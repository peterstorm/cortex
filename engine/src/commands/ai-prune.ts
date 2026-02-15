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
import { getActiveMemories, updateMemory } from '../infra/db.js';
import { isClaudeLlmAvailable } from '../infra/claude-llm.js';
import {
  AI_PRUNE_SESSION_INTERVAL,
  AI_PRUNE_MEMORY_THRESHOLD,
  AI_PRUNE_TIMEOUT_MS,
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
 * - sessions_since_ai_prune >= sessionInterval
 * - activeMemoryCount >= memoryThreshold
 */
export function shouldRunAiPrune(
  sessionsSinceAiPrune: number,
  activeMemoryCount: number,
  sessionInterval: number,
  memoryThreshold: number
): boolean {
  return sessionsSinceAiPrune >= sessionInterval || activeMemoryCount >= memoryThreshold;
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

NEVER archive pinned memories (marked PIN).
Be aggressive — archived memories are recoverable, not deleted.
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

function writeTelemetryData(path: string, data: Record<string, unknown>): void {
  fs.writeFileSync(path, JSON.stringify(data, null, 2), 'utf8');
}

function getSessionsSinceAiPrune(telemetryPath: string): number {
  const data = readTelemetry(telemetryPath);
  const val = data.sessions_since_ai_prune;
  return typeof val === 'number' ? val : 0;
}

function incrementSessionCounter(telemetryPath: string): number {
  const data = readTelemetry(telemetryPath);
  const current = typeof data.sessions_since_ai_prune === 'number' ? data.sessions_since_ai_prune : 0;
  const next = current + 1;
  data.sessions_since_ai_prune = next;
  writeTelemetryData(telemetryPath, data);
  return next;
}

function resetSessionCounter(telemetryPath: string): void {
  const data = readTelemetry(telemetryPath);
  data.sessions_since_ai_prune = 0;
  data.last_ai_prune_at = new Date().toISOString();
  writeTelemetryData(telemetryPath, data);
}

// ============================================================================
// LLM CALL
// ============================================================================

/**
 * Call claude -p with the prune prompt.
 * Same pattern as extractMemories in claude-llm.ts.
 */
async function callClaudePrune(prompt: string): Promise<string> {
  const proc = Bun.spawn(
    ['claude', '-p', '--model', 'haiku', '--output-format', 'text', '--allowedTools', ''],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { ...process.env, CORTEX_EXTRACTING: '1' },
    }
  );

  proc.stdin.write(prompt);
  proc.stdin.end();

  const stdoutPromise = new Response(proc.stdout).text();
  const stderrPromise = new Response(proc.stderr).text();

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`AI prune timed out after ${AI_PRUNE_TIMEOUT_MS}ms`));
    }, AI_PRUNE_TIMEOUT_MS)
  );

  const exitCode = await Promise.race([proc.exited, timeout]);

  if (exitCode !== 0) {
    const stderr = await stderrPromise;
    throw new Error(`Claude CLI exited with code ${exitCode}: ${stderr.slice(0, 500)}`);
  }

  const stdout = await stdoutPromise;
  if (!stdout.trim()) {
    throw new Error('Empty response from Claude CLI');
  }

  return stdout;
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
  telemetryPath: string
): Promise<AiPruneResult> {
  // Always increment session counter
  const sessionCount = incrementSessionCounter(telemetryPath);

  // Count active memories
  const projectMemories = getActiveMemories(projectDb);
  const globalMemories = getActiveMemories(globalDb);
  const totalActive = projectMemories.length + globalMemories.length;

  if (!shouldRunAiPrune(sessionCount, totalActive, AI_PRUNE_SESSION_INTERVAL, AI_PRUNE_MEMORY_THRESHOLD)) {
    return { archived: 0, reviewed: 0, skipped: true };
  }

  return runAiPrune(projectDb, globalDb, telemetryPath);
}

/**
 * Run AI prune unconditionally (for manual /ai-prune invocation).
 */
export async function runAiPrune(
  projectDb: Database,
  globalDb: Database,
  telemetryPath: string
): Promise<AiPruneResult> {
  if (!isClaudeLlmAvailable()) {
    return { archived: 0, reviewed: 0, error: 'Claude CLI not available' };
  }

  const projectMemories = getActiveMemories(projectDb);
  const globalMemories = getActiveMemories(globalDb);
  const allMemories = [...projectMemories, ...globalMemories];

  if (allMemories.length === 0) {
    resetSessionCounter(telemetryPath);
    return { archived: 0, reviewed: 0 };
  }

  // Build prompt from summaries
  const memoryData = allMemories.map(m => ({
    id: m.id,
    memory_type: m.memory_type,
    summary: m.summary,
    confidence: m.confidence,
    access_count: m.access_count,
    pinned: m.pinned,
    created_at: m.created_at,
  }));

  const prompt = buildPrunePrompt(memoryData);

  logInfo(`AI pruning ${allMemories.length} memories...`);

  let response: string;
  try {
    response = await callClaudePrune(prompt);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logError(`AI prune LLM call failed: ${message}`);
    return { archived: 0, reviewed: allMemories.length, error: message };
  }

  const candidates = parsePruneResponse(response);

  // Build a set of valid memory IDs for safety
  const projectIds = new Set(projectMemories.map(m => m.id));
  const globalIds = new Set(globalMemories.map(m => m.id));
  const pinnedIds = new Set(allMemories.filter(m => m.pinned).map(m => m.id));

  let archivedCount = 0;
  const now = new Date().toISOString();

  for (const candidate of candidates) {
    // Never archive pinned (safety check even though prompt says not to)
    if (pinnedIds.has(candidate.id)) {
      logInfo(`Skipping pinned memory ${candidate.id.slice(0, 8)}`);
      continue;
    }

    if (projectIds.has(candidate.id)) {
      updateMemory(projectDb, candidate.id, { status: 'archived' });
      archivedCount++;
      logInfo(`Archived ${candidate.id.slice(0, 8)}: ${candidate.reason}`);
    } else if (globalIds.has(candidate.id)) {
      updateMemory(globalDb, candidate.id, { status: 'archived' });
      archivedCount++;
      logInfo(`Archived ${candidate.id.slice(0, 8)}: ${candidate.reason}`);
    } else {
      logError(`AI suggested unknown memory ID: ${candidate.id}`);
    }
  }

  resetSessionCounter(telemetryPath);

  logInfo(`AI prune complete: ${archivedCount} archived out of ${allMemories.length} reviewed`);

  return {
    archived: archivedCount,
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
