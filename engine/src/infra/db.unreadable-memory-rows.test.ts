/**
 * A memories row that does not hold a valid Memory costs that row, never the
 * read it appears in.
 *
 * The database file is plain SQLite and Cortex is not its only writer. A
 * single archived row with priority 0, written by another tool, made
 * createMemory throw out of getArchivedMemories — and so out of every
 * lifecycle run for that project, for months. These tests pin the contract
 * edges, entities and facts already had: the row is skipped, named on stderr,
 * and left in the file exactly as it was found.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Database } from 'bun:sqlite';
import fc from 'fast-check';
import {
  openDatabase,
  insertMemory,
  getMemory,
  getMemoriesByIds,
  getActiveMemories,
  getArchivedMemories,
  getActiveMemoriesNeedingEmbedding,
  getActiveProseMemoriesByFilePath,
  getMemoriesWithEmbedding,
  getMemoriesWithEmbeddingByIds,
  searchByKeyword,
  countActiveMemoryRows,
} from './db.js';
import { createMemory } from '../core/types.js';
import type { Memory } from '../core/types.js';
import { runLifecycle } from '../commands/lifecycle.js';

function makeMemory(
  id: string,
  overrides: Partial<Parameters<typeof createMemory>[0]> = {}
): Memory {
  return createMemory({
    id,
    content: 'pgbouncer pools connections',
    summary: 'pooling',
    memory_type: 'context',
    scope: 'project',
    confidence: 0.5,
    priority: 5,
    source_type: 'manual',
    source_session: 's',
    source_context: '{}',
    ...overrides,
  });
}

/**
 * One way a stored row can stop being a Memory: the column written past the
 * factory, the value put there, and the diagnostic the read must give.
 * `priority 0` and `scope workspace` are the two shapes found in the wild.
 */
type Corruption = {
  readonly name: string;
  readonly column: string;
  readonly value: string | number;
  readonly diagnostic: string;
};

const CORRUPTIONS: readonly Corruption[] = [
  { name: 'priority 0', column: 'priority', value: 0, diagnostic: 'priority must be in [1, 10], got 0' },
  { name: 'priority 11', column: 'priority', value: 11, diagnostic: 'priority must be in [1, 10], got 11' },
  { name: 'confidence 2', column: 'confidence', value: 2, diagnostic: 'confidence must be in [0, 1], got 2' },
  { name: 'scope workspace', column: 'scope', value: 'workspace', diagnostic: "invalid scope 'workspace'" },
  { name: 'memory_type note', column: 'memory_type', value: 'note', diagnostic: "invalid memory_type 'note'" },
  { name: 'blank content', column: 'content', value: '   ', diagnostic: 'content must not be empty' },
  { name: 'blank summary', column: 'summary', value: '   ', diagnostic: 'summary must not be empty' },
  { name: 'blank source_session', column: 'source_session', value: '', diagnostic: 'source_session must not be empty' },
  {
    name: 'archive anchor on an active row',
    column: 'archived_at',
    value: '2026-01-01T00:00:00.000Z',
    diagnostic: 'active memory must not have archived_at set',
  },
];

/** Write a cell past createMemory, the way a foreign writer does. */
function corrupt(db: Database, id: string, corruption: Corruption): void {
  db.prepare(`UPDATE memories SET ${corruption.column} = ? WHERE id = ?`).run(corruption.value, id);
}

function storedRow(db: Database, id: string): Record<string, unknown> | null {
  return db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as Record<string, unknown> | null;
}

