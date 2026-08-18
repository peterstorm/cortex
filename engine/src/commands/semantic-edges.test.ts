/**
 * Tests for executeSemanticEdges orchestration and the pure helpers it
 * delegates to.
 *
 * Only the network call is stubbed, via the injectable LlmPromptTransport, so
 * the attempt-tracking wiring — typed replacement, declined marking, batch
 * failure accounting, unparseable-response retry, unique-conflict retirement,
 * pair_index join, lock skip, and the no-LLM guard — is exercised
 * hermetically against a real in-memory database AND the real classifyEdges.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { createMemory } from '../core/types.js';
import { openDatabase, insertMemory, insertEdge, getAllEdges, updateMemory } from '../infra/db.js';
import { acquireLock } from '../infra/lock.js';
import type { LlmPromptTransport } from '../infra/claude-llm.js';
import { withBunWhichUnavailable } from '../infra/llm-test-helpers.js';
import {
  executeSemanticEdges,
  pairContentHash,
  joinClassificationsToPairs,
  isUniqueConstraintError,
} from './semantic-edges.js';

// The LLM boundary here is the injectable transport, not the whole
// claude-llm module: these tests drive the real classifyEdges — prompt
// building, strict-vs-tolerant parsing, and the pair_index join — and stub
// only the network call underneath it.
const transportCall = vi.fn();
const transport: LlmPromptTransport = (prompt, timeoutMs, options) =>
  transportCall(prompt, timeoutMs, options) as ReturnType<LlmPromptTransport>;

/** Answer the batch on the direct (schema-guided, strict-parsed) path. */
function answerWith(classifications: readonly Record<string, unknown>[]): void {
  transportCall.mockResolvedValue({ text: JSON.stringify({ edges: classifications }), direct: true });
}

// Endpoint resolution stays mocked: it is the configuration seam deciding
// direct-vs-CLI, not the LLM call. A configured endpoint also short-circuits
// the isClaudeLlmAvailable PATH probe in the availability guard.
const mockResolveEndpoint = vi.fn();
vi.mock('../infra/llm-client.js', () => ({
  resolveOpenAiCompatEndpoint: () => mockResolveEndpoint(),
}));

