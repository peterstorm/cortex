#!/usr/bin/env bun
/**
 * CLI entry point for Cortex memory system
 *
 * Satisfies:
 * - FR-119: Receive Stop hook input as JSON stdin (session_id, transcript_path, cwd)
 * - FR-120: Dispatch Stop-hook commands; transcript JSONL parsing lives in
 *   core/extraction.ts (FR-002/FR-012)
 *
 * Architecture:
 * Thin orchestrator - parses subcommand + args, reads stdin, dispatches to commands
 *
 * Subcommands:
 * - extract: Session-end extraction (Stop hook)
 * - ingest-session: Detached extract + backfill + maintenance pipeline for Pi
 * - generate: Push surface generation
 * - recall: Semantic search
 * - remember: Explicit memory creation
 * - index-code: Prose-code pairing
 * - forget: Archive memories
 * - consolidate: Merge duplicates
 * - lifecycle: Apply decay + archival
 * - traverse: Graph traversal
 * - inspect: Telemetry display
 * - backfill: Process embedding queue
 * - prompt-recall: Keyword recall from user prompt (UserPromptSubmit hook)
 * - ai-prune: AI-powered memory pruning
 * - maintenance: Combined lifecycle + ai-prune + semantic-edges maintenance
 * - semantic-edges: Typed-edge classification
 * - load-surface: Surface load cache
 * - entity-query: Entity/fact graph queries
 */

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { HookInput } from './core/types.js';
import {
  getProjectDbPath,
  getGlobalDbPath,
  getSurfaceCacheDir,
  getSurfaceOutputPath,
  getLockDir,
  getTelemetryPath,
  getProjectName,
  DEFAULT_SEARCH_LIMIT,
  GITIGNORE_PATTERNS,
  LOCAL_COSINE_CALIBRATED,
} from './config.js';
import { openDatabase, openDatabaseReadOnly, getActiveMemories, getMemoriesByIds } from './infra/db.js';
import { ensureGitignored, writeSurface } from './infra/filesystem.js';
import { acquireLock, releaseLock } from './infra/lock.js';

// Command imports
import { executeExtract, type ExtractionResult } from './commands/extract.js';
import { runGenerate, loadCachedSurface, computeDbFingerprint } from './commands/generate.js';
import { wrapInMarkers } from './core/surface.js';
import { executeRecall, formatRecallResult, formatRecallError } from './commands/recall.js';
import type { RecallOptions } from './commands/recall.js';
import { executeRemember } from './commands/remember.js';
import { executeIndexCode } from './commands/index-code.js';
import { forgetById, forgetByQuery } from './commands/forget.js';
import { findSimilarPairs, formatPairForReview, mergePair } from './commands/consolidate.js';
import { runFullLifecycle, runLifecycleIfNeeded } from './commands/lifecycle.js';
import { runAiPrune, runAiPruneIfNeeded } from './commands/ai-prune.js';
import { executeTraverse } from './commands/traverse.js';
import { runInspect } from './commands/inspect.js';
import { backfill } from './commands/backfill.js';
import type { BackfillResult } from './commands/backfill.js';
import { executeSemanticEdges } from './commands/semantic-edges.js';
import { executePromptRecallWithFallback, formatPromptRecall } from './commands/prompt-recall.js';
import { executeEntityQuery, formatEntityQueryResult } from './commands/entity-query.js';
import {
  formatSessionIngestionResult,
  isSessionIngestionSuccessful,
  runSessionIngestion,
  type IngestionStepResult,
  type SessionIngestionRetryPolicy,
} from './commands/ingest-session.js';
import { disposeLocalModel, embedLocal } from './infra/local-embed.js';
import { ensureNativeLibraryPath } from './infra/native-library-path.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * The outcome of one CLI command — exactly one of three things happened.
 *
 * This was a flat bag: a `success` boolean beside independent optional
 * `deferred` and `retryable` flags. Nothing in that shape stopped a handler
 * from returning `success: true` and `deferred: true` at once (which
 * extractionToCommandResult in fact did), or a failure with no error to
 * report, and commandToIngestionStep had to recover the real outcome by
 * testing `deferred` BEFORE `success` — an ordering the compiler could not
 * see, let alone enforce. The union makes those states unrepresentable and
 * turns that recovery into a total switch.
 *
 * It sits between two ADTs on either side (ExtractionResult in,
 * IngestionStepResult out); it is now the same kind of thing they are.
 */
export type CommandResult =
  /** The command did its work. */
  | Readonly<{ kind: 'succeeded'; output?: string }>
  /** The command did no work yet and should be attempted again. */
  | Readonly<{ kind: 'deferred'; output?: string }>
  /** The command failed. `retryable` marks a failure a bounded retry may fix. */
  | Readonly<{ kind: 'failed'; error: string; output?: string; retryable?: boolean }>;

// ============================================================================
// STDIN PARSING
// ============================================================================

/**
 * Parse and validate JSON string as HookInput
 * Pure function - no I/O, testable
 *
 * @param jsonText - JSON string to parse
 * @returns Parsed HookInput or null if invalid
 */
