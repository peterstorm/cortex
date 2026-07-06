import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  cosineSimilarity,
  tokenize,
  jaccardSimilarity,
  classifySimilarity,
  jaccardPreFilter,
  batchCosineSimilarity,
  hybridSimilarity,
  hybridSimilarityScored,
  rankBySimilarity,
  rankByFusedSimilarity,
  queryCoverage,
  type JaccardPreFilter,
} from './similarity';
import { createMemory } from './types';
import type { Memory, SimilarityAction } from './types';

describe('cosineSimilarity', () => {
  describe('example-based tests', () => {
    it('returns 1.0 for identical vectors', () => {
      const v = new Float64Array([1, 2, 3]);
      expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 10);
    });

    it('returns 0.0 for orthogonal vectors', () => {
      const a = new Float64Array([1, 0, 0]);
      const b = new Float64Array([0, 1, 0]);
      expect(cosineSimilarity(a, b)).toBeCloseTo(0.0, 10);
    });

    it('returns -1.0 for opposite vectors', () => {
      const a = new Float64Array([1, 2, 3]);
      const b = new Float64Array([-1, -2, -3]);
      expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0, 10);
    });

    it('computes correct similarity for angled vectors', () => {
      const a = new Float64Array([1, 0]);
      const b = new Float64Array([1, 1]);
      // cos(45°) ≈ 0.707
      expect(cosineSimilarity(a, b)).toBeCloseTo(0.707, 3);
    });

    it('handles zero vectors', () => {
      const zero = new Float64Array([0, 0, 0]);
      const nonzero = new Float64Array([1, 2, 3]);
      expect(cosineSimilarity(zero, nonzero)).toBe(0);
    });

    it('accepts Float32Array inputs', () => {
      const a = new Float32Array([1, 0, 0]);
      const b = new Float32Array([1, 0, 0]);
      expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 6);
    });

    it('accepts mixed Float32Array and Float64Array', () => {
      const a = new Float32Array([1, 2, 3]);
      const b = new Float64Array([1, 2, 3]);
      expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 6);
    });

    it('throws on dimension mismatch', () => {
      const a = new Float64Array([1, 2]);
      const b = new Float64Array([1, 2, 3]);
      expect(() => cosineSimilarity(a, b)).toThrow(/dimension mismatch/i);
    });

    it('throws on empty vectors', () => {
      const a = new Float64Array([]);
      const b = new Float64Array([]);
      expect(() => cosineSimilarity(a, b)).toThrow(/empty vectors/i);
    });
  });

  describe('property-based tests', () => {
    it('is symmetric: sim(a,b) = sim(b,a)', () => {
      fc.assert(
        fc.property(
          fc.array(fc.float({ min: -10, max: 10, noNaN: true }), { minLength: 1, maxLength: 100 }),
          fc.array(fc.float({ min: -10, max: 10, noNaN: true }), { minLength: 1, maxLength: 100 }),
          (arrA, arrB) => {
            // Ensure same length
            const len = Math.min(arrA.length, arrB.length);
            const a = new Float64Array(arrA.slice(0, len));
            const b = new Float64Array(arrB.slice(0, len));

            const simAB = cosineSimilarity(a, b);
            const simBA = cosineSimilarity(b, a);

            expect(simAB).toBeCloseTo(simBA, 10);
          }
        )
      );
    });

    it('is bounded in [-1, 1]', () => {
      fc.assert(
        fc.property(
          fc.array(fc.float({ min: -10, max: 10, noNaN: true }), { minLength: 1, maxLength: 100 }),
          fc.array(fc.float({ min: -10, max: 10, noNaN: true }), { minLength: 1, maxLength: 100 }),
          (arrA, arrB) => {
            const len = Math.min(arrA.length, arrB.length);
            const a = new Float64Array(arrA.slice(0, len));
            const b = new Float64Array(arrB.slice(0, len));

            const sim = cosineSimilarity(a, b);
            expect(sim).toBeGreaterThanOrEqual(-1.0);
            expect(sim).toBeLessThanOrEqual(1.0);
          }
        )
      );
    });

    it('returns 1.0 for identical vectors (identity property)', () => {
      fc.assert(
        fc.property(
          fc.array(fc.float({ min: -10, max: 10, noNaN: true }), { minLength: 1, maxLength: 100 }),
          (arr) => {
            const v = new Float64Array(arr);
            // Skip all-zero vectors
            if (arr.every(x => x === 0)) return;

            const sim = cosineSimilarity(v, v);
            expect(sim).toBeCloseTo(1.0, 10);
          }
        )
      );
    });
  });
});

