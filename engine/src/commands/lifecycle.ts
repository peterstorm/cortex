/**
 * Lifecycle command: Apply decay, archive, and prune logic to all active memories
 * FR-092, FR-083, FR-088, FR-091
 *
 * Imperative shell - orchestrates I/O and pure core functions
 */

import type { Database } from 'bun:sqlite';
import type { Memory } from '../core/types.js';
import { getActiveMemories, getArchivedMemories, getAllEdges, updateMemory } from '../infra/db.js';
import { computeAllCentrality } from '../core/graph.js';
import { decayConfidence, determineLifecycleAction } from '../core/decay.js';

export interface LifecycleResult {
  readonly decayed: number;
  readonly archived: number;
  readonly pruned: number;
}

/**
 * Apply lifecycle operations to all active memories
 *
 * This is the imperative shell that:
 * 1. Fetches all active memories and edges from DB
 * 2. Computes centrality for all memories (pure)
 * 3. For each memory: applies decay and determines lifecycle action (pure)
 * 4. Applies actions to DB (I/O)
 *
 * Note: "daysBelowThreshold" tracking - we approximate by checking if current
 * decayed confidence is <0.3 and memory hasn't been accessed in 14 days.
 * The spec says "14 consecutive days" but tracking daily state is complex;
 * we use last_accessed_at as proxy.
 */
export function runLifecycle(db: Database): LifecycleResult {
  const now = new Date();

  // I/O: Fetch all active memories
  const activeMemories = getActiveMemories(db);

  // I/O: Fetch all edges for centrality calculation
  const allEdges = getAllEdges(db);

  // Pure: Compute centrality for all memories
  const centralityMap = computeAllCentrality(allEdges);

  let decayedCount = 0;
  let archivedCount = 0;
  let prunedCount = 0;

  // Process each active memory
  for (const memory of activeMemories) {
    const centrality = centralityMap.get(memory.id) ?? 0;

    // Pure: Compute decayed confidence
    const newConfidence = decayConfidence(memory, centrality, now);

    // Track if confidence changed (decayed)
    const confidenceChanged = Math.abs(newConfidence - memory.confidence) > 0.001;
    if (confidenceChanged) {
      decayedCount++;
    }

    // Pure: Approximate daysBelowThreshold
    // If confidence < 0.3 and last_accessed_at >= 14 days ago
    const daysSinceAccess = computeDaysSince(memory.last_accessed_at, now);
    const daysBelowThreshold = newConfidence < 0.3 && daysSinceAccess >= 14 ? daysSinceAccess : 0;

    // Pure: Determine lifecycle action
    const action = determineLifecycleAction(memory, newConfidence, daysBelowThreshold, centrality, now);

    // I/O: Apply action
    if (action.action === 'archive') {
      updateMemory(db, memory.id, {
        confidence: newConfidence,
        status: 'archived',
      });
      archivedCount++;
    } else if (action.action === 'prune') {
      updateMemory(db, memory.id, {
        confidence: newConfidence,
        status: 'pruned',
      });
      prunedCount++;
    } else if (action.action === 'exempt') {
      // Exempt memories don't decay, but update timestamp
      updateMemory(db, memory.id, {
        confidence: memory.confidence, // keep original
      });
    } else {
      // No action or just confidence update
      if (confidenceChanged) {
        updateMemory(db, memory.id, {
          confidence: newConfidence,
        });
      }
    }
  }

  // Also process archived memories for pruning
  // Note: A memory can be archived AND pruned in the same runLifecycle call.
  // This is intentional - the prune loop re-reads archived memories after the
  // archive loop writes, so a very old memory (e.g., 100 days unaccessed with
  // confidence < 0.3) will be archived in the first loop, then pruned in this
  // second loop if it also meets the 30-day archived threshold.
  // I/O: Fetch archived memories
  const archivedMemories = getArchivedMemories(db);
  for (const memory of archivedMemories) {
    const centrality = centralityMap.get(memory.id) ?? 0;
    const newConfidence = decayConfidence(memory, centrality, now);

    // determineLifecycleAction handles archived -> pruned transition
    const action = determineLifecycleAction(memory, newConfidence, 0, centrality, now);

    if (action.action === 'prune') {
      updateMemory(db, memory.id, {
        status: 'pruned',
      });
      prunedCount++;
    }
  }

  return {
    decayed: decayedCount,
    archived: archivedCount,
    pruned: prunedCount,
  };
}

/**
 * Helper: Compute days since timestamp
 * Pure function
 */
function computeDaysSince(timestamp: string, now: Date): number {
  const past = new Date(timestamp);
  const diffMs = now.getTime() - past.getTime();
  return Math.max(0, diffMs / (1000 * 60 * 60 * 24));
}