export function parseHookInput(jsonText: string): HookInput | null {
  try {
    const parsed = JSON.parse(jsonText);

    // Validate required fields
    if (
      typeof parsed.session_id === 'string' &&
      typeof parsed.transcript_path === 'string' &&
      typeof parsed.cwd === 'string'
    ) {
      return {
        session_id: parsed.session_id,
        transcript_path: parsed.transcript_path,
        cwd: parsed.cwd,
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Drain stdin to text, or null when nothing was piped in.
 *
 * The one place that knows how bytes arrive. Both stdin readers below used to
 * carry their own copy of the reader/concat/decode sequence and diverge only
 * in how they parsed the result — two copies of plumbing that has to change
 * together (a size cap, a different encoding) and no reason for either copy to
 * know that.
 *
 * @returns The decoded text, or null when stdin was empty.
 */
async function readStdinText(): Promise<string | null> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  if (chunks.length === 0) {
    return null;
  }

  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const buffer = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.length;
  }

  return new TextDecoder().decode(buffer);
}

/**
 * Read and parse JSON input from stdin
 * Used by hooks to pass structured data (FR-119)
 *
 * @returns Parsed HookInput or null if stdin empty/invalid
 */
async function readStdinJson(): Promise<HookInput | null> {
  try {
    const text = await readStdinText();
    if (text === null) {
      return null;
    }

    const hookInput = parseHookInput(text);

    if (!hookInput) {
      logError('Invalid stdin JSON: missing required fields (session_id, transcript_path, cwd)');
    }

    return hookInput;
  } catch (err) {
    logError(`Failed to read stdin: ${err}`);
    return null;
  }
}

// ============================================================================
// DATABASE INITIALIZATION
// ============================================================================

/**
 * Validate a cwd argument before any filesystem side effects.
 * Pure predicate over the argument string + a single existsSync/statSync probe.
 *
 * Rejects:
 * - Strings starting with '-' (flags mistaken for cwd, e.g. '--session')
 * - Relative paths (must be absolute)
 * - Paths that do not exist as directories
 *
 * @param cwd - Candidate project root directory
 * @returns Error message if invalid, null if valid
 */
export function validateCwd(cwd: string): string | null {
  if (cwd.startsWith('-')) {
    return `Invalid cwd '${cwd}': looks like a flag, expected an absolute directory path`;
  }
  if (!isAbsolute(cwd)) {
    return `Invalid cwd '${cwd}': must be an absolute path`;
  }
  try {
    if (!statSync(cwd).isDirectory()) {
      return `Invalid cwd '${cwd}': not a directory`;
    }
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : null;
    if (code === 'ENOENT') {
      return `Invalid cwd '${cwd}': directory does not exist`;
    }
    const message = error instanceof Error ? error.message : String(error);
    return `Invalid cwd '${cwd}': cannot inspect directory${code ? ` (${code})` : ''}: ${message}`;
  }
  return null;
}

/** Create a database file's parent directory if it is not already there. */
function ensureDbDir(dbPath: string): void {
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }
}

/**
 * Make a project's `.memory/` usable: directory present, patterns gitignored.
 *
 * Shared by the two entry points that need it — initDatabases, which also
 * wants the global database, and handleConsolidate, which is project-scoped
 * and used to carry its own copy of these steps. A change to how a project
 * root is prepared (a permission mode, another gitignore pattern) now lands in
 * one place instead of one obvious place and one buried in a command handler.
 *
 * Callers validate cwd first; the two disagree about what to do when it is
 * invalid (exit vs. return a failure), so that decision stays with them.
 *
 * @param cwd - Project root directory, already validated.
 * @returns The project database path.
 */
function prepareProjectDbDir(cwd: string): string {
  const projectDbPath = getProjectDbPath(cwd);
  ensureDbDir(projectDbPath);

  try {
    ensureGitignored(cwd, GITIGNORE_PATTERNS);
  } catch (err) {
    logError(`Failed to update .gitignore: ${err}`);
  }

  return projectDbPath;
}

/**
 * Open or create project and global databases
 * Ensures .memory/ directory exists and is gitignored
 *
 * Validates cwd first (single choke point) — exits 1 with a usage error
 * on invalid cwd so no phantom directories are ever created.
 *
 * @param cwd - Project root directory
 * @returns Tuple of [projectDb, globalDb]
 */
function initDatabases(cwd: string): [Database, Database] {
  const cwdError = validateCwd(cwd);
  if (cwdError !== null) {
    logError(cwdError);
    process.exit(1);
  }

  const projectDbPath = prepareProjectDbDir(cwd);
  const globalDbPath = getGlobalDbPath();
  ensureDbDir(globalDbPath);

  // Open databases
  const projectDb = openDatabase(projectDbPath);
  const globalDb = openDatabase(globalDbPath);

  return [projectDb, globalDb];
}

// ============================================================================
// COMMAND HANDLERS
// ============================================================================

/**
 * Translate the extraction ADT into the CLI command protocol.
 *
 * Both sides are three-arm unions over the same three outcomes, so this is a
 * total mapping with nothing to flatten. It used to report a deferral as
 * `success: true, deferred: true` — two flags for one state, which is what
 * forced the downstream reader to guess which of them meant more.
 */
export function extractionToCommandResult(result: ExtractionResult): CommandResult {
  const output = JSON.stringify(result);
  switch (result.kind) {
    case 'succeeded':
      return { kind: 'succeeded', output };
    case 'deferred':
      return { kind: 'deferred', output };
    case 'failed':
      return { kind: 'failed', retryable: result.retryable, output, error: result.error };
  }
}

/** Execute extraction for already-parsed session metadata. */
async function handleExtractInput(input: HookInput): Promise<CommandResult> {
  try {
    ensureGitignored(input.cwd, GITIGNORE_PATTERNS);
  } catch (err) {
    logError(`Failed to update .gitignore: ${err}`);
  }

  // Both DBs: extraction classifies candidate scope (FR-008), and
  // global-scoped candidates must land in the global DB to be visible
  // from other projects.
  const [projectDb, globalDb] = initDatabases(input.cwd);

  try {
    const result = await executeExtract(input, projectDb, globalDb);
    return extractionToCommandResult(result);
  } catch (err) {
    return {
      kind: 'failed',
      retryable: true,
      error: `Extract failed: ${err}`,
    };
  } finally {
    projectDb.close();
    globalDb.close();
  }
}

/**
 * Handle 'extract' subcommand (Stop hook)
 * Reads stdin JSON for hook input.
 */
async function handleExtract(): Promise<CommandResult> {
  const input = await readStdinJson();
  return input
    ? handleExtractInput(input)
    : {
        kind: 'failed',
        error: 'No stdin input provided (expected JSON with session_id, transcript_path, cwd)',
      };
}

/**
 * Handle 'generate' subcommand
 * Generates push surface from ranked memories
 */
async function handleGenerate(args: string[]): Promise<CommandResult> {
  // Args: [cwd]
  if (args.length === 0) {
    return {
      kind: 'failed',
      error: 'Usage: generate <cwd>',
    };
  }

  const cwd = args[0];
  const [projectDb, globalDb] = initDatabases(cwd);

  try {
    const result = runGenerate({
      projectDb,
      globalDb,
      cwd,
      surfacePath: getSurfaceOutputPath(cwd),
      cachePath: getSurfaceCacheDir(cwd),
      lockDir: getLockDir(cwd),
    });

    return {
      kind: 'succeeded',
      output: JSON.stringify(result),
    };
  } catch (err) {
    return {
      kind: 'failed',
      error: `Generate failed: ${err}`,
    };
  } finally {
    projectDb.close();
    globalDb.close();
  }
}

/**
 * Parse recall subcommand arguments
 * Pure function - no side effects, testable
 *
 * @param args - Command line args [cwd, query, ...options]
 * @returns Parsed options or error message
 */
export function parseRecallArgs(
  args: string[]
): { success: true; cwd: string; options: RecallOptions } | { success: false; error: string } {
  if (args.length < 2) {
    return {
      success: false,
      error: 'Usage: recall <cwd> <query> [--branch=BRANCH] [--limit=N] [--keyword]',
    };
  }

  const cwd = args[0];
  const query = args[1];

  // Parse flag options into mutable variables
  let branch: string | undefined;
  let limit: number | undefined;
  let keyword: boolean | undefined;

  for (let i = 2; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--branch=')) {
      branch = arg.slice(9);
    } else if (arg.startsWith('--limit=')) {
      const parsed = parseInt(arg.slice(8), 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        limit = parsed;
      }
    } else if (arg === '--keyword') {
      keyword = true;
    }
  }

  // Construct immutable RecallOptions
  const options: RecallOptions = {
    query,
    projectName: getProjectName(cwd),
    limit: limit ?? DEFAULT_SEARCH_LIMIT,
    ...(branch !== undefined && { branch }),
    ...(keyword !== undefined && { keyword }),
  };

  return { success: true, cwd, options };
}