describe('tokenize', () => {
  it('lowercases text', () => {
    expect(tokenize('Hello World')).toEqual(new Set(['hello', 'world']));
  });

  it('removes punctuation', () => {
    expect(tokenize("don't, can't! test?")).toEqual(new Set(['don', 't', 'can', 'test']));
  });

  it('collapses whitespace', () => {
    expect(tokenize('hello    world')).toEqual(new Set(['hello', 'world']));
  });

  it('handles empty string', () => {
    expect(tokenize('')).toEqual(new Set());
  });

  it('handles whitespace-only string', () => {
    expect(tokenize('   ')).toEqual(new Set());
  });

  it('trims leading/trailing whitespace', () => {
    expect(tokenize('  hello world  ')).toEqual(new Set(['hello', 'world']));
  });

  it('deduplicates repeated words', () => {
    expect(tokenize('hello hello world')).toEqual(new Set(['hello', 'world']));
  });

  it('keeps unicode letters as whole words (Danish)', () => {
    // Regression: the old [^a-z0-9_\s] regex split non-ASCII letters into
    // fragments ("håndterer" -> "h", "ndterer"), destroying keyword overlap.
    const tokens = tokenize('hvordan håndterer vi løsningen på café-problemet');

    expect(tokens.has('håndterer')).toBe(true);
    expect(tokens.has('løsningen')).toBe(true);
    expect(tokens.has('på')).toBe(true);
    // Hyphen is punctuation here — split into whole unicode words
    expect(tokens.has('café')).toBe(true);
    expect(tokens.has('problemet')).toBe(true);

    // No ASCII-mangled fragments
    expect(tokens.has('h')).toBe(false);
    expect(tokens.has('ndterer')).toBe(false);
    expect(tokens.has('caf')).toBe(false);
    expect(tokens.has('l')).toBe(false);
  });

  it('unicode-aware regex leaves ASCII behavior unchanged', () => {
    expect(tokenize("Don't panic, it's fine_here 123!")).toEqual(
      new Set(['don', 't', 'panic', 'it', 's', 'fine_here', '123'])
    );
  });
});

describe('jaccardSimilarity', () => {
  describe('example-based tests', () => {
    it('returns 1.0 for identical sets', () => {
      const a = new Set(['hello', 'world']);
      const b = new Set(['hello', 'world']);
      expect(jaccardSimilarity(a, b)).toBe(1.0);
    });

    it('returns 0.0 for disjoint sets', () => {
      const a = new Set(['hello']);
      const b = new Set(['world']);
      expect(jaccardSimilarity(a, b)).toBe(0.0);
    });

    it('computes partial overlap correctly', () => {
      const a = new Set(['a', 'b', 'c']);
      const b = new Set(['b', 'c', 'd']);
      // intersection = {b, c} = 2
      // union = {a, b, c, d} = 4
      expect(jaccardSimilarity(a, b)).toBe(0.5);
    });

    it('handles one empty set', () => {
      const a = new Set(['hello']);
      const b = new Set<string>();
      expect(jaccardSimilarity(a, b)).toBe(0.0);
    });

    it('handles both empty sets', () => {
      const a = new Set<string>();
      const b = new Set<string>();
      expect(jaccardSimilarity(a, b)).toBe(1.0);
    });

    it('handles subset relationship', () => {
      const a = new Set(['a', 'b']);
      const b = new Set(['a', 'b', 'c', 'd']);
      // intersection = {a, b} = 2
      // union = {a, b, c, d} = 4
      expect(jaccardSimilarity(a, b)).toBe(0.5);
    });
  });

  describe('property-based tests', () => {
    it('is symmetric: J(a,b) = J(b,a)', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string(), { maxLength: 20 }),
          fc.array(fc.string(), { maxLength: 20 }),
          (arrA, arrB) => {
            const a = new Set(arrA);
            const b = new Set(arrB);

            expect(jaccardSimilarity(a, b)).toBe(jaccardSimilarity(b, a));
          }
        )
      );
    });

    it('is bounded in [0, 1]', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string(), { maxLength: 20 }),
          fc.array(fc.string(), { maxLength: 20 }),
          (arrA, arrB) => {
            const a = new Set(arrA);
            const b = new Set(arrB);

            const sim = jaccardSimilarity(a, b);
            expect(sim).toBeGreaterThanOrEqual(0.0);
            expect(sim).toBeLessThanOrEqual(1.0);
          }
        )
      );
    });

    it('returns 1.0 for identical sets (identity property)', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string(), { minLength: 1, maxLength: 20 }),
          (arr) => {
            const a = new Set(arr);
            expect(jaccardSimilarity(a, a)).toBe(1.0);
          }
        )
      );
    });
  });
});

