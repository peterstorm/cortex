import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  if (originalMarker === undefined) delete process.env.CORTEX_EXTRACTING;
  else process.env.CORTEX_EXTRACTING = originalMarker;
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

  it('enqueues one detached ingestion worker without awaiting transcript processing', async () => {
    const stdin = { write: vi.fn(), end: vi.fn() };
    const unref = vi.fn();
    childProcess.spawn.mockReturnValue({ stdin, unref } as never);
    const handlers = registerHandlers();
    const tempDir = mkdtempSync(join(tmpdir(), 'cortex-pi-extension-'));
    const transcriptPath = join(tempDir, 'pi-session.jsonl');
    writeFileSync(transcriptPath, '{"type":"session"}\n');

    await handlers.get('session_start')?.(
      { reason: 'startup' },
      {
        cwd: '/project',
        model: { provider: 'openai-codex', id: 'gpt-5.6-sol' },
        sessionManager: {
          getSessionFile: () => transcriptPath,
          getSessionId: () => 'session-123',
        },
      },
    );

    expect(childProcess.spawn).toHaveBeenCalledWith(
      'bun',
      [expect.stringMatching(/engine\/src\/cli\.ts$/), 'load-surface', '/project'],
      expect.objectContaining({
        cwd: '/project',
        detached: true,
        stdio: ['ignore', 'ignore', 'ignore'],
      }),
    );
    childProcess.spawn.mockClear();
    stdin.write.mockClear();
    stdin.end.mockClear();
    unref.mockClear();

    await handlers.get('session_shutdown')?.(
      { reason: 'quit' },
      {
        cwd: '/project',
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
      cwd: '/project',
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      env: {
        CORTEX_PI_PROVIDER: 'openai-codex',
        CORTEX_PI_MODEL: 'gpt-5.6-sol',
      },
    });
    expect(stdin.write).toHaveBeenCalledWith(JSON.stringify({
      session_id: 'session-123',
      transcript_path: transcriptPath,
      cwd: '/project',
    }));
    expect(stdin.end).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();

    rmSync(tempDir, { recursive: true, force: true });
  });
});
