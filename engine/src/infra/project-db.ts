/**
 * The project database: finding it, and merging the stray ones into it.
 *
 * cortex used to key a project's memory on the directory a session started
 * in, so each worktree of a repository, and each subdirectory a session was
 * ever started from, grew a database of its own. A project is now its
 * repository (see core/project-location.ts), and every command that opens
 * the project database for writing first merges the stray databases it can
 * see into the repository's: the session's own subdirectories and the
 * repository's other worktrees. The per-prompt recall hook is the exception:
 * it only reads, must stay fast, and leaves strays for the next such command.
 *
 * Imperative shell — every function here does I/O.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { getLockDir, getProjectDbPath } from '../config.js';
import {
  locateProject,
  markerCandidates,
  parseWorktreeList,
  type ProjectLocation,
  type RepositoryProbe,
} from '../core/project-location.js';
import {
  describeFileMigration,
  migrateFiles,
  type FileMigration,
  type ReportableMigration,
} from './db-merge.js';

/** A directory holding this file keeps its own project memory. */
export const STANDALONE_MARKER = join('.memory', 'standalone');

// ============================================================================
// LOCATION
// ============================================================================

/** Why git gave no worktree list. */
export type ProbeFailure =
  /** The expected cases: `cwd` is in no repository, or git is not installed. */
  | Readonly<{ kind: 'no-repository' }>
  /** Git was there and could not answer: a timeout, a refused repository. */
  | Readonly<{ kind: 'unanswered'; reason: string }>;

/**
 * Classify a failed `git worktree list`. Pure.
 *
 * Only "not a git repository" and a missing git binary mean there is no
 * repository. Anything else — a timeout on a loaded machine, "dubious
 * ownership" — happened inside what may well be a repository, and must not
 * pass for the same thing.
 */
export function classifyProbeFailure(error: unknown): ProbeFailure {
  const failure = (typeof error === 'object' && error !== null ? error : {}) as Readonly<{
    code?: unknown;
    signal?: unknown;
    stderr?: unknown;
    message?: unknown;
  }>;
  const stderr = typeof failure.stderr === 'string' ? failure.stderr.trim() : '';
  if (failure.code === 'ENOENT' || /not a git repository/i.test(stderr)) return { kind: 'no-repository' };
  const reason =
    failure.code === 'ETIMEDOUT' || failure.signal === 'SIGTERM'
      ? `git did not answer within ${PROBE_TIMEOUT_MS} ms`
      : stderr || describeThrown(failure.message ?? error);
  return { kind: 'unanswered', reason };
}

/** Total: this runs inside a catch, where `String(thrown)` can itself throw. */
const describeThrown = (thrown: unknown): string =>
  typeof thrown === 'string' && thrown !== '' ? thrown : 'git failed without saying why';

const PROBE_TIMEOUT_MS = 5_000;

const warnToStderr = (message: string): void => {
  process.stderr.write(`[cortex] WARN: ${message}\n`);
};

/**
 * Ask git for the worktrees of the repository `cwd` is in. No repository (or
 * no git) keeps the pre-repository behaviour: the directory is the project.
 *
 * When git is there but cannot answer, the directory is still used — a hook
 * must not fail the session — but that is said out loud: memory written now
 * lands in this directory's own database, apart from the repository's, until
 * a later command merges it back.
 */
export function probeRepository(cwd: string, warn: (message: string) => void = warnToStderr): RepositoryProbe {
  try {
    const porcelain = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: PROBE_TIMEOUT_MS,
      env: withoutGitOverrides(process.env),
    });
    return parseWorktreeList(porcelain);
  } catch (error) {
    const failure = classifyProbeFailure(error);
    if (failure.kind === 'unanswered') {
      warn(
        `git could not say which repository ${cwd} belongs to (${failure.reason}); ` +
          'treating the directory as its own project, so its memory is kept apart from ' +
          "the repository's until a later command merges it",
      );
    }
    return { kind: 'not-a-repository' };
  }
}

/**
 * A git hook (or a parent git command) exports GIT_DIR and friends, which
 * would make git describe that repository instead of the one `cwd` is in.
 */
function withoutGitOverrides(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const overrides = new Set(['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE']);
  return {
    ...Object.fromEntries(Object.entries(env).filter(([key]) => !overrides.has(key))),
    // classifyProbeFailure reads git's message, so it must not be translated.
    LC_ALL: 'C',
  };
}

/** Where `cwd`'s project memory lives. `cwd` must be an existing directory. */
export function resolveProjectLocation(
  cwd: string,
  warn: (message: string) => void = warnToStderr,
): ProjectLocation {
  const probe = probeRepository(cwd, warn);
  // git reports real paths; compare like with like.
  const here = probe.kind === 'repository' ? realpathSync(cwd) : cwd;
  const standalone = new Set(
    markerCandidates(here, probe).filter((dir) => existsSync(join(dir, STANDALONE_MARKER))),
  );
  return locateProject(here, probe, standalone);
}

/** Whether the project has any memory yet: its own database, or a stray one waiting to merge. */
export function hasProjectMemory(location: ProjectLocation): boolean {
  return [location.root, ...location.strays].some((dir) => existsSync(getProjectDbPath(dir)));
}

// ============================================================================
// MERGE
// ============================================================================

/** Sources are directories; their database is `<dir>/.memory/cortex.db`. */
export type ProjectDbMigration = FileMigration<string>;

/** Brief: another session in the same project is merging the same files. */
const DEFAULT_WAIT_MS = 2_000;

/**
 * Merge every stray project database into the root's, then move each aside
 * as `cortex.db.merged-<time>`. On a clash the root's row is kept, then the
 * session's own directories' (nearest first), then other worktrees'. See
 * migrateFiles for the rules.
 */
export function migrateProjectDb(
  location: ProjectLocation,
  now: Date,
  waitMs: number = DEFAULT_WAIT_MS,
): ProjectDbMigration {
  return migrateFiles({
    target: getProjectDbPath(location.root),
    sources: location.strays,
    pathOf: getProjectDbPath,
    lockFile: join(getLockDir(location.root), 'merge.lock'),
    now,
    waitMs,
  });
}

/** One line per stray database, for the log. */
export function describeProjectMigration(
  migration: ReportableMigration<string>,
  location: ProjectLocation,
): string {
  const target = `project "${location.name}" (${getProjectDbPath(location.root)})`;
  return describeFileMigration(migration, 'stray memory', target, (dir) => dir);
}
