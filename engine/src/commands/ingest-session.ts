/**
 * Detached session-ingestion orchestration.
 *
 * The Pi extension starts this pipeline in a background process so session
 * replacement and shutdown never wait for transcript extraction or LLM work.
 */

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

export type SessionIngestionRetryPolicy = Readonly<{
  maxExtractionAttempts: number;
  retryDelayMs: (completedAttempts: number) => number;
  sleep: (milliseconds: number) => Promise<void>;
}>;

const DEFAULT_RETRY_POLICY: SessionIngestionRetryPolicy = {
  // A detached worker may wait up to roughly ten minutes for an extraction
  // already holding the per-project lock. This serializes overlapping session
  // shutdowns without delaying /new or /q in the parent Pi process.
  maxExtractionAttempts: 121,
  retryDelayMs: (completedAttempts) => Math.min(250 * (2 ** Math.min(completedAttempts - 1, 5)), 5_000),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

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
): Promise<Exclude<IngestionStepResult, { kind: 'deferred' }>> {
  for (let attempt = 1; attempt <= policy.maxExtractionAttempts; attempt++) {
    const result = await runStep(extract);
    if (result.kind === 'succeeded' || (result.kind === 'failed' && !result.retryable)) {
      return result;
    }
    const retryReason = result.kind === 'deferred' ? result.reason : result.error;

    if (attempt === policy.maxExtractionAttempts) {
      return {
        kind: 'failed',
        retryable: false,
        error: `extraction remained retryable after ${attempt} attempt(s): ${retryReason}`,
      };
    }

    await policy.sleep(policy.retryDelayMs(attempt));
  }

  return { kind: 'failed', retryable: false, error: 'extraction retry policy had no attempts' };
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