describe('classifySimilarity', () => {
  it('classifies score < 0.1 as ignore', () => {
    const result = classifySimilarity(0.05);
    expect(result.action).toBe('ignore');
    expect('strength' in result).toBe(false);
  });

  it('classifies score 0.1-0.4 as relate', () => {
    const r1 = classifySimilarity(0.1);
    expect(r1.action).toBe('relate');
    if (r1.action === 'relate') expect(r1.strength).toBe(0.1);

    const r2 = classifySimilarity(0.25);
    expect(r2.action).toBe('relate');
    if (r2.action === 'relate') expect(r2.strength).toBe(0.25);

    const r3 = classifySimilarity(0.39);
    expect(r3.action).toBe('relate');
    if (r3.action === 'relate') expect(r3.strength).toBe(0.39);
  });

  it('classifies score 0.4-0.5 as suggest', () => {
    const r1 = classifySimilarity(0.4);
    expect(r1.action).toBe('suggest');
    if (r1.action === 'suggest') expect(r1.strength).toBe(0.4);

    const r2 = classifySimilarity(0.45);
    expect(r2.action).toBe('suggest');
    if (r2.action === 'suggest') expect(r2.strength).toBe(0.45);

    const r3 = classifySimilarity(0.5);
    expect(r3.action).toBe('suggest');
    if (r3.action === 'suggest') expect(r3.strength).toBe(0.5);
  });

  it('classifies score > 0.5 as consolidate', () => {
    expect(classifySimilarity(0.51).action).toBe('consolidate');
    expect(classifySimilarity(0.75).action).toBe('consolidate');
    expect(classifySimilarity(1.0).action).toBe('consolidate');
  });

  it('preserves strength in relate and suggest actions', () => {
    const r1 = classifySimilarity(0.25);
    if (r1.action === 'relate') expect(r1.strength).toBe(0.25);

    const r2 = classifySimilarity(0.42);
    if (r2.action === 'suggest') expect(r2.strength).toBe(0.42);
  });

  it('omits strength for ignore and consolidate actions', () => {
    const r1 = classifySimilarity(0.05);
    expect('strength' in r1).toBe(false);

    const r2 = classifySimilarity(0.75);
    expect('strength' in r2).toBe(false);
  });

  describe('boundary tests', () => {
    it('handles boundary 0.1', () => {
      expect(classifySimilarity(0.1).action).toBe('relate');
      expect(classifySimilarity(0.09999).action).toBe('ignore');
    });

    it('handles boundary 0.4', () => {
      expect(classifySimilarity(0.4).action).toBe('suggest');
      expect(classifySimilarity(0.39999).action).toBe('relate');
    });

    it('handles boundary 0.5', () => {
      expect(classifySimilarity(0.5).action).toBe('suggest');
      expect(classifySimilarity(0.50001).action).toBe('consolidate');
    });
  });

  describe('space-aware bands (local-cosine calibration)', () => {
    it('gemini-cosine uses the same bands as jaccard', () => {
      expect(classifySimilarity(0.05, 'gemini-cosine').action).toBe('ignore');
      expect(classifySimilarity(0.25, 'gemini-cosine').action).toBe('relate');
      expect(classifySimilarity(0.45, 'gemini-cosine').action).toBe('suggest');
      expect(classifySimilarity(0.55, 'gemini-cosine').action).toBe('consolidate');
    });

    it('local-cosine ignores same-domain background similarity (< 0.6)', () => {
      // 0.6-0.75 is the routine same-domain-different-aspect band for raw
      // 384-dim BGE cosine — under jaccard bands these were all consolidate
      expect(classifySimilarity(0.45, 'local-cosine').action).toBe('ignore');
      expect(classifySimilarity(0.55, 'local-cosine').action).toBe('ignore');
      expect(classifySimilarity(0.59999, 'local-cosine').action).toBe('ignore');
    });

    it('local-cosine relates in [0.6, 0.75)', () => {
      const r = classifySimilarity(0.65, 'local-cosine');
      expect(r.action).toBe('relate');
      if (r.action === 'relate') expect(r.strength).toBe(0.65);
      expect(classifySimilarity(0.6, 'local-cosine').action).toBe('relate');
      expect(classifySimilarity(0.74999, 'local-cosine').action).toBe('relate');
    });

    it('local-cosine suggests in [0.75, 0.82)', () => {
      const r = classifySimilarity(0.78, 'local-cosine');
      expect(r.action).toBe('suggest');
      if (r.action === 'suggest') expect(r.strength).toBe(0.78);
      expect(classifySimilarity(0.75, 'local-cosine').action).toBe('suggest');
      expect(classifySimilarity(0.81999, 'local-cosine').action).toBe('suggest');
    });

    it('local-cosine consolidates at >= 0.82', () => {
      expect(classifySimilarity(0.82, 'local-cosine').action).toBe('consolidate');
      expect(classifySimilarity(0.9, 'local-cosine').action).toBe('consolidate');
      expect(classifySimilarity(1.0, 'local-cosine').action).toBe('consolidate');
    });

    it('defaults to jaccard bands when space is omitted (backwards compat)', () => {
      expect(classifySimilarity(0.65).action).toBe('consolidate');
      expect(classifySimilarity(0.65, 'jaccard').action).toBe('consolidate');
    });
  });
});