/**
 * Handle 'recall' subcommand
 * Semantic or keyword search
 */
async function handleRecall(args: string[]): Promise<CommandResult> {
  const parsed = parseRecallArgs(args);
  if (!parsed.success) {
    return {
      kind: 'failed',
      error: parsed.error,
    };
  }

  const { cwd, options } = parsed;
  const [projectDb, globalDb] = initDatabases(cwd);

  try {
    const result = await executeRecall(projectDb, globalDb, options);
    return {
      kind: 'succeeded',
      output: formatRecallResult(result),
    };
  } catch (err) {
    return {
      kind: 'failed',
      error: `Recall failed: ${err}`,
    };
  } finally {
    projectDb.close();
    globalDb.close();
  }
}

/**
 * Handle 'remember' subcommand
 * Create explicit memory
 */
async function handleRemember(args: string[]): Promise<CommandResult> {
  // Args: [cwd, content, ...options]
  if (args.length < 2) {
    return {
      kind: 'failed',
      error: 'Usage: remember <cwd> <content> [--type=TYPE] [--priority=N] [--scope=SCOPE] [--pinned] [--tags=tag1,tag2]',
    };
  }

  const cwd = args[0];
  const [projectDb, globalDb] = initDatabases(cwd);

  // Pass args without cwd to runRemember (it expects content first)
  const rememberArgs = args.slice(1);

  try {
    const result = await executeRemember(
      rememberArgs,
      'manual-session', // Session ID for manual memories
      projectDb,
      globalDb,
      {
        // Cosine dedup only when the active local model is the one the
        // thresholds were calibrated against; otherwise a threshold hit would
        // drop a genuinely new memory as a duplicate. See LOCAL_COSINE_CALIBRATED.
        embedFn: LOCAL_COSINE_CALIBRATED ? embedLocal : null,
        projectName: getProjectName(cwd),
        cwd,
      }
    );

    return result.success
      ? { kind: 'succeeded', output: `Created memory: ${result.memory_id}` }
      : { kind: 'failed', error: result.error };
  } catch (err) {
    return {
      kind: 'failed',
      error: `Remember failed: ${err}`,
    };
  } finally {
    projectDb.close();
    globalDb.close();
  }
}

/**
 * Handle 'index-code' subcommand
 * Index code blocks with prose descriptions
 */
async function handleIndexCode(args: string[]): Promise<CommandResult> {
  // Args: [cwd, filePath, summary, ...flags]
  if (args.length < 3) {
    return {
      kind: 'failed',
      error: 'Usage: index-code <cwd> <filePath> <summary> [--start=N] [--end=N] [--scope=project|global] [--tags=tag1,tag2] [--session=ID]',
    };
  }

  const cwd = args[0];
  const [projectDb, globalDb] = initDatabases(cwd);

  try {
    // Forward everything after cwd: filePath, summary, and all flags
    const result = await executeIndexCode(
      args.slice(1),
      'manual-index',
      projectDb,
      globalDb,
      getProjectName(cwd)
    );

    if (!result.success) {
      return { kind: 'failed', error: result.error };
    }
    return 'code_memory_id' in result
      ? { kind: 'succeeded', output: `Indexed code: ${result.code_memory_id}` }
      : { kind: 'succeeded' };
  } catch (err) {
    return {
      kind: 'failed',
      error: `Index-code failed: ${err}`,
    };
  } finally {
    projectDb.close();
    globalDb.close();
  }
}

/**
 * Handle 'forget' subcommand
 * Archive memory by ID or query
 */
