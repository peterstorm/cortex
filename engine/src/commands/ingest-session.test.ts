import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  DEFAULT_RETRY_POLICY,
  decideExtractionRetry,
  formatSessionIngestionResult,
  isSessionIngestionSuccessful,
  runSessionIngestion,
  type IngestionStepResult,
  type SessionIngestionRetryPolicy,
} from './ingest-session.js';

const succeeded = (output: string): IngestionStepResult => ({ kind: 'succeeded', output });
const failed = (error: string, retryable = false): IngestionStepResult => ({
  kind: 'failed',
  retryable,
  error,
});
const deferred = (reason: string): IngestionStepResult => ({ kind: 'deferred', reason });

const immediateRetryPolicy = (
  budgets: Readonly<{ deferred: number; failed: number }>,
  delays: number[] = [],
): SessionIngestionRetryPolicy => ({
  maxDeferredAttempts: budgets.deferred,
  maxFailedAttempts: budgets.failed,
  retryDelayMs: (attempt) => attempt * 10,
  sleep: async (milliseconds) => { delays.push(milliseconds); },
});

/** An extract step that answers from a script, then succeeds once the script runs out. */
const scripted = (script: readonly IngestionStepResult[], calls: string[]) => async (): Promise<IngestionStepResult> => {
  calls.push('extract');
  return script[calls.length - 1] ?? succeeded('caught up');
};

const quietSteps = {
  backfill: async () => succeeded('embedded'),
  maintenance: async () => succeeded('generated'),
};

