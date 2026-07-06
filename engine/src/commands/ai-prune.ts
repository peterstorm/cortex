/**
 * AI-powered memory pruning command.
 * Uses claude -p (headless) to evaluate active memories and archive stale/redundant ones.
 *
 * Smart trigger: runs if session count >= AI_PRUNE_SESSION_INTERVAL
 * OR active memory count >= AI_PRUNE_MEMORY_THRESHOLD.
 *
 * Imperative shell - orchestrates I/O and pure functions.
 */

import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import { getActiveMemories, updateMemory, archiveEdgesForMemory, supersedeFactsForMemory } from '../infra/db.js';
import { isClaudeLlmAvailable, runLlmPrompt } from '../infra/claude-llm.js';
import { writeTelemetry } from '../infra/filesystem.js';
import { invalidateSurfaceCache } from './generate.js';
import {
  AI_PRUNE_SESSION_INTERVAL,
  AI_PRUNE_MEMORY_THRESHOLD,
  AI_PRUNE_TIMEOUT_MS,
  AI_PRUNE_BATCH_SIZE,
  AI_PRUNE_MIN_MEMORIES,
  AI_PRUNE_MIN_AGE_DAYS,
} from '../config.js';

// ============================================================================
// TYPES
// ============================================================================

export interface AiPruneResult {
  readonly archived: number;
  readonly reviewed: number;
  readonly skipped?: boolean;
  readonly error?: string;
}

interface PruneCandidate {
  readonly id: string;
  readonly reason: string;
}

// ============================================================================
// PURE FUNCTIONS
// ============================================================================

/**
 * Check whether AI prune should run (pure).
 *
 * Triggers if EITHER:
 * - sessions_since_ai_prune >= sessionInterval (regular cadence)
 * - active memory count crossed the threshold AND grew >= 25% since the
 *   last prune. A raw count check would fire a full multi-batch LLM prune
 *   on EVERY session once the store stays above the threshold — pruning is
 *   selective, so the count rarely drops back below it.
 */
export function shouldRunAiPrune(
  sessionsSinceAiPrune: number,
  activeMemoryCount: number,
  sessionInterval: number,
  memoryThreshold: number,
  activeCountAtLastPrune: number = 0
): boolean {
  if (sessionsSinceAiPrune >= sessionInterval) return true;

  const growthFloor = Math.max(memoryThreshold, Math.ceil(activeCountAtLastPrune * 1.25));
  return activeMemoryCount >= growthFloor;
}

/**
 * Build the pruning prompt from memory summaries (pure).
 */
export function buildPrunePrompt(
  memories: readonly { id: string; memory_type: string; summary: string; confidence: number; access_count: number; pinned: boolean; created_at: string }[]
): string {
  const memoryLines = memories.map(m =>
    `${m.id} | ${m.memory_type} | conf=${m.confidence.toFixed(2)} | acc=${m.access_count}${m.pinned ? ' | PIN' : ''} | ${m.created_at.slice(0, 10)} | ${m.summary.slice(0, 140)}`
  ).join('\n');

  return `You are a memory pruner for a developer's persistent memory system.
Review these memories and return a JSON array of IDs to archive.

ARCHIVE if:
- Redundant: another memory in the list covers the same information
- Stale: refers to resolved issues, completed tasks, or old session context
- Too granular: implementation details better found by reading code
- One-time: session-specific context that won't help future sessions
- Generic: general best practices an LLM already knows
- Superseded: a newer memory in the list covers this with updated info

NEVER archive:
- Pinned memories (marked PIN)
- Memories less than 3 days old with confidence >= 0.7 (too new to evaluate)
- Architecture or decision memories with confidence >= 0.8 (high-value stable knowledge)

Be selective — only archive when clearly justified. When in doubt, keep.
One per concept: if multiple memories describe the same thing, keep the most comprehensive.

Respond ONLY with a JSON array. No markdown fences, no explanation.
Format: [{"id": "full-uuid", "reason": "short reason"}]
If nothing to archive, return [].

MEMORIES:
${memoryLines}`;
}

/**
 * Parse the LLM response into prune candidates (pure).
 * Tolerates markdown fences and whitespace.
 */
