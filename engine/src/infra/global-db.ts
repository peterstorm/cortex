/**
 * The global database, shared by every harness, and the one-time merge of the
 * per-harness databases it replaces.
 *
 * Claude Code used to keep global memories in ~/.claude/memory and pi in
 * ~/.pi/agent/memory, so neither saw what the other learned. The first
 * process to run with the unified path merges both into it, keeps the old
 * files beside themselves as `*.merged-<timestamp>`, and every later process
 * finds the target present and does nothing.
 *
 * Imperative shell — every function here does I/O.
 */

import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { match } from 'ts-pattern';
import {
  detectHarness,
  getGlobalDbPath,
  getLegacyGlobalDbPaths,
  type Env,
  type LegacyGlobalDb,
} from '../config.js';
import { openDatabase, openDatabaseReadOnly } from './db.js';
import { acquireLock, releaseLock } from './lock.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Tables copied by the merge, parents before children so foreign keys hold:
 * facts need their entity and source memory, edges their two memories.
 * The FTS tables are not listed — the triggers on memories and entities
 * fill them as rows arrive.
 */
export const MERGED_TABLES = [
  'memories',
  'entities',
  'facts',
  'edges',
  'extraction_checkpoints',
] as const;

export type MergedTable = (typeof MERGED_TABLES)[number];

/** Rows per table. */
export type TableCounts = Readonly<Record<MergedTable, number>>;

export type LegacyMerge = Readonly<{
  source: LegacyGlobalDb;
  /** Rows copied into the shared database. */
  copied: TableCounts;
  /** Rows not copied because an earlier source already held the same key. */
  duplicates: TableCounts;
  /** Where the legacy file was moved after the merge. */
  keptAs: string;
}>;

export type GlobalDbMigration =
  /** The shared database already exists: nothing to do. */
  | Readonly<{ kind: 'current' }>
  /** No legacy database exists: the shared one is created on first open as usual. */
  | Readonly<{ kind: 'fresh' }>
  | Readonly<{ kind: 'merged'; sources: readonly LegacyMerge[] }>
  /** Another process held the merge lock past the wait and has not finished. */
  | Readonly<{ kind: 'busy' }>
  | Readonly<{ kind: 'failed'; error: string }>;

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
 * Merge the legacy per-harness databases into `target`, once.
 *
 * Idempotent: a present target is never touched. The merge is built in a
 * staging file and renamed into place, so a crash leaves either no target
 * (the next run retries) or a complete one — never a half-merged database
 * that would read as `current` forever.
 */
export function migrateGlobalDb(options: MigrateOptions): GlobalDbMigration {
  const { target } = options;
  if (existsSync(target)) return { kind: 'current' };

  const sources = options.legacy.filter((source) => existsSync(source.path));
  if (sources.length === 0) return { kind: 'fresh' };

  try {
    mkdirSync(dirname(target), { recursive: true });
  } catch (error) {
    return { kind: 'failed', error: `cannot create ${dirname(target)}: ${message(error)}` };
  }

  const lockFile = `${target}.lock`;
  const lock = acquireLock(lockFile);
  if (!lock.acquired) {
    return lock.reason === 'held'
      ? awaitOtherMerge(target, options.waitMs ?? DEFAULT_WAIT_MS)
      : { kind: 'failed', error: `cannot take the merge lock ${lockFile}` };
  }

  try {
    // Re-check under the lock: another process may have finished between the
    // first check and our acquiring the lock.
    if (existsSync(target)) return { kind: 'current' };
    return mergeInto(target, sources, options.now);
  } finally {
    releaseLock(lockFile);
  }
}

function awaitOtherMerge(target: string, waitMs: number): GlobalDbMigration {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (existsSync(target)) return { kind: 'current' };
    Bun.sleepSync(POLL_MS);
  }
  return existsSync(target) ? { kind: 'current' } : { kind: 'busy' };
}

