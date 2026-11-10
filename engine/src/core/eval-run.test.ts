import { describe, expect, test } from 'vitest';
import * as fc from 'fast-check';
import { manifestToRow, parseManifest, resumeConflicts, type RunManifest } from './eval-run.js';
import type { RunName } from './eval-set.js';

const manifest = (overrides: Partial<RunManifest> = {}): RunManifest => ({
  run: 'before' as RunName,
  condition: 'cortex',
  project: '.dotfiles',
  requestedModel: 'deepseek-v4-flash',
  answerPromptDigest: 'a'.repeat(64),
  memory: { kind: 'snapshot', branch: 'main', excludedMemories: 3, excludedSessions: ['s1', 's2'] },
  createdAt: '2026-11-09T12:00:00.000Z',
  ...overrides,
});

const roundTrip = (m: RunManifest) => parseManifest(JSON.stringify(manifestToRow(m)));

describe('run manifest', () => {
  test('round-trips both memory sources (property)', () => {
    const memoryArb = fc.oneof(
      fc.constant({ kind: 'none' as const }),
      fc.record({
        kind: fc.constant('snapshot' as const),
        branch: fc.string(),
        excludedMemories: fc.nat(),
        excludedSessions: fc.array(fc.string()),
      }),
    );
    fc.assert(
      fc.property(memoryArb, fc.constantFrom('cortex' as const, 'none' as const), (memory, condition) => {
        const m = manifest({ memory, condition });
        expect(roundTrip(m)).toEqual({ kind: 'ok', value: m });
      }),
    );
  });

  test('rejects a manifest whose snapshot lost its branch', () => {
    const row = manifestToRow(manifest()) as { memory: Record<string, unknown> };
    delete row.memory.branch;
    expect(parseManifest(JSON.stringify(row)).kind).toBe('err');
  });
});

describe('resumeConflicts', () => {
  test('the same setup resumes, whatever order the sessions were listed in', () => {
    const reordered = manifest({
      memory: { kind: 'snapshot', branch: 'main', excludedMemories: 0, excludedSessions: ['s2', 's1'] },
    });
    expect(resumeConflicts(manifest(), reordered)).toEqual([]);
  });

  test('a different checkout branch does not block a resume: the run keeps its own', () => {
    const otherBranch = manifest({
      memory: { kind: 'snapshot', branch: 'feature', excludedMemories: 3, excludedSessions: ['s1', 's2'] },
    });
    expect(resumeConflicts(manifest(), otherBranch)).toEqual([]);
  });

  test('names every difference that would make the run incomparable', () => {
    const changed = manifest({
      condition: 'none',
      requestedModel: 'glm-5.3',
      answerPromptDigest: 'b'.repeat(64),
      memory: { kind: 'none' },
    });
    expect(resumeConflicts(manifest(), changed)).toEqual([
      'condition: run has cortex, now none',
      'answer model: run has deepseek-v4-flash, now glm-5.3',
      `answer prompt: run has ${'a'.repeat(12)}, now ${'b'.repeat(12)}`,
    ]);
  });

  test('a new authoring session conflicts: the answer key may have leaked into the snapshot read', () => {
    const more = manifest({
      memory: { kind: 'snapshot', branch: 'main', excludedMemories: 3, excludedSessions: ['s1', 's2', 's3'] },
    });
    expect(resumeConflicts(manifest(), more)).toEqual(['authoring sessions changed since the run started']);
  });
});
