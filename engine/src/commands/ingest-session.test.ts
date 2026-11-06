import { describe, expect, it } from 'vitest';
import {
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
  maxExtractionAttempts: number,
  delays: number[] = [],
): SessionIngestionRetryPolicy => ({
  maxExtractionAttempts,
  retryDelayMs: (attempt) => attempt * 10,
  sleep: async (milliseconds) => { delays.push(milliseconds); },
});

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
    }, immediateRetryPolicy(3, delays));

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
    }, immediateRetryPolicy(2));

    expect(calls).toEqual(['extract', 'extract', 'backfill', 'maintenance']);
    expect(isSessionIngestionSuccessful(result)).toBe(false);
    expect(result).toMatchObject({
      extraction: { kind: 'failed', error: expect.stringContaining('remained retryable after 2 attempt') },
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
    }, immediateRetryPolicy(2, delays));

    expect(calls).toEqual(['extract', 'extract', 'backfill', 'maintenance']);
    expect(delays).toEqual([10]);
    expect(result.extraction).toEqual({ kind: 'succeeded', output: 'recovered transcript' });
    expect(isSessionIngestionSuccessful(result)).toBe(true);
  });

  it('does not retry a terminal extraction failure', async () => {
    const calls: string[] = [];
    const result = await runSessionIngestion({
      extract: async () => { calls.push('extract'); return failed('invalid transcript path'); },
      backfill: async () => { calls.push('backfill'); return succeeded('embedded'); },
      maintenance: async () => { calls.push('maintenance'); return succeeded('surface refreshed'); },
    }, immediateRetryPolicy(3));

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
