/**
 * Tests for the shared global database and the merge of the legacy
 * per-harness databases into it. Real SQLite files in a temp directory
 * throughout: the merge is SQL, and its failure modes are file-level.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
import { migrateGlobalDb, resolveGlobalDbPath, type GlobalDbMigration } from './global-db.js';

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
const LATER = new Date('2026-11-11T12:00:00.000Z');

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'cortex-global-db-'));
  target = join(home, '.local', 'share', 'cortex', 'global.db');
  legacy = getLegacyGlobalDbPaths(home);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const legacyPath = (harness: 'claude' | 'pi') => legacy.find((l) => l.harness === harness)!.path;

/** Create a legacy DB at the harness's old path, run `seed` on it, close it. */
function seedLegacy(harness: 'claude' | 'pi', seed: (db: Database) => void): string {
  const path = legacyPath(harness);
  mkdirSync(dirname(path), { recursive: true });
  const db = openDatabase(path);
  try {
    seed(db);
  } finally {
    db.close();
  }
  return path;
}

function corruptLegacy(harness: 'claude' | 'pi'): string {
  const path = legacyPath(harness);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, 'this is not a sqlite database, just some bytes that are long enough');
  return path;
}

function migrate(options: { waitMs?: number; now?: Date } = {}): GlobalDbMigration {
  return migrateGlobalDb({ target, legacy, now: options.now ?? NOW, waitMs: options.waitMs });
}

function merged(migration: GlobalDbMigration) {
  if (migration.kind !== 'merged') throw new Error(`expected merged, got ${JSON.stringify(migration)}`);
  return migration;
}

