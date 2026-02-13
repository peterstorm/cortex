// Tests for surface generator

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  generateSurface,
  wrapInMarkers,
  estimateTokens,
  allocateBudget,
  CATEGORY_BUDGETS,
  type SurfaceOptions,
  type StalenessInfo,
  type RankedMemory,
} from './surface.js';
import type { Memory, MemoryType } from './types.js';

// Test fixtures
const createMemory = (overrides: Partial<RankedMemory> = {}): RankedMemory => ({
  id: overrides.id ?? 'mem-1',
  content: overrides.content ?? 'Test content',
  summary: overrides.summary ?? 'Test summary',
  memory_type: overrides.memory_type ?? 'decision',
  scope: overrides.scope ?? 'project',
  embedding: null,
  local_embedding: null,
  confidence: overrides.confidence ?? 0.8,
  priority: overrides.priority ?? 5,
  pinned: overrides.pinned ?? false,
  source_type: overrides.source_type ?? 'extraction',
  source_session: overrides.source_session ?? 'session-1',
  source_context: overrides.source_context ?? '{}',
  tags: overrides.tags ?? [],
  access_count: overrides.access_count ?? 0,
  last_accessed_at: overrides.last_accessed_at ?? '2024-01-01T00:00:00Z',
  created_at: overrides.created_at ?? '2024-01-01T00:00:00Z',
  updated_at: overrides.updated_at ?? '2024-01-01T00:00:00Z',
  status: overrides.status ?? 'active',
  rank: overrides.rank ?? 0.5,
});

describe('estimateTokens', () => {
  it('estimates tokens using ~4 chars per token', () => {
    expect(estimateTokens('test')).toBe(1); // 4 chars = 1 token
    expect(estimateTokens('test test')).toBe(3); // 9 chars = 2.25 -> 3 tokens
    expect(estimateTokens('a'.repeat(400))).toBe(100); // 400 chars = 100 tokens
  });

  it('handles empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  // Property test: token estimate is always non-negative and grows with text length
  it('property: token estimate is non-negative and monotonic', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        const tokensA = estimateTokens(a);
        const tokensB = estimateTokens(b);

        // Non-negative
        expect(tokensA).toBeGreaterThanOrEqual(0);
        expect(tokensB).toBeGreaterThanOrEqual(0);

        // Monotonic: longer text = more tokens
        if (a.length > b.length) {
          expect(tokensA).toBeGreaterThanOrEqual(tokensB);
        }
      })
    );
  });
});

describe('wrapInMarkers', () => {
  it('wraps content in CORTEX_MEMORY markers', () => {
    const content = 'Test content';
    const wrapped = wrapInMarkers(content);

    expect(wrapped).toContain('<!-- CORTEX_MEMORY_START -->');
    expect(wrapped).toContain('<!-- CORTEX_MEMORY_END -->');
    expect(wrapped).toContain(content);
  });

  it('handles empty string', () => {
    expect(wrapInMarkers('')).toBe('');
    expect(wrapInMarkers('   ')).toBe('');
  });

  it('preserves whitespace in content', () => {
    const content = '  line1\n  line2  ';
    const wrapped = wrapInMarkers(content);
    expect(wrapped).toContain(content);
  });
});

