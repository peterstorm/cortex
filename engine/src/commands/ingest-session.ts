/**
 * Detached session-ingestion orchestration.
 *
 * The Pi extension starts this pipeline in a background process so session
 * replacement and shutdown never wait for transcript extraction or LLM work.
 */

import { match } from 'ts-pattern';

export type IngestionStepResult =
  | Readonly<{ kind: 'succeeded'; output?: string }>
  | Readonly<{ kind: 'failed'; retryable: boolean; error: string; output?: string }>
  | Readonly<{ kind: 'deferred'; reason: string }>;

export type IngestionStepOutcome =
  | Exclude<IngestionStepResult, { kind: 'deferred' }>
  | Readonly<{ kind: 'skipped'; reason: string }>;

export type SessionIngestionResult = Readonly<{
  extraction: IngestionStepOutcome;
  backfill: IngestionStepOutcome;
  maintenance: IngestionStepOutcome;
}>;

export type SessionIngestionOperations = Readonly<{
  extract: () => Promise<IngestionStepResult>;
  backfill: () => Promise<IngestionStepResult>;
  maintenance: () => Promise<IngestionStepResult>;
}>;

/**
 * How long the detached worker keeps asking, with one budget per reason.
 *
 * Waiting for a lock and retrying a failure are different bets. A deferral
 * means another extraction holds the per-project lock and will release it, so
 * waiting is cheap and almost certain to pay off. A retryable failure means
 * the LLM call or a write failed; a few tries cover a blip, and past that the
 * chunk cursor carries the work to the next run. One shared budget of 121
 * spent ten minutes re-sending a failing extraction to a struggling server.
 */
export type SessionIngestionRetryPolicy = Readonly<{
  /** Attempts in total while extraction keeps reporting the lock as held. */
  maxDeferredAttempts: number;
  /** Attempts in total while extraction keeps failing retryably. */
  maxFailedAttempts: number;
  retryDelayMs: (completedAttempts: number) => number;
  sleep: (milliseconds: number) => Promise<void>;
}>;

