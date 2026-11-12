/**
 * Which entities a surface shows: named things, most recently learned-about
 * first, never file paths.
 */

import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { isPathLikeEntityName, renderEntitySection, selectSurfaceEntities } from './surface.js';
import type { EntityProfile, Fact } from './entities.js';

const fact = (entityId: string, createdAt: string, n = 0): Fact => ({
  id: `${entityId}-fact-${n}`,
  entity_id: entityId,
  predicate: 'is',
  object: `fact ${n}`,
  source_memory_id: 'mem',
  confidence: 0.9,
  valid_from: createdAt,
  valid_to: null,
  created_at: createdAt,
});

/** A profile whose facts were recorded at the given times (none = no current fact). */
const profile = (name: string, ...factTimes: string[]): EntityProfile => ({
  entity: {
    id: `id-${name}`,
    name,
    entity_type: 'tool',
    aliases: [],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
  },
  currentFacts: factTimes.map((at, n) => fact(`id-${name}`, at, n)),
  sourceMemories: [],
});

const names = (profiles: readonly EntityProfile[]) => profiles.map((p) => p.entity.name);

describe('isPathLikeEntityName', () => {
  it.each([
    '.claude/cortex-memory.local.md',
    '.claude/reviews/review-and-fix-runs',
    '.pi',
    '.gitignore',
    '/home/user/dev/repo/engine/src/cli.ts',
    '/home/user/dev',
    '~/notes',
    './scripts',
    '../sibling',
    'engine/src/cli.ts',
    'src/cli.ts',
    '  .memory/cortex.db  ',
  ])('treats %j as a path', (name) => {
    expect(isPathLikeEntityName(name)).toBe(true);
  });

  it.each([
    'CI/CD',
    'TCP/IP',
    'owner/repo',
    'Node.js',
    'socket.io',
    '.NET',
    'cli.ts',
    'NixOS',
    'potion-retrieval-32M',
    '/recall',
    'v1.2',
    '',
  ])('treats %j as a name', (name) => {
    expect(isPathLikeEntityName(name)).toBe(false);
  });
});

describe('selectSurfaceEntities', () => {
  it('puts the most recently learned-about entity first, whatever order they arrive in', () => {
    const selected = selectSurfaceEntities(
      [
        profile('Alpha', '2026-03-01T00:00:00.000Z'),
        profile('Zulu', '2026-09-01T00:00:00.000Z'),
        profile('Mike', '2026-06-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'),
      ],
      5,
    );
    expect(names(selected)).toEqual(['Zulu', 'Mike', 'Alpha']);
  });

  it('an entity is as recent as its newest fact, not its first', () => {
    const selected = selectSurfaceEntities(
      [
        profile('Old-with-news', '2026-01-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'),
        profile('Steady', '2026-08-01T00:00:00.000Z'),
      ],
      5,
    );
    expect(names(selected)).toEqual(['Old-with-news', 'Steady']);
  });

  it('paths never take a slot, however early they sort or however new they are', () => {
    const selected = selectSurfaceEntities(
      [
        profile('.claude/cortex-memory.local.md', '2026-11-01T00:00:00.000Z'),
        profile('.pi', '2026-11-01T00:00:00.000Z'),
        profile('/home/user/repo/src/cli.ts', '2026-11-01T00:00:00.000Z'),
        profile('Bun', '2026-02-01T00:00:00.000Z'),
      ],
      2,
    );
    expect(names(selected)).toEqual(['Bun']);
  });

  it('an entity with no current fact is not shown', () => {
    expect(selectSurfaceEntities([profile('Silent')], 5)).toEqual([]);
  });

  it('breaks a tie on recency by name', () => {
    const at = '2026-05-05T00:00:00.000Z';
    expect(names(selectSurfaceEntities([profile('b', at), profile('a', at), profile('c', at)], 2))).toEqual(['a', 'b']);
  });

  const isoDate = fc
    .integer({ min: Date.UTC(2025, 0, 1), max: Date.UTC(2027, 0, 1) })
    .map((ms) => new Date(ms).toISOString());
  const profiles = fc.uniqueArray(
    fc.record({
      name: fc.oneof(
        fc.string({ minLength: 1, maxLength: 12 }),
        fc.constantFrom('.claude/x.md', '/a/b/c', 'CI/CD', 'src/cli.ts', '.NET', '~/x'),
      ),
      times: fc.array(isoDate, { maxLength: 4 }),
    }),
    { selector: (p) => p.name, maxLength: 12 },
  ).map((rows) => rows.map((row) => profile(row.name, ...row.times)));
  const limit = fc.integer({ min: 0, max: 8 });

  it('property: selects at most the limit, only shown-able entities, each once, from the input', () => {
    fc.assert(
      fc.property(profiles, limit, (input, max) => {
        const selected = selectSurfaceEntities(input, max);
        expect(selected.length).toBeLessThanOrEqual(max);
        expect(new Set(selected).size).toBe(selected.length);
        for (const chosen of selected) {
          expect(input).toContain(chosen);
          expect(chosen.currentFacts.length).toBeGreaterThan(0);
          expect(isPathLikeEntityName(chosen.entity.name)).toBe(false);
        }
      }),
    );
  });

  it('property: nothing left out is more recent than anything selected', () => {
    fc.assert(
      fc.property(profiles, limit, (input, max) => {
        const selected = selectSurfaceEntities(input, max);
        if (selected.length === 0) return;
        const newest = (p: EntityProfile) => p.currentFacts.map((f) => f.created_at).sort().at(-1) ?? '';
        const oldestSelected = selected.map(newest).sort()[0];
        const leftOut = input.filter(
          (p) => !selected.includes(p) && p.currentFacts.length > 0 && !isPathLikeEntityName(p.entity.name),
        );
        for (const other of leftOut) expect(newest(other) <= oldestSelected).toBe(true);
      }),
    );
  });

  it('property: the selection does not depend on the order the entities arrive in', () => {
    fc.assert(
      fc.property(
        profiles.chain((input) => fc.tuple(fc.constant(input), fc.shuffledSubarray(input, { minLength: input.length }))),
        limit,
        ([input, shuffled], max) => {
          expect(names(selectSurfaceEntities(shuffled, max))).toEqual(names(selectSurfaceEntities(input, max)));
        },
      ),
    );
  });

  it('property: selecting again from a selection changes nothing', () => {
    fc.assert(
      fc.property(profiles, limit, (input, max) => {
        const once = selectSurfaceEntities(input, max);
        expect(selectSurfaceEntities(once, max)).toEqual(once);
      }),
    );
  });
});

describe('renderEntitySection', () => {
  it('renders the selected entities in order and no section when none qualify', () => {
    const section = renderEntitySection([
      profile('.claude/plans/plan.md', '2026-11-01T00:00:00.000Z'),
      profile('Older', '2026-02-01T00:00:00.000Z'),
      profile('Newer', '2026-09-01T00:00:00.000Z'),
    ]);
    expect(section).not.toBeNull();
    expect(section).not.toContain('.claude/plans');
    expect(section!.indexOf('**Newer**')).toBeLessThan(section!.indexOf('**Older**'));

    expect(renderEntitySection([profile('.pi', '2026-11-01T00:00:00.000Z')])).toBeNull();
  });
});