describe('hybridSimilarityScored', () => {
  it('reports method=cosine when both embeddings match dimensions', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0.6, 0.8]);
    const result = hybridSimilarityScored(new Set(['x']), new Set(['y']), a, b);
    expect(result.method).toBe('cosine');
    expect(result.score).toBeCloseTo(0.6, 5); // Float32 precision
  });

  it('reports method=jaccard when embeddings are missing', () => {
    const tokens = tokenize('redis cache layer');
    const result = hybridSimilarityScored(tokens, tokens, null, null);
    expect(result.method).toBe('jaccard');
    expect(result.score).toBe(1.0);
  });

  it('reports method=jaccard on dimension mismatch fallback', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([1, 0, 0]);
    const tokens = tokenize('redis cache layer');
    const result = hybridSimilarityScored(tokens, tokens, a, b);
    expect(result.method).toBe('jaccard');
  });

  it('hybridSimilarity wrapper returns the same score', () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0.6, 0.8]);
    const tokensA = tokenize('alpha beta');
    const tokensB = tokenize('gamma delta');
    expect(hybridSimilarity(tokensA, tokensB, a, b)).toBe(
      hybridSimilarityScored(tokensA, tokensB, a, b).score
    );
    expect(hybridSimilarity(tokensA, tokensB, null, null)).toBe(
      hybridSimilarityScored(tokensA, tokensB, null, null).score
    );
  });
});

describe('queryCoverage', () => {
  it('is 1.0 when every query token appears in the memory', () => {
    expect(queryCoverage(tokenize('nixos'), tokenize('configured the nixos flake'))).toBe(1);
    expect(queryCoverage(tokenize('nixos flake'), tokenize('configured the nixos flake today'))).toBe(1);
  });

  it('is 0 when no query token appears', () => {
    expect(queryCoverage(tokenize('redis'), tokenize('postgres connection pooling'))).toBe(0);
  });

  it('is 0 for an empty query', () => {
    expect(queryCoverage(new Set(), tokenize('anything at all'))).toBe(0);
  });

  it('is fractional for partial coverage, normalized by QUERY size only', () => {
    // 1 of 2 query tokens covered → 0.5 regardless of memory size
    const memory = tokenize(
      'a very long memory summary with many many tokens that would dilute jaccard to nothing nixos'
    );
    expect(queryCoverage(tokenize('nixos kubernetes'), memory)).toBe(0.5);
  });
});

describe('jaccardPreFilter', () => {
  it('returns definitely_similar for score > 0.6', () => {
    const result = jaccardPreFilter(0.75);
    expect(result.result).toBe('definitely_similar');
    expect(result.score).toBe(0.75);
  });

  it('returns definitely_different for score < 0.1', () => {
    const result = jaccardPreFilter(0.05);
    expect(result.result).toBe('definitely_different');
    expect(result.score).toBe(0.05);
  });

  it('returns maybe for score 0.1-0.6', () => {
    const result = jaccardPreFilter(0.25);
    expect(result.result).toBe('maybe');
    expect(result.score).toBe(0.25);
  });

  describe('boundary tests', () => {
    it('handles boundary 0.6', () => {
      const result1 = jaccardPreFilter(0.6);
      expect(result1.result).toBe('maybe');
      expect(result1.score).toBe(0.6);

      const result2 = jaccardPreFilter(0.60001);
      expect(result2.result).toBe('definitely_similar');
      expect(result2.score).toBe(0.60001);
    });

    it('handles boundary 0.1', () => {
      const result1 = jaccardPreFilter(0.1);
      expect(result1.result).toBe('maybe');
      expect(result1.score).toBe(0.1);

      const result2 = jaccardPreFilter(0.09999);
      expect(result2.result).toBe('definitely_different');
      expect(result2.score).toBe(0.09999);
    });
  });
});

