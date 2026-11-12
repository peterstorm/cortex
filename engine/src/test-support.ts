/**
 * Test-only helpers for the suites that drive real processes: the engine CLI
 * and git.
 *
 * Each of these suites carried its own copy of the CLI path, its own
 * `spawnSync('bun', [CLI, ...])` wrapper and its own git-with-an-identity
 * helper, and the copies had already drifted on the one thing that matters:
 * some gave the spawned CLI a throwaway HOME and one ran it against the real
 * one. Here the CLI always gets a throwaway HOME unless a test names one.
 *
 * Consumers: cli.test, cli-exit.test, cli-project.e2e.test,
 * show-surface.e2e.test, commands/eval.e2e.test (CLI_PATH only: it must spawn
 * asynchronously while its stub server answers), commands/show-surface.test,
 * infra/project-db.test.
 */

import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** The engine's CLI entry point. */
export const CLI_PATH = fileURLToPath(new URL('./cli.ts', import.meta.url));

/**
 * A fresh, empty HOME. It lands under the per-file temp directory
 * test-preload.ts sets, which is removed after the file's tests.
 */
export const isolatedHome = (): string => mkdtempSync(join(tmpdir(), 'cortex-test-home-'));

export type RunCliOptions = Readonly<{
  cwd?: string;
  /** Written to the CLI's stdin. */
  input?: string;
  /** Merged over process.env and the throwaway HOME, so it can name its own HOME. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to 120 s: a command that loads the embedding model takes seconds. */
  timeout?: number;
}>;

/** Run `bun cli.ts ...args` to completion, never against the real HOME. */
export function runCli(args: readonly string[], options: RunCliOptions = {}): SpawnSyncReturns<string> {
  return spawnSync('bun', [CLI_PATH, ...args], {
    encoding: 'utf8',
    cwd: options.cwd,
    input: options.input,
    timeout: options.timeout ?? 120_000,
    env: { ...process.env, HOME: isolatedHome(), ...options.env },
  });
}

/** Run git quietly in `cwd`, with a committer identity so commits work anywhere. */
export function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, stdio: 'ignore' });
}

/** Make `dir` a repository on `branch` with one (empty) commit, so branches and worktrees can be added. */
export function initRepo(dir: string, branch = 'main'): void {
  git(dir, 'init', '-q', '-b', branch);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
}
