import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CURRENT_SCHEMA_VERSION,
  openDatabase,
  insertMemory,
  updateMemory,
  getMemory,
  getMemoriesWithEmbedding,
  getMemoriesWithEmbeddingByIds,
  searchByKeyword,
  getActiveMemories,
  insertEdge,
  getEdgesForMemory,
  getAllEdges,
  getExtractionCheckpoint,
  saveExtractionCheckpoint,
  createCheckpoint,
  restoreCheckpoint,
  routeToDatabase,
  getActiveCodeMemoriesByFilePath,
  getActiveProseMemoriesByFilePath,
} from './db.js';
import { rankBySimilarity } from '../core/similarity.js';
import { createMemory, createEdge } from '../core/types.js';
import { LOCAL_EMBED_MODEL } from '../config.js';
import type { Memory, Edge, MemoryScope, MemoryType, MemoryStatus } from '../core/types.js';

/**
 * Test fixture factory: a valid Memory with neutral defaults, so each test
 * spells only the fields it actually exercises (same convention as
 * ai-prune.test.ts's makeMemory). The 12-field boilerplate no longer drifts
 * across dozens of call sites.
 */
function makeMemory(
  id: string,
  overrides: Partial<Parameters<typeof createMemory>[0]> = {}
): Memory {
  return createMemory({
    id,
    content: 'c',
    summary: 's',
    memory_type: 'context',
    scope: 'project',
    confidence: 0.5,
    priority: 5,
    source_type: 'manual',
    source_session: 's',
    source_context: '{}',
    ...overrides,
  });
}