describe('batchCosineSimilarity', () => {
  it('computes similarity for all targets', () => {
    const query = new Float64Array([1, 0, 0]);
    const targets = [
      new Float64Array([1, 0, 0]),    // sim = 1.0
      new Float64Array([0, 1, 0]),    // sim = 0.0
      new Float64Array([-1, 0, 0]),   // sim = -1.0
    ];

    const results = batchCosineSimilarity(query, targets);

    expect(results).toHaveLength(3);
    expect(results[0].score).toBeCloseTo(1.0, 10);
    expect(results[0].targetIndex).toBe(0);
    expect(results[1].score).toBeCloseTo(0.0, 10);
    expect(results[1].targetIndex).toBe(1);
    expect(results[2].score).toBeCloseTo(-1.0, 10);
    expect(results[2].targetIndex).toBe(2);
  });

  it('sorts results by score descending', () => {
    const query = new Float64Array([1, 0]);
    const targets = [
      new Float64Array([0, 1]),       // sim = 0.0
      new Float64Array([1, 1]),       // sim = 0.707
      new Float64Array([1, 0]),       // sim = 1.0
      new Float64Array([-1, 0]),      // sim = -1.0
    ];

    const results = batchCosineSimilarity(query, targets);

    expect(results[0].targetIndex).toBe(2); // highest (1.0)
    expect(results[1].targetIndex).toBe(1); // second (0.707)
    expect(results[2].targetIndex).toBe(0); // third (0.0)
    expect(results[3].targetIndex).toBe(3); // lowest (-1.0)
  });

  it('includes action classification for each result', () => {
    const query = new Float64Array([1, 0]);
    const targets = [
      new Float64Array([1, 0]),       // sim = 1.0 → consolidate
      new Float64Array([1, 1]),       // sim = 0.707 → consolidate
      new Float64Array([0.5, 1]),     // sim ≈ 0.45 → suggest
      new Float64Array([0.2, 1]),     // sim ≈ 0.20 → relate
      new Float64Array([0, 1]),       // sim = 0.0 → ignore
    ];

    const results = batchCosineSimilarity(query, targets);

    expect(results[0].action.action).toBe('consolidate');
    expect(results[1].action.action).toBe('consolidate');
    expect(results[2].action.action).toBe('suggest');
    expect(results[3].action.action).toBe('relate');
    expect(results[4].action.action).toBe('ignore');
  });

  it('handles empty targets array', () => {
    const query = new Float64Array([1, 0]);
    const results = batchCosineSimilarity(query, []);
    expect(results).toHaveLength(0);
  });

  it('preserves target indices after sorting', () => {
    const query = new Float64Array([1, 0]);
    const targets = [
      new Float64Array([0, 1]),       // index 0, sim = 0.0
      new Float64Array([1, 0]),       // index 1, sim = 1.0
    ];

    const results = batchCosineSimilarity(query, targets);

    // After sorting, highest score (index 1) comes first
    expect(results[0].targetIndex).toBe(1);
    expect(results[1].targetIndex).toBe(0);
  });
});

