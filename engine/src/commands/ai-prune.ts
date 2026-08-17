/**
 * AI-powered memory pruning command.
 * Uses the configured LLM (direct OpenAI-compatible endpoint first, headless
 * CLI subprocess as fallback) to evaluate active memories and archive stale/
 * redundant ones.
 *
 * Watermark trigger: runs when enough NEW memories have accumulated since
 * the last SUCCESSFUL prune (telemetry last_ai_prune_at), or when that
 * successful prune is older than the staleness floor — subject to a minimum
 * interval between runs. The watermark advances only on full success, so a
 * failed run never skips the review it owes (see shouldRunAiPrune).
 *
 * Imperative shell - orchestrates I/O and pure functions.
 */

import type { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import type { Memory } from '../core/types.js';
import { getActiveMemories, countActiveMemoriesCreatedAfter, updateMemory, archiveEdgesForMemory, supersedeFactsForMemory } from '../infra/db.js';
import { isClaudeLlmAvailable, runLlmPromptDirect } from '../infra/claude-llm.js';
import { resolveOpenAiCompatEndpoint } from '../infra/llm-client.js';
import { writeTelemetry } from '../infra/filesystem.js';
import { parseJsonFromLlmText } from '../core/json-utils.js';
import { invalidateSurfaceCache } from './generate.js';
import {
  AI_PRUNE_MIN_NEW_MEMORIES,
  AI_PRUNE_MAX_AGE_DAYS,
  AI_PRUNE_MIN_INTERVAL_HOURS,
  AI_PRUNE_TIMEOUT_MS,
  AI_PRUNE_BATCH_SIZE,
  AI_PRUNE_MIN_MEMORIES,
  AI_PRUNE_MIN_AGE_DAYS,
} from '../config.js';
import { chunk } from '../core/chunk.js';

// ============================================================================
// TYPES
// ============================================================================

export interface AiPruneResult {
  readonly archived: number;
  readonly reviewed: number;
  readonly skipped?: boolean;
  readonly error?: string;
}

export interface PruneCandidate {
  readonly id: string;
  readonly reason: string;
}

export type PruneParseOutcome =
  | Readonly<{ kind: 'ok'; candidates: readonly PruneCandidate[] }>
  | Readonly<{ kind: 'unparseable'; reason: string }>;

// ============================================================================
// PURE FUNCTIONS
// ============================================================================

/**
 * Check whether AI prune should run (pure).
 *
 * Watermark semantics — the trigger reads the last SUCCESSFUL prune
 * (lastPruneAt, null = never pruned) and the amount of new work since it:
 *
 * - First run (lastPruneAt === null): run only once the store is worth
 *   reviewing (activeMemoryCount >= minMemories).
 * - Otherwise: the minimum interval must have elapsed (no tight retry
 *   loops right after a prune), and then EITHER
 *     - newMemoriesSinceLastPrune >= minNewMemories (the watermark: there is
 *       genuinely new material for the LLM to judge), OR
 *     - the last successful prune is at least maxAgeDays old (staleness
 *       floor — memories go stale even when nothing new arrives).
 *
 * Deliberately NOT session-count based: a loom run ends many sessions per
 * hour, which used to turn a full multi-batch LLM re-review into a
 * per-session tax.
 */
export function shouldRunAiPrune(
  lastPruneAt: string | null,
  newMemoriesSinceLastPrune: number,
  activeMemoryCount: number,
  now: Date,
  options: {
    readonly minNewMemories?: number;
    readonly maxAgeDays?: number;
    readonly minIntervalHours?: number;
    readonly minMemories?: number;
  } = {}
): boolean {
  const minNewMemories = options.minNewMemories ?? AI_PRUNE_MIN_NEW_MEMORIES;
  const maxAgeDays = options.maxAgeDays ?? AI_PRUNE_MAX_AGE_DAYS;
  const minIntervalHours = options.minIntervalHours ?? AI_PRUNE_MIN_INTERVAL_HOURS;
  const minMemories = options.minMemories ?? AI_PRUNE_MIN_MEMORIES;

  if (lastPruneAt === null) {
    return activeMemoryCount >= minMemories;
  }

  const lastPruneMs = Date.parse(lastPruneAt);
  if (Number.isNaN(lastPruneMs)) {
    // A corrupted/missing timestamp reads as "never pruned": the safe
    // direction is to review again (idempotent) and re-record the watermark.
    return activeMemoryCount >= minMemories;
  }

  const ageMs = now.getTime() - lastPruneMs;
  if (ageMs < minIntervalHours * 60 * 60 * 1000) return false;
  if (ageMs >= maxAgeDays * 24 * 60 * 60 * 1000) return true;
  return newMemoriesSinceLastPrune >= minNewMemories;
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
Review these memories and return a JSON object containing the IDs to archive.

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

Respond ONLY with a JSON object. No markdown fences, no explanation.
Format: {"candidates": [{"id": "full-uuid", "reason": "short reason"}]}
If nothing should be archived, return {"candidates": []}.

MEMORIES:
${memoryLines}`;
}

/**
 * Parse the LLM response into prune candidates (pure).
 * Tolerates markdown fences and whitespace, but never turns malformed or
 * partially invalid output into a successful "archive nothing" decision.
 */
export function parsePruneResponse(response: string): PruneParseOutcome {
  const parsed = parseJsonFromLlmText<unknown>(response);
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'unparseable', reason: 'expected a parseable JSON object envelope' };
  }

  const candidates = (parsed as Record<string, unknown>).candidates;
  if (!Array.isArray(candidates)) {
    return { kind: 'unparseable', reason: 'expected a candidates array' };
  }

  const valid = candidates.filter(
    (item: unknown): item is PruneCandidate =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Record<string, unknown>).id === 'string' &&
      (item as Record<string, unknown>).id !== '' &&
      typeof (item as Record<string, unknown>).reason === 'string' &&
      (item as Record<string, unknown>).reason !== ''
  );
  if (valid.length !== candidates.length) {
    return {
      kind: 'unparseable',
      reason: `${candidates.length - valid.length} of ${candidates.length} candidate item(s) were invalid`,
    };
  }

  return { kind: 'ok', candidates: valid };
}

// ============================================================================
// TELEMETRY HELPERS
// ============================================================================

function readTelemetry(path: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (err) {
    // Absent telemetry is the normal first-run case. A file that EXISTS but
    // cannot be read/parsed silently resets the prune trigger state — say so.
    if (fs.existsSync(path)) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Telemetry ${path} exists but could not be read/parsed (${message}); trigger state resets`);
    }
    return {};
  }
}

