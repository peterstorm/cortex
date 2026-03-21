// Decay Engine: Confidence decay and lifecycle transitions
// Pure functions for FR-083 through FR-091

import type { Memory, MemoryType } from './types.js';

// FR-083, FR-084: Type-based half-life map
// null = stable (no decay)
// Days until confidence halves
export const HALF_LIFE_DAYS: Record<MemoryType, number | null> = {
  architecture: null, // stable, no decay
  decision: null, // stable, no decay
  code_description: null, // stable, no decay
  code: null, // stable, no decay
  pattern: 60,
  gotcha: 45,
  context: 30,
  progress: 7,
};

// Helper: Compute days between two timestamps
function computeDaysBetween(from: string, to: Date): number {
  const fromDate = new Date(from);
  const diffMs = to.getTime() - fromDate.getTime();
  return Math.max(0, diffMs / (1000 * 60 * 60 * 24));
}

// FR-085, FR-086: Compute effective half-life with modifiers
// Graduated access boost: each access improves retention
// Proportional centrality boost
export function getHalfLife(
  memoryType: MemoryType,
  modifiers: { access_count: number; centrality: number }
): number | null {
  const baseHalfLife = HALF_LIFE_DAYS[memoryType];
  if (baseHalfLife === null) return null; // stable types never decay

  // Graduated access boost: each recall extends half-life
  // 0 accesses → 1x, 1 → 1.3x, 3 → 1.6x, 7 → 1.9x, 15 → 2.2x
  const accessMultiplier = 1 + Math.log2(1 + modifiers.access_count) * 0.3;

  // Proportional centrality boost: up to 2x for centrality 1.0
  const centralityMultiplier = 1 + modifiers.centrality;

  return baseHalfLife * accessMultiplier * centralityMultiplier;
}

// FR-087: Apply exponential decay formula
// confidence * (0.5 ^ (age_days / half_life))
// Internal helper function
function applyDecay(
  originalConfidence: number,
  ageDays: number,
  halfLife: number | null
): number {
  if (halfLife === null || halfLife === 0) {
    // Stable type or invalid half-life - no decay
    return originalConfidence;
  }

  const decayFactor = Math.pow(0.5, ageDays / halfLife);
  return originalConfidence * decayFactor;
}

// Lifecycle action discriminated union
export type LifecycleAction =
  | { action: 'none' }
  | { action: 'archive'; reason: string }
  | { action: 'prune'; reason: string }
  | { action: 'exempt'; reason: string };

// FR-088, FR-089, FR-090, FR-091: Determine lifecycle transition
// Archive if confidence < 0.3 for 14 consecutive days
// Exempt if centrality > 0.5 (hub protection)
// Prune if archived and untouched for 30 days
export function determineLifecycleAction(
  memory: Memory,
  decayedConfidence: number,
  daysBelowThreshold: number,
  centrality: number,
  now: Date
): LifecycleAction {
  const daysSinceAccess = computeDaysBetween(memory.last_accessed_at, now);

  // FR-090: Handle archived memories
  if (memory.status === 'archived') {
    // FR-091: Prune if archived and untouched for 30 days
    if (daysSinceAccess >= 30) {
      return { action: 'prune', reason: 'archived_30d_no_access' };
    }
    return { action: 'none' };
  }

  // Already pruned or superseded - keep state
  if (memory.status === 'pruned' || memory.status === 'superseded') {
    return { action: 'none' };
  }

  // FR-084: Pinned memories never decay
  if (memory.pinned) {
    return { action: 'exempt', reason: 'pinned' };
  }

  // FR-089: Hub protection - exempt if centrality > 0.5
  if (centrality > 0.5) {
    return { action: 'exempt', reason: 'high_centrality' };
  }

  // FR-088: Archive if confidence < 0.3 for 14 consecutive days
  const CONFIDENCE_THRESHOLD = 0.3;
  const DAYS_BELOW_TO_ARCHIVE = 14;

  if (
    decayedConfidence < CONFIDENCE_THRESHOLD &&
    daysBelowThreshold >= DAYS_BELOW_TO_ARCHIVE
  ) {
    return { action: 'archive', reason: 'low_confidence_14d' };
  }

  return { action: 'none' };
}

// Canonical export matching plan signature
// Computes effective (decayed) confidence for a memory.
// Uses last_accessed_at as anchor — accessing a memory resets the decay clock.
// Does NOT mutate stored confidence; caller uses result for lifecycle decisions only.
export function decayConfidence(
  memory: Memory,
  centrality: number,
  now: Date
): number {
  // FR-084: Pinned memories don't decay
  if (memory.pinned) {
    return memory.confidence;
  }

  const daysSinceAccess = computeDaysBetween(memory.last_accessed_at, now);
  const halfLife = getHalfLife(memory.memory_type, {
    access_count: memory.access_count,
    centrality,
  });

  return applyDecay(memory.confidence, daysSinceAccess, halfLife);
}
