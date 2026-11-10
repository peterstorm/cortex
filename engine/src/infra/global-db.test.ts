/**
 * Tests for the shared global database and the one-time merge of the legacy
 * per-harness databases. Real SQLite files in a temp directory throughout:
 * the merge is SQL, and its failure modes are file-level.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createMemory, type Memory } from '../core/types.js';
import { createFact } from '../core/entities.js';
import { getLegacyGlobalDbPaths, type LegacyGlobalDb } from '../config.js';
import {
  getMemory,
  getCurrentFacts,
  getEntityByName,
  insertFact,
  insertMemory,
  openDatabase,
  searchByKeyword,
  upsertEntity,
} from './db.js';
import {
  copyStatement,
  migrateGlobalDb,
  resolveGlobalDbPath,
  sharedColumns,
  type GlobalDbMigration,
} from './global-db.js';

function makeMemory(id: string, overrides: Partial<Parameters<typeof createMemory>[0]> = {}): Memory {
  return createMemory({
    id,
    content: `content of ${id}`,
    summary: `summary of ${id}`,
    memory_type: 'context',
    scope: 'global',
    confidence: 0.8,
    priority: 5,
    source_type: 'extraction',
    source_session: 's',
    source_context: '{}',
    ...overrides,
  });
}

let home: string;
let target: string;
let legacy: readonly LegacyGlobalDb[];
const NOW = new Date('2026-11-10T12:00:00.000Z');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cortex-global-db-'));
  target = join(home, '.local', 'share', 'cortex', 'global.db');
  legacy = getLegacyGlobalDbPaths(home);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Create a legacy DB at the harness's old path, run `seed` on it, close it. */
function seedLegacy(harness: 'claude' | 'pi', seed: (db: Database) => void): string {
  const path = legacy.find((l) => l.harness === harness)!.path;
  mkdirSync(dirname(path), { recursive: true });
  const db = openDatabase(path);
  try {
    seed(db);
  } finally {
    db.close();
  }
  return path;
}

function migrate(waitMs?: number): GlobalDbMigration {
  return migrateGlobalDb({ target, legacy, now: NOW, waitMs });
}

function merged(migration: GlobalDbMigration) {
  if (migration.kind !== 'merged') throw new Error(`expected merged, got ${JSON.stringify(migration)}`);
  return migration;
}

