import { describe, expect, test } from 'vitest';
import * as fc from 'fast-check';
import {
  CASE_KINDS,
  caseToRow,
  describeEvalSet,
  parseAnswers,
  parseCaseRow,
  parseCases,
  parseEvalSettings,
  parseIsoDate,
  parseLabels,
  parseRunName,
  type EvalCase,
  type EvalSettings,
} from './eval-set.js';

const row = (overrides: Record<string, unknown> = {}) => ({
  id: 'q01',
  split: 'practice',
  kind: 'changed_value',
  asked_on: '2026-10-20',
  question: 'Which model does reclaw run pi on?',
  true_now: ['claude-sonnet-5.5, since 2026-10-26'],
  stale: ['claude-sonnet-5'],
  ...overrides,
});

const jsonl = (...rows: readonly unknown[]) => rows.map((r) => JSON.stringify(r)).join('\n');

const settings = (sessions: readonly string[] = ['s1']): EvalSettings => ({
  authoringSessions: new Set(sessions),
});

describe('parseCases', () => {
  test('parses a valid case into the domain shape', () => {
    const result = parseCases(jsonl(row()));
    expect(result).toEqual({
      kind: 'ok',
      value: [
        {
          id: 'q01',
          split: 'practice',
          kind: 'changed_value',
          askedOn: '2026-10-20',
          question: 'Which model does reclaw run pi on?',
          trueNow: ['claude-sonnet-5.5, since 2026-10-26'],
          stale: ['claude-sonnet-5'],
        },
      ],
    });
  });

  test('treats a missing stale list as no stale values', () => {
    const { stale: _omitted, ...withoutStale } = row();
    const result = parseCases(jsonl(withoutStale));
    expect(result.kind === 'ok' && result.value[0].stale).toEqual([]);
  });

  test('skips blank lines without shifting line numbers', () => {
    const result = parseCases(`${JSON.stringify(row())}\n\n${JSON.stringify(row({ id: 'q01' }))}`);
    expect(result).toEqual({ kind: 'err', errors: [{ line: 3, message: 'q01 appears twice' }] });
  });

  test('reports every bad line, not just the first', () => {
    const result = parseCases(
      ['{not json', JSON.stringify(row({ id: 'q02', split: 'test' })), JSON.stringify(row({ id: 'q03' }))].join('\n'),
    );
    expect(result.kind).toBe('err');
    expect(result.kind === 'err' && result.errors.map((e) => e.line)).toEqual([1, 2]);
  });

  test.each([
    ['an unknown field (a typo must not pass silently)', { true_nwo: ['x'] }, 'unknown field(s): true_nwo'],
    ['an empty truth list', { true_now: [] }, 'true_now must be a non-empty list'],
    ['a blank truth', { true_now: ['  '] }, 'true_now must be a non-empty list'],
    ['an unknown kind', { kind: 'vibes' }, 'kind must be one of'],
    ['an impossible date', { asked_on: '2026-02-30' }, 'asked_on must be a real YYYY-MM-DD date'],
    ['a blank question', { question: ' ' }, 'question must be a non-empty string'],
    ['a path-like id', { id: '../q' }, 'id must be'],
  ])('rejects %s', (_name, overrides, message) => {
    const parsed = parseCaseRow(row(overrides));
    expect(typeof parsed).toBe('string');
    expect(parsed as string).toContain(message);
  });

  const caseArb: fc.Arbitrary<EvalCase> = fc
    .record({
      id: fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{0,11}$/),
      split: fc.constantFrom('practice' as const, 'held_out' as const),
      kind: fc.constantFrom(...CASE_KINDS),
      askedOn: fc
        .date({ min: new Date('2000-01-01'), max: new Date('2099-12-31'), noInvalidDate: true })
        .map((d) => d.toISOString().slice(0, 10)),
      question: fc.string({ minLength: 1 }).filter((s) => s.trim() !== ''),
      trueNow: fc.array(fc.string().filter((s) => s.trim() !== ''), { minLength: 1, maxLength: 4 }),
      stale: fc.array(fc.string().filter((s) => s.trim() !== ''), { maxLength: 3 }),
    })
    .map((r) => r as unknown as EvalCase);

  test('caseToRow is the inverse of parsing (round trip)', () => {
    fc.assert(
      fc.property(caseArb, (evalCase) => {
        expect(parseCaseRow(caseToRow(evalCase))).toEqual(evalCase);
      }),
    );
  });

  test('ids are unique in every accepted set', () => {
    fc.assert(
      fc.property(fc.array(caseArb, { maxLength: 8 }), (cases) => {
        const result = parseCases(cases.map((c) => JSON.stringify(caseToRow(c))).join('\n'));
        if (result.kind === 'ok') {
          expect(new Set(result.value.map((c) => c.id)).size).toBe(result.value.length);
        } else {
          expect(result.errors.every((e) => e.message.endsWith('appears twice'))).toBe(true);
        }
      }),
    );
  });
});

