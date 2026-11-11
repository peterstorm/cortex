/**
 * Eval set: the test cases, answers and human labels the memory evaluation
 * reads, parsed from JSONL at the boundary into types that cannot hold an
 * invalid case.
 *
 * Method: Team0's "Measure before you build" (team0.ai/learn, MIT): about 20
 * questions from real work, each with what is true now and which outdated
 * values must not be presented as current, a third held out from tuning.
 *
 * Pure functional core — no I/O. Every parser returns a ParseResult carrying
 * ALL line errors, so one validation pass reports the whole file.
 */

import { isRecallPath, type RecallPath } from './types.js';

// ============================================================================
// DOMAIN TYPES
// ============================================================================

/** Practice cases may be tuned against; held-out cases measure real use. */
export type Split = 'practice' | 'held_out';
export const SPLITS: readonly Split[] = ['practice', 'held_out'] as const;

/** The five kinds of memory failure a case probes (Part 0, step 1). */
export type CaseKind =
  | 'changed_value'
  | 'same_entity'
  | 'unheard_decision'
  | 'commitment'
  | 'non_fact';
export const CASE_KINDS: readonly CaseKind[] = [
  'changed_value',
  'same_entity',
  'unheard_decision',
  'commitment',
  'non_fact',
] as const;

export type CaseId = string & { readonly __brand: 'CaseId' };
export type RunName = string & { readonly __brand: 'RunName' };
/** Calendar date, YYYY-MM-DD. */
export type IsoDate = string & { readonly __brand: 'IsoDate' };

export type NonEmptyArray<T> = readonly [T, ...T[]];

export type EvalCase = Readonly<{
  id: CaseId;
  split: Split;
  kind: CaseKind;
  /** The date the current truth was established. */
  askedOn: IsoDate;
  question: string;
  /** What is true now, most important first. */
  trueNow: NonEmptyArray<string>;
  /** Outdated values that must not be presented as current. */
  stale: readonly string[];
}>;

/**
 * One agent answer. `toolCalls` comes from answers collected by hand from a
 * tool-using agent; `promptTokens` from the harness's tool-less answerer,
 * where the injected context size is the read cost.
 */
export type Answer = Readonly<{
  id: CaseId;
  answer: string;
  toolCalls: number | null;
  promptTokens: number | null;
  /** The model that answered, as the provider reported it. */
  model: string | null;
  /**
   * How the memory this answer read was recalled. Null for an answer that
   * does not say: one collected by hand, or written before this was recorded.
   */
  recall: RecallPath | null;
}>;

/** The five measures every answer is judged on, each 0..1, higher is better. */
export type Measure = 'correct_current' | 'relevant' | 'missed' | 'ordered' | 'context_complete';
export const MEASURES: readonly Measure[] = [
  'correct_current',
  'relevant',
  'missed',
  'ordered',
  'context_complete',
] as const;

export type UnitScore = number & { readonly __brand: 'UnitScore' };
export type Measures = Readonly<Record<Measure, UnitScore>>;

/** A person's own scores for one answer of one run, used to check the judge. */
export type Label = Readonly<{
  run: RunName;
  id: CaseId;
  scores: Readonly<Partial<Record<Measure, UnitScore>>>;
}>;

/** Eval-set settings that apply to every run. */
export type EvalSettings = Readonly<{
  /**
   * Sessions in which the eval set was written or reviewed. Memories
   * extracted from them hold the answer key, so the memory read excludes them.
   */
  authoringSessions: ReadonlySet<string>;
}>;

export type ParseError = Readonly<{ line: number; message: string }>;

export type ParseResult<T> =
  | Readonly<{ kind: 'ok'; value: T }>
  | Readonly<{ kind: 'err'; errors: readonly ParseError[] }>;

// ============================================================================
// SMART CONSTRUCTORS
// ============================================================================

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const RUN_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function parseCaseId(raw: unknown): CaseId | null {
  return typeof raw === 'string' && ID_PATTERN.test(raw) ? (raw as CaseId) : null;
}

/** Run names become directory names, so they are restricted to a safe charset. */
export function parseRunName(raw: unknown): RunName | null {
  return typeof raw === 'string' && RUN_NAME_PATTERN.test(raw) && !raw.includes('..')
    ? (raw as RunName)
    : null;
}

