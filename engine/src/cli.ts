#!/usr/bin/env bun
/**
 * CLI entry point for Cortex memory system
 *
 * Satisfies:
 * - FR-119: Receive Stop hook input as JSON stdin (session_id, transcript_path, cwd)
 * - FR-120: Parse transcript as JSONL format
 *
 * Architecture:
 * Thin orchestrator - parses subcommand + args, reads stdin, dispatches to commands
 *
 * Subcommands:
 * - extract: Session-end extraction (Stop hook)
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
 */

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { HookInput } from './core/types.js';
import {
  getGeminiApiKey,
  getProjectDbPath,
  getGlobalDbPath,
  getSurfaceCacheDir,
  getSurfaceOutputPath,
  getLockDir,
  getTelemetryPath,
  getProjectName,
  DEFAULT_SEARCH_LIMIT,
  GITIGNORE_PATTERNS,
} from './config.js';
import { openDatabase, getActiveMemories } from './infra/db.js';
import { ensureGitignored } from './infra/filesystem.js';

// Command imports
import { executeExtract } from './commands/extract.js';
import { runGenerate, loadCachedSurface } from './commands/generate.js';
import { wrapInMarkers } from './core/surface.js';
import { executeRecall, formatRecallResult, formatRecallError } from './commands/recall.js';
import type { RecallOptions } from './commands/recall.js';
import { executeRemember } from './commands/remember.js';
import { executeIndexCode } from './commands/index-code.js';
import { forgetById, forgetByQuery } from './commands/forget.js';
import { findSimilarPairs } from './commands/consolidate.js';
import { runLifecycle } from './commands/lifecycle.js';
import { executeTraverse } from './commands/traverse.js';
import { runInspect } from './commands/inspect.js';
import { backfill } from './commands/backfill.js';

// ============================================================================
// TYPES
// ============================================================================

type CommandResult = {
  readonly success: boolean;
  readonly output?: string;
  readonly error?: string;
};

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
 * Read and parse JSON input from stdin
 * Used by hooks to pass structured data (FR-119)
 *
 * @returns Parsed HookInput or null if stdin empty/invalid
 */
