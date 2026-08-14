import { describe, expect, it } from 'vitest';
import {
  formatSessionIngestionResult,
  runSessionIngestion,
  type IngestionStepResult,
  type SessionIngestionRetryPolicy,
} from './ingest-session.js';

const succeeded = (output: string): IngestionStepResult => ({ kind: 'succeeded', output });
const failed = (error: string): IngestionStepResult => ({ kind: 'failed', error });
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
    expect(result.success).toBe(true);
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
    expect(result).toMatchObject({
      success: true,
      extraction: { kind: 'succeeded', output: 'retried transcript' },
    });
  });

  it('turns exhausted lock deferral into an observable failure', async () => {
    const calls: string[] = [];
    const result = await runSessionIngestion({
      extract: async () => { calls.push('extract'); return deferred('lock held'); },
      backfill: async () => { calls.push('backfill'); return succeeded('unexpected'); },
      maintenance: async () => { calls.push('maintenance'); return succeeded('surface refreshed'); },
    }, immediateRetryPolicy(2));

    expect(calls).toEqual(['extract', 'extract', 'maintenance']);
    expect(result).toMatchObject({
      success: false,
      extraction: { kind: 'failed', error: expect.stringContaining('remained deferred after 2 attempt') },
      backfill: { kind: 'skipped', reason: 'extraction failed' },
    });
  });

  it('skips backfill after extraction failure but still runs maintenance', async () => {
    const calls: string[] = [];
    const result = await runSessionIngestion({
      extract: async () => { calls.push('extract'); return failed('LLM unavailable'); },
      backfill: async () => { calls.push('backfill'); return succeeded('unexpected'); },
      maintenance: async () => { calls.push('maintenance'); return succeeded('surface refreshed'); },
    });

    expect(calls).toEqual(['extract', 'maintenance']);
    expect(result).toMatchObject({
      success: false,
      backfill: { kind: 'skipped', reason: 'extraction failed' },
      maintenance: { kind: 'succeeded' },
    });
  });

  it('turns unexpected step exceptions into failures and continues safely', async () => {
    const result = await runSessionIngestion({
      extract: async () => succeeded('ok'),
      backfill: async () => { throw new Error('embedding crashed'); },
      maintenance: async () => succeeded('surface refreshed'),
    });

    expect(result).toMatchObject({
      success: false,
      backfill: { kind: 'failed', error: 'embedding crashed' },
      maintenance: { kind: 'succeeded' },
    });
  });
});