function failed(migration: GlobalDbMigration) {
  if (migration.kind !== 'failed') throw new Error(`expected failed, got ${JSON.stringify(migration)}`);
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

const keptCopies = (original: string) =>
  readdirSync(dirname(original)).filter((f) => f.startsWith('cortex-global.db.merged-') && !/-(wal|shm|journal)$/.test(f));

describe('migrateGlobalDb', () => {
  it('does nothing and creates nothing when no legacy database exists', () => {
    expect(migrate()).toEqual({ kind: 'current' });
    expect(existsSync(target)).toBe(false);
  });

  it('merges both harnesses into one database and keeps the originals aside', () => {
    const embedding = new Float32Array(512).map((_, i) => i / 512);
    const claude = seedLegacy('claude', (db) => {
      insertMemory(db, makeMemory('c1', { content: 'nix flakes pin inputs', local_embedding: embedding }));
      insertMemory(db, makeMemory('c2', { status: 'archived', archived_at: NOW.toISOString() }));
    });
    const pi = seedLegacy('pi', (db) => insertMemory(db, makeMemory('p1', { content: 'pi routes subagents' })));

    const result = merged(migrate());

    // Only the database and its own WAL files: no snapshot or lock left behind.
    expect(readdirSync(dirname(target)).filter((f) => !/^global\.db(-wal|-shm)?$/.test(f))).toEqual([]);
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
      expect(keptCopies(original)).toHaveLength(1);
    }
    expect(result.sources[0].keptAs).toBe(`${claude}.merged-2026-11-10T12-00-00-000Z`);
  });

  it('merges into a shared database that already exists: an empty one cannot hide unmerged memories', () => {
    mkdirSync(dirname(target), { recursive: true });
    withTarget((db) => insertMemory(db, makeMemory('already-shared')));
    const claude = seedLegacy('claude', (db) => insertMemory(db, makeMemory('c1')));

    expect(merged(migrate()).sources[0].copied.memories).toBe(1);
    withTarget((db) => {
      expect(getMemory(db, 'already-shared')).not.toBeNull();
      expect(getMemory(db, 'c1')).not.toBeNull();
    });
    expect(existsSync(claude)).toBe(false);
  });

  it('is idempotent: once every legacy file is aside, a run changes nothing', () => {
    seedLegacy('claude', (db) => insertMemory(db, makeMemory('c1')));
    merged(migrate());

    expect(migrate()).toEqual({ kind: 'current' });
    expect(withTarget((db) => getMemory(db, 'c1'))).not.toBeNull();
  });

  it('merges a legacy file an older harness recreated after the merge, keeping both kept copies', () => {
    const claude = seedLegacy('claude', (db) => insertMemory(db, makeMemory('c1')));
    merged(migrate());
    seedLegacy('claude', (db) => insertMemory(db, makeMemory('c2-written-later')));

    expect(merged(migrate({ now: LATER })).sources[0].copied.memories).toBe(1);
    withTarget((db) => expect(getMemory(db, 'c2-written-later')).not.toBeNull());
    expect(keptCopies(claude)).toHaveLength(2);
  });

  it('never overwrites a kept copy when the same file is merged twice at the same instant', () => {
    const claude = seedLegacy('claude', (db) => insertMemory(db, makeMemory('c1')));
    const first = merged(migrate()).sources[0].keptAs;
    seedLegacy('claude', (db) => insertMemory(db, makeMemory('c2')));
    const second = merged(migrate()).sources[0].keptAs;

    expect(second).not.toBe(first);
    expect(keptCopies(claude)).toHaveLength(2);
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

  it('keeps what merged before an unreadable source and leaves that source in place', () => {
    const claude = seedLegacy('claude', (db) => insertMemory(db, makeMemory('c1')));
    const pi = corruptLegacy('pi');

    const result = failed(migrate());
    expect(result.error).toContain(pi);
    expect(result.merged.map((m) => m.source.harness)).toEqual(['claude']);
    expect(existsSync(claude)).toBe(false);
    expect(existsSync(pi)).toBe(true);
    expect(withTarget((db) => getMemory(db, 'c1'))).not.toBeNull();
    expect(readdirSync(dirname(target)).filter((f) => f.includes('.source-'))).toEqual([]);
  });

  it('stops at the first unreadable source, so a later one cannot take its clashes', () => {
    const claude = corruptLegacy('claude');
    const pi = seedLegacy('pi', (db) => insertMemory(db, makeMemory('p1')));

    expect(failed(migrate()).merged).toEqual([]);
    expect(existsSync(claude)).toBe(true);
    expect(existsSync(pi)).toBe(true);
  });

  it('reports busy when another live process holds the merge lock past the wait', () => {
    seedLegacy('claude', (db) => insertMemory(db, makeMemory('c1')));
    mkdirSync(dirname(target), { recursive: true });
    // This process's PID is alive, so the lock reads as held by another merge.
    writeFileSync(`${target}.lock`, String(process.pid));

    expect(migrate({ waitMs: 150 })).toEqual({ kind: 'busy' });
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

  it("falls back to this harness's own database while it is still unmerged, else to the shared one", () => {
    seedLegacy('claude', (db) => insertMemory(db, makeMemory('c1')));
    const pi = corruptLegacy('pi');
    const { lines, log } = quiet();

    // Claude merges, pi fails: pi keeps its own file in view until the retry.
    expect(resolveGlobalDbPath({ env: {}, home, harness: 'pi', log })).toBe(pi);
    expect(lines[0]).toMatch(/^WARN: merging .* failed: .*\nmerged before the failure:\n {2}claude: memories \+1/);
    expect(lines[0]).toMatch(/; using .*cortex-global\.db for now$/);
    // Claude's own file is already merged, so the shared one holds its memories.
    expect(resolveGlobalDbPath({ env: {}, home, harness: 'claude', log })).toBe(target);
  });

  it('uses CORTEX_GLOBAL_DB as it is, and never reads or moves the legacy files', () => {
    const claude = seedLegacy('claude', (db) => insertMemory(db, makeMemory('c1')));
    const custom = join(home, 'custom', 'memory.db');

    expect(resolveGlobalDbPath({ env: { CORTEX_GLOBAL_DB: custom }, home, log: () => {} })).toBe(custom);
    expect(existsSync(custom)).toBe(false);
    expect(existsSync(claude)).toBe(true);
  });

  it('finds the legacy databases under $HOME, not the account home Bun reports', () => {
    seedLegacy('claude', (db) => insertMemory(db, makeMemory('c1')));
    const { log } = quiet();

    expect(resolveGlobalDbPath({ env: { HOME: home }, log })).toBe(target);
    expect(withTarget((db) => getMemory(db, 'c1'))).not.toBeNull();
  });
});
