/**
 * Tests for the eval orchestrators: a real eval directory in a temp dir,
 * fake Llm and MemoryContext ports, a fake snapshot.
 */

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  answerCases,
  evalPaths,
  loadEvalSet,
  openRun,
  parseEvalArgs,
  scoreRuns,
  scoringPlan,
  type EvalPaths,
  type RunRequest,
} from './eval.js';
import type { EvalCase, RunName } from '../core/eval-set.js';
import type { Llm, MemoryContext } from '../core/eval-run.js';

let dir: string;
let paths: EvalPaths;

const verdict = (value: number) =>
  JSON.stringify({
    correct_current: value,
    relevant: value,
    missed: value,
    ordered: value,
    context_complete: value,
    reason: 'r',
  });

function writeSet(cases: readonly Record<string, unknown>[], sessions: readonly string[] = ['author-1']): void {
  writeFileSync(paths.settings, JSON.stringify({ authoring_sessions: sessions }));
  writeFileSync(paths.questions, cases.map((c) => JSON.stringify(c)).join('\n'));
}

const caseRow = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  split: 'practice',
  kind: 'changed_value',
  asked_on: '2026-10-20',
  question: `question ${id}`,
  true_now: [`truth ${id}`],
  stale: [],
  ...extra,
});

const request = (overrides: Partial<RunRequest> = {}): RunRequest => ({
  run: 'before' as RunName,
  condition: 'cortex',
  project: 'dotfiles',
  requestedModel: 'answer-model',
  branch: 'main',
  authoringSessions: new Set(['author-1']),
  now: new Date('2026-11-09T12:00:00Z'),
  ...overrides,
});

/** A fake Llm that records prompts and answers from a script. */
function scriptedLlm(reply: (prompt: string, call: number) => string, model = 'served-model') {
  const prompts: string[] = [];
  const llm: Llm = async (prompt) => {
    prompts.push(prompt);
    return { content: reply(prompt, prompts.length), model, promptTokens: prompt.length };
  };
  return { llm, prompts };
}

const SOURCES = { project: '/work/dotfiles/.memory/cortex.db', global: null };

/** A fake snapshot that records nothing and refuses `excludedMemories` memories. */
const taken = (excludedMemories = 0) => () => ({ sources: SOURCES, excludedMemories });

const contextFor: MemoryContext = async (question) => `memory about ${question}`;
const quiet = () => {};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'cortex-eval-'));
  paths = evalPaths(dir);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('loadEvalSet', () => {
  test('names every bad line of the questions file', () => {
    writeSet([caseRow('q1'), { ...caseRow('q2'), kind: 'nope' }, caseRow('q1')]);
    expect(() => loadEvalSet(paths)).toThrow(/questions\.jsonl:2: q2: kind must be one of[\s\S]*questions\.jsonl:3: q1 appears twice/);
  });

  test('requires eval.json so contamination filtering is a conscious choice', () => {
    writeFileSync(paths.questions, JSON.stringify(caseRow('q1')));
    expect(() => loadEvalSet(paths)).toThrow(/eval\.json does not exist/);
  });
});

describe('openRun', () => {
  test('a new cortex run takes one snapshot and records where it came from and what it excluded', () => {
    let snapshots = 0;
    const manifest = openRun(paths.run('before' as RunName), request(), () => {
      snapshots++;
      return { sources: SOURCES, excludedMemories: 4 };
    });
    expect(snapshots).toBe(1);
    expect(manifest.memory).toEqual({
      kind: 'snapshot',
      branch: 'main',
      sources: SOURCES,
      excludedMemories: 4,
      excludedSessions: ['author-1'],
    });
    expect(manifest.createdAt).toBe('2026-11-09T12:00:00.000Z');
  });

  test('the baseline run takes no snapshot', () => {
    const manifest = openRun(paths.run('none' as RunName), request({ condition: 'none' }), () => {
      throw new Error('must not snapshot');
    });
    expect(manifest.memory).toEqual({ kind: 'none' });
  });

  test('resuming keeps the original identity, snapshot and start time', () => {
    const first = openRun(paths.run('before' as RunName), request(), taken(4));
    const resumed = openRun(
      paths.run('before' as RunName),
      request({ now: new Date('2026-12-01T00:00:00Z'), branch: 'feature' }),
      () => {
        throw new Error('must not snapshot again');
      },
    );
    expect(resumed).toEqual(first);
  });

  test('refuses to resume under a different setup', () => {
    openRun(paths.run('before' as RunName), request(), taken(4));
    expect(() =>
      openRun(paths.run('before' as RunName), request({ requestedModel: 'other-model' }), taken()),
    ).toThrow(/start a new run name[\s\S]*answer model: run has answer-model, now other-model/);
  });
});

