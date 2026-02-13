import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { computeRank, selectForSurface, mergeResults } from './ranking.js';
import type { Memory, MemoryType, SearchResult } from './types.js';

// Helper: create complete Memory with all required fields
function createTestMemory(overrides: Partial<Memory> = {}): Memory {
  const now = new Date().toISOString();
  return {
    id: 'test-id',
    content: 'test content',
    summary: 'test summary',
    memory_type: 'decision',
    scope: 'project',
    embedding: null,
    local_embedding: null,
    confidence: 0.8,
    priority: 5,
    pinned: false,
    source_type: 'extraction',
    source_session: 'session-1',
    source_context: JSON.stringify({ branch: 'main', commits: [], files: [] }),
    tags: [],
    access_count: 0,
    last_accessed_at: now,
    created_at: now,
    updated_at: now,
    status: 'active',
    ...overrides,
  };
}

// Arbitraries for property tests
const memoryTypeArb = fc.constantFrom<MemoryType>(
  'architecture',
  'decision',
  'pattern',
  'gotcha',
  'context',
  'progress',
  'code_description',
  'code'
);

const memoryArb = fc.record({
  id: fc.uuid(),
  content: fc.lorem({ maxCount: 50 }),
  summary: fc.lorem({ maxCount: 20 }),
  memory_type: memoryTypeArb,
  confidence: fc.double({ min: 0, max: 1, noNaN: true }),
  priority: fc.integer({ min: 1, max: 10 }),
  source_context: fc.string().map(s => JSON.stringify({ branch: s, commits: [], files: [] })),
  access_count: fc.nat({ max: 1000 }),
}).map(partial => createTestMemory(partial));

const searchResultArb = (sourceType: 'project' | 'global') =>
  fc.record({
    memory: memoryArb,
    score: fc.double({ min: 0, max: 1, noNaN: true }),
    source: fc.constant(sourceType)
  });

// Example-based tests
describe('computeRank', () => {
  it('computes rank for basic memory', () => {
    const memory = createTestMemory({
      id: '1',
      confidence: 0.8,
      priority: 5,
      access_count: 10,
    });

    // Add centrality property (not part of Memory type, computed at runtime)
    const memoryWithCentrality = { ...memory, centrality: 0.5 };

    const rank = computeRank(memoryWithCentrality, { maxAccessLog: Math.log(11) });

    // Expected: (0.8 * 0.5) + (0.5 * 0.2) + (0.5 * 0.15) + (log(11)/log(11) * 0.15)
    // = 0.4 + 0.1 + 0.075 + 0.15 = 0.725
    expect(rank).toBeCloseTo(0.725, 2);
  });

  it('applies branch boost when branch matches', () => {
    const memory = createTestMemory({
      id: '1',
      confidence: 0.8,
      priority: 5,
      source_context: JSON.stringify({ branch: 'feature/x', commits: [], files: [] }),
      access_count: 0,
    });

    const withoutBoost = computeRank(memory, {
      maxAccessLog: 1,
      currentBranch: 'main'
    });

    const withBoost = computeRank(memory, {
      maxAccessLog: 1,
      currentBranch: 'feature/x'
    });

    expect(withBoost).toBeGreaterThan(withoutBoost);
    expect(withBoost - withoutBoost).toBeCloseTo(0.1, 2);
  });

  it('handles invalid source_context gracefully', () => {
    const memory = createTestMemory({
      id: '1',
      confidence: 0.5,
      priority: 5,
      source_context: 'invalid json',
      access_count: 0,
    });

    expect(() =>
      computeRank(memory, { maxAccessLog: 1, currentBranch: 'main' })
    ).not.toThrow();
  });

  it('handles zero maxAccessLog', () => {
    const memory = createTestMemory({
      id: '1',
      confidence: 0.5,
      priority: 5,
      source_context: '{}',
      access_count: 100,
    });

    const rank = computeRank(memory, { maxAccessLog: 0 });
    expect(rank).toBeGreaterThanOrEqual(0);
    expect(rank).toBeLessThanOrEqual(1);
  });
});