describe('hybridSimilarity', () => {
  it('returns 0 for definitely_different when no embeddings (Jaccard < 0.1)', () => {
    const tokensA = tokenize('python data processing pipeline');
    const tokensB = tokenize('css flexbox layout grid');
    expect(hybridSimilarity(tokensA, tokensB, null, null)).toBe(0);
  });

  it('returns Jaccard score for definitely_similar when no embeddings (Jaccard > 0.6)', () => {
    const text = 'the quick brown fox jumps over the lazy dog';
    const tokensA = tokenize(text);
    const tokensB = tokenize(text);
    const score = hybridSimilarity(tokensA, tokensB, null, null);
    expect(score).toBeCloseTo(1.0);
  });

  it('prefers cosine over Jaccard when embeddings available', () => {
    // Tokens have partial Jaccard overlap
    const tokensA = tokenize('react state management with hooks');
    const tokensB = tokenize('react context state provider pattern');
    // Embeddings are very similar → cosine should be used regardless of Jaccard range
    const embA = new Float32Array([0.8, 0.1, 0.1]);
    const embB = new Float32Array([0.7, 0.2, 0.1]);
    const score = hybridSimilarity(tokensA, tokensB, embA, embB);
    // Should use cosine (~0.98), not Jaccard
    expect(score).toBeGreaterThan(0.9);
  });

  it('uses cosine even when Jaccard would be definitely_different', () => {
    // Completely different vocabulary but semantically similar embeddings
    const tokensA = tokenize('python data processing pipeline');
    const tokensB = tokenize('css flexbox layout grid');
    // Verify Jaccard < 0.1 (would be "definitely_different" without embeddings)
    expect(jaccardSimilarity(tokensA, tokensB)).toBeLessThan(0.1);
    // But embeddings say they're similar
    const embA = new Float32Array([0.9, 0.1, 0.0]);
    const embB = new Float32Array([0.85, 0.15, 0.0]);
    const score = hybridSimilarity(tokensA, tokensB, embA, embB);
    // Should use cosine (~0.99), NOT return 0
    expect(score).toBeGreaterThan(0.9);
  });

  it('falls back to Jaccard when dimensions mismatch', () => {
    const tokensA = tokenize('similar text content here today');
    const tokensB = tokenize('similar text content here also');
    const embA = new Float32Array([0.1, 0.2, 0.3]); // 3-dim
    const embB = new Float64Array([0.1, 0.2, 0.3, 0.4]); // 4-dim
    const score = hybridSimilarity(tokensA, tokensB, embA, embB);
    // Falls back to Jaccard
    expect(score).toBe(jaccardSimilarity(tokensA, tokensB));
  });

  it('falls back to Jaccard when one embedding is null', () => {
    const tokensA = tokenize('test content one two');
    const tokensB = tokenize('test content one three');
    const embA = new Float32Array([0.1, 0.2]);
    const score = hybridSimilarity(tokensA, tokensB, embA, null);
    expect(score).toBe(jaccardSimilarity(tokensA, tokensB));
  });

  it('falls back to Jaccard when both embeddings are null', () => {
    const tokensA = tokenize('partial overlap tokens here');
    const tokensB = tokenize('partial overlap different words');
    const score = hybridSimilarity(tokensA, tokensB, null, null);
    expect(score).toBe(jaccardSimilarity(tokensA, tokensB));
  });

  it('is symmetric', () => {
    const tokensA = tokenize('react hooks state management');
    const tokensB = tokenize('react context state provider');
    const embA = new Float32Array([0.5, 0.3, 0.2]);
    const embB = new Float32Array([0.4, 0.3, 0.3]);
    expect(hybridSimilarity(tokensA, tokensB, embA, embB))
      .toBeCloseTo(hybridSimilarity(tokensB, tokensA, embB, embA));
  });
});

describe('integration: tokenize + jaccard workflow', () => {
  it('computes similarity between text strings', () => {
    const text1 = 'The quick brown fox jumps over the lazy dog';
    const text2 = 'A quick brown dog jumps over the lazy fox';

    const tokens1 = tokenize(text1);
    const tokens2 = tokenize(text2);
    const similarity = jaccardSimilarity(tokens1, tokens2);

    // Common: quick, brown, jumps, over, the, lazy, fox, dog = 8
    // Union: the, quick, brown, fox, jumps, over, lazy, dog, a = 9
    expect(similarity).toBeCloseTo(8 / 9, 5);
  });

  it('handles case and punctuation differences', () => {
    const text1 = 'Hello, World!';
    const text2 = 'hello world';

    const tokens1 = tokenize(text1);
    const tokens2 = tokenize(text2);
    const similarity = jaccardSimilarity(tokens1, tokens2);

    expect(similarity).toBe(1.0); // Identical after normalization
  });
});

// ============================================================================
// rankBySimilarity / rankByFusedSimilarity
// ============================================================================

function makeRankMemory(id: string, summary: string, tags: readonly string[] = []): Memory {
  const now = new Date().toISOString();
  return createMemory({
    id,
    content: summary,
    summary,
    memory_type: 'decision',
    scope: 'project',
    confidence: 0.9,
    priority: 5,
    source_type: 'extraction',
    source_session: 'sess-1',
    source_context: '{}',
    tags,
    last_accessed_at: now,
    created_at: now,
    updated_at: now,
  });
}

