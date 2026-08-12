/**
 * Lifecycle command: Apply decay, archive, and prune logic to all active memories
 * FR-092, FR-083, FR-088, FR-091
 *
 * Imperative shell - orchestrates I/O and pure core functions
 */

import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import type { Memory } from '../core/types.js';
import { getActiveMemories, getArchivedMemories, getAllEdges, updateMemory, deleteEdgesForMemory, archiveEdgesForMemory, getLatestMemoryTimestamp, vacuumPrunedMemories, supersedeFactsForMemory } from '../infra/db.js';
import { computeAllCentrality } from '../core/graph.js';
import { writeTelemetry } from '../infra/filesystem.js';
import { decayConfidence, determineLifecycleAction } from '../core/decay.js';
import { LIFECYCLE_FALLBACK_HOURS, VACUUM_RETENTION_DAYS } from '../config.js';
import { invalidateSurfaceCache } from './generate.js';

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
 * Uses writeTelemetry (temp file + atomic rename) so concurrent readers
 * never observe torn JSON.
 */
function writeLastLifecycleAt(telemetryPath: string, timestamp: string): void {
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(fs.readFileSync(telemetryPath, 'utf8'));
  } catch {
    // file doesn't exist or invalid — start fresh
  }
  data.last_lifecycle_at = timestamp;
  writeTelemetry(telemetryPath, data);
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
  telemetryPath: string,
  cwd?: string
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

  const result = runFullLifecycle(projectDb, globalDb, cwd);

  writeLastLifecycleAt(telemetryPath, now.toISOString());

  return result;
}

/**
 * Run lifecycle on both databases AND vacuum expired pruned rows.
 * Shared by the smart-trigger path (runLifecycleIfNeeded) and the plain
 * `lifecycle <cwd>` CLI path — previously vacuum only ran on the
 * `--if-needed` path, so a manual lifecycle never hard-deleted pruned
 * memories past the retention period.
 *
 * @param projectDb - Project database
 * @param globalDb - Global database
 * @param cwd - Project root; when provided, surface cache is invalidated on changes
 * @returns Combined lifecycle counts across both databases
 */
export function runFullLifecycle(
  projectDb: Database,
  globalDb: Database,
  cwd?: string
): LifecycleResult {
  const projectResult = runLifecycle(projectDb, cwd);
  const globalResult = runLifecycle(globalDb, cwd);

  // Hard-delete pruned memories past retention period
  vacuumPrunedMemories(projectDb, VACUUM_RETENTION_DAYS);
  vacuumPrunedMemories(globalDb, VACUUM_RETENTION_DAYS);

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
export function runLifecycle(db: Database, cwd?: string): LifecycleResult {
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
  // Note: We compute effective (decayed) confidence for lifecycle decisions
  // but do NOT write it back to DB. Stored confidence stays at the original
  // value — decay is recomputed on-the-fly from last_accessed_at each run.
  // This prevents the double-decay bug and lets recall reset the decay clock.
  for (const memory of activeMemories) {
    const centrality = centralityMap.get(memory.id) ?? 0;

    // Pure: Compute effective confidence (not stored)
    const effectiveConfidence = decayConfidence(memory, centrality, now);

    // Track if confidence has effectively decayed
    const hasDecayed = Math.abs(effectiveConfidence - memory.confidence) > 0.001;
    if (hasDecayed) {
      decayedCount++;
    }

    // Pure: Approximate daysBelowThreshold
    // If effective confidence < 0.3 and last_accessed_at >= 14 days ago
    const daysSinceAccess = computeDaysSince(memory.last_accessed_at, now);
    const daysBelowThreshold = effectiveConfidence < 0.3 && daysSinceAccess >= 14 ? daysSinceAccess : 0;

    // Pure: Determine lifecycle action
    const action = determineLifecycleAction(memory, effectiveConfidence, daysBelowThreshold, centrality, now);

    // I/O: Only write to DB on status transitions
    if (action.action === 'archive') {
      // archived_at anchors the archive→prune grace period (FR-091)
      updateMemory(db, memory.id, { status: 'archived', archived_at: now.toISOString() });
      archiveEdgesForMemory(db, memory.id);
      // Retract entity facts sourced from the archived memory
      supersedeFactsForMemory(db, memory.id);
      archivedCount++;
    } else if (action.action === 'prune') {
      updateMemory(db, memory.id, { status: 'pruned' });
      deleteEdgesForMemory(db, memory.id);
      supersedeFactsForMemory(db, memory.id);
      prunedCount++;
    }
    // exempt and none: no DB write needed
  }

  // Also process archived memories for pruning.
  // Note: A memory archived in the loop above will NOT be pruned in the same
  // call — prune eligibility is anchored at archived_at, giving every
  // archived memory a full PRUNE_THRESHOLD_DAYS grace period before its
  // edges are hard-deleted (legacy rows without archived_at fall back to
  // updated_at, which the archive write also refreshes).
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
      deleteEdgesForMemory(db, memory.id);
      supersedeFactsForMemory(db, memory.id);
      prunedCount++;
    }
  }

  // Invalidate cached surfaces when the visible memory set changed
  if (cwd !== undefined && (archivedCount > 0 || prunedCount > 0)) {
    invalidateSurfaceCache(cwd);
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
