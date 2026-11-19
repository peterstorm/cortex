/**
 * Dedupe shell: plan + apply over real (in-memory) databases.
 * The planner's laws are property-tested in core/restatement.test.ts; this
 * file checks the writes — status, supersedes edge, re-pointed edges and
 * facts, dry-run purity, idempotence and the per-database split.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Database } from 'bun:sqlite';
import {
  executeDedupe,
  dedupeChangedMemories,
  formatDedupeOutcome,
  type DedupeTarget,
} from './dedupe.js';
import { createMemory, type Memory } from '../core/types.js';
import {
  openDatabase,
  insertMemory,
  insertEdge,
  insertFact,
  upsertEntity,
  getMemory,
  getAllEdges,
  getFactsByMemory,
} from '../infra/db.js';
import { LOCAL_EMBED_MODEL } from '../config.js';

const THRESHOLD = 0.9;

/** Unit vector at `degrees` in one plane, so cos(at(a), at(b)) = cos(a - b). */
const at = (degrees: number): Float32Array => {
  const r = (degrees * Math.PI) / 180;
  return new Float32Array([Math.cos(r), Math.sin(r), 0, 0]);
};

type SeedOptions = Readonly<{ tags?: readonly string[]; priority?: number; content?: string }>;

const seed = (db: Database, id: string, degrees: number, day: number, options: SeedOptions = {}): Memory => {
  const memory = createMemory({
    id,
    content: options.content ?? `${id} content`,
    summary: `${id} summary`,
    memory_type: 'decision',
    scope: 'project',
    confidence: 0.9,
    priority: options.priority ?? 5,
    tags: options.tags ?? [],
    source_type: 'extraction',
    source_session: 's',
    source_context: '{}',
    local_embedding: at(degrees),
    created_at: new Date(Date.UTC(2026, 0, 1 + day)).toISOString(),
  });
  insertMemory(db, memory);
  return memory;
};

