/**
 * Tests for JSON extraction helpers used to parse LLM responses.
 */

import { describe, it, expect } from 'vitest';
import { extractJsonSlice, parseJsonFromLlmText } from './json-utils.js';

describe('extractJsonSlice', () => {
  it('returns null when no JSON-looking value exists', () => {
    expect(extractJsonSlice('no json here')).toBeNull();
    expect(extractJsonSlice('')).toBeNull();
  });

  it('extracts a plain JSON array', () => {
    const text = '[{"a":1}]';
    expect(extractJsonSlice(text)).toBe(text);
  });

  it('extracts a plain JSON object', () => {
    const text = '{"memories":[]}';
    expect(extractJsonSlice(text)).toBe(text);
  });

  it('extracts JSON with leading prose', () => {
    const result = extractJsonSlice('Here are the edges: [{"source_id":"a"}]');
    expect(result).toBe('[{"source_id":"a"}]');
  });

  it('extracts JSON with trailing prose', () => {
    const json = '[{"source_id":"a","relation_type":"refines","strength":0.6}]';
    const result = extractJsonSlice(
      `${json}\n\nThe source of this relationship is a refinement of the target, as both concern the same component.`
    );
    expect(result).toBe(json);
  });

  it('extracts object JSON surrounded by markdown and prose', () => {
    const result = extractJsonSlice(
      'Sure!\n```json\n{"memories":[{"content":"x"}]}\n```\nDone.'
    );
    expect(result).toBe('{"memories":[{"content":"x"}]}');
  });

  it('extracts JSON preceded by short prose', () => {
    const result = extractJsonSlice('Here are the edges: [{"id":1}]');
    expect(result).toBe('[{"id":1}]');
  });
});

describe('parseJsonFromLlmText', () => {
  it('parses fenced JSON', () => {
    expect(
      parseJsonFromLlmText<{ a: number }>('```json\n{"a":1}\n```')
    ).toEqual({ a: 1 });
  });

  it('parses JSON followed by trailing prose', () => {
    expect(
      parseJsonFromLlmText<number[]>('[1,2,3]\n\nBoth numbers are small.')
    ).toEqual([1, 2, 3]);
  });

  it('returns null for unparseable text', () => {
    expect(parseJsonFromLlmText('no json at all')).toBeNull();
  });

  it('tries the raw text as a last resort', () => {
    expect(parseJsonFromLlmText<{ ok: boolean }>('{"ok":true}')).toEqual({
      ok: true,
    });
  });
});