describe('allocateBudget', () => {
  it('allocates memories within category LINE budgets', () => {
    const memories = [
      createMemory({ id: '1', memory_type: 'architecture', summary: 'Single line', rank: 0.9 }),
      createMemory({ id: '2', memory_type: 'architecture', summary: 'Another line', rank: 0.8 }),
      createMemory({ id: '3', memory_type: 'decision', summary: 'Decision line', rank: 0.7 }),
    ];

    const budgets: Record<MemoryType, number> = {
      architecture: 1, // 1 line budget
      decision: 1, // 1 line budget
      pattern: 0,
      gotcha: 0,
      context: 0,
      progress: 0,
      code_description: 0,
      code: 0,
    };

    const allocated = allocateBudget(memories, budgets, false);

    // Should take top 1 architecture (1 line) and top 1 decision (1 line)
    expect(allocated).toHaveLength(2);
    expect(allocated.find(m => m.id === '1')).toBeDefined(); // top architecture
    expect(allocated.find(m => m.id === '3')).toBeDefined(); // top decision
  });

  it('allows overflow when enabled', () => {
    const memories = [
      createMemory({ id: '1', memory_type: 'architecture', summary: 'Line 1', rank: 0.9 }),
      createMemory({ id: '2', memory_type: 'architecture', summary: 'Line 2', rank: 0.8 }),
      createMemory({ id: '3', memory_type: 'architecture', summary: 'Line 3', rank: 0.7 }),
    ];

    const budgets: Record<MemoryType, number> = {
      architecture: 1, // 1 line budget
      decision: 5, // 5 line unused budget
      pattern: 0,
      gotcha: 0,
      context: 0,
      progress: 0,
      code_description: 0,
      code: 0,
    };

    const allocated = allocateBudget(memories, budgets, true);

    // Should take 1 within budget + up to 2 more from unused decision budget (each is 1 line)
    expect(allocated.length).toBeGreaterThan(1);
    expect(allocated.length).toBeLessThanOrEqual(3); // all 3 can fit in 1 + 5 unused lines
  });

  it('redistributes unused LINE budget to high-value overflow', () => {
    const memories = [
      createMemory({ id: '1', memory_type: 'architecture', summary: 'Arch 1', rank: 0.9 }),
      createMemory({ id: '2', memory_type: 'architecture', summary: 'Arch 2', rank: 0.8 }),
      createMemory({ id: '3', memory_type: 'architecture', summary: 'Arch 3', rank: 0.7 }),
      createMemory({ id: '4', memory_type: 'decision', summary: 'Dec 1', rank: 0.6 }),
    ];

    const budgets: Record<MemoryType, number> = {
      architecture: 2, // 2 line budget
      decision: 5, // 5 line budget, but only 1 decision (4 unused lines)
      pattern: 0,
      gotcha: 0,
      context: 0,
      progress: 0,
      code_description: 0,
      code: 0,
    };

    const allocated = allocateBudget(memories, budgets, true);

    // Should take 2 architecture (2 lines), 1 decision (1 line), + 1 overflow (id=3, 1 line from 4 unused)
    expect(allocated).toHaveLength(4);
    expect(allocated.find(m => m.id === '3')).toBeDefined(); // overflow redistributed
  });

  it('skips categories with zero budget', () => {
    const memories = [
      createMemory({ id: '1', memory_type: 'code', summary: 'Code mem', rank: 0.9 }),
      createMemory({ id: '2', memory_type: 'decision', summary: 'Decision mem', rank: 0.8 }),
    ];

    const allocated = allocateBudget(memories, CATEGORY_BUDGETS, false);

    // Code has budget 0, should be excluded
    expect(allocated.find(m => m.id === '1')).toBeUndefined();
    expect(allocated.find(m => m.id === '2')).toBeDefined();
  });

  it('respects LINE budgets for multi-line summaries', () => {
    const memories = [
      createMemory({
        id: '1',
        memory_type: 'architecture',
        summary: 'Line 1\nLine 2\nLine 3', // 3 lines
        rank: 0.9
      }),
      createMemory({
        id: '2',
        memory_type: 'architecture',
        summary: 'Single line', // 1 line
        rank: 0.8
      }),
      createMemory({
        id: '3',
        memory_type: 'architecture',
        summary: 'Another\nTwo lines', // 2 lines
        rank: 0.7
      }),
    ];

    const budgets: Record<MemoryType, number> = {
      architecture: 4, // 4 line budget
      decision: 0,
      pattern: 0,
      gotcha: 0,
      context: 0,
      progress: 0,
      code_description: 0,
      code: 0,
    };

    const allocated = allocateBudget(memories, budgets, false);

    // Should take id=1 (3 lines) + id=2 (1 line) = 4 lines total
    // id=3 would exceed budget (4 + 2 = 6 > 4)
    expect(allocated).toHaveLength(2);
    expect(allocated.find(m => m.id === '1')).toBeDefined();
    expect(allocated.find(m => m.id === '2')).toBeDefined();
    expect(allocated.find(m => m.id === '3')).toBeUndefined();
  });

  it('redistributes unused LINE budget with multi-line summaries', () => {
    const memories = [
      createMemory({
        id: '1',
        memory_type: 'architecture',
        summary: 'Line 1\nLine 2', // 2 lines
        rank: 0.9
      }),
      createMemory({
        id: '2',
        memory_type: 'architecture',
        summary: 'Line 3\nLine 4\nLine 5', // 3 lines (overflow)
        rank: 0.85
      }),
      createMemory({
        id: '3',
        memory_type: 'architecture',
        summary: 'Line 6', // 1 line (overflow)
        rank: 0.8
      }),
    ];

    const budgets: Record<MemoryType, number> = {
      architecture: 2, // 2 line budget - only id=1 fits
      decision: 5, // 5 unused lines
      pattern: 0,
      gotcha: 0,
      context: 0,
      progress: 0,
      code_description: 0,
      code: 0,
    };

    const allocated = allocateBudget(memories, budgets, true);

    // Should allocate id=1 (2 lines within budget)
    // Overflow: id=2 (3 lines, rank 0.85) and id=3 (1 line, rank 0.8)
    // Redistribute from 5 unused lines: id=2 (3 lines) + id=3 (1 line) = 4 lines used
    expect(allocated).toHaveLength(3);
    expect(allocated.find(m => m.id === '1')).toBeDefined();
    expect(allocated.find(m => m.id === '2')).toBeDefined(); // higher rank overflow
    expect(allocated.find(m => m.id === '3')).toBeDefined(); // lower rank overflow (still fits)
  });

  // Property test: allocated count never exceeds total budget
  it('property: allocated count respects total budget without overflow', () => {
    const memoryArb = fc.record({
      id: fc.uuid(),
      memory_type: fc.constantFrom<MemoryType>(
        'architecture',
        'decision',
        'pattern',
        'gotcha',
        'progress',
        'context',
        'code_description'
      ),
      rank: fc.double({ min: 0, max: 1 }),
    });

    fc.assert(
      fc.property(fc.array(memoryArb, { minLength: 0, maxLength: 50 }), (memData) => {
        const memories = memData.map(d => createMemory(d));
        const allocated = allocateBudget(memories, CATEGORY_BUDGETS, false);

        const totalBudget = Object.values(CATEGORY_BUDGETS).reduce((a, b) => a + b, 0);
        expect(allocated.length).toBeLessThanOrEqual(totalBudget);
      })
    );
  });

  // Property test: with overflow, high-rank memories are prioritized
  it('property: overflow prioritizes high-rank memories', () => {
    const memories = [
      createMemory({ id: '1', memory_type: 'architecture', summary: 'High', rank: 0.9 }),
      createMemory({ id: '2', memory_type: 'architecture', summary: 'Low', rank: 0.5 }),
      createMemory({ id: '3', memory_type: 'architecture', summary: 'Med', rank: 0.8 }),
    ];

    const budgets: Record<MemoryType, number> = {
      architecture: 1, // 1 line budget
      decision: 2, // 2 lines unused
      pattern: 0,
      gotcha: 0,
      context: 0,
      progress: 0,
      code_description: 0,
      code: 0,
    };

    const allocated = allocateBudget(memories, budgets, true);

    // First should be in budget (rank 0.9)
    expect(allocated.find(m => m.id === '1')).toBeDefined();

    // If overflow taken, should prefer rank 0.8 over 0.5
    if (allocated.length > 1) {
      const overflowMem = allocated.find(m => m.id === '3' || m.id === '2');
      if (allocated.length === 3) {
        // Both taken (2 unused lines available)
        expect(allocated.find(m => m.id === '3')).toBeDefined();
      } else if (overflowMem) {
        // Only one overflow, should be higher rank
        expect(overflowMem.id).toBe('3'); // rank 0.8
      }
    }
  });
});