function withTarget<T>(read: (db: Database) => T): T {
  const db = openDatabase(target);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

describe('migrateGlobalDb', () => {
  it('does nothing and creates nothing when no legacy database exists', () => {
    expect(migrate()).toEqual({ kind: 'fresh' });
    expect(existsSync(target)).toBe(false);
  });

  it('leaves a present target and the legacy databases alone', () => {
    const claude = seedLegacy('claude', (db) => insertMemory(db, makeMemory('c1')));
    mkdirSync(dirname(target), { recursive: true });
    openDatabase(target).close();

    expect(migrate()).toEqual({ kind: 'current' });
    expect(existsSync(claude)).toBe(true);
    expect(withTarget((db) => getMemory(db, 'c1'))).toBeNull();
  });

  it('merges both harnesses into one database and keeps the originals aside', () => {
    const embedding = new Float32Array(512).map((_, i) => i / 512);
    const claude = seedLegacy('claude', (db) => {
      insertMemory(db, makeMemory('c1', { content: 'nix flakes pin inputs', local_embedding: embedding }));
      insertMemory(db, makeMemory('c2', { status: 'archived', archived_at: NOW.toISOString() }));
    });
    const pi = seedLegacy('pi', (db) => insertMemory(db, makeMemory('p1', { content: 'pi routes subagents' })));

    const result = merged(migrate());

    // Checked before anything opens the target: only the database itself is
    // there, with no staging, WAL or snapshot files left by the merge.
    expect(readdirSync(dirname(target))).toEqual(['global.db']);
    expect(result.sources.map((s) => [s.source.harness, s.copied.memories, s.duplicates.memories])).toEqual([
      ['claude', 2, 0],
      ['pi', 1, 0],
    ]);
    withTarget((db) => {
      expect(getMemory(db, 'c1')?.local_embedding).toEqual(embedding);
      expect(getMemory(db, 'c2')?.status).toBe('archived');
      expect(getMemory(db, 'p1')?.content).toBe('pi routes subagents');
      // The FTS index is filled by the insert triggers, so keyword recall works.
      expect(searchByKeyword(db, 'flakes', 10).map((m) => m.id)).toEqual(['c1']);
      expect(searchByKeyword(db, 'subagents', 10).map((m) => m.id)).toEqual(['p1']);
    });
    for (const original of [claude, pi]) {
      expect(existsSync(original)).toBe(false);
      expect(readdirSync(dirname(original)).some((f) => f.startsWith('cortex-global.db.merged-'))).toBe(true);
    }
    expect(result.sources[0].keptAs).toBe(`${claude}.merged-2026-11-10T12-00-00-000Z`);
  });

  it('is idempotent: a second run finds the target and changes nothing', () => {
    seedLegacy('claude', (db) => insertMemory(db, makeMemory('c1')));
    merged(migrate());

    expect(migrate()).toEqual({ kind: 'current' });
    expect(withTarget((db) => getMemory(db, 'c1'))).not.toBeNull();
  });

  it('merges a single legacy database when only one harness was used', () => {
    seedLegacy('pi', (db) => insertMemory(db, makeMemory('p1')));

    const result = merged(migrate());
    expect(result.sources.map((s) => s.source.harness)).toEqual(['pi']);
    expect(withTarget((db) => getMemory(db, 'p1'))).not.toBeNull();
  });

  it('keeps the first source on an id clash and reports the duplicate', () => {
    seedLegacy('claude', (db) => insertMemory(db, makeMemory('same', { content: 'from claude' })));
    seedLegacy('pi', (db) => insertMemory(db, makeMemory('same', { content: 'from pi' })));

    const result = merged(migrate());
    expect(result.sources[1].copied.memories).toBe(0);
    expect(result.sources[1].duplicates.memories).toBe(1);
    expect(withTarget((db) => getMemory(db, 'same')?.content)).toBe('from claude');
  });

  it('collapses entities that clash by name and type, repointing their facts', () => {
    const fact = (entityId: string, memoryId: string, object: string) =>
      createFact({
        id: `fact-${memoryId}`,
        entity_id: entityId,
        predicate: 'is',
        object,
        source_memory_id: memoryId,
        confidence: 0.9,
        valid_from: NOW.toISOString(),
      });
    seedLegacy('claude', (db) => {
      insertMemory(db, makeMemory('c1'));
      insertFact(db, fact(upsertEntity(db, 'Bun', 'tool'), 'c1', 'a runtime'));
    });
    seedLegacy('pi', (db) => {
      insertMemory(db, makeMemory('p1'));
      insertFact(db, fact(upsertEntity(db, 'bun', 'tool'), 'p1', 'fast'));
    });

    const result = merged(migrate());
    expect(result.sources[1].duplicates.entities).toBe(1);
    expect(result.sources[1].copied.facts).toBe(1);
    withTarget((db) => {
      const entity = getEntityByName(db, 'bun')!;
      expect(getCurrentFacts(db, entity.id).map((f) => f.object).sort()).toEqual(['a runtime', 'fast']);
    });
  });

  it('copies edges and extraction checkpoints', () => {
    seedLegacy('claude', (db) => {
      insertMemory(db, makeMemory('a'));
      insertMemory(db, makeMemory('b'));
      db.run(
        `INSERT INTO edges (id, source_id, target_id, relation_type, strength, created_at)
         VALUES ('e1', 'a', 'b', 'relates_to', 0.7, ?)`,
        [NOW.toISOString()],
      );
      db.run(
        `INSERT INTO extraction_checkpoints (id, session_id, cursor_position, extracted_at)
         VALUES ('k1', 'session-1', 42, ?)`,
        [NOW.toISOString()],
      );
    });

    const result = merged(migrate());
    expect(result.sources[0].copied.edges).toBe(1);
    expect(result.sources[0].copied.extraction_checkpoints).toBe(1);
  });

  it('includes rows still in the legacy WAL, written by a connection that is still open', () => {
    const path = legacy[0].path;
    mkdirSync(dirname(path), { recursive: true });
    const live = openDatabase(path);
    try {
      insertMemory(live, makeMemory('in-wal'));
      expect(existsSync(`${path}-wal`)).toBe(true);

      merged(migrate());
      expect(withTarget((db) => getMemory(db, 'in-wal'))).not.toBeNull();
    } finally {
      live.close();
    }
  });

  it('merges a legacy database from before later columns and tables existed', () => {
    const path = legacy[0].path;
    mkdirSync(dirname(path), { recursive: true });
    const old = new Database(path);
    old.run(`CREATE TABLE memories (
      id TEXT PRIMARY KEY, content TEXT NOT NULL, summary TEXT NOT NULL, memory_type TEXT NOT NULL,
      scope TEXT NOT NULL, embedding BLOB, confidence REAL NOT NULL, priority INTEGER NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0, source_type TEXT NOT NULL, source_session TEXT NOT NULL,
      source_context TEXT NOT NULL, tags TEXT NOT NULL, access_count INTEGER NOT NULL DEFAULT 0,
      last_accessed_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active')`);
    old.run(`CREATE TABLE edges (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
      relation_type TEXT NOT NULL, strength REAL NOT NULL, bidirectional INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL)`);
    old.run(`CREATE TABLE extraction_checkpoints (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
      cursor_position INTEGER NOT NULL, extracted_at TEXT NOT NULL)`);
    const t = NOW.toISOString();
    old.run(
      `INSERT INTO memories (id, content, summary, memory_type, scope, confidence, priority, source_type,
        source_session, source_context, tags, last_accessed_at, created_at, updated_at)
       VALUES ('old', 'from an old schema', 's', 'context', 'global', 0.5, 5, 'manual', 's', '{}', '[]', ?, ?, ?)`,
      [t, t, t],
    );
    old.close();

    const result = merged(migrate());
    expect(result.sources[0].copied.memories).toBe(1);
    expect(result.sources[0].copied.entities).toBe(0);
    expect(withTarget((db) => getMemory(db, 'old'))).toMatchObject({ content: 'from an old schema', archived_at: null });
  });

  it('fails without creating the target or touching the legacy files when a source is unreadable', () => {
    seedLegacy('claude', (db) => insertMemory(db, makeMemory('c1')));
    const pi = legacy[1].path;
    mkdirSync(dirname(pi), { recursive: true });
    writeFileSync(pi, 'this is not a sqlite database, just some bytes that are long enough');

    const result = migrate();
    expect(result.kind).toBe('failed');
    expect(existsSync(target)).toBe(false);
    expect(existsSync(legacy[0].path)).toBe(true);
    expect(existsSync(pi)).toBe(true);
    // No staging leftovers beside the target.
    expect(readdirSync(dirname(target)).filter((f) => f.includes('merging'))).toEqual([]);
  });

  it('reports busy when another live process holds the merge lock and never finishes', () => {
    seedLegacy('claude', (db) => insertMemory(db, makeMemory('c1')));
    mkdirSync(dirname(target), { recursive: true });
    // This process's PID is alive, so the lock reads as held by another merge.
    writeFileSync(`${target}.lock`, String(process.pid));

    expect(migrate(150)).toEqual({ kind: 'busy' });
    expect(existsSync(target)).toBe(false);
    expect(existsSync(legacy[0].path)).toBe(true);
  });
});

describe('resolveGlobalDbPath', () => {
  const quiet = () => {
    const lines: string[] = [];
    return { lines, log: (line: string) => lines.push(line) };
  };

  it('returns the shared path, merging first, and says what it merged', () => {
    seedLegacy('pi', (db) => insertMemory(db, makeMemory('p1')));
    const { lines, log } = quiet();

    expect(resolveGlobalDbPath({ env: {}, home, now: NOW, log })).toBe(target);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^INFO: merged 1 global memory database\(s\) into .*\n {2}pi: memories \+1; original kept at /);
  });

  it('returns the shared path silently on a fresh machine', () => {
    const { lines, log } = quiet();
    expect(resolveGlobalDbPath({ env: {}, home, log })).toBe(target);
    expect(lines).toEqual([]);
  });

  it("falls back to this harness's legacy database when the merge fails, so the shared one is never created empty", () => {
    seedLegacy('claude', (db) => insertMemory(db, makeMemory('c1')));
    mkdirSync(dirname(legacy[1].path), { recursive: true });
    writeFileSync(legacy[1].path, 'not a database');
    const { lines, log } = quiet();

    expect(resolveGlobalDbPath({ env: {}, home, harness: 'pi', log })).toBe(legacy[1].path);
    expect(resolveGlobalDbPath({ env: {}, home, harness: 'claude', log })).toBe(legacy[0].path);
    expect(existsSync(target)).toBe(false);
    expect(lines[0]).toMatch(/^WARN: merging .* failed: .*; using .*cortex-global\.db for now$/);
  });

  it('merges into CORTEX_GLOBAL_DB when it is set', () => {
    seedLegacy('claude', (db) => insertMemory(db, makeMemory('c1')));
    const custom = join(home, 'custom', 'memory.db');

    expect(resolveGlobalDbPath({ env: { CORTEX_GLOBAL_DB: custom }, home, log: () => {} })).toBe(custom);
    expect(existsSync(custom)).toBe(true);
  });
});

describe('merge SQL', () => {
  it('sharedColumns keeps the target order and only columns both sides have', () => {
    const columnList = fc.uniqueArray(fc.constantFrom<string>('a', 'b', 'c', 'd', 'e', 'f'));
    fc.assert(
      fc.property(
        columnList,
        columnList,
        (targetCols, legacyCols) => {
          const shared = sharedColumns(targetCols, legacyCols);
          expect(shared.every((c) => targetCols.includes(c) && legacyCols.includes(c))).toBe(true);
          expect(shared).toEqual(targetCols.filter((c) => legacyCols.includes(c)));
        },
      ),
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
