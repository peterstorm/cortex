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
  renderAgreements,
  scoreRuns,
  scoringPlan,
  summarizeAnswering,
  type AnswerOutcome,
  type EvalPaths,
  type RunPaths,
  type RunRequest,
} from './eval.js';
import { parseLabels, type EvalCase, type RunName } from '../core/eval-set.js';
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

const contextFor: MemoryContext = async (question) => ({ text: `memory about ${question}`, recall: 'semantic' });
const quiet = () => {};

const readRows = (file: string): Record<string, unknown>[] =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

/** Cut a file as a write interrupted partway through its last line would leave it. */
function tearLastLine(file: string): void {
  const text = readFileSync(file, 'utf8');
  const lastLineStart = text.lastIndexOf('\n', text.length - 2) + 1;
  writeFileSync(file, text.slice(0, lastLineStart + 9));
}

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

  test('refuses to resume once the project is known by another name', () => {
    openRun(paths.run('before' as RunName), request(), taken(4));
    expect(() => openRun(paths.run('before' as RunName), request({ project: 'renamed' }), taken())).toThrow(
      /project: run has dotfiles, now renamed/,
    );
  });

  test('refuses a run.json whose condition contradicts the memory it records', () => {
    const runPaths = paths.run('before' as RunName);
    openRun(runPaths, request(), taken(4));
    const row = JSON.parse(readFileSync(runPaths.manifest, 'utf8'));
    writeFileSync(runPaths.manifest, JSON.stringify({ ...row, condition: 'none' }));

    expect(() => openRun(runPaths, request({ condition: 'none' }), taken())).toThrow(
      /condition none contradicts memory kind snapshot/,
    );
  });
});