async function handleForget(args: string[]): Promise<CommandResult> {
  // Args: [cwd, idOrQuery]
  if (args.length < 2) {
    return {
      kind: 'failed',
      error: 'Usage: forget <cwd> <idOrQuery>',
    };
  }

  const cwd = args[0];
  const idOrQuery = args[1];
  const [projectDb, globalDb] = initDatabases(cwd);

  try {
    // Try as ID first (both DBs)
    let result = forgetById(projectDb, idOrQuery, cwd);
    if (result.status === 'not_found') {
      result = forgetById(globalDb, idOrQuery, cwd);
    }

    // If still not found, try as keyword query
    if (result.status === 'not_found') {
      result = forgetByQuery(projectDb, idOrQuery);
      if (result.status === 'candidates' && result.memories.length === 0) {
        result = forgetByQuery(globalDb, idOrQuery);
      }
    }

    if (result.status === 'archived') {
      return {
        kind: 'succeeded',
        output: `Archived memory: ${result.memoryId}`,
      };
    } else if (result.status === 'candidates' && result.memories.length === 1) {
      // Single match — auto-archive without confirmation
      const candidate = result.memories[0];
      const archiveResult = forgetById(
        candidate.scope === 'global' ? globalDb : projectDb,
        candidate.id,
        cwd,
      );
      if (archiveResult.status === 'archived') {
        return {
          kind: 'succeeded',
          output: `Archived memory: ${archiveResult.memoryId}`,
        };
      }
      return { kind: 'failed', error: `Failed to archive ${candidate.id}` };
    } else if (result.status === 'candidates' && result.memories.length > 1) {
      const list = result.memories.map(m => `  ${m.id} - ${m.summary}`).join('\n');
      return {
        kind: 'succeeded',
        output: `Found ${result.memories.length} candidate(s):\n${list}`,
      };
    } else {
      return {
        kind: 'failed',
        error: 'Memory not found',
      };
    }
  } catch (err) {
    return {
      kind: 'failed',
      error: `Forget failed: ${err}`,
    };
  } finally {
    projectDb.close();
    globalDb.close();
  }
}

/**
 * Handle 'consolidate' subcommand
 *
 * List mode:  consolidate <cwd> [--threshold=N]
 *   Prints each similar pair with IDs, similarity, and content for review.
 * Merge mode: consolidate <cwd> --merge --a=<idA> --b=<idB> --summary=<text> --content=<text>
 *   Merges one reviewed pair (FR-075..077); human approval happens in the skill.
 */
async function handleConsolidate(args: string[]): Promise<CommandResult> {
  if (args.length < 1) {
    return {
      kind: 'failed',
      error: 'Usage: consolidate <cwd> [--threshold=N] | consolidate <cwd> --merge --a=<idA> --b=<idB> --summary=<text> --content=<text>',
    };
  }

  const cwd = args[0];
  const cwdError = validateCwd(cwd);
  if (cwdError !== null) {
    return { kind: 'failed', error: cwdError };
  }
  // Only open project DB - consolidate operates on project scope only
  const projectDbPath = prepareProjectDbDir(cwd);

  const projectDb = openDatabase(projectDbPath);

  try {
    if (args.includes('--merge')) {
      const flagValue = (name: string): string | undefined => {
        const arg = args.find(a => a.startsWith(`--${name}=`));
        return arg?.slice(name.length + 3);
      };
      const idA = flagValue('a');
      const idB = flagValue('b');
      const summary = flagValue('summary');
      const content = flagValue('content');
      if (!idA || !idB || !summary || !content) {
        return {
          kind: 'failed',
          error: 'Usage: consolidate <cwd> --merge --a=<idA> --b=<idB> --summary=<text> --content=<text>',
        };
      }

      // 'any' status: mergePair re-checks status inside its transaction and
      // returns a more informative skip reason than "not found"
      const found = getMemoriesByIds(projectDb, [idA, idB], 'any');
      const memoryA = found.find(m => m.id === idA);
      const memoryB = found.find(m => m.id === idB);
      if (!memoryA || !memoryB) {
        const missing = [!memoryA && idA, !memoryB && idB].filter(Boolean).join(', ');
        return { kind: 'failed', error: `Memory not found: ${missing}` };
      }

      const mergeResult = mergePair(
        projectDb,
        { memoryA, memoryB, similarity: 1.0 },
        summary,
        content,
        'consolidate-session',
        cwd
      );
      if (mergeResult.kind === 'skipped') {
        return {
          kind: 'failed',
          error: `Merge skipped: ${mergeResult.reason}`,
        };
      }
      return {
        kind: 'succeeded',
        output: `Merged ${idA} + ${idB} -> ${mergeResult.mergedId} (both originals superseded). Run backfill + generate to refresh embeddings and surface.`,
      };
    }

    const thresholdArg = args.find(a => a.startsWith('--threshold='));
    const threshold = thresholdArg ? Number.parseFloat(thresholdArg.slice('--threshold='.length)) : undefined;
    if (threshold !== undefined && (Number.isNaN(threshold) || threshold <= 0 || threshold > 1)) {
      return { kind: 'failed', error: '--threshold must be a number in (0, 1]' };
    }

    const memories = getActiveMemories(projectDb);
    const pairs = findSimilarPairs(memories, threshold);

    if (pairs.length === 0) {
      return { kind: 'succeeded', output: 'Found 0 similar pairs' };
    }

    const sections = pairs.map(formatPairForReview);
    const header = `Found ${pairs.length} similar pair(s). To merge one:\n  consolidate <cwd> --merge --a=<idA> --b=<idB> --summary=<merged summary> --content=<merged content>\n`;
    return {
      kind: 'succeeded',
      output: [header, ...sections].join('\n'),
    };
  } catch (err) {
    return {
      kind: 'failed',
      error: `Consolidate failed: ${err}`,
    };
  } finally {
    projectDb.close();
  }
}

/**
 * Handle 'lifecycle' subcommand
 * Apply decay + archival + pruning
 * --if-needed: smart trigger — skip if no new memories and last run <2h ago
 */
