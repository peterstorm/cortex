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

import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
import { openDatabase } from './db.js';
import {
  describeCounts,
  keepAside,
  mergeDatabaseInto,
  mergedSuffix,
  type SourceCounts,
} from './db-merge.js';
import { acquireLock, releaseLock } from './lock.js';

// ============================================================================
// TYPES
// ============================================================================

export type LegacyMerge = Readonly<{
  source: LegacyGlobalDb;
  /** Where the legacy file was moved after its rows were committed. */
  keptAs: string;
}> &
  SourceCounts;

export type GlobalDbMigration =
  /** No legacy database is left at its old path: nothing to do. */
  | Readonly<{ kind: 'current' }>
  | Readonly<{ kind: 'merged'; sources: readonly LegacyMerge[] }>
  /** Another process held the merge lock past the wait. */
  | Readonly<{ kind: 'busy' }>
  /**
   * A source could not be merged. Sources are merged in precedence order and
   * the merge stops at the first failure, so `merged` are the ones before it.
   */
  | Readonly<{ kind: 'failed'; error: string; merged: readonly LegacyMerge[] }>;

export type MigrateOptions = Readonly<{
  target: string;
  legacy: readonly LegacyGlobalDb[];
  now: Date;
  /** How long to wait for another process's merge before reporting busy. */
  waitMs?: number;
}>;

/** A merge of a few thousand rows takes milliseconds; this only covers a stuck one. */
const DEFAULT_WAIT_MS = 10_000;
const POLL_MS = 100;

// ============================================================================
// MERGE
// ============================================================================

/**
 * Merge every legacy database still at its old path into `target`, creating
 * `target` if needed. Each source is copied in its own transaction and moved
 * aside only after it commits, so a crash leaves it in place for the retry,
 * which skips the rows already copied.
 */
export function migrateGlobalDb(options: MigrateOptions): GlobalDbMigration {
  const { target } = options;
  const pending = () => options.legacy.filter((source) => existsSync(source.path));
  if (pending().length === 0) return { kind: 'current' };

  try {
    mkdirSync(dirname(target), { recursive: true });
  } catch (error) {
    return { kind: 'failed', error: `cannot create ${dirname(target)}: ${message(error)}`, merged: [] };
  }

  const lockFile = `${target}.lock`;
  const lock = acquireWithin(lockFile, options.waitMs ?? DEFAULT_WAIT_MS);
  if (lock !== 'acquired') {
    return lock === 'held'
      ? { kind: 'busy' }
      : { kind: 'failed', error: `cannot take the merge lock ${lockFile}`, merged: [] };
  }

  try {
    // Re-read under the lock: the process we waited for may have merged them.
    const sources = pending();
    return sources.length === 0 ? { kind: 'current' } : mergeInto(target, sources, options.now);
  } finally {
    releaseLock(lockFile);
  }
}

function acquireWithin(lockFile: string, waitMs: number): 'acquired' | 'held' | 'io-error' {
  const deadline = Date.now() + waitMs;
  for (;;) {
    const lock = acquireLock(lockFile);
    if (lock.acquired) return 'acquired';
    if (lock.reason === 'io-error') return 'io-error';
    if (Date.now() >= deadline) return 'held';
    Bun.sleepSync(POLL_MS);
  }
}

function mergeInto(target: string, sources: readonly LegacyGlobalDb[], now: Date): GlobalDbMigration {
  const merged: LegacyMerge[] = [];
  let db;
  try {
    db = openDatabase(target);
  } catch (error) {
    return { kind: 'failed', error: `cannot open ${target}: ${message(error)}`, merged };
  }

  try {
    for (const [index, source] of sources.entries()) {
      try {
        const counts = mergeDatabaseInto(db, source.path, `${target}.source-${process.pid}-${index}`);
        merged.push({ source, ...counts, keptAs: keepAside(source.path, mergedSuffix(now)) });
      } catch (error) {
        // Stop here: a later source merged now would win clashes that belong
        // to this one when it is retried.
        return { kind: 'failed', error: `${source.path}: ${message(error)}`, merged };
      }
    }
    return { kind: 'merged', sources: merged };
  } finally {
    db.close();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ============================================================================
// REPORTING
// ============================================================================

/** The outcomes worth a log line: something was merged, or could not be. */
export type ReportableMigration = Exclude<GlobalDbMigration, { kind: 'current' }>;

const describeSources = (sources: readonly LegacyMerge[]): readonly string[] =>
  sources.map(
    (merge) => `  ${merge.source.harness}: ${describeCounts(merge)}; original kept at ${merge.keptAs}`,
  );

/** One line per source, for the log. */
export function describeMigration(migration: ReportableMigration, target: string): string {
  return match(migration)
    .with({ kind: 'busy' }, () => `another process is still merging the global memory databases into ${target}`)
    .with({ kind: 'failed' }, ({ error, merged }) =>
      [
        `merging the global memory databases into ${target} failed: ${error}`,
        ...(merged.length > 0 ? ['merged before the failure:', ...describeSources(merged)] : []),
      ].join('\n'),
    )
    .with({ kind: 'merged' }, ({ sources }) =>
      [`merged ${sources.length} global memory database(s) into ${target}:`, ...describeSources(sources)].join('\n'),
    )
    .exhaustive();
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
