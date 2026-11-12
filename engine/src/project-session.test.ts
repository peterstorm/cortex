/**
 * The project session: whatever the command does, both databases are closed
 * afterwards, and only a throw from the command becomes a labelled failure.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from 'bun:sqlite';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getProjectDbPath } from './config.js';
import type { CommandResult } from './command-result.js';
import {
  locate,
  usingProjectSession,
  validateCwd,
  withProjectSession,
  type ProjectSession,
} from './project-session.js';

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts');

let cwd: string;
/** Every session a command was handed, so a test can look at it afterwards. */
let seen: ProjectSession[];

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'cortex-project-session-')));
  seen = [];
});

afterEach(() => rmSync(cwd, { recursive: true, force: true }));

/** A closed bun:sqlite connection refuses every statement. */
const isClosed = (db: Database): boolean => {
  try {
    db.query('SELECT 1').get();
    return false;
  } catch {
    return true;
  }
};

/** The one session the command was handed has both databases closed. */
const closedAfterwards = (): boolean =>
  seen.length === 1 && isClosed(seen[0].projectDb) && isClosed(seen[0].globalDb);

describe('withProjectSession', () => {
  it('hands the command the located project with both databases open, and returns its result', async () => {
    let openDuringRun = false;

    const result = await withProjectSession(cwd, 'Generate', (session) => {
      seen.push(session);
      openDuringRun = !isClosed(session.projectDb) && !isClosed(session.globalDb);
      return { kind: 'succeeded', output: 'done' };
    });

    expect(result).toEqual({ kind: 'succeeded', output: 'done' });
    expect(openDuringRun).toBe(true);
    expect(seen[0].project.cwd).toBe(cwd);
    expect(existsSync(getProjectDbPath(seen[0].project.root))).toBe(true);
  });

  it('closes both databases when the command returns', async () => {
    await withProjectSession(cwd, 'Generate', (session) => {
      seen.push(session);
      return { kind: 'succeeded' };
    });

    expect(closedAfterwards()).toBe(true);
  });

  it('closes both databases when the command returns a failure, and passes the failure through untouched', async () => {
    const failure: CommandResult = { kind: 'failed', error: 'Memory not found', retryable: true, output: 'partial' };

    const result = await withProjectSession(cwd, 'Forget', (session) => {
      seen.push(session);
      return failure;
    });

    expect(result).toEqual(failure);
    expect(closedAfterwards()).toBe(true);
  });

  it('turns a throw from the command into "<label> failed: <error>" and closes both databases', async () => {
    const result = await withProjectSession(cwd, 'Generate', (session) => {
      seen.push(session);
      throw new Error('surface lock held');
    });

    expect(result).toEqual({ kind: 'failed', error: 'Generate failed: Error: surface lock held' });
    expect(closedAfterwards()).toBe(true);
  });

  it('turns a rejection from an async command into the same labelled failure', async () => {
    const result = await withProjectSession(cwd, 'Semantic edges', async (session) => {
      seen.push(session);
      await Promise.resolve();
      throw 'endpoint refused';
    });

    expect(result).toEqual({ kind: 'failed', error: 'Semantic edges failed: endpoint refused' });
    expect(closedAfterwards()).toBe(true);
  });

  it('does not label a failure to open the project: that propagates to the caller', async () => {
    // `.memory` as a file: the project database cannot be created under it.
    writeFileSync(join(cwd, '.memory'), 'not a directory');

    const outcome = withProjectSession(cwd, 'Generate', (session) => {
      seen.push(session);
      return { kind: 'succeeded' };
    });

    await expect(outcome).rejects.toThrow();
    expect(seen).toHaveLength(0);
  });
});

describe('usingProjectSession', () => {
  it('closes both databases when the command returns, and returns its result', async () => {
    const result = await usingProjectSession(locate(cwd), (session) => {
      seen.push(session);
      return { kind: 'deferred', output: 'later' };
    });

    expect(result).toEqual({ kind: 'deferred', output: 'later' });
    expect(closedAfterwards()).toBe(true);
  });

  it('lets a throw from the command propagate, after closing both databases', async () => {
    const outcome = usingProjectSession(locate(cwd), async (session) => {
      seen.push(session);
      throw new Error('extraction crashed');
    });

    await expect(outcome).rejects.toThrow('extraction crashed');
    expect(closedAfterwards()).toBe(true);
  });
});

describe('validateCwd', () => {
  it('accepts an existing absolute directory', () => {
    expect(validateCwd(cwd)).toBeNull();
  });

  it('rejects dash-prefixed values (flags mistaken for cwd)', () => {
    for (const arg of ['--session', '-x', '--if-needed']) {
      const error = validateCwd(arg);
      expect(error).not.toBeNull();
      expect(error).toContain('looks like a flag');
    }
  });

  it('rejects relative paths', () => {
    const error = validateCwd('some/relative/dir');
    expect(error).not.toBeNull();
    expect(error).toContain('must be an absolute path');
  });

  it('rejects nonexistent directories without creating them', () => {
    const missing = join(cwd, 'does-not-exist');

    const error = validateCwd(missing);

    expect(error).not.toBeNull();
    expect(error).toContain('does not exist');
    // Validation must be side-effect free — no phantom directories
    expect(existsSync(missing)).toBe(false);
  });

  it('rejects paths pointing at a file, not a directory', () => {
    const filePath = join(cwd, 'file.txt');
    writeFileSync(filePath, 'not a dir', 'utf8');

    const error = validateCwd(filePath);

    expect(error).not.toBeNull();
    expect(error).toContain('not a directory');
  });

  it('reports non-ENOENT filesystem failures instead of calling them missing', () => {
    const loop = join(cwd, 'symlink-loop');
    symlinkSync(loop, loop);

    const error = validateCwd(loop);

    expect(error).toContain('ELOOP');
    expect(error).not.toContain('directory does not exist');
  });
});

describe('locate', () => {
  it('exits 1 with the usage error on an invalid cwd, before creating anything', () => {
    const missing = join(cwd, 'does-not-exist');

    const result = spawnSync('bun', [CLI_PATH, 'generate', missing], {
      encoding: 'utf8',
      env: process.env,
      timeout: 120_000,
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`[cortex] Invalid cwd '${missing}': directory does not exist`);
    expect(existsSync(missing)).toBe(false);
  }, 120_000);
});