async function handleLifecycle(args: string[]): Promise<CommandResult> {
  // Args: [cwd] [--if-needed]
  if (args.length < 1) {
    return {
      kind: 'failed',
      error: 'Usage: lifecycle <cwd> [--if-needed]',
    };
  }

  const cwd = args[0];
  const ifNeeded = args.includes('--if-needed');
  const [projectDb, globalDb] = initDatabases(cwd);

  try {
    if (ifNeeded) {
      const result = runLifecycleIfNeeded(projectDb, globalDb, getTelemetryPath(cwd), cwd);
      if (result.skipped) {
        return { kind: 'succeeded', output: 'Lifecycle skipped (no changes needed)' };
      }
      return {
        kind: 'succeeded',
        output: `Lifecycle complete: archived ${result.archived}, pruned ${result.pruned}`,
      };
    }

    // Same lifecycle+vacuum sequence as the --if-needed path (minus the
    // skip heuristics) — a manual run must also hard-delete expired
    // pruned rows.
    const result = runFullLifecycle(projectDb, globalDb, cwd);

    return {
      kind: 'succeeded',
      output: `Lifecycle complete: archived ${result.archived}, pruned ${result.pruned}`,
    };
  } catch (err) {
    return {
      kind: 'failed',
      error: `Lifecycle failed: ${err}`,
    };
  } finally {
    projectDb.close();
    globalDb.close();
  }
}

/**
 * Handle `ai-prune`: direct OpenAI-compatible LLM first, CLI fallback.
 * `--if-needed` runs on the session interval or sufficient memory growth.
 */
async function handleAiPrune(args: string[]): Promise<CommandResult> {
  if (args.length < 1) {
    return {
      kind: 'failed',
      error: 'Usage: ai-prune <cwd> [--if-needed]',
    };
  }

  const cwd = args[0];
  const ifNeeded = args.includes('--if-needed');
  const lockFile = join(getLockDir(cwd), 'ai-prune.lock');
  const lock = acquireLock(lockFile);
  if (!lock.acquired) {
    return lock.reason === 'held'
      ? { kind: 'succeeded', output: 'AI prune skipped (another run is active)' }
      : { kind: 'failed', error: 'AI prune failed: could not acquire lock' };
  }

  try {
    const [projectDb, globalDb] = initDatabases(cwd);
    try {
      const result = ifNeeded
        ? await runAiPruneIfNeeded(projectDb, globalDb, getTelemetryPath(cwd), cwd)
        : await runAiPrune(projectDb, globalDb, getTelemetryPath(cwd), cwd);

      if (result.kind === 'skipped') {
        return { kind: 'succeeded', output: `AI prune skipped: ${result.reason}` };
      }
      if (result.kind === 'failed') {
        return { kind: 'failed', error: `AI prune failed: ${result.error}` };
      }
      return {
        kind: 'succeeded',
        output: `AI prune complete: archived ${result.archived} of ${result.reviewed} reviewed`,
      };
    } catch (err) {
      return {
        kind: 'failed',
        error: `AI prune failed: ${err}`,
      };
    } finally {
      projectDb.close();
      globalDb.close();
    }
  } finally {
    releaseLock(lockFile);
  }
}

/**
 * Handle 'traverse' subcommand
 * BFS graph traversal from memory ID
 */
async function handleTraverse(args: string[]): Promise<CommandResult> {
  // Args: [cwd, memoryId, maxDepth] [--include-archived]
  const includeArchived = args.includes('--include-archived');
  const positional = args.filter(a => !a.startsWith('--'));

  if (positional.length < 2) {
    return {
      kind: 'failed',
      error: 'Usage: traverse <cwd> <memoryId> [maxDepth] [--include-archived]',
    };
  }

  const cwd = positional[0];
  const memoryId = positional[1];
  const maxDepth = positional.length > 2 ? parseInt(positional[2], 10) : 2;
  const [projectDb, globalDb] = initDatabases(cwd);

  try {
    // Try project DB first
    let result = executeTraverse(projectDb, { id: memoryId, depth: maxDepth, includeArchived });
    if (!result.success) {
      // Try global DB
      result = executeTraverse(globalDb, { id: memoryId, depth: maxDepth, includeArchived });
    }

    if (!result.success) {
      return {
        kind: 'failed',
        error: JSON.stringify(result.error),
      };
    }

    return {
      kind: 'succeeded',
      output: JSON.stringify(result.result),
    };
  } catch (err) {
    return {
      kind: 'failed',
      error: `Traverse failed: ${err}`,
    };
  } finally {
    projectDb.close();
    globalDb.close();
  }
}

/**
 * Handle 'inspect' subcommand
 * Display telemetry and memory stats
 */
async function handleInspect(args: string[]): Promise<CommandResult> {
  // Args: [cwd]
  if (args.length < 1) {
    return {
      kind: 'failed',
      error: 'Usage: inspect <cwd>',
    };
  }

  const cwd = args[0];
  const [projectDb, globalDb] = initDatabases(cwd);

  try {
    runInspect(
      projectDb,
      globalDb,
      getTelemetryPath(cwd),
      getSurfaceCacheDir(cwd)
    );

    return {
      kind: 'succeeded',
    };
  } catch (err) {
    return {
      kind: 'failed',
      error: `Inspect failed: ${err}`,
    };
  } finally {
    projectDb.close();
    globalDb.close();
  }
}

/**
 * A command outcome plus the per-memory warnings the caller should print.
 *
 * Paired rather than intersected with CommandResult: warnings are orthogonal
 * to which arm the outcome is (a partial success and a total failure both
 * carry them), and `CommandResult & { warnings }` distributes over the union,
 * so every reader had to destructure it before it could see `error` at all.
 */
export type BackfillSummary = Readonly<{
  result: CommandResult;
  warnings: readonly string[];
}>;

/**
 * Summarize project + global backfill results into a CommandResult.
 * Pure function — no I/O, testable.
 *
 * - Any `ok: false` result → failure with the error(s)
 * - `failed > 0` → per-memory errors surfaced in `warnings` (caller prints
 *   to stderr), failed count included in output
 * - Everything failed (`failed > 0 && processed === 0`) → failure
 */