/** Build a normalized-ish vector of `dim` dims pointing mostly at `axis`. */
function axisVector(dim: number, axis: number, spread = 0): Float32Array {
  const v = new Float32Array(dim);
  v[axis % dim] = 1;
  if (spread > 0) v[(axis + 1) % dim] = spread;
  return v;
}

describe('rankBySimilarity', () => {
  const query = new Float32Array([1, 0, 0]); // 3-dim

  it('ranks candidates by cosine similarity descending', () => {
    const candidates = [
      { memory: makeRankMemory('far', 'far away'), embedding: new Float32Array([0, 1, 0]) },
      { memory: makeRankMemory('close', 'very close'), embedding: new Float32Array([0.9, 0.1, 0]) },
      { memory: makeRankMemory('mid', 'in between'), embedding: new Float32Array([0.5, 0.5, 0]) },
    ];

    const ranked = rankBySimilarity(candidates, query, 10);

    expect(ranked.map(r => r.memory.id)).toEqual(['close', 'mid', 'far']);
  });

  it('skips mismatched-dimension candidates instead of throwing (regression)', () => {
    // Previously a single 768-dim row among 384-dim rows threw inside
    // cosineSimilarity and killed ALL semantic recall.
    const candidates = [
      { memory: makeRankMemory('match-1', 'matching dims'), embedding: new Float32Array([1, 0, 0]) },
      { memory: makeRankMemory('legacy-768', 'legacy row'), embedding: new Float32Array([1, 0, 0, 0]) }, // wrong dim
      { memory: makeRankMemory('match-2', 'also matching'), embedding: new Float32Array([0.8, 0.2, 0]) },
    ];

    const ranked = rankBySimilarity(candidates, query, 10);

    expect(ranked.map(r => r.memory.id)).toEqual(['match-1', 'match-2']);
    expect(ranked.some(r => r.memory.id === 'legacy-768')).toBe(false);
  });

  it('returns empty when every candidate has mismatched dimensions', () => {
    const candidates = [
      { memory: makeRankMemory('a', 'four dims'), embedding: new Float32Array(4) },
      { memory: makeRankMemory('b', 'five dims'), embedding: new Float32Array(5) },
    ];

    expect(() => rankBySimilarity(candidates, query, 10)).not.toThrow();
    expect(rankBySimilarity(candidates, query, 10)).toEqual([]);
  });

  it('applies minScore and limit', () => {
    const candidates = [
      { memory: makeRankMemory('hi', 'high'), embedding: new Float32Array([1, 0, 0]) },
      { memory: makeRankMemory('lo', 'low'), embedding: new Float32Array([0.1, 0.9, 0]) },
    ];

    const ranked = rankBySimilarity(candidates, query, 10, 0.5);
    expect(ranked.map(r => r.memory.id)).toEqual(['hi']);

    const limited = rankBySimilarity(candidates, query, 1, 0);
    expect(limited.length).toBe(1);
    expect(limited[0].memory.id).toBe('hi');
  });
});

