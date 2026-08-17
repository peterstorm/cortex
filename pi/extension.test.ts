import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import registerCortex from './extension.js';
import type { CliDetachedOptions, CliRunOptions, CliRunResult, CliRunner } from './cli-runner.js';

// This file mocks no MODULE. The engine boundary is a port (CliRunner), so the
// extension's behaviour is driven with the plain object below instead of
// `vi.mock('node:child_process', ...)` — a seam whose hoisting requirements
// differ between vitest and bun's vitest shim, and which killed every test in
// this file at import twice (fixed in 153e032, reverted in e1b26f3). The real
// adapter's own behaviour is covered by cli-runner.test.ts, against real
// subprocesses. (The two vi.fn() calls further down are plain spies on a
// caller-supplied notify callback — no module is intercepted.)
type RecordedCall = { args: readonly string[]; options?: CliRunOptions | CliDetachedOptions };

function fakeCli() {
  const runs: RecordedCall[] = [];
  const detached: RecordedCall[] = [];
  let nextResult: CliRunResult = { ok: true, output: '' };

  const runner: CliRunner = {
    run(args, options) {
      runs.push({ args, options });
      return nextResult;
    },
    runDetached(args, options) {
      detached.push({ args, options });
    },
  };

  return {
    runner,
    runs,
    detached,
    answerWith(result: CliRunResult) { nextResult = result; },
  };
}

const originalMarker = process.env.CORTEX_EXTRACTING;
const originalHome = process.env.HOME;
const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cortex-pi-extension-'));
  tempDirs.push(dir);
  return dir;
}

function registerHandlers(cli: CliRunner): Map<string, (...args: unknown[]) => unknown> {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerCortex({
    on: (name: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(name, handler);
    },
    registerCommand: (name: string, command: { handler: (...args: unknown[]) => unknown }) => {
      handlers.set(`command:${name}`, command.handler);
    },
  } as never, cli);
  return handlers;
}

function sessionContext(cwd: string, overrides: {
  transcriptPath?: string;
  sessionId?: string;
  model?: { provider: string; id: string };
} = {}) {
  return {
    cwd,
    model: overrides.model,
    sessionManager: {
      getSessionFile: () => overrides.transcriptPath,
      getSessionId: () => overrides.sessionId,
    },
  };
}

