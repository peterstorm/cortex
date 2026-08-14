/**
 * Detached session-ingestion orchestration.
 *
 * The Pi extension starts this pipeline in a background process so session
 * replacement and shutdown never wait for transcript extraction or LLM work.
 */

export type IngestionStepResult = Readonly<{
  success: boolean;
  output?: string;
  error?: string;
}>;

export type IngestionStepOutcome =
  | Readonly<{ kind: 'completed'; result: IngestionStepResult }>
  | Readonly<{ kind: 'skipped'; reason: string }>;

export type SessionIngestionResult = Readonly<{
  success: boolean;
  extraction: IngestionStepOutcome;
  backfill: IngestionStepOutcome;
  maintenance: IngestionStepOutcome;
}>;

export type SessionIngestionOperations = Readonly<{
  extract: () => Promise<IngestionStepResult>;
  backfill: () => Promise<IngestionStepResult>;
  maintenance: () => Promise<IngestionStepResult>;
}>;

async function runStep(operation: () => Promise<IngestionStepResult>): Promise<IngestionStepOutcome> {
  try {
    return { kind: 'completed', result: await operation() };
  } catch (error) {
    return {
      kind: 'completed',
      result: {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/**
 * Run extract → backfill → maintenance in order.
 *
 * Backfill is skipped after a failed extraction. Maintenance still runs so an
 * earlier successful extraction can finish lifecycle work and refresh the
 * surface even when the current transcript cannot be ingested.
 */
export async function runSessionIngestion(
  operations: SessionIngestionOperations,
): Promise<SessionIngestionResult> {
  const extraction = await runStep(operations.extract);
  const extractionSucceeded =
    extraction.kind === 'completed' && extraction.result.success;

  const backfill: IngestionStepOutcome = extractionSucceeded
    ? await runStep(operations.backfill)
    : { kind: 'skipped', reason: 'extraction failed' };

  const maintenance = await runStep(operations.maintenance);
  const outcomes = [extraction, backfill, maintenance];
  const success = outcomes.every(
    (outcome) => outcome.kind === 'skipped' || outcome.result.success,
  );

  return { success, extraction, backfill, maintenance };
}

export function formatSessionIngestionResult(result: SessionIngestionResult): string {
  const formatOutcome = (name: string, outcome: IngestionStepOutcome): string => {
    if (outcome.kind === 'skipped') return `${name}: skipped (${outcome.reason})`;
    const detail = outcome.result.output ?? outcome.result.error ?? (outcome.result.success ? 'complete' : 'failed');
    return `${name}: ${detail}`;
  };

  return [
    formatOutcome('extract', result.extraction),
    formatOutcome('backfill', result.backfill),
    formatOutcome('maintenance', result.maintenance),
  ].join('\n');
}
