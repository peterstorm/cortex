/**
 * Read admission: the optional `admit` filter on the two reads the hooks
 * inject (composeSurface, prompt recall). Absent, both reads behave exactly
 * as before; present, a refused memory reaches neither, on any recall path.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { Database } from 'bun:sqlite';
import type { MemoryAdmission } from '../core/admission.js';
import { createMemory } from '../core/types.js';
import { insertFact, insertMemory, openDatabase, upsertEntity } from '../infra/db.js';
import { composeSurface } from './generate.js';
import { executePromptRecall, executePromptRecallWithFallback, recallForPrompt } from './prompt-recall.js';

const mockEmbedLocal = vi.fn();
vi.mock('../infra/local-embed.js', () => ({
  embedLocal: (text: string) => mockEmbedLocal(text),
}));

const unit = (score: number): Float32Array => {
  const v = new Float32Array(512);
  v[0] = score;
  v[1] = Math.sqrt(1 - score * score);
  return v;
};

let projectDb: Database;
let globalDb: Database;

function add(id: string, summary: string, session: string): void {
  insertMemory(
    projectDb,
    createMemory({
      id,
      content: summary,
      summary,
      memory_type: 'decision',
      scope: 'project',
      confidence: 0.9,
      priority: 8,
      source_type: 'extraction',
      source_session: session,
      source_context: '{}',
      tags: [],
      status: 'active',
      local_embedding: unit(0.9),
    }),
  );
}

const refuseAuthor: MemoryAdmission = (m) => m.source_session !== 'author';

beforeEach(() => {
  projectDb = openDatabase(':memory:');
  globalDb = openDatabase(':memory:');
  add('kept', 'pilot start date moved to November fifteenth', 'work');
  add('refused', 'pilot start date answer key November fifteenth', 'author');
  insertFact(projectDb, {
    id: 'f-refused',
    entity_id: upsertEntity(projectDb, 'pilot', 'project'),
    predicate: 'starts',
    object: 'from-the-answer-key',
    source_memory_id: 'refused',
    confidence: 0.7,
    valid_from: '2026-11-01T00:00:00.000Z',
    valid_to: null,
    created_at: '2026-11-01T00:00:00.000Z',
  });
  mockEmbedLocal.mockReset();
});

describe('composeSurface', () => {
  test('without admit, every active memory and fact is a candidate, as before', () => {
    const surface = composeSurface(projectDb, globalDb, 'main');
    expect(surface.memoryCount).toBe(2);
    expect(surface.content).toContain('answer key');
    expect(surface.content).toContain('from-the-answer-key');
  });

  test('a refused memory and the facts it sourced stay out of the surface', () => {
    const surface = composeSurface(projectDb, globalDb, 'main', { admit: refuseAuthor });
    expect(surface.memoryCount).toBe(1);
    expect(surface.content).toContain('moved to November fifteenth');
    expect(surface.content).not.toContain('answer key');
    expect(surface.content).not.toContain('from-the-answer-key');
  });

  test('an entity with one admitted and one refused fact keeps the admitted fact only', () => {
    insertFact(projectDb, {
      id: 'f-kept',
      entity_id: upsertEntity(projectDb, 'pilot', 'project'),
      predicate: 'owned-by',
      object: 'from-the-work-session',
      source_memory_id: 'kept',
      confidence: 0.7,
      valid_from: '2026-11-01T00:00:00.000Z',
      valid_to: null,
      created_at: '2026-11-01T00:00:00.000Z',
    });

    const surface = composeSurface(projectDb, globalDb, 'main', { admit: refuseAuthor });

    expect(surface.content).toContain('from-the-work-session');
    expect(surface.content).not.toContain('from-the-answer-key');
    expect(composeSurface(projectDb, globalDb, 'main').content).toContain('from-the-answer-key');
  });
});

describe('prompt recall', () => {
  const options = { prompt: 'pilot start date november fifteenth', surfaceContent: '' };

  test('the semantic path skips refused memories', async () => {
    mockEmbedLocal.mockResolvedValue(unit(1));
    const all = await executePromptRecallWithFallback(projectDb, globalDb, options);
    const admitted = await executePromptRecallWithFallback(projectDb, globalDb, { ...options, admit: refuseAuthor });
    expect(all.map((m) => m.id).sort()).toEqual(['kept', 'refused']);
    expect(admitted.map((m) => m.id)).toEqual(['kept']);
  });

  test('the degraded keyword path skips refused memories', async () => {
    mockEmbedLocal.mockRejectedValue(new Error('embedder down'));
    const admitted = await executePromptRecallWithFallback(projectDb, globalDb, { ...options, admit: refuseAuthor });
    expect(admitted.map((m) => m.id)).toEqual(['kept']);
    expect(executePromptRecall(projectDb, globalDb, { ...options, admit: refuseAuthor }).map((m) => m.id)).toEqual(['kept']);
  });

  test('recall names the path that produced its memories', async () => {
    mockEmbedLocal.mockResolvedValue(unit(1));
    expect((await recallForPrompt(projectDb, globalDb, options)).path).toBe('semantic');

    mockEmbedLocal.mockRejectedValue(new Error('embedder down'));
    const degraded = await recallForPrompt(projectDb, globalDb, options);
    expect(degraded.path).toBe('keyword-fallback');
    expect(degraded.memories.map((m) => m.id).sort()).toEqual(['kept', 'refused']);

    expect(await recallForPrompt(projectDb, globalDb, { ...options, prompt: 'hi' })).toEqual({
      path: 'not-run',
      memories: [],
    });
  });
});