afterEach(() => {
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
    const cli = fakeCli();
    const handlers = registerHandlers(cli.runner);

    process.env.CORTEX_EXTRACTING = '1';
    const context = new Proxy({}, {
      get: () => {
        throw new Error('shutdown pipeline accessed context');
      },
    });

    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(
        handlers.get('session_shutdown')?.({ reason: 'quit' }, context),
      ).resolves.toBeUndefined();
      expect(cli.detached).toHaveLength(0);
      // The skip is announced: a pipeline that silently does nothing reads
      // exactly like one that ran and found nothing.
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('nested extraction child'),
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('skips the pipeline with a diagnostic on a reload shutdown', async () => {
    const cli = fakeCli();
    const handlers = registerHandlers(cli.runner);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await handlers.get('session_shutdown')?.({ reason: 'reload' }, sessionContext(tempProject()));

      expect(cli.detached).toHaveLength(0);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("reason='reload'"));
    } finally {
      stderr.mockRestore();
    }
  });

  // The fail-closed guard in front of every reason. A pi version that adds a
  // reason must not have it laundered into a policy that never reviewed it.
  it('refuses an unrecognized shutdown reason instead of running the pipeline', async () => {
    const cli = fakeCli();
    const handlers = registerHandlers(cli.runner);
    const cwd = tempProject();
    const transcriptPath = join(cwd, 'pi-session.jsonl');
    writeFileSync(transcriptPath, '{"type":"session"}\n');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      await handlers.get('session_shutdown')?.(
        { reason: 'hibernate' },
        sessionContext(cwd, { transcriptPath, sessionId: 'session-unknown-reason' }),
      );

      expect(cli.detached).toHaveLength(0);
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("Unknown session_shutdown reason 'hibernate'"),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('enqueues one detached ingestion worker carrying the transcript and model', async () => {
    const cli = fakeCli();
    const handlers = registerHandlers(cli.runner);
    const cwd = tempProject();
    const transcriptPath = join(cwd, 'pi-session.jsonl');
    writeFileSync(transcriptPath, '{"type":"session"}\n');
    const context = sessionContext(cwd, {
      transcriptPath,
      sessionId: 'session-123',
      model: { provider: 'openai-codex', id: 'gpt-5.6-sol' },
    });

    await handlers.get('session_start')?.({ reason: 'startup' }, context);

    expect(cli.detached).toEqual([
      { args: ['load-surface', cwd], options: { cwd } },
    ]);
    cli.detached.length = 0;

    await handlers.get('session_shutdown')?.({ reason: 'quit' }, context);

    expect(cli.detached).toHaveLength(1);
    const [ingest] = cli.detached;
    expect(ingest.args).toEqual(['ingest-session']);
    expect(ingest.options).toMatchObject({
      cwd,
      env: {
        CORTEX_PI_PROVIDER: 'openai-codex',
        CORTEX_PI_MODEL: 'gpt-5.6-sol',
      },
    });
    expect((ingest.options as CliDetachedOptions).stdin).toBe(JSON.stringify({
      session_id: 'session-123',
      transcript_path: transcriptPath,
      cwd,
    }));
  });

  it('spawns no worker when an ephemeral session has no transcript (subagent shutdown)', async () => {
    const cli = fakeCli();
    const handlers = registerHandlers(cli.runner);
    const cwd = tempProject();
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await handlers.get('session_shutdown')?.(
        { reason: 'quit' },
        sessionContext(cwd, { sessionId: 'ephemeral-session', model: { provider: 'openai-codex', id: 'gpt-5.6-sol' } }),
      );

      // Ephemeral sessions (subagent spawns use --no-session) never run
      // extraction, so nothing new entered the store. Maintenance would only
      // burn LLM budget (ai-prune, semantic-edges) competing with the live
      // agents that spawned the session, and the spawning session's own
      // ingest-session pipeline already maintains the store.
      expect(cli.detached).toHaveLength(0);
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining('extraction and maintenance skipped (ephemeral session)'),
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it('falls back to session-start metadata and model when shutdown context omits them', async () => {
    const cli = fakeCli();
    const handlers = registerHandlers(cli.runner);
    const cwd = tempProject();
    const transcriptPath = join(cwd, 'pi-session.jsonl');
    writeFileSync(transcriptPath, '{}\n');

    await handlers.get('session_start')?.({}, sessionContext(cwd, {
      transcriptPath,
      sessionId: 'session-at-start',
      model: { provider: 'provider-at-start', id: 'model-at-start' },
    }));
    cli.detached.length = 0;

    await handlers.get('session_shutdown')?.({ reason: 'quit' }, sessionContext(cwd));

    const [ingest] = cli.detached;
    expect((ingest.options as CliDetachedOptions).env).toMatchObject({
      CORTEX_PI_PROVIDER: 'provider-at-start',
      CORTEX_PI_MODEL: 'model-at-start',
    });
    expect((ingest.options as CliDetachedOptions).stdin).toBe(JSON.stringify({
      session_id: 'session-at-start',
      transcript_path: transcriptPath,
      cwd,
    }));
  });
});

describe('Cortex Pi extension diagnostics and surface contract', () => {
  it('shows cortex-status CLI failures as errors instead of no-data info', async () => {
    const cli = fakeCli();
    cli.answerWith({ ok: false, error: 'CLI failed: bun inspect (status=2): database is corrupt' });
    const handlers = registerHandlers(cli.runner);
    const cwd = tempProject();
    const notify = vi.fn();

    await handlers.get('command:cortex-status')?.('', { cwd, ui: { notify } });

    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining('Cortex status failed:'),
      'error',
    );
    expect(notify).not.toHaveBeenCalledWith(
      'No cortex data found for this project',
      'info',
    );
  });

  it('reports no cortex data when the status command succeeds with empty output', async () => {
    const cli = fakeCli();
    cli.answerWith({ ok: true, output: '' });
    const handlers = registerHandlers(cli.runner);
    const notify = vi.fn();

    await handlers.get('command:cortex-status')?.('', { cwd: tempProject(), ui: { notify } });

    expect(notify).toHaveBeenCalledWith('No cortex data found for this project', 'info');
  });

  it('degrades to the system prompt alone when prompt-recall fails', async () => {
    const cli = fakeCli();
    cli.answerWith({ ok: false, error: 'CLI failed: bun prompt-recall (status=2): database is corrupt' });
    const handlers = registerHandlers(cli.runner);
    const cwd = tempProject();

    const result = (await handlers.get('before_agent_start')?.(
      { systemPrompt: 'base', prompt: 'remember this' },
      { cwd },
    )) as { systemPrompt: string; message?: unknown };

    expect(cli.runs).toHaveLength(1);
    expect(cli.runs[0].args).toEqual(['prompt-recall']);
    // A failed recall contributes nothing rather than injecting an error blob.
    expect(result.message).toBeUndefined();
    expect(result.systemPrompt).toContain('Cortex Memory CLI');
  });

  it('reports an unreadable existing Gemini environment file', () => {
    const home = tempProject();
    const envPath = join(home, '.config', 'sops-nix', 'secrets', 'rendered', 'gemini-env');
    mkdirSync(envPath, { recursive: true });
    process.env.HOME = home;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      registerHandlers(fakeCli().runner);
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
    const handlers = registerHandlers(fakeCli().runner);

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

  it('injects the cached memory surface and the CLI path into the agent start prompt', async () => {
    // Happy path: a readable surface file is surfaced to the agent as a
    // hidden cortex-memory message, and the system prompt carries the
    // resolved plugin root so ${CLAUDE_PLUGIN_ROOT} commands work.
    const cwd = tempProject();
    const surfacePath = join(cwd, '.claude', 'cortex-memory.local.md');
    mkdirSync(dirname(surfacePath), { recursive: true });
    writeFileSync(surfacePath, 'Recall: use the functional core pattern');
    const handlers = registerHandlers(fakeCli().runner);

    const result = (await handlers.get('before_agent_start')?.(
      { systemPrompt: 'base prompt', prompt: '' },
      { cwd },
    )) as {
      systemPrompt: string;
      message?: { customType: string; content: string; display: boolean };
    };

    expect(result.systemPrompt.startsWith('base prompt')).toBe(true);
    expect(result.systemPrompt).toContain('Cortex Memory CLI');
    expect(result.systemPrompt).toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(result.message?.customType).toBe('cortex-memory');
    expect(result.message?.content).toBe('Recall: use the functional core pattern');
    expect(result.message?.display).toBe(false);
  });

  it('returns only the system prompt when no surface exists and the prompt is empty', async () => {
    const cwd = tempProject();
    const handlers = registerHandlers(fakeCli().runner);

    const result = (await handlers.get('before_agent_start')?.(
      { systemPrompt: 'base prompt', prompt: '' },
      { cwd },
    )) as { systemPrompt: string; message?: unknown };

    expect(result.systemPrompt).toContain('Cortex Memory CLI');
    expect(result.message).toBeUndefined();
  });
});