function getLastAiPruneAt(telemetryPath: string): string | null {
  const data = readTelemetry(telemetryPath);
  const val = data.last_ai_prune_at;
  return typeof val === 'string' && val.length > 0 ? val : null;
}

/**
 * Advance the prune watermark. Called ONLY after a fully successful review
 * (or a terminal no-op like "store too small" / "empty store"): a failed or
 * partially failed run must leave the watermark in place, or the review it
 * owes would be silently skipped — the same invariant as extraction
 * checkpointing.
 */
function recordSuccessfulAiPrune(telemetryPath: string, at: Date): void {
  const data = readTelemetry(telemetryPath);
  data.last_ai_prune_at = at.toISOString();
  writeTelemetry(telemetryPath, data);
}

// ============================================================================
// LLM CALL
// ============================================================================

/**
 * Call the LLM with the prune prompt.
 * Prefers the direct OpenAI-compatible endpoint (thinking disabled); falls
 * back to the headless CLI subprocess (claude -p / pi -p).
 */
async function callClaudePrune(prompt: string): Promise<string> {
  const { text } = await runLlmPromptDirect(prompt, AI_PRUNE_TIMEOUT_MS, {
    jsonSchema: {
      type: 'object',
      properties: {
        candidates: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1 },
              reason: { type: 'string', minLength: 1 },
            },
            required: ['id', 'reason'],
            additionalProperties: false,
          },
        },
      },
      required: ['candidates'],
      additionalProperties: false,
    },
  });
  return text;
}

// ============================================================================
// IMPERATIVE SHELL
// ============================================================================

/**
 * Run AI prune only if the watermark trigger is satisfied: enough new
 * memories since the last successful prune, or the staleness floor reached.
 */