export function parseIsoDate(raw: unknown): IsoDate | null {
  if (typeof raw !== 'string' || !ISO_DATE_PATTERN.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00Z`);
  // Round-trip rejects impossible dates such as 2026-02-30.
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(raw)
    ? (raw as IsoDate)
    : null;
}

export function parseUnitScore(raw: unknown): UnitScore | null {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1
    ? (raw as UnitScore)
    : null;
}

function isSplit(raw: unknown): raw is Split {
  return typeof raw === 'string' && (SPLITS as readonly string[]).includes(raw);
}

function isCaseKind(raw: unknown): raw is CaseKind {
  return typeof raw === 'string' && (CASE_KINDS as readonly string[]).includes(raw);
}

function nonBlankStrings(raw: unknown): readonly string[] | null {
  if (!Array.isArray(raw)) return null;
  const strings = raw.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
  return strings.length === raw.length ? strings : null;
}

function isNonEmpty<T>(items: readonly T[]): items is NonEmptyArray<T> {
  return items.length > 0;
}

function nonNegativeIntOrNull(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null) return null;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 ? raw : undefined;
}

// ============================================================================
// JSONL PARSING
// ============================================================================

export type Row = Readonly<Record<string, unknown>>;
type RowParser<T> = (row: Row) => T | string;

/**
 * Parse JSONL: one object per non-blank line, every line through `parseRow`,
 * ids unique by `keyOf`. Collects every error rather than stopping at the first.
 */
export function parseJsonl<T>(
  text: string,
  parseRow: RowParser<T>,
  keyOf: (item: T) => string,
): ParseResult<readonly T[]> {
  const items: T[] = [];
  const errors: ParseError[] = [];
  const seen = new Set<string>();

  text.split('\n').forEach((raw, index) => {
    const line = index + 1;
    if (raw.trim() === '') return;

    let row: unknown;
    try {
      row = JSON.parse(raw);
    } catch {
      errors.push({ line, message: 'expected one complete JSON object on this line' });
      return;
    }
    if (typeof row !== 'object' || row === null || Array.isArray(row)) {
      errors.push({ line, message: 'expected a JSON object' });
      return;
    }

    const parsed = parseRow(row as Row);
    if (typeof parsed === 'string') {
      errors.push({ line, message: parsed });
      return;
    }
    const key = keyOf(parsed);
    if (seen.has(key)) {
      errors.push({ line, message: `${key} appears twice` });
      return;
    }
    seen.add(key);
    items.push(parsed);
  });

  return errors.length > 0 ? { kind: 'err', errors } : { kind: 'ok', value: items };
}

/** Parse a file that holds one JSON object (not a list, not a scalar). */
export function parseJsonObject(text: string): ParseResult<Row> {
  const notAnObject: ParseResult<Row> = {
    kind: 'err',
    errors: [{ line: 1, message: 'expected a JSON object' }],
  };
  try {
    const raw: unknown = JSON.parse(text);
    return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
      ? { kind: 'ok', value: raw as Row }
      : notAnObject;
  } catch {
    return notAnObject;
  }
}

/**
 * A file appended to one line at a time, split at an interrupted write.
 *
 * A process killed mid-append leaves a final line that is neither terminated
 * nor complete JSON. That line is `torn`: it was never a row, and the next
 * append must not be glued onto it. A final line that is complete JSON but
 * lacks its newline (a hand-edited file) is a row and stays in `complete`.
 */
export type AppendedLines = Readonly<{ complete: string; torn: string | null }>;

export function splitTornTail(text: string): AppendedLines {
  if (text === '' || text.endsWith('\n')) return { complete: text, torn: null };
  const lastBreak = text.lastIndexOf('\n');
  const tail = text.slice(lastBreak + 1);
  try {
    JSON.parse(tail);
    return { complete: text, torn: null };
  } catch {
    return { complete: text.slice(0, lastBreak + 1), torn: tail };
  }
}

/** Reject keys outside the schema: a typo such as `true_nwo` must not pass silently. */
function unknownKeys(row: Row, allowed: readonly string[]): string | null {
  const extra = Object.keys(row).filter((key) => !allowed.includes(key));
  return extra.length > 0 ? `unknown field(s): ${extra.join(', ')}` : null;
}

const CASE_KEYS = ['id', 'split', 'kind', 'asked_on', 'question', 'true_now', 'stale'] as const;

export function parseCaseRow(row: Row): EvalCase | string {
  const extra = unknownKeys(row, CASE_KEYS);
  if (extra) return extra;

  const id = parseCaseId(row.id);
  if (!id) return 'id must be a non-empty string of letters, digits, _ or -';
  if (!isSplit(row.split)) return `${id}: split must be one of ${SPLITS.join(', ')}`;
  if (!isCaseKind(row.kind)) return `${id}: kind must be one of ${CASE_KINDS.join(', ')}`;
  const askedOn = parseIsoDate(row.asked_on);
  if (!askedOn) return `${id}: asked_on must be a real YYYY-MM-DD date`;
  if (typeof row.question !== 'string' || row.question.trim() === '') {
    return `${id}: question must be a non-empty string`;
  }
  const trueNow = nonBlankStrings(row.true_now);
  if (!trueNow || !isNonEmpty(trueNow)) {
    return `${id}: true_now must be a non-empty list of non-empty strings`;
  }
  const stale = row.stale === undefined ? [] : nonBlankStrings(row.stale);
  if (!stale) return `${id}: stale must be a list of non-empty strings`;

  return { id, split: row.split, kind: row.kind, askedOn, question: row.question, trueNow, stale };
}

/**
 * Answers files accept Team0's format ({id, answer, tool_calls?}) plus the
 * harness's own fields; anything else is ignored so hand-collected answer
 * files can carry their own notes.
 */
export function parseAnswerRow(row: Row): Answer | string {
  const id = parseCaseId(row.id);
  if (!id) return 'id must be a non-empty string of letters, digits, _ or -';
  if (typeof row.answer !== 'string') return `${id}: answer must be a string`;
  const toolCalls = nonNegativeIntOrNull(row.tool_calls);
  if (toolCalls === undefined) return `${id}: tool_calls must be a non-negative integer`;
  const promptTokens = nonNegativeIntOrNull(row.prompt_tokens);
  if (promptTokens === undefined) return `${id}: prompt_tokens must be a non-negative integer`;
  const model = typeof row.answer_model === 'string' ? row.answer_model : null;
  const recall = isRecallPath(row.recall) ? row.recall : null;
  return { id, answer: row.answer, toolCalls, promptTokens, model, recall };
}

const LABEL_KEYS = ['run', 'id', ...MEASURES] as const;

export function parseLabelRow(row: Row): Label | string {
  const extra = unknownKeys(row, LABEL_KEYS);
  if (extra) return extra;
  const run = parseRunName(row.run);
  if (!run) return 'run must name the run whose answer was labelled';
  const id = parseCaseId(row.id);
  if (!id) return 'id must be a non-empty string of letters, digits, _ or -';

  const scores: Partial<Record<Measure, UnitScore>> = {};
  for (const measure of MEASURES) {
    if (row[measure] === undefined) continue;
    const score = parseUnitScore(row[measure]);
    if (score === null) return `${id}: ${measure} must be a number from 0 to 1`;
    scores[measure] = score;
  }
  if (Object.keys(scores).length === 0) return `${id}: label at least one measure`;
  return { run, id, scores };
}

export const parseCases = (text: string): ParseResult<readonly EvalCase[]> =>
  parseJsonl(text, parseCaseRow, (c) => c.id);

export const parseAnswers = (text: string): ParseResult<readonly Answer[]> =>
  parseJsonl(text, parseAnswerRow, (a) => a.id);

export const parseLabels = (text: string): ParseResult<readonly Label[]> =>
  parseJsonl(text, parseLabelRow, (l) => `${l.run}/${l.id}`);

export function parseEvalSettings(text: string): ParseResult<EvalSettings> {
  const fail = (message: string): ParseResult<EvalSettings> => ({
    kind: 'err',
    errors: [{ line: 1, message }],
  });
  const parsed = parseJsonObject(text);
  if (parsed.kind === 'err') return parsed;
  const extra = unknownKeys(parsed.value, ['authoring_sessions']);
  if (extra) return fail(extra);
  const sessions = nonBlankStrings(parsed.value.authoring_sessions);
  if (!sessions) {
    return fail('authoring_sessions must be a list of session ids (use [] when there are none)');
  }
  return { kind: 'ok', value: { authoringSessions: new Set(sessions) } };
}

// ============================================================================
// DESCRIPTION
// ============================================================================

/** The method's target size: a useful diagnostic, not a precise estimate. */
export const TARGET_CASES = 20;

/** Coverage summary and method warnings for a parsed eval set. */
export function describeEvalSet(cases: readonly EvalCase[], settings: EvalSettings): string {
  const count = (pred: (c: EvalCase) => boolean) => cases.filter(pred).length;
  const heldOut = count((c) => c.split === 'held_out');
  const kinds = CASE_KINDS.map((k) => [k, count((c) => c.kind === k)] as const);

  const warnings = [
    ...(cases.length < TARGET_CASES
      ? [`${cases.length} cases; the method calls for about ${TARGET_CASES}`]
      : []),
    ...(heldOut === 0 && cases.length > 0
      ? ['no held_out case: practice scores cannot tell tuning from improvement']
      : []),
    ...(heldOut > 0 && Math.abs(heldOut / cases.length - 1 / 3) > 0.1
      ? [`held_out is ${Math.round((100 * heldOut) / cases.length)}% of cases; aim for about a third`]
      : []),
    ...kinds.filter(([, n]) => n === 0).map(([k]) => `no ${k} case`),
    ...(settings.authoringSessions.size === 0
      ? ['no authoring sessions listed: memories extracted while writing this set would leak the answer key']
      : []),
  ];

  return [
    `${cases.length} cases: ${cases.length - heldOut} practice, ${heldOut} held_out`,
    `kinds: ${kinds.map(([k, n]) => `${k} ${n}`).join(', ')}`,
    `authoring sessions excluded from memory reads: ${settings.authoringSessions.size}`,
    ...(warnings.length > 0 ? ['warnings:', ...warnings.map((w) => `  - ${w}`)] : []),
  ].join('\n');
}

export function formatParseErrors(file: string, errors: readonly ParseError[]): string {
  return errors.map(({ line, message }) => `${file}:${line}: ${message}`).join('\n');
}
