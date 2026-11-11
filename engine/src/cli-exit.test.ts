/**
 * Exit-status contract of the CLI entry point.
 *
 * Regression: once onnxruntime-node had loaded, the CLI ended with
 * `process.exit()`, which runs native teardown on the exiting thread and makes
 * Bun panic ("A C++ exception occurred", status 134) even after the model was
 * disposed. Every command that embedded (remember, backfill, recall) therefore
 * "failed" after doing its work, breaking `remember && backfill && generate`
 * chains. These tests pin both the pure mapping and the real process status.
 */

import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exitCodeFor } from './cli.js';

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts');

describe('cli - exitCodeFor', () => {
  it('maps a success to 0', () => {
    expect(exitCodeFor({ kind: 'succeeded' })).toBe(0);
  });

  it('maps a deferral to 0: it did no work yet and is retried, it did not fail', () => {
    expect(exitCodeFor({ kind: 'deferred', output: 'later' })).toBe(0);
  });

  it('maps a failure to 1, retryable or not', () => {
    expect(exitCodeFor({ kind: 'failed', error: 'boom' })).toBe(1);
    expect(exitCodeFor({ kind: 'failed', error: 'boom', retryable: true })).toBe(1);
  });
});

/** Run the real CLI in an isolated HOME and project directory. */
function runCli(args: (cwd: string) => readonly string[]) {
  const home = mkdtempSync(join(tmpdir(), 'cortex-exit-home-'));
  const cwd = mkdtempSync(join(tmpdir(), 'cortex-exit-cwd-'));
  try {
    return spawnSync('bun', [CLI_PATH, ...args(cwd)], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
      timeout: 180_000,
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('cli - process exit status', () => {
  it(
    'exits 0 without a Bun panic after a command loads the local embedding model',
    () => {
      // remember embeds for dedup and flushes the embedding queue, so the
      // ONNX runtime is loaded and disposed before the process ends.
      const result = runCli((cwd) => [
        'remember',
        cwd,
        'exit-status regression memory',
        '--type=gotcha',
      ]);

      expect(result.stderr).not.toContain('panic');
      expect(result.stdout).toContain('Created memory:');
      expect(result.status).toBe(0);
    },
    200_000,
  );

  it('exits 1 for a failed command', () => {
    const result = runCli(() => ['no-such-subcommand']);

    expect(result.stderr).toContain('Unknown subcommand: no-such-subcommand');
    expect(result.status).toBe(1);
  });

  it('exits 1 with usage when no subcommand is given', () => {
    const result = runCli(() => []);

    expect(result.stderr).toContain('Usage: cli.ts <subcommand>');
    expect(result.status).toBe(1);
  });
});
