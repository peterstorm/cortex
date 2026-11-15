/**
 * Tests for edge classification pure functions (prompt building + response parsing).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import {
  buildEdgeClassificationPrompt,
  buildLlmInvocation,
  parseEdgeClassificationResponse,
  resetConsecutiveDirectFailuresForTests,
  resetLlmConcurrencyForTests,
  runLlmPrompt,
  runLlmPromptDirect,
  thinkingLevelFor,
  type MemoryPair,
} from './claude-llm.js';
import { resetServedModelCheck } from './llm-client.js';

describe('buildLlmInvocation', () => {
  it('uses the cheap supported Codex model for an active Codex session', () => {
    const invocation = buildLlmInvocation({
      PI_CODING_AGENT: 'true',
      CORTEX_PI_PROVIDER: 'openai-codex',
      CORTEX_PI_MODEL: 'gpt-5.6-terra',
    });

    expect(invocation).toEqual({
      binary: 'pi',
      args: ['pi', '-p', '--provider', 'openai-codex', '--model', 'gpt-5.4-mini', '--thinking', 'off', '--no-session'],
      provider: 'openai-codex',
      model: 'gpt-5.4-mini',
      thinking: 'off',
    });
  });

  it('uses the cheap supported Anthropic model regardless of the session model', () => {
    const invocation = buildLlmInvocation({
      PI_CODING_AGENT: 'true',
      CORTEX_PI_PROVIDER: 'anthropic',
      CORTEX_PI_MODEL: 'claude-sonnet-5',
    });

    expect(invocation).toEqual({
      binary: 'pi',
      args: ['pi', '-p', '--provider', 'anthropic', '--model', 'claude-haiku-4-5', '--thinking', 'off', '--no-session'],
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      thinking: 'off',
    });
  });

  it('reuses the active model for a local OpenAI-compatible provider', () => {
    const invocation = buildLlmInvocation({
      PI_CODING_AGENT: 'true',
      CORTEX_PI_PROVIDER: 'desktop-vllm',
      CORTEX_PI_MODEL: 'glm-5.3-flash-exl3-k4-vision-fp8kv-mtp-359k-v11.1',
    });

    expect(invocation).toEqual({
      binary: 'pi',
      args: ['pi', '-p', '--provider', 'desktop-vllm', '--model', 'glm-5.3-flash-exl3-k4-vision-fp8kv-mtp-359k-v11.1', '--thinking', 'off', '--no-session'],
      provider: 'desktop-vllm',
      model: 'glm-5.3-flash-exl3-k4-vision-fp8kv-mtp-359k-v11.1',
      thinking: 'off',
    });
  });

  it('lets explicit extraction settings override automatic Pi selection', () => {
    const invocation = buildLlmInvocation({
      PI_CODING_AGENT: 'true',
      CORTEX_PI_PROVIDER: 'openai-codex',
      CORTEX_LLM_PROVIDER: 'google',
      CORTEX_LLM_MODEL: 'gemini-2.5-flash-lite',
    });

    expect(invocation).toEqual({
      binary: 'pi',
      args: ['pi', '-p', '--provider', 'google', '--model', 'gemini-2.5-flash-lite', '--thinking', 'off', '--no-session'],
      provider: 'google',
      model: 'gemini-2.5-flash-lite',
      thinking: 'off',
    });
  });

  it('reuses the active model for a custom provider rather than guessing an invalid model', () => {
    const invocation = buildLlmInvocation({
      PI_CODING_AGENT: 'true',
      CORTEX_PI_PROVIDER: 'company-proxy',
      CORTEX_PI_MODEL: 'memory-fast-v2',
    });

    expect(invocation).toEqual({
      binary: 'pi',
      args: ['pi', '-p', '--provider', 'company-proxy', '--model', 'memory-fast-v2', '--thinking', 'off', '--no-session'],
      provider: 'company-proxy',
      model: 'memory-fast-v2',
      thinking: 'off',
    });
  });

  it('does not reuse the active model for an unknown provider different from the active one', () => {
    const invocation = buildLlmInvocation({
      PI_CODING_AGENT: 'true',
      CORTEX_PI_PROVIDER: 'openai-codex',
      CORTEX_PI_MODEL: 'gpt-5.6-terra',
      CORTEX_LLM_PROVIDER: 'some-unknown-provider',
    });

    expect(invocation.args).not.toContain('--model');
    expect(invocation).toEqual({
      binary: 'pi',
      args: ['pi', '-p', '--provider', 'some-unknown-provider', '--thinking', 'off', '--no-session'],
      provider: 'some-unknown-provider',
      model: undefined,
      thinking: 'off',
    });
  });

  it('retains Haiku extraction for Claude Code', () => {
    const invocation = buildLlmInvocation({});

    expect(invocation).toEqual({
      binary: 'claude',
      args: ['claude', '-p', '--model', 'haiku', '--output-format', 'text'],
      model: 'haiku',
    });
  });

  it('honors CORTEX_LLM_MODEL in the claude branch', () => {
    const invocation = buildLlmInvocation({ CORTEX_LLM_MODEL: 'opus-4.1' });

    expect(invocation).toEqual({
      binary: 'claude',
      args: ['claude', '-p', '--model', 'opus-4.1', '--output-format', 'text'],
      model: 'opus-4.1',
    });
  });

  it('honors CORTEX_LLM_BINARY as an explicit binary override', () => {
    const invocation = buildLlmInvocation({ CORTEX_LLM_BINARY: 'pi', HOME: '/nonexistent-home' });

    expect(invocation).toEqual({
      binary: 'pi',
      args: ['pi', '-p', '--thinking', 'off', '--no-session'],
      provider: undefined,
      model: undefined,
      thinking: 'off',
    });
  });

  it('passes a requested thinking level through to pi', () => {
    // GLM on Hyperflare has no off switch: asking for "off" gets maximum reasoning, so the
    // fallback asks for the lowest effort the model accepts instead.
    const invocation = buildLlmInvocation({
      PI_CODING_AGENT: 'true',
      CORTEX_PI_PROVIDER: 'desktop-vllm',
      CORTEX_PI_MODEL: 'warmind-1017-native',
    }, 'low');

    expect(invocation.args).toEqual([
      'pi', '-p', '--provider', 'desktop-vllm', '--model', 'warmind-1017-native', '--thinking', 'low', '--no-session',
    ]);
  });

  it('has no thinking flag to set for claude', () => {
    expect(buildLlmInvocation({}, 'low').args).toEqual(['claude', '-p', '--model', 'haiku', '--output-format', 'text']);
  });

  // pi-detached.log: a Copilot session ran every extraction on its own
  // claude-sonnet-5.5 with `--thinking off`, and all 582 calls came back 400.
  it('runs a Copilot session on Haiku 5.5 at the lowest thinking level it accepts', () => {
    const invocation = buildLlmInvocation({
      PI_CODING_AGENT: 'true',
      CORTEX_PI_PROVIDER: 'github-copilot',
      CORTEX_PI_MODEL: 'claude-sonnet-5.5',
    });

    expect(invocation).toEqual({
      binary: 'pi',
      args: ['pi', '-p', '--provider', 'github-copilot', '--model', 'claude-haiku-5.5', '--thinking', 'low', '--no-session'],
      provider: 'github-copilot',
      model: 'claude-haiku-5.5',
      thinking: 'low',
    });
  });

  it('turns off into low for an explicitly configured Claude 5.5 model too', () => {
    const invocation = buildLlmInvocation({
      PI_CODING_AGENT: 'true',
      CORTEX_LLM_PROVIDER: 'github-copilot',
      CORTEX_LLM_MODEL: 'claude-sonnet-5.5',
    });

    expect(invocation.args).toEqual([
      'pi', '-p', '--provider', 'github-copilot', '--model', 'claude-sonnet-5.5', '--thinking', 'low', '--no-session',
    ]);
  });
});

describe('thinkingLevelFor', () => {
  const levels = ['off', 'low', 'medium', 'high'] as const;

  it.each(['claude-haiku-5.5', 'claude-sonnet-5.5', 'claude-opus-5.5', 'Claude-Opus-5.5', 'claude-sonnet-5.5-20261001'])(
    'sends low instead of off to %s, which refuses off',
    (model) => {
      expect(thinkingLevelFor(model, 'off')).toBe('low');
    },
  );

  it.each([
    'claude-haiku-4-5',
    'claude-sonnet-5',
    'claude-sonnet-5.50',
    'gpt-5.4-mini',
    'glm-5.3-flash-hyperflare-tp2-uncensored',
    'my-claude-sonnet-5.5-proxy',
  ])('keeps off for %s', (model) => {
    expect(thinkingLevelFor(model, 'off')).toBe('off');
  });

  it('keeps off when no model is pinned', () => {
    expect(thinkingLevelFor(undefined, 'off')).toBe('off');
  });

  it('only ever raises off, and only to the cheapest level', () => {
    fc.assert(
      fc.property(fc.option(fc.string(), { nil: undefined }), fc.constantFrom(...levels), (model, requested) => {
        const sent = thinkingLevelFor(model, requested);
        expect(sent === requested || (requested === 'off' && sent === 'low')).toBe(true);
      }),
    );
  });
});

describe('subprocess fallback thinking level', () => {
  const ENV = ['PATH', 'HOME', 'PI_CODING_AGENT', 'CORTEX_LLM_API_URL', 'CORTEX_LLM_API_KEY', 'CORTEX_LLM_MODEL',
    'CORTEX_LLM_PROVIDER', 'CORTEX_PI_PROVIDER', 'CORTEX_PI_MODEL', 'PI_PROVIDER', 'PI_MODEL',
    'CORTEX_LLM_REASONING_EFFORT'];
  const saved = new Map<string, string | undefined>();
  let scratch = '';
  let argsFile = '';

  beforeEach(() => {
    for (const key of ENV) saved.set(key, Bun.env[key]);
    scratch = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cortex-fallback-'));
    argsFile = nodePath.join(scratch, 'pi-args');
    // A fake `pi` that records its argv and answers like a headless run.
    fs.writeFileSync(
      nodePath.join(scratch, 'pi'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\ncat > /dev/null\nprintf '{"memories":[]}'\n`,
      { mode: 0o755 },
    );
    Bun.env.PATH = `${scratch}:${saved.get('PATH') ?? ''}`;
    Bun.env.HOME = scratch; // no ~/.pi: the direct endpoint comes from the explicit variables below
    Bun.env.PI_CODING_AGENT = 'true';
    Bun.env.CORTEX_LLM_API_URL = 'http://llm.example/v1';
    Bun.env.CORTEX_LLM_API_KEY = 'k';
    Bun.env.CORTEX_LLM_MODEL = 'warmind-1017-native'; // the session is pinned to WARMIND
    Bun.env.CORTEX_PI_PROVIDER = 'desktop-vllm';
    for (const key of ['CORTEX_LLM_PROVIDER', 'PI_PROVIDER', 'PI_MODEL', 'CORTEX_PI_MODEL', 'CORTEX_LLM_REASONING_EFFORT']) {
      delete Bun.env[key];
    }
    resetServedModelCheck();
    resetConsecutiveDirectFailuresForTests();
    resetLlmConcurrencyForTests();
  });

  afterEach(() => {
    for (const key of ENV) {
      const value = saved.get(key);
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  /** Fail the direct call the way a GLM server that ignored the request does, then return pi's argv. */
  async function fallbackArgs(servedId: string): Promise<string[]> {
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL) =>
      String(url).endsWith('/models')
        ? new Response(JSON.stringify({ data: [{ id: servedId }] }), { status: 200 })
        : new Response(JSON.stringify({
          choices: [{ message: { content: '', reasoning_content: 'hmm' }, finish_reason: 'length' }],
        }), { status: 200 })) as typeof fetch;
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = await runLlmPromptDirect('extract', 10_000, { jsonMode: true });
      expect(result.direct).toBe(false);
    } finally {
      globalThis.fetch = original;
      warn.mockRestore();
    }
    return fs.readFileSync(argsFile, 'utf8').trim().split('\n');
  }

  it('asks a GLM server for the lowest effort instead of "off", which it ignores', async () => {
    const args = await fallbackArgs('glm-5.3-flash-hyperflare-tp2-cyber-hybrid');
    expect(args[args.indexOf('--thinking') + 1]).toBe('low');
  });

  it('keeps off for a model that honours it', async () => {
    const args = await fallbackArgs('warmind-1017-native');
    expect(args[args.indexOf('--thinking') + 1]).toBe('off');
  });

  it('follows CORTEX_LLM_REASONING_EFFORT', async () => {
    Bun.env.CORTEX_LLM_REASONING_EFFORT = 'high';
    const args = await fallbackArgs('warmind-1017-native');
    expect(args[args.indexOf('--thinking') + 1]).toBe('high');
  });

  it('logs the thinking level it sends, not the one it was asked for', async () => {
    // Claude 5.5 refuses `off`, so `off` goes out as `low`. The log line is
    // what an operator reads when a run misbehaves; it must name what pi got.
    Bun.env.CORTEX_LLM_MODEL = 'claude-haiku-5.5';
    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });

    try {
      await runLlmPrompt('extract', 10_000, 'off');
    } finally {
      stderr.mockRestore();
    }

    const args = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
    expect(args[args.indexOf('--thinking') + 1]).toBe('low');
    expect(written.join('')).toContain('/claude-haiku-5.5 (thinking: low)');
  });

  /** Replace the fake `pi` with one that fails the way a real run did. */
  function piFailsWith(stderr: string): void {
    fs.writeFileSync(
      nodePath.join(scratch, 'pi'),
      `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' '${stderr}' >&2\nexit 1\n`,
      { mode: 0o755 },
    );
  }

  it('throws a provider refusal when pi reports one, so loops stop asking', async () => {
    piFailsWith('429 quota exceeded');

    await expect(runLlmPrompt('extract', 10_000)).rejects.toMatchObject({
      name: 'LlmProviderRefusedError',
      refusal: { kind: 'http-status', status: 429 },
      detail: expect.stringContaining('Extraction LLM CLI exited with code 1: 429 quota exceeded'),
    });
  });

  it('throws a plain error for a failure that may pass on the next call', async () => {
    piFailsWith('Connection error.');

    await expect(runLlmPrompt('extract', 10_000)).rejects.toMatchObject({
      name: 'Error',
      message: expect.stringContaining('Extraction LLM CLI exited with code 1: Connection error.'),
    });
  });
});