export async function runAiPruneIfNeeded(
  projectDb: Database,
  globalDb: Database,
  telemetryPath: string,
  cwd?: string
): Promise<AiPruneResult> {
  const projectMemories = getActiveMemories(projectDb);
  const globalMemories = getActiveMemories(globalDb);
  const totalActive = projectMemories.length + globalMemories.length;

  const lastPruneAt = getLastAiPruneAt(telemetryPath);
  const newSinceLastPrune = lastPruneAt === null
    ? totalActive
    : countActiveMemoriesCreatedAfter(projectDb, lastPruneAt)
      + countActiveMemoriesCreatedAfter(globalDb, lastPruneAt);

  if (!shouldRunAiPrune(lastPruneAt, newSinceLastPrune, totalActive, new Date())) {
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
 * High-confidence architecture and decision memories are stable project
 * knowledge. Enforce their prompt-level protection in code because model
 * output is untrusted.
 */
export function isProtectedStableMemory(
  memory: Pick<Memory, 'memory_type' | 'confidence'>
): boolean {
  return (
    (memory.memory_type === 'architecture' || memory.memory_type === 'decision') &&
    memory.confidence >= 0.8
  );
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
  if (resolveOpenAiCompatEndpoint() === null && !isClaudeLlmAvailable()) {
    return {
      archived: 0,
      reviewed: 0,
      error: 'No LLM available: no OpenAI-compatible endpoint configured and no LLM CLI on PATH',
    };
  }

  const projectMemories = getActiveMemories(projectDb);
  const globalMemories = getActiveMemories(globalDb);
  const allMemories = [...projectMemories, ...globalMemories];

  if (allMemories.length === 0) {
    recordSuccessfulAiPrune(telemetryPath, new Date());
    return { archived: 0, reviewed: 0 };
  }

  // Guard: don't prune when memory count is very low.
  // With few memories, aggressive pruning wipes out ALL context.
  if (allMemories.length < AI_PRUNE_MIN_MEMORIES) {
    logInfo(`Skipping AI prune: only ${allMemories.length} active memories (min: ${AI_PRUNE_MIN_MEMORIES})`);
    recordSuccessfulAiPrune(telemetryPath, new Date());
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
  const protectedStableIds = new Set(
    allMemories.filter(isProtectedStableMemory).map(m => m.id)
  );
  const createdAtById = new Map(allMemories.map(m => [m.id, m.created_at]));

  const batches = chunk(memoryData, AI_PRUNE_BATCH_SIZE);
  const totalBatches = batches.length;

  logInfo(`AI pruning ${allMemories.length} memories in ${totalBatches} batch(es)...`);

  let totalArchived = 0;
  let successfulBatches = 0;
  let reviewedMemories = 0;

  // A memory and the graph/entity records derived from it form one archive
  // consistency boundary. If any dependent write fails, SQLite rolls the
  // entire archive back so a later prune can retry the still-active memory.
  const archiveProjectMemory = projectDb.transaction((id: string, archivedAt: string) => {
    updateMemory(projectDb, id, { status: 'archived', archived_at: archivedAt });
    archiveEdgesForMemory(projectDb, id);
    supersedeFactsForMemory(projectDb, id);
  });
  const archiveGlobalMemory = globalDb.transaction((id: string, archivedAt: string) => {
    updateMemory(globalDb, id, { status: 'archived', archived_at: archivedAt });
    archiveEdgesForMemory(globalDb, id);
    supersedeFactsForMemory(globalDb, id);
  });

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

    const parsed = parsePruneResponse(response);
    if (parsed.kind === 'unparseable') {
      logError(`Batch ${i + 1} response was unparseable: ${parsed.reason}`);
      continue;
    }

    // Parse, then validate the model's references before performing writes.
    // A mixed valid/unknown response is one semantically invalid batch: do not
    // archive valid siblings and do not reset cadence as if review succeeded.
    const unknownIds = parsed.candidates
      .map((candidate) => candidate.id)
      .filter((id) => !projectIds.has(id) && !globalIds.has(id));
    if (unknownIds.length > 0) {
      for (const id of unknownIds) {
        logError(`AI suggested unknown memory ID: ${id}`);
      }
      continue;
    }

    successfulBatches++;
    reviewedMemories += batch.length;

    for (const candidate of parsed.candidates) {
      if (pinnedIds.has(candidate.id)) {
        logInfo(`Skipping pinned memory ${candidate.id.slice(0, 8)}`);
        continue;
      }

      if (protectedStableIds.has(candidate.id)) {
        logInfo(`Skipping high-confidence architecture/decision memory ${candidate.id.slice(0, 8)}`);
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
        archiveProjectMemory(candidate.id, archivedAt);
        totalArchived++;
        logInfo(`Archived ${candidate.id.slice(0, 8)}: ${candidate.reason}`);
      } else if (globalIds.has(candidate.id)) {
        archiveGlobalMemory(candidate.id, archivedAt);
        totalArchived++;
        logInfo(`Archived ${candidate.id.slice(0, 8)}: ${candidate.reason}`);
      }
    }
  }

  // Successful batches may already have archived memories even when a sibling
  // batch failed, so invalidate the surface before returning a partial error.
  if (cwd !== undefined && totalArchived > 0) {
    invalidateSurfaceCache(cwd);
  }

  if (successfulBatches !== totalBatches) {
    const failedBatches = totalBatches - successfulBatches;
    return {
      archived: totalArchived,
      reviewed: reviewedMemories,
      error: successfulBatches === 0
        ? `All ${totalBatches} AI prune batches failed`
        : `${failedBatches} of ${totalBatches} AI prune batches failed; cadence was not reset`,
    };
  }

  recordSuccessfulAiPrune(telemetryPath, new Date());

  logInfo(`AI prune complete: ${totalArchived} archived out of ${reviewedMemories} reviewed`);

  return {
    archived: totalArchived,
    reviewed: reviewedMemories,
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
