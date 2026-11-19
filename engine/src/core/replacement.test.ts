import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { parseReplacementTag, replacedBy, type ReplacementTag } from './replacement.js';
import { createMemory, type Memory, type MemoryStatus } from './types.js';

const tagged = (id: string, tags: readonly string[], extra: { pinned?: boolean; status?: MemoryStatus } = {}): Memory =>
  createMemory({
    id,
    content: id,
    summary: id,
    memory_type: 'decision',
    scope: 'project',
    confidence: 1,
    priority: 5,
    source_type: 'manual',
    source_session: 's',
    source_context: '{}',
    tags,
    ...extra,
  });

const tag = (raw: string): ReplacementTag => {
  const parsed = parseReplacementTag(raw);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.tag;
};

describe('parseReplacementTag', () => {
  it('accepts a plain tag', () => {
    expect(parseReplacementTag('deploy-procedure')).toEqual({ ok: true, tag: 'deploy-procedure' });
  });

  it.each(['', 'a,b', 'two words', ' lead', 'tab\there', 'new\nline'])('refuses %j', (raw) => {
    expect(parseReplacementTag(raw).ok).toBe(false);
  });

  it('property: accepted exactly when non-empty with no comma or whitespace', () => {
    fc.assert(
      fc.property(fc.string(), (raw) => {
        expect(parseReplacementTag(raw).ok).toBe(raw !== '' && !/[,\s]/u.test(raw));
      })
    );
  });
});

describe('replacedBy', () => {
  it('selects every other active memory carrying the tag, pinned included', () => {
    const memories = [
      tagged('new', ['deploy']),
      tagged('old', ['deploy', 'ops']),
      tagged('pinned-old', ['deploy'], { pinned: true }),
      tagged('archived-old', ['deploy'], { status: 'superseded' }),
      tagged('unrelated', ['ops']),
    ];
    expect(replacedBy('new', tag('deploy'), memories).map((m) => m.id)).toEqual(['old', 'pinned-old']);
  });

  it('matches the tag exactly, not as a substring or case-insensitively', () => {
    const memories = [tagged('a', ['deploy-old']), tagged('b', ['Deploy'])];
    expect(replacedBy('new', tag('deploy'), memories)).toEqual([]);
  });
});
