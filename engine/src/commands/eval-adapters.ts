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
import type { MemoryAdmission } from '../core/admission.js';
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
// The eval measures the reads the hooks really make, so it calls the same
// two functions they do rather than a copy of them.
import { composeSurface } from './generate.js';
import { formatPromptRecall, recallForPrompt } from './prompt-recall.js';

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
  /** Where the project's memory lives (its repository root), not the directory the eval ran in. */
  projectRoot: string;
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
export function snapshotMemory({ projectRoot, globalDbPath, snapshotDir }: SnapshotRequest): SnapshotSources {
  const projectDbPath = getProjectDbPath(projectRoot);
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

/**
 * Open a run's snapshot as its manifest describes it. A run taken with no
 * global database reads an empty one, as a live session would.
 *
 * @throws Error when the manifest records a global database but its snapshot
 *   file is gone: answering from the project alone would quietly measure less
 *   memory than the run started with.
 */
function openSnapshot(snapshotDir: string, sources: SnapshotSources): SnapshotDbs {
  const globalPath = path.join(snapshotDir, GLOBAL_SNAPSHOT);
  if (sources.global !== null && !existsSync(globalPath)) {
    throw new Error(
      `the run's snapshot of ${sources.global} is missing (${globalPath}); ` +
        'its memory can no longer be read as it was, so start a new run',
    );
  }
  const projectDb = openDatabaseReadOnly(path.join(snapshotDir, PROJECT_SNAPSHOT));
  try {
    const globalDb = sources.global === null ? openDatabase(':memory:') : openDatabaseReadOnly(globalPath);
    return {
      projectDb,
      globalDb,
      close: () => {
        projectDb.close();
        globalDb.close();
      },
    };
  } catch (error) {
    projectDb.close();
    throw error;
  }
}

/** How many active memories in the snapshot `admit` refuses. */
export function countRefused(snapshotDir: string, sources: SnapshotSources, admit: MemoryAdmission): number {
  const dbs = openSnapshot(snapshotDir, sources);
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
 * question, so it is composed once. Each context says which recall path
 * produced its block: the keyword fallback ranks differently.
 */
export function openSnapshotContext(options: {
  readonly snapshotDir: string;
  /** The databases the snapshot was copied from, as the run's manifest records them. */
  readonly sources: SnapshotSources;
  readonly projectName: string;
  readonly branch: string;
  readonly asOf: Date;
  readonly admit: MemoryAdmission;
}): SnapshotContext {
  const dbs = openSnapshot(options.snapshotDir, options.sources);
  const surface = (() => {
    try {
      return wrapInMarkers(
        composeSurface(dbs.projectDb, dbs.globalDb, options.branch, {
          admit: options.admit,
          now: options.asOf,
        }).content,
      );
    } catch (error) {
      dbs.close();
      throw error;
    }
  })();

  const context: MemoryContext = async (question) => {
    const recalled = await recallForPrompt(dbs.projectDb, dbs.globalDb, {
      prompt: question,
      surfaceContent: surface,
      projectName: options.projectName,
      admit: options.admit,
    });
    return {
      text: [surface, formatPromptRecall(recalled.memories)].filter((block) => block !== '').join('\n\n'),
      recall: recalled.path,
    };
  };

  return { context, close: dbs.close };
}

/** The baseline condition: the agent is given no memory at all. */
export const noMemoryContext: MemoryContext = async () => ({ text: '', recall: 'not-run' });

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