describe('computeRank recency decay', () => {
  it('reduces rank for older memories', () => {
    const now = new Date('2024-06-15T00:00:00Z');
    const recent = createTestMemory({
      id: '1',
      confidence: 0.8,
      priority: 5,
      access_count: 0,
      created_at: '2024-06-15T00:00:00Z',
    });
    const old = createTestMemory({
      id: '2',
      confidence: 0.8,
      priority: 5,
      access_count: 0,
      created_at: '2024-05-16T00:00:00Z',
    });

    const recentRank = computeRank(recent, { maxAccessLog: 1, now });
    const oldRank = computeRank(old, { maxAccessLog: 1, now });

    expect(recentRank).toBeGreaterThan(oldRank);
  });

  it('applies correct decay at half-life boundary', () => {
    const now = new Date('2024-06-15T00:00:00Z');
    const atHalfLife = createTestMemory({
      id: '1',
      confidence: 0.8,
      priority: 5,
      access_count: 0,
      created_at: '2024-06-01T00:00:00Z',
    });
    const fresh = createTestMemory({
      id: '2',
      confidence: 0.8,
      priority: 5,
      access_count: 0,
      created_at: '2024-06-15T00:00:00Z',
    });

    const halfLifeRank = computeRank(atHalfLife, { maxAccessLog: 1, now });
    const freshRank = computeRank(fresh, { maxAccessLog: 1, now });

    expect(halfLifeRank).toBeCloseTo(freshRank * 0.5, 1);
  });

  it('exempts pinned memories from recency decay', () => {
    const now = new Date('2024-06-15T00:00:00Z');
    const pinned = createTestMemory({
      id: '1',
      confidence: 0.8,
      priority: 5,
      access_count: 0,
      pinned: true,
      created_at: '2024-01-01T00:00:00Z',
    });
    const unpinned = createTestMemory({
      id: '2',
      confidence: 0.8,
      priority: 5,
      access_count: 0,
      pinned: false,
      created_at: '2024-01-01T00:00:00Z',
    });

    const pinnedRank = computeRank(pinned, { maxAccessLog: 1, now });
    const unpinnedRank = computeRank(unpinned, { maxAccessLog: 1, now });

    expect(pinnedRank).toBeGreaterThan(unpinnedRank);
  });

  it('allows custom half-life', () => {
    const now = new Date('2024-06-15T00:00:00Z');
    const memory = createTestMemory({
      id: '1',
      confidence: 0.8,
      priority: 5,
      access_count: 0,
      created_at: '2024-06-08T00:00:00Z',
    });

    const rank7 = computeRank(memory, { maxAccessLog: 1, now, recencyHalfLifeDays: 7 });
    const rank14 = computeRank(memory, { maxAccessLog: 1, now, recencyHalfLifeDays: 14 });

    expect(rank7).toBeLessThan(rank14);
  });
});

// Property-based tests
describe('computeRank properties', () => {
  it('always returns non-negative rank', () => {
    fc.assert(
      fc.property(memoryArb, fc.double({ min: 0.1, max: 10, noNaN: true }), (memory, maxLog) => {
        const rank = computeRank(memory, { maxAccessLog: maxLog });
        expect(rank).toBeGreaterThanOrEqual(0);
      })
    );
  });

  it('always returns rank bounded in [0, 1]', () => {
    fc.assert(
      fc.property(memoryArb, fc.double({ min: 0.1, max: 10, noNaN: true }), (memory, maxLog) => {
        const rank = computeRank(memory, { maxAccessLog: maxLog });
        expect(rank).toBeLessThanOrEqual(1);
      })
    );
  });

  it('higher priority yields higher or equal rank (monotonic)', () => {
    fc.assert(
      fc.property(
        memoryArb,
        fc.integer({ min: 1, max: 10 }),
        fc.integer({ min: 1, max: 10 }),
        (baseMemory, priority1, priority2) => {
          fc.pre(priority1 !== priority2);
          const now = new Date();

          const mem1 = createTestMemory({ ...baseMemory, priority: priority1 });
          const mem2 = createTestMemory({ ...baseMemory, priority: priority2 });

          const rank1 = computeRank(mem1, { maxAccessLog: 1, now });
          const rank2 = computeRank(mem2, { maxAccessLog: 1, now });

          if (priority1 > priority2) {
            expect(rank1).toBeGreaterThanOrEqual(rank2);
          } else {
            expect(rank2).toBeGreaterThanOrEqual(rank1);
          }
        }
      )
    );
  });

  it('branch boost increases rank', () => {
    fc.assert(
      fc.property(memoryArb, fc.string(), (baseMemory, branch) => {
        const now = new Date();
        const memory = createTestMemory({
          ...baseMemory,
          source_context: JSON.stringify({ branch, commits: [], files: [] })
        });

        const withoutBoost = computeRank(memory, { maxAccessLog: 1, now });
        const withBoost = computeRank(memory, { maxAccessLog: 1, currentBranch: branch, now });

        expect(withBoost).toBeGreaterThanOrEqual(withoutBoost);
      })
    );
  });

  it('higher confidence yields higher or equal rank', () => {
    fc.assert(
      fc.property(
        memoryArb,
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (baseMemory, conf1, conf2) => {
          fc.pre(Math.abs(conf1 - conf2) > 0.1);
          const now = new Date();

          const mem1 = createTestMemory({ ...baseMemory, confidence: conf1 });
          const mem2 = createTestMemory({ ...baseMemory, confidence: conf2 });

          const rank1 = computeRank(mem1, { maxAccessLog: 1, now });
          const rank2 = computeRank(mem2, { maxAccessLog: 1, now });

          // Confidence contributes 0.5 weight to rank
          // With diff > 0.1, we expect rank diff > 0.05
          if (conf1 > conf2) {
            expect(rank1).toBeGreaterThan(rank2 - 0.001);
          } else {
            expect(rank2).toBeGreaterThan(rank1 - 0.001);
          }
        }
      )
    );
  });
});

