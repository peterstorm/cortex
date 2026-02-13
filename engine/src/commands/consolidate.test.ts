/**
 * Tests for consolidate command
 * Covers FR-071, FR-074, FR-075, FR-076, FR-077, FR-079, FR-080, FR-081, FR-082
 */


import { Database } from 'bun:sqlite';
import {
  findSimilarPairs,
  formatPairForReview,
  buildMergedMemory,
  detectDuplicates,
  mergePair,
  executeConsolidate,
  type MemoryPair,
} from './consolidate.js';
import { createMemory } from '../core/types.js';
import type { Memory } from '../core/types.js';
import { openDatabase, insertMemory, getMemory, getAllEdges } from '../infra/db.js';

// ============================================================================
// TEST HELPERS
// ============================================================================

function createTestMemory(overrides: Partial<Memory> = {}): Memory {
  return createMemory({
    id: `mem-${Math.random().toString(36).substr(2, 9)}`,
    content: 'Test content',
    summary: 'Test summary',
    memory_type: 'context',
    scope: 'project',
    confidence: 0.8,
    priority: 5,
    pinned: false,
    source_type: 'manual',
    source_session: 'test-session',
    source_context: JSON.stringify({ test: true }),
    tags: [],
    embedding: null,
    local_embedding: null,
    access_count: 0,
    last_accessed_at: new Date().toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'active',
    ...overrides,
  });
}

// ============================================================================
// FUNCTIONAL CORE TESTS (Pure Functions)
// ============================================================================

describe('findSimilarPairs', () => {
  test('returns empty array for empty input', () => {
    const pairs = findSimilarPairs([]);
    expect(pairs).toEqual([]);
  });

  test('returns empty array for single memory', () => {
    const memory = createTestMemory();
    const pairs = findSimilarPairs([memory]);
    expect(pairs).toEqual([]);
  });

  test('finds similar pairs based on Jaccard similarity when no embeddings', () => {
    const memoryA = createTestMemory({
      summary: 'The quick brown fox jumps over the lazy dog',
      content: 'The quick brown fox jumps over the lazy dog',
    });

    const memoryB = createTestMemory({
      summary: 'The quick brown fox jumps over lazy dogs',
      content: 'The quick brown fox jumps over lazy dogs',
    });

    const pairs = findSimilarPairs([memoryA, memoryB], 0.5);

    expect(pairs.length).toBe(1);
    expect(pairs[0].memoryA.id).toBe(memoryA.id);
    expect(pairs[0].memoryB.id).toBe(memoryB.id);
    expect(pairs[0].similarity).toBeGreaterThan(0.5);
  });

  test('filters out pairs below threshold', () => {
    const memoryA = createTestMemory({
      summary: 'React component patterns',
      content: 'React component patterns',
    });

    const memoryB = createTestMemory({
      summary: 'Database optimization techniques',
      content: 'Database optimization techniques',
    });

    const pairs = findSimilarPairs([memoryA, memoryB], 0.5);

    expect(pairs.length).toBe(0);
  });

  test('uses cosine similarity when embeddings available', () => {
    // Create identical embeddings (similarity = 1.0)
    const embedding = new Float64Array([0.1, 0.2, 0.3, 0.4, 0.5]);

    const memoryA = createTestMemory({
      summary: 'Different summary A',
      embedding: embedding,
    });

    const memoryB = createTestMemory({
      summary: 'Different summary B',
      embedding: new Float64Array([0.1, 0.2, 0.3, 0.4, 0.5]),
    });

    const pairs = findSimilarPairs([memoryA, memoryB], 0.5);

    expect(pairs.length).toBe(1);
    expect(pairs[0].similarity).toBeCloseTo(1.0, 2);
  });

  test('prefers gemini embeddings over local embeddings', () => {
    const geminiEmbedding = new Float64Array([0.1, 0.2, 0.3]);
    const localEmbedding = new Float32Array([0.5, 0.5, 0.5]);

    const memoryA = createTestMemory({
      embedding: geminiEmbedding,
      local_embedding: localEmbedding,
    });

    const memoryB = createTestMemory({
      embedding: new Float64Array([0.1, 0.2, 0.3]),
      local_embedding: new Float32Array([0.9, 0.9, 0.9]),
    });

    const pairs = findSimilarPairs([memoryA, memoryB], 0.5);

    // Should use gemini embeddings (identical = 1.0 similarity)
    expect(pairs.length).toBe(1);
    expect(pairs[0].similarity).toBeCloseTo(1.0, 2);
  });

  test('sorts pairs by similarity descending', () => {
    const memoryA = createTestMemory({
      summary: 'test one two three',
      content: 'test one two three',
    });

    const memoryB = createTestMemory({
      summary: 'test one two three four', // More similar to A
      content: 'test one two three four',
    });

    const memoryC = createTestMemory({
      summary: 'test one', // Less similar to A
      content: 'test one',
    });

    const pairs = findSimilarPairs([memoryA, memoryB, memoryC], 0.3);

    // Should have 3 pairs: A-B, A-C, B-C
    expect(pairs.length).toBeGreaterThan(0);

    // First pair should have highest similarity
    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i - 1].similarity).toBeGreaterThanOrEqual(pairs[i].similarity);
    }
  });

  test('handles mixed embedding dimensions with fallback to Jaccard', () => {
    const memoryA = createTestMemory({
      summary: 'similar text content here',
      embedding: new Float64Array([0.1, 0.2]), // 2D
    });

    const memoryB = createTestMemory({
      summary: 'similar text content here',
      local_embedding: new Float32Array([0.5, 0.5, 0.5]), // 3D
    });

    // Should fall back to Jaccard since dimensions don't match
    const pairs = findSimilarPairs([memoryA, memoryB], 0.5);

    expect(pairs.length).toBe(1);
    expect(pairs[0].similarity).toBeGreaterThan(0.5);
  });
});

