/**
 * Adapters for the eval ports (core/eval-run.ts): a frozen memory snapshot,
 * the memory context the hooks would inject from it, and LLM endpoints.
 *
 * Imperative shell — every function here does I/O.
 */

import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { getProjectDbPath } from '../config.js';
import { wrapInMarkers } from '../core/surface.js';
import type { Llm, MemoryContext, SnapshotSources } from '../core/eval-run.js';
import { VERDICT_SCHEMA } from '../core/eval-rubric.js';
import { getActiveMemories, openDatabase, openDatabaseReadOnly } from '../infra/db.js';
import {
  chatCompletion,
  resolveOpenAiCompatEndpoint,
  type ChatCompletionOptions,
  type LlmEndpoint,
} from '../infra/llm-client.js';
import { composeSurface, type MemoryAdmission } from './generate.js';
import { executePromptRecallWithFallback, formatPromptRecall } from './prompt-recall.js';

// ============================================================================
// MEMORY SNAPSHOT
// ============================================================================

const PROJECT_SNAPSHOT = 'project.db';
const GLOBAL_SNAPSHOT = 'global.db';

/** Memories from authoring sessions hold the answer key; every eval read refuses them. */
export const excludeSessions =
  (sessions: ReadonlySet<string>): MemoryAdmission =>
  (memory) =>
    !sessions.has(memory.source_session);

export type SnapshotRequest = Readonly<{
  /** The project whose memory DB is copied. */
  cwd: string;
  /** The global DB the CLI would open; the caller resolves it, so a test never reads the real one. */
  globalDbPath: string;
  snapshotDir: string;
}>;

/**
 * Copy the project's (and the global) memory DB into `snapshotDir` with
 * VACUUM INTO: a consistent point-in-time copy taken from a read-only
 * connection, so a live session writing to the DB is never blocked.
 *
 * @returns the databases it copied, for the run manifest
 * @throws Error when the project has no cortex DB — there is nothing to evaluate
 */
export function snapshotMemory({ cwd, globalDbPath, snapshotDir }: SnapshotRequest): SnapshotSources {
  const projectDbPath = getProjectDbPath(cwd);
  if (!existsSync(projectDbPath)) {
    throw new Error(`no cortex database at ${projectDbPath}; nothing to evaluate`);
  }
  const sources: SnapshotSources = {
    project: projectDbPath,
    global: existsSync(globalDbPath) ? globalDbPath : null,
  };
  mkdirSync(snapshotDir, { recursive: true });
  const copies: readonly (readonly [string, string])[] = [
    [sources.project, PROJECT_SNAPSHOT],
    ...(sources.global === null ? [] : [[sources.global, GLOBAL_SNAPSHOT] as const]),
  ];
  for (const [source, name] of copies) {
    const target = path.join(snapshotDir, name);
    // VACUUM INTO refuses an existing file. One here is a leftover from a run
    // start that died before writing its manifest, so it was never used.
    rmSync(target, { force: true });
    const db = openDatabaseReadOnly(source);
    try {
      db.prepare('VACUUM INTO ?').run(target);
    } finally {
      db.close();
    }
  }
  return sources;
}

type SnapshotDbs = Readonly<{ projectDb: Database; globalDb: Database; close: () => void }>;

/** A missing global snapshot reads as an empty global DB, as it does live. */
function openSnapshot(snapshotDir: string): SnapshotDbs {
  const projectDb = openDatabaseReadOnly(path.join(snapshotDir, PROJECT_SNAPSHOT));
  const globalPath = path.join(snapshotDir, GLOBAL_SNAPSHOT);
  const globalDb = existsSync(globalPath) ? openDatabaseReadOnly(globalPath) : openDatabase(':memory:');
  return {
    projectDb,
    globalDb,
    close: () => {
      projectDb.close();
      globalDb.close();
    },
  };
}

