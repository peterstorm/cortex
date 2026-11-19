import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { distinctFacts, planRestatements, type Restatement } from './restatement.js';
import { cosineSimilarity } from './similarity.js';
import { createMemory, MEMORY_TYPES, type Memory, type MemoryType } from './types.js';

/** A unit vector at `degrees` in the first plane: cos(a°, b°) = cos(a - b). */
const at = (degrees: number): Float32Array => {
  const r = (degrees * Math.PI) / 180;
  return new Float32Array([Math.cos(r), Math.sin(r), 0, 0]);
};

type Spec = Readonly<{
  id: string;
  vector?: Float32Array | null;
  type?: MemoryType;
  createdAt?: string;
  pinned?: boolean;
}>;

const memory = ({ id, vector = null, type = 'decision', createdAt = '2026-01-01T00:00:00.000Z', pinned = false }: Spec): Memory =>
  createMemory({
    id,
    content: `content of ${id}`,
    summary: `summary of ${id}`,
    memory_type: type,
    scope: 'project',
    confidence: 0.9,
    priority: 5,
    pinned,
    source_type: 'extraction',
    source_session: 's',
    source_context: '{}',
    local_embedding: vector,
    created_at: createdAt,
  });

const day = (n: number): string => new Date(Date.UTC(2026, 0, 1 + n)).toISOString();

describe('distinctFacts', () => {
  const ids = (items: readonly Memory[]) => items.map((m) => m.id);

  it('drops a lower-ranked restatement of a kept hit and keeps rank order', () => {
    const ranked = [
      memory({ id: 'a', vector: at(0) }),
      memory({ id: 'a-copy', vector: at(10) }), // cos 0.985
      memory({ id: 'b', vector: at(60) }), // cos 0.5
    ];
    expect(ids(distinctFacts(ranked, (m) => m, 0.85))).toEqual(['a', 'b']);
  });

  it('never drops across memory types', () => {
    const ranked = [memory({ id: 'a', vector: at(0) }), memory({ id: 'g', vector: at(0), type: 'gotcha' })];
    expect(ids(distinctFacts(ranked, (m) => m, 0.85))).toEqual(['a', 'g']);
  });

  it('always keeps items without a current-model embedding', () => {
    const ranked = [memory({ id: 'a', vector: at(0) }), memory({ id: 'kw', vector: null })];
    expect(ids(distinctFacts(ranked, (m) => m, 0.85))).toEqual(['a', 'kw']);
  });

  it('compares only against kept items: a dropped item drops nothing', () => {
    // b restates a (cos 0.94); c restates b (cos 0.94) but not a (cos 0.77).
    const ranked = [memory({ id: 'a', vector: at(0) }), memory({ id: 'b', vector: at(20) }), memory({ id: 'c', vector: at(40) })];
    expect(ids(distinctFacts(ranked, (m) => m, 0.85))).toEqual(['a', 'c']);
  });

  it('a null threshold (uncalibrated model) keeps everything', () => {
    const ranked = [memory({ id: 'a', vector: at(0) }), memory({ id: 'a2', vector: at(0) })];
    expect(distinctFacts(ranked, (m) => m, null)).toBe(ranked);
  });

  it('works through an accessor on wrapped results', () => {
    const ranked = [{ memory: memory({ id: 'a', vector: at(0) }), score: 0.9 }, { memory: memory({ id: 'a2', vector: at(1) }), score: 0.8 }];
    expect(distinctFacts(ranked, (r) => r.memory, 0.85).map((r) => r.score)).toEqual([0.9]);
  });

  const listArb = fc
    .array(
      fc.record({
        degrees: fc.integer({ min: 0, max: 90 }),
        type: fc.constantFrom<MemoryType>('decision', 'gotcha'),
        embedded: fc.boolean(),
      }),
      { maxLength: 25 }
    )
    .map((specs) => specs.map((s, i) => memory({ id: `m${i}`, vector: s.embedded ? at(s.degrees) : null, type: s.type })));
  const thresholdArb = fc.double({ min: 0.5, max: 1, noNaN: true });

  it('property: the output is an order-preserving subsequence that keeps every unembedded item', () => {
    fc.assert(
      fc.property(listArb, thresholdArb, (ranked, threshold) => {
        const kept = distinctFacts(ranked, (m) => m, threshold);
        const positions = kept.map((m) => ranked.indexOf(m));
        expect(positions).toEqual([...positions].sort((a, b) => a - b));
        for (const m of ranked) if (m.local_embedding === null) expect(kept).toContain(m);
      })
    );
  });

  it('property: no two kept items of one type restate each other, and it is idempotent', () => {
    fc.assert(
      fc.property(listArb, thresholdArb, (ranked, threshold) => {
        const kept = distinctFacts(ranked, (m) => m, threshold);
        kept.forEach((a, i) =>
          kept.slice(i + 1).forEach((b) => {
            if (a.memory_type !== b.memory_type || !a.local_embedding || !b.local_embedding) return;
            expect(cosineSimilarity(a.local_embedding, b.local_embedding)).toBeLessThan(threshold);
          })
        );
        expect(distinctFacts(kept, (m) => m, threshold)).toEqual(kept);
      })
    );
  });
});

