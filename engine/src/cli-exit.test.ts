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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exitCodeFor } from './cli.js';
import { runCli } from './test-support.js';

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

/** Run the real CLI in an isolated HOME (runCli's) and project directory. */
function runCliInFreshProject(args: (cwd: string) => readonly string[]) {
  const cwd = mkdtempSync(join(tmpdir(), 'cortex-exit-cwd-'));
  try {
    return runCli(args(cwd), { timeout: 180_000 });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('cli - process exit status', () => {
  it(
    'exits 0 without a Bun panic after a command loads the local embedding model',
    () => {
      // remember embeds for dedup and flushes the embedding queue, so the
      // ONNX runtime is loaded and disposed before the process ends.
      const result = runCliInFreshProject((cwd) => [
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
    const result = runCliInFreshProject(() => ['no-such-subcommand']);

    expect(result.stderr).toContain('Unknown subcommand: no-such-subcommand');
    expect(result.status).toBe(1);
  });

  it('exits 1 with usage when no subcommand is given', () => {
    const result = runCliInFreshProject(() => []);

    expect(result.stderr).toContain('Usage: cli.ts <subcommand>');
    expect(result.status).toBe(1);
  });
});
