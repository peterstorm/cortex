/**
 * Lifecycle command: Apply decay, archive, and prune logic to all active memories
 * FR-092, FR-083, FR-088, FR-091
 *
 * Imperative shell - orchestrates I/O and pure core functions
 */

import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import type { Memory } from '../core/types.js';
import { getActiveMemories, getArchivedMemories, getAllEdges, updateMemory, getLatestMemoryTimestamp } from '../infra/db.js';
import { computeAllCentrality } from '../core/graph.js';
import { decayConfidence, determineLifecycleAction } from '../core/decay.js';
import { LIFECYCLE_FALLBACK_HOURS } from '../config.js';

export interface LifecycleResult {
  readonly decayed: number;
  readonly archived: number;
  readonly pruned: number;
  readonly skipped?: boolean;
}

/**
 * Check whether lifecycle should run (pure logic, I/O-provided inputs).
 *
 * Runs if EITHER:
 * - New memories exist since last lifecycle run
 * - Fallback interval exceeded (catches time-based decay on idle projects)
 *
 * @returns true if lifecycle should execute
 */
export function shouldRunLifecycle(
  lastLifecycleAt: string | null,
  latestMemoryAt: string | null,
  now: Date,
  fallbackHours: number
): boolean {
  // Never run before → always run
  if (!lastLifecycleAt) return true;

  const lastRun = new Date(lastLifecycleAt).getTime();

  // New memories since last run
  if (latestMemoryAt) {
    const latestMemory = new Date(latestMemoryAt).getTime();
    if (latestMemory > lastRun) return true;
  }

  // Fallback: time since last run exceeds threshold
  const hoursSinceLastRun = (now.getTime() - lastRun) / (1000 * 60 * 60);
  return hoursSinceLastRun >= fallbackHours;
}

/**
 * Read last_lifecycle_at from telemetry file.
 * Returns null if file missing or field absent.
 */
function readLastLifecycleAt(telemetryPath: string): string | null {
  try {
    const data = JSON.parse(fs.readFileSync(telemetryPath, 'utf8'));
    return typeof data.last_lifecycle_at === 'string' ? data.last_lifecycle_at : null;
  } catch {
    return null;
  }
}

/**
 * Write last_lifecycle_at to telemetry file (merge, don't overwrite).
 */
function writeLastLifecycleAt(telemetryPath: string, timestamp: string): void {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(telemetryPath, 'utf8'));
  } catch {
    // file doesn't exist or invalid — start fresh
  }
  data.last_lifecycle_at = timestamp;
  fs.writeFileSync(telemetryPath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Run lifecycle only if needed (smart trigger).
 * Checks last_lifecycle_at vs latest memory created_at and fallback interval.
 *
 * @returns LifecycleResult with skipped=true if no work was needed
 */
export function runLifecycleIfNeeded(
  projectDb: Database,
  globalDb: Database,
  telemetryPath: string
): LifecycleResult {
  const now = new Date();
  const lastLifecycleAt = readLastLifecycleAt(telemetryPath);

  // Check latest memory across both DBs
  const projectLatest = getLatestMemoryTimestamp(projectDb);
  const globalLatest = getLatestMemoryTimestamp(globalDb);
  const latestMemoryAt = [projectLatest, globalLatest]
    .filter((t): t is string => t !== null)
    .sort()
    .pop() ?? null;

  if (!shouldRunLifecycle(lastLifecycleAt, latestMemoryAt, now, LIFECYCLE_FALLBACK_HOURS)) {
    return { decayed: 0, archived: 0, pruned: 0, skipped: true };
  }

  const projectResult = runLifecycle(projectDb);
  const globalResult = runLifecycle(globalDb);

  writeLastLifecycleAt(telemetryPath, now.toISOString());

  return {
    decayed: projectResult.decayed + globalResult.decayed,
    archived: projectResult.archived + globalResult.archived,
    pruned: projectResult.pruned + globalResult.pruned,
  };
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