describe('selectForSurface', () => {
  it('excludes code type memories', () => {
    const memories: Memory[] = [
      createTestMemory({
        id: '1',
        memory_type: 'code',
        confidence: 1.0,
        priority: 10,
        access_count: 100,
      }),
      createTestMemory({
        id: '2',
        memory_type: 'decision',
        confidence: 0.8,
        priority: 5,
        access_count: 10,
      }),
    ];

    const selected = selectForSurface(memories, { currentBranch: 'main' });

    expect(selected).toHaveLength(1);
    expect(selected[0].memory_type).toBe('decision');
  });

  it('respects category budgets (soft limit)', () => {
    // Create enough memories that we would exceed maxTokens before selecting all
    const longSummary = 'word '.repeat(100); // ~75 tokens per memory
    const memories: Memory[] = Array.from({ length: 50 }, (_, i) =>
      createTestMemory({
        id: `${i}`,
        summary: longSummary,
        memory_type: 'decision',
        confidence: 0.8,
        priority: 8,
        access_count: i,
      })
    );

    const selected = selectForSurface(memories, { currentBranch: 'main', maxTokens: 500 });

    // With maxTokens=500 and ~75 tokens per memory, should select around 6-7 memories
    expect(selected.length).toBeLessThan(50);
    expect(selected.length).toBeGreaterThan(0);
  });

  it('selects highest ranked memories first', () => {
    const memories: Memory[] = [
      createTestMemory({
        id: '1',
        summary: 'low priority',
        confidence: 0.3,
        priority: 1,
        access_count: 0,
      }),
      createTestMemory({
        id: '2',
        summary: 'high priority',
        confidence: 0.9,
        priority: 10,
        access_count: 100,
      }),
    ];

    const selected = selectForSurface(memories, { currentBranch: 'main' });

    expect(selected[0].id).toBe('2');
  });

  it('stops at max tokens', () => {
    const memories: Memory[] = Array.from({ length: 100 }, (_, i) =>
      createTestMemory({
        id: `${i}`,
        summary: 'a '.repeat(100),  // ~75 tokens each
        memory_type: 'decision',
        confidence: 0.8,
        priority: 8,
        access_count: i,
      })
    );

    const selected = selectForSurface(memories, {
      currentBranch: 'main',
      maxTokens: 200
    });

    // Use same formula as estimateTokens: chars / 4
    const totalTokens = selected.reduce((sum, m) => sum + Math.ceil(m.summary.length / 4), 0);

    expect(totalTokens).toBeLessThanOrEqual(220); // Allow 10% overflow
  });
});