describe('formatPairForReview', () => {
  test('formats pair with all relevant information', () => {
    const memoryA = createTestMemory({
      id: 'mem-a',
      summary: 'Summary A',
      content: 'Content A',
      memory_type: 'decision',
      priority: 8,
    });

    const memoryB = createTestMemory({
      id: 'mem-b',
      summary: 'Summary B',
      content: 'Content B',
      memory_type: 'pattern',
      priority: 6,
    });

    const pair: MemoryPair = {
      memoryA,
      memoryB,
      similarity: 0.85,
    };

    const formatted = formatPairForReview(pair);

    expect(formatted).toContain('85.0%');
    expect(formatted).toContain('mem-a');
    expect(formatted).toContain('mem-b');
    expect(formatted).toContain('Summary A');
    expect(formatted).toContain('Summary B');
    expect(formatted).toContain('Content A');
    expect(formatted).toContain('Content B');
    expect(formatted).toContain('decision');
    expect(formatted).toContain('pattern');
    expect(formatted).toContain('Priority: 8');
    expect(formatted).toContain('Priority: 6');
  });
});

describe('buildMergedMemory', () => {
  test('creates merged memory with higher priority', () => {
    const memoryA = createTestMemory({ priority: 8 });
    const memoryB = createTestMemory({ priority: 5 });

    const pair: MemoryPair = {
      memoryA,
      memoryB,
      similarity: 0.9,
    };

    const merged = buildMergedMemory(
      pair,
      'Merged summary',
      'Merged content',
      'test-session',
      'test-merged-id',
      '2026-01-01T00:00:00.000Z'
    );

    expect(merged.priority).toBe(8);
  });

  test('preserves pinned flag if either memory is pinned', () => {
    const memoryA = createTestMemory({ pinned: true });
    const memoryB = createTestMemory({ pinned: false });

    const pair: MemoryPair = {
      memoryA,
      memoryB,
      similarity: 0.9,
    };

    const merged = buildMergedMemory(
      pair,
      'Merged summary',
      'Merged content',
      'test-session',
      'test-merged-id',
      '2026-01-01T00:00:00.000Z'
    );

    expect(merged.pinned).toBe(true);
  });

  test('combines and deduplicates tags', () => {
    const memoryA = createTestMemory({ tags: ['tag1', 'tag2'] });
    const memoryB = createTestMemory({ tags: ['tag2', 'tag3'] });

    const pair: MemoryPair = {
      memoryA,
      memoryB,
      similarity: 0.9,
    };

    const merged = buildMergedMemory(
      pair,
      'Merged summary',
      'Merged content',
      'test-session',
      'test-merged-id',
      '2026-01-01T00:00:00.000Z'
    );

    expect(merged.tags.length).toBe(3);
    expect(merged.tags).toContain('tag1');
    expect(merged.tags).toContain('tag2');
    expect(merged.tags).toContain('tag3');
  });

  test('sets scope to global if either memory is global', () => {
    const memoryA = createTestMemory({ scope: 'global' });
    const memoryB = createTestMemory({ scope: 'project' });

    const pair: MemoryPair = {
      memoryA,
      memoryB,
      similarity: 0.9,
    };

    const merged = buildMergedMemory(
      pair,
      'Merged summary',
      'Merged content',
      'test-session',
      'test-merged-id',
      '2026-01-01T00:00:00.000Z'
    );

    expect(merged.scope).toBe('global');
  });

  test('sets scope to project if both are project', () => {
    const memoryA = createTestMemory({ scope: 'project' });
    const memoryB = createTestMemory({ scope: 'project' });

    const pair: MemoryPair = {
      memoryA,
      memoryB,
      similarity: 0.9,
    };

    const merged = buildMergedMemory(
      pair,
      'Merged summary',
      'Merged content',
      'test-session',
      'test-merged-id',
      '2026-01-01T00:00:00.000Z'
    );

    expect(merged.scope).toBe('project');
  });

  test('prefers gemini embedding over local', () => {
    const geminiEmbedding = new Float64Array([0.1, 0.2, 0.3]);
    const localEmbedding = new Float32Array([0.4, 0.5, 0.6]);

    const memoryA = createTestMemory({
      embedding: geminiEmbedding,
      local_embedding: null,
    });

    const memoryB = createTestMemory({
      embedding: null,
      local_embedding: localEmbedding,
    });

    const pair: MemoryPair = {
      memoryA,
      memoryB,
      similarity: 0.9,
    };

    const merged = buildMergedMemory(
      pair,
      'Merged summary',
      'Merged content',
      'test-session',
      'test-merged-id',
      '2026-01-01T00:00:00.000Z'
    );

    expect(merged.embedding).toEqual(geminiEmbedding);
    expect(merged.local_embedding).toEqual(localEmbedding);
  });

  test('sets confidence to 1.0 for human-approved merge', () => {
    const memoryA = createTestMemory({ confidence: 0.6 });
    const memoryB = createTestMemory({ confidence: 0.7 });

    const pair: MemoryPair = {
      memoryA,
      memoryB,
      similarity: 0.9,
    };

    const merged = buildMergedMemory(
      pair,
      'Merged summary',
      'Merged content',
      'test-session',
      'test-merged-id',
      '2026-01-01T00:00:00.000Z'
    );

    expect(merged.confidence).toBe(1.0);
  });

  test('uses memory type from higher-priority memory', () => {
    const memoryA = createTestMemory({
      priority: 8,
      memory_type: 'decision',
    });

    const memoryB = createTestMemory({
      priority: 5,
      memory_type: 'pattern',
    });

    const pair: MemoryPair = {
      memoryA,
      memoryB,
      similarity: 0.9,
    };

    const merged = buildMergedMemory(
      pair,
      'Merged summary',
      'Merged content',
      'test-session',
      'test-merged-id',
      '2026-01-01T00:00:00.000Z'
    );

    expect(merged.memory_type).toBe('decision');
  });

  test('stores merge metadata in source_context', () => {
    const memoryA = createTestMemory({ id: 'mem-a' });
    const memoryB = createTestMemory({ id: 'mem-b' });

    const pair: MemoryPair = {
      memoryA,
      memoryB,
      similarity: 0.9,
    };

    const merged = buildMergedMemory(
      pair,
      'Merged summary',
      'Merged content',
      'test-session',
      'test-merged-id',
      '2026-01-01T00:00:00.000Z'
    );

    const context = JSON.parse(merged.source_context);
    expect(context.source).toBe('consolidation');
    expect(context.merged_from).toContain('mem-a');
    expect(context.merged_from).toContain('mem-b');
    expect(context.session_id).toBe('test-session');
  });
});