export function summarizeBackfillResults(
  projectResult: BackfillResult,
  globalResult: BackfillResult
): BackfillSummary {
  const results = [projectResult, globalResult];
  const hardErrors = results.flatMap((r) => (r.ok ? [] : [r.error]));

  if (hardErrors.length > 0) {
    return { result: { kind: 'failed', error: hardErrors.join('; ') }, warnings: [] };
  }

  const okResults = results.filter((r): r is Extract<BackfillResult, { ok: true }> => r.ok);
  const processed = okResults.reduce((sum, r) => sum + r.processed, 0);
  const failed = okResults.reduce((sum, r) => sum + r.failed, 0);
  const warnings = okResults.flatMap((r) => [...r.errors]);

  if (failed > 0 && processed === 0) {
    return {
      result: { kind: 'failed', error: `Backfill failed: all ${failed} embedding(s) failed` },
      warnings,
    };
  }

  return {
    result: {
      kind: 'succeeded',
      output:
        failed > 0
          ? `Backfill complete: processed ${processed} memories, ${failed} failed`
          : `Backfill complete: processed ${processed} memories`,
    },
    warnings,
  };
}

/**
 * Handle 'backfill' subcommand
 * Process pending embedding queue
 */
async function handleBackfill(args: string[]): Promise<CommandResult> {
  // Args: [cwd]
  if (args.length < 1) {
    return {
      kind: 'failed',
      error: 'Usage: backfill <cwd>',
    };
  }

  const cwd = args[0];
  const [projectDb, globalDb] = initDatabases(cwd);
  try {
    const projectResult = await backfill(projectDb, getProjectName(cwd));
    const globalResult = await backfill(globalDb, 'global');

    const { result, warnings } = summarizeBackfillResults(projectResult, globalResult);
    for (const warning of warnings) {
      logError(warning);
    }
    return result;
  } catch (err) {
    return {
      kind: 'failed',
      error: `Backfill failed: ${err}`,
    };
  } finally {
    projectDb.close();
    globalDb.close();
  }
}

/**
 * Handle 'semantic-edges' subcommand
 * Classify relates_to edges with typed relationships via the configured LLM
 * (direct OpenAI-compatible endpoint first, CLI subprocess as fallback).
 */
async function handleSemanticEdges(args: string[]): Promise<CommandResult> {
  if (args.length < 1) {
    return {
      kind: 'failed',
      error: 'Usage: semantic-edges <cwd>',
    };
  }

  const cwd = args[0];
  const [projectDb, globalDb] = initDatabases(cwd);

  const limit = (() => {
    const limitArg = args.find(a => a.startsWith('--limit='));
    if (!limitArg) return { invalid: false as const, value: 0 };
    const parsed = parseInt(limitArg.split('=')[1], 10);
    if (Number.isNaN(parsed) || parsed < 0) {
      return { invalid: true as const };
    }
    return { invalid: false as const, value: parsed };
  })();
  if (limit.invalid) {
    return { kind: 'failed', error: '--limit must be a non-negative integer' };
  }

  try {
    const result = await executeSemanticEdges(projectDb, { limit: limit.value, lockDir: getLockDir(cwd) });

    if (!result.ok) {
      return { kind: 'failed', error: result.error };
    }

    return {
      kind: 'succeeded',
      output: `Semantic edges: classified=${result.classified}, failed=${result.failed}`,
    };
  } catch (err) {
    return {
      kind: 'failed',
      error: `Semantic edges failed: ${err}`,
    };
  } finally {
    projectDb.close();
    globalDb.close();
  }
}

/**
 * Handle 'load-surface' subcommand (SessionStart hook)
 * Load cached push surface if available
 */
async function handleLoadSurface(args: string[]): Promise<CommandResult> {
  // Args: [cwd]
  if (args.length < 1) {
    return {
      kind: 'failed',
      error: 'Usage: load-surface <cwd>',
    };
  }

  const cwd = args[0];

  try {
    // Only act for projects that already use cortex. This hook runs at
    // SessionStart in EVERY project; creating .memory/DBs in untouched
    // projects is not ok — and without a project DB the cache fingerprint
    // can't be validated anyway.
    if (!existsSync(getProjectDbPath(cwd))) {
      return { kind: 'succeeded', output: 'No cached surface available' };
    }

    const [projectDb, globalDb] = initDatabases(cwd);
    try {
      // Fingerprint the current DBs so a cache written against a different
      // memory set (archives, merges, inserts) is a miss, not a hit.
      const fingerprint = computeDbFingerprint(projectDb, globalDb);
      const result = loadCachedSurface(cwd, getSurfaceCacheDir(cwd), fingerprint);

      if (result !== null && !result.staleness.stale) {
        // Write cached surface through the same locked, atomic,
        // marker-splicing path as generation — a bare writeFileSync here
        // bypassed the surface lock and clobbered user content.
        writeSurface(getSurfaceOutputPath(cwd), wrapInMarkers(result.surface), getLockDir(cwd));
        return { kind: 'succeeded', output: 'Loaded cached surface' };
      }

      // Cache miss or stale: regenerate from the database
      runGenerate({
        projectDb,
        globalDb,
        cwd,
        surfacePath: getSurfaceOutputPath(cwd),
        cachePath: getSurfaceCacheDir(cwd),
        lockDir: getLockDir(cwd),
      });
      return {
        kind: 'succeeded',
        output: result === null
          ? 'Regenerated surface (cache miss)'
          : `Regenerated surface (cache stale: ${result.staleness.age_hours.toFixed(1)}h old)`,
      };
    } finally {
      projectDb.close();
      globalDb.close();
    }
  } catch (err) {
    return {
      kind: 'failed',
      error: `Load-surface failed: ${err}`,
    };
  }
}

/**
 * Handle 'entity-query' subcommand
 * Entity-first temporal retrieval
 */
async function handleEntityQuery(args: string[]): Promise<CommandResult> {
  if (args.length < 2) {
    return {
      kind: 'failed',
      error: 'Usage: entity-query <cwd> <query> [--history] [--limit=N]',
    };
  }

  const cwd = args[0];
  const query = args[1];
  const includeHistory = args.includes('--history');
  const limitArg = args.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 5;

  const [projectDb, globalDb] = initDatabases(cwd);

  try {
    const result = executeEntityQuery(projectDb, globalDb, {
      query,
      includeHistory,
      limit,
    });

    return {
      kind: 'succeeded',
      output: formatEntityQueryResult(result),
    };
  } catch (err) {
    return {
      kind: 'failed',
      error: `Entity query failed: ${err}`,
    };
  } finally {
    projectDb.close();
    globalDb.close();
  }
}

