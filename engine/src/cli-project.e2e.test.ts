/**
 * The real CLI, run from inside a linked worktree's subdirectory: memory
 * must land in the repository's main worktree, the surface beside the
 * session, and the worktree's own old database must be merged and kept aside.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getLockDir, getProjectDbPath, getSurfaceCacheDir, getSurfaceOutputPath } from './config.js';
import { createMemory } from './core/types.js';
import { getActiveMemories, getMemory, insertMemory, openDatabase } from './infra/db.js';

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts');

let base: string;

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' });

function cli(...args: string[]) {
  return spawnSync('bun', [CLI_PATH, ...args], { encoding: 'utf8', env: process.env, timeout: 120_000 });
}

function seed(dir: string, id: string, summary: string): void {
  mkdirSync(join(dir, '.memory'), { recursive: true });
  const db = openDatabase(getProjectDbPath(dir));
  try {
    insertMemory(
      db,
      createMemory({
        id,
        content: summary,
        summary,
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.9,
        priority: 9,
        source_type: 'extraction',
        source_session: 's',
        source_context: '{}',
      }),
    );
  } finally {
    db.close();
  }
}

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'cortex-cli-project-')));
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

describe('cli - one memory per repository', () => {
  it('generate from a worktree subdirectory merges the worktree DB into the main one and surfaces it there', () => {
    const main = join(base, 'loom');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
    const worktree = join(base, 'loom-audit');
    git(main, 'worktree', 'add', '-q', '-b', 'audit', worktree);
    const session = join(worktree, 'engine');
    mkdirSync(session);
    seed(main, 'from-main', 'Decided in the main checkout');
    seed(worktree, 'from-worktree', 'Decided on the audit branch worktree');

    const result = cli('generate', session);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('merged 1 stray memory database(s) into project "loom"');

    // Memory: one database, at the main worktree.
    const db = openDatabase(getProjectDbPath(main));
    try {
      expect(getMemory(db, 'from-main')).not.toBeNull();
      expect(getMemory(db, 'from-worktree')).not.toBeNull();
    } finally {
      db.close();
    }
    expect(existsSync(getProjectDbPath(worktree))).toBe(false);
    expect(readdirSync(join(worktree, '.memory')).some((f) => f.startsWith('cortex.db.merged-'))).toBe(true);
    expect(existsSync(join(session, '.memory'))).toBe(false);

    // Surface: beside the session, holding both checkouts' memories.
    const surface = readFileSync(getSurfaceOutputPath(session), 'utf8');
    expect(surface).toContain('Decided in the main checkout');
    expect(surface).toContain('Decided on the audit branch worktree');

    // inspect names the project and where its memory lives.
    expect(cli('inspect', session).stdout).toContain(`Project: loom (repository) — memory at ${getProjectDbPath(main)}`);
  });

  it('remember and load-surface from a worktree subdirectory keep every project file at the main worktree', () => {
    const main = join(base, 'loom');
    mkdirSync(main);
    git(main, 'init', '-q', '-b', 'main');
    git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
    const worktree = join(base, 'loom-audit');
    git(main, 'worktree', 'add', '-q', '-b', 'audit', worktree);
    const session = join(worktree, 'engine');
    mkdirSync(session);
    seed(main, 'from-main', 'Decided in the main checkout');

    const remembered = cli('remember', session, 'Remembered from the audit worktree engine directory', '--type=decision', '--priority=9');
    expect(remembered.status, remembered.stderr).toBe(0);
    const loaded = cli('load-surface', session);
    expect(loaded.status, loaded.stderr).toBe(0);

    // Memory, surface cache and locks: the repository's, at the main worktree.
    const db = openDatabase(getProjectDbPath(main));
    try {
      expect(getActiveMemories(db).map((m) => m.summary).sort()).toEqual([
        'Decided in the main checkout',
        'Remembered from the audit worktree engine directory',
      ]);
    } finally {
      db.close();
    }
    expect(readdirSync(getSurfaceCacheDir(main)).some((f) => f.endsWith('.json'))).toBe(true);
    expect(existsSync(getLockDir(main))).toBe(true);
    expect(existsSync(join(worktree, '.memory'))).toBe(false);
    expect(existsSync(join(session, '.memory'))).toBe(false);

    // Surface: beside the session only, holding what was just remembered.
    const surface = readFileSync(getSurfaceOutputPath(session), 'utf8');
    expect(surface).toContain('Remembered from the audit worktree engine directory');
    expect(surface).toContain('Decided in the main checkout');
    expect(existsSync(getSurfaceOutputPath(main))).toBe(false);
    expect(existsSync(getSurfaceOutputPath(worktree))).toBe(false);
  });
});