describe('answerCases', () => {
  let runPaths: RunPaths;
  /** Answer the three cases of run `before`; `rest` swaps the memory context or the log. */
  let answer: (
    llm: Llm,
    rest?: Partial<{ context: MemoryContext; log: (line: string) => void }>,
  ) => Promise<AnswerOutcome>;

  beforeEach(() => {
    writeSet([caseRow('q1'), caseRow('q2'), caseRow('q3')]);
    const { cases } = loadEvalSet(paths);
    runPaths = paths.run('before' as RunName);
    const manifest = openRun(runPaths, request(), taken());
    answer = (llm, rest = {}) =>
      answerCases({ cases, manifest, paths: runPaths, llm, context: contextFor, log: quiet, ...rest });
  });

  test('answers every case from its memory context and records the served model', async () => {
    const { llm, prompts } = scriptedLlm(() => 'an answer');

    const outcome = await answer(llm);

    expect(outcome).toEqual({ answered: 3, alreadyAnswered: 0, failed: [] });
    expect(prompts[0]).toContain('memory about question q1');
    expect(prompts[0]).toContain('Today is 2026-11-09');
    expect(readRows(runPaths.answers).map((r) => [r.id, r.answer_model])).toEqual([
      ['q1', 'served-model'],
      ['q2', 'served-model'],
      ['q3', 'served-model'],
    ]);
  });

  test('each answer records the recall path its memory came through', async () => {
    const degraded: MemoryContext = async (question) => ({
      text: 'm',
      recall: question.endsWith('q2') ? 'keyword-fallback' : 'semantic',
    });

    await answer(scriptedLlm(() => 'a').llm, { context: degraded });

    expect(readRows(runPaths.answers).map((r) => r.recall)).toEqual(['semantic', 'keyword-fallback', 'semantic']);
  });

  test('an answer torn by an interrupted write is dropped, said so, and answered again', async () => {
    await answer(scriptedLlm(() => 'first').llm);
    tearLastLine(runPaths.answers);

    const logged: string[] = [];
    const retry = scriptedLlm(() => 'second');
    const outcome = await answer(retry.llm, { log: (line) => logged.push(line) });

    expect(outcome).toEqual({ answered: 1, alreadyAnswered: 2, failed: [] });
    expect(retry.prompts).toHaveLength(1);
    expect(retry.prompts[0]).toContain('question q3');
    expect(logged[0]).toContain('dropped an incomplete last line');
    expect(readRows(runPaths.answers).map((r) => [r.id, r.answer])).toEqual([
      ['q1', 'first'],
      ['q2', 'first'],
      ['q3', 'second'],
    ]);
  });

  test('a complete last answer that only lacks its newline is kept, and the next one starts a new line', async () => {
    writeFileSync(runPaths.answers, JSON.stringify({ id: 'q1', answer: 'written by hand' }));

    const logged: string[] = [];
    const outcome = await answer(scriptedLlm(() => 'a').llm, { log: (line) => logged.push(line) });

    expect(outcome).toEqual({ answered: 2, alreadyAnswered: 1, failed: [] });
    expect(logged.some((line) => line.includes('dropped'))).toBe(false);
    expect(readRows(runPaths.answers).map((r) => [r.id, r.answer])).toEqual([
      ['q1', 'written by hand'],
      ['q2', 'a'],
      ['q3', 'a'],
    ]);
  });

  test('a failed case is reported, not stored, and answered on the next run', async () => {
    const flaky = scriptedLlm((prompt) => {
      if (prompt.includes('question q2')) throw new Error('LLM API 503');
      return 'ok';
    });
    const first = await answer(flaky.llm);
    expect(first.failed).toEqual([{ id: 'q2', error: 'LLM API 503' }]);

    const healthy = scriptedLlm(() => 'ok');
    const second = await answer(healthy.llm);
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

  test('a judgement torn by an interrupted write is dropped and judged again; the others are reused', async () => {
    await answeredRun('before', 'answer');
    const { cases } = loadEvalSet(paths);
    const judge = scriptedLlm(() => verdict(1));
    const score = () => scoreRuns({ cases, paths, runs: ['before' as RunName], judge: judge.llm, judgeRequested: 'judge', log: quiet });
    await score();
    const scores = paths.run('before' as RunName).scores;
    tearLastLine(scores);

    expect(scoringPlan(cases, paths, ['before' as RunName], 'judge')).toBe(
      'before: 2 of 2 cases answered, 1 judgements reusable, 1 to judge with judge',
    );
    const [result] = await score();

    expect(result.scored.map((s) => s.evalCase.id)).toEqual(['q1', 'q2']);
    expect(judge.prompts).toHaveLength(3);
    expect(readRows(scores).map((r) => r.id)).toEqual(['q1', 'q2']);
  });

  test('a run whose last answer was torn scores the answers that were written whole', async () => {
    await answeredRun('before', 'answer');
    tearLastLine(paths.run('before' as RunName).answers);
    const { cases } = loadEvalSet(paths);

    const [result] = await scoreRuns({
      cases,
      paths,
      runs: ['before' as RunName],
      judge: scriptedLlm(() => verdict(1)).llm,
      judgeRequested: 'judge',
      log: quiet,
    });

    expect(result.scored.map((s) => s.evalCase.id)).toEqual(['q1']);
    expect(result.unanswered).toEqual(['q2']);
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

describe('summarizeAnswering', () => {
  const outcome = { answered: 2, alreadyAnswered: 1, failed: [] };

  test('a cortex run says how many authoring-session memories it excluded', () => {
    const manifest = openRun(paths.run('before' as RunName), request(), taken(4));
    expect(summarizeAnswering(manifest, outcome)).toEqual({
      output: 'run before (cortex): 2 answered now, 1 already answered; 4 authoring-session memories excluded',
      failure: null,
    });
  });

  test('the baseline run has no memory to exclude from', () => {
    const manifest = openRun(paths.run('none' as RunName), request({ run: 'none' as RunName, condition: 'none' }), taken());
    expect(summarizeAnswering(manifest, outcome).output).toBe('run none (none): 2 answered now, 1 already answered');
  });

  test('any failed case fails the pass and says how to retry', () => {
    const manifest = openRun(paths.run('before' as RunName), request(), taken());
    const failed = [{ id: 'q2' as EvalCase['id'], error: 'LLM API 503' }];
    expect(summarizeAnswering(manifest, { ...outcome, failed }).failure).toBe(
      '1 case(s) failed; run the same command again to retry them',
    );
  });
});

describe('renderAgreements', () => {
  test('renders a table for each labelled run and none for a run nobody labelled', async () => {
    writeSet([caseRow('q1')]);
    const { cases } = loadEvalSet(paths);
    for (const name of ['before', 'after']) {
      const runPaths = paths.run(name as RunName);
      const manifest = openRun(runPaths, request({ run: name as RunName }), taken());
      await answerCases({ cases, manifest, paths: runPaths, llm: scriptedLlm(() => 'a').llm, context: contextFor, log: quiet });
    }
    const results = await scoreRuns({
      cases,
      paths,
      runs: ['before' as RunName, 'after' as RunName],
      judge: scriptedLlm(() => verdict(1)).llm,
      judgeRequested: 'judge',
      log: quiet,
    });
    const labels = parseLabels(JSON.stringify({ run: 'after', id: 'q1', relevant: 0.5 }));
    if (labels.kind !== 'ok') throw new Error('labels fixture must parse');

    const tables = renderAgreements(results, labels.value);

    expect(tables).toHaveLength(1);
    expect(tables[0]).toContain('judge vs your labels for after');
    expect(tables[0]).toMatch(/relevant\s+0\.50\s+\(1\)\s+<- check the judge/);
    expect(renderAgreements(results, [])).toEqual([]);
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
