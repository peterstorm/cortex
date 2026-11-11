/**
 * Eval command: score what an agent answers from cortex's memory against a
 * test set of real cases — Team0's "Measure before you build" applied to
 * cortex's read path.
 *
 * Imperative shell. The orchestrators here depend only on the eval ports
 * (Llm, MemoryContext) and the eval directory; prompts, parsing, judging and
 * aggregation are the pure core in core/eval-*.ts, and the adapters live in
 * eval-adapters.ts.
 *
 * Eval directory (default <project>/.memory/eval, gitignored with .memory/):
 *   eval.json                 {"authoring_sessions": [...]}
 *   questions.jsonl           confirmed cases
 *   labels.jsonl              optional: your own scores, to check the judge
 *   runs/<run>/run.json       the run's identity (condition, model, snapshot)
 *   runs/<run>/memory/        the frozen DB snapshot the run answers from
 *   runs/<run>/answers.jsonl  one line per answer, appended as answered
 *   runs/<run>/scores.jsonl   one line per judgement, keyed by the judge prompt
 */

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  formatParseErrors,
  parseAnswers,
  parseCases,
  parseEvalSettings,
  parseIsoDate,
  parseLabels,
  parseRunName,
  type Answer,
  type CaseId,
  type EvalCase,
  type EvalSettings,
  type IsoDate,
  type Label,
  type ParseResult,
  type RunName,
} from '../core/eval-set.js';
import {
  buildAnswerPrompt,
  buildJudgePrompt,
  judgementToRow,
  parseJudgements,
  parseVerdict,
  ANSWER_PROMPT,
  type Judgement,
  type RunResult,
  type ScoredAnswer,
} from '../core/eval-rubric.js';
import {
  manifestToRow,
  parseCondition,
  parseManifest,
  resumeConflicts,
  type Condition,
  type Llm,
  type MemoryContext,
  type MemorySource,
  type RunIdentity,
  type RunManifest,
  type SnapshotSources,
} from '../core/eval-run.js';

// ============================================================================
// EVAL DIRECTORY
// ============================================================================

export type RunPaths = Readonly<{
  dir: string;
  manifest: string;
  snapshot: string;
  answers: string;
  scores: string;
}>;

export type EvalPaths = Readonly<{
  dir: string;
  settings: string;
  questions: string;
  labels: string;
  run: (name: RunName) => RunPaths;
}>;

export const defaultEvalDir = (cwd: string): string => path.join(cwd, '.memory', 'eval');

export function evalPaths(dir: string): EvalPaths {
  return {
    dir,
    settings: path.join(dir, 'eval.json'),
    questions: path.join(dir, 'questions.jsonl'),
    labels: path.join(dir, 'labels.jsonl'),
    run: (name) => {
      const runDir = path.join(dir, 'runs', name);
      return {
        dir: runDir,
        manifest: path.join(runDir, 'run.json'),
        snapshot: path.join(runDir, 'memory'),
        answers: path.join(runDir, 'answers.jsonl'),
        scores: path.join(runDir, 'scores.jsonl'),
      };
    },
  };
}

/** Parse a required file; every parse error becomes one thrown message. */
function readParsed<T>(file: string, parse: (text: string) => ParseResult<T>): T {
  if (!existsSync(file)) throw new Error(`${file} does not exist`);
  const result = parse(readFileSync(file, 'utf8'));
  if (result.kind === 'err') throw new Error(formatParseErrors(file, result.errors));
  return result.value;
}

function readOptional<T>(file: string, parse: (text: string) => ParseResult<T>, absent: T): T {
  return existsSync(file) ? readParsed(file, parse) : absent;
}

const appendRow = (file: string, row: Record<string, unknown>): void =>
  appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');

function writeJsonAtomic(file: string, value: Record<string, unknown>): void {
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, file);
}

export const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

export type EvalSet = Readonly<{ cases: readonly EvalCase[]; settings: EvalSettings }>;

/** @throws Error naming every invalid line, or a missing file */
export function loadEvalSet(paths: EvalPaths): EvalSet {
  return {
    settings: readParsed(paths.settings, parseEvalSettings),
    cases: readParsed(paths.questions, parseCases),
  };
}

