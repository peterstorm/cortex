/**
 * Merging one cortex database into another.
 *
 * Shared by every migration that consolidates memory files: the per-harness
 * global databases into the shared one, and stray per-directory project
 * databases into their repository's. The target may be live — other
 * processes may have it open — so each source is copied in a single
 * transaction and only moved aside after that transaction commits. A crash
 * leaves the source in place, and the retry is harmless: rows already copied
 * are skipped by key.
 *
 * Imperative shell — every exported function except the pure helpers does I/O.
 */

import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { match } from 'ts-pattern';
import { openDatabase, openDatabaseReadOnly } from './db.js';
import { acquireLockWithin, releaseLock } from './lock.js';

// ============================================================================
// TYPES
// ============================================================================

/**
 * Tables copied by a merge, parents before children so foreign keys hold:
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

export type SourceCounts = Readonly<{
  /** Rows copied into the target. */
  copied: TableCounts;
  /** Rows not copied because the target already held the same key. */
  duplicates: TableCounts;
}>;

/** One source merged into the target. `S` is however the caller names a source. */
export type FileMerge<S = string> = SourceCounts &
  Readonly<{
    source: S;
    /** Where the source was moved after its rows were committed. */
    keptAs: string;
  }>;

export type FileMigration<S = string> =
  /** None of the sources exists: nothing to do. */
  | Readonly<{ kind: 'current' }>
  | Readonly<{ kind: 'merged'; merged: readonly FileMerge<S>[] }>
  /** Another process held the merge lock past the wait. */
  | Readonly<{ kind: 'busy' }>
  /** A source could not be merged; the merge stopped there, after `merged`. */
  | Readonly<{ kind: 'failed'; error: string; merged: readonly FileMerge<S>[] }>;

export type MigrateFilesOptions<S> = Readonly<{
  target: string;
  /** Candidate sources, in precedence order: on a key clash the earlier row is kept. */
  sources: readonly S[];
  pathOf: (source: S) => string;
  lockFile: string;
  now: Date;
  waitMs: number;
}>;

// ============================================================================
// MIGRATION
// ============================================================================

/**
 * Merge every source that exists into `target`, creating it if needed, then
 * move each aside. A source at its path is unmerged; once moved aside it is
 * never read again — that is the whole idempotency rule.
 *
 * Runs under `lockFile`, waiting up to `waitMs` for another process's merge.
 * Each source is one transaction, moved aside only after it commits, so a
 * crash leaves it in place and the retry skips what was already copied.
 * Sources merge in order and the merge stops at the first failure, so a
 * later source never takes clashes that belong to an earlier one.
 */
export function migrateFiles<S>(options: MigrateFilesOptions<S>): FileMigration<S> {
  const { target, lockFile, pathOf } = options;
  const pending = () => options.sources.filter((source) => existsSync(pathOf(source)));
  if (pending().length === 0) return { kind: 'current' };

  try {
    mkdirSync(dirname(target), { recursive: true });
  } catch (error) {
    return { kind: 'failed', error: `cannot create ${dirname(target)}: ${message(error)}`, merged: [] };
  }

  const lock = acquireLockWithin(lockFile, options.waitMs);
  if (!lock.acquired) {
    return lock.reason === 'held'
      ? { kind: 'busy' }
      : { kind: 'failed', error: `cannot take the merge lock ${lockFile}`, merged: [] };
  }

  try {
    // Re-read under the lock: the process we waited for may have merged them.
    const sources = pending();
    return sources.length === 0 ? { kind: 'current' } : mergeEach(target, sources, pathOf, options.now);
  } finally {
    releaseLock(lockFile);
  }
}