describe('answerCases', () => {
  const cases = (): readonly EvalCase[] => {
    writeSet([caseRow('q1'), caseRow('q2'), caseRow('q3')]);
    return loadEvalSet(paths).cases;
  };

  test('answers every case from its memory context and records the served model', async () => {
    const all = cases();
    const runPaths = paths.run('before' as RunName);
    const manifest = openRun(runPaths, request(), taken());
    const { llm, prompts } = scriptedLlm(() => 'an answer');

    const outcome = await answerCases({ cases: all, manifest, paths: runPaths, llm, context: contextFor, log: quiet });

    expect(outcome).toEqual({ answered: 3, alreadyAnswered: 0, failed: [] });
    expect(prompts[0]).toContain('memory about question q1');
    expect(prompts[0]).toContain('Today is 2026-11-09');
    const rows = readFileSync(runPaths.answers, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map((r) => [r.id, r.answer_model])).toEqual([
      ['q1', 'served-model'],
      ['q2', 'served-model'],
      ['q3', 'served-model'],
    ]);
  });

  test('a failed case is reported, not stored, and answered on the next run', async () => {
    const all = cases();
    const runPaths = paths.run('before' as RunName);
    const manifest = openRun(runPaths, request(), taken());

    const flaky = scriptedLlm((prompt) => {
      if (prompt.includes('question q2')) throw new Error('LLM API 503');
      return 'ok';
    });
    const first = await answerCases({ cases: all, manifest, paths: runPaths, llm: flaky.llm, context: contextFor, log: quiet });
    expect(first.failed).toEqual([{ id: 'q2', error: 'LLM API 503' }]);

    const healthy = scriptedLlm(() => 'ok');
    const second = await answerCases({ cases: all, manifest, paths: runPaths, llm: healthy.llm, context: contextFor, log: quiet });
    expect(second).toEqual({ answered: 1, alreadyAnswered: 2, failed: [] });
    expect(healthy.prompts).toHaveLength(1);
    expect(healthy.prompts[0]).toContain('question q2');
  });
});

