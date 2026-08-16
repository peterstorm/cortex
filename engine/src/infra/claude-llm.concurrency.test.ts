/**
 * Tests for the process-wide LLM slot pool (CORTEX_LLM_MAX_CONCURRENCY).
 *
 * Background cortex work (extraction, edge classification, AI pruning, and
 * the subprocess fallback) must never occupy more than a bounded share of a
 * model server that live agents already rely on. These tests drive the real
 * runLlmPromptDirect with an in-flight-tracking transport mock and assert the
 * observed concurrency against the configured cap.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  resetConsecutiveDirectFailuresForTests,
  resetLlmConcurrencyForTests,
  runLlmPromptDirect,
} from './claude-llm.js';

const mockResolveOpenAiCompatEndpoint = vi.fn();
const mockChatCompletionText = vi.fn();
vi.mock('./llm-client.js', () => ({
  resolveOpenAiCompatEndpoint: () => mockResolveOpenAiCompatEndpoint(),
  chatCompletionText: (...args: unknown[]) => mockChatCompletionText(...args),
}));

const FAKE_ENDPOINT = { baseUrl: 'http://llm.example/v1', apiKey: 'k', model: 'm' };

/** Transport mock that reports peak in-flight concurrency across calls. */
function trackingTransport(options: {
  readonly delayMs?: number;
  readonly rejectFirst?: number;
}): { maxInFlight: () => number; settled: () => number } {
  let inFlight = 0;
  let peak = 0;
  let settled = 0;
  let calls = 0;
  mockChatCompletionText.mockImplementation(() => {
    calls += 1;
    const shouldFail = calls <= (options.rejectFirst ?? 0);
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    return new Promise<string>((resolve, reject) => {
      setTimeout(() => {
        inFlight -= 1;
        settled += 1;
        if (shouldFail) reject(new Error('LLM API returned empty content'));
        else resolve('{"edges": []}');
      }, options.delayMs ?? 15);
    });
  });
  return { maxInFlight: () => peak, settled: () => settled };
}

describe('process-wide LLM concurrency cap', () => {
  const originalCap = process.env.CORTEX_LLM_MAX_CONCURRENCY;

  beforeEach(() => {
    mockResolveOpenAiCompatEndpoint.mockReset();
    mockChatCompletionText.mockReset();
    resetConsecutiveDirectFailuresForTests();
    resetLlmConcurrencyForTests();
    mockResolveOpenAiCompatEndpoint.mockReturnValue(FAKE_ENDPOINT);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalCap === undefined) delete process.env.CORTEX_LLM_MAX_CONCURRENCY;
    else process.env.CORTEX_LLM_MAX_CONCURRENCY = originalCap;
  });

  it('caps in-flight calls at the default of 2', async () => {
    const tracker = trackingTransport({});
    await Promise.all(Array.from({ length: 4 }, () => runLlmPromptDirect('p', 2_000)));

    expect(tracker.maxInFlight()).toBe(2);
    expect(tracker.settled()).toBe(4);
  });

  it('honors CORTEX_LLM_MAX_CONCURRENCY=1 for the most conservative setting', async () => {
    process.env.CORTEX_LLM_MAX_CONCURRENCY = '1';
    const tracker = trackingTransport({});
    await Promise.all(Array.from({ length: 3 }, () => runLlmPromptDirect('p', 2_000)));

    expect(tracker.maxInFlight()).toBe(1);
    expect(tracker.settled()).toBe(3);
  });

  it('does not serialize below demand when the operator raises the cap', async () => {
    process.env.CORTEX_LLM_MAX_CONCURRENCY = '5';
    const tracker = trackingTransport({});
    await Promise.all(Array.from({ length: 3 }, () => runLlmPromptDirect('p', 2_000)));

    expect(tracker.maxInFlight()).toBe(3);
  });

  it('falls back to the default cap for invalid or sub-1 values', async () => {
    for (const invalid of ['0', '-2', 'abc', '2.5']) {
      process.env.CORTEX_LLM_MAX_CONCURRENCY = invalid;
      resetLlmConcurrencyForTests();
      const tracker = trackingTransport({});
      await Promise.all(Array.from({ length: 4 }, () => runLlmPromptDirect('p', 2_000)));
      expect(tracker.maxInFlight()).toBe(2);
    }
  });

  it('releases the slot when a call fails so later calls are not stranded', async () => {
    process.env.CORTEX_LLM_MAX_CONCURRENCY = '1';
    // The first call fails once, which is below the saturation threshold, so
    // it falls back to the subprocess: stub the CLI lookup so the fallback
    // fails fast instead of spawning a real agent loop.
    const bunGlobal = (globalThis as { Bun?: { which: (bin: string) => string | null } }).Bun;
    const originalWhich = bunGlobal!.which;
    bunGlobal!.which = () => null;
    const tracker = trackingTransport({ rejectFirst: 1 });
    try {
      const calls = Array.from({ length: 3 }, () => runLlmPromptDirect('p', 2_000));
      const results = await Promise.allSettled(calls);

      // First call failed (slot released), the other two completed on it.
      expect(results[0].status).toBe('rejected');
      expect(results[1].status).toBe('fulfilled');
      expect(results[2].status).toBe('fulfilled');
      expect(tracker.maxInFlight()).toBe(1);
      expect(tracker.settled()).toBe(3);
    } finally {
      bunGlobal!.which = originalWhich;
    }
  });

  it('lets queued callers proceed as slots free (no deadlock past the cap)', async () => {
    process.env.CORTEX_LLM_MAX_CONCURRENCY = '1';
    const tracker = trackingTransport({});
    const results = await Promise.all(Array.from({ length: 6 }, () => runLlmPromptDirect('p', 2_000)));

    expect(results).toHaveLength(6);
    expect(tracker.settled()).toBe(6);
    expect(tracker.maxInFlight()).toBe(1);
  });
});