describe('generateSurface', () => {
  it('generates empty string for no memories', () => {
    const surface = generateSurface([], 'main', null);
    expect(surface).toBe('');
  });

  it('generates surface with header and branch', () => {
    const memories = [
      createMemory({ id: '1', summary: 'Test decision', memory_type: 'decision' }),
    ];

    const surface = generateSurface(memories, 'main', null);

    expect(surface).toContain('# Cortex Memory Surface');
    expect(surface).toContain('**Branch:** main');
    expect(surface).toContain('## Decision');
    expect(surface).toContain('Test decision');
  });

  it('includes staleness warning when surface is stale', () => {
    const memories = [
      createMemory({ id: '1', summary: 'Test', memory_type: 'decision' }),
    ];

    const staleness: StalenessInfo = { stale: true, age_hours: 48 };
    const surface = generateSurface(memories, 'main', staleness);

    expect(surface).toContain('**Warning:** Surface is 48h old. May be stale.');
  });

  it('groups memories by category', () => {
    const memories = [
      createMemory({ id: '1', summary: 'Arch decision', memory_type: 'architecture' }),
      createMemory({ id: '2', summary: 'Pattern found', memory_type: 'pattern' }),
      createMemory({ id: '3', summary: 'Another arch', memory_type: 'architecture' }),
    ];

    const surface = generateSurface(memories, 'main', null);

    expect(surface).toContain('## Architecture');
    expect(surface).toContain('Arch decision');
    expect(surface).toContain('Another arch');
    expect(surface).toContain('## Pattern');
    expect(surface).toContain('Pattern found');
  });

  it('includes tags when present', () => {
    const memories = [
      createMemory({
        id: '1',
        summary: 'Test',
        memory_type: 'decision',
        tags: ['important', 'frontend'],
      }),
    ];

    const surface = generateSurface(memories, 'main', null);

    expect(surface).toContain('*Tags: important, frontend*');
  });

  it('respects category budgets via allocateBudget', () => {
    // Create 30 architecture memories (budget is 25 lines)
    const memories = Array.from({ length: 30 }, (_, i) =>
      createMemory({
        id: `arch-${i}`,
        summary: `Architecture ${i}`,
        memory_type: 'architecture',
        rank: 1 - i / 100, // descending rank
      })
    );

    // Budget enforcement lives in allocateBudget, not generateSurface
    const allocated = allocateBudget(memories, CATEGORY_BUDGETS, false);

    expect(allocated.length).toBeLessThanOrEqual(25); // respects budget
  });

  it('truncates when token limit exceeded with no overflow', () => {
    const memories = Array.from({ length: 50 }, (_, i) =>
      createMemory({
        id: `mem-${i}`,
        summary: 'A'.repeat(100), // long summaries
        memory_type: 'progress',
      })
    );

    const surface = generateSurface(memories, 'main', null, {
      maxTokens: 200,
      allowOverflow: false,
    });

    const tokens = estimateTokens(surface);
    expect(tokens).toBeLessThanOrEqual(220); // within 10% overflow
  });

  // Property test: generated surface always has markers-compatible structure
  it('property: surface is valid markdown with sections', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            summary: fc.string({ minLength: 1, maxLength: 100 }),
            memory_type: fc.constantFrom<MemoryType>(
              'architecture',
              'decision',
              'pattern',
              'gotcha'
            ),
            rank: fc.double({ min: 0, max: 1 }),
          }),
          { minLength: 1, maxLength: 20 }
        ),
        (memData) => {
          const memories = memData.map(d => createMemory(d));
          const surface = generateSurface(memories, 'test-branch', null);

          // Should contain header
          expect(surface).toContain('# Cortex Memory Surface');
          expect(surface).toContain('**Branch:** test-branch');

          // Should have at least one section
          expect(surface).toMatch(/## [A-Z]/);
        }
      )
    );
  });

  // Property test: token estimate within reasonable bounds
  it('property: surface stays within token budget +10%', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.uuid(),
            summary: fc.string({ minLength: 10, maxLength: 50 }),
            memory_type: fc.constantFrom<MemoryType>(
              'architecture',
              'decision',
              'pattern',
              'gotcha',
              'progress'
            ),
            rank: fc.double({ min: 0, max: 1 }),
          }),
          { minLength: 5, maxLength: 30 }
        ),
        fc.integer({ min: 500, max: 2500 }),
        (memData, maxTokens) => {
          const memories = memData.map(d => createMemory(d));
          const surface = generateSurface(memories, 'main', null, { maxTokens });

          const tokens = estimateTokens(surface);
          // Allow 10% overflow
          expect(tokens).toBeLessThanOrEqual(maxTokens * 1.1);
        }
      ),
      { numRuns: 50 } // reduce runs for performance
    );
  });
});

