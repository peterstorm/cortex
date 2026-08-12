/**
 * Tests for executeSemanticEdges orchestration.
 *
 * The LLM boundary is mocked (like extract.test.ts) so the attempt-tracking
 * wiring — typed replacement, declined marking, batch failure accounting,
 * unique-conflict retirement, lock skip, and the no-LLM guard — is exercised
 * hermetically against a real in-memory database.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import { createMemory } from '../core/types.js';
import { openDatabase, insertMemory, insertEdge, getAllEdges } from '../infra/db.js';
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
    mockClassifyEdges.mockResolvedValue([
      { source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.8 },
    ]);

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
    mockClassifyEdges.mockResolvedValue([
      { source_id: 'a', target_id: 'b', relation_type: 'contradicts', strength: 0.7 },
    ]);

    await executeSemanticEdges(db, { limit: 0, lockDir });
    const contradicts = getAllEdges(db).find((e) => e.relation_type === 'contradicts')!;
    expect(contradicts.bidirectional).toBe(true);
  });

  it('marks declined edges classified so they are not re-asked', async () => {
    seedMemory('a');
    seedMemory('b');
    const edgeId = insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    mockClassifyEdges.mockResolvedValue([
      { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5 },
    ]);

    const result = await executeSemanticEdges(db, { limit: 0, lockDir });

    expect(result).toEqual({ ok: true, classified: 0, failed: 0 });
    const kept = getAllEdges(db).find((e) => e.id === edgeId)!;
    expect(kept.relation_type).toBe('relates_to');
    expect(kept.classified_at).not.toBeNull();
    expect(kept.classify_hash).not.toBeNull();
  });

  it('leaves edges unmarked and counts the batch on a thrown classification failure', async () => {
    seedMemory('a');
    seedMemory('b');
    const edgeId = insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    mockClassifyEdges.mockRejectedValue(new Error('LLM API 503'));

    const result = await executeSemanticEdges(db, { limit: 0, lockDir });

    expect(result).toEqual({ ok: true, classified: 0, failed: 1 });
    const kept = getAllEdges(db).find((e) => e.id === edgeId)!;
    expect(kept.classified_at).toBeNull();
    expect(kept.classify_hash).toBeNull();
  });

  it('retires a replace-edge unique-constraint conflict instead of re-asking forever', async () => {
    seedMemory('a');
    seedMemory('b');
    // The pre-filter re-created a relates_to candidate although a typed edge
    // for the pair already exists (content-change requalification).
    insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.8, bidirectional: false, status: 'active' });
    const candidateId = insertEdge(db, { source_id: 'a', target_id: 'b', relation_type: 'relates_to', strength: 0.5, bidirectional: true, status: 'active' });
    mockClassifyEdges.mockResolvedValue([
      { source_id: 'a', target_id: 'b', relation_type: 'refines', strength: 0.8 },
    ]);

    const result = await executeSemanticEdges(db, { limit: 0, lockDir });

    expect(result).toEqual({ ok: true, classified: 0, failed: 1 });
    // The candidate is retired so the next run does not re-ask the LLM.
    const candidate = getAllEdges(db).find((e) => e.id === candidateId)!;
    expect(candidate.classified_at).not.toBeNull();
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
