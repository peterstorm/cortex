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
import {
  classifyEdges,
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
    // Stub the CLI lookup so the subprocess fallback fails fast with a typed
    // error instead of spawning. (globalThis cast avoids a Bun-global typing
    // dependency in this file.)
    const bunGlobal = (globalThis as { Bun?: { which: (bin: string) => string | null } }).Bun;
    const originalWhich = bunGlobal!.which;
    bunGlobal!.which = () => null;
    try {
      await expect(runLlmPromptDirect('prompt', 1000)).rejects.toThrow(/CLI not found/);
      await expect(runLlmPromptDirect('prompt', 1000)).rejects.toThrow(/CLI not found/);
    } finally {
      bunGlobal!.which = originalWhich;
    }
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
    const bunGlobal = (globalThis as { Bun?: { which: (bin: string) => string | null } }).Bun;
    const originalWhich = bunGlobal!.which;
    bunGlobal!.which = () => null;
    try {
      await expect(runLlmPromptDirect('prompt', 1000)).rejects.toThrow(/CLI not found/);
      const success = await runLlmPromptDirect('prompt', 1000);
      expect(success).toEqual({ text: '{"edges": []}', direct: true });
      await expect(runLlmPromptDirect('prompt', 1000)).rejects.toThrow(/CLI not found/);
    } finally {
      bunGlobal!.which = originalWhich;
    }
    // Warning 1 = first failure (no suffix); warning 2 = the third call's
    // failure, which must carry no recurrence suffix because the middle
    // success reset the counter.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenNthCalledWith(1, expect.stringMatching(/LLM API 503/));
    expect(warn).toHaveBeenNthCalledWith(2, expect.not.stringMatching(/consecutive/));
    warn.mockRestore();
  });
});