describe('Database Layer', () => {
  describe('openDatabase', () => {
    it('creates schema on new database', () => {
      const db = openDatabase(':memory:');

      // Verify tables exist by querying schema
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as { name: string }[];

      const tableNames = tables.map((t) => t.name);
      expect(tableNames).toContain('memories');
      expect(tableNames).toContain('edges');
      expect(tableNames).toContain('extraction_checkpoints');
      expect(tableNames).toContain('memories_fts');

      db.close();
    });

    it('enables WAL mode', () => {
      const db = openDatabase(':memory:');
      const result = db.query('PRAGMA journal_mode').get() as { journal_mode: string };
      expect(result.journal_mode).toBe('memory'); // WAL not applicable to :memory: but won't error
      db.close();
    });

    it('enables foreign keys', () => {
      const db = openDatabase(':memory:');
      const result = db.query('PRAGMA foreign_keys').get() as { foreign_keys: number };
      expect(result.foreign_keys).toBe(1);
      db.close();
    });
  });

  describe('Memory CRUD', () => {
    let db: ReturnType<typeof openDatabase>;

    beforeEach(() => {
      db = openDatabase(':memory:');
    });

    it('inserts and retrieves memory by ID', () => {
      const memory = makeMemory('mem-1', {
        content: 'Use functional core pattern',
        summary: 'FP architecture principle',
        memory_type: 'architecture',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-1',
        source_context: JSON.stringify({ branch: 'main' }),
        tags: ['fp', 'architecture'],
      });

      insertMemory(db, memory);

      const retrieved = getMemory(db, 'mem-1');
      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe('mem-1');
      expect(retrieved?.content).toBe('Use functional core pattern');
      expect(retrieved?.memory_type).toBe('architecture');
      expect(retrieved?.tags).toEqual(['fp', 'architecture']);
      expect(retrieved?.pinned).toBe(false);
      expect(retrieved?.status).toBe('active');

      db.close();
    });

    it('returns null for non-existent memory', () => {
      const retrieved = getMemory(db, 'non-existent');
      expect(retrieved).toBeNull();
      db.close();
    });

    it('inserts memory with embeddings and retrieves correctly', () => {
      const voyageEmbedding = new Float64Array([0.1, 0.2, 0.3, 0.4]);
      const localEmbedding = new Float32Array([0.5, 0.6, 0.7, 0.8]);

      const memory = makeMemory('mem-emb', {
        content: 'Test embeddings',
        summary: 'Embedding test',
        scope: 'global',
        confidence: 0.8,
        source_session: 'session-2',
        embedding: voyageEmbedding,
        local_embedding: localEmbedding,
      });

      insertMemory(db, memory);

      const retrieved = getMemory(db, 'mem-emb');
      expect(retrieved).toBeDefined();
      expect(retrieved?.embedding).toEqual(voyageEmbedding);
      expect(retrieved?.local_embedding).toEqual(localEmbedding);

      db.close();
    });

    it('updates memory fields', () => {
      const memory = makeMemory('mem-update', {
        content: 'Original content',
        summary: 'Original summary',
        memory_type: 'decision',
        priority: 3,
        source_type: 'extraction',
        source_session: 'session-3',
      });

      insertMemory(db, memory);

      updateMemory(db, 'mem-update', {
        content: 'Updated content',
        priority: 7,
        status: 'superseded',
        tags: ['updated'],
      });

      const retrieved = getMemory(db, 'mem-update');
      expect(retrieved?.content).toBe('Updated content');
      expect(retrieved?.priority).toBe(7);
      expect(retrieved?.status).toBe('superseded');
      expect(retrieved?.tags).toEqual(['updated']);
      expect(retrieved?.summary).toBe('Original summary'); // Unchanged

      db.close();
    });

    it('rejects invalid memory_type through updateMemory (C6 validation is enforced)', () => {
      const memory = makeMemory('mem-invalid-type');
      insertMemory(db, memory);

      expect(() => updateMemory(db, 'mem-invalid-type', { memory_type: 'not-a-type' as unknown as MemoryType }))
        .toThrow(/invalid memory_type/);
      db.close();
    });

    it('rejects invalid status through updateMemory', () => {
      const memory = makeMemory('mem-invalid-status');
      insertMemory(db, memory);

      expect(() => updateMemory(db, 'mem-invalid-status', { status: 'zombie' as unknown as MemoryStatus }))
        .toThrow(/invalid status/);
      db.close();
    });

    it('rejects invalid scope through updateMemory', () => {
      const memory = makeMemory('mem-invalid-scope');
      insertMemory(db, memory);

      expect(() => updateMemory(db, 'mem-invalid-scope', { scope: 'workspace' as unknown as MemoryScope }))
        .toThrow(/invalid scope/);
      expect(getMemory(db, 'mem-invalid-scope')?.scope).toBe('project');
      db.close();
    });

    it('rejects out-of-range confidence through updateMemory', () => {
      const memory = makeMemory('mem-invalid-confidence');
      insertMemory(db, memory);

      expect(() => updateMemory(db, 'mem-invalid-confidence', { confidence: 1.4 }))
        .toThrow(/confidence must be in \[0, 1\]/);
      db.close();
    });

    it('rejects out-of-range priority through updateMemory', () => {
      const memory = makeMemory('mem-invalid-priority');
      insertMemory(db, memory);

      expect(() => updateMemory(db, 'mem-invalid-priority', { priority: 11 }))
        .toThrow(/priority must be in \[1, 10\]/);
      db.close();
    });

    it('rejects empty content through updateMemory', () => {
      const memory = makeMemory('mem-invalid-content');
      insertMemory(db, memory);

      expect(() => updateMemory(db, 'mem-invalid-content', { content: '   ' }))
        .toThrow(/content must not be empty/);
      db.close();
    });

    it('maintains the status/archived_at coupling when archiving', () => {
      const memory = makeMemory('mem-archive-coupling');
      insertMemory(db, memory);

      // Flipping to archived without archived_at writes the archive anchor.
      updateMemory(db, 'mem-archive-coupling', { status: 'archived' });
      const archived = getMemory(db, 'mem-archive-coupling');
      expect(archived?.status).toBe('archived');
      expect(archived?.archived_at).not.toBeNull();

      // Re-activating clears the anchor.
      updateMemory(db, 'mem-archive-coupling', { status: 'active' });
      const reactivated = getMemory(db, 'mem-archive-coupling');
      expect(reactivated?.status).toBe('active');
      expect(reactivated?.archived_at).toBeNull();
      db.close();
    });

    it('refuses an active memory with a non-null archived_at through updateMemory', () => {
      const memory = makeMemory('mem-active-archive');
      insertMemory(db, memory);

      expect(() => updateMemory(db, 'mem-active-archive', {
        status: 'active',
        archived_at: '2026-08-12T00:00:00.000Z',
      })).toThrow(/active memory must not have archived_at/);
      db.close();
    });

    it('refuses an archived_at-only update on an active row (no status change)', () => {
      const memory = makeMemory('mem-anchor-only');
      insertMemory(db, memory);

      expect(() => updateMemory(db, 'mem-anchor-only', {
        archived_at: '2026-08-12T00:00:00.000Z',
      })).toThrow(/cannot set archived_at without archiving/);
      // The row is untouched and still readable.
      const retrieved = getMemory(db, 'mem-anchor-only');
      expect(retrieved?.archived_at).toBeNull();
      db.close();
    });

    it('allows re-anchoring an already-archived memory through archived_at only', () => {
      const memory = makeMemory('mem-reanchor', {
        status: 'archived',
        archived_at: '2026-08-01T00:00:00.000Z',
      });
      insertMemory(db, memory);

      updateMemory(db, 'mem-reanchor', { archived_at: '2026-08-02T00:00:00.000Z' });
      expect(getMemory(db, 'mem-reanchor')?.archived_at).toBe('2026-08-02T00:00:00.000Z');
      db.close();
    });

    it('refuses a status-only supersede on an anchored row (anchor must be cleared first)', () => {
      const memory = makeMemory('mem-supersede-anchor', {
        status: 'archived',
        archived_at: '2026-08-01T00:00:00.000Z',
      });
      insertMemory(db, memory);

      // A status-only update leaves archived_at at the row's current value,
      // persisting a row createMemory refuses to read back.
      expect(() => updateMemory(db, 'mem-supersede-anchor', { status: 'superseded' }))
        .toThrow(/must not carry an archive anchor/);
      const row = getMemory(db, 'mem-supersede-anchor');
      expect(row?.status).toBe('archived');
      expect(row?.archived_at).toBe('2026-08-01T00:00:00.000Z');
      db.close();
    });

    it('allows superseding an unanchored row', () => {
      insertMemory(db, makeMemory('mem-supersede-active'));

      updateMemory(db, 'mem-supersede-active', { status: 'superseded' });
      const row = getMemory(db, 'mem-supersede-active');
      expect(row?.status).toBe('superseded');
      expect(row?.archived_at).toBeNull();
      db.close();
    });

    it('falls back to no tags (with a diagnostic) when a tags cell is corrupt', () => {
      insertMemory(db, makeMemory('mem-bad-tags', { tags: ['ok'] }));
      db.prepare('UPDATE memories SET tags = ? WHERE id = ?').run('not-json', 'mem-bad-tags');

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const retrieved = getMemory(db, 'mem-bad-tags');
        expect(retrieved).not.toBeNull();
        expect(retrieved?.tags).toEqual([]);
        expect(warn).toHaveBeenCalledWith(
          '[cortex:db] Memory mem-bad-tags: tags deserialized to invalid JSON; falling back to []'
        );
      } finally {
        warn.mockRestore();
        db.close();
      }
    });

    it('gets only active memories', () => {
      const active1 = makeMemory('mem-active-1', {
        content: 'Active memory 1',
        summary: 'Active 1',
        memory_type: 'pattern',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-4',
        status: 'active',
      });

      const active2 = makeMemory('mem-active-2', {
        content: 'Active memory 2',
        summary: 'Active 2',
        memory_type: 'gotcha',
        confidence: 0.8,
        priority: 6,
        source_type: 'extraction',
        source_session: 'session-4',
        status: 'active',
      });

      const superseded = makeMemory('mem-superseded', {
        content: 'Superseded memory',
        summary: 'Superseded',
        memory_type: 'pattern',
        confidence: 0.7,
        source_type: 'extraction',
        source_session: 'session-4',
        status: 'superseded',
      });

      insertMemory(db, active1);
      insertMemory(db, active2);
      insertMemory(db, superseded);

      const activeMemories = getActiveMemories(db);
      expect(activeMemories).toHaveLength(2);
      expect(activeMemories.map((m) => m.id).sort()).toEqual(['mem-active-1', 'mem-active-2']);

      db.close();
    });
  });

  describe('file-path lookup in source_context (json_extract)', () => {
    let db: ReturnType<typeof openDatabase>;

    beforeEach(() => {
      db = openDatabase(':memory:');
    });

    it('finds the code memory for a plain path (including paths with spaces) and nothing else', () => {
      insertMemory(db, makeMemory('code-plain', {
        memory_type: 'code',
        source_context: JSON.stringify({ file_path: '/tmp/plain.ts' }),
      }));
      insertMemory(db, makeMemory('code-spaces', {
        memory_type: 'code',
        source_context: JSON.stringify({ file_path: '/tmp/dir with spaces/main.ts' }),
      }));
      insertMemory(db, makeMemory('code-other', {
        memory_type: 'code',
        source_context: JSON.stringify({ file_path: '/tmp/other.ts' }),
      }));

      expect(getActiveCodeMemoriesByFilePath(db, '/tmp/plain.ts').map((m) => m.id)).toEqual(['code-plain']);
      expect(getActiveCodeMemoriesByFilePath(db, '/tmp/dir with spaces/main.ts').map((m) => m.id)).toEqual(['code-spaces']);
      db.close();
    });

    it('finds a path containing a double quote, matching only its own row', () => {
      insertMemory(db, makeMemory('code-quote', {
        memory_type: 'code',
        source_context: JSON.stringify({ file_path: '/tmp/we"ird.ts' }),
      }));
      insertMemory(db, makeMemory('code-decoy', {
        memory_type: 'code',
        source_context: JSON.stringify({ file_path: '/tmp/weird.ts' }),
      }));

      expect(getActiveCodeMemoriesByFilePath(db, '/tmp/we"ird.ts').map((m) => m.id)).toEqual(['code-quote']);
      expect(getActiveCodeMemoriesByFilePath(db, '/tmp/weird.ts').map((m) => m.id)).toEqual(['code-decoy']);
      db.close();
    });

    it('finds a backslash path without cross-matching a collapsed form', () => {
      // A LIKE over the JSON-escaped text missed backslash paths entirely and
      // could cross-match; json_extract compares the parsed value, so only
      // the exact path matches.
      insertMemory(db, makeMemory('code-win', {
        memory_type: 'code',
        source_context: JSON.stringify({ file_path: 'C:\\Users\\x\\main.ts' }),
      }));
      insertMemory(db, makeMemory('code-collapsed', {
        memory_type: 'code',
        source_context: JSON.stringify({ file_path: 'C:Usersxmain.ts' }),
      }));

      expect(getActiveCodeMemoriesByFilePath(db, 'C:\\Users\\x\\main.ts').map((m) => m.id)).toEqual(['code-win']);
      expect(getActiveCodeMemoriesByFilePath(db, 'C:Usersxmain.ts').map((m) => m.id)).toEqual(['code-collapsed']);
      db.close();
    });

    it('splits code and prose (code_description) lookups on the same contract', () => {
      const path = 'C:\\Users\\x\\readme.md';
      insertMemory(db, makeMemory('prose-1', {
        memory_type: 'code_description',
        source_context: JSON.stringify({ file_path: path }),
      }));
      insertMemory(db, makeMemory('code-1', {
        memory_type: 'code',
        source_context: JSON.stringify({ file_path: path }),
      }));

      expect(getActiveProseMemoriesByFilePath(db, path).map((m) => m.id)).toEqual(['prose-1']);
      expect(getActiveCodeMemoriesByFilePath(db, path).map((m) => m.id)).toEqual(['code-1']);
      db.close();
    });

    it('ignores non-active memories and malformed stored JSON (no match, no throw)', () => {
      insertMemory(db, makeMemory('code-archived', {
        memory_type: 'code',
        source_context: JSON.stringify({ file_path: '/tmp/a.ts' }),
        status: 'archived',
        archived_at: '2026-08-01T00:00:00.000Z',
      }));
      // createMemory does not validate source_context, so a corrupt cell is
      // reachable; the json_valid guard skips it — no match, no throw.
      insertMemory(db, makeMemory('code-malformed', {
        memory_type: 'code',
        source_context: 'not-json',
      }));
      // The invariant the guard exists for: a corrupt row must not break a
      // lookup that has real matches in the same pass.
      insertMemory(db, makeMemory('code-real', {
        memory_type: 'code',
        source_context: JSON.stringify({ file_path: '/tmp/real.ts' }),
      }));

      expect(getActiveCodeMemoriesByFilePath(db, '/tmp/a.ts')).toEqual([]);
      expect(getActiveCodeMemoriesByFilePath(db, '/tmp/real.ts').map((m) => m.id)).toEqual(['code-real']);
      db.close();
    });
  });

  describe('searchByKeyword', () => {
    let db: ReturnType<typeof openDatabase>;

    beforeEach(() => {
      db = openDatabase(':memory:');

      // Insert test memories
      const mem1 = makeMemory('mem-fts-1', {
        content: 'Use functional programming patterns',
        summary: 'FP patterns',
        memory_type: 'pattern',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-5',
        tags: ['fp', 'patterns'],
      });

      const mem2 = makeMemory('mem-fts-2', {
        content: 'Immutability is a core functional principle',
        summary: 'Immutability principle',
        memory_type: 'architecture',
        confidence: 0.95,
        priority: 9,
        source_type: 'extraction',
        source_session: 'session-5',
        tags: ['fp', 'immutability'],
      });

      const mem3 = makeMemory('mem-fts-3', {
        content: 'Database operations should be isolated at boundaries',
        summary: 'DB boundary isolation',
        memory_type: 'architecture',
        confidence: 0.85,
        priority: 7,
        source_type: 'extraction',
        source_session: 'session-5',
        tags: ['architecture', 'database'],
      });

      insertMemory(db, mem1);
      insertMemory(db, mem2);
      insertMemory(db, mem3);
    });

    it('searches by keyword in content', () => {
      const results = searchByKeyword(db, 'functional', 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results.map((m) => m.id)).toContain('mem-fts-1');
      expect(results.map((m) => m.id)).toContain('mem-fts-2');

      db.close();
    });

    it('searches by keyword in tags', () => {
      const results = searchByKeyword(db, 'immutability', 10);
      expect(results.length).toBeGreaterThan(0);
      expect(results.map((m) => m.id)).toContain('mem-fts-2');

      db.close();
    });

    it('respects limit parameter', () => {
      const results = searchByKeyword(db, 'architecture', 1);
      expect(results).toHaveLength(1);

      db.close();
    });

    it('returns empty for empty or whitespace-only query instead of FTS5 syntax error', () => {
      expect(searchByKeyword(db, '', 10)).toEqual([]);
      expect(searchByKeyword(db, '   ', 10)).toEqual([]);

      db.close();
    });
  });

  describe('getMemoriesWithEmbedding + rankBySimilarity', () => {
    let db: ReturnType<typeof openDatabase>;

    beforeEach(() => {
      db = openDatabase(':memory:');

      // Insert memories with embeddings
      const mem1 = makeMemory('mem-emb-1', {
        content: 'Memory 1',
        summary: 'Summary 1',
        memory_type: 'pattern',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-6',
        local_embedding: new Float32Array([1, 0, 0, 0]),
      });

      const mem2 = makeMemory('mem-emb-2', {
        content: 'Memory 2',
        summary: 'Summary 2',
        memory_type: 'pattern',
        confidence: 0.8,
        priority: 7,
        source_type: 'extraction',
        source_session: 'session-6',
        local_embedding: new Float32Array([0.9, 0.1, 0, 0]),
      });

      const mem3 = makeMemory('mem-emb-3', {
        content: 'Memory 3',
        summary: 'Summary 3',
        memory_type: 'pattern',
        confidence: 0.7,
        priority: 6,
        source_type: 'extraction',
        source_session: 'session-6',
        local_embedding: new Float32Array([0, 1, 0, 0]),
      });

      insertMemory(db, mem1);
      insertMemory(db, mem2);
      insertMemory(db, mem3);
    });

    it('excludes non-active memories from embedding candidates', () => {
      // Archival keeps the embedding — without a status filter, /forget-ed
      // memories would resurface in semantic recall.
      updateMemory(db, 'mem-emb-2', { status: 'archived' });

      const candidates = getMemoriesWithEmbedding(db);
      expect(candidates.map((c) => c.memory.id).sort()).toEqual(['mem-emb-1', 'mem-emb-3']);

      const byIds = getMemoriesWithEmbeddingByIds(
        db,
        ['mem-emb-1', 'mem-emb-2', 'mem-emb-3']
      );
      expect(byIds.map((c) => c.memory.id).sort()).toEqual(['mem-emb-1', 'mem-emb-3']);

      db.close();
    });

    it('tags local embeddings with the producing model and filters reads to it', () => {
      // Vectors from two models share a column but not a space. Comparing
      // across them yields plausible scores rather than an error, so reads are
      // filtered to the current model.
      const withLocal = makeMemory('mem-local-1', {
        content: 'local vector memory',
        summary: 'local vector memory',
        confidence: 0.8,
        source_type: 'extraction',
        source_session: 'session-local',
        local_embedding: new Float32Array([0.1, 0.2, 0.3]),
      });
      insertMemory(db, withLocal);

      const tagged = db
        .prepare('SELECT local_embedding_model FROM memories WHERE id = ?')
        .get('mem-local-1') as { local_embedding_model: string | null };
      expect(tagged.local_embedding_model).toBe(LOCAL_EMBED_MODEL);

      expect(getMemoriesWithEmbedding(db).map(c => c.memory.id)).toContain('mem-local-1');

      // A vector produced by some other model must not be returned.
      db.run('UPDATE memories SET local_embedding_model = ? WHERE id = ?', [
        'some/other-model',
        'mem-local-1',
      ]);
      expect(getMemoriesWithEmbedding(db).map(c => c.memory.id)).not.toContain(
        'mem-local-1'
      );
    });

    it('applies the model filter on BOTH read paths, not just the all-rows one', () => {
      // recall.ts uses getMemoriesWithEmbeddingByIds for FTS-prefiltered hits
      // and getMemoriesWithEmbedding otherwise. If only one filtered by model,
      // the same query would silently compare across vector spaces depending
      // on which branch it took.
      const m = makeMemory('mem-local-both', {
        content: 'both paths',
        summary: 'both paths',
        confidence: 0.8,
        source_type: 'extraction',
        source_session: 'session-local',
        local_embedding: new Float32Array([0.7, 0.8, 0.9]),
      });
      insertMemory(db, m);

      expect(getMemoriesWithEmbedding(db).map(c => c.memory.id)).toContain(
        'mem-local-both'
      );
      expect(
        getMemoriesWithEmbeddingByIds(db, ['mem-local-both']).map(c => c.memory.id)
      ).toContain('mem-local-both');

      db.run('UPDATE memories SET local_embedding_model = ? WHERE id = ?', [
        'foreign/model',
        'mem-local-both',
      ]);

      // Assert on the retagged row specifically: the fixtures in beforeEach also
      // carry vectors, so a total-count assertion would be about them, not
      // about the model filter under test.
      expect(getMemoriesWithEmbedding(db).map(c => c.memory.id)).not.toContain('mem-local-both');
      expect(getMemoriesWithEmbeddingByIds(db, ['mem-local-both'])).toHaveLength(0);
    });

    it('excludes legacy local vectors that carry no model tag', () => {
      const legacy = makeMemory('mem-local-legacy', {
        content: 'legacy local vector',
        summary: 'legacy local vector',
        confidence: 0.8,
        source_type: 'extraction',
        source_session: 'session-local',
        local_embedding: new Float32Array([0.4, 0.5, 0.6]),
      });
      insertMemory(db, legacy);
      db.run('UPDATE memories SET local_embedding_model = NULL WHERE id = ?', ['mem-local-legacy']);

      expect(getMemoriesWithEmbedding(db).map(c => c.memory.id)).not.toContain(
        'mem-local-legacy'
      );
    });

    it('warns when an ID-filtered non-null embedding cannot be deserialized', () => {
      db.run('UPDATE memories SET local_embedding = 0 WHERE id = ?', ['mem-emb-1']);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      try {
        const candidates = getMemoriesWithEmbeddingByIds(db, ['mem-emb-1']);

        expect(candidates).toEqual([]);
        expect(warn).toHaveBeenCalledWith(
          '[cortex:db] Skipping memory mem-emb-1: local_embedding deserialized to null'
        );
      } finally {
        warn.mockRestore();
        db.close();
      }
    });

    it('fetches and ranks by embedding similarity', () => {
      const queryEmbedding = new Float64Array([1, 0, 0, 0]);

      const candidates = getMemoriesWithEmbedding(db);
      const results = rankBySimilarity(candidates, queryEmbedding, 10);
      expect(results.length).toBe(3);

      // Should be sorted by similarity (mem1 is identical, mem2 is close, mem3 is orthogonal)
      expect(results[0].memory.id).toBe('mem-emb-1');
      expect(results[1].memory.id).toBe('mem-emb-2');
      expect(results[2].memory.id).toBe('mem-emb-3');
      // Scores should be descending
      expect(results[0].score).toBeGreaterThan(results[1].score);
      expect(results[1].score).toBeGreaterThan(results[2].score);

      db.close();
    });

    it('respects limit parameter', () => {
      const queryEmbedding = new Float64Array([1, 0, 0, 0]);

      const candidates = getMemoriesWithEmbedding(db);
      const results = rankBySimilarity(candidates, queryEmbedding, 2);
      expect(results).toHaveLength(2);
      expect(results[0].memory.id).toBe('mem-emb-1');
      expect(results[1].memory.id).toBe('mem-emb-2');

      db.close();
    });

    it('fetches and ranks by local embedding similarity', () => {
      const db2 = openDatabase(':memory:');

      const mem = makeMemory('mem-local', {
        content: 'Local embedding test',
        summary: 'Local test',
        memory_type: 'pattern',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-7',
        local_embedding: new Float32Array([1, 0, 0]),
      });

      insertMemory(db2, mem);

      const queryEmbedding = new Float32Array([0.95, 0.05, 0]);
      const candidates = getMemoriesWithEmbedding(db2);
      const results = rankBySimilarity(candidates, queryEmbedding, 10);

      expect(results).toHaveLength(1);
      expect(results[0].memory.id).toBe('mem-local');
      expect(results[0].score).toBeGreaterThan(0);

      db2.close();
      db.close();
    });
  });

  describe('Edge CRUD', () => {
    let db: ReturnType<typeof openDatabase>;

    beforeEach(() => {
      db = openDatabase(':memory:');

      // Insert memories for edge tests
      const mem1 = makeMemory('mem-edge-1', {
        content: 'Source memory',
        summary: 'Source',
        memory_type: 'pattern',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-8',
      });

      const mem2 = makeMemory('mem-edge-2', {
        content: 'Target memory',
        summary: 'Target',
        memory_type: 'pattern',
        confidence: 0.8,
        priority: 7,
        source_type: 'extraction',
        source_session: 'session-8',
      });

      insertMemory(db, mem1);
      insertMemory(db, mem2);
    });

    it('inserts edge and retrieves by memory ID', () => {
      const edgeId = insertEdge(db, {
        source_id: 'mem-edge-1',
        target_id: 'mem-edge-2',
        relation_type: 'relates_to',
        strength: 0.7,
        bidirectional: false,
        status: 'active',
      });

      expect(edgeId).toBeDefined();

      const edges = getEdgesForMemory(db, 'mem-edge-1');
      expect(edges).toHaveLength(1);
      expect(edges[0].source_id).toBe('mem-edge-1');
      expect(edges[0].target_id).toBe('mem-edge-2');
      expect(edges[0].relation_type).toBe('relates_to');
      expect(edges[0].strength).toBe(0.7);

      db.close();
    });

    it('materializes classified_at/classify_hash through getEdgesForMemory (attempt-tracking parity)', () => {
      insertEdge(db, {
        source_id: 'mem-edge-1',
        target_id: 'mem-edge-2',
        relation_type: 'relates_to',
        strength: 0.5,
        bidirectional: true,
        status: 'active',
        classified_at: '2026-08-12T00:00:00.000Z',
        classify_hash: 'abc123',
      });

      const edges = getEdgesForMemory(db, 'mem-edge-1');
      expect(edges).toHaveLength(1);
      expect(edges[0].classified_at).toBe('2026-08-12T00:00:00.000Z');
      expect(edges[0].classify_hash).toBe('abc123');

      db.close();
    });

    it('enforces unique constraint on (source_id, target_id, relation_type)', () => {
      insertEdge(db, {
        source_id: 'mem-edge-1',
        target_id: 'mem-edge-2',
        relation_type: 'relates_to',
        strength: 0.7,
        bidirectional: false,
        status: 'active',
      });

      // Attempt to insert duplicate edge
      expect(() =>
        insertEdge(db, {
          source_id: 'mem-edge-1',
          target_id: 'mem-edge-2',
          relation_type: 'relates_to',
          strength: 0.8, // Different strength, but same source/target/relation
          bidirectional: false,
          status: 'active',
        })
      ).toThrow();

      db.close();
    });

    it('allows same source/target with different relation type', () => {
      insertEdge(db, {
        source_id: 'mem-edge-1',
        target_id: 'mem-edge-2',
        relation_type: 'relates_to',
        strength: 0.7,
        bidirectional: false,
        status: 'active',
      });

      // Different relation type should succeed
      const edgeId = insertEdge(db, {
        source_id: 'mem-edge-1',
        target_id: 'mem-edge-2',
        relation_type: 'refines',
        strength: 0.8,
        bidirectional: false,
        status: 'active',
      });

      expect(edgeId).toBeDefined();

      const edges = getEdgesForMemory(db, 'mem-edge-1');
      expect(edges).toHaveLength(2);

      db.close();
    });

    it('retrieves bidirectional edges from target side', () => {
      insertEdge(db, {
        source_id: 'mem-edge-1',
        target_id: 'mem-edge-2',
        relation_type: 'relates_to',
        strength: 0.7,
        bidirectional: true,
        status: 'active',
      });

      const edgesFromSource = getEdgesForMemory(db, 'mem-edge-1');
      expect(edgesFromSource).toHaveLength(1);

      const edgesFromTarget = getEdgesForMemory(db, 'mem-edge-2');
      expect(edgesFromTarget).toHaveLength(1);
      expect(edgesFromTarget[0].bidirectional).toBe(true);

      db.close();
    });

    it('does not retrieve unidirectional edges from target side', () => {
      insertEdge(db, {
        source_id: 'mem-edge-1',
        target_id: 'mem-edge-2',
        relation_type: 'relates_to',
        strength: 0.7,
        bidirectional: false,
        status: 'active',
      });

      const edgesFromTarget = getEdgesForMemory(db, 'mem-edge-2');
      expect(edgesFromTarget).toHaveLength(0);

      db.close();
    });

    it('gets all edges', () => {
      insertEdge(db, {
        source_id: 'mem-edge-1',
        target_id: 'mem-edge-2',
        relation_type: 'relates_to',
        strength: 0.7,
        bidirectional: false,
        status: 'active',
      });

      insertEdge(db, {
        source_id: 'mem-edge-2',
        target_id: 'mem-edge-1',
        relation_type: 'refines',
        strength: 0.6,
        bidirectional: false,
        status: 'active',
      });

      const allEdges = getAllEdges(db);
      expect(allEdges).toHaveLength(2);

      db.close();
    });
  });

  describe('Extraction Checkpoint', () => {
    let db: ReturnType<typeof openDatabase>;

    beforeEach(() => {
      db = openDatabase(':memory:');
    });

    it('saves and retrieves checkpoint', () => {
      saveExtractionCheckpoint(db, {
        session_id: 'session-ckpt-1',
        cursor_position: 12345,
      });

      const checkpoint = getExtractionCheckpoint(db, 'session-ckpt-1');
      expect(checkpoint).toBeDefined();
      expect(checkpoint?.session_id).toBe('session-ckpt-1');
      expect(checkpoint?.cursor_position).toBe(12345);

      db.close();
    });

    it('returns null for non-existent checkpoint', () => {
      const checkpoint = getExtractionCheckpoint(db, 'non-existent');
      expect(checkpoint).toBeNull();

      db.close();
    });

    it('updates checkpoint on duplicate session_id', () => {
      saveExtractionCheckpoint(db, {
        session_id: 'session-ckpt-2',
        cursor_position: 100,
      });

      saveExtractionCheckpoint(db, {
        session_id: 'session-ckpt-2',
        cursor_position: 200,
      });

      const checkpoint = getExtractionCheckpoint(db, 'session-ckpt-2');
      expect(checkpoint?.cursor_position).toBe(200);

      db.close();
    });

    it('respects caller-provided extracted_at timestamp', () => {
      const customTimestamp = '2024-01-15T10:30:00.000Z';

      saveExtractionCheckpoint(db, {
        session_id: 'session-ckpt-3',
        cursor_position: 500,
        extracted_at: customTimestamp,
      });

      const checkpoint = getExtractionCheckpoint(db, 'session-ckpt-3');
      expect(checkpoint?.extracted_at).toBe(customTimestamp);

      db.close();
    });

    it('generates extracted_at when not provided', () => {
      const beforeSave = new Date();

      saveExtractionCheckpoint(db, {
        session_id: 'session-ckpt-4',
        cursor_position: 600,
      });

      const checkpoint = getExtractionCheckpoint(db, 'session-ckpt-4');
      expect(checkpoint).toBeDefined();

      const afterSave = new Date();
      const extractedAt = new Date(checkpoint!.extracted_at);

      expect(extractedAt.getTime()).toBeGreaterThanOrEqual(beforeSave.getTime());
      expect(extractedAt.getTime()).toBeLessThanOrEqual(afterSave.getTime());

      db.close();
    });
  });

  describe('Checkpoint/Restore', () => {
    it('creates checkpoint and restores database', () => {
      const db = openDatabase(':memory:');

      // Insert initial data
      const mem1 = makeMemory('mem-ckpt-1', {
        content: 'Original memory',
        summary: 'Original',
        memory_type: 'pattern',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-9',
      });

      insertMemory(db, mem1);

      // Create checkpoint
      const checkpointPath = createCheckpoint(db);
      expect(checkpointPath).toBeDefined();

      // Modify database
      updateMemory(db, 'mem-ckpt-1', { content: 'Modified content' });

      const modifiedMemory = getMemory(db, 'mem-ckpt-1');
      expect(modifiedMemory?.content).toBe('Modified content');

      // Restore from checkpoint
      restoreCheckpoint(db, checkpointPath);

      const restoredMemory = getMemory(db, 'mem-ckpt-1');
      expect(restoredMemory?.content).toBe('Original memory');

      db.close();
    });

    it('cleans up FTS rows orphaned by restore (regression)', () => {
      const db = openDatabase(':memory:');

      // Insert one memory, checkpoint it
      insertMemory(db, makeMemory('mem-fts-keep', {
        content: 'Memory about zebras and savannas',
        summary: 'Zebra memory',
        confidence: 0.9,
        source_type: 'extraction',
        source_session: 'session-fts',
      }));

      const checkpointPath = createCheckpoint(db);

      // Insert a SECOND memory after the checkpoint — its FTS row would
      // become an orphan on restore without explicit cleanup
      insertMemory(db, makeMemory('mem-fts-orphan', {
        content: 'Memory about quixotic wombats',
        summary: 'Wombat memory',
        confidence: 0.9,
        source_type: 'extraction',
        source_session: 'session-fts',
      }));

      restoreCheckpoint(db, checkpointPath);

      // Base table only has the checkpointed memory
      expect(getMemory(db, 'mem-fts-orphan')).toBeNull();
      expect(getMemory(db, 'mem-fts-keep')).not.toBeNull();

      // FTS row count matches memories row count — no orphans
      const memCount = (db.prepare('SELECT COUNT(*) AS c FROM memories').get() as { c: number }).c;
      const ftsCount = (db.prepare('SELECT COUNT(*) AS c FROM memories_fts').get() as { c: number }).c;
      expect(ftsCount).toBe(memCount);
      expect(ftsCount).toBe(1);

      // The orphaned content is not searchable (no phantom hits)
      const phantomHits = searchByKeyword(db, 'wombats', 10);
      expect(phantomHits).toEqual([]);

      // The restored memory remains searchable
      const realHits = searchByKeyword(db, 'zebras', 10);
      expect(realHits.map((m) => m.id)).toEqual(['mem-fts-keep']);

      db.close();
      rmSync(checkpointPath, { force: true });
    });

    it('rejects checkpoint path with single quote (SQL injection prevention)', () => {
      const db = openDatabase(':memory:');

      // Attempt to create checkpoint - should pass validation
      const validPath = createCheckpoint(db);
      expect(validPath).toBeDefined();

      // Attempt to restore with malicious path containing single quote
      const maliciousPath = "'; DROP TABLE memories; --";

      expect(() => restoreCheckpoint(db, maliciousPath)).toThrow(
        'Path contains invalid character: single quote'
      );

      db.close();
    });
  });

  describe('routeToDatabase', () => {
    it('routes to project database for project scope', () => {
      const projectDb = openDatabase(':memory:');
      const globalDb = openDatabase(':memory:');

      const routed = routeToDatabase('project', projectDb, globalDb);
      expect(routed).toBe(projectDb);

      projectDb.close();
      globalDb.close();
    });

    it('routes to global database for global scope', () => {
      const projectDb = openDatabase(':memory:');
      const globalDb = openDatabase(':memory:');

      const routed = routeToDatabase('global', projectDb, globalDb);
      expect(routed).toBe(globalDb);

      projectDb.close();
      globalDb.close();
    });
  });

  describe('schema migrations (idempotent, tables exist in the wild)', () => {
    it('adds archived_at and transcript_length to a legacy database', () => {
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');
      const { Database } = require('bun:sqlite');

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-migration-'));
      const dbPath = path.join(dir, 'legacy.db');

      // Simulate a legacy database created before the columns existed
      const legacy = new Database(dbPath);
      legacy.run(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY, content TEXT NOT NULL, summary TEXT NOT NULL,
          memory_type TEXT NOT NULL, scope TEXT NOT NULL,
          embedding BLOB, local_embedding BLOB,
          confidence REAL NOT NULL, priority INTEGER NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0,
          source_type TEXT NOT NULL, source_session TEXT NOT NULL, source_context TEXT NOT NULL,
          tags TEXT NOT NULL, access_count INTEGER NOT NULL DEFAULT 0,
          last_accessed_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
        )
      `);
      legacy.run(`
        CREATE TABLE extraction_checkpoints (
          id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
          cursor_position INTEGER NOT NULL, extracted_at TEXT NOT NULL
        )
      `);
      const now = new Date().toISOString();
      legacy.run(
        `INSERT INTO memories (id, content, summary, memory_type, scope, confidence, priority, source_type, source_session, source_context, tags, last_accessed_at, created_at, updated_at)
         VALUES ('legacy-1', 'c', 's', 'context', 'project', 0.8, 5, 'manual', 'sess', '{}', '[]', ?, ?, ?)`,
        [now, now, now]
      );
      legacy.close();

      // openDatabase must migrate in place without touching existing rows
      const db = openDatabase(dbPath);
      const memoryCols = (db.prepare(`PRAGMA table_info(memories)`).all() as { name: string }[]).map(c => c.name);
      const checkpointCols = (db.prepare(`PRAGMA table_info(extraction_checkpoints)`).all() as { name: string }[]).map(c => c.name);
      expect(memoryCols).toContain('archived_at');
      expect(checkpointCols).toContain('transcript_length');
      expect(memoryCols).toContain('local_embedding_model');
      expect(checkpointCols).toContain('projection_version');

      // Legacy row readable, archived_at defaults to null
      const legacyMemory = getMemory(db, 'legacy-1');
      expect(legacyMemory).not.toBeNull();
      expect(legacyMemory!.archived_at).toBeNull();

      // A legacy row predates both new columns, so they read as "unknown"
      // rather than as a false claim about which model or projection produced it.
      const legacyRow = db
        .prepare(`SELECT local_embedding_model FROM memories WHERE id = 'legacy-1'`)
        .get() as { local_embedding_model: string | null };
      expect(legacyRow.local_embedding_model).toBeNull();
      db.close();

      // Idempotent: re-opening must not throw (duplicate column)
      const again = openDatabase(dbPath);
      expect(getMemory(again, 'legacy-1')).not.toBeNull();
      again.close();

      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('persists archived_at through insert, update, and read', () => {
      const db = openDatabase(':memory:');
      const now = new Date().toISOString();
      const memory = makeMemory('arch-1', {
        confidence: 0.8,
        source_session: 'sess',
      });
      insertMemory(db, memory);

      expect(getMemory(db, 'arch-1')!.archived_at).toBeNull();

      updateMemory(db, 'arch-1', { status: 'archived', archived_at: now });
      const updated = getMemory(db, 'arch-1');
      expect(updated!.status).toBe('archived');
      expect(updated!.archived_at).toBe(now);
      db.close();
    });

    it('adds classified_at to a legacy edges table', () => {
      const fs = require('node:fs');
      const os = require('node:os');
      const path = require('node:path');
      const { Database } = require('bun:sqlite');

      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-edge-migration-'));
      const dbPath = path.join(dir, 'legacy.db');

      // Simulate a legacy database whose edges table predates classified_at
      const legacy = new Database(dbPath);
      legacy.run(`
        CREATE TABLE memories (
          id TEXT PRIMARY KEY, content TEXT NOT NULL, summary TEXT NOT NULL,
          memory_type TEXT NOT NULL, scope TEXT NOT NULL,
          embedding BLOB, local_embedding BLOB,
          confidence REAL NOT NULL, priority INTEGER NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 0,
          source_type TEXT NOT NULL, source_session TEXT NOT NULL, source_context TEXT NOT NULL,
          tags TEXT NOT NULL, access_count INTEGER NOT NULL DEFAULT 0,
          last_accessed_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active'
        )
      `);
      legacy.run(`
        CREATE TABLE edges (
          id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL,
          relation_type TEXT NOT NULL, strength REAL NOT NULL,
          bidirectional INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
          created_at TEXT NOT NULL
        )
      `);
      legacy.close();

      const db = openDatabase(dbPath);
      const edgeCols = (db.prepare(`PRAGMA table_info(edges)`).all() as { name: string }[]).map(c => c.name);
      expect(edgeCols).toContain('classified_at');
      expect(edgeCols).toContain('classify_hash');
      expect(edgeCols).toContain('last_failed_at');
      db.close();

      // Idempotent: re-opening must not throw (duplicate column)
      const again = openDatabase(dbPath);
      const edgeCols2 = (again.prepare(`PRAGMA table_info(edges)`).all() as { name: string }[]).map(c => c.name);
      expect(edgeCols2).toContain('classified_at');
      expect(edgeCols2).toContain('last_failed_at');
      again.close();

      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('classifiable edges respect attempt tracking and content changes', () => {
      const { getRelatesToEdgesWithMemories, markEdgeClassified } = require('./db.js');
      const { selectClassificationCandidates, pairContentHash } = require('../commands/semantic-edges.js');
      const db = openDatabase(':memory:');

      function seedMemory(id: string): void {
        insertMemory(db, makeMemory(id, {
          content: `content ${id}`, summary: `summary ${id}`,
          confidence: 0.8, source_session: 'sess',
        }));
      }
      seedMemory('a');
      seedMemory('b');
      seedMemory('c');

      const e1 = insertEdge(db, {
        source_id: 'a', target_id: 'b', relation_type: 'relates_to',
        strength: 0.5, bidirectional: true, status: 'active',
      });
      const e2 = insertEdge(db, {
        source_id: 'b', target_id: 'c', relation_type: 'relates_to',
        strength: 0.4, bidirectional: true, status: 'active',
      });

      // Both unclassified → both classifiable
      expect(selectClassificationCandidates(getRelatesToEdgesWithMemories(db), 0, new Date()).map(c => c.edgeId).sort())
        .toEqual([e1, e2].sort());

      // Attempt with unchanged content → no longer classifiable
      const rows = getRelatesToEdgesWithMemories(db);
      const e1Row = rows.find(r => r.edge.id === e1)!;
      const e1Hash = pairContentHash(e1Row.source, e1Row.target);
      markEdgeClassified(db, e1, '2026-08-12T10:00:00.000Z', e1Hash);
      expect(selectClassificationCandidates(getRelatesToEdgesWithMemories(db), 0, new Date()).map(c => c.edgeId))
        .toEqual([e2]);

      // Typed edges are never classifiable
      insertEdge(db, {
        source_id: 'a', target_id: 'c', relation_type: 'refines',
        strength: 0.9, bidirectional: true, status: 'active',
      });
      expect(selectClassificationCandidates(getRelatesToEdgesWithMemories(db), 0, new Date()).map(c => c.edgeId))
        .toEqual([e2]);

      // Content change after the attempt → re-qualifies
      updateMemory(db, 'a', { content: 'changed content a' });
      expect(selectClassificationCandidates(getRelatesToEdgesWithMemories(db), 0, new Date()).map(c => c.edgeId).sort())
        .toEqual([e1, e2].sort());

      // limit is respected (0 = all)
      expect(selectClassificationCandidates(getRelatesToEdgesWithMemories(db), 1, new Date()).length).toBe(1);

      // classified_at / classify_hash round-trip through reads
      const e1Stored = getAllEdges(db).find(e => e.id === e1)!;
      expect(e1Stored.classified_at).toBe('2026-08-12T10:00:00.000Z');
      expect(e1Stored.classify_hash).toBe(e1Hash);
      db.close();
    });

    it('failure backoff gates re-classification until expiry or content change', () => {
      const { getRelatesToEdgesWithMemories, markEdgeClassified, markEdgeFailed } = require('./db.js');
      const { selectClassificationCandidates, pairContentHash } = require('../commands/semantic-edges.js');
      const db = openDatabase(':memory:');

      function seedMemory(id: string): void {
        insertMemory(db, makeMemory(id, {
          content: `content ${id}`, summary: `summary ${id}`,
          confidence: 0.8, source_session: 'sess',
        }));
      }
      seedMemory('a');
      seedMemory('b');

      const e1 = insertEdge(db, {
        source_id: 'a', target_id: 'b', relation_type: 'relates_to',
        strength: 0.5, bidirectional: true, status: 'active',
      });

      const rows = getRelatesToEdgesWithMemories(db);
      const row = rows.find(r => r.edge.id === e1)!;
      const hash = pairContentHash(row.source, row.target);

      // Recent failure with unchanged content → not classifiable (backoff)
      const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      markEdgeFailed(db, e1, recent, hash);
      expect(selectClassificationCandidates(getRelatesToEdgesWithMemories(db), 0, new Date()).map(c => c.edgeId))
        .toEqual([]);

      // last_failed_at round-trips through reads; a failure is NOT an answer
      const stored = getAllEdges(db).find(e => e.id === e1)!;
      expect(stored.last_failed_at).toBe(recent);
      expect(stored.classified_at).toBeNull();

      // Content change after the failure → immediately re-qualifies
      updateMemory(db, 'a', { content: 'changed content a' });
      expect(selectClassificationCandidates(getRelatesToEdgesWithMemories(db), 0, new Date()).map(c => c.edgeId))
        .toEqual([e1]);

      // Re-failed with the new content hash, but the backoff has expired
      // (25h > 24h) → classifiable again
      const rowsAfter = getRelatesToEdgesWithMemories(db);
      const rowAfter = rowsAfter.find(r => r.edge.id === e1)!;
      const hashAfter = pairContentHash(rowAfter.source, rowAfter.target);
      const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
      markEdgeFailed(db, e1, stale, hashAfter);
      expect(selectClassificationCandidates(getRelatesToEdgesWithMemories(db), 0, new Date()).map(c => c.edgeId))
        .toEqual([e1]);

      // An answered edge clears the failure record: the backoff only applies
      // to edges that are still unclassified
      markEdgeClassified(db, e1, '2026-08-12T10:00:00.000Z', hashAfter);
      const cleared = getAllEdges(db).find(e => e.id === e1)!;
      expect(cleared.last_failed_at).toBeNull();
      db.close();
    });

    it('getRelatesToEdges round-trips last_failed_at (a failure is not a decline)', () => {
      const { getRelatesToEdges, getRelatesToEdgesWithMemories, markEdgeClassified, markEdgeFailed } = require('./db.js');
      const { pairContentHash } = require('../commands/semantic-edges.js');
      const db = openDatabase(':memory:');

      function seedMemory(id: string): void {
        insertMemory(db, makeMemory(id, {
          content: `content ${id}`, summary: `summary ${id}`,
          confidence: 0.8, source_session: 'sess',
        }));
      }
      seedMemory('a');
      seedMemory('b');

      const e1 = insertEdge(db, {
        source_id: 'a', target_id: 'b', relation_type: 'relates_to',
        strength: 0.5, bidirectional: true, status: 'active',
      });

      // Never attempted → null on both fields
      const fresh = getRelatesToEdges(db).find((e: { id: string }) => e.id === e1)!;
      expect(fresh.last_failed_at).toBeNull();
      expect(fresh.classified_at).toBeNull();

      // Recorded failure → the plain read reports it. null means
      // "never failed" (the backoff signal), so a mapper that drops the
      // column here would silently falsify it.
      const rows = getRelatesToEdgesWithMemories(db);
      const row = rows.find((r: { edge: { id: string } }) => r.edge.id === e1)!;
      const hash = pairContentHash(row.source, row.target);
      const failedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      markEdgeFailed(db, e1, failedAt, hash);
      const failedEdge = getRelatesToEdges(db).find((e: { id: string }) => e.id === e1)!;
      expect(failedEdge.last_failed_at).toBe(failedAt);
      expect(failedEdge.classified_at).toBeNull();

      // An answered edge clears the failure record in the plain read too
      markEdgeClassified(db, e1, '2026-08-12T10:00:00.000Z', hash);
      const cleared = getRelatesToEdges(db).find((e: { id: string }) => e.id === e1)!;
      expect(cleared.last_failed_at).toBeNull();
      expect(cleared.classified_at).toBe('2026-08-12T10:00:00.000Z');
      db.close();
    });
  });

  describe('repointEdgesToMemory / repointFactSources', () => {
    const { repointEdgesToMemory, repointFactSources, upsertEntity, insertFact, getFactsByMemory } = require('./db.js');

    function seedMemory(db: ReturnType<typeof openDatabase>, id: string): void {
      insertMemory(db, makeMemory(id, {
        content: `content ${id}`, summary: `summary ${id}`,
        confidence: 0.8, source_session: 'sess',
      }));
    }

    it('re-points edges, drops self-references and duplicates, keeps supersedes', () => {
      const db = openDatabase(':memory:');
      for (const id of ['old', 'merged', 'other', 'shared']) seedMemory(db, id);

      insertEdge(db, { source_id: 'old', target_id: 'other', relation_type: 'source_of', strength: 1.0, bidirectional: false, status: 'active' });
      insertEdge(db, { source_id: 'old', target_id: 'merged', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
      insertEdge(db, { source_id: 'old', target_id: 'shared', relation_type: 'refines', strength: 0.5, bidirectional: true, status: 'active' });
      insertEdge(db, { source_id: 'merged', target_id: 'shared', relation_type: 'refines', strength: 0.5, bidirectional: true, status: 'active' });
      insertEdge(db, { source_id: 'other', target_id: 'old', relation_type: 'supersedes', strength: 1.0, bidirectional: false, status: 'active' });

      repointEdgesToMemory(db, 'old', 'merged');

      const edges = getAllEdges(db);
      // source_of re-pointed
      const sourceOf = edges.filter((e: Edge) => e.relation_type === 'source_of');
      expect(sourceOf.length).toBe(1);
      expect(sourceOf[0].source_id).toBe('merged');
      // old↔merged dropped (would self-reference)
      expect(edges.some((e: Edge) => e.source_id === e.target_id)).toBe(false);
      expect(edges.filter((e: Edge) => e.relation_type === 'relates_to').length).toBe(0);
      // duplicate refines dropped, existing one kept
      const refines = edges.filter((e: Edge) => e.relation_type === 'refines');
      expect(refines.length).toBe(1);
      expect(refines[0].source_id).toBe('merged');
      // supersedes untouched (history)
      const supersedes = edges.filter((e: Edge) => e.relation_type === 'supersedes');
      expect(supersedes.length).toBe(1);
      expect(supersedes[0].target_id).toBe('old');
      db.close();
    });

    it('re-points fact sources', () => {
      const db = openDatabase(':memory:');
      seedMemory(db, 'old');
      seedMemory(db, 'merged');

      const entityId = upsertEntity(db, 'Thing', 'concept');
      const now = new Date().toISOString();
      insertFact(db, {
        id: 'f1', entity_id: entityId, predicate: 'is', object: 'a thing',
        source_memory_id: 'old', confidence: 0.7, valid_from: now, valid_to: null, created_at: now,
      });

      const changed = repointFactSources(db, 'old', 'merged');
      expect(changed).toBe(1);
      expect(getFactsByMemory(db, 'old').length).toBe(0);
      expect(getFactsByMemory(db, 'merged').length).toBe(1);
      db.close();
    });
  });
});

describe('Schema versioning (PRAGMA user_version)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'cortex-schema-test-'));
  });

  it('stamps a fresh database with the current schema version', () => {
    const db = openDatabase(':memory:');

    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(row.user_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(row.user_version).toBe(1);

    db.close();
  });

  it('refuses to open a database with a newer schema version', () => {
    const dbPath = join(tmpDir, 'future.db');

    // Simulate a DB written by a newer plugin version
    const raw = new Database(dbPath);
    raw.run('PRAGMA user_version = 99');
    raw.close();

    expect(() => openDatabase(dbPath)).toThrow(
      /schema version 99 is newer than supported version 1/
    );

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reopens an already-stamped database without error', () => {
    const dbPath = join(tmpDir, 'stamped.db');

    const first = openDatabase(dbPath);
    first.close();

    const second = openDatabase(dbPath);
    const row = second.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(row.user_version).toBe(CURRENT_SCHEMA_VERSION);
    second.close();

    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stamps a legacy (version 0) file database and preserves its data', () => {
    const dbPath = join(tmpDir, 'legacy.db');

    const db = openDatabase(dbPath);
    insertMemory(db, makeMemory('mem-schema-1', {
      content: 'legacy content survives version stamping',
      summary: 'legacy',
      confidence: 0.8,
      source_type: 'extraction',
      source_session: 'sess-schema',
    }));
    // Reset to 0 as if written by pre-versioning code
    db.run('PRAGMA user_version = 0');
    db.close();

    const reopened = openDatabase(dbPath);
    const row = reopened.prepare('PRAGMA user_version').get() as { user_version: number };
    expect(row.user_version).toBe(CURRENT_SCHEMA_VERSION);
    expect(getMemory(reopened, 'mem-schema-1')).not.toBeNull();
    reopened.close();

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

// ============================================================================
// Regression tests: findings 11 and 12 — status-filtered getMemoriesByIds,
// fact supersede on archive, active-source filter in getCurrentFacts
// ============================================================================

import {
  getMemoriesByIds,
  upsertEntity,
  insertFact,
  getCurrentFacts,
  supersedeFactsForMemory,
  getFactsByMemory,
} from './db.js';

function makeStatusMemory(id: string, status: 'active' | 'archived' | 'superseded'): Memory {
  const now = new Date().toISOString();
  return makeMemory(id, {
    content: `content ${id}`,
    summary: `summary ${id}`,
    confidence: 0.8,
    source_session: 'sess',
    created_at: now,
    updated_at: now,
    last_accessed_at: now,
    status,
  });
}

describe('getMemoriesByIds status filter (finding 11)', () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
    insertMemory(db, makeStatusMemory('m-active', 'active'));
    insertMemory(db, makeStatusMemory('m-archived', 'archived'));
    insertMemory(db, makeStatusMemory('m-superseded', 'superseded'));
  });

  it('defaults to active-only', () => {
    const result = getMemoriesByIds(db, ['m-active', 'm-archived', 'm-superseded']);
    expect(result.map(m => m.id)).toEqual(['m-active']);
  });

  it("returns all statuses with 'any'", () => {
    const result = getMemoriesByIds(db, ['m-active', 'm-archived', 'm-superseded'], 'any');
    expect(result.map(m => m.id).sort()).toEqual(['m-active', 'm-archived', 'm-superseded']);
  });

  it('supports explicit status lists', () => {
    const result = getMemoriesByIds(db, ['m-active', 'm-archived'], ['archived']);
    expect(result.map(m => m.id)).toEqual(['m-archived']);
  });

  it('returns empty for an empty status list', () => {
    expect(getMemoriesByIds(db, ['m-active'], [])).toEqual([]);
  });
});

describe('fact supersede on archive (finding 12)', () => {
  let db: Database;
  let entityId: string;

  beforeEach(() => {
    db = openDatabase(':memory:');
    insertMemory(db, makeStatusMemory('fact-src', 'active'));
    entityId = upsertEntity(db, 'PgBouncer', 'tool');
    insertFact(db, {
      id: 'fact-1',
      entity_id: entityId,
      predicate: 'used for',
      object: 'connection pooling',
      source_memory_id: 'fact-src',
      confidence: 0.9,
      valid_from: new Date().toISOString(),
      valid_to: null,
      created_at: new Date().toISOString(),
    });
  });

  it('supersedeFactsForMemory retracts current facts and reports count', () => {
    expect(getCurrentFacts(db, entityId)).toHaveLength(1);

    const count = supersedeFactsForMemory(db, 'fact-src');
    expect(count).toBe(1);
    expect(getCurrentFacts(db, entityId)).toHaveLength(0);

    // Idempotent: second call supersedes nothing new
    expect(supersedeFactsForMemory(db, 'fact-src')).toBe(0);

    // History preserved: fact still exists with valid_to set
    const all = getFactsByMemory(db, 'fact-src');
    expect(all).toHaveLength(1);
    expect(all[0].valid_to).not.toBeNull();
  });

  it('getCurrentFacts excludes facts whose source memory is not active (defense in depth)', () => {
    // Archive the source WITHOUT superseding the fact (a missed archive path)
    updateMemory(db, 'fact-src', { status: 'archived' });

    expect(getCurrentFacts(db, entityId)).toHaveLength(0);
  });

  it('getCurrentFacts keeps facts when the source memory is active', () => {
    expect(getCurrentFacts(db, entityId)).toHaveLength(1);
  });
});

// ============================================================================
// openDatabaseReadOnly — hot read-only paths (prompt-recall hook)
// ============================================================================

import { openDatabaseReadOnly, searchByKeywordOr } from './db.js';

describe('openDatabaseReadOnly', () => {
  function makeRoMemory(id: string): Memory {
    const now = new Date().toISOString();
    return makeMemory(id, {
      content: 'readonly nixos content',
      summary: 'readonly nixos summary',
      confidence: 0.9,
      source_session: 's1',
      created_at: now,
      last_accessed_at: now,
      updated_at: now,
    });
  }

  it('reads an existing database, including FTS search', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortex-ro-test-'));
    const dbPath = join(dir, 'cortex.db');
    try {
      const rw = openDatabase(dbPath);
      insertMemory(rw, makeRoMemory('ro-1'));
      rw.close();

      const ro = openDatabaseReadOnly(dbPath);
      try {
        expect(getMemory(ro, 'ro-1')).not.toBeNull();
        const hits = searchByKeywordOr(ro, ['nixos'], 5);
        expect(hits.map(m => m.id)).toContain('ro-1');
      } finally {
        ro.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects writes (readonly enforced by SQLite)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortex-ro-test-'));
    const dbPath = join(dir, 'cortex.db');
    try {
      openDatabase(dbPath).close();

      const ro = openDatabaseReadOnly(dbPath);
      try {
        expect(() => insertMemory(ro, makeRoMemory('ro-write'))).toThrow();
      } finally {
        ro.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not run schema DDL — no tables are created on a database it did not initialize', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortex-ro-test-'));
    const dbPath = join(dir, 'bare.db');
    try {
      // Create a bare SQLite file WITHOUT cortex schema
      const bare = new Database(dbPath);
      bare.run('CREATE TABLE unrelated (x INTEGER)');
      bare.close();

      const ro = openDatabaseReadOnly(dbPath);
      try {
        const tables = ro
          .prepare("SELECT name FROM sqlite_master WHERE type='table'")
          .all() as { name: string }[];
        expect(tables.map(t => t.name)).not.toContain('memories');
      } finally {
        ro.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws when the file does not exist (callers must check first)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cortex-ro-test-'));
    try {
      expect(() => openDatabaseReadOnly(join(dir, 'missing.db'))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// Corrupt-cell guards, watermark counting, and endpoint validation (r51)
// ============================================================================

import {
  getEntityByName,
  getAllEntities,
  searchEntities,
  countActiveMemoriesCreatedAfter,
  getRelatesToEdgesWithMemories,
} from './db.js';

describe('corrupt JSON list cells degrade the row, never the read', () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  // The comment on rowToMemory claims parity with the local_embedding guard,
  // which warns unconditionally. Valid-but-non-array JSON never enters the
  // catch, so without an explicit branch it degraded silently while the
  // comment promised a diagnostic.
  it.each([
    ['5', 'number'],
    ['null', 'null'],
    ['{}', 'object'],
    ['"a string"', 'string'],
  ])('warns and falls back to [] when a tags cell holds valid non-array JSON (%s)', (cell, shape) => {
    insertMemory(db, makeMemory('mem-nonarray-tags', { tags: ['ok'] }));
    db.prepare('UPDATE memories SET tags = ? WHERE id = ?').run(cell, 'mem-nonarray-tags');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const retrieved = getMemory(db, 'mem-nonarray-tags');
      expect(retrieved?.tags).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        `[cortex:db] Memory mem-nonarray-tags: tags deserialized to ${shape}, not an array; falling back to []`
      );
    } finally {
      warn.mockRestore();
      db.close();
    }
  });

  it('keeps every entity read alive when one aliases cell is unparseable', () => {
    const id = upsertEntity(db, 'Ada Lovelace', 'person', ['Ada']);
    db.prepare('UPDATE entities SET aliases = ? WHERE id = ?').run('not-json', id);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // All three read paths route through rowToEntity; before the guard, any
      // one of them threw a context-free SyntaxError for the whole result set.
      expect(getEntityByName(db, 'Ada Lovelace')?.aliases).toEqual([]);
      expect(getAllEntities(db).map((e) => e.aliases)).toEqual([[]]);
      expect(searchEntities(db, 'Ada').map((e) => e.aliases)).toEqual([[]]);
      expect(warn).toHaveBeenCalledWith(
        `[cortex:db] Entity ${id}: aliases deserialized to invalid JSON; falling back to []`
      );
    } finally {
      warn.mockRestore();
      db.close();
    }
  });

  it('warns and falls back when an aliases cell holds valid non-array JSON', () => {
    const id = upsertEntity(db, 'Grace Hopper', 'person', ['Grace']);
    db.prepare('UPDATE entities SET aliases = ? WHERE id = ?').run('{}', id);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(getEntityByName(db, 'Grace Hopper')?.aliases).toEqual([]);
      expect(warn).toHaveBeenCalledWith(
        `[cortex:db] Entity ${id}: aliases deserialized to object, not an array; falling back to []`
      );
    } finally {
      warn.mockRestore();
      db.close();
    }
  });
});

describe('countActiveMemoriesCreatedAfter (AI-prune watermark)', () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  it('counts strictly after the watermark and excludes non-active rows', () => {
    const watermark = '2026-01-10T00:00:00.000Z';
    insertMemory(db, makeMemory('before', { created_at: '2026-01-09T23:59:59.999Z' }));
    // Exactly at the watermark is NOT new work: the comparison is `>`.
    insertMemory(db, makeMemory('at', { created_at: watermark }));
    insertMemory(db, makeMemory('after-1', { created_at: '2026-01-10T00:00:00.001Z' }));
    insertMemory(db, makeMemory('after-2', { created_at: '2026-02-01T00:00:00.000Z' }));
    insertMemory(db, makeMemory('after-archived', {
      created_at: '2026-02-01T00:00:00.000Z',
      status: 'archived',
      archived_at: '2026-02-02T00:00:00.000Z',
    }));

    expect(countActiveMemoriesCreatedAfter(db, watermark)).toBe(2);
    db.close();
  });
});

describe('getRelatesToEdgesWithMemories endpoint validation', () => {
  it('drops a row whose endpoint memory_type is out of domain instead of passing it on', () => {
    const db = openDatabase(':memory:');
    insertMemory(db, makeMemory('src'));
    insertMemory(db, makeMemory('tgt'));
    insertEdge(db, {
      source_id: 'src', target_id: 'tgt', relation_type: 'relates_to',
      strength: 0.5, bidirectional: true, status: 'active',
    });
    expect(getRelatesToEdgesWithMemories(db)).toHaveLength(1);

    // The JOIN reads memory_type straight off the memories table, bypassing
    // rowToMemory — so a legacy/corrupt value would otherwise flow untouched
    // into a classification prompt.
    db.prepare('UPDATE memories SET memory_type = ? WHERE id = ?').run('not-a-type', 'src');

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(getRelatesToEdgesWithMemories(db)).toHaveLength(0);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("invalid endpoint memory_type (source 'not-a-type', target 'context')")
      );
    } finally {
      warn.mockRestore();
      db.close();
    }
  });
});