describe('rankByFusedSimilarity', () => {
  const query = new Float32Array([1, 0, 0]); // 3-dim
  const keywordWeight = 0.3;

  it('fused score = cosine boosted by query coverage (clamped to 1)', () => {
    const memory = makeRankMemory('m1', 'redis caching strategy', ['redis']);
    const embedding = new Float32Array([0.7, Math.sqrt(1 - 0.49), 0]); // cosine = 0.7
    const queryTokens = tokenize('redis caching strategy redis'); // fully covered by memory

    const [result] = rankByFusedSimilarity(
      [{ memory, embedding }],
      query,
      queryTokens,
      10,
      0,
      keywordWeight
    );

    const memoryTokens = tokenize(`${memory.summary} ${memory.tags.join(' ')}`);
    const coverage = queryCoverage(queryTokens, memoryTokens);
    const cosine = cosineSimilarity(query, embedding);

    expect(coverage).toBe(1); // every query token appears in the memory
    expect(result.score).toBeCloseTo(Math.min(1, cosine * (1 + keywordWeight * coverage)), 10);
    expect(result.score).toBeGreaterThan(cosine); // boost actually applied
  });

  it('short proper-noun query gets the FULL boost, not a diluted Jaccard boost (regression)', () => {
    // Old formula used Jaccard(query, memory): a fully-matching 1-token
    // "NixOS" query against a long summary had overlap ≈ 1/30 → boost
    // factor ≈ 1.01, a near no-op. Coverage = 1.0 must rerank decisively.
    const longSummary =
      'configured the nixos flake with home manager modules sops secrets ' +
      'overlays and a custom package set for the development shell environment';
    const memory = makeRankMemory('m1', longSummary);
    const embedding = new Float32Array([0.7, Math.sqrt(1 - 0.49), 0]); // cosine = 0.7
    const queryTokens = tokenize('nixos');

    const [result] = rankByFusedSimilarity(
      [{ memory, embedding }],
      query,
      queryTokens,
      10,
      0,
      keywordWeight
    );

    const cosine = cosineSimilarity(query, embedding);
    // Full boost: cosine * (1 + 0.3 * 1.0), NOT cosine * (1 + 0.3 * ~0.05)
    expect(result.score).toBeCloseTo(cosine * (1 + keywordWeight), 10);
  });

  it('"NixOS" query reranks a covering memory above an equal-cosine memory without the term', () => {
    const sharedEmbedding = new Float32Array([0.7, Math.sqrt(1 - 0.49), 0]); // cosine = 0.7
    const candidates = [
      { memory: makeRankMemory('no-overlap', 'unrelated vocabulary entirely'), embedding: sharedEmbedding },
      { memory: makeRankMemory('overlap', 'nixos flake configuration'), embedding: sharedEmbedding },
    ];

    const ranked = rankByFusedSimilarity(
      candidates,
      query,
      tokenize('nixos'),
      10,
      0,
      keywordWeight
    );

    expect(ranked.map(r => r.memory.id)).toEqual(['overlap', 'no-overlap']);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('fused score never exceeds 1.0 (property)', () => {
    const words = ['redis', 'cache', 'nixos', 'flake', 'bun', 'sqlite', 'edge', 'graph'];
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...words), { minLength: 1, maxLength: 5 }),
        fc.array(fc.constantFrom(...words), { minLength: 1, maxLength: 8 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (queryWords, memoryWords, x) => {
          // Embedding at angle acos(x) from the query axis → cosine = x
          const embedding = new Float32Array([x, Math.sqrt(Math.max(0, 1 - x * x)), 0]);
          const memory = makeRankMemory('m', memoryWords.join(' '));
          const ranked = rankByFusedSimilarity(
            [{ memory, embedding }],
            query,
            tokenize(queryWords.join(' ')),
            10,
            0,
            keywordWeight
          );
          for (const r of ranked) {
            expect(r.score).toBeLessThanOrEqual(1.0);
          }
        }
      )
    );
  });

  it('orders by fused score descending', () => {
    const candidates = [
      { memory: makeRankMemory('far', 'nothing shared'), embedding: new Float32Array([0, 1, 0]) },
      { memory: makeRankMemory('close', 'nothing shared'), embedding: new Float32Array([0.9, 0.1, 0]) },
    ];

    const ranked = rankByFusedSimilarity(candidates, query, tokenize('some query'), 10);
    expect(ranked.map(r => r.memory.id)).toEqual(['close', 'far']);
  });

  it('applies minScore to the RAW cosine score before fusion', () => {
    const candidates = [
      { memory: makeRankMemory('below', 'query words match exactly'), embedding: new Float32Array([0.3, 0.95, 0]) },
    ];
    const queryTokens = tokenize('query words match exactly');

    // Raw cosine < 0.5 — keyword boost must NOT rescue it past minScore
    const rawCosine = cosineSimilarity(query, candidates[0].embedding);
    expect(rawCosine).toBeLessThan(0.5);

    const ranked = rankByFusedSimilarity(candidates, query, queryTokens, 10, 0.5, keywordWeight);
    expect(ranked).toEqual([]);
  });

  it('respects limit', () => {
    const candidates = ['a', 'b', 'c'].map((id, i) => ({
      memory: makeRankMemory(id, `memory ${id}`),
      embedding: axisVector(3, 0, i * 0.1),
    }));

    const ranked = rankByFusedSimilarity(candidates, query, tokenize('memory'), 2);
    expect(ranked.length).toBe(2);
  });

  it('skips mismatched-dimension candidates instead of throwing (regression)', () => {
    const candidates = [
      { memory: makeRankMemory('good', 'valid embedding row'), embedding: new Float32Array([1, 0, 0]) },
      { memory: makeRankMemory('bad', 'legacy 768-dim row'), embedding: new Float32Array(768) },
    ];

    const ranked = rankByFusedSimilarity(candidates, query, tokenize('valid embedding'), 10);

    expect(ranked.map(r => r.memory.id)).toEqual(['good']);
  });
});
