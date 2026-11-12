/**
 * The project session: find the project a cwd belongs to, open its database
 * and the global one, run one command against them, and always close both.
 *
 * Every CLI command that writes memory used to carry its own copy of this:
 * locate, open both databases, try, catch into "X failed", finally close
 * both. The close discipline was enforced only by copy-paste — a handler that
 * forgot its `finally` leaked a connection — and a change to how a project is
 * opened (a merge step, a gitignore pattern, a directory mode) had to land in
 * every copy. It lands here now.
 *
 * Two ways in:
 * - withProjectSession — the common command: a cwd and a label in, a
 *   CommandResult out. A throw from the command becomes `<label> failed: …`.
 * - usingProjectSession — for a command that has located the project itself
 *   and keeps its own failure policy (a retryable failure, a lock taken
 *   between locating and opening, a check that decides whether to open at
 *   all). It closes both databases and catches nothing.
 *
 * Opening is deliberately outside the labelled catch in both: a project that
 * cannot be opened is not "Generate failed", it is the CLI's unhandled error.
 *
 * Imperative shell — every function here does I/O.
 */

import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { match } from 'ts-pattern';
import type { CommandResult } from './command-result.js';
import { getProjectDbPath, GITIGNORE_PATTERNS } from './config.js';
import type { ProjectLocation } from './core/project-location.js';
import { openDatabase } from './infra/db.js';
import { ensureGitignored } from './infra/filesystem.js';
import { resolveGlobalDbPath } from './infra/global-db.js';
import { describeProjectMigration, migrateProjectDb, resolveProjectLocation } from './infra/project-db.js';

// ============================================================================
// TYPES
// ============================================================================

/** A located project with both of its databases open. Valid only inside the command it is handed to. */
export type ProjectSession = Readonly<{
  project: ProjectLocation;
  projectDb: Database;
  globalDb: Database;
}>;

/** One command run against an open project session. */
type ProjectCommand = (session: ProjectSession) => CommandResult | Promise<CommandResult>;

// ============================================================================
// SESSIONS
// ============================================================================

/**
 * Locate the project `cwd` belongs to, open both databases, run `command`,
 * and close both whatever it did.
 *
 * A throw (or rejection) from `command` becomes
 * `{ kind: 'failed', error: '<label> failed: <error>' }`; a result it returns,
 * failure or not, passes through untouched. An invalid cwd exits 1 (see
 * locate), and a failure to open propagates.
 */
export async function withProjectSession(
  cwd: string,
  label: string,
  command: ProjectCommand,
): Promise<CommandResult> {
  return usingProjectSession(locate(cwd), async (session) => {
    try {
      return await command(session);
    } catch (err) {
      return { kind: 'failed', error: `${label} failed: ${err}` };
    }
  });
}

/**
 * Open both databases of an already-located project, run `command`, and
 * close both whatever it did. Nothing is caught: a throw from opening or from
 * `command` propagates, for a caller with a failure policy of its own.
 *
 * Opening merges the project's stray databases into its own, creates and
 * gitignores its `.memory/`, and merges the per-harness global databases into
 * the global one first if that has not happened yet.
 */
export async function usingProjectSession(
  project: ProjectLocation,
  command: ProjectCommand,
): Promise<CommandResult> {
  const projectDbPath = prepareProjectDbDir(project);
  const globalDbPath = resolveGlobalDbPath();
  ensureDbDir(globalDbPath);

  const projectDb = openDatabase(projectDbPath);
  const globalDb = openDatabase(globalDbPath);

  try {
    return await command({ project, projectDb, globalDb });
  } finally {
    projectDb.close();
    globalDb.close();
  }
}

// ============================================================================
// LOCATING A PROJECT
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

/**
 * Find the project `cwd` belongs to (see core/project-location.ts).
 *
 * Validates cwd first (single choke point) — exits 1 with a usage error on
 * an invalid cwd so no phantom directories are ever created.
 */
export function locate(cwd: string): ProjectLocation {
  const cwdError = validateCwd(cwd);
  if (cwdError !== null) {
    logError(cwdError);
    process.exit(1);
  }
  return resolveProjectLocation(cwd);
}

// ============================================================================
// PREPARING A PROJECT'S DATABASE
// ============================================================================

/**
 * Merge the project's stray databases (its worktrees', and the session's
 * subdirectories') into its own, and say what moved. One that cannot be
 * merged now stays where it is and is retried next time.
 */
export function mergeStrayProjectDbs(project: ProjectLocation): void {
  const migration = migrateProjectDb(project, new Date());
  match(migration)
    .with({ kind: 'current' }, () => {})
    .with({ kind: 'merged' }, (merged) => logError(`INFO: ${describeProjectMigration(merged, project)}`))
    .with({ kind: 'busy' }, { kind: 'failed' }, (unmerged) =>
      logError(`WARN: ${describeProjectMigration(unmerged, project)}; retrying next time`),
    )
    .exhaustive();
}

/**
 * Make a project's `.memory/` usable: stray databases merged, directory
 * present, patterns gitignored.
 *
 * Shared by the project session, which also wants the global database, and
 * the CLI's consolidate command, which is project-scoped and used to carry its
 * own copy of these steps. A change to how a project root is prepared (a
 * permission mode, another gitignore pattern) lands in one place.
 *
 * Both the root and the session's own directory are gitignored: the memory
 * lives at the root, the surface file in the session's directory.
 *
 * @returns The project database path.
 */
export function prepareProjectDbDir(project: ProjectLocation): string {
  mergeStrayProjectDbs(project);
  const projectDbPath = getProjectDbPath(project.root);
  ensureDbDir(projectDbPath);

  for (const dir of new Set([project.root, project.cwd])) {
    try {
      ensureGitignored(dir, GITIGNORE_PATTERNS);
    } catch (err) {
      logError(`Failed to update .gitignore: ${err}`);
    }
  }

  return projectDbPath;
}

/** Create a database file's parent directory if it is not already there. */
function ensureDbDir(dbPath: string): void {
  const dbDir = dirname(dbPath);
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }
}

/** Log to stderr with the CLI's prefix — the same line cli.ts writes. */
function logError(message: string): void {
  console.error(`[cortex] ${message}`);
}
