/**
 * Tests for backfill command
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDatabase, insertMemory, getMemory } from '../infra/db.ts';
import { backfill } from './backfill.ts';
import { createMemory } from '../core/types.ts';
import * as localEmbed from '../infra/local-embed.ts';

describe('backfill', () => {
  let ensureModelLoadedSpy: ReturnType<typeof vi.spyOn>;
  let embedLocalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Setup spies with default implementations
    ensureModelLoadedSpy = vi.spyOn(localEmbed, 'ensureModelLoaded');
    embedLocalSpy = vi.spyOn(localEmbed, 'embedLocal');
  });

  afterEach(() => {
    // Restore all spies to prevent leakage
    vi.restoreAllMocks();
  });

  describe('when no memories need backfilling', () => {
    it('returns zero processed and failed', async () => {
      const db = openDatabase(':memory:');

      // Insert memory with both embeddings
      const memory = createMemory({
        id: 'mem-1',
        content: 'Test content',
        summary: 'Test summary',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.8,
        priority: 5,
        source_type: 'extraction',
        source_session: 'session-1',
        source_context: JSON.stringify({ branch: 'main' }),
        embedding: new Float64Array(768),
        local_embedding: new Float32Array(384),
      });

      insertMemory(db, memory);

      const result = await backfill(db, 'test-project');

      expect(result).toEqual({
        ok: true,
        processed: 0,
        failed: 0,
        errors: [],
        method: 'local',
      });
    });

    it('returns zero when database is empty', async () => {
      const db = openDatabase(':memory:');

      const result = await backfill(db, 'test-project');

      expect(result).toEqual({
        ok: true,
        processed: 0,
        failed: 0,
        errors: [],
        method: 'local',
      });
    });
  });

  describe('local embedding', () => {
    it('embeds memories that lack a vector', async () => {
      const db = openDatabase(':memory:');

      // Setup mocks
ensureModelLoadedSpy.mockResolvedValue(true);
embedLocalSpy
        .mockResolvedValueOnce(new Float32Array(384).fill(0.3))
        .mockResolvedValueOnce(new Float32Array(384).fill(0.4));

      // Insert memories without embeddings
      const memory1 = createMemory({
        id: 'mem-1',
        content: 'Decision about architecture',
        summary: 'Chose microservices',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-1',
        source_context: JSON.stringify({ branch: 'main' }),
      });

      const memory2 = createMemory({
        id: 'mem-2',
        content: 'Pattern for error handling',
        summary: 'Use Either type',
        memory_type: 'pattern',
        scope: 'global',
        confidence: 0.85,
        priority: 7,
        source_type: 'extraction',
        source_session: 'session-1',
        source_context: JSON.stringify({ branch: 'main' }),
      });

      insertMemory(db, memory1);
      insertMemory(db, memory2);

      const result = await backfill(db, 'test-project');

      expect(result).toEqual({
        ok: true,
        processed: 2,
        failed: 0,
        errors: [],
        method: 'local',
      });

      expect(ensureModelLoadedSpy).toHaveBeenCalled();
      expect(embedLocalSpy).toHaveBeenCalledTimes(2);
      expect(embedLocalSpy).toHaveBeenCalledWith(
        '[decision] [project:test-project] Chose microservices'
      );
      expect(embedLocalSpy).toHaveBeenCalledWith(
        '[pattern] [project:test-project] Use Either type'
      );
    });

    it('handles local model unavailable', async () => {
      const db = openDatabase(':memory:');

      // Setup mocks
ensureModelLoadedSpy.mockResolvedValue(false);

      // Insert memory without embeddings
      const memory = createMemory({
        id: 'mem-1',
        content: 'Decision about architecture',
        summary: 'Chose microservices',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-1',
        source_context: JSON.stringify({ branch: 'main' }),
      });

      insertMemory(db, memory);

      const result = await backfill(db, 'test-project');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.processed).toBe(0);
        expect(result.failed).toBe(1);
        expect(result.method).toBe('local');
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('Local model failed to load');
      }
    });

    it('handles individual local embedding failures', async () => {
      const db = openDatabase(':memory:');

      // Setup mocks
ensureModelLoadedSpy.mockResolvedValue(true);
embedLocalSpy
        .mockResolvedValueOnce(new Float32Array(384).fill(0.3))
        .mockRejectedValueOnce(new Error('Model error'));

      // Insert memories
      const memory1 = createMemory({
        id: 'mem-1',
        content: 'First memory',
        summary: 'First',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-1',
        source_context: JSON.stringify({ branch: 'main' }),
      });

      const memory2 = createMemory({
        id: 'mem-2',
        content: 'Second memory',
        summary: 'Second',
        memory_type: 'pattern',
        scope: 'project',
        confidence: 0.8,
        priority: 7,
        source_type: 'extraction',
        source_session: 'session-1',
        source_context: JSON.stringify({ branch: 'main' }),
      });

      insertMemory(db, memory1);
      insertMemory(db, memory2);

      const result = await backfill(db, 'test-project');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.processed).toBe(1);
        expect(result.failed).toBe(1);
        expect(result.method).toBe('local');
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('Failed to embed/update memory');
      }
    });
  });

  describe('code memories (FR-053)', () => {
    it('never embeds code memories', async () => {
      const db = openDatabase(':memory:');

      ensureModelLoadedSpy.mockResolvedValue(true);
      embedLocalSpy.mockResolvedValue(new Float32Array(384).fill(0.1));

      // Code memory: embedding null BY DESIGN (index-code pairing)
      const codeMemory = createMemory({
        id: 'mem-code',
        content: 'export function foo() { return 42; }',
        summary: 'export function foo() { return 42; }',
        memory_type: 'code',
        scope: 'project',
        confidence: 1.0,
        priority: 5,
        source_type: 'code_index',
        source_session: 'session-1',
        source_context: JSON.stringify({ source: 'code_index', file_path: 'src/foo.ts' }),
      });

      // Prose memory: should still be backfilled
      const proseMemory = createMemory({
        id: 'mem-prose',
        content: 'foo returns the answer',
        summary: 'foo returns the answer',
        memory_type: 'code_description',
        scope: 'project',
        confidence: 0.9,
        priority: 5,
        source_type: 'code_index',
        source_session: 'session-1',
        source_context: JSON.stringify({ source: 'code_index', file_path: 'src/foo.ts' }),
      });

      insertMemory(db, codeMemory);
      insertMemory(db, proseMemory);

      const result = await backfill(db, 'test-project');

      // Only the prose memory is embedded; the code memory never is.
      expect(result).toEqual({
        ok: true,
        processed: 1,
        failed: 0,
        errors: [],
        method: 'local',
      });

      // The embedded text is the prose summary only — never raw code
      expect(embedLocalSpy).toHaveBeenCalledTimes(1);
      expect(embedLocalSpy).toHaveBeenCalledWith(
        '[code_description] [project:test-project] foo returns the answer'
      );
    });
  });

  describe('edge cases', () => {
    it('embeds only the memories missing a vector', async () => {
      const db = openDatabase(':memory:');

      // Setup mocks
      ensureModelLoadedSpy.mockResolvedValue(true);
      embedLocalSpy.mockResolvedValue(new Float32Array(384).fill(0.1));

      // Insert memories with different embedding states
      const memoryNoEmbeddings = createMemory({
        id: 'mem-no-embed',
        content: 'No embeddings',
        summary: 'No embeddings',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-1',
        source_context: JSON.stringify({ branch: 'main' }),
      });

      const memoryWithLocal = createMemory({
        id: 'mem-with-local',
        content: 'Has local embedding',
        summary: 'Has local',
        memory_type: 'gotcha',
        scope: 'project',
        confidence: 0.7,
        priority: 6,
        source_type: 'extraction',
        source_session: 'session-1',
        source_context: JSON.stringify({ branch: 'main' }),
        local_embedding: new Float32Array(384),
      });

      insertMemory(db, memoryNoEmbeddings);
      insertMemory(db, memoryWithLocal);

      const result = await backfill(db, 'test-project');

      // Only mem-no-embed lacks a vector; mem-with-local already has one.
      expect(result).toEqual({
        ok: true,
        processed: 1,
        failed: 0,
        errors: [],
        method: 'local',
      });

      expect(embedLocalSpy).toHaveBeenCalledTimes(1);
    });

    it('handles unexpected errors gracefully', async () => {
      const db = openDatabase(':memory:');

      // Insert memory to ensure the embedding step is reached
      const memory = createMemory({
        id: 'mem-1',
        content: 'Test content',
        summary: 'Test summary',
        memory_type: 'decision',
        scope: 'project',
        confidence: 0.9,
        priority: 8,
        source_type: 'extraction',
        source_session: 'session-1',
        source_context: JSON.stringify({ branch: 'main' }),
      });
      insertMemory(db, memory);

      // Setup mocks - simulate catastrophic failure
      ensureModelLoadedSpy.mockImplementation(() => {
        throw new Error('Unexpected error');
      });

      const result = await backfill(db, 'test-project');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Backfill failed');
      }
    });
  });
});