describe('parseAnswers', () => {
  test("accepts Team0's format and the harness's own fields, ignoring notes", () => {
    const result = parseAnswers(
      jsonl(
        { id: 'q01', tool_calls: 6, answer: 'Nov 1' },
        { id: 'q02', answer: 'x', prompt_tokens: 1200, answer_model: 'glm', context_chars: 9, note: 'hand' },
      ),
    );
    expect(result).toEqual({
      kind: 'ok',
      value: [
        { id: 'q01', answer: 'Nov 1', toolCalls: 6, promptTokens: null, model: null },
        { id: 'q02', answer: 'x', toolCalls: null, promptTokens: 1200, model: 'glm' },
      ],
    });
  });

  test('rejects a negative tool call count', () => {
    expect(parseAnswers(jsonl({ id: 'q01', answer: 'a', tool_calls: -1 })).kind).toBe('err');
  });
});

describe('parseLabels', () => {
  test('keeps only the measures given', () => {
    const result = parseLabels(jsonl({ run: 'before', id: 'q01', correct_current: 0, missed: 0.5 }));
    expect(result).toEqual({
      kind: 'ok',
      value: [{ run: 'before', id: 'q01', scores: { correct_current: 0, missed: 0.5 } }],
    });
  });

  test('the same case may be labelled once per run', () => {
    const twoRuns = jsonl({ run: 'a', id: 'q01', relevant: 1 }, { run: 'b', id: 'q01', relevant: 1 });
    expect(parseLabels(twoRuns).kind).toBe('ok');
    expect(parseLabels(jsonl({ run: 'a', id: 'q01', relevant: 1 }, { run: 'a', id: 'q01', relevant: 0 })).kind).toBe('err');
  });

  test.each([
    [{ run: 'a', id: 'q01' }, 'label at least one measure'],
    [{ run: 'a', id: 'q01', relevant: 1.5 }, 'relevant must be a number from 0 to 1'],
    [{ id: 'q01', relevant: 1 }, 'run must name the run'],
  ])('rejects %j', (label, message) => {
    const result = parseLabels(jsonl(label));
    expect(result.kind === 'err' && result.errors[0].message).toContain(message);
  });
});

describe('parseEvalSettings', () => {
  test('requires the authoring session list, even when empty', () => {
    expect(parseEvalSettings('{"authoring_sessions": []}')).toEqual({
      kind: 'ok',
      value: { authoringSessions: new Set() },
    });
    expect(parseEvalSettings('{}').kind).toBe('err');
    expect(parseEvalSettings('{"authoring_sessions": ["a"], "extra": 1}').kind).toBe('err');
  });
});

describe('smart constructors', () => {
  test('run names are safe directory names', () => {
    expect(parseRunName('before-2026.11')).toBe('before-2026.11');
    for (const bad of ['', 'Before', '../x', 'a/b', '.hidden', 'a..b']) {
      expect(parseRunName(bad)).toBeNull();
    }
  });

  test('dates must exist on the calendar', () => {
    expect(parseIsoDate('2028-02-29')).toBe('2028-02-29');
    expect(parseIsoDate('2026-02-29')).toBeNull();
    expect(parseIsoDate('2026-1-5')).toBeNull();
  });
});

describe('describeEvalSet', () => {
  const cases = (n: number, heldOut: number): EvalCase[] =>
    Array.from({ length: n }, (_, i) => {
      const parsed = parseCaseRow(
        row({
          id: `q${i}`,
          split: i < heldOut ? 'held_out' : 'practice',
          kind: CASE_KINDS[i % CASE_KINDS.length],
        }),
      );
      return parsed as EvalCase;
    });

  test('a full set with a third held out and every kind has no warnings', () => {
    const text = describeEvalSet(cases(21, 7), settings());
    expect(text).toContain('21 cases: 14 practice, 7 held_out');
    expect(text).not.toContain('warnings:');
  });

  test('warns about size, split, missing kinds and missing authoring sessions', () => {
    const text = describeEvalSet(cases(3, 0), settings([]));
    expect(text).toContain('3 cases; the method calls for about 20');
    expect(text).toContain('no held_out case');
    expect(text).toContain('no commitment case');
    expect(text).toContain('no authoring sessions listed');
  });
});
