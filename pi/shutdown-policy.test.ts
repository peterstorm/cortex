import { describe, expect, it } from 'vitest';
import { shouldRunShutdownPipeline } from './shutdown-policy.js';

describe('Cortex Pi shutdown policy', () => {
  it.each(['quit', 'new', 'resume', 'fork'] as const)(
    'runs maintenance for a real %s shutdown',
    (reason) => {
      expect(shouldRunShutdownPipeline(reason, undefined)).toBe(true);
    },
  );

  it('does not run maintenance during extension reload', () => {
    expect(shouldRunShutdownPipeline('reload', undefined)).toBe(false);
  });

  it.each(['quit', 'reload', 'new', 'resume', 'fork'] as const)(
    'never recurses from an extraction child shutting down with reason %s',
    (reason) => {
      expect(shouldRunShutdownPipeline(reason, '1')).toBe(false);
    },
  );

  it('does not treat unrelated marker values as extraction children', () => {
    expect(shouldRunShutdownPipeline('quit', '0')).toBe(true);
  });
});