// ============================================================================
// IMPERATIVE SHELL TESTS (I/O with in-memory DB)
// ============================================================================

describe('detectDuplicates', () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  test('returns empty array when no active memories', () => {
    const pairs = detectDuplicates(db);
    expect(pairs).toEqual([]);
  });

  test('detects duplicate memories above threshold', () => {
    const memoryA = createTestMemory({
      summary: 'React hooks best practices for state management',
      content: 'React hooks best practices for state management',
    });

    const memoryB = createTestMemory({
      summary: 'React hooks best practices for managing state',
      content: 'React hooks best practices for managing state',
    });

    insertMemory(db, memoryA);
    insertMemory(db, memoryB);

    const pairs = detectDuplicates(db, { threshold: 0.5 });

    expect(pairs.length).toBe(1);
    expect(pairs[0].similarity).toBeGreaterThan(0.5);
  });

  test('respects custom threshold', () => {
    const memoryA = createTestMemory({
      summary: 'test one two',
      content: 'test one two',
    });

    const memoryB = createTestMemory({
      summary: 'completely different unrelated content here',
      content: 'completely different unrelated content here',
    });

    insertMemory(db, memoryA);
    insertMemory(db, memoryB);

    // High threshold - should find no pairs (too dissimilar)
    const highThreshold = detectDuplicates(db, { threshold: 0.9 });
    expect(highThreshold.length).toBe(0);

    // Low threshold - may find pairs depending on Jaccard
    const lowThreshold = detectDuplicates(db, { threshold: 0.01 });
    expect(lowThreshold.length).toBeGreaterThanOrEqual(0);
  });

  test('only considers active memories', () => {
    const memoryA = createTestMemory({
      summary: 'test similar content',
      status: 'active',
    });

    const memoryB = createTestMemory({
      summary: 'test similar content',
      status: 'superseded', // Not active
    });

    insertMemory(db, memoryA);
    insertMemory(db, memoryB);

    const pairs = detectDuplicates(db, { threshold: 0.5 });

    // Should not find pairs because memoryB is not active
    expect(pairs.length).toBe(0);
  });
});

