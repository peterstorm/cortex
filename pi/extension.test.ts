import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const childProcess = {
  execFileSync: vi.fn(() => ''),
  spawn: vi.fn(),
};

vi.mock('node:child_process', () => childProcess);

import registerCortex from './extension.js';

const originalMarker = process.env.CORTEX_EXTRACTING;
const originalHome = process.env.HOME;
const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cortex-pi-extension-'));
  tempDirs.push(dir);
  return dir;
}

function fakeChild() {
  return {
    stdin: { write: vi.fn(), end: vi.fn(), once: vi.fn() },
    unref: vi.fn(),
    once: vi.fn(),
  };
}

function registerHandlers(): Map<string, (...args: unknown[]) => unknown> {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerCortex({
    on: (name: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(name, handler);
    },
    registerCommand: () => undefined,
  } as never);
  return handlers;
}

afterEach(() => {
  vi.clearAllMocks();
  childProcess.execFileSync.mockImplementation(() => '');
  if (originalMarker === undefined) delete process.env.CORTEX_EXTRACTING;
  else process.env.CORTEX_EXTRACTING = originalMarker;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('Cortex Pi extension shutdown', () => {
  it('returns before touching session context in an extraction child', async () => {
    const handlers = registerHandlers();

    process.env.CORTEX_EXTRACTING = '1';
    const context = new Proxy({}, {
      get: () => {
        throw new Error('shutdown pipeline accessed context');
      },
    });

    await expect(
      handlers.get('session_shutdown')?.({ reason: 'quit' }, context),
    ).resolves.toBeUndefined();
    expect(childProcess.spawn).not.toHaveBeenCalled();
  });

  it('enqueues one detached ingestion worker with project-local diagnostics', async () => {
    const child = fakeChild();
    childProcess.spawn.mockReturnValue(child as never);
    const handlers = registerHandlers();
    const cwd = tempProject();
    const transcriptPath = join(cwd, 'pi-session.jsonl');
    writeFileSync(transcriptPath, '{"type":"session"}\n');

    await handlers.get('session_start')?.(
      { reason: 'startup' },
      {
        cwd,
        model: { provider: 'openai-codex', id: 'gpt-5.6-sol' },
        sessionManager: {
          getSessionFile: () => transcriptPath,
          getSessionId: () => 'session-123',
        },
      },
    );

    expect(childProcess.spawn).toHaveBeenCalledWith(
      'bun',
      [expect.stringMatching(/engine\/src\/cli\.ts$/), 'load-surface', cwd],
      expect.objectContaining({
        cwd,
        detached: true,
        stdio: ['ignore', expect.any(Number), expect.any(Number)],
      }),
    );
    expect(existsSync(join(cwd, '.memory', 'logs', 'pi-detached.log'))).toBe(true);
    childProcess.spawn.mockClear();
    child.stdin.write.mockClear();
    child.stdin.end.mockClear();
    child.unref.mockClear();

    await handlers.get('session_shutdown')?.(
      { reason: 'quit' },
      {
        cwd,
        model: { provider: 'openai-codex', id: 'gpt-5.6-sol' },
        sessionManager: {
          getSessionFile: () => transcriptPath,
          getSessionId: () => 'session-123',
        },
      },
    );

    expect(childProcess.spawn).toHaveBeenCalledTimes(1);
    const [binary, args, options] = childProcess.spawn.mock.calls[0];
    expect(binary).toBe('bun');
    expect(args).toEqual([expect.stringMatching(/engine\/src\/cli\.ts$/), 'ingest-session']);
    expect(options).toMatchObject({
      cwd,
      detached: true,
      stdio: ['pipe', expect.any(Number), expect.any(Number)],
      env: {
        CORTEX_PI_PROVIDER: 'openai-codex',
        CORTEX_PI_MODEL: 'gpt-5.6-sol',
      },
    });
    expect(child.stdin.write).toHaveBeenCalledWith(JSON.stringify({
      session_id: 'session-123',
      transcript_path: transcriptPath,
      cwd,
    }));
    expect(child.stdin.end).toHaveBeenCalledOnce();
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it('falls back to session-start metadata and model when shutdown context omits them', async () => {
    const child = fakeChild();
    childProcess.spawn.mockReturnValue(child as never);
    const handlers = registerHandlers();
    const cwd = tempProject();
    const transcriptPath = join(cwd, 'pi-session.jsonl');
    writeFileSync(transcriptPath, '{}\n');

    await handlers.get('session_start')?.({}, {
      cwd,
      model: { provider: 'provider-at-start', id: 'model-at-start' },
      sessionManager: {
        getSessionFile: () => transcriptPath,
        getSessionId: () => 'session-at-start',
      },
    });
    childProcess.spawn.mockClear();

    await handlers.get('session_shutdown')?.({ reason: 'quit' }, {
      cwd,
      model: undefined,
      sessionManager: {
        getSessionFile: () => undefined,
        getSessionId: () => undefined,
      },
    });

    const [, , options] = childProcess.spawn.mock.calls[0];
    expect(options.env).toMatchObject({
      CORTEX_PI_PROVIDER: 'provider-at-start',
      CORTEX_PI_MODEL: 'model-at-start',
    });
    expect(child.stdin.write).toHaveBeenCalledWith(JSON.stringify({
      session_id: 'session-at-start',
      transcript_path: transcriptPath,
      cwd,
    }));
  });
});

describe('Cortex Pi extension diagnostics and surface contract', () => {
  it('reports synchronous CLI failures instead of presenting them as no data', async () => {
    const failure = Object.assign(new Error('bun exited'), {
      status: 2,
      signal: null,
      stderr: Buffer.from('database is corrupt'),
    });
    childProcess.execFileSync.mockImplementationOnce(() => { throw failure; });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const handlers = registerHandlers();
    const cwd = tempProject();

    try {
      await handlers.get('before_agent_start')?.(
        { systemPrompt: 'base', prompt: 'remember this' },
        { cwd },
      );
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('status=2'));
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('database is corrupt'));
    } finally {
      stderr.mockRestore();
    }
  });

  it('reports detached spawn errors without making the handler await the child', async () => {
    const child = fakeChild();
    child.once.mockImplementation((event: string, listener: (error: Error) => void) => {
      if (event === 'error') listener(new Error('spawn EACCES'));
      return child;
    });
    childProcess.spawn.mockReturnValue(child as never);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const handlers = registerHandlers();
    const cwd = tempProject();

    try {
      await handlers.get('session_start')?.({}, {
        cwd,
        model: undefined,
        sessionManager: { getSessionFile: () => undefined, getSessionId: () => 's' },
      });
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('spawn EACCES'));
      expect(child.unref).toHaveBeenCalledOnce();
    } finally {
      stderr.mockRestore();
    }
  });

  it('reports an unreadable existing Gemini environment file', () => {
    const home = tempProject();
    const envPath = join(home, '.config', 'sops-nix', 'secrets', 'rendered', 'gemini-env');
    mkdirSync(envPath, { recursive: true });
    process.env.HOME = home;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      registerHandlers();
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`Failed to read Gemini environment file ${envPath}`));
    } finally {
      stderr.mockRestore();
    }
  });

  it('reads only the unified .claude surface and reports read failures', async () => {
    const cwd = tempProject();
    const surfacePath = join(cwd, '.claude', 'cortex-memory.local.md');
    mkdirSync(surfacePath, { recursive: true });
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const handlers = registerHandlers();

    try {
      await handlers.get('before_agent_start')?.(
        { systemPrompt: 'base', prompt: '' },
        { cwd },
      );
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining(`Failed to read memory surface ${surfacePath}`));
      expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining('/.pi/cortex-memory.local.md'));
    } finally {
      stderr.mockRestore();
    }
  });
});
