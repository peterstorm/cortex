import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { chunk } from './chunk.js';

describe('chunk', () => {
  it('splits into consecutive groups of the given size', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });

  it('returns one group when the size covers the whole array', () => {
    expect(chunk([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });

  it('returns no groups for an empty array', () => {
    expect(chunk([], 3)).toEqual([]);
  });

  it('does not mutate or alias the input array', () => {
    const input = [1, 2, 3, 4];
    const groups = chunk(input, 2);
    (groups[0] as number[])[0] = 99;
    expect(input).toEqual([1, 2, 3, 4]);
  });

  // The guard exists because the loop advances by `size`: without it, a
  // non-positive size never terminates and grows the result until the process
  // is OOM-killed. Throwing turns a silent hang into a named error.
  it.each([0, -1, -10])('rejects non-positive size %i instead of hanging', (size) => {
    expect(() => chunk([1, 2, 3], size)).toThrow(/size must be a positive integer/);
  });

  it.each([1.5, NaN, Infinity])('rejects non-integer size %s', (size) => {
    expect(() => chunk([1, 2, 3], size)).toThrow(/size must be a positive integer/);
  });
});

describe('chunk invariants', () => {
  it('concatenating the groups reproduces the input', () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), fc.integer({ min: 1, max: 20 }), (arr, size) => {
        expect(chunk(arr, size).flat()).toEqual(arr);
      })
    );
  });

  it('every group but the last is exactly `size` long, and none is empty', () => {
    fc.assert(
      fc.property(fc.array(fc.integer()), fc.integer({ min: 1, max: 20 }), (arr, size) => {
        const groups = chunk(arr, size);
        groups.forEach((group, i) => {
          expect(group.length).toBeGreaterThan(0);
          if (i < groups.length - 1) expect(group.length).toBe(size);
          else expect(group.length).toBeLessThanOrEqual(size);
        });
      })
    );
  });
});