describe('selectForSurface properties', () => {
  it('never returns code type memories', () => {
    fc.assert(
      fc.property(fc.array(memoryArb, { minLength: 1, maxLength: 50 }), fc.string(), (memories, branch) => {
        const selected = selectForSurface(memories, { currentBranch: branch });
        expect(selected.every(m => m.memory_type !== 'code')).toBe(true);
      })
    );
  });

  it('returns memories in descending rank order', () => {
    fc.assert(
      fc.property(fc.array(memoryArb, { minLength: 2, maxLength: 20 }), fc.string(), (memories, branch) => {
        const now = new Date();
        const selected = selectForSurface(memories, { currentBranch: branch, now });

        if (selected.length < 2) return;

        // Match selectForSurface: compute maxAccessLog from non-code candidates only
        const candidates = memories.filter(m => m.memory_type !== 'code');
        const maxAccessLog = Math.max(
          ...candidates.map(m => Math.log(m.access_count + 1)),
          1
        );

        const ranks = selected.map(m =>
          computeRank(m, { maxAccessLog, currentBranch: branch, now })
        );

        for (let i = 0; i < ranks.length - 1; i++) {
          expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i + 1] - 0.0001); // Allow small floating point errors
        }
      })
    );
  });
});

describe('mergeResults', () => {
  it('deduplicates by memory ID', () => {
    const sharedMemory = createTestMemory({ id: 'shared' });

    const projectResults: SearchResult[] = [
      { memory: sharedMemory, score: 0.9, source: 'project', related: [] }
    ];

    const globalResults: SearchResult[] = [
      { memory: sharedMemory, score: 0.7, source: 'global', related: [] }
    ];

    const merged = mergeResults(projectResults, globalResults, 10);

    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('project');
  });

  it('prefers project results over global when duplicate', () => {
    const memory = createTestMemory({ id: 'dup' });

    const projectResults: SearchResult[] = [
      { memory, score: 0.5, source: 'project', related: [] }
    ];

    const globalResults: SearchResult[] = [
      { memory, score: 0.9, source: 'global', related: [] }
    ];

    const merged = mergeResults(projectResults, globalResults, 10);

    expect(merged).toHaveLength(1);
    expect(merged[0].source).toBe('project');
  });

  it('sorts by score descending', () => {
    const mem1 = createTestMemory({ id: '1' });
    const mem2 = createTestMemory({ id: '2' });

    const projectResults: SearchResult[] = [
      { memory: mem1, score: 0.5, source: 'project', related: [] }
    ];

    const globalResults: SearchResult[] = [
      { memory: mem2, score: 0.9, source: 'global', related: [] }
    ];

    const merged = mergeResults(projectResults, globalResults, 10);

    expect(merged[0].memory.id).toBe('2');
    expect(merged[1].memory.id).toBe('1');
  });

  it('respects limit', () => {
    const projectResults: SearchResult[] = Array.from({ length: 10 }, (_, i) => ({
      memory: createTestMemory({ id: `p${i}` }),
      score: 0.5 + i * 0.01,
      source: 'project' as const,
      related: [],
    }));

    const globalResults: SearchResult[] = [];

    const merged = mergeResults(projectResults, globalResults, 5);

    expect(merged).toHaveLength(5);
  });
});

describe('mergeResults properties', () => {
  it('never returns more than limit', () => {
    fc.assert(
      fc.property(
        fc.array(searchResultArb('project'), { maxLength: 20 }),
        fc.array(searchResultArb('global'), { maxLength: 20 }),
        fc.integer({ min: 1, max: 30 }),
        (projectResults, globalResults, limit) => {
          const merged = mergeResults(projectResults, globalResults, limit);
          expect(merged.length).toBeLessThanOrEqual(limit);
        }
      )
    );
  });

  it('returns results sorted by score descending', () => {
    fc.assert(
      fc.property(
        fc.array(searchResultArb('project'), { minLength: 1, maxLength: 10 }),
        fc.array(searchResultArb('global'), { minLength: 1, maxLength: 10 }),
        (projectResults, globalResults) => {
          const merged = mergeResults(projectResults, globalResults, 50);

          for (let i = 0; i < merged.length - 1; i++) {
            expect(merged[i].score).toBeGreaterThanOrEqual(merged[i + 1].score);
          }
        }
      )
    );
  });

  it('contains no duplicate memory IDs', () => {
    fc.assert(
      fc.property(
        fc.array(searchResultArb('project'), { maxLength: 20 }),
        fc.array(searchResultArb('global'), { maxLength: 20 }),
        (projectResults, globalResults) => {
          const merged = mergeResults(projectResults, globalResults, 50);
          const ids = merged.map(r => r.memory.id);
          const uniqueIds = new Set(ids);
          expect(uniqueIds.size).toBe(ids.length);
        }
      )
    );
  });
});
