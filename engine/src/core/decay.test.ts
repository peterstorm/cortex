// Tests for decay engine
// Property-based tests verify invariants, example tests verify specific rules

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  HALF_LIFE_DAYS,
  getHalfLife,
  decayConfidence,
  determineLifecycleAction,
  type LifecycleAction,
} from './decay.js';
import type { Memory, MemoryType, MemoryStatus } from './types.js';

// Test helpers
function createMemory(overrides: Partial<Memory> = {}): Memory {
  const now = new Date('2026-02-08T12:00:00Z');
  return {
    id: 'mem-1',
    content: 'test content',
    summary: 'test summary',
    memory_type: 'pattern',
    scope: 'project',
    embedding: null,
    local_embedding: null,
    confidence: 0.8,
    priority: 5,
    pinned: false,
    source_type: 'extraction',
    source_session: 'session-1',
    source_context: '{}',
    tags: [],
    access_count: 0,
    last_accessed_at: now.toISOString(),
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
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

const decayingMemoryTypeArb = fc.constantFrom<MemoryType>(
  'pattern',
  'gotcha',
  'context',
  'progress'
);

const stableMemoryTypeArb = fc.constantFrom<MemoryType>(
  'architecture',
  'decision',
  'code_description',
  'code'
);

const confidenceArb = fc.double({ min: 0, max: 1, noNaN: true });
const ageDaysArb = fc.nat({ max: 365 });
const centralityArb = fc.double({ min: 0, max: 1, noNaN: true });
const accessCountArb = fc.nat({ max: 100 });

describe('decay engine', () => {
  describe('HALF_LIFE_DAYS constant', () => {
    it('defines stable types as null', () => {
      expect(HALF_LIFE_DAYS.architecture).toBeNull();
      expect(HALF_LIFE_DAYS.decision).toBeNull();
      expect(HALF_LIFE_DAYS.code_description).toBeNull();
      expect(HALF_LIFE_DAYS.code).toBeNull();
    });

    it('defines correct half-lives for decaying types', () => {
      expect(HALF_LIFE_DAYS.pattern).toBe(60);
      expect(HALF_LIFE_DAYS.gotcha).toBe(45);
      expect(HALF_LIFE_DAYS.context).toBe(30);
      expect(HALF_LIFE_DAYS.progress).toBe(7);
    });
  });

  describe('getHalfLife', () => {
    it('returns null for stable types regardless of modifiers', () => {
      const modifiers = { access_count: 50, centrality: 0.9 };
      expect(getHalfLife('architecture', modifiers)).toBeNull();
      expect(getHalfLife('decision', modifiers)).toBeNull();
      expect(getHalfLife('code_description', modifiers)).toBeNull();
      expect(getHalfLife('code', modifiers)).toBeNull();
    });

    it('returns base half-life with no modifiers', () => {
      const modifiers = { access_count: 0, centrality: 0 };
      expect(getHalfLife('pattern', modifiers)).toBe(60);
      expect(getHalfLife('gotcha', modifiers)).toBe(45);
      expect(getHalfLife('context', modifiers)).toBe(30);
      expect(getHalfLife('progress', modifiers)).toBe(7);
    });

    it('graduated access boost increases half-life', () => {
      // 7 accesses: 1 + log2(8) * 0.3 = 1 + 0.9 = 1.9x
      const modifiers = { access_count: 7, centrality: 0 };
      expect(getHalfLife('progress', modifiers)).toBeCloseTo(7 * 1.9, 1);
      expect(getHalfLife('pattern', modifiers)).toBeCloseTo(60 * 1.9, 0);
    });

    it('even 1 access provides some protection', () => {
      // 1 access: 1 + log2(2) * 0.3 = 1 + 0.3 = 1.3x
      const modifiers = { access_count: 1, centrality: 0 };
      expect(getHalfLife('progress', modifiers)).toBeCloseTo(7 * 1.3, 1);
    });

    it('centrality proportionally boosts half-life', () => {
      // centrality 0.8: 1 + 0.8 = 1.8x
      const modifiers = { access_count: 0, centrality: 0.8 };
      expect(getHalfLife('progress', modifiers)).toBeCloseTo(7 * 1.8, 1);
      expect(getHalfLife('pattern', modifiers)).toBeCloseTo(60 * 1.8, 0);
    });

    it('access and centrality multiply together', () => {
      // 15 accesses: 1 + log2(16) * 0.3 = 1 + 1.2 = 2.2x
      // centrality 0.8: 1 + 0.8 = 1.8x
      // combined: 2.2 * 1.8 = 3.96x
      const modifiers = { access_count: 15, centrality: 0.8 };
      expect(getHalfLife('progress', modifiers)).toBeCloseTo(7 * 3.96, 0);
      expect(getHalfLife('pattern', modifiers)).toBeCloseTo(60 * 3.96, 0);
    });

    // Property test: stable types always return null
    it('property: stable types always return null', () => {
      fc.assert(
        fc.property(
          stableMemoryTypeArb,
          accessCountArb,
          centralityArb,
          (type, access, cent) => {
            const result = getHalfLife(type, {
              access_count: access,
              centrality: cent,
            });
            return result === null;
          }
        )
      );
    });

    // Property test: decaying types always return positive number
    it('property: decaying types return positive half-life', () => {
      fc.assert(
        fc.property(
          decayingMemoryTypeArb,
          accessCountArb,
          centralityArb,
          (type, access, cent) => {
            const result = getHalfLife(type, {
              access_count: access,
              centrality: cent,
            });
            return result !== null && result > 0;
          }
        )
      );
    });

    // Property test: more accesses = longer half-life
    it('property: higher access count gives longer or equal half-life', () => {
      fc.assert(
        fc.property(
          decayingMemoryTypeArb,
          accessCountArb,
          centralityArb,
          (type, access, cent) => {
            const low = getHalfLife(type, { access_count: access, centrality: cent })!;
            const high = getHalfLife(type, { access_count: access + 1, centrality: cent })!;
            return high >= low;
          }
        )
      );
    });
  });

  describe('decayConfidence', () => {
    it('returns original confidence for pinned memories', () => {
      const memory = createMemory({
        pinned: true,
        memory_type: 'progress',
        confidence: 0.8,
        last_accessed_at: new Date('2026-01-01T00:00:00Z').toISOString(),
      });
      const now = new Date('2026-02-08T00:00:00Z'); // 38 days later
      const decayed = decayConfidence(memory, 0.2, now);
      expect(decayed).toBe(0.8);
    });

    it('returns original confidence for stable types', () => {
      const memory = createMemory({
        memory_type: 'architecture',
        confidence: 0.9,
        last_accessed_at: new Date('2025-01-01T00:00:00Z').toISOString(),
      });
      const now = new Date('2026-02-08T00:00:00Z'); // 404 days later
      const decayed = decayConfidence(memory, 0.1, now);
      expect(decayed).toBe(0.9);
    });

    it('decays progress memory based on days since last access', () => {
      const lastAccessed = new Date('2026-02-01T00:00:00Z');
      const memory = createMemory({
        memory_type: 'progress',
        confidence: 1.0,
        access_count: 0,
        last_accessed_at: lastAccessed.toISOString(),
      });
      const now = new Date('2026-02-08T00:00:00Z'); // 7 days since access
      const decayed = decayConfidence(memory, 0, now);
      expect(decayed).toBeCloseTo(0.5); // One half-life (7 days)
    });

    it('accessing a memory resets the decay clock', () => {
      const now = new Date('2026-02-08T00:00:00Z');

      // Memory created 30 days ago but accessed 1 day ago
      const memory = createMemory({
        memory_type: 'progress',
        confidence: 1.0,
        access_count: 3,
        created_at: new Date('2026-01-09T00:00:00Z').toISOString(),
        last_accessed_at: new Date('2026-02-07T00:00:00Z').toISOString(), // 1 day ago
      });

      const decayed = decayConfidence(memory, 0, now);
      // Only 1 day of decay, not 30: 1.0 * 0.5^(1/halfLife)
      // halfLife = 7 * (1 + log2(4)*0.3) = 7 * 1.6 = 11.2
      // 0.5^(1/11.2) ≈ 0.94
      expect(decayed).toBeGreaterThan(0.9);
    });

    it('decays slower with higher access count', () => {
      const lastAccessed = new Date('2026-02-01T00:00:00Z');
      const now = new Date('2026-02-08T00:00:00Z'); // 7 days

      const lowAccess = createMemory({
        memory_type: 'progress',
        confidence: 1.0,
        access_count: 0,
        last_accessed_at: lastAccessed.toISOString(),
      });

      const highAccess = createMemory({
        memory_type: 'progress',
        confidence: 1.0,
        access_count: 7,
        last_accessed_at: lastAccessed.toISOString(),
      });

      const lowDecayed = decayConfidence(lowAccess, 0, now);
      const highDecayed = decayConfidence(highAccess, 0, now);

      expect(highDecayed).toBeGreaterThan(lowDecayed);
    });

    it('decays slower with higher centrality', () => {
      const lastAccessed = new Date('2026-02-01T00:00:00Z');
      const now = new Date('2026-02-08T00:00:00Z');

      const lowCent = createMemory({
        memory_type: 'progress',
        confidence: 1.0,
        access_count: 0,
        last_accessed_at: lastAccessed.toISOString(),
      });

      const lowDecayed = decayConfidence(lowCent, 0, now);
      const highDecayed = decayConfidence(lowCent, 0.8, now);

      expect(highDecayed).toBeGreaterThan(lowDecayed);
    });

    // Property test: pinned memories never decay
    it('property: pinned memories have stable confidence', () => {
      fc.assert(
        fc.property(
          memoryTypeArb,
          confidenceArb,
          ageDaysArb,
          centralityArb,
          (type, conf, age, cent) => {
            const lastAccessed = new Date();
            lastAccessed.setDate(lastAccessed.getDate() - age);

            const memory = createMemory({
              memory_type: type,
              confidence: conf,
              pinned: true,
              last_accessed_at: lastAccessed.toISOString(),
            });

            const decayed = decayConfidence(memory, cent, new Date());
            return Math.abs(decayed - conf) < 0.000001;
          }
        )
      );
    });

    // Property test: recently accessed memories barely decay
    it('property: memories accessed within 1 hour retain >99% confidence', () => {
      fc.assert(
        fc.property(
          decayingMemoryTypeArb,
          fc.double({ min: 0.1, max: 1, noNaN: true }),
          centralityArb,
          accessCountArb,
          (type, conf, cent, access) => {
            const now = new Date();
            const recentAccess = new Date(now.getTime() - 3600_000); // 1 hour ago

            const memory = createMemory({
              memory_type: type,
              confidence: conf,
              access_count: access,
              last_accessed_at: recentAccess.toISOString(),
            });

            const decayed = decayConfidence(memory, cent, now);
            return decayed >= conf * 0.99;
          }
        )
      );
    });
  });

  describe('determineLifecycleAction', () => {
    const now = new Date('2026-02-08T12:00:00Z');

    it('keeps active memories with good confidence', () => {
      const memory = createMemory({ status: 'active', confidence: 0.8 });
      const action = determineLifecycleAction(memory, 0.8, 0, 0.2, now);
      expect(action).toEqual({ action: 'none' });
    });

    it('keeps memories with low confidence if not below threshold long enough', () => {
      const memory = createMemory({ status: 'active' });
      const action = determineLifecycleAction(memory, 0.2, 10, 0.2, now);
      expect(action).toEqual({ action: 'none' });
    });

    it('archives memories with confidence < 0.3 for 14+ days', () => {
      const memory = createMemory({ status: 'active' });
      const action = determineLifecycleAction(memory, 0.25, 14, 0.2, now);
      expect(action).toEqual({
        action: 'archive',
        reason: 'low_confidence_14d',
      });
    });

    it('exempts pinned memories from archival', () => {
      const memory = createMemory({ status: 'active', pinned: true });
      const action = determineLifecycleAction(memory, 0.1, 30, 0.1, now);
      expect(action).toEqual({ action: 'exempt', reason: 'pinned' });
    });

    it('exempts high-centrality memories (hub protection)', () => {
      const memory = createMemory({ status: 'active' });
      const action = determineLifecycleAction(memory, 0.1, 30, 0.6, now);
      expect(action).toEqual({ action: 'exempt', reason: 'high_centrality' });
    });

    it('keeps archived memories if accessed within 30 days', () => {
      const recentAccess = new Date(now);
      recentAccess.setDate(recentAccess.getDate() - 10);

      const memory = createMemory({
        status: 'archived',
        last_accessed_at: recentAccess.toISOString(),
      });
      const action = determineLifecycleAction(memory, 0.1, 30, 0.2, now);
      expect(action).toEqual({ action: 'none' });
    });

    it('prunes archived memories untouched for 30+ days', () => {
      const oldAccess = new Date(now);
      oldAccess.setDate(oldAccess.getDate() - 35);

      const memory = createMemory({
        status: 'archived',
        last_accessed_at: oldAccess.toISOString(),
      });
      const action = determineLifecycleAction(memory, 0.1, 30, 0.2, now);
      expect(action).toEqual({ action: 'prune', reason: 'archived_30d_no_access' });
    });

    it('keeps pruned memories (terminal state)', () => {
      const memory = createMemory({ status: 'pruned' });
      const action = determineLifecycleAction(memory, 0.1, 30, 0.2, now);
      expect(action).toEqual({ action: 'none' });
    });

    it('keeps superseded memories (terminal state)', () => {
      const memory = createMemory({ status: 'superseded' });
      const action = determineLifecycleAction(memory, 0.1, 30, 0.2, now);
      expect(action).toEqual({ action: 'none' });
    });

    // Property test: pinned memories always exempt or keep
    it('property: pinned memories never archived or pruned', () => {
      fc.assert(
        fc.property(
          confidenceArb,
          fc.nat({ max: 100 }),
          centralityArb,
          (conf, days, cent) => {
            const memory = createMemory({ pinned: true, status: 'active' });
            const action = determineLifecycleAction(
              memory,
              conf,
              days,
              cent,
              now
            );
            return action.action === 'exempt' || action.action === 'none';
          }
        )
      );
    });

    // Property test: high centrality protects from archival
    it('property: centrality > 0.5 prevents archival', () => {
      fc.assert(
        fc.property(
          confidenceArb,
          fc.nat({ max: 100 }),
          fc.double({ min: 0.51, max: 1.0, noNaN: true }),
          (conf, days, cent) => {
            const memory = createMemory({ status: 'active', pinned: false });
            const action = determineLifecycleAction(
              memory,
              conf,
              days,
              cent,
              now
            );
            return action.action !== 'archive';
          }
        )
      );
    });

    // Property test: archived memories either kept or pruned (no other transitions)
    it('property: archived memories only kept or pruned', () => {
      fc.assert(
        fc.property(
          confidenceArb,
          fc.nat({ max: 100 }),
          centralityArb,
          fc.nat({ max: 60 }),
          (conf, days, cent, daysNoAccess) => {
            const lastAccess = new Date(now);
            lastAccess.setDate(lastAccess.getDate() - daysNoAccess);

            const memory = createMemory({
              status: 'archived',
              last_accessed_at: lastAccess.toISOString(),
            });
            const action = determineLifecycleAction(
              memory,
              conf,
              days,
              cent,
              now
            );
            return action.action === 'none' || action.action === 'prune';
          }
        )
      );
    });
  });

  describe('integration: full decay pipeline', () => {
    it('progress memory decays and archives over time', () => {
      const now = new Date('2026-02-08T12:00:00Z');

      // Create progress memory last accessed 30 days ago
      const lastAccessed = new Date(now);
      lastAccessed.setDate(lastAccessed.getDate() - 30);

      const memory = createMemory({
        memory_type: 'progress',
        confidence: 0.8,
        access_count: 0,
        created_at: lastAccessed.toISOString(),
        last_accessed_at: lastAccessed.toISOString(),
      });

      // After 30 days with 7-day half-life: 0.8 * 0.5^(30/7) ≈ 0.052
      const decayed = decayConfidence(memory, 0.1, now);
      expect(decayed).toBeLessThan(0.3);

      // Should be archived if below threshold for 14 days
      const action = determineLifecycleAction(memory, decayed, 14, 0.1, now);
      expect(action).toEqual({ action: 'archive', reason: 'low_confidence_14d' });
    });

    it('recently accessed memory avoids archival', () => {
      const now = new Date('2026-02-08T12:00:00Z');

      // Created 60 days ago but accessed 2 days ago
      const created = new Date(now);
      created.setDate(created.getDate() - 60);
      const lastAccessed = new Date(now);
      lastAccessed.setDate(lastAccessed.getDate() - 2);

      const memory = createMemory({
        memory_type: 'progress',
        confidence: 0.8,
        access_count: 3,
        created_at: created.toISOString(),
        last_accessed_at: lastAccessed.toISOString(),
      });

      // Only 2 days since access, not 60
      const decayed = decayConfidence(memory, 0.1, now);
      expect(decayed).toBeGreaterThan(0.5); // barely decayed
    });

    it('hub memory (high centrality) protected from archival', () => {
      const now = new Date('2026-02-08T12:00:00Z');

      const lastAccessed = new Date(now);
      lastAccessed.setDate(lastAccessed.getDate() - 60);

      const memory = createMemory({
        memory_type: 'context',
        confidence: 0.8,
        access_count: 0,
        created_at: lastAccessed.toISOString(),
        last_accessed_at: lastAccessed.toISOString(),
      });

      const decayed = decayConfidence(memory, 0.7, now);

      // Protected from archival by centrality
      const action = determineLifecycleAction(memory, decayed, 20, 0.7, now);
      expect(action).toEqual({ action: 'exempt', reason: 'high_centrality' });
    });
  });
});
