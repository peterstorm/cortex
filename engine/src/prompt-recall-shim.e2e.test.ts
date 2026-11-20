/**
 * End to end through the real UserPromptSubmit shim (hooks/scripts/
 * prompt-recall.sh), with a stand-in CLI so each outcome can be forced: the
 * shim must hand the CLI's stdout to Claude Code untouched, and must keep the
 * CLI's warnings in a log instead of discarding them. Before the log, a
 * degraded recall (embedder down → keyword search) left no trace anywhere.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REAL_SHIM = fileURLToPath(new URL('../../hooks/scripts/prompt-recall.sh', import.meta.url));

let root: string;
let shim: string;
let logDir: string;

/** Lay out a plugin root whose engine/src/cli.ts is `cliSource`. */
function withCli(cliSource: string): void {
  writeFileSync(path.join(root, 'engine', 'src', 'cli.ts'), cliSource);
}

function runShim(): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', [shim], {
    input: JSON.stringify({ prompt: 'how is the garmin sync', cwd: root }),
    env: { ...process.env, CORTEX_LOG_DIR: logDir, CORTEX_ONNX_LD_PATH: '/nonexistent' },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const logFile = () => path.join(logDir, 'prompt-recall.log');

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'cortex-prompt-recall-shim-'));
  mkdirSync(path.join(root, 'hooks', 'scripts'), { recursive: true });
  mkdirSync(path.join(root, 'engine', 'src'), { recursive: true });
  shim = path.join(root, 'hooks', 'scripts', 'prompt-recall.sh');
  copyFileSync(REAL_SHIM, shim);
  logDir = path.join(root, 'state', 'cortex');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('prompt-recall hook shim', () => {
  test('passes the injected block through and logs each warning line with a timestamp', () => {
    withCli(`
      await Bun.stdin.text();
      process.stdout.write('<!-- CORTEX_RECALL_START -->\\nblock\\n<!-- CORTEX_RECALL_END -->\\n');
      process.stderr.write('[cortex] WARN: prompt-recall fell back to keyword search: embedder down\\n');
      process.stderr.write('[cortex] WARN: second line\\n');
    `);

    const result = runShim();

    expect(result).toEqual({
      status: 0,
      stdout: '<!-- CORTEX_RECALL_START -->\nblock\n<!-- CORTEX_RECALL_END -->\n',
      stderr: '',
    });
    const lines = readFileSync(logFile(), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z \[cortex\] WARN: prompt-recall fell back to keyword search: embedder down$/,
    );
    expect(lines[1]).toMatch(/ \[cortex\] WARN: second line$/);
  });

  test('a healthy recall writes no log at all', () => {
    withCli(`await Bun.stdin.text(); process.stdout.write('ok\\n');`);

    expect(runShim()).toEqual({ status: 0, stdout: 'ok\n', stderr: '' });
    expect(existsSync(logDir)).toBe(false);
  });

  test('a crashing CLI never fails the prompt, and its error lands in the log', () => {
    withCli(`await Bun.stdin.text(); console.error('boom'); process.exit(1);`);

    expect(runShim()).toEqual({ status: 0, stdout: '', stderr: '' });
    expect(readFileSync(logFile(), 'utf8')).toMatch(/ boom\n$/);
  });

  test('rotates the log once it passes 1 MiB, keeping one previous file', () => {
    withCli(`await Bun.stdin.text(); console.error('fresh warning');`);
    mkdirSync(logDir, { recursive: true });
    writeFileSync(logFile(), 'x'.repeat(1_048_577));

    expect(runShim().status).toBe(0);

    expect(statSync(`${logFile()}.1`).size).toBe(1_048_577);
    expect(readFileSync(logFile(), 'utf8')).toMatch(/ fresh warning\n$/);
  });
});
