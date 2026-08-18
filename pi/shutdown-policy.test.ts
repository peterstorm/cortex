import { describe, expect, it } from 'vitest';
import { isCortexShutdownReason, shouldRunShutdownPipeline } from './shutdown-policy.js';

// The guard sits in front of EVERY reason, not just unknown ones: an inverted
// or narrowed condition here disables the shutdown pipeline for quit/new/
// resume/fork alike, silently ending extraction for every session. Both
// directions are pinned.
describe('isCortexShutdownReason', () => {
  it.each(['quit', 'reload', 'new', 'resume', 'fork'] as const)(
    'accepts the known reason %s',
    (reason) => {
      expect(isCortexShutdownReason(reason)).toBe(true);
    },
  );

  it.each([
    ['a reason a future pi version could add', 'suspend'],
    ['an empty string', ''],
    ['a near-miss with different case', 'Quit'],
    ['a whitespace-padded reason', ' quit '],
  ])('fails closed on %s', (_label, reason) => {
    expect(isCortexShutdownReason(reason)).toBe(false);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a number', 3],
    ['an object', { reason: 'quit' }],
    ['an array', ['quit']],
  ])('fails closed on %s', (_label, reason) => {
    expect(isCortexShutdownReason(reason)).toBe(false);
  });
});

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