describe('buildEdgeClassificationPrompt', () => {
  it('builds prompt with pair descriptions', () => {
    const pairs: MemoryPair[] = [
      {
        source: {
          id: 'mem1',
          content: 'Source content',
          summary: 'Source summary',
          memory_type: 'decision',
        },
        target: {
          id: 'mem2',
          content: 'Target content',
          summary: 'Target summary',
          memory_type: 'pattern',
        },
      },
    ];

    const result = buildEdgeClassificationPrompt(pairs);

    expect(result).toContain('Pair 1:');
    expect(result).toContain('pair_index: 1');
    expect(result).toContain('Source [mem1]:');
    expect(result).toContain('Type: decision');
    expect(result).toContain('Summary: Source summary');
    expect(result).toContain('Content: Source content');
    expect(result).toContain('Target [mem2]:');
    expect(result).toContain('Type: pattern');
    expect(result).toContain('Summary: Target summary');
    expect(result).toContain('Content: Target content');
    expect(result).toContain('Edge Relation Types:');
    expect(result).toContain('relates_to');
    expect(result).toContain('derived_from');
  });

  it('enumerates every pair with its 1-based pair_index', () => {
    const pair = (id: string): MemoryPair => ({
      source: { id, content: 'c', summary: 's', memory_type: 'context' },
      target: { id: `${id}-t`, content: 'c', summary: 's', memory_type: 'context' },
    });
    const result = buildEdgeClassificationPrompt([pair('a'), pair('b'), pair('c')]);

    expect(result).toContain('Pair 1:\n  pair_index: 1');
    expect(result).toContain('Pair 2:\n  pair_index: 2');
    expect(result).toContain('Pair 3:\n  pair_index: 3');
  });
});