describe('executeSemanticEdges', () => {
  let db: Database;
  let lockDir: string;

  /**
   * The classify_hash an already-attempted edge between two seedMemory rows
   * would carry. Mirrors seedMemory's own content template so the two cannot
   * drift apart: if they did, the backoff tests below would silently start
   * exercising the content-CHANGED branch while still claiming to pin the
   * unchanged one, with nothing failing to say so.
   */
  function matchingContentHash(sourceId: string, targetId: string): string {
    return pairContentHash(
      { content: `content ${sourceId}`, summary: `summary ${sourceId}` },
      { content: `content ${targetId}`, summary: `summary ${targetId}` },
    );
  }

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
    transportCall.mockReset();
    mockResolveEndpoint.mockReset().mockReturnValue({ baseUrl: 'http://localhost:8000/v1', apiKey: 'k', model: 'm' });
  });

  afterAll(() => {
    fs.rmSync(lockDir, { recursive: true, force: true });
  });

  it('replaces relates_to edges with typed relations and marks them classified', async () => {
    seedMemory('a');
    seedMemory('b');
    insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    answerWith([
      { source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.8 },
    ]);

    const result = await executeSemanticEdges(db, { limit: 0, lockDir, transport });

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
    answerWith([
      { source_id: 'a', target_id: 'b', relation_type: 'contradicts', strength: 0.7 },
    ]);

    await executeSemanticEdges(db, { limit: 0, lockDir, transport });
    const contradicts = getAllEdges(db).find((e) => e.relation_type === 'contradicts')!;
    expect(contradicts.bidirectional).toBe(true);
  });

  it('marks declined edges classified so they are not re-asked', async () => {
    seedMemory('a');
    seedMemory('b');
    const edgeId = insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    answerWith([
      { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5 },
    ]);

    const result = await executeSemanticEdges(db, { limit: 0, lockDir, transport });

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
    transportCall.mockRejectedValue(new Error('LLM API 503'));

    const result = await executeSemanticEdges(db, { limit: 0, lockDir, transport });

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
    // Tolerant (CLI-fallback) path: unschematized garbage parses to
    // 'unparseable' rather than throwing.
    transportCall.mockResolvedValue({ text: 'not json at all', direct: false });

    const result = await executeSemanticEdges(db, { limit: 0, lockDir, transport });

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
    answerWith([
      { source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.8 },
    ]);

    const result = await executeSemanticEdges(db, { limit: 0, lockDir, transport });

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
    answerWith([
      { pair_index: 1, source_id: 'b', target_id: 'a', relation_type: 'supersedes', strength: 0.9 },
    ]);

    const result = await executeSemanticEdges(db, { limit: 0, lockDir, transport });

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
    answerWith([
      { source_id: 'b', target_id: 'a', relation_type: 'refines', strength: 0.7 },
    ]);

    const result = await executeSemanticEdges(db, { limit: 0, lockDir, transport });

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
      classify_hash: matchingContentHash('a', 'b'),
      last_failed_at: recentFailure,
    });

    const result = await executeSemanticEdges(db, { limit: 0, lockDir, transport });

    expect(result).toEqual({ ok: true, classified: 0, failed: 0 });
    expect(transportCall).not.toHaveBeenCalled();
  });

  it('re-asks a failed edge once the failure backoff has elapsed', async () => {
    seedMemory('a');
    seedMemory('b');
    const oldFailure = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    insertEdge(db, {
      source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active',
      classify_hash: matchingContentHash('a', 'b'),
      last_failed_at: oldFailure,
    });
    answerWith([]);

    const result = await executeSemanticEdges(db, { limit: 0, lockDir, transport });

    expect(result).toEqual({ ok: true, classified: 0, failed: 0 });
    expect(transportCall).toHaveBeenCalledTimes(1);
  });

  it('re-asks an edge with an unparseable last_failed_at even inside the backoff window (fail-safe)', async () => {
    // A corrupt timestamp (NaN from Date.parse) must never pin the edge in
    // backoff forever: the !Number.isNaN guard sends it back to the queue.
    seedMemory('a');
    seedMemory('b');
    insertEdge(db, {
      source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active',
      classify_hash: matchingContentHash('a', 'b'),
      last_failed_at: 'not-a-date',
    });
    answerWith([]);

    const result = await executeSemanticEdges(db, { limit: 0, lockDir, transport });

    expect(result).toEqual({ ok: true, classified: 0, failed: 0 });
    expect(transportCall).toHaveBeenCalledTimes(1);
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
    answerWith([]);

    const result = await executeSemanticEdges(db, { limit: 0, lockDir, transport });

    expect(result).toEqual({ ok: true, classified: 0, failed: 0 });
    expect(transportCall).toHaveBeenCalledTimes(1);
  });

  it('re-asks a declined edge after its content-change re-classification failure backoff elapses', async () => {
    seedMemory('a');
    seedMemory('b');
    insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });

    // Run 1: the classifier declines (answers relates_to) — the edge stays
    // relates_to with classified_at + classify_hash set.
    answerWith([{ source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5 }]);
    const first = await executeSemanticEdges(db, { limit: 0, lockDir, transport });
    expect(first).toEqual({ ok: true, classified: 0, failed: 0 });

    // Content changed, so re-classification is due — and the attempt fails.
    updateMemory(db, 'a', { content: 'changed content a' });
    transportCall.mockRejectedValue(new Error('LLM API returned empty content'));
    const second = await executeSemanticEdges(db, { limit: 0, lockDir, transport });
    expect(second).toEqual({ ok: true, classified: 0, failed: 1 });

    // Inside the backoff window the failed re-classification is not
    // re-asked (no re-hammering of the unhealthy server)...
    transportCall.mockClear();
    const third = await executeSemanticEdges(db, { limit: 0, lockDir, transport });
    expect(third).toEqual({ ok: true, classified: 0, failed: 0 });
    expect(transportCall).not.toHaveBeenCalled();

    // ...but a failure is never a decline: once the backoff elapses the
    // re-classification must be retried (regression: the failure used to
    // stamp the current content hash and retire the edge forever).
    db.prepare('UPDATE edges SET last_failed_at = ?')
      .run(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
    answerWith([{ source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.8 }]);
    const fourth = await executeSemanticEdges(db, { limit: 0, lockDir, transport });
    expect(fourth).toEqual({ ok: true, classified: 1, failed: 0 });
    const typed = getAllEdges(db).find((edge) => edge.relation_type === 'refines')!;
    // A successful answer clears the failure record.
    expect(typed.last_failed_at).toBeNull();
  });

  it('rejects duplicate unindexed answers as a corrupt batch', async () => {
    seedMemory('a');
    seedMemory('b');
    const edgeId = insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    answerWith([
      { source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.7 },
      { source_id: 'a', target_id: 'b', relation_type: 'supersedes', strength: 0.8 },
    ]);

    const result = await executeSemanticEdges(db, { limit: 0, lockDir, transport });

    expect(result).toEqual({ ok: true, classified: 0, failed: 1 });
    expect(getAllEdges(db).find((edge) => edge.id === edgeId)!.classified_at).toBeNull();
  });

  it('treats an out-of-range pair_index as a corrupt response (failed, unmarked)', async () => {
    seedMemory('a');
    seedMemory('b');
    const edgeId = insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    answerWith([
      { pair_index: 7, source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.7 },
    ]);

    const result = await executeSemanticEdges(db, { limit: 0, lockDir, transport });

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
    answerWith([
      { pair_index: 1, source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.7 },
      { source_id: 'c', target_id: 'd', relation_type: 'refines', strength: 0.7 },
    ]);

    const result = await executeSemanticEdges(db, { limit: 0, lockDir, transport });

    expect(result).toEqual({ ok: true, classified: 0, failed: 2 });
    expect(getAllEdges(db).find((e) => e.id === edgeA)!.classified_at).toBeNull();
    expect(getAllEdges(db).find((e) => e.id === edgeB)!.classified_at).toBeNull();
  });

  it('treats duplicate pair_index values as a corrupt response (failed, unmarked)', async () => {
    seedMemory('a');
    seedMemory('b');
    const edgeId = insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    answerWith([
      { pair_index: 1, source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.7 },
      { pair_index: 1, source_id: 'x', target_id: 'y', relation_type: 'supersedes', strength: 0.9 },
    ]);

    const result = await executeSemanticEdges(db, { limit: 0, lockDir, transport });

    expect(result).toEqual({ ok: true, classified: 0, failed: 1 });
    expect(getAllEdges(db).find((e) => e.id === edgeId)!.classified_at).toBeNull();
  });

  it('counts a DB write failure per edge instead of misattributing the whole batch', async () => {
    seedMemory('a');
    seedMemory('b');
    insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    answerWith([
      { source_id: 'a', target_id: 'b', relation_type: 'contradicts', strength: 0.7 },
    ]);
    // Make the replacement transaction fail like a locked/busy DB would.
    const insertSpy = vi.spyOn(await import('../infra/db.js'), 'insertEdge')
      .mockImplementationOnce(() => { throw new Error('SQLITE_BUSY: database is locked'); });
    try {
      const result = await executeSemanticEdges(db, { limit: 0, lockDir, transport });
      expect(result).toEqual({ ok: true, classified: 0, failed: 1 });
    } finally {
      insertSpy.mockRestore();
    }
  });

  // Both stamping paths run inside a mapLimit worker. An error escaping either
  // one rejects Promise.all, which discards the tallies of every other batch
  // and leaves the abandoned runner writing to a database the caller's finally
  // is about to close. These two pin that neither path can escape.

  it('keeps sibling batch counts when one edge\'s failure stamp cannot be written', async () => {
    // Same 12-pair, two-batch shape as the mixed-accounting test below: batch
    // one is unparseable (10 failures, each needing a backoff stamp), batch two
    // classifies 2. With markEdgeFailed throwing, the run used to lose all of
    // it; the counts below are what survives.
    for (let i = 0; i < 12; i++) {
      seedMemory(`m${i}`);
      seedMemory(`m${i}-t`);
      insertEdge(db, {
        source_id: `m${i}`, target_id: `m${i}-t`, relation_type: 'relates_to',
        strength: 0.5, bidirectional: true, status: 'active',
      });
    }
    transportCall
      .mockResolvedValueOnce({ text: 'garbage', direct: false })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          edges: [
            { pair_index: 1, source_id: 'm10', target_id: 'm10-t', relation_type: 'refines', strength: 0.8 },
            { pair_index: 2, source_id: 'm11', target_id: 'm11-t', relation_type: 'supersedes', strength: 0.9 },
          ],
        }),
        direct: true,
      });
    const failedSpy = vi.spyOn(await import('../infra/db.js'), 'markEdgeFailed')
      .mockImplementation(() => { throw new Error('SQLITE_BUSY: database is locked'); });

    try {
      const result = await executeSemanticEdges(db, { limit: 0, lockDir, transport });
      expect(result).toEqual({ ok: true, classified: 2, failed: 10 });
      // The stamp is what was lost, not the run: the failed edges stay
      // unclassified and simply get re-asked without the backoff delay.
      expect(getAllEdges(db).filter((e) => e.relation_type !== 'relates_to')).toHaveLength(2);
    } finally {
      failedSpy.mockRestore();
    }
  });

  it('survives a unique-constraint recovery stamp that cannot be written', async () => {
    seedMemory('a');
    seedMemory('b');
    // The candidate the run will classify...
    insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    // ...and a typed edge for the same pair that already exists, so the
    // replacement insert trips UNIQUE (source_id, target_id, relation_type)
    // and the run takes the recovery branch.
    insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.9, bidirectional: false, status: 'active' });
    answerWith([
      { source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.8 },
    ]);
    const classifiedSpy = vi.spyOn(await import('../infra/db.js'), 'markEdgeClassified')
      .mockImplementation(() => { throw new Error('SQLITE_BUSY: database is locked'); });

    try {
      const result = await executeSemanticEdges(db, { limit: 0, lockDir, transport });
      // Unguarded, this threw out of the worker and the whole run reported
      // ok:false with no counts at all.
      expect(result).toEqual({ ok: true, classified: 0, failed: 1 });
    } finally {
      classifiedSpy.mockRestore();
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
    transportCall
      .mockResolvedValueOnce({ text: 'garbage', direct: false })
      .mockResolvedValueOnce({
        text: JSON.stringify({
          edges: [
            { pair_index: 1, source_id: 'm10', target_id: 'm10-t', relation_type: 'refines', strength: 0.8 },
            { pair_index: 2, source_id: 'm11', target_id: 'm11-t', relation_type: 'supersedes', strength: 0.9 },
          ],
        }),
        direct: true,
      });

    const result = await executeSemanticEdges(db, { limit: 0, lockDir, transport });

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
    const result = await executeSemanticEdges(db, { limit: 0, lockDir, transport });

    expect(result).toEqual({ ok: true, classified: 0, failed: 0 });
    expect(transportCall).not.toHaveBeenCalled();
  });

  it('fails with a clear error when no LLM transport is available', async () => {
    // No endpoint AND no CLI on PATH: the real isClaudeLlmAvailable probe runs
    // here, so the CLI lookup is stubbed away rather than the module mocked.
    mockResolveEndpoint.mockReturnValue(null);
    seedMemory('a');
    seedMemory('b');

    const result = await withBunWhichUnavailable(() =>
      executeSemanticEdges(db, { limit: 0, lockDir, transport })
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no LLM available/i);
    expect(transportCall).not.toHaveBeenCalled();
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

    const result = await executeSemanticEdges(db, { limit: 0, lockDir, transport });

    expect(result).toEqual({ ok: true, classified: 0, failed: 0 });
    expect(transportCall).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Pure helpers extracted from the batch worker (r51)
// ============================================================================

describe('joinClassificationsToPairs', () => {
  const pair = (sourceId: string, targetId: string) => ({
    pair: {
      source: { id: sourceId, content: `content ${sourceId}`, summary: `summary ${sourceId}`, memory_type: 'context' as const },
      target: { id: targetId, content: `content ${targetId}`, summary: `summary ${targetId}`, memory_type: 'context' as const },
    },
  });
  const classification = (over: Record<string, unknown>) => ({
    source_id: 'a', target_id: 'b', relation_type: 'refines' as const, strength: 0.8, ...over,
  });

  it('joins by ordinal when every entry echoes pair_index', () => {
    const result = joinClassificationsToPairs(
      [pair('a', 'b'), pair('c', 'd')],
      [classification({ pair_index: 2 }), classification({ pair_index: 1 })]
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.byOrdinal) {
      expect([...result.byIndex.keys()].sort()).toEqual([1, 2]);
    } else {
      expect.unreachable('expected an ordinal join');
    }
  });

  // The whole point of the ordinal protocol: a model that flips the IDs must
  // not cost us the classification.
  it('ignores flipped IDs when pair_index is present', () => {
    const result = joinClassificationsToPairs(
      [pair('a', 'b')],
      [classification({ pair_index: 1, source_id: 'b', target_id: 'a' })]
    );
    expect(result.ok && result.byOrdinal && result.byIndex.has(1)).toBe(true);
  });

  it('joins by composite key when no entry echoes pair_index', () => {
    const result = joinClassificationsToPairs([pair('a', 'b')], [classification({})]);
    expect(result.ok && !result.byOrdinal && result.byKey.has('a:b')).toBe(true);
  });

  it('accepts an empty response as an empty join rather than a failure', () => {
    const result = joinClassificationsToPairs([pair('a', 'b')], []);
    expect(result).toEqual({ ok: true, byOrdinal: false, byKey: new Map() });
  });

  it.each([
    [
      'duplicate pair_index',
      [classification({ pair_index: 1 }), classification({ pair_index: 1 })],
      /duplicate pair_index 1/,
    ],
    [
      'out-of-range pair_index',
      [classification({ pair_index: 7 })],
      /pair_index 7 is out of range for a 1-pair batch/,
    ],
    [
      'unknown unindexed pair',
      [classification({ source_id: 'x', target_id: 'y' })],
      /referenced unknown unindexed pair x:y/,
    ],
    [
      'duplicate unindexed pair',
      [classification({}), classification({ relation_type: 'supersedes' as const })],
      /duplicate unindexed pair a:b/,
    ],
  ])('rejects a corrupt response: %s', (_name, classifications, expected) => {
    const result = joinClassificationsToPairs([pair('a', 'b')], classifications);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(expected);
  });

  it('rejects a response that mixes indexed and unindexed entries', () => {
    const result = joinClassificationsToPairs(
      [pair('a', 'b'), pair('c', 'd')],
      [classification({ pair_index: 1 }), classification({ source_id: 'c', target_id: 'd' })]
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/mixed indexed and unindexed entries \(1 of 2 indexed\)/);
  });
});

describe('isUniqueConstraintError', () => {
  it('recognizes the SQLite result code without reading the message', () => {
    expect(isUniqueConstraintError(Object.assign(new Error('opaque'), { code: 'SQLITE_CONSTRAINT_UNIQUE' }))).toBe(true);
    expect(isUniqueConstraintError(Object.assign(new Error('opaque'), { code: 'SQLITE_CONSTRAINT_PRIMARYKEY' }))).toBe(true);
  });

  it('does not mistake another constraint class for a unique conflict', () => {
    expect(isUniqueConstraintError(Object.assign(new Error('x'), { code: 'SQLITE_CONSTRAINT_FOREIGNKEY' }))).toBe(false);
    expect(isUniqueConstraintError(Object.assign(new Error('x'), { code: 'SQLITE_CONSTRAINT_NOTNULL' }))).toBe(false);
  });

  it('falls back to the message when no code is present', () => {
    expect(isUniqueConstraintError(new Error('UNIQUE constraint failed: edges.source_id'))).toBe(true);
    expect(isUniqueConstraintError(new Error('database is locked'))).toBe(false);
    expect(isUniqueConstraintError('UNIQUE constraint failed')).toBe(true);
    expect(isUniqueConstraintError(null)).toBe(false);
  });
});