describe('runSessionIngestion', () => {
  it('runs extraction, backfill, and maintenance sequentially', async () => {
    const calls: string[] = [];
    const result = await runSessionIngestion({
      extract: async () => { calls.push('extract'); return succeeded('1 memory'); },
      backfill: async () => { calls.push('backfill'); return succeeded('embedded'); },
      maintenance: async () => { calls.push('maintenance'); return succeeded('generated'); },
    });

    expect(calls).toEqual(['extract', 'backfill', 'maintenance']);
    expect(isSessionIngestionSuccessful(result)).toBe(true);
    expect(formatSessionIngestionResult(result)).toBe(
      'extract: 1 memory\nbackfill: embedded\nmaintenance: generated',
    );
  });

  it('retries a lock-deferred extraction before running backfill', async () => {
    const calls: string[] = [];
    const delays: number[] = [];
    let attempts = 0;
    const result = await runSessionIngestion({
      extract: async () => {
        calls.push('extract');
        attempts++;
        return attempts < 3 ? deferred('another extraction holds the lock') : succeeded('retried transcript');
      },
      backfill: async () => { calls.push('backfill'); return succeeded('embedded'); },
      maintenance: async () => { calls.push('maintenance'); return succeeded('generated'); },
    }, immediateRetryPolicy({ deferred: 3, failed: 1 }, delays));

    expect(calls).toEqual(['extract', 'extract', 'extract', 'backfill', 'maintenance']);
    expect(delays).toEqual([10, 20]);
    expect(isSessionIngestionSuccessful(result)).toBe(true);
    expect(result).toMatchObject({
      extraction: { kind: 'succeeded', output: 'retried transcript' },
    });
  });

  it('turns exhausted lock deferral into an observable failure', async () => {
    const calls: string[] = [];
    const result = await runSessionIngestion({
      extract: async () => { calls.push('extract'); return deferred('lock held'); },
      backfill: async () => { calls.push('backfill'); return succeeded('embedded'); },
      maintenance: async () => { calls.push('maintenance'); return succeeded('surface refreshed'); },
    }, immediateRetryPolicy({ deferred: 2, failed: 5 }));

    expect(calls).toEqual(['extract', 'extract', 'backfill', 'maintenance']);
    expect(isSessionIngestionSuccessful(result)).toBe(false);
    expect(result).toMatchObject({
      extraction: { kind: 'failed', error: expect.stringContaining('remained deferred after 2 attempt(s): lock held') },
      backfill: { kind: 'succeeded', output: 'embedded' },
    });
  });

  it('retries a transient extraction failure before backfill', async () => {
    const calls: string[] = [];
    const delays: number[] = [];
    let attempts = 0;
    const result = await runSessionIngestion({
      extract: async () => {
        calls.push('extract');
        attempts++;
        return attempts === 1
          ? failed('temporary provider timeout', true)
          : succeeded('recovered transcript');
      },
      backfill: async () => { calls.push('backfill'); return succeeded('embedded'); },
      maintenance: async () => { calls.push('maintenance'); return succeeded('generated'); },
    }, immediateRetryPolicy({ deferred: 1, failed: 2 }, delays));

    expect(calls).toEqual(['extract', 'extract', 'backfill', 'maintenance']);
    expect(delays).toEqual([10]);
    expect(result.extraction).toEqual({ kind: 'succeeded', output: 'recovered transcript' });
    expect(isSessionIngestionSuccessful(result)).toBe(true);
  });

  // The default budget used to be one shared 121 attempts, sized for waiting
  // on a lock: a failing extraction was re-sent to a struggling server for ten
  // minutes. A failure now gets its own small budget, and the chunk cursor
  // carries the work to the next run.
  it('stops a failing extraction after three attempts with the default policy', async () => {
    const calls: string[] = [];
    const delays: number[] = [];
    const result = await runSessionIngestion(
      { extract: scripted(Array(10).fill(failed('LLM API 503', true)), calls), ...quietSteps },
      // The real budgets and backoff; only the waiting is recorded instead of slept.
      { ...DEFAULT_RETRY_POLICY, sleep: async (milliseconds) => { delays.push(milliseconds); } },
    );

    expect(calls).toHaveLength(3);
    expect(delays).toEqual([250, 500]);
    expect(result.extraction).toEqual({
      kind: 'failed',
      retryable: false,
      error: 'extraction still failing after 3 attempt(s): LLM API 503',
    });
  });

  it('keeps the two budgets apart: lock waits do not spend the failure budget', async () => {
    const calls: string[] = [];
    const delays: number[] = [];
    const lock = deferred('lock held');
    const blip = failed('timeout', true);
    const result = await runSessionIngestion(
      { extract: scripted([lock, lock, blip, lock, blip, succeeded('done')], calls), ...quietSteps },
      immediateRetryPolicy({ deferred: 4, failed: 3 }, delays),
    );

    expect(calls).toHaveLength(6);
    expect(delays).toEqual([10, 20, 30, 40, 50]);
    expect(result.extraction).toEqual({ kind: 'succeeded', output: 'done' });
  });

  it('bounds the attempts by the two budgets for any mix of deferrals and failures', async () => {
    const step = fc.oneof(
      fc.constant(deferred('lock held')),
      fc.constant(failed('timeout', true)),
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(step, { maxLength: 40 }),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 8 }),
        async (script, maxDeferred, maxFailed) => {
          const calls: string[] = [];
          const result = await runSessionIngestion(
            { extract: scripted(script, calls), ...quietSteps },
            immediateRetryPolicy({ deferred: maxDeferred, failed: maxFailed }),
          );
          const seen = script.slice(0, calls.length);
          const deferrals = seen.filter((r) => r.kind === 'deferred').length;
          const failures = seen.filter((r) => r.kind === 'failed').length;
          expect(deferrals).toBeLessThanOrEqual(maxDeferred);
          expect(failures).toBeLessThanOrEqual(maxFailed);
          // Either a budget ran out exactly on its last allowed attempt, or the script did.
          const exhausted = result.extraction.kind === 'failed';
          expect(exhausted).toBe(deferrals === maxDeferred || failures === maxFailed);
        },
      ),
    );
  });

  it('decides from the attempts already made, not from the result alone', () => {
    const policy = { maxDeferredAttempts: 3, maxFailedAttempts: 2 };
    expect(decideExtractionRetry(failed('x', true), { deferred: 2, failed: 0 }, policy))
      .toEqual({ kind: 'retry', attempts: { deferred: 2, failed: 1 } });
    expect(decideExtractionRetry(failed('x', true), { deferred: 0, failed: 1 }, policy))
      .toMatchObject({ kind: 'stop', outcome: { kind: 'failed', retryable: false } });
    expect(decideExtractionRetry(deferred('lock'), { deferred: 1, failed: 1 }, policy))
      .toEqual({ kind: 'retry', attempts: { deferred: 2, failed: 1 } });
    expect(decideExtractionRetry(deferred('lock'), { deferred: 2, failed: 0 }, policy))
      .toMatchObject({ kind: 'stop', outcome: { kind: 'failed', error: expect.stringContaining('remained deferred after 3') } });
    expect(decideExtractionRetry(failed('terminal'), { deferred: 0, failed: 0 }, policy))
      .toEqual({ kind: 'stop', outcome: failed('terminal') });
    expect(decideExtractionRetry(succeeded('ok'), { deferred: 9, failed: 9 }, policy))
      .toEqual({ kind: 'stop', outcome: succeeded('ok') });
  });

  it('does not retry a terminal extraction failure', async () => {
    const calls: string[] = [];
    const result = await runSessionIngestion({
      extract: async () => { calls.push('extract'); return failed('invalid transcript path'); },
      backfill: async () => { calls.push('backfill'); return succeeded('embedded'); },
      maintenance: async () => { calls.push('maintenance'); return succeeded('surface refreshed'); },
    }, immediateRetryPolicy({ deferred: 3, failed: 3 }));

    expect(calls).toEqual(['extract', 'backfill', 'maintenance']);
    expect(result.extraction).toMatchObject({ kind: 'failed', retryable: false });
  });

  // Backfill's work is "embed memories that already exist and recall cannot
  // see" — entirely independent of this session's transcript. Gating it on
  // extraction meant a deferred or failed extraction stalled embedding repair
  // for the whole run, which is how a database ends up with hundreds of
  // unembedded rows while every shutdown reports "processed 0 memories".
  it('runs backfill after a failed extraction, then maintenance', async () => {
    const calls: string[] = [];
    const result = await runSessionIngestion({
      extract: async () => { calls.push('extract'); return failed('LLM unavailable'); },
      backfill: async () => { calls.push('backfill'); return succeeded('embedded 12'); },
      maintenance: async () => { calls.push('maintenance'); return succeeded('surface refreshed'); },
    });

    expect(calls).toEqual(['extract', 'backfill', 'maintenance']);
    expect(isSessionIngestionSuccessful(result)).toBe(false);
    expect(result).toMatchObject({
      backfill: { kind: 'succeeded', output: 'embedded 12' },
      maintenance: { kind: 'succeeded' },
    });
  });

  it('turns unexpected step exceptions into failures and continues safely', async () => {
    const result = await runSessionIngestion({
      extract: async () => succeeded('ok'),
      backfill: async () => { throw new Error('embedding crashed'); },
      maintenance: async () => succeeded('surface refreshed'),
    });

    expect(isSessionIngestionSuccessful(result)).toBe(false);
    expect(result).toMatchObject({
      backfill: { kind: 'failed', error: 'embedding crashed' },
      maintenance: { kind: 'succeeded' },
    });
  });
});