describe('parseEdgeClassificationResponse', () => {
  it('parses valid JSON response', () => {
    const response = JSON.stringify([
      { source_id: 'mem1', target_id: 'mem2', relation_type: 'relates_to', strength: 0.8 },
    ]);

    const result = parseEdgeClassificationResponse(response);

    expect(result).toEqual({
      kind: 'ok',
      classifications: [
        { source_id: 'mem1', target_id: 'mem2', relation_type: 'relates_to', strength: 0.8 },
      ],
    });
  });

  it('parses JSON followed by trailing prose', () => {
    const response =
      '[{"source_id":"mem1","target_id":"mem2","relation_type":"refines","strength":0.7}]\n\n' +
      'The source refines the target because both concern the same module and the source improves the design.';

    const result = parseEdgeClassificationResponse(response);

    expect(result).toEqual({
      kind: 'ok',
      classifications: [
        { source_id: 'mem1', target_id: 'mem2', relation_type: 'refines', strength: 0.7 },
      ],
    });
  });

  it('parses JSON inside prose with no code fence', () => {
    const response =
      'Here are the classifications: [{"source_id":"a","target_id":"b","relation_type":"contradicts","strength":0.9}] Hope this helps.';

    const result = parseEdgeClassificationResponse(response);

    expect(result).toEqual({
      kind: 'ok',
      classifications: [
        { source_id: 'a', target_id: 'b', relation_type: 'contradicts', strength: 0.9 },
      ],
    });
  });

  it('strict mode throws on truncated JSON', () => {
    const truncated = '[{"source_id":"a","target_id":"b","relation_type":"refines","strength":0.7},';

    expect(() => parseEdgeClassificationResponse(truncated, { strict: true })).toThrow(
      /not valid JSON/
    );
  });

  it('strict mode throws on non-array JSON', () => {
    expect(() =>
      parseEdgeClassificationResponse('{"error":"something"}', { strict: true })
    ).toThrow(/no edges array/);
  });

  it('strict mode parses the schema-guided {"edges": [...]} wrapper shape', () => {
    const response = JSON.stringify({
      edges: [
        { pair_index: 1, source_id: 'a', target_id: 'b', relation_type: 'derived_from', strength: 0.6 },
      ],
    });

    expect(parseEdgeClassificationResponse(response, { strict: true })).toEqual({
      kind: 'ok',
      classifications: [
        { pair_index: 1, source_id: 'a', target_id: 'b', relation_type: 'derived_from', strength: 0.6 },
      ],
    });
  });

  it('strict mode throws when any item has invalid shape (no silent dropped decline)', () => {
    const response = JSON.stringify({
      edges: [
        { pair_index: 1, source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.7 },
        { pair_index: 2, source_id: 'c', target_id: 'd', relation_type: 'REFINES', strength: 0.7 },
      ],
    });

    expect(() => parseEdgeClassificationResponse(response, { strict: true })).toThrow(
      /1 of 2 items with invalid shape/
    );
  });

  it('strict mode accepts an empty array', () => {
    expect(parseEdgeClassificationResponse('[]', { strict: true })).toEqual({
      kind: 'ok',
      classifications: [],
    });
  });

  it('strict mode parses a valid full response', () => {
    const response =
      '[{"pair_index":1,"source_id":"a","target_id":"b","relation_type":"derived_from","strength":0.6}]';

    expect(parseEdgeClassificationResponse(response, { strict: true })).toEqual({
      kind: 'ok',
      classifications: [
        { pair_index: 1, source_id: 'a', target_id: 'b', relation_type: 'derived_from', strength: 0.6 },
      ],
    });
  });

  it('parses JSON in markdown code blocks', () => {
    const response = `
\`\`\`json
[
  { "source_id": "mem1", "target_id": "mem2", "relation_type": "refines", "strength": 0.9 }
]
\`\`\`
`;

    const result = parseEdgeClassificationResponse(response);

    expect(result).toEqual({
      kind: 'ok',
      classifications: [
        { source_id: 'mem1', target_id: 'mem2', relation_type: 'refines', strength: 0.9 },
      ],
    });
  });

  it('tolerant mode accepts the schema-guided {"edges": [...]} wrapper shape', () => {
    const response = JSON.stringify({
      edges: [
        { pair_index: 1, source_id: 'a', target_id: 'b', relation_type: 'supersedes', strength: 0.9 },
      ],
    });

    expect(parseEdgeClassificationResponse(response)).toEqual({
      kind: 'ok',
      classifications: [
        { pair_index: 1, source_id: 'a', target_id: 'b', relation_type: 'supersedes', strength: 0.9 },
      ],
    });
  });

  it('tolerant mode parses the prompt-shaped wrapper inside prose', () => {
    const response =
      'Here you go: {"edges": [{"pair_index": 1, "source_id": "a", "target_id": "b", "relation_type": "refines", "strength": 0.75}]} Hope this helps.';

    expect(parseEdgeClassificationResponse(response)).toEqual({
      kind: 'ok',
      classifications: [
        { pair_index: 1, source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.75 },
      ],
    });
  });

  it('reports unparseable instead of a silent empty result for invalid JSON', () => {
    const result = parseEdgeClassificationResponse('invalid json');
    expect(result.kind).toBe('unparseable');
    if (result.kind === 'unparseable') expect(result.reason).toMatch(/failed to parse/);
  });

  it('reports unparseable for a JSON object without an edges array', () => {
    const result = parseEdgeClassificationResponse(JSON.stringify({ error: 'test' }));
    expect(result.kind).toBe('unparseable');
  });

  it('fails a tolerant batch when any unindexed classification is invalid', () => {
    const response = JSON.stringify([
      { source_id: 'mem1', target_id: 'mem2', relation_type: 'relates_to', strength: 0.8 },
      { source_id: 'mem3', target_id: 'mem4', relation_type: 'invalid', strength: 0.7 },
      { source_id: 'mem5', target_id: 'mem6', relation_type: 'refines', strength: 1.5 },
    ]);

    const result = parseEdgeClassificationResponse(response);

    expect(result.kind).toBe('unparseable');
  });

  it('treats a dropped indexed item as unparseable so the pair is retried', () => {
    const response = JSON.stringify({
      edges: [
        { pair_index: 1, source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.7 },
        { pair_index: 2, source_id: 'c', target_id: 'd', relation_type: 'REFINES', strength: 0.7 },
      ],
    });

    const result = parseEdgeClassificationResponse(response);
    expect(result.kind).toBe('unparseable');
  });

  it('preserves pair_index through tolerant parsing', () => {
    const response = JSON.stringify({
      edges: [
        { pair_index: 1, source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5 },
      ],
    });

    const result = parseEdgeClassificationResponse(response);
    expect(result).toEqual({
      kind: 'ok',
      classifications: [
        { pair_index: 1, source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5 },
      ],
    });
  });

  it('rejects a malformed pair_index as invalid (batch failure, not a decline)', () => {
    const response = JSON.stringify([
      { pair_index: 0, source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.7 },
    ]);

    // The dropped item carried a pair_index, so the response is unparseable
    // and the pair is retried rather than silently retired.
    const result = parseEdgeClassificationResponse(response);
    expect(result.kind).toBe('unparseable');
  });

  it('validates all edge relation types', () => {
    const response = JSON.stringify([
      { source_id: '1', target_id: '2', relation_type: 'relates_to', strength: 0.8 },
      { source_id: '1', target_id: '3', relation_type: 'derived_from', strength: 0.8 },
      { source_id: '1', target_id: '4', relation_type: 'contradicts', strength: 0.8 },
      { source_id: '1', target_id: '5', relation_type: 'exemplifies', strength: 0.8 },
      { source_id: '1', target_id: '6', relation_type: 'refines', strength: 0.8 },
      { source_id: '1', target_id: '7', relation_type: 'supersedes', strength: 0.8 },
      { source_id: '1', target_id: '8', relation_type: 'source_of', strength: 0.8 },
    ]);

    const result = parseEdgeClassificationResponse(response);

    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.classifications).toHaveLength(7);
      expect(result.classifications.map((r) => r.relation_type)).toEqual([
        'relates_to',
        'derived_from',
        'contradicts',
        'exemplifies',
        'refines',
        'supersedes',
        'source_of',
      ]);
    }
  });
});
