/**
 * Tests for executeSemanticEdges orchestration.
 *
 * The LLM boundary is mocked (like extract.test.ts) so the attempt-tracking
 * wiring — typed replacement, declined marking, batch failure accounting,
 * unparseable-response retry, unique-conflict retirement, pair_index join,
 * lock skip, and the no-LLM guard — is exercised hermetically against a real
 * in-memory database.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { createMemory } from '../core/types.js';
import { openDatabase, insertMemory, insertEdge, getAllEdges, updateMemory } from '../infra/db.js';
import { acquireLock } from '../infra/lock.js';
import { executeSemanticEdges, pairContentHash } from './semantic-edges.js';

const mockClassifyEdges = vi.fn();
const mockIsClaudeLlmAvailable = vi.fn();
const mockResolveEndpoint = vi.fn();

vi.mock('../infra/claude-llm.js', () => ({
  classifyEdges: (pairs: unknown) => mockClassifyEdges(pairs),
  isClaudeLlmAvailable: () => mockIsClaudeLlmAvailable(),
}));
vi.mock('../infra/llm-client.js', () => ({
  resolveOpenAiCompatEndpoint: () => mockResolveEndpoint(),
}));

describe('executeSemanticEdges', () => {
  let db: Database;
  let lockDir: string;

  function seedMemory(id: string): void {
    insertMemory(db, createMemory({
      id, content: `content ${id}`, summary: `summary ${id}`,
      memory_type: 'context', scope: 'project', confidence: 0.8, priority: 5,
      source_type: 'manual', source_session: 'sess', source_context: '{}',
    }));
  }

  beforeEach(() => {
    db = openDatabase(':memory:');
    lockDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cortex-semantic-edges-'));
    mockClassifyEdges.mockReset();
    mockIsClaudeLlmAvailable.mockReset().mockReturnValue(true);
    mockResolveEndpoint.mockReset().mockReturnValue({ baseUrl: 'http://localhost:8000/v1', apiKey: 'k', model: 'm' });
  });

  afterAll(() => {
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  it('replaces relates_to edges with typed relations and marks them classified', async () => {
    seedMemory('a');
    seedMemory('b');
    insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    mockClassifyEdges.mockResolvedValue({
      kind: 'ok',
      classifications: [
        { source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.8 },
      ],
    });

    const result = await executeSemanticEdges(db, { limit: 0, lockDir });

    expect(result).toEqual({ ok: true, classified: 1, failed: 0 });
    const edges = getAllEdges(db);
    expect(edges.some((e) => e.relation_type === 'relates_to')).toBe(false);
    const typed = edges.find((e) => e.relation_type === 'refines')!;
    expect(typed).toBeDefined();
    // Directional relations stay directional (A19)
    expect(typed.bidirectional).toBe(false);
    expect(typed.classified_at).not.toBeNull();
    expect(typed.classify_hash).not.toBeNull();
  });

  it('keeps symmetric relations bidirectional', async () => {
    seedMemory('a');
    seedMemory('b');
    insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    mockClassifyEdges.mockResolvedValue({
      kind: 'ok',
      classifications: [
        { source_id: 'a', target_id: 'b', relation_type: 'contradicts', strength: 0.7 },
      ],
    });

    await executeSemanticEdges(db, { limit: 0, lockDir });
    const contradicts = getAllEdges(db).find((e) => e.relation_type === 'contradicts')!;
    expect(contradicts.bidirectional).toBe(true);
  });

  it('marks declined edges classified so they are not re-asked', async () => {
    seedMemory('a');
    seedMemory('b');
    const edgeId = insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    mockClassifyEdges.mockResolvedValue({
      kind: 'ok',
      classifications: [
        { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5 },
      ],
    });

    const result = await executeSemanticEdges(db, { limit: 0, lockDir });

    expect(result).toEqual({ ok: true, classified: 0, failed: 0 });
    const kept = getAllEdges(db).find((e) => e.id === edgeId)!;
    expect(kept.relation_type).toBe('relates_to');
    expect(kept.classified_at).not.toBeNull();
    expect(kept.classify_hash).not.toBeNull();
  });

  it('leaves edges unclassified but records the failure for backoff on a thrown classification failure', async () => {
    seedMemory('a');
    seedMemory('b');
    const edgeId = insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    mockClassifyEdges.mockRejectedValue(new Error('LLM API 503'));

    const result = await executeSemanticEdges(db, { limit: 0, lockDir });

    expect(result).toEqual({ ok: true, classified: 0, failed: 1 });
    const kept = getAllEdges(db).find((e) => e.id === edgeId)!;
    // A failure is never a decline: the edge stays unclassified so it is
    // retried, but the failure is recorded (timestamp + content hash) so
    // the backoff delays the retry instead of re-hammering every run.
    expect(kept.classified_at).toBeNull();
    expect(kept.last_failed_at).not.toBeNull();
    expect(kept.classify_hash).not.toBeNull();
  });

  it('leaves edges unclassified but records the failure for backoff on an unparseable response instead of retiring them', async () => {
    seedMemory('a');
    seedMemory('b');
    const edgeId = insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    mockClassifyEdges.mockResolvedValue({
      kind: 'unparseable',
      reason: 'failed to parse edge classification response: garbage',
    });

    const result = await executeSemanticEdges(db, { limit: 0, lockDir });

    // The run must not report a green ok:true/failed:0 while permanently
    // retiring the pair: the batch counts as failed and the edge stays
    // unclassified (with a failure record for the backoff) so a later run
    // retries it.
    expect(result).toEqual({ ok: true, classified: 0, failed: 1 });
    const kept = getAllEdges(db).find((e) => e.id === edgeId)!;
    expect(kept.classified_at).toBeNull();
    expect(kept.last_failed_at).not.toBeNull();
    expect(kept.classify_hash).not.toBeNull();
  });

  it('retires a replace-edge unique-constraint conflict instead of re-asking forever', async () => {
    seedMemory('a');
    seedMemory('b');
    // The pre-filter re-created a relates_to candidate although a typed edge
    // for the pair already exists (content-change requalification).
    insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.8, bidirectional: false, status: 'active' });
    const candidateId = insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    mockClassifyEdges.mockResolvedValue({
      kind: 'ok',
      classifications: [
        { source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.8 },
      ],
    });

    const result = await executeSemanticEdges(db, { limit: 0, lockDir });

    expect(result).toEqual({ ok: true, classified: 0, failed: 1 });
    // The candidate is retired so the next run does not re-ask the LLM.
    const candidate = getAllEdges(db).find((e) => e.id === candidateId)!;
    expect(candidate.classified_at).not.toBeNull();
  });

  it('joins classifications by pair_index even when the model flips the IDs', async () => {
    seedMemory('a');
    seedMemory('b');
    const edgeId = insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    // The model answers pair 1 but echoes the IDs in the wrong direction; the
    // deterministic pair_index join must still apply the classification
    // instead of treating it as unmatched (which would retire the edge).
    mockClassifyEdges.mockResolvedValue({
      kind: 'ok',
      classifications: [
        { pair_index: 1, source_id: 'b', target_id: 'a', relation_type: 'supersedes', strength: 0.9 },
      ],
    });

    const result = await executeSemanticEdges(db, { limit: 0, lockDir });

    expect(result).toEqual({ ok: true, classified: 1, failed: 0 });
    const typed = getAllEdges(db).find((e) => e.id !== edgeId)!;
    expect(typed).toMatchObject({
      source_id: 'a',
      target_id: 'b',
      relation_type: 'supersedes',
      bidirectional: false,
    });
  });

  it('rejects an unknown unindexed pair instead of retiring it as a decline', async () => {
    seedMemory('a');
    seedMemory('b');
    const edgeId = insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    mockClassifyEdges.mockResolvedValue({
      kind: 'ok',
      classifications: [
        { source_id: 'b', target_id: 'a', relation_type: 'refines', strength: 0.7 },
      ],
    });

    const result = await executeSemanticEdges(db, { limit: 0, lockDir });

    expect(result).toEqual({ ok: true, classified: 0, failed: 1 });
    const kept = getAllEdges(db).find((edge) => edge.id === edgeId)!;
    expect(kept.classified_at).toBeNull();
    expect(kept.last_failed_at).not.toBeNull();
    expect(kept.classify_hash).not.toBeNull();
  });

  it('does not re-ask an edge whose last failure is recent and content is unchanged (backoff)', async () => {
    seedMemory('a');
    seedMemory('b');
    const recentFailure = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    insertEdge(db, {
      source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active',
      classify_hash: pairContentHash(
        { content: 'content a', summary: 'summary a' },
        { content: 'content b', summary: 'summary b' },
      ),
      last_failed_at: recentFailure,
    });

    const result = await executeSemanticEdges(db, { limit: 0, lockDir });

    expect(result).toEqual({ ok: true, classified: 0, failed: 0 });
    expect(mockClassifyEdges).not.toHaveBeenCalled();
  });

  it('re-asks a failed edge once the failure backoff has elapsed', async () => {
    seedMemory('a');
    seedMemory('b');
    const oldFailure = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    insertEdge(db, {
      source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active',
      classify_hash: pairContentHash(
        { content: 'content a', summary: 'summary a' },
        { content: 'content b', summary: 'summary b' },
      ),
      last_failed_at: oldFailure,
    });
    mockClassifyEdges.mockResolvedValue({ kind: 'ok', classifications: [] });

    const result = await executeSemanticEdges(db, { limit: 0, lockDir });

    expect(result).toEqual({ ok: true, classified: 0, failed: 0 });
    expect(mockClassifyEdges).toHaveBeenCalledTimes(1);
  });

  it('re-asks an edge with an unparseable last_failed_at even inside the backoff window (fail-safe)', async () => {
    // A corrupt timestamp (NaN from Date.parse) must never pin the edge in
    // backoff forever: the !Number.isNaN guard sends it back to the queue.
    seedMemory('a');
    seedMemory('b');
    insertEdge(db, {
      source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active',
      classify_hash: pairContentHash(
        { content: 'content a', summary: 'summary a' },
        { content: 'content b', summary: 'summary b' },
      ),
      last_failed_at: 'not-a-date',
    });
    mockClassifyEdges.mockResolvedValue({ kind: 'ok', classifications: [] });

    const result = await executeSemanticEdges(db, { limit: 0, lockDir });

    expect(result).toEqual({ ok: true, classified: 0, failed: 0 });
    expect(mockClassifyEdges).toHaveBeenCalledTimes(1);
  });

  it('re-asks a failed edge immediately when its content changed since the failure', async () => {
    seedMemory('a');
    seedMemory('b');
    const recentFailure = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    insertEdge(db, {
      source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active',
      // Hash of content the edge no longer has: the pair changed since the
      // failure, which is new information and resets the backoff.
      classify_hash: 'stale-hash-from-previous-content',
      last_failed_at: recentFailure,
    });
    mockClassifyEdges.mockResolvedValue({ kind: 'ok', classifications: [] });

    const result = await executeSemanticEdges(db, { limit: 0, lockDir });

    expect(result).toEqual({ ok: true, classified: 0, failed: 0 });
    expect(mockClassifyEdges).toHaveBeenCalledTimes(1);
  });

  it('re-asks a declined edge after its content-change re-classification failure backoff elapses', async () => {
    seedMemory('a');
    seedMemory('b');
    insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });

    // Run 1: the classifier declines (answers relates_to) — the edge stays
    // relates_to with classified_at + classify_hash set.
    mockClassifyEdges.mockResolvedValue({
      kind: 'ok',
      classifications: [{ source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5 }],
    });
    const first = await executeSemanticEdges(db, { limit: 0, lockDir });
    expect(first).toEqual({ ok: true, classified: 0, failed: 0 });

    // Content changed, so re-classification is due — and the attempt fails.
    updateMemory(db, 'a', { content: 'changed content a' });
    mockClassifyEdges.mockRejectedValue(new Error('LLM API returned empty content'));
    const second = await executeSemanticEdges(db, { limit: 0, lockDir });
    expect(second).toEqual({ ok: true, classified: 0, failed: 1 });

    // Inside the backoff window the failed re-classification is not
    // re-asked (no re-hammering of the unhealthy server)...
    mockClassifyEdges.mockClear();
    const third = await executeSemanticEdges(db, { limit: 0, lockDir });
    expect(third).toEqual({ ok: true, classified: 0, failed: 0 });
    expect(mockClassifyEdges).not.toHaveBeenCalled();

    // ...but a failure is never a decline: once the backoff elapses the
    // re-classification must be retried (regression: the failure used to
    // stamp the current content hash and retire the edge forever).
    db.prepare('UPDATE edges SET last_failed_at = ?')
      .run(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
    mockClassifyEdges.mockResolvedValue({
      kind: 'ok',
      classifications: [{ source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.8 }],
    });
    const fourth = await executeSemanticEdges(db, { limit: 0, lockDir });
    expect(fourth).toEqual({ ok: true, classified: 1, failed: 0 });
    const typed = getAllEdges(db).find((edge) => edge.relation_type === 'refines')!;
    // A successful answer clears the failure record.
    expect(typed.last_failed_at).toBeNull();
  });

  it('rejects duplicate unindexed answers as a corrupt batch', async () => {
    seedMemory('a');
    seedMemory('b');
    const edgeId = insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    mockClassifyEdges.mockResolvedValue({
      kind: 'ok',
      classifications: [
        { source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.7 },
        { source_id: 'a', target_id: 'b', relation_type: 'supersedes', strength: 0.8 },
      ],
    });

    const result = await executeSemanticEdges(db, { limit: 0, lockDir });

    expect(result).toEqual({ ok: true, classified: 0, failed: 1 });
    expect(getAllEdges(db).find((edge) => edge.id === edgeId)!.classified_at).toBeNull();
  });

  it('treats an out-of-range pair_index as a corrupt response (failed, unmarked)', async () => {
    seedMemory('a');
    seedMemory('b');
    const edgeId = insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    mockClassifyEdges.mockResolvedValue({
      kind: 'ok',
      classifications: [
        { pair_index: 7, source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.7 },
      ],
    });

    const result = await executeSemanticEdges(db, { limit: 0, lockDir });

    expect(result).toEqual({ ok: true, classified: 0, failed: 1 });
    const kept = getAllEdges(db).find((e) => e.id === edgeId)!;
    expect(kept.classified_at).toBeNull();
  });

  it('treats mixed indexed/unindexed classifications as a corrupt response', async () => {
    seedMemory('a');
    seedMemory('b');
    seedMemory('c');
    seedMemory('d');
    const edgeA = insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    const edgeB = insertEdge(db, { source_id: 'c', target_id: 'd', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    mockClassifyEdges.mockResolvedValue({
      kind: 'ok',
      classifications: [
        { pair_index: 1, source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.7 },
        { source_id: 'c', target_id: 'd', relation_type: 'refines', strength: 0.7 },
      ],
    });

    const result = await executeSemanticEdges(db, { limit: 0, lockDir });

    expect(result).toEqual({ ok: true, classified: 0, failed: 2 });
    expect(getAllEdges(db).find((e) => e.id === edgeA)!.classified_at).toBeNull();
    expect(getAllEdges(db).find((e) => e.id === edgeB)!.classified_at).toBeNull();
  });

  it('treats duplicate pair_index values as a corrupt response (failed, unmarked)', async () => {
    seedMemory('a');
    seedMemory('b');
    const edgeId = insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    mockClassifyEdges.mockResolvedValue({
      kind: 'ok',
      classifications: [
        { pair_index: 1, source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.7 },
        { pair_index: 1, source_id: 'x', target_id: 'y', relation_type: 'supersedes', strength: 0.9 },
      ],
    });

    const result = await executeSemanticEdges(db, { limit: 0, lockDir });

    expect(result).toEqual({ ok: true, classified: 0, failed: 1 });
    expect(getAllEdges(db).find((e) => e.id === edgeId)!.classified_at).toBeNull();
  });

  it('counts a DB write failure per edge instead of misattributing the whole batch', async () => {
    seedMemory('a');
    seedMemory('b');
    insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    mockClassifyEdges.mockResolvedValue({
      kind: 'ok',
      classifications: [
        { source_id: 'a', target_id: 'b', relation_type: 'contradicts', strength: 0.7 },
      ],
    });
    // Make the replacement transaction fail like a locked/busy DB would.
    const insertSpy = vi.spyOn(await import('../infra/db.js'), 'insertEdge')
      .mockImplementationOnce(() => { throw new Error('SQLITE_BUSY: database is locked'); });
    try {
      const result = await executeSemanticEdges(db, { limit: 0, lockDir });
      expect(result).toEqual({ ok: true, classified: 0, failed: 1 });
    } finally {
      insertSpy.mockRestore();
    }
  });

  it('handles multiple batches with mixed success and failure accounting', async () => {
    // 12 pairs → batches of 10 + 2 (BATCH_SIZE=10). The first batch's
    // response is unparseable (all 10 fail, unmarked); the second batch
    // classifies both pairs.
    for (let i = 0; i < 12; i++) {
      seedMemory(`m${i}`);
      seedMemory(`m${i}-t`);
      insertEdge(db, {
        source_id: `m${i}`, target_id: `m${i}-t`, relation_type: 'relates_to',
        strength: 0.5, bidirectional: true, status: 'active',
      });
    }
    mockClassifyEdges
      .mockResolvedValueOnce({ kind: 'unparseable', reason: 'garbage' })
      .mockResolvedValueOnce({
        kind: 'ok',
        classifications: [
          { pair_index: 1, source_id: 'm10', target_id: 'm10-t', relation_type: 'refines', strength: 0.8 },
          { pair_index: 2, source_id: 'm11', target_id: 'm11-t', relation_type: 'supersedes', strength: 0.9 },
        ],
      });

    const result = await executeSemanticEdges(db, { limit: 0, lockDir });

    expect(result).toEqual({ ok: true, classified: 2, failed: 10 });
    const edges = getAllEdges(db);
    // The 10 failed edges are unmarked and remain relates_to.
    expect(edges.filter((e) => e.relation_type === 'relates_to' && e.classified_at === null)).toHaveLength(10);
    // The 2 typed replacements are marked.
    expect(edges.filter((e) => e.classified_at !== null && e.relation_type !== 'relates_to')).toHaveLength(2);
  });

  it('skips when the semantic-edges lock is held', async () => {
    const lockFile = nodePath.join(lockDir, 'semantic-edges.lock');
    fs.writeFileSync(lockFile, String(process.pid));
    expect(acquireLock(lockFile).acquired).toBe(false);

    seedMemory('a');
    seedMemory('b');
    const result = await executeSemanticEdges(db, { limit: 0, lockDir });

    expect(result).toEqual({ ok: true, classified: 0, failed: 0 });
    expect(mockClassifyEdges).not.toHaveBeenCalled();
  });

  it('fails with a clear error when no LLM transport is available', async () => {
    mockIsClaudeLlmAvailable.mockReturnValue(false);
    mockResolveEndpoint.mockReturnValue(null);
    seedMemory('a');
    seedMemory('b');

    const result = await executeSemanticEdges(db, { limit: 0, lockDir });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no LLM available/i);
    expect(mockClassifyEdges).not.toHaveBeenCalled();
  });

  it('returns immediately when every candidate is already classified', async () => {
    seedMemory('a');
    seedMemory('b');
    insertEdge(db, {
      source_id: 'a', target_id: 'b', relation_type: 'relates_to',
      strength: 0.5, bidirectional: true, status: 'active',
      classified_at: '2026-08-12T00:00:00.000Z',
      classify_hash: pairContentHash({ content: 'content a', summary: 'summary a' }, { content: 'content b', summary: 'summary b' }),
    });

    const result = await executeSemanticEdges(db, { limit: 0, lockDir });

    expect(result).toEqual({ ok: true, classified: 0, failed: 0 });
    expect(mockClassifyEdges).not.toHaveBeenCalled();
  });
});