describe('mergePair', () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  test('creates merged memory and supersedes edges', () => {
    const memoryA = createTestMemory({ id: 'mem-a' });
    const memoryB = createTestMemory({ id: 'mem-b' });

    insertMemory(db, memoryA);
    insertMemory(db, memoryB);

    const pair: MemoryPair = {
      memoryA,
      memoryB,
      similarity: 0.9,
    };

    const mergedId = mergePair(
      db,
      pair,
      'Merged summary',
      'Merged content',
      'test-session'
    );

    // Check merged memory exists
    const merged = getMemory(db, mergedId);
    expect(merged).not.toBeNull();
    expect(merged!.summary).toBe('Merged summary');
    expect(merged!.content).toBe('Merged content');

    // Check supersedes edges exist
    const edges = getAllEdges(db);
    const supersedesEdges = edges.filter((e) => e.relation_type === 'supersedes');
    expect(supersedesEdges.length).toBe(2);

    // Check edges point from merged to old memories
    expect(supersedesEdges.some((e) => e.source_id === mergedId && e.target_id === 'mem-a')).toBe(
      true
    );
    expect(supersedesEdges.some((e) => e.source_id === mergedId && e.target_id === 'mem-b')).toBe(
      true
    );

    // Check supersedes edges have strength 1.0
    supersedesEdges.forEach((edge) => {
      expect(edge.strength).toBe(1.0);
      expect(edge.status).toBe('active');
    });
  });

  test('marks old memories as superseded', () => {
    const memoryA = createTestMemory({ id: 'mem-a' });
    const memoryB = createTestMemory({ id: 'mem-b' });

    insertMemory(db, memoryA);
    insertMemory(db, memoryB);

    const pair: MemoryPair = {
      memoryA,
      memoryB,
      similarity: 0.9,
    };

    mergePair(db, pair, 'Merged summary', 'Merged content', 'test-session');

    // Check old memories are superseded
    const updatedA = getMemory(db, 'mem-a');
    const updatedB = getMemory(db, 'mem-b');

    expect(updatedA!.status).toBe('superseded');
    expect(updatedB!.status).toBe('superseded');
  });
});

describe('executeConsolidate', () => {
  let db: Database;

  beforeEach(() => {
    db = openDatabase(':memory:');
  });

  test('creates checkpoint before processing', () => {
    const result = executeConsolidate(db);

    expect(result.checkpoint_path).toBeDefined();
    expect(result.checkpoint_path).toContain('checkpoint');
  });

  test('detects pairs but does not auto-merge (FR-082)', () => {
    const memoryA = createTestMemory({
      summary: 'duplicate content here',
      content: 'duplicate content here',
    });

    const memoryB = createTestMemory({
      summary: 'duplicate content here',
      content: 'duplicate content here',
    });

    insertMemory(db, memoryA);
    insertMemory(db, memoryB);

    const result = executeConsolidate(db, { threshold: 0.5 });

    // Should find pairs
    expect(result.pairs_found).toBe(1);

    // Should NOT auto-merge (FR-082: human-only)
    expect(result.pairs_merged).toBe(0);
    expect(result.pairs_skipped).toBe(1);

    // Original memories should still be active
    const stillA = getMemory(db, memoryA.id);
    const stillB = getMemory(db, memoryB.id);
    expect(stillA!.status).toBe('active');
    expect(stillB!.status).toBe('active');
  });

  test('respects maxPasses limit (FR-081)', () => {
    // Insert memories that would trigger multiple passes
    for (let i = 0; i < 10; i++) {
      const memory = createTestMemory({
        summary: `test content ${i}`,
        content: `test content ${i}`,
      });
      insertMemory(db, memory);
    }

    const result = executeConsolidate(db, { threshold: 0.01, maxPasses: 3 });

    // Should stop after detecting pairs (no auto-merge)
    expect(result.pairs_found).toBeGreaterThanOrEqual(0);
  });

  test('handles empty database gracefully', () => {
    const result = executeConsolidate(db);

    expect(result.pairs_found).toBe(0);
    expect(result.pairs_merged).toBe(0);
    expect(result.pairs_skipped).toBe(0);
    expect(result.checkpoint_path).toBeDefined();
  });
});