describe('planRestatements', () => {
  const plan = (memories: readonly Memory[], threshold = 0.9) => planRestatements(memories, threshold);

  it('supersedes the older copy by the newer one', () => {
    const memories = [
      memory({ id: 'old', vector: at(0), createdAt: day(0) }),
      memory({ id: 'new', vector: at(5), createdAt: day(1) }),
    ];
    const [only, ...rest] = plan(memories);
    expect(rest).toEqual([]);
    expect(only).toMatchObject({ kept: 'new', superseded: 'old' });
    expect(only.similarity).toBeCloseTo(Math.cos((5 * Math.PI) / 180), 5);
  });

  it('never chains: an old memory close only to a superseded one stays', () => {
    // newest n (0°) absorbs m (20°, cos 0.94); o (40°) is 0.94 from m but 0.77 from n.
    const memories = [
      memory({ id: 'o', vector: at(40), createdAt: day(0) }),
      memory({ id: 'm', vector: at(20), createdAt: day(1) }),
      memory({ id: 'n', vector: at(0), createdAt: day(2) }),
    ];
    expect(plan(memories).map((r) => [r.kept, r.superseded])).toEqual([['n', 'm']]);
  });

  it('a restatement goes to its most similar newer leader', () => {
    const memories = [
      memory({ id: 'old', vector: at(10), createdAt: day(0) }),
      memory({ id: 'lead-far', vector: at(0), createdAt: day(1) }), // cos(10°) 0.985
      memory({ id: 'lead-near', vector: at(31), createdAt: day(2) }), // 31° from lead-far: both leaders
    ];
    // old is 10° from lead-far and 21° from lead-near: lead-far wins.
    expect(plan(memories)).toEqual([expect.objectContaining({ kept: 'lead-far', superseded: 'old' })]);
  });

  it('never supersedes a pinned memory, but a pinned memory may supersede an older copy', () => {
    const memories = [
      memory({ id: 'oldest', vector: at(0), createdAt: day(0) }),
      memory({ id: 'pinned', vector: at(1), createdAt: day(1), pinned: true }),
      memory({ id: 'newest', vector: at(2), createdAt: day(2) }),
    ];
    // pinned is not superseded by newest; oldest goes to the most similar
    // leader — pinned (1°) beats newest (2°).
    expect(plan(memories).map((r) => [r.kept, r.superseded])).toEqual([['pinned', 'oldest']]);
  });

  it('ignores code memories, other types and memories without a current-model vector', () => {
    const memories = [
      memory({ id: 'code-old', vector: at(0), type: 'code', createdAt: day(0) }),
      memory({ id: 'code-new', vector: at(0), type: 'code', createdAt: day(1) }),
      memory({ id: 'gotcha', vector: at(0), type: 'gotcha', createdAt: day(0) }),
      memory({ id: 'decision', vector: at(0), createdAt: day(1) }),
      memory({ id: 'unembedded', vector: null, createdAt: day(0) }),
    ];
    expect(plan(memories)).toEqual([]);
  });

  it('breaks equal timestamps by id, whatever the input order', () => {
    const a = memory({ id: 'a', vector: at(0) });
    const b = memory({ id: 'b', vector: at(0) });
    expect(plan([a, b])).toEqual(plan([b, a]));
    expect(plan([a, b])).toEqual([expect.objectContaining({ kept: 'a', superseded: 'b' })]);
  });

  const corpusArb = fc
    .array(
      fc.record({
        degrees: fc.integer({ min: 0, max: 60 }),
        day: fc.integer({ min: 0, max: 5 }),
        type: fc.constantFrom<MemoryType>(...MEMORY_TYPES),
        pinned: fc.boolean(),
        embedded: fc.boolean(),
      }),
      { maxLength: 30 }
    )
    .map((specs) =>
      specs.map((s, i) =>
        memory({ id: `m${String(i).padStart(2, '0')}`, vector: s.embedded ? at(s.degrees) : null, type: s.type, createdAt: day(s.day), pinned: s.pinned })
      )
    );
  const thresholdArb = fc.double({ min: 0.8, max: 0.99, noNaN: true });

  const apply = (memories: readonly Memory[], restatements: readonly Restatement[]) => {
    const gone = new Set(restatements.map((r) => r.superseded));
    return memories.filter((m) => !gone.has(m.id));
  };

  it('property: every pair is same-type, newer-kept, at or above the threshold, and never touches pinned/code', () => {
    fc.assert(
      fc.property(corpusArb, thresholdArb, (memories, threshold) => {
        const byId = new Map(memories.map((m) => [m.id, m]));
        for (const r of planRestatements(memories, threshold)) {
          const kept = byId.get(r.kept);
          const old = byId.get(r.superseded);
          if (!kept || !old) throw new Error('plan names an unknown memory');
          expect(kept.memory_type).toBe(old.memory_type);
          expect(old.memory_type).not.toBe('code');
          expect(old.pinned).toBe(false);
          expect(old.created_at <= kept.created_at).toBe(true);
          expect(r.similarity).toBeGreaterThanOrEqual(threshold);
        }
      })
    );
  });

  it('property: no chaining (a kept memory is never superseded) and each memory is superseded at most once', () => {
    fc.assert(
      fc.property(corpusArb, thresholdArb, (memories, threshold) => {
        const restatements = planRestatements(memories, threshold);
        const superseded = restatements.map((r) => r.superseded);
        expect(new Set(superseded).size).toBe(superseded.length);
        for (const r of restatements) expect(superseded).not.toContain(r.kept);
      })
    );
  });

  it('property: idempotent — planning again over the survivors finds nothing', () => {
    fc.assert(
      fc.property(corpusArb, thresholdArb, (memories, threshold) => {
        const survivors = apply(memories, planRestatements(memories, threshold));
        expect(planRestatements(survivors, threshold)).toEqual([]);
      })
    );
  });

  it('property: the plan does not depend on input order', () => {
    fc.assert(
      fc.property(corpusArb, thresholdArb, (memories, threshold) => {
        expect(planRestatements([...memories].reverse(), threshold)).toEqual(planRestatements(memories, threshold));
      })
    );
  });
});