export function parsePruneResponse(response: string): readonly PruneCandidate[] {
  // Strip markdown fences if present
  const cleaned = response
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim();

  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];

    return parsed.filter(
      (item: unknown): item is PruneCandidate =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>).id === 'string' &&
        typeof (item as Record<string, unknown>).reason === 'string'
    );
  } catch {
    logError(`Failed to parse AI prune response: ${cleaned.slice(0, 200)}`);
    return [];
  }
}

// ============================================================================
// TELEMETRY HELPERS
// ============================================================================

function readTelemetry(path: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

function getActiveCountAtLastPrune(telemetryPath: string): number {
  const data = readTelemetry(telemetryPath);
  const val = data.active_count_at_last_ai_prune;
  return typeof val === 'number' ? val : 0;
}

function incrementSessionCounter(telemetryPath: string): number {
  const data = readTelemetry(telemetryPath);
  const current = typeof data.sessions_since_ai_prune === 'number' ? data.sessions_since_ai_prune : 0;
  const next = current + 1;
  data.sessions_since_ai_prune = next;
  writeTelemetry(telemetryPath, data);
  return next;
}

function resetSessionCounter(telemetryPath: string, activeCount: number): void {
  const data = readTelemetry(telemetryPath);
  data.sessions_since_ai_prune = 0;
  data.last_ai_prune_at = new Date().toISOString();
  data.active_count_at_last_ai_prune = activeCount;
  writeTelemetry(telemetryPath, data);
}

// ============================================================================
// LLM CALL
// ============================================================================

/**
 * Call the headless LLM CLI with the prune prompt.
 * Delegates to runLlmPrompt, which handles binary detection (claude vs pi),
 * model/provider selection, pipe draining, and timeout.
 */
async function callClaudePrune(prompt: string): Promise<string> {
  return runLlmPrompt(prompt, AI_PRUNE_TIMEOUT_MS);
}

// ============================================================================
// IMPERATIVE SHELL
// ============================================================================

/**
 * Run AI prune only if triggered by session count or memory threshold.
 * Increments session counter on every call; resets after successful prune.
 */
export async function runAiPruneIfNeeded(
  projectDb: Database,
  globalDb: Database,
  telemetryPath: string,
  cwd?: string
): Promise<AiPruneResult> {
  // Always increment session counter
  const sessionCount = incrementSessionCounter(telemetryPath);

  // Count active memories
  const projectMemories = getActiveMemories(projectDb);
  const globalMemories = getActiveMemories(globalDb);
  const totalActive = projectMemories.length + globalMemories.length;

  const lastPruneCount = getActiveCountAtLastPrune(telemetryPath);
  if (!shouldRunAiPrune(sessionCount, totalActive, AI_PRUNE_SESSION_INTERVAL, AI_PRUNE_MEMORY_THRESHOLD, lastPruneCount)) {
    return { archived: 0, reviewed: 0, skipped: true };
  }

  return runAiPrune(projectDb, globalDb, telemetryPath, cwd);
}

/**
 * Check whether a memory is too young to archive (pure).
 * Enforces the "never archive <AI_PRUNE_MIN_AGE_DAYS days old" rule in code —
 * the LLM prompt states it, but LLM output must never be trusted to obey it.
 */
export function isTooYoungToArchive(
  createdAt: string,
  now: Date,
  minAgeDays: number = AI_PRUNE_MIN_AGE_DAYS
): boolean {
  const ageMs = now.getTime() - new Date(createdAt).getTime();
  return ageMs < minAgeDays * 24 * 60 * 60 * 1000;
}

/**
 * Split array into chunks of given size (pure).
 */
function chunk<T>(arr: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}

/**
 * Run AI prune unconditionally (for manual /ai-prune invocation).
 * Batches memories into chunks of AI_PRUNE_BATCH_SIZE for large stores.
 */
export async function runAiPrune(
  projectDb: Database,
  globalDb: Database,
  telemetryPath: string,
  cwd?: string
): Promise<AiPruneResult> {
  if (!isClaudeLlmAvailable()) {
    return { archived: 0, reviewed: 0, error: 'Claude CLI not available' };
  }

  const projectMemories = getActiveMemories(projectDb);
  const globalMemories = getActiveMemories(globalDb);
  const allMemories = [...projectMemories, ...globalMemories];

  if (allMemories.length === 0) {
    resetSessionCounter(telemetryPath, 0);
    return { archived: 0, reviewed: 0 };
  }

  // Guard: don't prune when memory count is very low.
  // With few memories, aggressive pruning wipes out ALL context.
  if (allMemories.length < AI_PRUNE_MIN_MEMORIES) {
    logInfo(`Skipping AI prune: only ${allMemories.length} active memories (min: ${AI_PRUNE_MIN_MEMORIES})`);
    resetSessionCounter(telemetryPath, allMemories.length);
    return { archived: 0, reviewed: allMemories.length, skipped: true };
  }

  // Build memory data for prompt
  const memoryData = allMemories.map(m => ({
    id: m.id,
    memory_type: m.memory_type,
    summary: m.summary,
    confidence: m.confidence,
    access_count: m.access_count,
    pinned: m.pinned,
    created_at: m.created_at,
  }));

  // Build ID lookup sets for archive routing
  const projectIds = new Set(projectMemories.map(m => m.id));
  const globalIds = new Set(globalMemories.map(m => m.id));
  const pinnedIds = new Set(allMemories.filter(m => m.pinned).map(m => m.id));
  const createdAtById = new Map(allMemories.map(m => [m.id, m.created_at]));

  const batches = chunk(memoryData, AI_PRUNE_BATCH_SIZE);
  const totalBatches = batches.length;

  logInfo(`AI pruning ${allMemories.length} memories in ${totalBatches} batch(es)...`);

  let totalArchived = 0;

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    logInfo(`Batch ${i + 1}/${totalBatches}: ${batch.length} memories`);

    const prompt = buildPrunePrompt(batch);

    let response: string;
    try {
      response = await callClaudePrune(prompt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Batch ${i + 1} LLM call failed: ${message}`);
      continue; // skip failed batch, try next
    }

    const candidates = parsePruneResponse(response);

    for (const candidate of candidates) {
      if (pinnedIds.has(candidate.id)) {
        logInfo(`Skipping pinned memory ${candidate.id.slice(0, 8)}`);
        continue;
      }

      // Age guard enforced in code, not just prompt: never archive
      // memories younger than AI_PRUNE_MIN_AGE_DAYS regardless of LLM output
      const createdAt = createdAtById.get(candidate.id);
      if (createdAt && isTooYoungToArchive(createdAt, new Date())) {
        logInfo(`Skipping too-young memory ${candidate.id.slice(0, 8)} (< ${AI_PRUNE_MIN_AGE_DAYS} days old)`);
        continue;
      }

      // archived_at anchors the archive→prune grace period (FR-091)
      const archivedAt = new Date().toISOString();
      if (projectIds.has(candidate.id)) {
        updateMemory(projectDb, candidate.id, { status: 'archived', archived_at: archivedAt });
        archiveEdgesForMemory(projectDb, candidate.id);
        supersedeFactsForMemory(projectDb, candidate.id);
        totalArchived++;
        logInfo(`Archived ${candidate.id.slice(0, 8)}: ${candidate.reason}`);
      } else if (globalIds.has(candidate.id)) {
        updateMemory(globalDb, candidate.id, { status: 'archived', archived_at: archivedAt });
        archiveEdgesForMemory(globalDb, candidate.id);
        supersedeFactsForMemory(globalDb, candidate.id);
        totalArchived++;
        logInfo(`Archived ${candidate.id.slice(0, 8)}: ${candidate.reason}`);
      } else {
        logError(`AI suggested unknown memory ID: ${candidate.id}`);
      }
    }
  }

  // Invalidate cached surfaces when memories were archived
  if (cwd !== undefined && totalArchived > 0) {
    invalidateSurfaceCache(cwd);
  }

  resetSessionCounter(telemetryPath, allMemories.length - totalArchived);

  logInfo(`AI prune complete: ${totalArchived} archived out of ${allMemories.length} reviewed`);

  return {
    archived: totalArchived,
    reviewed: allMemories.length,
  };
}

// ============================================================================
// LOGGING
// ============================================================================

function logError(message: string): void {
  process.stderr.write(`[cortex:ai-prune] ERROR: ${message}\n`);
}

function logInfo(message: string): void {
  process.stderr.write(`[cortex:ai-prune] INFO: ${message}\n`);
}