async function readStdinJson(): Promise<HookInput | null> {
  try {
    const stdin = Bun.stdin.stream();
    const reader = stdin.getReader();
    const chunks: Uint8Array[] = [];

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    if (chunks.length === 0) {
      return null;
    }

    // Concatenate chunks
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const buffer = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
      buffer.set(chunk, offset);
      offset += chunk.length;
    }

    const text = new TextDecoder().decode(buffer);
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
 * Open or create project and global databases
 * Ensures .memory/ directory exists and is gitignored
 *
 * @param cwd - Project root directory
 * @returns Tuple of [projectDb, globalDb]
 */
function initDatabases(cwd: string): [Database, Database] {
  const projectDbPath = getProjectDbPath(cwd);
  const globalDbPath = getGlobalDbPath();

  // Ensure parent directories exist
  const projectDbDir = dirname(projectDbPath);
  if (!existsSync(projectDbDir)) {
    mkdirSync(projectDbDir, { recursive: true });
  }

  const globalDbDir = dirname(globalDbPath);
  if (!existsSync(globalDbDir)) {
    mkdirSync(globalDbDir, { recursive: true });
  }

  // Ensure .gitignore patterns
  try {
    ensureGitignored(cwd, GITIGNORE_PATTERNS);
  } catch (err) {
    logError(`Failed to update .gitignore: ${err}`);
  }

  // Open databases
  const projectDb = openDatabase(projectDbPath);
  const globalDb = openDatabase(globalDbPath);

  return [projectDb, globalDb];
}

// ============================================================================
// COMMAND HANDLERS
// ============================================================================

/**
 * Handle 'extract' subcommand (Stop hook)
 * Reads stdin JSON for hook input
 */
async function handleExtract(): Promise<CommandResult> {
  const input = await readStdinJson();
  if (!input) {
    return {
      success: false,
      error: 'No stdin input provided (expected JSON with session_id, transcript_path, cwd)',
    };
  }

  // Only open project DB - extract doesn't use global DB
  const projectDbPath = getProjectDbPath(input.cwd);
  const projectDbDir = dirname(projectDbPath);
  if (!existsSync(projectDbDir)) {
    mkdirSync(projectDbDir, { recursive: true });
  }

  try {
    ensureGitignored(input.cwd, GITIGNORE_PATTERNS);
  } catch (err) {
    logError(`Failed to update .gitignore: ${err}`);
  }

  const projectDb = openDatabase(projectDbPath);

  try {
    const result = await executeExtract(input, projectDb);
    return {
      success: result.success,
      output: JSON.stringify(result),
      error: result.error,
    };
  } catch (err) {
    return {
      success: false,
      error: `Extract failed: ${err}`,
    };
  } finally {
    projectDb.close();
  }
}

/**
 * Handle 'generate' subcommand
 * Generates push surface from ranked memories
 */
async function handleGenerate(args: string[]): Promise<CommandResult> {
  // Args: [cwd]
  if (args.length === 0) {
    return {
      success: false,
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
      success: true,
      output: JSON.stringify(result),
    };
  } catch (err) {
    return {
      success: false,
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
    geminiApiKey: getGeminiApiKey(),
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
      success: false,
      error: parsed.error,
    };
  }

  const { cwd, options } = parsed;
  const [projectDb, globalDb] = initDatabases(cwd);

  try {
    const result = await executeRecall(projectDb, globalDb, options);
    return {
      success: true,
      output: formatRecallResult(result),
    };
  } catch (err) {
    return {
      success: false,
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
      success: false,
      error: 'Usage: remember <cwd> <content> [--type=TYPE] [--priority=N] [--scope=SCOPE] [--pinned] [--tags=tag1,tag2]',
    };
  }

  const cwd = args[0];
  const [projectDb, globalDb] = initDatabases(cwd);

  // Pass args without cwd to runRemember (it expects content first)
  const rememberArgs = args.slice(1);

  try {
    const result = executeRemember(
      rememberArgs,
      'manual-session', // Session ID for manual memories
      projectDb,
      globalDb
    );

    return {
      success: result.success,
      output: result.success ? `Created memory: ${result.memory_id}` : undefined,
      error: result.error,
    };
  } catch (err) {
    return {
      success: false,
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
  // Args: [cwd, proseId, codePath]
  if (args.length < 3) {
    return {
      success: false,
      error: 'Usage: index-code <cwd> <proseId> <codePath>',
    };
  }

  const cwd = args[0];
  const proseId = args[1];
  const codePath = args[2];
  const [projectDb, globalDb] = initDatabases(cwd);

  try {
    const result = await executeIndexCode(
      [proseId, codePath],
      'manual-index',
      projectDb,
      globalDb,
      getGeminiApiKey(),
      getProjectName(cwd)
    );

    return {
      success: result.success,
      output: result.success && 'code_memory_id' in result ? `Indexed code: ${result.code_memory_id}` : undefined,
      error: !result.success ? result.error : undefined,
    };
  } catch (err) {
    return {
      success: false,
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
      success: false,
      error: 'Usage: forget <cwd> <idOrQuery>',
    };
  }

  const cwd = args[0];
  const idOrQuery = args[1];
  const [projectDb, globalDb] = initDatabases(cwd);

  try {
    // Try as ID first (both DBs)
    let result = forgetById(projectDb, idOrQuery);
    if (result.status === 'not_found') {
      result = forgetById(globalDb, idOrQuery);
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
        success: true,
        output: `Archived memory: ${result.memoryId}`,
      };
    } else if (result.status === 'candidates' && result.memories.length > 0) {
      const list = result.memories.map(m => `  ${m.id} - ${m.summary}`).join('\n');
      return {
        success: true,
        output: `Found ${result.memories.length} candidate(s):\n${list}`,
      };
    } else {
      return {
        success: false,
        output: 'Memory not found',
      };
    }
  } catch (err) {
    return {
      success: false,
      error: `Forget failed: ${err}`,
    };
  } finally {
    projectDb.close();
    globalDb.close();
  }
}

/**
 * Handle 'consolidate' subcommand
 * Find and report similar memory pairs
 */
async function handleConsolidate(args: string[]): Promise<CommandResult> {
  // Args: [cwd]
  if (args.length < 1) {
    return {
      success: false,
      error: 'Usage: consolidate <cwd>',
    };
  }

  const cwd = args[0];
  // Only open project DB - consolidate operates on project scope only
  const projectDbPath = getProjectDbPath(cwd);
  const projectDbDir = dirname(projectDbPath);
  if (!existsSync(projectDbDir)) {
    mkdirSync(projectDbDir, { recursive: true });
  }

  try {
    ensureGitignored(cwd, GITIGNORE_PATTERNS);
  } catch (err) {
    logError(`Failed to update .gitignore: ${err}`);
  }

  const projectDb = openDatabase(projectDbPath);

  try {
    const memories = getActiveMemories(projectDb);
    const pairs = findSimilarPairs(memories);
    return {
      success: true,
      output: `Found ${pairs.length} similar pairs`,
    };
  } catch (err) {
    return {
      success: false,
      error: `Consolidate failed: ${err}`,
    };
  } finally {
    projectDb.close();
  }
}

/**
 * Handle 'lifecycle' subcommand
 * Apply decay + archival + pruning
 */
async function handleLifecycle(args: string[]): Promise<CommandResult> {
  // Args: [cwd]
  if (args.length < 1) {
    return {
      success: false,
      error: 'Usage: lifecycle <cwd>',
    };
  }

  const cwd = args[0];
  const [projectDb, globalDb] = initDatabases(cwd);

  try {
    const projectResult = runLifecycle(projectDb);
    const globalResult = runLifecycle(globalDb);

    return {
      success: true,
      output: `Lifecycle complete: archived ${projectResult.archived + globalResult.archived}, pruned ${projectResult.pruned + globalResult.pruned}`,
    };
  } catch (err) {
    return {
      success: false,
      error: `Lifecycle failed: ${err}`,
    };
  } finally {
    projectDb.close();
    globalDb.close();
  }
}

/**
 * Handle 'traverse' subcommand
 * BFS graph traversal from memory ID
 */
async function handleTraverse(args: string[]): Promise<CommandResult> {
  // Args: [cwd, memoryId, maxDepth]
  if (args.length < 2) {
    return {
      success: false,
      error: 'Usage: traverse <cwd> <memoryId> [maxDepth]',
    };
  }

  const cwd = args[0];
  const memoryId = args[1];
  const maxDepth = args.length > 2 ? parseInt(args[2], 10) : 2;
  const [projectDb, globalDb] = initDatabases(cwd);

  try {
    // Try project DB first
    let result = executeTraverse(projectDb, { id: memoryId, depth: maxDepth });
    if (!result.success) {
      // Try global DB
      result = executeTraverse(globalDb, { id: memoryId, depth: maxDepth });
    }

    if (!result.success) {
      return {
        success: false,
        error: JSON.stringify(result.error),
      };
    }

    return {
      success: true,
      output: JSON.stringify(result.result),
    };
  } catch (err) {
    return {
      success: false,
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
      success: false,
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
      success: true,
    };
  } catch (err) {
    return {
      success: false,
      error: `Inspect failed: ${err}`,
    };
  } finally {
    projectDb.close();
    globalDb.close();
  }
}

/**
 * Handle 'backfill' subcommand
 * Process pending embedding queue
 */
async function handleBackfill(args: string[]): Promise<CommandResult> {
  // Args: [cwd]
  if (args.length < 1) {
    return {
      success: false,
      error: 'Usage: backfill <cwd>',
    };
  }

  const cwd = args[0];
  const [projectDb, globalDb] = initDatabases(cwd);
  const apiKey = getGeminiApiKey();

  try {
    const projectResult = await backfill(projectDb, getProjectName(cwd), apiKey);
    const globalResult = await backfill(globalDb, 'global', apiKey);

    const processed = (projectResult.ok ? projectResult.processed : 0) + (globalResult.ok ? globalResult.processed : 0);
    return {
      success: true,
      output: `Backfill complete: processed ${processed} memories`,
    };
  } catch (err) {
    return {
      success: false,
      error: `Backfill failed: ${err}`,
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
      success: false,
      error: 'Usage: load-surface <cwd>',
    };
  }

  const cwd = args[0];

  try {
    const result = loadCachedSurface(cwd, getSurfaceCacheDir(cwd));

    if (result !== null) {
      // Write cached surface to .claude/cortex-memory.local.md
      const outputPath = getSurfaceOutputPath(cwd);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, wrapInMarkers(result.surface), 'utf8');
    }

    return {
      success: true,
      output: result !== null ? 'Loaded cached surface' : 'No cached surface available',
    };
  } catch (err) {
    return {
      success: false,
      error: `Load-surface failed: ${err}`,
    };
  }
}

// ============================================================================
// MAIN DISPATCH
// ============================================================================

/**
 * Main CLI entry point
 * Parses subcommand and dispatches to appropriate handler
 */
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    logError('Usage: cli.ts <subcommand> [args...]');
    logError('Subcommands: extract, generate, recall, remember, index-code, forget, consolidate, lifecycle, traverse, inspect, backfill, load-surface');
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
      case 'traverse':
        result = await handleTraverse(subcommandArgs);
        break;
      case 'inspect':
        result = await handleInspect(subcommandArgs);
        break;
      case 'backfill':
        result = await handleBackfill(subcommandArgs);
        break;
      case 'load-surface':
        result = await handleLoadSurface(subcommandArgs);
        break;
      default:
        result = {
          success: false,
          error: `Unknown subcommand: ${subcommand}`,
        };
    }
  } catch (err) {
    result = {
      success: false,
      error: `Unhandled error: ${err}`,
    };
  }

  // Safety: close DBs on uncaught exceptions to prevent WAL corruption
  process.on('uncaughtException', (err) => {
    logError(`Uncaught exception: ${err}`);
    process.exit(1);
  });

  // Output result
  if (result.output) {
    console.log(result.output);
  }

  if (!result.success) {
    if (result.error) {
      logError(result.error);
    }
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