function mergeInto(
  target: string,
  sources: readonly LegacyGlobalDb[],
  now: Date,
): GlobalDbMigration {
  const staging = `${target}.merging-${process.pid}`;
  removeDbFiles(staging);

  try {
    const db = openDatabase(staging);
    let merged: readonly Omit<LegacyMerge, 'keptAs'>[];
    try {
      merged = sources.map((source, index) =>
        mergeSource(db, source, `${staging}.source-${index}`),
      );
      // Leave WAL mode, which folds the WAL into the main file and deletes it,
      // so the rename below moves a complete database. A checkpoint alone is
      // not enough: Bun closes lazily while prepared statements live, which
      // left the -wal/-shm files beside the staging name.
      db.run('PRAGMA journal_mode = DELETE');
    } finally {
      db.close();
    }
    renameSync(staging, target);
    removeDbFiles(staging);

    const suffix = `merged-${now.toISOString().replace(/[:.]/g, '-')}`;
    return {
      kind: 'merged',
      sources: merged.map((m) => ({ ...m, keptAs: keepLegacy(m.source.path, suffix) })),
    };
  } catch (error) {
    removeDbFiles(staging);
    return { kind: 'failed', error: message(error) };
  }
}

/**
 * Copy one legacy database into `db`.
 *
 * The source is first copied with VACUUM INTO from a read-only connection:
 * that captures rows still sitting in its WAL, never blocks a live writer,
 * and leaves the original untouched until the whole merge has succeeded.
 */
function mergeSource(
  db: Database,
  source: LegacyGlobalDb,
  snapshotPath: string,
): Omit<LegacyMerge, 'keptAs'> {
  removeDbFiles(snapshotPath);
  const reader = openDatabaseReadOnly(source.path);
  try {
    reader.prepare('VACUUM INTO ?').run(snapshotPath);
  } finally {
    reader.close();
  }

  db.run('ATTACH DATABASE ? AS legacy', [snapshotPath]);
  try {
    const counts: readonly CopyCount[] = db.transaction(() =>
      MERGED_TABLES.map((table) => copyTable(db, table)),
    )();
    return {
      source,
      copied: countsOf(counts.map((c) => c.copied)),
      duplicates: countsOf(counts.map((c) => c.selected - c.copied)),
    };
  } finally {
    db.run('DETACH DATABASE legacy');
    removeDbFiles(snapshotPath);
  }
}

type CopyCount = Readonly<{ selected: number; copied: number }>;

function copyTable(db: Database, table: MergedTable): CopyCount {
  const legacyColumns = columnsOf(db, 'legacy', table);
  // An older database may predate a table (entities, facts) entirely.
  if (legacyColumns.length === 0) return { selected: 0, copied: 0 };

  const columns = sharedColumns(columnsOf(db, 'main', table), legacyColumns);
  const before = rowCount(db, 'main', table);
  db.run(copyStatement(table, columns));
  // Counted from the table, not the statement's `changes`: that also counts
  // the FTS5 shadow-table writes the insert triggers make.
  return { selected: rowCount(db, 'legacy', table), copied: rowCount(db, 'main', table) - before };
}