export const loadLabels = (paths: EvalPaths): readonly Label[] =>
  readOptional(paths.labels, parseLabels, []);

// ============================================================================
// ANSWERING
// ============================================================================

export type RunRequest = Readonly<{
  run: RunName;
  condition: Condition;
  project: string;
  requestedModel: string;
  branch: string;
  authoringSessions: ReadonlySet<string>;
  now: Date;
}>;

/** What taking a snapshot produced: where it was copied from, and how many memories the eval refuses. */
export type SnapshotTaken = Readonly<{ sources: SnapshotSources; excludedMemories: number }>;

/** Take the memory snapshot into a directory. */
export type TakeSnapshot = (snapshotDir: string) => SnapshotTaken;

/**
 * Resume the run when its identity matches, or start it: snapshot memory
 * (cortex condition), then write the manifest. A conflicting resume is
 * refused, because mixing two setups in one run makes it incomparable.
 *
 * @throws Error listing every identity conflict
 */
export function openRun(paths: RunPaths, request: RunRequest, takeSnapshot: TakeSnapshot): RunManifest {
  const identity: RunIdentity = {
    condition: request.condition,
    project: request.project,
    requestedModel: request.requestedModel,
    answerPromptDigest: sha256(ANSWER_PROMPT),
    excludedSessions: [...request.authoringSessions].sort(),
  };

  if (existsSync(paths.manifest)) {
    const existing = readParsed(paths.manifest, parseManifest);
    const conflicts = resumeConflicts(existing, identity);
    if (conflicts.length > 0) {
      throw new Error(
        `run ${request.run} was started with a different setup; start a new run name to compare:\n` +
          conflicts.map((c) => `  - ${c}`).join('\n'),
      );
    }
    return existing;
  }

  mkdirSync(paths.dir, { recursive: true });
  const memory: MemorySource =
    identity.condition === 'none'
      ? { kind: 'none' }
      : {
          kind: 'snapshot',
          branch: request.branch,
          excludedSessions: identity.excludedSessions,
          ...takeSnapshot(paths.snapshot),
        };
  const manifest: RunManifest = {
    run: request.run,
    condition: identity.condition,
    project: identity.project,
    requestedModel: identity.requestedModel,
    answerPromptDigest: identity.answerPromptDigest,
    memory,
    createdAt: request.now.toISOString(),
  };
  writeJsonAtomic(paths.manifest, manifestToRow(manifest));
  return manifest;
}

export type AnswerOutcome = Readonly<{
  answered: number;
  alreadyAnswered: number;
  failed: readonly Readonly<{ id: CaseId; error: string }>[];
}>;

/** The answer date is pinned to the run's start, so a resumed run asks the same prompt. */
function runDate(manifest: RunManifest): IsoDate {
  const date = parseIsoDate(manifest.createdAt.slice(0, 10));
  if (!date) throw new Error(`run ${manifest.run} has an invalid created_at`);
  return date;
}

/**
 * Answer every case the run has not answered yet, appending each answer as it
 * lands so an interruption loses at most one. A failed case is reported and
 * retried on the next invocation.
 */
