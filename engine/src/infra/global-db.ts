/**
 * The global database, shared by every harness, and the merge of the
 * per-harness databases it replaces.
 *
 * Claude Code used to keep global memories in ~/.claude/memory and pi in
 * ~/.pi/agent/memory, so neither saw what the other learned. Any process
 * resolving the shared path merges whichever of those still sits at its old
 * path into the shared database, then moves it aside as `*.merged-<time>`.
 *
 * "Still at its old path" is the whole idempotency rule. It does not matter
 * whether the shared database already exists: one created empty (by a test,
 * or an aborted run) cannot hide unmerged memories, and a harness still on an
 * older plugin version that recreates its old file has those memories merged
 * on the next run instead of stranded.
 *
 * Imperative shell — every function here does I/O.
 */

import { existsSync } from 'node:fs';
import { match } from 'ts-pattern';
import {
  currentEnv,
  detectHarness,
  getLegacyGlobalDbPaths,
  homeDir,
  locateGlobalDb,
  type Env,
  type LegacyGlobalDb,
} from '../config.js';
import {
  describeFileMigration,
  migrateFiles,
  type FileMerge,
  type FileMigration,
  type ReportableMigration,
} from './db-merge.js';

// ============================================================================
// TYPES
// ============================================================================

export type LegacyMerge = FileMerge<LegacyGlobalDb>;

/** `current` means no legacy database is left at its old path. */
export type GlobalDbMigration = FileMigration<LegacyGlobalDb>;

export type MigrateOptions = Readonly<{
  target: string;
  legacy: readonly LegacyGlobalDb[];
  now: Date;
  /** How long to wait for another process's merge before reporting busy. */
  waitMs?: number;
}>;

/** A merge of a few thousand rows takes milliseconds; this only covers a stuck one. */
const DEFAULT_WAIT_MS = 10_000;

// ============================================================================
// MERGE
// ============================================================================

/**
 * Merge every legacy database still at its old path into `target`, creating
 * `target` if needed, Claude Code's first. See migrateFiles for the rules.
 */
export function migrateGlobalDb(options: MigrateOptions): GlobalDbMigration {
  return migrateFiles({
    target: options.target,
    sources: options.legacy,
    pathOf: (source) => source.path,
    lockFile: `${options.target}.lock`,
    now: options.now,
    waitMs: options.waitMs ?? DEFAULT_WAIT_MS,
  });
}

// ============================================================================
// REPORTING
// ============================================================================

/** One line per source, for the log. */
export function describeMigration(migration: ReportableMigration<LegacyGlobalDb>, target: string): string {
  return describeFileMigration(migration, 'global memory', target, (source) => source.harness);
}

// ============================================================================
// RESOLUTION
// ============================================================================

export type ResolveOptions = Readonly<{
  env?: Env;
  home?: string;
  now?: Date;
  harness?: 'claude' | 'pi';
  waitMs?: number;
  log?: (line: string) => void;
}>;

/**
 * The global database path every command should open, merging the legacy
 * per-harness databases into it first.
 *
 * `CORTEX_GLOBAL_DB` names a database to use as it is: nothing is merged into
 * it, and the legacy files are never read or moved.
 *
 * If the merge cannot finish, this returns the current harness's legacy path
 * while that file is still unmerged, so the harness keeps its own memories in
 * view until the retry; once it has been merged, the shared path holds them.
 */
export function resolveGlobalDbPath(options: ResolveOptions = {}): string {
  const env = options.env ?? currentEnv();
  const home = options.home ?? homeDir(env);
  const location = locateGlobalDb(env, home);
  if (location.kind === 'override') return location.path;

  const target = location.path;
  const legacy = getLegacyGlobalDbPaths(home);
  const log = options.log ?? ((line: string) => process.stderr.write(`[cortex] ${line}\n`));
  const migration = migrateGlobalDb({ target, legacy, now: options.now ?? new Date(), waitMs: options.waitMs });

  return match(migration)
    .with({ kind: 'current' }, () => target)
    .with({ kind: 'merged' }, (merged) => {
      log(`INFO: ${describeMigration(merged, target)}`);
      return target;
    })
    .with({ kind: 'busy' }, { kind: 'failed' }, (unmerged) => {
      const harness = options.harness ?? detectHarness();
      const own = legacy.find((source) => source.harness === harness)?.path;
      const fallback = own !== undefined && existsSync(own) ? own : target;
      log(`WARN: ${describeMigration(unmerged, target)}; using ${fallback} for now`);
      return fallback;
    })
    .exhaustive();
}
