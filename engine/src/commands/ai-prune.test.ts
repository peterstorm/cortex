import { describe, expect, it } from 'vitest';
import { shouldRunAiPrune } from './ai-prune.js';

describe('shouldRunAiPrune', () => {
  it('runs at the configured session cadence', () => {
    expect(shouldRunAiPrune(5, 10, 5, 50, 10)).toBe(true);
  });

  it('runs when a store first crosses the memory threshold', () => {
    expect(shouldRunAiPrune(1, 50, 5, 50, 0)).toBe(true);
  });

  it('does not rerun every session merely because the store remains large', () => {
    expect(shouldRunAiPrune(1, 276, 5, 50, 276)).toBe(false);
  });

  it('runs after the store grows at least 25 percent since the last prune', () => {
    expect(shouldRunAiPrune(1, 125, 5, 50, 100)).toBe(true);
    expect(shouldRunAiPrune(1, 124, 5, 50, 100)).toBe(false);
  });
});