export async function answerCases(deps: {
  readonly cases: readonly EvalCase[];
  readonly manifest: RunManifest;
  readonly paths: RunPaths;
  readonly llm: Llm;
  readonly context: MemoryContext;
  readonly log: (line: string) => void;
}): Promise<AnswerOutcome> {
  const { cases, manifest, paths, llm, context, log } = deps;
  const done = new Set(readOptional(paths.answers, parseAnswers, []).map((a) => a.id));
  const today = runDate(manifest);
  const failed: { id: CaseId; error: string }[] = [];
  let answered = 0;

  for (const evalCase of cases) {
    if (done.has(evalCase.id)) continue;
    try {
      const memory = await context(evalCase.question);
      const reply = await llm(buildAnswerPrompt(evalCase.question, memory, manifest.project, today));
      appendRow(paths.answers, {
        id: evalCase.id,
        answer: reply.content,
        prompt_tokens: reply.promptTokens,
        answer_model: reply.model,
        context_chars: memory.length,
        answered_at: new Date().toISOString(),
      });
      answered++;
      log(`${evalCase.id}: answered (${reply.promptTokens ?? '?'} prompt tokens)`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      failed.push({ id: evalCase.id, error });
      log(`${evalCase.id}: FAILED ${error}`);
    }
  }

  return { answered, alreadyAnswered: done.size, failed };
}

// ============================================================================
// SCORING
// ============================================================================

type LoadedRun = Readonly<{
  run: RunName;
  paths: RunPaths;
  memory: MemorySource;
  answers: ReadonlyMap<CaseId, Answer>;
  judgements: readonly Judgement[];
}>;

function loadRun(paths: EvalPaths, run: RunName): LoadedRun {
  const runPaths = paths.run(run);
  if (!existsSync(runPaths.answers)) {
    throw new Error(`run ${run} has no answers at ${runPaths.answers}; run \`eval answer ${run}\` first`);
  }
  return {
    run,
    paths: runPaths,
    memory: readParsed(runPaths.manifest, parseManifest).memory,
    answers: new Map(readParsed(runPaths.answers, parseAnswers).map((a) => [a.id, a])),
    judgements: readOptional(runPaths.scores, parseJudgements, []),
  };
}

/**
 * A judgement is reused only for exactly what it scored: the rendered judge
 * prompt (rubric, case and answer) and the judge model requested.
 */
export const judgeKey = (judgePrompt: string, judgeRequested: string): string =>
  sha256(`${judgeRequested}\n${judgePrompt}`);

type CaseScoring = Readonly<
  | { kind: 'unanswered' }
  | { kind: 'cached'; scored: ScoredAnswer }
  | { kind: 'to-judge'; answer: Answer; prompt: string; key: string }
>;

function planCase(loaded: LoadedRun, evalCase: EvalCase, judgeRequested: string): CaseScoring {
  const answer = loaded.answers.get(evalCase.id);
  if (!answer) return { kind: 'unanswered' };
  const prompt = buildJudgePrompt(evalCase, answer.answer);
  const key = judgeKey(prompt, judgeRequested);
  const cached = loaded.judgements.find((j) => j.id === evalCase.id && j.key === key);
  return cached
    ? { kind: 'cached', scored: { evalCase, answer, judgement: cached } }
    : { kind: 'to-judge', answer, prompt, key };
}

/** Dry run: what scoring would reuse and what it would send to the judge. No model is called. */
export function scoringPlan(
  cases: readonly EvalCase[],
  paths: EvalPaths,
  runs: readonly RunName[],
  judgeRequested: string,
): string {
  return runs
    .map((run) => {
      const loaded = loadRun(paths, run);
      const plans = cases.map((c) => planCase(loaded, c, judgeRequested));
      const count = (kind: CaseScoring['kind']) => plans.filter((p) => p.kind === kind).length;
      return (
        `${run}: ${cases.length - count('unanswered')} of ${cases.length} cases answered, ` +
        `${count('cached')} judgements reusable, ${count('to-judge')} to judge with ${judgeRequested}`
      );
    })
    .join('\n');
}

/** Ask the judge about one case; a string says why it stays unscored. */
async function judgeCase(
  judge: Llm,
  plan: Extract<CaseScoring, { kind: 'to-judge' }>,
  id: CaseId,
): Promise<Judgement | string> {
  try {
    const reply = await judge(plan.prompt);
    const verdict = parseVerdict(reply.content);
    if (verdict.kind === 'err') return `unscorable judge reply (${verdict.message})`;
    return {
      id,
      key: plan.key,
      judgeModel: reply.model,
      scores: verdict.verdict.scores,
      reason: verdict.verdict.reason,
      scoredAt: new Date().toISOString(),
    };
  } catch (err) {
    return `judge failed (${err instanceof Error ? err.message : String(err)})`;
  }
}

/**
 * Judge every answered case of each run, reusing stored judgements and
 * appending new ones as they land. A reply that is not a complete verdict
 * leaves the case unscored (and unstored, so the next run retries it).
 */
export async function scoreRuns(deps: {
  readonly cases: readonly EvalCase[];
  readonly paths: EvalPaths;
  readonly runs: readonly RunName[];
  readonly judge: Llm;
  readonly judgeRequested: string;
  readonly log: (line: string) => void;
}): Promise<readonly RunResult[]> {
  const { cases, paths, judge, judgeRequested, log } = deps;
  const loadedRuns = deps.runs.map((run) => loadRun(paths, run));
  const results: RunResult[] = [];

  for (const loaded of loadedRuns) {
    const scored: ScoredAnswer[] = [];
    const unanswered: CaseId[] = [];
    const unscored: CaseId[] = [];

    for (const evalCase of cases) {
      const plan = planCase(loaded, evalCase, judgeRequested);
      if (plan.kind === 'unanswered') {
        unanswered.push(evalCase.id);
        continue;
      }
      if (plan.kind === 'cached') {
        scored.push(plan.scored);
        continue;
      }
      const judgement = await judgeCase(judge, plan, evalCase.id);
      if (typeof judgement === 'string') {
        unscored.push(evalCase.id);
        log(`${loaded.run}/${evalCase.id}: ${judgement}`);
        continue;
      }
      appendRow(loaded.paths.scores, judgementToRow(judgement));
      scored.push({ evalCase, answer: plan.answer, judgement });
      log(`${loaded.run}/${evalCase.id}: judged`);
    }

    results.push({ run: loaded.run, memory: loaded.memory, scored, unanswered, unscored });
  }
  return results;
}

// ============================================================================
// ARGUMENTS
// ============================================================================

export type EvalCommand =
  | Readonly<{ kind: 'validate'; cwd: string; dir: string }>
  | Readonly<{ kind: 'answer'; cwd: string; dir: string; run: RunName; condition: Condition }>
  | Readonly<{
      kind: 'score';
      cwd: string;
      dir: string;
      runs: readonly [RunName] | readonly [RunName, RunName];
      dryRun: boolean;
    }>;

export const EVAL_USAGE = [
  'Usage:',
  '  eval validate [--cwd=<project>] [--dir=<eval dir>]',
  '  eval answer <run> [--condition=cortex|none] [--cwd=<project>] [--dir=<eval dir>]',
  '  eval score <run> [<run>] [--dry-run] [--cwd=<project>] [--dir=<eval dir>]',
].join('\n');

/** Parse `eval` arguments into a command, or an error message. */
export function parseEvalArgs(args: readonly string[], defaultCwd: string): EvalCommand | string {
  const [sub, ...rest] = args;
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (const arg of rest) {
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    flags.set(eq === -1 ? arg.slice(2) : arg.slice(2, eq), eq === -1 ? 'true' : arg.slice(eq + 1));
  }

  const allowed: Readonly<Record<string, readonly string[]>> = {
    validate: ['cwd', 'dir'],
    answer: ['cwd', 'dir', 'condition'],
    score: ['cwd', 'dir', 'dry-run'],
  };
  if (sub === undefined || !(sub in allowed)) return EVAL_USAGE;
  const unknown = [...flags.keys()].filter((f) => !allowed[sub].includes(f));
  if (unknown.length > 0) return `unknown flag(s) for eval ${sub}: --${unknown.join(', --')}\n${EVAL_USAGE}`;

  const cwd = path.resolve(flags.get('cwd') ?? defaultCwd);
  const dir = path.resolve(flags.get('dir') ?? defaultEvalDir(cwd));
  const named = positional.map(parseRunName).filter((r): r is RunName => r !== null);
  if (named.length !== positional.length) {
    return 'run names use lowercase letters, digits, ".", "_" and "-", starting with a letter or digit';
  }

  if (sub === 'validate') {
    return positional.length === 0 ? { kind: 'validate', cwd, dir } : EVAL_USAGE;
  }
  if (sub === 'answer') {
    const condition = parseCondition(flags.get('condition') ?? 'cortex');
    if (!condition) return '--condition must be cortex or none';
    return named.length === 1 ? { kind: 'answer', cwd, dir, run: named[0], condition } : EVAL_USAGE;
  }
  const dryRun = flags.get('dry-run') === 'true';
  if (named.length === 1) return { kind: 'score', cwd, dir, runs: [named[0]], dryRun };
  if (named.length === 2 && named[0] !== named[1]) {
    return { kind: 'score', cwd, dir, runs: [named[0], named[1]], dryRun };
  }
  return EVAL_USAGE;
}
