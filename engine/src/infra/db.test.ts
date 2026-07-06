import { describe, it, expect, beforeEach } from 'vitest';
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
} from './db.js';
import { rankBySimilarity } from '../core/similarity.js';
import { createMemory, createEdge } from '../core/types.js';
import type { Memory, Edge, MemoryScope } from '../core/types.js';

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
      const memory = createMemory({
        id: 'mem-1',
        content: 'Use functional core pattern',
        summary: 'FP architecture principle',
        memory_type: 'architecture',
        scope: 'project',
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

      const memory = createMemory({
        id: 'mem-emb',
        content: 'Test embeddings',
        summary: 'Embedding test',
        memory_type: 'context',
        scope: 'global',
        confidence: 0.8,
        priority: 5,
        source_type: 'manual',
        source_session: 'session-2',
        source_context: '{}',
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
      const memory = createMemory({
        id: 'mem-update',
        content: 'Original content',
        summary: 'Original summary',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.5,
        priority: 3,
        source_type: 'extraction',
        source_session: 'session-3',
        source_context: '{}',
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

    it('gets only active memories', () => {
      const active1 = createMemory({
        id: 'mem-active-1',
        content: 'Active memory 1',
        summary: 'Active 1',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-4',
        source_context: '{}',
        status: 'active',
      });

      const active2 = createMemory({
        id: 'mem-active-2',
        content: 'Active memory 2',
        summary: 'Active 2',
        memory_type: 'gotcha',
        scope: 'project',
        confidence: 0.8,
        priority: 6,
        source_type: 'extraction',
        source_session: 'session-4',
        source_context: '{}',
        status: 'active',
      });

      const superseded = createMemory({
        id: 'mem-superseded',
        content: 'Superseded memory',
        summary: 'Superseded',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.7,
        priority: 5,
        source_type: 'extraction',
        source_session: 'session-4',
        source_context: '{}',
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

  describe('searchByKeyword', () => {
    let db: ReturnType<typeof openDatabase>;

    beforeEach(() => {
      db = openDatabase(':memory:');

      // Insert test memories
      const mem1 = createMemory({
        id: 'mem-fts-1',
        content: 'Use functional programming patterns',
        summary: 'FP patterns',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-5',
        source_context: '{}',
        tags: ['fp', 'patterns'],
      });

      const mem2 = createMemory({
        id: 'mem-fts-2',
        content: 'Immutability is a core functional principle',
        summary: 'Immutability principle',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.95,
        priority: 9,
        source_type: 'extraction',
        source_session: 'session-5',
        source_context: '{}',
        tags: ['fp', 'immutability'],
      });

      const mem3 = createMemory({
        id: 'mem-fts-3',
        content: 'Database operations should be isolated at boundaries',
        summary: 'DB boundary isolation',
        memory_type: 'architecture',
        scope: 'project',
        confidence: 0.85,
        priority: 7,
        source_type: 'extraction',
        source_session: 'session-5',
        source_context: '{}',
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
      const mem1 = createMemory({
        id: 'mem-emb-1',
        content: 'Memory 1',
        summary: 'Summary 1',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-6',
        source_context: '{}',
        embedding: new Float64Array([1, 0, 0, 0]),
      });

      const mem2 = createMemory({
        id: 'mem-emb-2',
        content: 'Memory 2',
        summary: 'Summary 2',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.8,
        priority: 7,
        source_type: 'extraction',
        source_session: 'session-6',
        source_context: '{}',
        embedding: new Float64Array([0.9, 0.1, 0, 0]),
      });

      const mem3 = createMemory({
        id: 'mem-emb-3',
        content: 'Memory 3',
        summary: 'Summary 3',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.7,
        priority: 6,
        source_type: 'extraction',
        source_session: 'session-6',
        source_context: '{}',
        embedding: new Float64Array([0, 1, 0, 0]),
      });

      insertMemory(db, mem1);
      insertMemory(db, mem2);
      insertMemory(db, mem3);
    });

    it('excludes non-active memories from embedding candidates', () => {
      // Archival keeps the embedding — without a status filter, /forget-ed
      // memories would resurface in semantic recall.
      updateMemory(db, 'mem-emb-2', { status: 'archived' });

      const candidates = getMemoriesWithEmbedding(db, 'gemini');
      expect(candidates.map((c) => c.memory.id).sort()).toEqual(['mem-emb-1', 'mem-emb-3']);

      const byIds = getMemoriesWithEmbeddingByIds(
        db,
        ['mem-emb-1', 'mem-emb-2', 'mem-emb-3'],
        'gemini'
      );
      expect(byIds.map((c) => c.memory.id).sort()).toEqual(['mem-emb-1', 'mem-emb-3']);

      db.close();
    });

    it('fetches and ranks by gemini embedding similarity', () => {
      const queryEmbedding = new Float64Array([1, 0, 0, 0]);

      const candidates = getMemoriesWithEmbedding(db, 'gemini');
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

      const candidates = getMemoriesWithEmbedding(db, 'gemini');
      const results = rankBySimilarity(candidates, queryEmbedding, 2);
      expect(results).toHaveLength(2);
      expect(results[0].memory.id).toBe('mem-emb-1');
      expect(results[1].memory.id).toBe('mem-emb-2');

      db.close();
    });

    it('fetches and ranks by local embedding similarity', () => {
      const db2 = openDatabase(':memory:');

      const mem = createMemory({
        id: 'mem-local',
        content: 'Local embedding test',
        summary: 'Local test',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-7',
        source_context: '{}',
        local_embedding: new Float32Array([1, 0, 0]),
      });

      insertMemory(db2, mem);

      const queryEmbedding = new Float32Array([0.95, 0.05, 0]);
      const candidates = getMemoriesWithEmbedding(db2, 'local');
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
      const mem1 = createMemory({
        id: 'mem-edge-1',
        content: 'Source memory',
        summary: 'Source',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-8',
        source_context: '{}',
      });

      const mem2 = createMemory({
        id: 'mem-edge-2',
        content: 'Target memory',
        summary: 'Target',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.8,
        priority: 7,
        source_type: 'extraction',
        source_session: 'session-8',
        source_context: '{}',
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
      const mem1 = createMemory({
        id: 'mem-ckpt-1',
        content: 'Original memory',
        summary: 'Original',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-9',
        source_context: '{}',
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
      insertMemory(db, createMemory({
        id: 'mem-fts-keep',
        content: 'Memory about zebras and savannas',
        summary: 'Zebra memory',
        memory_type: 'context',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'extraction',
        source_session: 'session-fts',
        source_context: '{}',
      }));

      const checkpointPath = createCheckpoint(db);

      // Insert a SECOND memory after the checkpoint — its FTS row would
      // become an orphan on restore without explicit cleanup
      insertMemory(db, createMemory({
        id: 'mem-fts-orphan',
        content: 'Memory about quixotic wombats',
        summary: 'Wombat memory',
        memory_type: 'context',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'extraction',
        source_session: 'session-fts',
        source_context: '{}',
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

      // Legacy row readable, archived_at defaults to null
      const legacyMemory = getMemory(db, 'legacy-1');
      expect(legacyMemory).not.toBeNull();
      expect(legacyMemory!.archived_at).toBeNull();
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
      const memory = createMemory({
        id: 'arch-1',
        content: 'c', summary: 's', memory_type: 'context', scope: 'project',
        confidence: 0.8, priority: 5, source_type: 'manual',
        source_session: 'sess', source_context: '{}',
      });
      insertMemory(db, memory);

      expect(getMemory(db, 'arch-1')!.archived_at).toBeNull();

      updateMemory(db, 'arch-1', { status: 'archived', archived_at: now });
      const updated = getMemory(db, 'arch-1');
      expect(updated!.status).toBe('archived');
      expect(updated!.archived_at).toBe(now);
      db.close();
    });

    it('persists transcript_length on extraction checkpoints', () => {
      const db = openDatabase(':memory:');

      saveExtractionCheckpoint(db, {
        session_id: 'sess-tl',
        cursor_position: 42,
        extracted_at: new Date().toISOString(),
        transcript_length: 1000,
      });
      expect(getExtractionCheckpoint(db, 'sess-tl')!.transcript_length).toBe(1000);

      // Omitted → null (legacy callers)
      saveExtractionCheckpoint(db, {
        session_id: 'sess-legacy',
        cursor_position: 7,
        extracted_at: new Date().toISOString(),
      });
      expect(getExtractionCheckpoint(db, 'sess-legacy')!.transcript_length).toBeNull();
      db.close();
    });
  });

  describe('repointEdgesToMemory / repointFactSources', () => {
    const { repointEdgesToMemory, repointFactSources, upsertEntity, insertFact, getFactsByMemory } = require('./db.js');

    function seedMemory(db: ReturnType<typeof openDatabase>, id: string): void {
      insertMemory(db, createMemory({
        id, content: `content ${id}`, summary: `summary ${id}`,
        memory_type: 'context', scope: 'project', confidence: 0.8, priority: 5,
        source_type: 'manual', source_session: 'sess', source_context: '{}',
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
    insertMemory(db, createMemory({
      id: 'mem-schema-1',
      content: 'legacy content survives version stamping',
      summary: 'legacy',
      memory_type: 'context',
      scope: 'project',
      confidence: 0.8,
      priority: 5,
      source_type: 'extraction',
      source_session: 'sess-schema',
      source_context: '{}',
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
  return createMemory({
    id,
    content: `content ${id}`,
    summary: `summary ${id}`,
    memory_type: 'context',
    scope: 'project',
    confidence: 0.8,
    priority: 5,
    source_type: 'extraction',
    source_session: 'sess',
    source_context: '{}',
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
    return createMemory({
      id,
      content: 'readonly nixos content',
      summary: 'readonly nixos summary',
      memory_type: 'context',
      scope: 'project',
      confidence: 0.9,
      priority: 5,
      source_type: 'manual',
      source_session: 's1',
      source_context: '{}',
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
