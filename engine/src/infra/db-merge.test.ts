/**
 * Tests for the merge engine's pure SQL, its file handling, and what a merge
 * does with a row the target cannot hold. The rest of the merge is exercised
 * end to end by global-db.test.ts and project-db.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemory } from '../core/types.js';
import { getActiveMemories, insertFact, insertMemory, openDatabase, upsertEntity } from './db.js';
import {
  copyStatement,
  describeCounts,
  keepAside,
  MERGED_TABLES,
  mergedSuffix,
  migrateFiles,
  sharedColumns,
  type TableCounts,
} from './db-merge.js';

describe('merge SQL', () => {
  it('sharedColumns keeps the target order and only columns both sides have (property)', () => {
    const columnList = fc.uniqueArray(fc.constantFrom<string>('a', 'b', 'c', 'd', 'e', 'f'));
    fc.assert(
      fc.property(columnList, columnList, (targetCols, legacyCols) => {
        const shared = sharedColumns(targetCols, legacyCols);
        expect(shared).toEqual(targetCols.filter((c) => legacyCols.includes(c)));
      }),
    );
  });

  it('copies columns by name, and only a fact repoints its entity', () => {
    expect(copyStatement('memories', ['id', 'content'])).toBe(
      'INSERT INTO main.memories (id, content) SELECT src.id, src.content FROM legacy.memories AS src ' +
        'WHERE true ON CONFLICT DO NOTHING',
    );
    expect(copyStatement('facts', ['id', 'entity_id'])).toMatch(
      /SELECT src\.id, \(SELECT kept\.id FROM main\.entities kept JOIN legacy\.entities own/,
    );
  });
});

describe('a row the target cannot hold', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortex-db-merge-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const memory = (id: string) =>
    createMemory({
      id,
      content: `content of ${id}`,
      summary: `summary of ${id}`,
      memory_type: 'context',
      scope: 'project',
      confidence: 0.8,
      priority: 5,
      source_type: 'extraction',
      source_session: 's',
      source_context: '{}',
    });

  /** A database holding memory `id` and one fact about `entity` sourced from it. */
  function seed(path: string, id: string, entity: string): void {
    const db = openDatabase(path);
    try {
      insertMemory(db, memory(id));
      insertFact(db, {
        id: `fact-${id}`,
        entity_id: upsertEntity(db, entity, 'tool'),
        predicate: 'serves',
        object: 'something',
        source_memory_id: id,
        confidence: 0.7,
        valid_from: '2026-11-01T00:00:00.000Z',
        valid_to: null,
        created_at: '2026-11-01T00:00:00.000Z',
      });
    } finally {
      db.close();
    }
  }

  const migrate = (target: string, source: string) =>
    migrateFiles({
      target,
      sources: [source],
      pathOf: (path) => path,
      lockFile: `${target}.lock`,
      now: new Date('2026-11-11T08:00:00.000Z'),
      waitMs: 150,
    });

  const memoryIds = (path: string): readonly string[] => {
    const db = openDatabase(path);
    try {
      return getActiveMemories(db).map((m) => m.id);
    } finally {
      db.close();
    }
  };

  it('a row whose key the target already has is a duplicate: the merge goes on and counts it', () => {
    const target = join(dir, 'target.db');
    const source = join(dir, 'source.db');
    seed(target, 'shared', 'reclaw');
    seed(source, 'shared', 'reclaw');

    const migration = migrate(target, source);
    if (migration.kind !== 'merged') throw new Error(JSON.stringify(migration));

    expect(migration.merged[0].duplicates).toMatchObject({ memories: 1, entities: 1, facts: 1 });
    expect(existsSync(source)).toBe(false);
  });

  it('a row that breaks any other constraint fails the merge: nothing is copied and the source stays', () => {
    const target = join(dir, 'target.db');
    const source = join(dir, 'source.db');
    seed(target, 'kept', 'reclaw');
    seed(source, 'orphaned', 'maya');
    // A fact left without its entity copies with a NULL entity_id, which the
    // target refuses. Counting that as "already present" would drop the fact
    // and then move its only copy aside as merged.
    const db = openDatabase(source);
    db.run('PRAGMA foreign_keys = OFF');
    db.run('DELETE FROM entities');
    db.close();

    const migration = migrate(target, source);
    if (migration.kind !== 'failed') throw new Error(JSON.stringify(migration));

    expect(migration.error).toContain(source);
    expect(migration.error).toMatch(/NOT NULL constraint failed: facts\.entity_id/);
    expect(migration.merged).toEqual([]);
    expect(existsSync(source)).toBe(true);
    expect(readdirSync(dir).filter((f) => f.includes('.merged-'))).toEqual([]);
    // The source's memory was copied in the same transaction as the fact, so it went with it.
    expect(memoryIds(target)).toEqual(['kept']);
  });
});

describe('describeCounts', () => {
  const counts = (values: Partial<TableCounts>): TableCounts =>
    ({ ...Object.fromEntries(MERGED_TABLES.map((t) => [t, 0])), ...values }) as TableCounts;

  it('names only the tables that had rows', () => {
    expect(describeCounts({ copied: counts({ memories: 3, facts: 2 }), duplicates: counts({ memories: 1 }) })).toBe(
      'memories +3 (1 already present), facts +2',
    );
    expect(describeCounts({ copied: counts({}), duplicates: counts({}) })).toBe('empty');
  });
});

describe('keepAside', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortex-db-merge-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('moves the database and its WAL files together', () => {
    const db = join(dir, 'cortex.db');
    for (const f of [db, `${db}-wal`, `${db}-shm`]) writeFileSync(f, 'x');

    const keptAs = keepAside(db, mergedSuffix(new Date('2026-11-11T08:00:00.000Z')));
    expect(keptAs).toBe(`${db}.merged-2026-11-11T08-00-00-000Z`);
    expect(readdirSync(dir).sort()).toEqual(
      [keptAs, `${keptAs}-shm`, `${keptAs}-wal`].map((f) => f.slice(dir.length + 1)).sort(),
    );
    expect(existsSync(db)).toBe(false);
  });

  it('never overwrites an earlier kept copy', () => {
    const db = join(dir, 'cortex.db');
    writeFileSync(db, 'first');
    const first = keepAside(db, 'merged-x');
    writeFileSync(db, 'second');
    const second = keepAside(db, 'merged-x');

    expect(second).toBe(`${first}-1`);
    expect(readdirSync(dir).sort()).toEqual(['cortex.db.merged-x', 'cortex.db.merged-x-1']);
  });
});
