import { describe, expect, it } from 'vitest';
import {
  formatSessionIngestionResult,
  runSessionIngestion,
  type IngestionStepResult,
} from './ingest-session.js';

const succeeded = (output: string): IngestionStepResult => ({ success: true, output });
const failed = (error: string): IngestionStepResult => ({ success: false, error });

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
      maintenance: { kind: 'completed', result: { success: true } },
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
      backfill: {
        kind: 'completed',
        result: { success: false, error: 'embedding crashed' },
      },
      maintenance: { kind: 'completed', result: { success: true } },
    });
  });
});