describe('an unreadable memory row is skipped, named and left alone', () => {
  let db: Database;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = openDatabase(':memory:');
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    db.close();
  });

  it.each(CORRUPTIONS)('$name: every reader keeps the sibling and drops the row', (corruption) => {
    const embedding = new Float32Array([0.1, 0.2, 0.3]);
    insertMemory(db, makeMemory('mem-bad', { local_embedding: embedding }));
    insertMemory(db, makeMemory('mem-ok', { local_embedding: embedding }));
    corrupt(db, 'mem-bad', corruption);
    const before = storedRow(db, 'mem-bad');

    expect(getActiveMemories(db).map((m) => m.id)).toEqual(['mem-ok']);
    expect(getMemory(db, 'mem-bad')).toBeNull();
    expect(getMemory(db, 'mem-ok')?.id).toBe('mem-ok');
    expect(getMemoriesByIds(db, ['mem-bad', 'mem-ok'], 'any').map((m) => m.id)).toEqual(['mem-ok']);
    expect(getMemoriesWithEmbedding(db).map((r) => r.memory.id)).toEqual(['mem-ok']);
    expect(getMemoriesWithEmbeddingByIds(db, ['mem-bad', 'mem-ok']).map((r) => r.memory.id)).toEqual(['mem-ok']);

    expect(warn).toHaveBeenCalledWith(`[cortex:db] Skipping memory mem-bad: ${corruption.diagnostic}`);
    // Skipping is a read decision. The row is someone's data: it is reported,
    // not repaired and not deleted.
    expect(storedRow(db, 'mem-bad')).toEqual(before);
  });

  it('drops a row whose status is out of domain from the readers that can reach it', () => {
    // Every bulk reader but getMemoriesByIds(…, 'any') filters status in SQL,
    // so this cell is only reachable by id.
    insertMemory(db, makeMemory('mem-bad'));
    insertMemory(db, makeMemory('mem-ok'));
    db.prepare('UPDATE memories SET status = ? WHERE id = ?').run('retired', 'mem-bad');

    expect(getMemory(db, 'mem-bad')).toBeNull();
    expect(getMemoriesByIds(db, ['mem-bad', 'mem-ok'], 'any').map((m) => m.id)).toEqual(['mem-ok']);
    expect(warn).toHaveBeenCalledWith("[cortex:db] Skipping memory mem-bad: invalid status 'retired'");
  });

  it('keeps keyword search alive when a matching row is unreadable', () => {
    insertMemory(db, makeMemory('mem-bad'));
    insertMemory(db, makeMemory('mem-ok'));
    db.prepare('UPDATE memories SET priority = 0 WHERE id = ?').run('mem-bad');

    expect(searchByKeyword(db, 'pgbouncer', 10).map((m) => m.id)).toEqual(['mem-ok']);
  });

  it('keeps backfill and re-index lookups alive when a candidate row is unreadable', () => {
    const fileContext = JSON.stringify({ source: 'code_index', file_path: 'src/pool.ts' });
    for (const id of ['mem-bad', 'mem-ok']) {
      insertMemory(db, makeMemory(id, { memory_type: 'code_description', source_context: fileContext }));
    }
    db.prepare('UPDATE memories SET priority = 0 WHERE id = ?').run('mem-bad');

    expect(getActiveMemoriesNeedingEmbedding(db).map((m) => m.id)).toEqual(['mem-ok']);
    expect(getActiveProseMemoriesByFilePath(db, 'src/pool.ts').map((m) => m.id)).toEqual(['mem-ok']);
  });

  it('counts stored active rows whether or not they can be read', () => {
    insertMemory(db, makeMemory('mem-bad'));
    insertMemory(db, makeMemory('mem-ok'));
    insertMemory(db, makeMemory('mem-archived', { status: 'archived', archived_at: '2026-01-01T00:00:00.000Z' }));
    db.prepare('UPDATE memories SET priority = 0 WHERE id = ?').run('mem-bad');

    expect(countActiveMemoryRows(db)).toBe(2);
    expect(getActiveMemories(db)).toHaveLength(1);
  });

  it('skips exactly the corrupted rows, whatever mix of rows the table holds', () => {
    // The property behind every example above: reading is total over the
    // table, and what it returns is precisely the rows that still hold a
    // Memory — in any order, in any proportion, with any of the corruptions.
    const rowPlan = fc.array(fc.option(fc.constantFrom(...CORRUPTIONS), { nil: null }), {
      minLength: 0,
      maxLength: 12,
    });

    fc.assert(
      fc.property(rowPlan, (plan) => {
        const propertyDb = openDatabase(':memory:');
        try {
          plan.forEach((corruption, index) => {
            const id = `mem-${index}`;
            insertMemory(propertyDb, makeMemory(id));
            if (corruption !== null) corrupt(propertyDb, id, corruption);
          });
          const intact = plan.flatMap((corruption, index) => (corruption === null ? [`mem-${index}`] : []));

          expect(getActiveMemories(propertyDb).map((m) => m.id).sort()).toEqual([...intact].sort());
          expect(countActiveMemoryRows(propertyDb)).toBe(plan.length);
        } finally {
          propertyDb.close();
        }
      }),
      { numRuns: 60 }
    );
  });
});

describe('lifecycle on a database holding rows another tool wrote', () => {
  let db: Database;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = openDatabase(':memory:');
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    db.close();
  });

  it('still archives what is due, and leaves the foreign rows as they were', () => {
    const fifteenDaysAgo = new Date(Date.now() - 15 * 24 * 60 * 60 * 1000).toISOString();

    // Due for archiving: low confidence, untouched for more than 14 days.
    insertMemory(db, makeMemory('mem-due', {
      confidence: 0.25,
      created_at: fifteenDaysAgo,
      last_accessed_at: fifteenDaysAgo,
    }));

    // The row that stopped lifecycle for a whole project: archived, priority 0,
    // an origin outside the union.
    insertMemory(db, makeMemory('librarian-vault-review', {
      status: 'archived',
      archived_at: fifteenDaysAgo,
      created_at: fifteenDaysAgo,
      last_accessed_at: fifteenDaysAgo,
    }));
    db.prepare('UPDATE memories SET priority = 0, source_type = ? WHERE id = ?')
      .run('librarian', 'librarian-vault-review');

    // And the one that would have stopped it next: an active row in a scope
    // Cortex does not have.
    insertMemory(db, makeMemory('workspace-note', {
      confidence: 0.25,
      created_at: fifteenDaysAgo,
      last_accessed_at: fifteenDaysAgo,
    }));
    db.prepare('UPDATE memories SET scope = ? WHERE id = ?').run('workspace', 'workspace-note');

    const foreignBefore = [storedRow(db, 'librarian-vault-review'), storedRow(db, 'workspace-note')];

    const result = runLifecycle(db);

    expect(result.archived).toBe(1);
    expect(getMemory(db, 'mem-due')?.status).toBe('archived');
    expect(getArchivedMemories(db).map((m) => m.id)).toEqual(['mem-due']);
    expect([storedRow(db, 'librarian-vault-review'), storedRow(db, 'workspace-note')]).toEqual(foreignBefore);
    expect(warn).toHaveBeenCalledWith(
      '[cortex:db] Skipping memory librarian-vault-review: priority must be in [1, 10], got 0'
    );
    expect(warn).toHaveBeenCalledWith("[cortex:db] Skipping memory workspace-note: invalid scope 'workspace'");
  });
});
