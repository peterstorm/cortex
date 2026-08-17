/**
 * Tests for classifyEdges' transport-based strict/tolerant routing (C2 of
 * review-and-fix r18).
 *
 * The real classifyEdges + real parseEdgeClassificationResponse wiring is
 * exercised with an injected transport: direct output ("direct": true) must
 * parse strictly (malformed output throws), subprocess output ("direct":
 * false) must parse tolerantly (prompt-shaped wrapper accepted, garbage
 * reported as unparseable, declines as an empty ok). Reverting the
 * { strict: direct } routing — the v16 C1 fix — must fail these tests.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withBunWhichUnavailable } from './llm-test-helpers.js';
import {
  classifyEdges,
  resetConsecutiveDirectFailuresForTests,
  runLlmPromptDirect,
  type LlmPromptTransport,
} from './claude-llm.js';

const mockResolveOpenAiCompatEndpoint = vi.fn();
const mockChatCompletionText = vi.fn();
vi.mock('./llm-client.js', () => ({
  resolveOpenAiCompatEndpoint: () => mockResolveOpenAiCompatEndpoint(),
  chatCompletionText: (...args: unknown[]) => mockChatCompletionText(...args),
}));

const FAKE_ENDPOINT = { baseUrl: 'http://llm.example/v1', apiKey: 'k', model: 'm' };
const PAIR = {
  source: { id: 'a', content: 'src', summary: 'src s', memory_type: 'context' },
  target: { id: 'b', content: 'tgt', summary: 'tgt s', memory_type: 'pattern' },
} as const;

const wrapperResponse = JSON.stringify({
  edges: [
    { pair_index: 1, source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.8 },
  ],
});

function transportReturning(text: string, direct: boolean): LlmPromptTransport {
  return async () => ({ text, direct });
}

describe('classifyEdges transport routing', () => {
  beforeEach(() => {
    mockResolveOpenAiCompatEndpoint.mockReset();
    mockChatCompletionText.mockReset();
    // The consecutive-failure counter is per-process module state; tests must
    // not inherit saturation state from an earlier test in this file.
    resetConsecutiveDirectFailuresForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('parses direct-endpoint output strictly (schema-guided wrapper shape)', async () => {
    const outcome = await classifyEdges([PAIR], transportReturning(wrapperResponse, true));

    expect(outcome).toEqual({
      kind: 'ok',
      classifications: [
        { pair_index: 1, source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.8 },
      ],
    });
  });

  it('throws on malformed direct-endpoint output so the batch counts as failed', async () => {
    await expect(classifyEdges([PAIR], transportReturning('not json at all', true)))
      .rejects.toThrow(/not valid JSON/);
  });

  it('parses subprocess output tolerantly and accepts the prompt-shaped wrapper', async () => {
    // The C1 regression: the fallback path must accept the {"edges": [...]}
    // shape the prompt requests. The old tolerant parser returned [] here,
    // which permanently retired every edge as a fake decline.
    const outcome = await classifyEdges([PAIR], transportReturning(wrapperResponse, false));

    expect(outcome.kind).toBe('ok');
    if (outcome.kind === 'ok') {
      expect(outcome.classifications).toEqual([
        { pair_index: 1, source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.8 },
      ]);
    }
  });

  it('reports garbage subprocess output as unparseable instead of a silent empty result', async () => {
    const outcome = await classifyEdges([PAIR], transportReturning('this is not JSON', false));

    expect(outcome.kind).toBe('unparseable');
    if (outcome.kind === 'unparseable') expect(outcome.reason).toMatch(/failed to parse/);
  });

  it('reports a genuine decline as an empty ok outcome', async () => {
    const outcome = await classifyEdges(
      [PAIR],
      transportReturning(JSON.stringify({ edges: [] }), false)
    );

    expect(outcome).toEqual({ kind: 'ok', classifications: [] });
  });

  it('returns an empty ok outcome without calling the transport for zero pairs', async () => {
    const transport = vi.fn<LlmPromptTransport>();
    const outcome = await classifyEdges([], transport);

    expect(outcome).toEqual({ kind: 'ok', classifications: [] });
    expect(transport).not.toHaveBeenCalled();
  });

  it('falls back to the subprocess after a direct failure and surfaces consecutive failures', async () => {
    // Real runLlmPromptDirect: the direct call fails, so the subprocess
    // fallback is attempted. The CLI is unavailable (Bun.which stubbed), so
    // the fallback fails fast with a typed error instead of spawning.
    mockResolveOpenAiCompatEndpoint.mockReturnValue(FAKE_ENDPOINT);
    mockChatCompletionText.mockRejectedValue(new Error('LLM API 503'));
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await withBunWhichUnavailable(async () => {
      await expect(runLlmPromptDirect('prompt', 1000)).rejects.toThrow(/CLI not found/);
      await expect(runLlmPromptDirect('prompt', 1000)).rejects.toThrow(/CLI not found/);
    });
    // The second failure warning carries the recurrence signal.
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/2 consecutive direct-endpoint failures/));
    warn.mockRestore();
  });

  it('resets the consecutive-failure counter on a successful direct call', async () => {
    // Failure → success → failure: the third warning must NOT claim a
    // recurrence, because the success in between reset the counter.
    mockResolveOpenAiCompatEndpoint.mockReturnValue(FAKE_ENDPOINT);
    mockChatCompletionText
      .mockRejectedValueOnce(new Error('LLM API 503'))
      .mockResolvedValueOnce('{"edges": []}')
      .mockRejectedValueOnce(new Error('LLM API 503'));
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await withBunWhichUnavailable(async () => {
      await expect(runLlmPromptDirect('prompt', 1000)).rejects.toThrow(/CLI not found/);
      const success = await runLlmPromptDirect('prompt', 1000);
      expect(success).toEqual({ text: '{"edges": []}', direct: true });
      await expect(runLlmPromptDirect('prompt', 1000)).rejects.toThrow(/CLI not found/);
    });
    // Warning 1 = first failure (no suffix); warning 2 = the third call's
    // failure, which must carry no recurrence suffix because the middle
    // success reset the counter.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, expect.stringMatching(/LLM API 503/));
    expect(warn).toHaveBeenNthCalledWith(2, expect.not.stringMatching(/consecutive/));
    warn.mockRestore();
  });

  it('suppresses the subprocess fallback once consecutive direct failures reach the threshold', async () => {
    // A saturated local server (empty content, timeouts) must not escalate
    // into `claude -p` / `pi -p` agent loops: below the threshold a single
    // transient failure still falls back, but at the default threshold of 3
    // the call throws so the caller defers the work to the next run.
    mockResolveOpenAiCompatEndpoint.mockReturnValue(FAKE_ENDPOINT);
    mockChatCompletionText.mockRejectedValue(new Error('LLM API returned empty content'));
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await withBunWhichUnavailable(async () => {
      await expect(runLlmPromptDirect('prompt', 1000)).rejects.toThrow(/CLI not found/);
      await expect(runLlmPromptDirect('prompt', 1000)).rejects.toThrow(/CLI not found/);
      await expect(runLlmPromptDirect('prompt', 1000))
        .rejects.toThrow(/direct LLM endpoint saturated: 3 consecutive failure/);
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringMatching(/suppressing \S+ subprocess fallback after 3 consecutive failure\(s\)/),
    );
    warn.mockRestore();
  });

  it('honors CORTEX_LLM_MAX_DIRECT_FAILURES to tighten the suppression threshold', async () => {
    mockResolveOpenAiCompatEndpoint.mockReturnValue(FAKE_ENDPOINT);
    mockChatCompletionText.mockRejectedValue(new Error('LLM request timed out after 1000ms'));
    const original = process.env.CORTEX_LLM_MAX_DIRECT_FAILURES;
    process.env.CORTEX_LLM_MAX_DIRECT_FAILURES = '1';
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(runLlmPromptDirect('prompt', 1000))
        .rejects.toThrow(/direct LLM endpoint saturated: 1 consecutive failure/);
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/suppressing \S+ subprocess fallback after 1 consecutive failure\(s\)/),
      );
    } finally {
      if (original === undefined) delete process.env.CORTEX_LLM_MAX_DIRECT_FAILURES;
      else process.env.CORTEX_LLM_MAX_DIRECT_FAILURES = original;
      warn.mockRestore();
    }
  });

  it('falls back to the default threshold for invalid CORTEX_LLM_MAX_DIRECT_FAILURES values', async () => {
    // 'abc' → NaN → default 3: the first failure still escalates to the
    // subprocess fallback (which fails fast here, CLI stubbed away) instead
    // of throwing the saturation error the valid-'1' test asserts.
    mockResolveOpenAiCompatEndpoint.mockReturnValue(FAKE_ENDPOINT);
    mockChatCompletionText.mockRejectedValue(new Error('LLM API 503'));
    const original = process.env.CORTEX_LLM_MAX_DIRECT_FAILURES;
    process.env.CORTEX_LLM_MAX_DIRECT_FAILURES = 'abc';
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await withBunWhichUnavailable(async () => {
        await expect(runLlmPromptDirect('prompt', 1000)).rejects.toThrow(/CLI not found/);
        expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/direct LLM endpoint saturated/));
      });
    } finally {
      if (original === undefined) delete process.env.CORTEX_LLM_MAX_DIRECT_FAILURES;
      else process.env.CORTEX_LLM_MAX_DIRECT_FAILURES = original;
      warn.mockRestore();
    }
  });

  it('returns the subprocess text with direct:false when no endpoint is configured', async () => {
    // No OpenAI-compatible endpoint → runLlmPromptDirectUnbounded skips the
    // direct attempt entirely and the real Bun.spawn-based subprocess path
    // produces the text. The flag must say direct:false so callers route
    // subprocess output to the tolerant parser.
    mockResolveOpenAiCompatEndpoint.mockReturnValue(null);
    const bunGlobal = (globalThis as {
      Bun?: {
        which: (bin: string) => string | null;
        spawn: (args: string[], opts: unknown) => unknown;
      };
    }).Bun!;
    const originalWhich = bunGlobal.which;
    const originalSpawn = bunGlobal.spawn;
    const emptyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const stdoutStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('unbounded-fallback-output'));
        controller.close();
      },
    });
    bunGlobal.which = () => '/fake/llm-cli';
    bunGlobal.spawn = (() => ({
      stdin: { write: () => undefined, end: () => undefined },
      stdout: stdoutStream,
      stderr: emptyStream,
      exited: Promise.resolve(0),
      kill: () => undefined,
    })) as unknown as typeof originalSpawn;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(runLlmPromptDirect('prompt', 1000)).resolves.toEqual({
        text: 'unbounded-fallback-output',
        direct: false,
      });
    } finally {
      bunGlobal.which = originalWhich;
      bunGlobal.spawn = originalSpawn;
      stderr.mockRestore();
    }
  });
});