describe('scoreRuns', () => {
  async function answeredRun(name: string, answer: string, ids: readonly string[] = ['q1', 'q2']) {
    const runPaths = paths.run(name as RunName);
    const manifest = openRun(runPaths, request({ run: name as RunName }), taken());
    const { cases } = loadEvalSet(paths);
    await answerCases({
      cases: cases.filter((c) => ids.includes(c.id)),
      manifest,
      paths: runPaths,
      llm: scriptedLlm(() => answer).llm,
      context: contextFor,
      log: quiet,
    });
  }

  beforeEach(() => writeSet([caseRow('q1'), caseRow('q2', { split: 'held_out' })]));

  test('judges each answer once; a second scoring reuses the stored judgements', async () => {
    await answeredRun('before', 'answer');
    const { cases } = loadEvalSet(paths);
    const judge = scriptedLlm(() => verdict(0.5), 'judge-served');

    const first = await scoreRuns({ cases, paths, runs: ['before' as RunName], judge: judge.llm, judgeRequested: 'judge', log: quiet });
    expect(first[0].scored.map((s) => [s.evalCase.id, s.judgement.judgeModel])).toEqual([
      ['q1', 'judge-served'],
      ['q2', 'judge-served'],
    ]);

    const again = await scoreRuns({ cases, paths, runs: ['before' as RunName], judge: judge.llm, judgeRequested: 'judge', log: quiet });
    expect(again[0].scored).toHaveLength(2);
    expect(judge.prompts).toHaveLength(2);
  });

  test('editing a truth, or changing the judge model, re-judges that answer', async () => {
    await answeredRun('before', 'answer');
    const judge = scriptedLlm(() => verdict(1));
    const score = (judgeRequested: string) =>
      scoreRuns({ cases: loadEvalSet(paths).cases, paths, runs: ['before' as RunName], judge: judge.llm, judgeRequested, log: quiet });

    await score('judge');
    writeSet([caseRow('q1', { true_now: ['a corrected truth'] }), caseRow('q2', { split: 'held_out' })]);
    await score('judge');
    expect(judge.prompts).toHaveLength(3);
    expect(judge.prompts[2]).toContain('a corrected truth');

    await score('another-judge');
    expect(judge.prompts).toHaveLength(5);
  });

  test('an unusable verdict leaves the case unscored and unstored, so it is retried', async () => {
    await answeredRun('before', 'answer');
    const { cases } = loadEvalSet(paths);
    const sloppy = scriptedLlm((prompt) => (prompt.includes('question q1') ? 'looks fine to me' : verdict(1)));

    const [result] = await scoreRuns({ cases, paths, runs: ['before' as RunName], judge: sloppy.llm, judgeRequested: 'judge', log: quiet });
    expect(result.unscored).toEqual(['q1']);
    expect(result.scored.map((s) => s.evalCase.id)).toEqual(['q2']);
    const stored = readFileSync(paths.run('before' as RunName).scores, 'utf8').trim().split('\n');
    expect(stored).toHaveLength(1);
  });

  test('each result carries the memory its run answered from, read back from the manifest', async () => {
    await answeredRun('before', 'answer');
    const { cases } = loadEvalSet(paths);
    const [result] = await scoreRuns({
      cases,
      paths,
      runs: ['before' as RunName],
      judge: scriptedLlm(() => verdict(1)).llm,
      judgeRequested: 'judge',
      log: quiet,
    });
    expect(result.memory).toMatchObject({ kind: 'snapshot', sources: SOURCES });
  });

  test('a case one run never answered is reported as unanswered', async () => {
    await answeredRun('before', 'answer', ['q1']);
    const { cases } = loadEvalSet(paths);
    const [result] = await scoreRuns({
      cases,
      paths,
      runs: ['before' as RunName],
      judge: scriptedLlm(() => verdict(1)).llm,
      judgeRequested: 'judge',
      log: quiet,
    });
    expect(result.unanswered).toEqual(['q2']);
  });

  test('scoring a run that was never answered names the command to run', async () => {
    const { cases } = loadEvalSet(paths);
    await expect(
      scoreRuns({ cases, paths, runs: ['ghost' as RunName], judge: scriptedLlm(() => '').llm, judgeRequested: 'j', log: quiet }),
    ).rejects.toThrow(/run `eval answer ghost` first/);
  });

  test('the dry run reports reusable and pending judgements without calling a model', async () => {
    await answeredRun('before', 'answer', ['q1']);
    const { cases } = loadEvalSet(paths);
    expect(scoringPlan(cases, paths, ['before' as RunName], 'judge')).toBe(
      'before: 1 of 2 cases answered, 0 judgements reusable, 1 to judge with judge',
    );
  });
});

describe('parseEvalArgs', () => {
  const cwd = '/work/project';

  test('defaults the eval directory under the project memory dir', () => {
    expect(parseEvalArgs(['validate'], cwd)).toEqual({
      kind: 'validate',
      cwd,
      dir: '/work/project/.memory/eval',
    });
  });

  test('answer defaults to the cortex condition', () => {
    expect(parseEvalArgs(['answer', 'before', '--cwd=/other'], cwd)).toEqual({
      kind: 'answer',
      cwd: '/other',
      dir: '/other/.memory/eval',
      run: 'before',
      condition: 'cortex',
    });
    expect(parseEvalArgs(['answer', 'none', '--condition=none'], cwd)).toMatchObject({ condition: 'none' });
  });

  test('score compares one or two distinct runs', () => {
    expect(parseEvalArgs(['score', 'a', 'b', '--dry-run'], cwd)).toMatchObject({ runs: ['a', 'b'], dryRun: true });
    expect(parseEvalArgs(['score', 'a', 'a'], cwd)).toContain('Usage:');
    expect(parseEvalArgs(['score', 'a', 'b', 'c'], cwd)).toContain('Usage:');
  });

  test.each([
    [['answer'], 'Usage:'],
    [['answer', 'Bad/Name'], 'run names use lowercase'],
    [['answer', 'a', '--condition=maybe'], '--condition must be cortex or none'],
    [['score', 'a', '--condition=none'], 'unknown flag(s) for eval score: --condition'],
    [['frobnicate'], 'Usage:'],
  ])('rejects %j', (args, message) => {
    expect(parseEvalArgs(args, cwd)).toContain(message);
  });
});

test('evalPaths keeps every run inside its own directory', () => {
  const runPaths = evalPaths('/e').run('before' as RunName);
  expect(runPaths).toEqual({
    dir: '/e/runs/before',
    manifest: '/e/runs/before/run.json',
    snapshot: '/e/runs/before/memory',
    answers: '/e/runs/before/answers.jsonl',
    scores: '/e/runs/before/scores.jsonl',
  });
  expect(existsSync('/e')).toBe(false);
});
