/**
 * End to end through the prompt-recall log's two writers.
 *
 * The real UserPromptSubmit shim (hooks/scripts/prompt-recall.sh), with a
 * stand-in CLI so each outcome can be forced: the shim hands the CLI's stdout
 * to Claude Code untouched and logs the CLI's stderr only when the CLI crashed.
 *
 * The real CLI, which logs its own warnings: that is what makes a degraded
 * recall visible under Pi, whose extension runs the CLI with no shim and keeps
 * no stderr from a run that exits 0. Before the log, a degraded recall
 * (embedder down → keyword search) left no trace under either harness.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promptRecallLogPath } from './infra/prompt-recall-log.js';

const REAL_SHIM = fileURLToPath(new URL('../../hooks/scripts/prompt-recall.sh', import.meta.url));
const REAL_CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const STAMPED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z /;

let root: string;
let shim: string;
let logDir: string;

/** Lay out a plugin root whose engine/src/cli.ts is `cliSource`. */
function withCli(cliSource: string): void {
  writeFileSync(path.join(root, 'engine', 'src', 'cli.ts'), cliSource);
}

function runShim(env: NodeJS.ProcessEnv = { CORTEX_LOG_DIR: logDir }): {
  status: number | null;
  stdout: string;
  stderr: string;
} {
  // The caller's env decides the log location, so none is inherited.
  const { CORTEX_LOG_DIR: _inherited, ...inherited } = process.env;
  const result = spawnSync('bash', [shim], {
    input: JSON.stringify({ prompt: 'how is the garmin sync', cwd: root }),
    env: { ...inherited, CORTEX_ONNX_LD_PATH: '/nonexistent', ...env },
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
  test('passes the injected block through and leaves a healthy exit`s stderr to the CLI', () => {
    // The CLI logs its own warnings, so the shim logging them too would
    // record every one twice.
    withCli(`
      await Bun.stdin.text();
      process.stdout.write('<!-- CORTEX_RECALL_START -->\\nblock\\n<!-- CORTEX_RECALL_END -->\\n');
      process.stderr.write('[cortex] WARN: logged by the CLI itself\\n');
    `);

    expect(runShim()).toEqual({
      status: 0,
      stdout: '<!-- CORTEX_RECALL_START -->\nblock\n<!-- CORTEX_RECALL_END -->\n',
      stderr: '',
    });
    expect(existsSync(logDir)).toBe(false);
  });

  test('a crashing CLI never fails the prompt, and each stderr line lands in the log, stamped', () => {
    withCli(`await Bun.stdin.text(); console.error('boom'); console.error('second line'); process.exit(1);`);

    expect(runShim()).toEqual({ status: 0, stdout: '', stderr: '' });
    const lines = readFileSync(logFile(), 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(new RegExp(`${STAMPED.source}boom$`));
    expect(lines[1]).toMatch(new RegExp(`${STAMPED.source}second line$`));
  });

  test('rotates the log once it passes 1 MiB, keeping one previous file', () => {
    withCli(`await Bun.stdin.text(); console.error('fresh crash'); process.exit(1);`);
    mkdirSync(logDir, { recursive: true });
    writeFileSync(logFile(), 'x'.repeat(1_048_577));

    expect(runShim().status).toBe(0);

    expect(statSync(`${logFile()}.1`).size).toBe(1_048_577);
    expect(readFileSync(logFile(), 'utf8')).toMatch(/ fresh crash\n$/);
  });

  test('without CORTEX_LOG_DIR it writes where the engine writes', () => {
    withCli(`await Bun.stdin.text(); console.error('crash'); process.exit(1);`);
    const env = { XDG_STATE_HOME: path.join(root, 'xdg'), HOME: path.join(root, 'home') };

    runShim(env);

    expect(readFileSync(promptRecallLogPath(env, '/unused'), 'utf8')).toMatch(/ crash\n$/);
  });
});

describe('the real prompt-recall CLI', () => {
  test('logs its own warning on a run that exits 0, with no shim in between (the Pi path)', () => {
    const result = spawnSync('bun', [REAL_CLI, 'prompt-recall'], {
      input: JSON.stringify({ prompt: 42 }),
      env: { ...process.env, CORTEX_LOG_DIR: logDir },
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('prompt-recall ignored malformed input');
    expect(readFileSync(logFile(), 'utf8')).toMatch(
      new RegExp(`${STAMPED.source}\\[cortex\\] WARN: prompt-recall ignored malformed input: expected string prompt and cwd\\n$`),
    );
  });
});
