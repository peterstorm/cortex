/**
 * Tests for locating and merging project databases against real git
 * repositories and worktrees in a temp directory.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProjectDbPath } from '../config.js';
import { createMemory } from '../core/types.js';
import { getMemory, insertMemory, openDatabase } from './db.js';
import {
  describeProjectMigration,
  hasProjectMemory,
  migrateProjectDb,
  probeRepository,
  resolveProjectLocation,
  STANDALONE_MARKER,
} from './project-db.js';

let base: string;
const NOW = new Date('2026-11-11T09:00:00.000Z');

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' });

/** A repository with one commit, so worktrees can be added. */
function makeRepo(name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

function addWorktree(repo: string, name: string): string {
  const dir = join(base, name);
  git(repo, 'worktree', 'add', '-q', '-b', name, dir);
  return dir;
}

/** A project DB in `dir` holding one memory with `id`. */
function seedDb(dir: string, id: string): void {
  mkdirSync(join(dir, '.memory'), { recursive: true });
  const db = openDatabase(getProjectDbPath(dir));
  try {
    insertMemory(
      db,
      createMemory({
        id,
        content: `content of ${id}`,
        summary: `summary of ${id}`,
        memory_type: 'context',
        scope: 'project',
        confidence: 0.8,
        priority: 5,
        source_type: 'extraction',
        source_session: 's',
        source_context: '{}',
      }),
    );
  } finally {
    db.close();
  }
}

function memoryIn(dir: string, id: string) {
  const db = openDatabase(getProjectDbPath(dir));
  try {
    return getMemory(db, id);
  } finally {
    db.close();
  }
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'cortex-project-db-')));
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('resolveProjectLocation', () => {
  it('outside a repository, the directory is the project', () => {
    const dir = join(base, 'scratch');
    mkdirSync(dir);
    expect(probeRepository(dir)).toEqual({ kind: 'not-a-repository' });
    expect(resolveProjectLocation(dir)).toMatchObject({ root: dir, scope: 'directory', strays: [] });
  });

  it('a subdirectory and a linked worktree both resolve to the main worktree', () => {
    const loom = makeRepo('loom');
    const audit = addWorktree(loom, 'loom-audit');
    mkdirSync(join(audit, 'engine'));

    expect(resolveProjectLocation(join(audit, 'engine'))).toMatchObject({
      cwd: join(audit, 'engine'),
      root: loom,
      name: 'loom',
      scope: 'repository',
      strays: [join(audit, 'engine'), audit],
    });
    mkdirSync(join(loom, 'engine'));
    expect(resolveProjectLocation(join(loom, 'engine'))).toMatchObject({
      root: loom,
      strays: [join(loom, 'engine'), audit],
    });
  });

  it('a standalone marker keeps a directory to itself', () => {
    const reclaw = makeRepo('reclaw');
    const workspace = join(reclaw, 'workspace');
    mkdirSync(join(workspace, '.memory'), { recursive: true });
    writeFileSync(join(workspace, STANDALONE_MARKER), '');

    expect(resolveProjectLocation(workspace)).toMatchObject({ root: workspace, scope: 'standalone', strays: [] });
    expect(resolveProjectLocation(reclaw)).toMatchObject({ root: reclaw, scope: 'repository', strays: [] });
  });

  it('ignores a GIT_DIR exported by an enclosing git command', () => {
    const loom = makeRepo('loom');
    const other = makeRepo('other');
    process.env.GIT_DIR = join(other, '.git');
    try {
      expect(resolveProjectLocation(loom).root).toBe(loom);
    } finally {
      delete process.env.GIT_DIR;
    }
  });

  it('knows a project has memory when only a stray database exists yet', () => {
    const loom = makeRepo('loom');
    const audit = addWorktree(loom, 'loom-audit');
    expect(hasProjectMemory(resolveProjectLocation(audit))).toBe(false);
    seedDb(audit, 'a1');
    expect(hasProjectMemory(resolveProjectLocation(audit))).toBe(true);
  });
});

describe('migrateProjectDb', () => {
  it('merges worktree and subdirectory databases into the root and keeps them aside', () => {
    const loom = makeRepo('loom');
    const audit = addWorktree(loom, 'loom-audit');
    const engine = join(audit, 'engine');
    mkdirSync(engine);
    seedDb(loom, 'root-memory');
    seedDb(audit, 'audit-memory');
    seedDb(engine, 'engine-memory');

    const location = resolveProjectLocation(engine);
    const migration = migrateProjectDb(location, NOW);
    if (migration.kind !== 'merged') throw new Error(JSON.stringify(migration));

    expect(migration.merged.map((m) => [m.source, m.copied.memories])).toEqual([
      [engine, 1],
      [audit, 1],
    ]);
    for (const id of ['root-memory', 'audit-memory', 'engine-memory']) expect(memoryIn(loom, id)).not.toBeNull();
    for (const dir of [audit, engine]) {
      expect(existsSync(getProjectDbPath(dir))).toBe(false);
      expect(readdirSync(join(dir, '.memory')).some((f) => f.startsWith('cortex.db.merged-'))).toBe(true);
    }
    expect(migrateProjectDb(location, NOW)).toEqual({ kind: 'current' });
    expect(describeProjectMigration(migration, location)).toMatch(
      /^merged 2 stray memory database\(s\) into project "loom" .*\n {2}.*engine: memories \+1; original kept at /,
    );
  });

  it('creates the root database when only a worktree had one', () => {
    const loom = makeRepo('loom');
    const audit = addWorktree(loom, 'loom-audit');
    seedDb(audit, 'only-here');

    expect(migrateProjectDb(resolveProjectLocation(audit), NOW).kind).toBe('merged');
    expect(memoryIn(loom, 'only-here')).not.toBeNull();
  });

  it('keeps the root row on an id clash', () => {
    const loom = makeRepo('loom');
    const audit = addWorktree(loom, 'loom-audit');
    seedDb(loom, 'same');
    seedDb(audit, 'same');
    const db = openDatabase(getProjectDbPath(audit));
    db.run(`UPDATE memories SET content = 'from the worktree' WHERE id = 'same'`);
    db.close();

    const migration = migrateProjectDb(resolveProjectLocation(audit), NOW);
    if (migration.kind !== 'merged') throw new Error(JSON.stringify(migration));
    expect(migration.merged[0].duplicates.memories).toBe(1);
    expect(memoryIn(loom, 'same')?.content).toBe('content of same');
  });

  it('never merges a standalone directory into the repository', () => {
    const reclaw = makeRepo('reclaw');
    const workspace = join(reclaw, 'workspace');
    seedDb(workspace, 'bot-chat');
    writeFileSync(join(workspace, STANDALONE_MARKER), '');

    expect(migrateProjectDb(resolveProjectLocation(reclaw), NOW)).toEqual({ kind: 'current' });
    expect(migrateProjectDb(resolveProjectLocation(workspace), NOW)).toEqual({ kind: 'current' });
    expect(existsSync(getProjectDbPath(workspace))).toBe(true);
  });
});
