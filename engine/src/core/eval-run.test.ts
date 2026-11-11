import { describe, expect, test } from 'vitest';
import * as fc from 'fast-check';
import {
  conditionOf,
  differingSources,
  manifestToRow,
  parseManifest,
  planRun,
  resumeConflicts,
  startManifest,
  type MemorySource,
  type RunIdentity,
  type RunManifest,
} from './eval-run.js';
import type { RunName } from './eval-set.js';

const SOURCES = { project: '/work/dotfiles/.memory/cortex.db', global: '/home/u/.local/share/cortex/global.db' };

const snapshot = (overrides: Partial<Extract<MemorySource, { kind: 'snapshot' }>> = {}): MemorySource => ({
  kind: 'snapshot',
  branch: 'main',
  sources: SOURCES,
  excludedMemories: 3,
  excludedSessions: ['s1', 's2'],
  ...overrides,
});

const manifest = (overrides: Partial<RunManifest> = {}): RunManifest => ({
  run: 'before' as RunName,
  project: '.dotfiles',
  requestedModel: 'deepseek-v4-flash',
  answerPromptDigest: 'a'.repeat(64),
  memory: snapshot(),
  createdAt: '2026-11-09T12:00:00.000Z',
  ...overrides,
});

const identity = (overrides: Partial<RunIdentity> = {}): RunIdentity => ({
  condition: 'cortex',
  project: '.dotfiles',
  requestedModel: 'deepseek-v4-flash',
  answerPromptDigest: 'a'.repeat(64),
  excludedSessions: ['s1', 's2'],
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
        sources: fc.record({ project: fc.string(), global: fc.option(fc.string(), { nil: null }) }),
        excludedMemories: fc.nat(),
        excludedSessions: fc.array(fc.string()),
      }),
    );
    fc.assert(
      fc.property(memoryArb, (memory) => {
        const m = manifest({ memory });
        expect(roundTrip(m)).toEqual({ kind: 'ok', value: m });
      }),
    );
  });

  test('the condition is which memory the run reads, and the row says so', () => {
    expect(conditionOf(snapshot())).toBe('cortex');
    expect(conditionOf({ kind: 'none' })).toBe('none');
    expect(manifestToRow(manifest({ memory: { kind: 'none' } })).condition).toBe('none');
  });

  test.each([
    ['cortex', { kind: 'none' }],
    ['none', manifestToRow(manifest()).memory],
  ])('rejects a run.json whose condition %s contradicts its memory', (condition, memory) => {
    const row = { ...manifestToRow(manifest()), condition, memory };
    expect(parseManifest(JSON.stringify(row))).toEqual({
      kind: 'err',
      errors: [{ line: 1, message: expect.stringContaining(`condition ${condition} contradicts memory kind`) }],
    });
  });

  test.each([['[]'], ['42'], ['{not json']])('rejects %s: a manifest is one JSON object', (text) => {
    expect(parseManifest(text)).toEqual({ kind: 'err', errors: [{ line: 1, message: 'expected a JSON object' }] });
  });

  test.each(['branch', 'sources'])('rejects a snapshot that lost its %s', (key) => {
    const row = manifestToRow(manifest()) as { memory: Record<string, unknown> };
    delete row.memory[key];
    expect(parseManifest(JSON.stringify(row)).kind).toBe('err');
  });

  test('rejects a snapshot whose global source is neither a path nor null', () => {
    const row = manifestToRow(manifest()) as { memory: { sources: Record<string, unknown> } };
    row.memory.sources.global = 42;
    expect(parseManifest(JSON.stringify(row)).kind).toBe('err');
  });
});

describe('resumeConflicts', () => {
  test('the same setup resumes, whatever order the sessions were listed in', () => {
    expect(resumeConflicts(manifest(), identity({ excludedSessions: ['s2', 's1'] }))).toEqual([]);
  });

  test('names every difference that would make the run incomparable', () => {
    const changed = identity({
      condition: 'none',
      requestedModel: 'glm-5.3',
      answerPromptDigest: 'b'.repeat(64),
      excludedSessions: [],
    });
    expect(resumeConflicts(manifest(), changed)).toEqual([
      'condition: run has cortex, now none',
      'answer model: run has deepseek-v4-flash, now glm-5.3',
      `answer prompt: run has ${'a'.repeat(12)}, now ${'b'.repeat(12)}`,
    ]);
  });

  test('a new authoring session conflicts: the answer key may have leaked into the snapshot read', () => {
    expect(resumeConflicts(manifest(), identity({ excludedSessions: ['s1', 's2', 's3'] }))).toEqual([
      'authoring sessions changed since the run started',
    ]);
  });

  test('a baseline run reads no memory, so its authoring sessions never conflict', () => {
    const baseline = manifest({ memory: { kind: 'none' } });
    expect(resumeConflicts(baseline, identity({ condition: 'none', excludedSessions: ['s9'] }))).toEqual([]);
  });
});

describe('planRun', () => {
  test('a run with no manifest starts', () => {
    expect(planRun(null, identity())).toEqual({ kind: 'start' });
  });

  test('the same setup resumes the stored manifest unchanged', () => {
    const stored = manifest();
    expect(planRun(stored, identity())).toEqual({ kind: 'resume', manifest: stored });
  });

  test('a different setup is refused, naming each conflict', () => {
    expect(planRun(manifest(), identity({ project: 'elsewhere' }))).toEqual({
      kind: 'refuse',
      conflicts: ['project: run has .dotfiles, now elsewhere'],
    });
  });

  test('a started run resumes under the identity it was started with (property)', () => {
    const identityArb = fc.record({
      condition: fc.constantFrom('cortex' as const, 'none' as const),
      project: fc.string(),
      requestedModel: fc.string(),
      answerPromptDigest: fc.string({ minLength: 12 }),
      excludedSessions: fc.array(fc.string()),
    });
    fc.assert(
      fc.property(identityArb, (wanted) => {
        const memory: MemorySource =
          wanted.condition === 'none' ? { kind: 'none' } : snapshot({ excludedSessions: wanted.excludedSessions });
        const started = startManifest('before' as RunName, wanted, memory, new Date('2026-11-09T12:00:00Z'));
        expect(planRun(started, wanted)).toEqual({ kind: 'resume', manifest: started });
        expect(roundTrip(started)).toEqual({ kind: 'ok', value: started });
      }),
    );
  });
});

describe('differingSources', () => {
  test('snapshots of the same databases do not differ', () => {
    expect(differingSources([snapshot(), snapshot({ branch: 'feature', excludedMemories: 0 })])).toEqual([]);
  });

  test('a baseline differs from nothing', () => {
    expect(differingSources([{ kind: 'none' }, snapshot()])).toEqual([]);
  });

  test('names each source that differs, project before global', () => {
    const elsewhere = snapshot({ sources: { project: '/other/.memory/cortex.db', global: null } });
    expect(differingSources([snapshot(), elsewhere])).toEqual(['project', 'global']);
    const otherHarness = snapshot({ sources: { ...SOURCES, global: '/home/u/.pi/agent/memory/cortex-global.db' } });
    expect(differingSources([snapshot(), otherHarness])).toEqual(['global']);
  });
});
