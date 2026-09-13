/**
 * Tests for edge classification pure functions (prompt building + response parsing).
 */

import { describe, it, expect } from 'vitest';
import {
  buildEdgeClassificationPrompt,
  buildLlmInvocation,
  parseEdgeClassificationResponse,
  type MemoryPair,
} from './claude-llm.js';

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
