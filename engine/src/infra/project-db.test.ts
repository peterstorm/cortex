/**
 * Tests for locating and merging project databases against real git
 * repositories and worktrees in a temp directory.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getLockDir, getProjectDbPath } from '../config.js';
import { createMemory } from '../core/types.js';
import { getMemory, insertMemory, openDatabase } from './db.js';
import {
  classifyProbeFailure,
  describeProjectMigration,
  hasProjectMemory,
  migrateProjectDb,
  probeRepository,
  resolveProjectLocation,
  STANDALONE_MARKER,
} from './project-db.js';
import { git, initRepo } from '../test-support.js';

let base: string;
const NOW = new Date('2026-11-11T09:00:00.000Z');

/** A repository with one commit, so worktrees can be added. */
function makeRepo(name: string): string {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  initRepo(dir);
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

describe('classifyProbeFailure', () => {
  it.each([
    [{ code: 'ENOENT', message: 'spawnSync git ENOENT' }],
    [{ status: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' }],
  ])('git missing, or no repository here, is no repository: %j', (error) => {
    expect(classifyProbeFailure(error)).toEqual({ kind: 'no-repository' });
  });

  it.each([
    [{ code: 'ETIMEDOUT' }, 'git did not answer within 5000 ms'],
    [{ signal: 'SIGTERM', stderr: '' }, 'git did not answer within 5000 ms'],
    [
      { status: 128, stderr: "fatal: detected dubious ownership in repository at '/work/loom'\n" },
      "fatal: detected dubious ownership in repository at '/work/loom'",
    ],
    [new Error('spawnSync git EACCES'), 'spawnSync git EACCES'],
    ['boom', 'boom'],
  ])('git that was there and could not answer is not the same thing: %j', (error, reason) => {
    expect(classifyProbeFailure(error)).toEqual({ kind: 'unanswered', reason });
  });

  it('classifies anything thrown, and only the two expected failures as no repository (property)', () => {
    fc.assert(
      fc.property(fc.anything(), (error) => {
        const failure = classifyProbeFailure(error);
        const shape = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; stderr?: unknown };
        const expected =
          shape.code === 'ENOENT' || (typeof shape.stderr === 'string' && /not a git repository/i.test(shape.stderr));
        expect(failure.kind).toBe(expected ? 'no-repository' : 'unanswered');
      }),
    );
  });
});

describe('probeRepository', () => {
  const collect = () => {
    const warnings: string[] = [];
    return { warnings, warn: (message: string) => warnings.push(message) };
  };

  it('says nothing for a directory in no repository', () => {
    const dir = join(base, 'scratch');
    mkdirSync(dir);
    const { warnings, warn } = collect();

    expect(probeRepository(dir, warn)).toEqual({ kind: 'not-a-repository' });
    expect(warnings).toEqual([]);
  });

  it('warns when git is there but cannot answer, and still treats the directory as the project', () => {
    const broken = makeRepo('broken');
    writeFileSync(join(broken, '.git', 'config'), 'this is not a git config\n');
    const { warnings, warn } = collect();

    expect(probeRepository(broken, warn)).toEqual({ kind: 'not-a-repository' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`git could not say which repository ${broken} belongs to (`);
    expect(warnings[0]).toContain('bad config');
    expect(warnings[0]).toContain("kept apart from the repository's until a later command merges it");

    const again = collect();
    expect(resolveProjectLocation(broken, again.warn)).toMatchObject({ root: broken, scope: 'directory', strays: [] });
    expect(again.warnings).toHaveLength(1);
  });
});

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

  it('reports busy, and leaves the stray in place, while another process holds the merge lock', () => {
    const loom = makeRepo('loom');
    const audit = addWorktree(loom, 'loom-audit');
    seedDb(audit, 'audit-memory');
    const location = resolveProjectLocation(audit);
    mkdirSync(getLockDir(loom), { recursive: true });
    // This process's PID is alive, so the lock reads as held by another merge.
    const lock = join(getLockDir(loom), 'merge.lock');
    writeFileSync(lock, String(process.pid));

    const migration = migrateProjectDb(location, NOW, 150);

    expect(migration).toEqual({ kind: 'busy' });
    expect(existsSync(getProjectDbPath(audit))).toBe(true);
    expect(existsSync(getProjectDbPath(loom))).toBe(false);
    expect(describeProjectMigration(migration as { kind: 'busy' }, location)).toContain(
      'another process is still merging the stray memory databases into project "loom"',
    );

    rmSync(lock);
    expect(migrateProjectDb(location, NOW, 150).kind).toBe('merged');
    expect(memoryIn(loom, 'audit-memory')).not.toBeNull();
  });

  it('stops at a stray it cannot read: the earlier ones are merged, that one stays where it is', () => {
    const loom = makeRepo('loom');
    const audit = addWorktree(loom, 'loom-audit');
    const engine = join(audit, 'engine');
    mkdirSync(engine);
    seedDb(engine, 'engine-memory');
    mkdirSync(join(audit, '.memory'));
    writeFileSync(getProjectDbPath(audit), 'this is not a sqlite database, whatever its name says');

    const location = resolveProjectLocation(engine);
    const migration = migrateProjectDb(location, NOW);
    if (migration.kind !== 'failed') throw new Error(JSON.stringify(migration));

    expect(migration.error).toContain(getProjectDbPath(audit));
    expect(migration.merged.map((m) => m.source)).toEqual([engine]);
    expect(memoryIn(loom, 'engine-memory')).not.toBeNull();
    expect(existsSync(getProjectDbPath(engine))).toBe(false);
    expect(existsSync(getProjectDbPath(audit))).toBe(true);
    expect(readdirSync(join(audit, '.memory'))).toEqual(['cortex.db']);
    expect(describeProjectMigration(migration, location)).toMatch(/failed: .*\nmerged before the failure:\n {2}.*engine: memories \+1/);
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
