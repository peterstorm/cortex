import { describe, it, expect, beforeEach } from 'vitest';
import {
  openDatabase,
  insertMemory,
  updateMemory,
  getMemory,
  getMemoriesWithEmbedding,
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
});
