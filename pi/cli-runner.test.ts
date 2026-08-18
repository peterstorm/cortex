import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { describeError, nodeCliRunner } from './cli-runner.js';

// The adapter is the one place that touches node:child_process, and it is
// tested against REAL subprocesses rather than a mocked module: the behaviour
// worth pinning here (does the environment arrive, does stdin arrive, is the
// detached child's output captured to the project log) only exists once a
// process actually starts. Nothing is hoisted, so nothing here can be broken
// by a runner's mock semantics. Each test points the runner at a throwaway
// script instead of the engine CLI, which is exactly what the `cliPath`
// parameter is for.
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cortex-cli-runner-'));
  tempDirs.push(dir);
  return dir;
}

/** Write a throwaway script and return its path. */
function script(dir: string, body: string): string {
  const path = join(dir, 'fake-cli.ts');
  writeFileSync(path, body);
  return path;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for the detached child');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('describeError', () => {
  it('uses the message of an Error', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('stringifies a non-Error', () => {
    expect(describeError('plain string')).toBe('plain string');
    expect(describeError(42)).toBe('42');
  });
});

describe('nodeCliRunner.run', () => {
  it('passes args through and returns trimmed stdout', () => {
    const dir = tempDir();
    const cli = nodeCliRunner(script(dir, 'console.log("  " + process.argv.slice(2).join("|") + "  ");'), {});

    expect(cli.run(['inspect', '/some/cwd'])).toEqual({ ok: true, output: 'inspect|/some/cwd' });
  });

  it('delivers stdin to the child', () => {
    const dir = tempDir();
    const cli = nodeCliRunner(
      script(dir, 'process.stdout.write(await Bun.stdin.text());'),
      {},
    );

    expect(cli.run(['ingest'], { stdin: '{"session_id":"s-1"}' }))
      .toEqual({ ok: true, output: '{"session_id":"s-1"}' });
  });

  it('layers per-call env over the adapter base env, both on top of process.env', () => {
    const dir = tempDir();
    const cli = nodeCliRunner(
      script(dir, 'console.log(JSON.stringify({ root: process.env.CORTEX_PLUGIN_ROOT, provider: process.env.CORTEX_PI_PROVIDER, path: process.env.PATH !== undefined }));'),
      { CORTEX_PLUGIN_ROOT: '/plugin/root' },
    );

    const result = cli.run(['x'], { env: { CORTEX_PI_PROVIDER: 'openai-codex' } });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(JSON.parse(result.output)).toEqual({
      root: '/plugin/root',
      provider: 'openai-codex',
      path: true,
    });
  });

  it('runs in the requested cwd', () => {
    const dir = tempDir();
    const workdir = tempDir();
    const cli = nodeCliRunner(script(dir, 'console.log(process.cwd());'), {});

    const result = cli.run(['pwd'], { cwd: workdir });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain(workdir.split('/').pop()!);
  });

  it('reports a failing command with its status and stderr instead of empty output', () => {
    const dir = tempDir();
    const cli = nodeCliRunner(
      script(dir, 'process.stderr.write("database is corrupt\\n"); process.exit(2);'),
      {},
    );

    const result = cli.run(['inspect'], { cwd: dir });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('status=2');
    expect(result.error).toContain('database is corrupt');
    expect(result.error).toContain('inspect');
  });

  it('never throws when the binary cannot run the script at all', () => {
    const dir = tempDir();
    const cli = nodeCliRunner(join(dir, 'does-not-exist.ts'), {});

    const result = cli.run(['anything'], { cwd: dir });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('anything');
  });

  it('gives up on a child that outlives its timeout', () => {
    const dir = tempDir();
    const cli = nodeCliRunner(script(dir, 'await new Promise(() => {});'), {});

    const result = cli.run(['hang'], { cwd: dir, timeout: 300 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Named as a timeout, not lumped in with exit-status failures: the
      // runtime reports 'ETIMEDOUT', which the previous substring test for
      // "TIMEOUT" never matched.
      expect(result.error).toContain('CLI timeout');
      expect(result.error).toContain('hang');
    }
  });
});

describe('nodeCliRunner.runDetached', () => {
  it('starts the child without awaiting it and captures output to the project log', async () => {
    const dir = tempDir();
    const workdir = tempDir();
    const marker = join(workdir, 'ran.txt');
    const cli = nodeCliRunner(
      script(dir, `console.log("detached output"); await Bun.write(${JSON.stringify(marker)}, "done");`),
      {},
    );

    cli.runDetached(['load-surface', workdir], { cwd: workdir });

    await waitFor(() => existsSync(marker));
    expect(readFileSync(marker, 'utf-8')).toBe('done');

    const logPath = join(workdir, '.memory', 'logs', 'pi-detached.log');
    expect(existsSync(logPath)).toBe(true);
    await waitFor(() => readFileSync(logPath, 'utf-8').includes('detached output'));
  });

  it('delivers stdin and env to a detached child', async () => {
    const dir = tempDir();
    const workdir = tempDir();
    const marker = join(workdir, 'received.json');
    const cli = nodeCliRunner(
      script(dir, `const stdin = await Bun.stdin.text(); await Bun.write(${JSON.stringify(marker)}, JSON.stringify({ stdin, provider: process.env.CORTEX_PI_PROVIDER, root: process.env.CORTEX_PLUGIN_ROOT }));`),
      { CORTEX_PLUGIN_ROOT: '/plugin/root' },
    );

    cli.runDetached(['ingest-session'], {
      cwd: workdir,
      stdin: '{"session_id":"s-9"}',
      env: { CORTEX_PI_PROVIDER: 'openai-codex' },
    });

    await waitFor(() => existsSync(marker));
    expect(JSON.parse(readFileSync(marker, 'utf-8'))).toEqual({
      stdin: '{"session_id":"s-9"}',
      provider: 'openai-codex',
      root: '/plugin/root',
    });
  });

  it('reports a log-directory failure and still starts the child', async () => {
    const dir = tempDir();
    const workdir = tempDir();
    // .memory is a FILE, so creating .memory/logs must fail. The child still
    // has to run — diagnostics are best-effort, the pipeline is not.
    writeFileSync(join(workdir, '.memory'), 'not a directory');
    const marker = join(workdir, 'ran.txt');
    const cli = nodeCliRunner(script(dir, `await Bun.write(${JSON.stringify(marker)}, "done");`), {});

    const written: string[] = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      cli.runDetached(['load-surface', workdir], { cwd: workdir });
      await waitFor(() => existsSync(marker));
    } finally {
      process.stderr.write = original;
    }

    expect(written.join('')).toContain('detached CLI log setup failed');
  });

  it('never throws when the detached script does not exist', () => {
    const workdir = tempDir();
    const cli = nodeCliRunner(join(workdir, 'missing.ts'), {});

    expect(() => cli.runDetached(['load-surface', workdir], { cwd: workdir })).not.toThrow();
  });
});
