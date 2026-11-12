/**
 * Every connection waits for a lock before failing, readers included.
 *
 * A read-only connection used to open with SQLite's default of no wait, so
 * `eval answer` (a VACUUM INTO snapshot from a read-only connection) failed at
 * once with "database is locked" whenever another process was opening or
 * closing the same database at that moment.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, openDatabaseReadOnly } from './db.js';

const busyTimeout = (db: Database): number =>
  (db.prepare('PRAGMA busy_timeout').get() as { timeout: number }).timeout;

describe('busy timeout', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cortex-busy-timeout-'));
    dbPath = join(dir, 'cortex.db');
    openDatabase(dbPath).close();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a read-only connection waits as long as a read-write one', () => {
    const rw = openDatabase(dbPath);
    const ro = openDatabaseReadOnly(dbPath);
    try {
      expect(busyTimeout(rw)).toBe(5000);
      expect(busyTimeout(ro)).toBe(busyTimeout(rw));
    } finally {
      ro.close();
      rw.close();
    }
  });

  it('a read-only connection can snapshot the database while a writer holds its transaction open', () => {
    const rw = openDatabase(dbPath);
    const ro = openDatabaseReadOnly(dbPath);
    try {
      rw.run('BEGIN IMMEDIATE');
      rw.run(`INSERT INTO entities (id, name, entity_type, created_at, updated_at) VALUES ('e1', 'Bun', 'tool', 'now', 'now')`);

      ro.prepare('VACUUM INTO ?').run(join(dir, 'snapshot.db'));

      rw.run('COMMIT');
      const snapshot = openDatabaseReadOnly(join(dir, 'snapshot.db'));
      try {
        // The snapshot is the committed state at the time it was taken.
        expect(snapshot.prepare('SELECT count(*) AS n FROM entities').get()).toEqual({ n: 0 });
      } finally {
        snapshot.close();
      }
    } finally {
      ro.close();
      rw.close();
    }
  });
});