describe('integration: full surface generation flow', () => {
  it('generates complete surface with multiple categories', () => {
    const memories = [
      createMemory({
        id: '1',
        summary: 'Use functional core pattern for testability',
        memory_type: 'architecture',
        tags: ['fp', 'testing'],
        rank: 0.95,
      }),
      createMemory({
        id: '2',
        summary: 'Decided to use SQLite with WAL mode',
        memory_type: 'decision',
        tags: ['database'],
        rank: 0.9,
      }),
      createMemory({
        id: '3',
        summary: 'Pattern: allocate budget with overflow redistribution',
        memory_type: 'pattern',
        rank: 0.85,
      }),
      createMemory({
        id: '4',
        summary: 'Gotcha: better-sqlite3 requires native compilation',
        memory_type: 'gotcha',
        tags: ['deployment'],
        rank: 0.8,
      }),
      createMemory({
        id: '5',
        summary: 'Implemented surface generator with tests',
        memory_type: 'progress',
        rank: 0.75,
      }),
    ];

    const surface = generateSurface(memories, 'feature/cortex', null);

    // Verify structure
    expect(surface).toContain('# Cortex Memory Surface');
    expect(surface).toContain('**Branch:** feature/cortex');
    expect(surface).toContain('## Architecture');
    expect(surface).toContain('## Decision');
    expect(surface).toContain('## Pattern');
    expect(surface).toContain('## Gotcha');
    expect(surface).toContain('## Progress');

    // Verify content
    expect(surface).toContain('Use functional core pattern for testability');
    expect(surface).toContain('*Tags: fp, testing*');
    expect(surface).toContain('Decided to use SQLite with WAL mode');

    // Verify wrapping works
    const wrapped = wrapInMarkers(surface);
    expect(wrapped).toContain('<!-- CORTEX_MEMORY_START -->');
    expect(wrapped).toContain('<!-- CORTEX_MEMORY_END -->');

    // Verify token estimate
    const tokens = estimateTokens(surface);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(2500); // reasonable size
  });

  it('handles edge case: all memories from one category', () => {
    const memories = Array.from({ length: 10 }, (_, i) =>
      createMemory({
        id: `decision-${i}`,
        summary: `Decision ${i}`,
        memory_type: 'decision',
        rank: 1 - i / 20,
      })
    );

    const surface = generateSurface(memories, 'main', null);

    expect(surface).toContain('## Decision');
    expect(surface.split('## ').length).toBe(2); // Only header + Decision section

    const wrapped = wrapInMarkers(surface);
    expect(wrapped).toContain('<!-- CORTEX_MEMORY_START -->');
  });
});
