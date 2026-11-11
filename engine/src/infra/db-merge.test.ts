/**
 * Tests for the merge engine's pure SQL and its file handling. The merge
 * itself is exercised end to end by global-db.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyStatement, describeCounts, keepAside, MERGED_TABLES, mergedSuffix, sharedColumns, type TableCounts } from './db-merge.js';

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
      'INSERT OR IGNORE INTO main.memories (id, content) SELECT src.id, src.content FROM legacy.memories AS src',
    );
    expect(copyStatement('facts', ['id', 'entity_id'])).toMatch(
      /SELECT src\.id, \(SELECT kept\.id FROM main\.entities kept JOIN legacy\.entities own/,
    );
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