/** How many active memories in the snapshot `admit` refuses. */
export function countRefused(snapshotDir: string, admit: MemoryAdmission): number {
  const dbs = openSnapshot(snapshotDir);
  try {
    return [...getActiveMemories(dbs.projectDb), ...getActiveMemories(dbs.globalDb)].filter(
      (memory) => !admit(memory),
    ).length;
  } finally {
    dbs.close();
  }
}

export type SnapshotContext = Readonly<{ context: MemoryContext; close: () => void }>;

/**
 * The context Claude Code's hooks inject on a prompt — the push surface
 * followed by the prompt-recall block — computed from the snapshot with the
 * run's pinned branch and time. The surface does not depend on the
 * question, so it is composed once.
 */
export function openSnapshotContext(options: {
  readonly snapshotDir: string;
  readonly projectName: string;
  readonly branch: string;
  readonly asOf: Date;
  readonly admit: MemoryAdmission;
}): SnapshotContext {
  const dbs = openSnapshot(options.snapshotDir);
  const surface = wrapInMarkers(
    composeSurface(dbs.projectDb, dbs.globalDb, options.branch, {
      admit: options.admit,
      now: options.asOf,
    }).content,
  );

  const context: MemoryContext = async (question) => {
    const recalled = await executePromptRecallWithFallback(dbs.projectDb, dbs.globalDb, {
      prompt: question,
      surfaceContent: surface,
      projectName: options.projectName,
      admit: options.admit,
    });
    return [surface, formatPromptRecall(recalled)].filter((block) => block !== '').join('\n\n');
  };

  return { context, close: dbs.close };
}

/** The baseline condition: the agent is given no memory at all. */
export const noMemoryContext: MemoryContext = async () => '';

// ============================================================================
// LLM ENDPOINTS
// ============================================================================

export type EvalRole = 'answer' | 'judge';

export type EndpointResolution =
  | Readonly<{ kind: 'ok'; endpoint: LlmEndpoint }>
  | Readonly<{ kind: 'err'; message: string }>;

/**
 * Resolve the endpoint for one eval role. CORTEX_EVAL_<ROLE>_{API_URL,
 * API_KEY,MODEL} pin it explicitly (all three, or none); otherwise the role
 * uses cortex's own direct endpoint. There is deliberately no fallback to the
 * claude/pi CLI: a run must name the model it measured, and the CLI path
 * would also fire cortex's own hooks into the answer.
 */
export function resolveEvalEndpoint(
  role: EvalRole,
  env: Readonly<Record<string, string | undefined>>,
): EndpointResolution {
  const names = ['API_URL', 'API_KEY', 'MODEL'].map((n) => `CORTEX_EVAL_${role.toUpperCase()}_${n}`);
  const [url, key, model] = names.map((n) => env[n] || undefined);

  if (url && key && model) {
    return { kind: 'ok', endpoint: { baseUrl: url.replace(/\/+$/, ''), apiKey: key, model } };
  }
  if (url || key || model) {
    return { kind: 'err', message: `set all of ${names.join(', ')}, or none of them` };
  }
  const fallback = resolveOpenAiCompatEndpoint();
  return fallback
    ? { kind: 'ok', endpoint: fallback }
    : {
        kind: 'err',
        message: `no OpenAI-compatible endpoint for the ${role} model: set ${names.join(', ')}`,
      };
}

/** Room for a drafted email or plan; a truncated answer fails rather than being judged. */
export const ANSWER_COMPLETION: ChatCompletionOptions = {
  maxTokens: 3000,
  temperature: 0,
  timeoutMs: 300_000,
};

export const JUDGE_COMPLETION: ChatCompletionOptions = {
  jsonSchema: VERDICT_SCHEMA,
  maxTokens: 800,
  temperature: 0,
  timeoutMs: 180_000,
};

export const endpointLlm =
  (endpoint: LlmEndpoint, options: ChatCompletionOptions): Llm =>
  async (prompt) => {
    const completion = await chatCompletion(endpoint, prompt, options);
    return {
      content: completion.content,
      model: completion.model,
      promptTokens: completion.promptTokens,
    };
  };