export const DEFAULT_RETRY_POLICY: SessionIngestionRetryPolicy = {
  // A detached worker may wait up to roughly ten minutes for an extraction
  // already holding the per-project lock. This serializes overlapping session
  // shutdowns without delaying /new or /q in the parent Pi process.
  maxDeferredAttempts: 121,
  maxFailedAttempts: 3,
  retryDelayMs: (completedAttempts) => Math.min(250 * (2 ** Math.min(completedAttempts - 1, 5)), 5_000),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

/** Extraction attempts made so far, counted by why each was retried. */
export type ExtractionAttempts = Readonly<{ deferred: number; failed: number }>;

type ExtractionOutcome = Exclude<IngestionStepResult, { kind: 'deferred' }>;

/** What the worker does after one extraction attempt. */
export type ExtractionRetryDecision =
  | Readonly<{ kind: 'stop'; outcome: ExtractionOutcome }>
  | Readonly<{ kind: 'retry'; attempts: ExtractionAttempts }>;

/**
 * Pure and total: stop with an outcome, or retry with the attempt counted
 * against its own budget. Every retry raises one counter toward its maximum,
 * so the loop driving this always ends.
 */
export function decideExtractionRetry(
  result: IngestionStepResult,
  before: ExtractionAttempts,
  policy: Pick<SessionIngestionRetryPolicy, 'maxDeferredAttempts' | 'maxFailedAttempts'>,
): ExtractionRetryDecision {
  return match(result)
    .returnType<ExtractionRetryDecision>()
    .with({ kind: 'succeeded' }, (outcome) => ({ kind: 'stop', outcome }))
    .with({ kind: 'failed', retryable: false }, (outcome) => ({ kind: 'stop', outcome }))
    .with({ kind: 'failed', retryable: true }, ({ error }) => {
      const attempts = { ...before, failed: before.failed + 1 };
      return attempts.failed < policy.maxFailedAttempts
        ? { kind: 'retry', attempts }
        : exhausted(`extraction still failing after ${attempts.failed} attempt(s): ${error}`);
    })
    .with({ kind: 'deferred' }, ({ reason }) => {
      const attempts = { ...before, deferred: before.deferred + 1 };
      return attempts.deferred < policy.maxDeferredAttempts
        ? { kind: 'retry', attempts }
        : exhausted(`extraction remained deferred after ${attempts.deferred} attempt(s): ${reason}`);
    })
    .exhaustive();
}

const exhausted = (error: string): ExtractionRetryDecision => ({
  kind: 'stop',
  outcome: { kind: 'failed', retryable: false, error },
});

async function runStep(operation: () => Promise<IngestionStepResult>): Promise<IngestionStepResult> {
  try {
    return await operation();
  } catch (error) {
    return {
      kind: 'failed',
      retryable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function runExtractionWithRetry(
  extract: () => Promise<IngestionStepResult>,
  policy: SessionIngestionRetryPolicy,
): Promise<ExtractionOutcome> {
  let attempts: ExtractionAttempts = { deferred: 0, failed: 0 };
  for (;;) {
    const decision = decideExtractionRetry(await runStep(extract), attempts, policy);
    if (decision.kind === 'stop') return decision.outcome;
    attempts = decision.attempts;
    await policy.sleep(policy.retryDelayMs(attempts.deferred + attempts.failed));
  }
}

/**
 * Run extract → backfill → maintenance in order.
 *
 * Lock-deferred extraction is retried in this detached worker before backfill.
 * Backfill runs whatever the extraction did: it embeds memories that ALREADY
 * exist and recall cannot see (no vector, or a vector from a retired model),
 * which is work this session's transcript has no bearing on. Gating it on
 * extraction's outcome meant one lock-deferred session stalled embedding
 * repair for the whole run, for a reason that had nothing to do with backfill.
 * Maintenance runs last so it sees whatever the two steps above wrote.
 */
export async function runSessionIngestion(
  operations: SessionIngestionOperations,
  retryPolicy: SessionIngestionRetryPolicy = DEFAULT_RETRY_POLICY,
): Promise<SessionIngestionResult> {
  const extraction = await runExtractionWithRetry(operations.extract, retryPolicy);

  const backfillResult = await runStep(operations.backfill);
  const backfill: IngestionStepOutcome = backfillResult.kind === 'deferred'
    ? { kind: 'failed', retryable: false, error: `backfill unexpectedly deferred: ${backfillResult.reason}` }
    : backfillResult;

  const maintenanceResult = await runStep(operations.maintenance);
  const maintenance: IngestionStepOutcome = maintenanceResult.kind === 'deferred'
    ? { kind: 'failed', retryable: false, error: `maintenance unexpectedly deferred: ${maintenanceResult.reason}` }
    : maintenanceResult;

  return { extraction, backfill, maintenance };
}

/** Derive pipeline success from its outcomes so contradictory states cannot be constructed. */
export function isSessionIngestionSuccessful(result: SessionIngestionResult): boolean {
  return [result.extraction, result.backfill, result.maintenance].every(
    (outcome) => outcome.kind === 'succeeded' || outcome.kind === 'skipped',
  );
}

export function formatSessionIngestionResult(result: SessionIngestionResult): string {
  const formatOutcome = (name: string, outcome: IngestionStepOutcome): string => {
    if (outcome.kind === 'skipped') return `${name}: skipped (${outcome.reason})`;
    if (outcome.kind === 'failed') return `${name}: ${outcome.output ?? outcome.error}`;
    return `${name}: ${outcome.output ?? 'complete'}`;
  };

  return [
    formatOutcome('extract', result.extraction),
    formatOutcome('backfill', result.backfill),
    formatOutcome('maintenance', result.maintenance),
  ].join('\n');
}
