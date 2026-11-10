/**
 * Eval run: the identity of one answering run, and when two runs (or a run
 * and its resumption) are comparable.
 *
 * A run answers every case under one condition, one requested answer model,
 * one answer-prompt template and one frozen memory snapshot. Resuming a run
 * that was interrupted is allowed only under the same identity; anything else
 * is a new experiment and needs a new run name.
 *
 * Pure functional core — no I/O.
 */

import { match } from 'ts-pattern';
import { parseRunName, type ParseResult, type Row, type RunName } from './eval-set.js';

/** What the answering agent is given: cortex's injected context, or nothing (the baseline). */
export type Condition = 'cortex' | 'none';
export const CONDITIONS: readonly Condition[] = ['cortex', 'none'] as const;

export function parseCondition(raw: unknown): Condition | null {
  return typeof raw === 'string' && (CONDITIONS as readonly string[]).includes(raw)
    ? (raw as Condition)
    : null;
}

/**
 * The memory a run reads: a frozen snapshot, or none at all. Surface ranking
 * also depends on the branch and on time (recency decay), so a snapshot run
 * pins both: the branch here, the time as the manifest's createdAt.
 */
export type MemorySource =
  | Readonly<{
      kind: 'snapshot';
      branch: string;
      /** Memories refused because an authoring session produced them. */
      excludedMemories: number;
      excludedSessions: readonly string[];
    }>
  | Readonly<{ kind: 'none' }>;

// ============================================================================
// PORTS
// ============================================================================

export type LlmReply = Readonly<{
  content: string;
  /** The model the provider reports having used. */
  model: string;
  promptTokens: number | null;
}>;

/** One prompt in, one completion out. Answering and judging are separate adapters. */
export type Llm = (prompt: string) => Promise<LlmReply>;

/** The memory context an agent would be given at the start of a turn asking `question`. */
export type MemoryContext = (question: string) => Promise<string>;

export type RunManifest = Readonly<{
  run: RunName;
  condition: Condition;
  project: string;
  requestedModel: string;
  answerPromptDigest: string;
  memory: MemorySource;
  createdAt: string;
}>;

export function manifestToRow(manifest: RunManifest): Record<string, unknown> {
  return {
    run: manifest.run,
    condition: manifest.condition,
    project: manifest.project,
    requested_model: manifest.requestedModel,
    answer_prompt_sha256: manifest.answerPromptDigest,
    memory: match(manifest.memory)
      .with({ kind: 'snapshot' }, (m) => ({
        kind: m.kind,
        branch: m.branch,
        excluded_memories: m.excludedMemories,
        excluded_sessions: [...m.excludedSessions],
      }))
      .with({ kind: 'none' }, (m) => ({ kind: m.kind }))
      .exhaustive(),
    created_at: manifest.createdAt,
  };
}

function parseMemorySource(raw: unknown): MemorySource | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const row = raw as Row;
  if (row.kind === 'none') return { kind: 'none' };
  if (row.kind !== 'snapshot') return null;
  const sessions = row.excluded_sessions;
  if (
    typeof row.branch !== 'string' ||
    typeof row.excluded_memories !== 'number' ||
    !Array.isArray(sessions) ||
    !sessions.every((s) => typeof s === 'string')
  ) {
    return null;
  }
  return {
    kind: 'snapshot',
    branch: row.branch,
    excludedMemories: row.excluded_memories,
    excludedSessions: sessions as readonly string[],
  };
}

export function parseManifest(text: string): ParseResult<RunManifest> {
  const fail = (message: string): ParseResult<RunManifest> => ({
    kind: 'err',
    errors: [{ line: 1, message }],
  });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('expected a JSON object');
  }
  if (typeof raw !== 'object' || raw === null) return fail('expected a JSON object');
  const row = raw as Row;

  const run = parseRunName(row.run);
  const condition = parseCondition(row.condition);
  const memory = parseMemorySource(row.memory);
  if (!run) return fail('run must be a run name');
  if (!condition) return fail('condition must be cortex or none');
  if (!memory) return fail('memory must describe a snapshot or none');
  for (const key of ['project', 'requested_model', 'answer_prompt_sha256', 'created_at'] as const) {
    if (typeof row[key] !== 'string') return fail(`${key} must be a string`);
  }
  return {
    kind: 'ok',
    value: {
      run,
      condition,
      project: row.project as string,
      requestedModel: row.requested_model as string,
      answerPromptDigest: row.answer_prompt_sha256 as string,
      memory,
      createdAt: row.created_at as string,
    },
  };
}

const sameSessions = (a: readonly string[], b: readonly string[]): boolean => {
  const sortedB = [...b].sort();
  return a.length === b.length && [...a].sort().every((s, i) => s === sortedB[i]);
};

/**
 * Why `wanted` cannot resume `existing`, or [] when it can. The snapshot,
 * its branch and its as-of time are reused on resume, so memory cannot
 * drift; what can drift is everything the caller chooses afresh.
 */
export function resumeConflicts(existing: RunManifest, wanted: RunManifest): readonly string[] {
  const conflicts: string[] = [];
  const differs = (label: string, a: string, b: string) => {
    if (a !== b) conflicts.push(`${label}: run has ${a}, now ${b}`);
  };
  differs('condition', existing.condition, wanted.condition);
  differs('project', existing.project, wanted.project);
  differs('answer model', existing.requestedModel, wanted.requestedModel);
  differs('answer prompt', existing.answerPromptDigest.slice(0, 12), wanted.answerPromptDigest.slice(0, 12));
  if (
    existing.memory.kind === 'snapshot' &&
    wanted.memory.kind === 'snapshot' &&
    !sameSessions(existing.memory.excludedSessions, wanted.memory.excludedSessions)
  ) {
    conflicts.push('authoring sessions changed since the run started');
  }
  return conflicts;
}