export type PromptRecallDatabaseOpeners = Readonly<{
  readOnly: (path: string) => Database;
  readWrite: (path: string) => Database;
  warn: (message: string) => void;
}>;

/** Open a prompt-recall DB read-only, with an observable read-write fallback. */
export function openPromptRecallDatabase(
  path: string,
  openers: PromptRecallDatabaseOpeners = {
    readOnly: openDatabaseReadOnly,
    readWrite: openDatabase,
    warn: (message) => process.stderr.write(`${message}\n`),
  },
): Database | null {
  try {
    return openers.readOnly(path);
  } catch (error) {
    openers.warn(
      `[cortex] WARN: prompt-recall read-only open failed for ${path}; ` +
        `falling back to read-write: ${error instanceof Error ? error.message : String(error)}`,
    );
    try {
      return openers.readWrite(path);
    } catch (fallbackError) {
      openers.warn(
        `[cortex] WARN: prompt-recall could not open database ${path}: ` +
          `${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
      );
      return null;
    }
  }
}

/**
 * Handle 'prompt-recall' subcommand (UserPromptSubmit hook)
 * Reads stdin JSON with prompt + cwd, runs keyword FTS5 recall
 * Always succeeds — never exits non-zero
 */
async function handlePromptRecall(): Promise<CommandResult> {
  try {
    const text = await readStdinText();
    if (text === null) {
      return { kind: 'succeeded' };
    }

    const parsed = JSON.parse(text);

    const prompt = parsed?.prompt;
    const cwd = parsed?.cwd;
    if (typeof prompt !== 'string' || typeof cwd !== 'string') {
      process.stderr.write(
        '[cortex] WARN: prompt-recall ignored malformed input: expected string prompt and cwd\n'
      );
      return { kind: 'succeeded' };
    }

    // Check DBs exist — don't create empty ones for a read-only hook
    const projectDbPath = getProjectDbPath(cwd);
    const globalDbPath = getGlobalDbPath();
    const hasProjectDb = existsSync(projectDbPath);
    const hasGlobalDb = existsSync(globalDbPath);

    if (!hasProjectDb && !hasGlobalDb) {
      return { kind: 'succeeded' };
    }

    // Read surface file for dedup
    const surfacePath = getSurfaceOutputPath(cwd);
    let surfaceContent = '';
    try {
      if (existsSync(surfacePath)) {
        surfaceContent = readFileSync(surfacePath, 'utf8');
      }
    } catch (err) {
      // Best-effort hook: a surface read failure must not fail the prompt,
      // but it must not vanish without a trace either.
      process.stderr.write(
        `[cortex] WARN: prompt-recall could not read surface file ${surfacePath}: ` +
          `${err instanceof Error ? err.message : String(err)}\n`
      );
    }

    // Read-only fast path: this hook fires on EVERY user prompt and only reads.
    // That path skips schema DDL/migrations and avoids the writer lock. If it
    // fails (e.g. odd filesystem semantics), the best-effort fallback uses the
    // normal read-write open and may initialize schema or take the writer lock.
    const projectDb = hasProjectDb ? openPromptRecallDatabase(projectDbPath) : null;
    const globalDb = hasGlobalDb ? openPromptRecallDatabase(globalDbPath) : null;

    try {
      const memories = await executePromptRecallWithFallback(projectDb, globalDb, {
        prompt,
        surfaceContent,
        projectName: getProjectName(cwd),
      });
      const output = formatPromptRecall(memories);

      return {
        kind: 'succeeded',
        output: output || undefined,
      };
    } finally {
      projectDb?.close();
      globalDb?.close();
    }
  } catch (err) {
    // Never fail — prompt-recall is best-effort. But never silent: a broken
    // hook must leave a trace, or a corrupt DB would dead-silence memory
    // injection on every prompt with no way to diagnose it.
    process.stderr.write(
      `[cortex] WARN: prompt-recall failed (best-effort, continuing): ` +
        `${err instanceof Error ? err.message : String(err)}\n`
    );
    return { kind: 'succeeded' };
  }
}

/**
 * Run expensive post-session work sequentially behind one per-project lock.
 * Duplicate shutdowns skip rather than multiplying LLM workers.
 */
async function handleMaintenance(args: string[]): Promise<CommandResult> {
  if (args.length < 1) {
    return { kind: 'failed', error: 'Usage: maintenance <cwd>' };
  }

  const cwd = args[0];
  const lockFile = join(getLockDir(cwd), 'maintenance.lock');
  const lock = acquireLock(lockFile);
  if (!lock.acquired) {
    return lock.reason === 'held'
      ? { kind: 'succeeded', output: 'Maintenance skipped (another run is active)' }
      : { kind: 'failed', error: 'Maintenance failed: could not acquire lock' };
  }

  try {
    const steps: readonly (() => Promise<CommandResult>)[] = [
      () => handleSemanticEdges([cwd]),
      () => handleLifecycle([cwd, '--if-needed']),
      () => handleAiPrune([cwd, '--if-needed']),
      () => handleGenerate([cwd]),
    ];
    const results: CommandResult[] = [];
    for (const runStep of steps) results.push(await runStep());

    const output = results
      .map((result) => result.output ?? (result.kind === 'failed' ? result.error : undefined))
      .filter((line): line is string => Boolean(line))
      .join('\n');
    // A deferred step did no work but did not fail — it is retried on the next
    // run, so it must not turn the whole maintenance pass into a failure.
    const failures = results.filter((result) => result.kind === 'failed');

    return failures.length === 0
      ? { kind: 'succeeded', output }
      : {
          kind: 'failed',
          output,
          error: `Maintenance completed with ${failures.length} failed step(s)`,
        };
  } finally {
    releaseLock(lockFile);
  }
}

/**
 * Handle the complete detached Pi session-end pipeline from one stdin payload.
 * Keeping sequencing in this worker lets the extension return immediately
 * while preserving extract → backfill → maintenance ordering.
 */
export type IngestSessionCommandOperations = Readonly<{
  extract: (input: HookInput) => Promise<CommandResult>;
  backfill: (cwd: string) => Promise<CommandResult>;
  maintenance: (cwd: string) => Promise<CommandResult>;
}>;

/**
 * Parse one CLI command result into the detached ingestion protocol.
 *
 * A total switch over the arm. It used to be an ordered chain that had to test
 * `deferred` before `success` because a deferral set both; swapping the two
 * checks silently reclassified every deferral as a success, and nothing in the
 * types said so.
 */
export function commandToIngestionStep(result: CommandResult): IngestionStepResult {
  const withOutput = result.output === undefined ? {} : { output: result.output };
  switch (result.kind) {
    case 'succeeded':
      return { kind: 'succeeded', ...withOutput };
    case 'deferred':
      return { kind: 'deferred', reason: result.output ?? 'command deferred' };
    case 'failed':
      return {
        kind: 'failed',
        retryable: result.retryable === true,
        error: result.error,
        ...withOutput,
      };
  }
}

/** Injectable shell boundary for the complete detached ingestion pipeline. */
export async function runIngestSessionInput(
  input: HookInput,
  operations: IngestSessionCommandOperations = {
    extract: handleExtractInput,
    backfill: (cwd) => handleBackfill([cwd]),
    maintenance: (cwd) => handleMaintenance([cwd]),
  },
  retryPolicy?: SessionIngestionRetryPolicy,
): Promise<CommandResult> {
  const result = await runSessionIngestion({
    extract: async () => commandToIngestionStep(await operations.extract(input)),
    backfill: async () => commandToIngestionStep(await operations.backfill(input.cwd)),
    maintenance: async () => commandToIngestionStep(await operations.maintenance(input.cwd)),
  }, retryPolicy);

  const output = formatSessionIngestionResult(result);
  return isSessionIngestionSuccessful(result)
    ? { kind: 'succeeded', output }
    : { kind: 'failed', output, error: 'Session ingestion completed with failed step(s)' };
}

async function handleIngestSession(): Promise<CommandResult> {
  const input = await readStdinJson();
  return input
    ? runIngestSessionInput(input)
    : {
        kind: 'failed',
        error: 'No stdin input provided (expected JSON with session_id, transcript_path, cwd)',
      };
}

// ============================================================================
// MAIN DISPATCH
// ============================================================================

/**
 * Main CLI entry point
 * Parses subcommand and dispatches to appropriate handler
 */
async function main() {
  // Before any subcommand runs, because the loader reads LD_LIBRARY_PATH once
  // at process start: where onnxruntime's libstdc++ is off the default path,
  // this re-runs the process with it and never returns. A no-op everywhere
  // else, including the hook scripts that already set the path themselves.
  ensureNativeLibraryPath();

  const args = process.argv.slice(2);

  if (args.length === 0) {
    logError('Usage: cli.ts <subcommand> [args...]');
    logError('Subcommands: extract, ingest-session, generate, recall, remember, index-code, forget, consolidate, lifecycle, ai-prune, maintenance, traverse, inspect, backfill, semantic-edges, load-surface, prompt-recall, entity-query');
    process.exit(1);
  }

  const subcommand = args[0];
  const subcommandArgs = args.slice(1);

  let result: CommandResult;

  try {
    switch (subcommand) {
      case 'extract':
        result = await handleExtract();
        break;
      case 'ingest-session':
        result = await handleIngestSession();
        break;
      case 'generate':
        result = await handleGenerate(subcommandArgs);
        break;
      case 'recall':
        result = await handleRecall(subcommandArgs);
        break;
      case 'remember':
        result = await handleRemember(subcommandArgs);
        break;
      case 'index-code':
        result = await handleIndexCode(subcommandArgs);
        break;
      case 'forget':
        result = await handleForget(subcommandArgs);
        break;
      case 'consolidate':
        result = await handleConsolidate(subcommandArgs);
        break;
      case 'lifecycle':
        result = await handleLifecycle(subcommandArgs);
        break;
      case 'ai-prune':
        result = await handleAiPrune(subcommandArgs);
        break;
      case 'maintenance':
        result = await handleMaintenance(subcommandArgs);
        break;
      case 'traverse':
        result = await handleTraverse(subcommandArgs);
        break;
      case 'inspect':
        result = await handleInspect(subcommandArgs);
        break;
      case 'backfill':
        result = await handleBackfill(subcommandArgs);
        break;
      case 'semantic-edges':
        result = await handleSemanticEdges(subcommandArgs);
        break;
      case 'load-surface':
        result = await handleLoadSurface(subcommandArgs);
        break;
      case 'prompt-recall':
        result = await handlePromptRecall();
        break;
      case 'entity-query':
        result = await handleEntityQuery(subcommandArgs);
        break;
      default:
        result = {
          kind: 'failed',
          error: `Unknown subcommand: ${subcommand}`,
        };
    }
  } catch (err) {
    result = {
      kind: 'failed',
      error: `Unhandled error: ${err}`,
    };
  }

  // Output result
  if (result.output) {
    process.stdout.write(result.output + '\n');
  }

  // Dispose ONNX model resources before exit
  await disposeLocalModel();

  // A deferral is not a failure: the command did no work yet and the caller is
  // expected to run it again, so it exits 0 like a success.
  if (result.kind === 'failed') {
    logError(result.error);
    process.exit(1);
  }

  process.exit(0);
}

// ============================================================================
// UTILITIES
// ============================================================================

/**
 * Log error to stderr
 */
function logError(message: string): void {
  console.error(`[cortex] ${message}`);
}

// Run main only when executed directly (not imported by tests)
if (import.meta.main) {
  main().catch((err) => {
    logError(`Fatal error: ${err}`);
    process.exit(1);
  });
}