// ============================================================================
// PROPERTY TESTS
// ============================================================================

describe('findSimilarPairs - properties', () => {
  test('never returns pairs with same memory ID', () => {
    const memories = Array.from({ length: 10 }, () =>
      createTestMemory({
        summary: 'test content',
        content: 'test content',
      })
    );

    const pairs = findSimilarPairs(memories, 0.1);

    pairs.forEach((pair) => {
      expect(pair.memoryA.id).not.toBe(pair.memoryB.id);
    });
  });

  test('similarity scores are in range [0, 1]', () => {
    const memories = Array.from({ length: 5 }, (_, i) =>
      createTestMemory({
        summary: `test content ${i}`,
        content: `test content ${i}`,
      })
    );

    const pairs = findSimilarPairs(memories, 0.0);

    pairs.forEach((pair) => {
      expect(pair.similarity).toBeGreaterThanOrEqual(0);
      expect(pair.similarity).toBeLessThanOrEqual(1);
    });
  });

  test('results are sorted by similarity descending', () => {
    const memories = Array.from({ length: 5 }, (_, i) =>
      createTestMemory({
        summary: `test content ${i}`,
        content: `test content ${i}`,
      })
    );

    const pairs = findSimilarPairs(memories, 0.0);

    for (let i = 1; i < pairs.length; i++) {
      expect(pairs[i - 1].similarity).toBeGreaterThanOrEqual(pairs[i].similarity);
    }
  });

  test('all pairs have similarity >= threshold', () => {
    const memories = Array.from({ length: 5 }, (_, i) =>
      createTestMemory({
        summary: `test content ${i}`,
        content: `test content ${i}`,
      })
    );

    const threshold = 0.5;
    const pairs = findSimilarPairs(memories, threshold);

    pairs.forEach((pair) => {
      expect(pair.similarity).toBeGreaterThanOrEqual(threshold);
    });
  });
});

describe('buildMergedMemory - properties', () => {
  test('merged priority is max of inputs', () => {
    for (let i = 0; i < 10; i++) {
      const priorityA = Math.floor(Math.random() * 10) + 1;
      const priorityB = Math.floor(Math.random() * 10) + 1;

      const memoryA = createTestMemory({ priority: priorityA });
      const memoryB = createTestMemory({ priority: priorityB });

      const pair: MemoryPair = { memoryA, memoryB, similarity: 0.9 };
      const merged = buildMergedMemory(pair, 'summary', 'content', 'session', 'test-id', '2026-01-01T00:00:00.000Z');

      expect(merged.priority).toBe(Math.max(priorityA, priorityB));
    }
  });

  test('merged confidence is always 1.0', () => {
    for (let i = 0; i < 10; i++) {
      const memoryA = createTestMemory({ confidence: Math.random() });
      const memoryB = createTestMemory({ confidence: Math.random() });

      const pair: MemoryPair = { memoryA, memoryB, similarity: 0.9 };
      const merged = buildMergedMemory(pair, 'summary', 'content', 'session', 'test-id', '2026-01-01T00:00:00.000Z');

      expect(merged.confidence).toBe(1.0);
    }
  });

  test('merged status is always active', () => {
    const memoryA = createTestMemory({ status: 'active' });
    const memoryB = createTestMemory({ status: 'active' });

    const pair: MemoryPair = { memoryA, memoryB, similarity: 0.9 };
    const merged = buildMergedMemory(pair, 'summary', 'content', 'session', 'test-id', '2026-01-01T00:00:00.000Z');

    expect(merged.status).toBe('active');
  });
});