function rowCount(db: Database, schema: 'main' | 'legacy', table: MergedTable): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${schema}.${table}`).get() as { n: number }).n;
}

function columnsOf(db: Database, schema: 'main' | 'legacy', table: MergedTable): readonly string[] {
  return (db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[]).map(
    (column) => column.name,
  );
}

// ============================================================================
// PURE HELPERS
// ============================================================================

/**
 * The columns both schemas have, in the target's order. A legacy database
 * from before a migration lacks the newer columns; those take their defaults.
 */
export function sharedColumns(
  target: readonly string[],
  legacy: readonly string[],
): readonly string[] {
  const present = new Set(legacy);
  return target.filter((column) => present.has(column));
}

/**
 * The INSERT that copies one table from `legacy` into `main`.
 *
 * OR IGNORE keeps the row already present on a key clash: the same memory id
 * in both sources, or an entity with the same name and type. A fact whose
 * entity clashed is repointed to the entity that was kept, matched the way
 * the unique index matches (case-insensitive name, same type); with no clash
 * that lookup finds the fact's own entity.
 */
export function copyStatement(table: MergedTable, columns: readonly string[]): string {
  const list = columns.join(', ');
  const values = columns
    .map((column) =>
      table === 'facts' && column === 'entity_id'
        ? `(SELECT kept.id FROM main.entities kept JOIN legacy.entities own
             ON LOWER(kept.name) = LOWER(own.name) AND kept.entity_type = own.entity_type
           WHERE own.id = src.entity_id)`
        : `src.${column}`,
    )
    .join(', ');
  return `INSERT OR IGNORE INTO main.${table} (${list}) SELECT ${values} FROM legacy.${table} AS src`;
}

function countsOf(values: readonly number[]): TableCounts {
  return Object.fromEntries(MERGED_TABLES.map((table, i) => [table, values[i]])) as TableCounts;
}

/** The outcomes worth a log line: something was merged, or could not be. */
export type ReportableMigration = Exclude<GlobalDbMigration, { kind: 'current' } | { kind: 'fresh' }>;

/** One line per source, for the log. */
export function describeMigration(migration: ReportableMigration, target: string): string {
  return match(migration)
    .with({ kind: 'busy' }, () => `another process is still merging the global memory databases into ${target}`)
    .with({ kind: 'failed' }, ({ error }) => `merging the global memory databases into ${target} failed: ${error}`)
    .with({ kind: 'merged' }, ({ sources }) =>
      [
        `merged ${sources.length} global memory database(s) into ${target}:`,
        ...sources.map(
          ({ source, copied, duplicates, keptAs }) =>
            `  ${source.harness}: ${
              MERGED_TABLES.filter((t) => copied[t] + duplicates[t] > 0)
                .map((t) => `${t} +${copied[t]}${duplicates[t] ? ` (${duplicates[t]} already present)` : ''}`)
                .join(', ') || 'empty'
            }; original kept at ${keptAs}`,
        ),
      ].join('\n'),
    )
    .exhaustive();
}

// ============================================================================
// FILES
// ============================================================================

const DB_FILE_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const;

function removeDbFiles(path: string): void {
  for (const suffix of DB_FILE_SUFFIXES) rmSync(`${path}${suffix}`, { force: true });
}

/** Move a merged legacy database (and its WAL files) aside; it is kept, never deleted. */
function keepLegacy(path: string, suffix: string): string {
  const keptAs = `${path}.${suffix}`;
  for (const fileSuffix of DB_FILE_SUFFIXES) {
    if (existsSync(`${path}${fileSuffix}`)) renameSync(`${path}${fileSuffix}`, `${keptAs}${fileSuffix}`);
  }
  return keptAs;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ============================================================================
// RESOLUTION
// ============================================================================

export type ResolveOptions = Readonly<{
  env?: Env;
  home?: string;
  now?: Date;
  harness?: 'claude' | 'pi';
  log?: (line: string) => void;
}>;

/**
 * The global database path every command should open, merging the legacy
 * per-harness databases first if that has not happened yet.
 *
 * If the merge cannot run, this returns the current harness's legacy path
 * instead of the shared one: opening the shared path would create it empty,
 * and a present target reads as already merged — the legacy memories would
 * never be merged at all. Falling back keeps them in use and retries the
 * merge on the next run.
 */
export function resolveGlobalDbPath(options: ResolveOptions = {}): string {
  const target = getGlobalDbPath(options.env, options.home);
  const legacy = getLegacyGlobalDbPaths(options.home);
  const log = options.log ?? ((line: string) => process.stderr.write(`[cortex] ${line}\n`));

  const migration = migrateGlobalDb({ target, legacy, now: options.now ?? new Date() });

  return match(migration)
    .with({ kind: 'current' }, { kind: 'fresh' }, () => target)
    .with({ kind: 'merged' }, (merged) => {
      log(`INFO: ${describeMigration(merged, target)}`);
      return target;
    })
    .with({ kind: 'busy' }, { kind: 'failed' }, (unmerged) => {
      const harness = options.harness ?? detectHarness();
      const fallback = legacy.find((source) => source.harness === harness)?.path ?? target;
      log(`WARN: ${describeMigration(unmerged, target)}; using ${fallback} for now`);
      return fallback;
    })
    .exhaustive();
}
