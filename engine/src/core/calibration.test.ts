import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  compareForDedup,
  dedupVerdict,
  duplicateFloor,
  type DedupPolicy,
  type DuplicateBands,
} from './calibration.js';
import { tokenize } from './similarity.js';
import { JACCARD_DEDUP, cosineCalibrationFor, dedupPolicyFor } from '../config.js';

const SKIP_ONLY: DuplicateBands = { kind: 'skip-only', skipFrom: 0.92 };
const MERGE_THEN_SKIP: DuplicateBands = { kind: 'merge-then-skip', mergeFrom: 0.75, skipFrom: 0.85 };

/** Valid bands: a skip-only floor, or a merge floor strictly below the skip floor. */
const bandsArb: fc.Arbitrary<DuplicateBands> = fc.oneof(
  fc.double({ min: 0.01, max: 1, noNaN: true }).map((skipFrom): DuplicateBands => ({ kind: 'skip-only', skipFrom })),
  fc
    .tuple(fc.double({ min: 0.01, max: 1, noNaN: true }), fc.double({ min: 0.01, max: 1, noNaN: true }))
    .filter(([a, b]) => a !== b)
    .map(([a, b]): DuplicateBands => ({
      kind: 'merge-then-skip',
      mergeFrom: Math.min(a, b),
      skipFrom: Math.max(a, b),
    }))
);
const scoreArb = fc.double({ min: -1, max: 1, noNaN: true });

describe('dedupVerdict', () => {
  it('skip-only bands never merge', () => {
    expect(dedupVerdict(0.5, SKIP_ONLY)).toBe('keep');
    expect(dedupVerdict(0.91, SKIP_ONLY)).toBe('keep');
    expect(dedupVerdict(0.92, SKIP_ONLY)).toBe('skip');
  });

  it('merge-then-skip bands: keep below the merge floor, merge up to the skip floor, skip from it', () => {
    expect(dedupVerdict(0.74, MERGE_THEN_SKIP)).toBe('keep');
    expect(dedupVerdict(0.75, MERGE_THEN_SKIP)).toBe('merge');
    expect(dedupVerdict(0.849, MERGE_THEN_SKIP)).toBe('merge');
    expect(dedupVerdict(0.85, MERGE_THEN_SKIP)).toBe('skip');
  });

  it('property: a skip-only space never yields merge', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.01, max: 1, noNaN: true }), scoreArb, (skipFrom, score) => {
        expect(dedupVerdict(score, { kind: 'skip-only', skipFrom })).not.toBe('merge');
      })
    );
  });

  it('property: the verdict is monotone in the score (keep < merge < skip)', () => {
    const rank = { keep: 0, merge: 1, skip: 2 } as const;
    fc.assert(
      fc.property(bandsArb, scoreArb, scoreArb, (bands, a, b) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        expect(rank[dedupVerdict(low, bands)]).toBeLessThanOrEqual(rank[dedupVerdict(high, bands)]);
      })
    );
  });

  it('property: a score is kept exactly when it is below the duplicate floor', () => {
    fc.assert(
      fc.property(bandsArb, scoreArb, (bands, score) => {
        expect(dedupVerdict(score, bands) === 'keep').toBe(score < duplicateFloor(bands));
      })
    );
  });
});

describe('compareForDedup', () => {
  const tokensA = tokenize('alpha bravo charlie');
  const tokensB = tokenize('delta echo foxtrot');
  const same = new Float32Array([1, 0, 0]);
  const potion = dedupPolicyFor(cosineCalibrationFor('minishlab/potion-retrieval-32M'));

  it('scores cosine against the cosine thresholds when calibrated and both sides carry a vector', () => {
    const { score, thresholds } = compareForDedup(tokensA, tokensB, same, same, potion);
    expect(score).toBeCloseTo(1, 10);
    expect(thresholds).toBe(potion.cosine);
  });

  it('falls back to Jaccard and its thresholds when a side has no vector', () => {
    const { score, thresholds } = compareForDedup(tokensA, tokensB, same, null, potion);
    expect(score).toBe(0);
    expect(thresholds).toBe(JACCARD_DEDUP);
  });

  it('falls back to Jaccard on a width mismatch', () => {
    const wider = new Float32Array([1, 0, 0, 0]);
    const { thresholds } = compareForDedup(tokensA, tokensA, same, wider, potion);
    expect(thresholds).toBe(JACCARD_DEDUP);
  });

  it('property: an uncalibrated policy never reads the vectors', () => {
    const uncalibrated: DedupPolicy = dedupPolicyFor(null);
    const vec = fc.array(fc.float({ min: -1, max: 1, noNaN: true }), { minLength: 3, maxLength: 3 })
      .map((xs) => new Float32Array(xs));
    fc.assert(
      fc.property(vec, vec, (a, b) => {
        const withVectors = compareForDedup(tokensA, tokensB, a, b, uncalibrated);
        const without = compareForDedup(tokensA, tokensB, null, null, uncalibrated);
        expect(withVectors).toEqual(without);
        expect(withVectors.thresholds).toBe(JACCARD_DEDUP);
      })
    );
  });
});