function mergeEach<S>(
  target: string,
  sources: readonly S[],
  pathOf: (source: S) => string,
  now: Date,
): FileMigration<S> {
  const merged: FileMerge<S>[] = [];
  let db;
  try {
    db = openDatabase(target);
  } catch (error) {
    return { kind: 'failed', error: `cannot open ${target}: ${message(error)}`, merged };
  }

  try {
    for (const [index, source] of sources.entries()) {
      try {
        const path = pathOf(source);
        const counts = mergeDatabaseInto(db, path, `${target}.source-${process.pid}-${index}`);
        merged.push({ source, ...counts, keptAs: keepAside(path, mergedSuffix(now)) });
      } catch (error) {
        return { kind: 'failed', error: `${pathOf(source)}: ${message(error)}`, merged };
      }
    }
    return { kind: 'merged', merged };
  } finally {
    db.close();
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ============================================================================
// MERGE
// ============================================================================

/**
 * Copy every row of the database at `sourcePath` that `db` does not already
 * hold, in one transaction. On a key clash the row already in `db` is kept.
 *
 * The source is first copied with VACUUM INTO from a read-only connection to
 * `snapshotPath`: that captures rows still sitting in its WAL and never
 * blocks a live writer. The source itself is not touched; moving it aside is
 * the caller's step, after this returns.
 *
 * @throws when the source cannot be read or the copy fails; nothing is committed then
 */
export function mergeDatabaseInto(db: Database, sourcePath: string, snapshotPath: string): SourceCounts {
  removeDbFiles(snapshotPath);
  const reader = openDatabaseReadOnly(sourcePath);
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
 * The columns both schemas have, in the target's order. A source from before
 * a migration lacks the newer columns; those take their defaults.
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
 * ON CONFLICT DO NOTHING keeps the row already present on a key clash: the
 * same memory id in both, or an entity with the same name and type. It skips
 * key clashes and nothing else. A row the target refuses for any other reason
 * (a NULL where it needs a value, a failed CHECK) raises, which rolls the
 * source's transaction back and leaves the source in place: OR IGNORE would
 * have dropped that row, counted it as "already present", and let the source
 * be moved aside as merged.
 *
 * A fact whose entity clashed is repointed to the entity that was kept,
 * matched the way the unique index matches (case-insensitive name, same
 * type); with no clash that lookup finds the fact's own entity.
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
  // `WHERE true` is SQLite's required disambiguation between a join's ON and
  // the upsert clause after INSERT ... SELECT.
  return (
    `INSERT INTO main.${table} (${list}) SELECT ${values} FROM legacy.${table} AS src ` +
    'WHERE true ON CONFLICT DO NOTHING'
  );
}

function countsOf(values: readonly number[]): TableCounts {
  return Object.fromEntries(MERGED_TABLES.map((table, i) => [table, values[i]])) as TableCounts;
}

/** `memories +3 (1 already present), facts +2`, or `empty`. */
export function describeCounts({ copied, duplicates }: SourceCounts): string {
  return (
    MERGED_TABLES.filter((t) => copied[t] + duplicates[t] > 0)
      .map((t) => `${t} +${copied[t]}${duplicates[t] ? ` (${duplicates[t]} already present)` : ''}`)
      .join(', ') || 'empty'
  );
}

/** The outcomes worth a log line: something was merged, or could not be. */
export type ReportableMigration<S> = Exclude<FileMigration<S>, { kind: 'current' }>;

/**
 * One log entry for a migration: a headline, then one line per source.
 *
 * @param noun - what was merged, e.g. `global memory`
 * @param target - where it was merged into, as the reader should see it
 * @param label - how to name one source
 */
export function describeFileMigration<S>(
  migration: ReportableMigration<S>,
  noun: string,
  target: string,
  label: (source: S) => string,
): string {
  const lines = (merged: readonly FileMerge<S>[]) =>
    merged.map((m) => `  ${label(m.source)}: ${describeCounts(m)}; original kept at ${m.keptAs}`);
  return match(migration)
    .with({ kind: 'busy' }, () => `another process is still merging the ${noun} databases into ${target}`)
    .with({ kind: 'failed' }, ({ error, merged }) =>
      [
        `merging the ${noun} databases into ${target} failed: ${error}`,
        ...(merged.length > 0 ? ['merged before the failure:', ...lines(merged)] : []),
      ].join('\n'),
    )
    .with({ kind: 'merged' }, ({ merged }) =>
      [`merged ${merged.length} ${noun} database(s) into ${target}:`, ...lines(merged)].join('\n'),
    )
    .exhaustive();
}

/** The suffix a merged source is kept under: `merged-2026-11-10T12-00-00-000Z`. */
export function mergedSuffix(now: Date): string {
  return `merged-${now.toISOString().replace(/[:.]/g, '-')}`;
}

// ============================================================================
// FILES
// ============================================================================

const DB_FILE_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const;

export function removeDbFiles(path: string): void {
  for (const suffix of DB_FILE_SUFFIXES) rmSync(`${path}${suffix}`, { force: true });
}

/**
 * Move a merged database (and its WAL files) aside to `<path>.<suffix>`; it
 * is kept, never deleted. Its old path is then free, which is what marks it
 * merged: a database at the old path again is new and will be merged again.
 */
export function keepAside(path: string, suffix: string): string {
  // A database merged twice in the same millisecond must not overwrite the
  // first one's kept copy: rename silently replaces an existing file.
  const free = (name: string) => DB_FILE_SUFFIXES.every((s) => !existsSync(`${name}${s}`));
  let keptAs = `${path}.${suffix}`;
  for (let n = 1; !free(keptAs); n++) keptAs = `${path}.${suffix}-${n}`;
  for (const fileSuffix of DB_FILE_SUFFIXES) {
    if (existsSync(`${path}${fileSuffix}`)) renameSync(`${path}${fileSuffix}`, `${keptAs}${fileSuffix}`);
  }
  return keptAs;
}