describe('executeDedupe', () => {
  let project: Database;
  let global: Database;
  let targets: readonly DedupeTarget[];

  beforeEach(() => {
    project = openDatabase(':memory:');
    global = openDatabase(':memory:');
    targets = [
      { label: 'project', db: project },
      { label: 'global', db: global },
    ];
  });

  afterEach(() => {
    project.close();
    global.close();
  });

  it('reports disabled and touches nothing when the model has no restatement calibration', () => {
    seed(project, 'old', 0, 0);
    seed(project, 'new', 0, 1);
    const outcome = executeDedupe(targets, null, false);
    expect(outcome).toEqual({ kind: 'disabled', model: LOCAL_EMBED_MODEL });
    expect(getMemory(project, 'old')?.status).toBe('active');
    expect(formatDedupeOutcome(outcome)).toBe(`Dedupe disabled: ${LOCAL_EMBED_MODEL} has no restatement calibration`);
    expect(dedupeChangedMemories(outcome)).toBe(false);
  });

  it('dry-run plans the pair and writes nothing', () => {
    seed(project, 'old', 0, 0);
    seed(project, 'new', 3, 1);
    const outcome = executeDedupe(targets, THRESHOLD, true);

    expect(outcome.kind).toBe('planned');
    const text = formatDedupeOutcome(outcome);
    expect(text).toContain('Dedupe would supersede 1 restatement(s) (project 1, global 0)');
    expect(text).toContain('keep      new  new summary');
    expect(text).toContain('supersede old  old summary');
    expect(dedupeChangedMemories(outcome)).toBe(false);
    expect(getMemory(project, 'old')?.status).toBe('active');
    expect(getAllEdges(project)).toEqual([]);
  });

  it('supersedes the older memory, links kept → older and re-points its edges and facts', () => {
    seed(project, 'old', 0, 0);
    seed(project, 'new', 3, 1);
    seed(project, 'neighbour', 80, 0);
    insertEdge(project, {
      source_id: 'old', target_id: 'neighbour',
      relation_type: 'refines', strength: 0.8, bidirectional: true, status: 'active',
    });
    const entityId = upsertEntity(project, 'Deployer', 'tool');
    const now = new Date().toISOString();
    insertFact(project, {
      id: 'fact-1', entity_id: entityId, predicate: 'runs', object: 'nightly',
      source_memory_id: 'old', confidence: 0.8, valid_from: now, valid_to: null, created_at: now,
    });

    const outcome = executeDedupe(targets, THRESHOLD, false);

    expect(formatDedupeOutcome(outcome)).toBe('Dedupe superseded 1 restatement(s) (project 1, global 0)');
    expect(dedupeChangedMemories(outcome)).toBe(true);
    expect(getMemory(project, 'old')?.status).toBe('superseded');
    expect(getMemory(project, 'new')?.status).toBe('active');

    const edges = getAllEdges(project);
    expect(edges.filter((e) => e.relation_type === 'supersedes')).toEqual([
      expect.objectContaining({ source_id: 'new', target_id: 'old', strength: 1, bidirectional: false }),
    ]);
    expect(edges.filter((e) => e.relation_type === 'refines')).toEqual([
      expect.objectContaining({ source_id: 'new', target_id: 'neighbour' }),
    ]);
    expect(getFactsByMemory(project, 'old')).toEqual([]);
    expect(getFactsByMemory(project, 'new').map((f) => f.id)).toEqual(['fact-1']);
  });

  it('reuses a supersedes edge the graph already holds instead of aborting the transaction', () => {
    // The retired semantic-edges pass labelled some restating pairs
    // `supersedes` (newer → older) without retiring the older memory.
    seed(project, 'old', 0, 0);
    seed(project, 'new', 3, 1);
    seed(project, 'other-old', 90, 0);
    seed(project, 'other-new', 92, 1);
    insertEdge(project, {
      source_id: 'new', target_id: 'old',
      relation_type: 'supersedes', strength: 0.6, bidirectional: false, status: 'suggested',
    });

    const outcome = executeDedupe(targets, THRESHOLD, false);

    expect(formatDedupeOutcome(outcome)).toBe('Dedupe superseded 2 restatement(s) (project 2, global 0)');
    expect(getMemory(project, 'old')?.status).toBe('superseded');
    expect(getMemory(project, 'other-old')?.status).toBe('superseded');
    const supersedes = getAllEdges(project).filter((e) => e.relation_type === 'supersedes');
    expect(supersedes).toHaveLength(2);
    expect(supersedes.find((e) => e.target_id === 'old')).toEqual(
      expect.objectContaining({ source_id: 'new', strength: 1, bidirectional: false, status: 'active' })
    );
  });

  it('is idempotent: a second run supersedes nothing', () => {
    seed(project, 'a', 0, 0);
    seed(project, 'b', 2, 1);
    seed(project, 'c', 4, 2);
    expect(formatDedupeOutcome(executeDedupe(targets, THRESHOLD, false))).toContain('superseded 2 restatement(s)');

    const again = executeDedupe(targets, THRESHOLD, false);
    expect(formatDedupeOutcome(again)).toBe('Dedupe superseded 0 restatement(s) (project 0, global 0)');
    expect(dedupeChangedMemories(again)).toBe(false);
  });

  it('dedupes each database separately and never across them', () => {
    seed(project, 'p-old', 0, 0);
    seed(project, 'p-new', 1, 1);
    seed(global, 'g-only', 0, 2); // restates p-old, but lives in the other DB
    const outcome = executeDedupe(targets, THRESHOLD, false);

    expect(formatDedupeOutcome(outcome)).toBe('Dedupe superseded 1 restatement(s) (project 1, global 0)');
    expect(getMemory(global, 'g-only')?.status).toBe('active');
    expect(getMemory(project, 'p-old')?.status).toBe('superseded');
  });

  it('the kept memory absorbs the union of tags and the highest priority of every copy it supersedes', () => {
    seed(project, 'oldest', 0, 0, { tags: ['ops', 'deploy-target'], priority: 3 });
    seed(project, 'older', 2, 1, { tags: ['release', 'ops'], priority: 8 });
    seed(project, 'newest', 1, 2, { tags: ['deploy'], priority: 4 });

    const outcome = executeDedupe(targets, THRESHOLD, false);

    expect(formatDedupeOutcome(outcome)).toBe('Dedupe superseded 2 restatement(s) (project 2, global 0)');
    const kept = getMemory(project, 'newest');
    expect(kept?.status).toBe('active');
    expect(kept?.tags).toEqual(['deploy', 'release', 'ops', 'deploy-target']);
    expect(kept?.priority).toBe(8);
  });

  it('leaves the kept memory untouched when the copy adds no tag and no priority', () => {
    seed(project, 'old', 0, 0, { tags: ['ops'], priority: 2 });
    const kept = seed(project, 'new', 3, 1, { tags: ['ops'], priority: 5 });

    executeDedupe(targets, THRESHOLD, false);

    expect(getMemory(project, 'old')?.status).toBe('superseded');
    expect(getMemory(project, 'new')).toEqual(expect.objectContaining({ tags: ['ops'], priority: 5, updated_at: kept.updated_at }));
  });

  it('never supersedes a merge product, which keeps the content its merges appended', () => {
    seed(project, 'merged', 0, 0, { content: 'merged content\n---\ndetail only the merge holds' });
    seed(project, 'restated', 2, 1);

    const outcome = executeDedupe(targets, THRESHOLD, false);

    expect(dedupeChangedMemories(outcome)).toBe(false);
    expect(getMemory(project, 'merged')?.status).toBe('active');
    expect(getMemory(project, 'restated')?.status).toBe('active');
  });

  it('leaves dissimilar memories alone', () => {
    seed(project, 'x', 0, 0);
    seed(project, 'y', 45, 1);
    const outcome = executeDedupe(targets, THRESHOLD, false);
    expect(dedupeChangedMemories(outcome)).toBe(false);
    expect(getMemory(project, 'x')?.status).toBe('active');
  });
});
