/**
 * Backfill command: process queued embeddings
 *
 * Implements FR-046: System MUST backfill missing embeddings in background at next session start
 * Implements NFR-017: System MUST process queued operations at next session when API available
 *
 * Functional Core + Imperative Shell pattern:
 * - Shell (this file): orchestrates I/O, calls pure functions
 * - Core: buildEmbeddingText (pure), DB queries (I/O boundary)
 */

import { Database } from 'bun:sqlite';
import type { Memory } from '../core/types.js';
import { buildEmbeddingText } from '../core/extraction.js';
import { getActiveMemories, updateMemory } from '../infra/db.js';
import { embedTexts, isGeminiAvailable, MAX_BATCH_SIZE } from '../infra/gemini-embed.ts';
import { embedLocal, ensureModelLoaded } from '../infra/local-embed.ts';

/**
 * Discriminated union for backfill result
 */
export type BackfillResult =
  | { ok: true; processed: number; failed: number; errors: readonly string[]; method: 'gemini' | 'local' }
  | { ok: false; error: string };

/**
 * Functional Core: filter memories missing Gemini embedding
 */
function filterGeminiUnembedded(memories: readonly Memory[]): readonly Memory[] {
  return memories.filter((m) => m.embedding === null);
}

/**
 * Functional Core: filter memories missing local embedding
 */
function filterLocalUnembedded(memories: readonly Memory[]): readonly Memory[] {
  return memories.filter((m) => m.local_embedding === null);
}

/**
 * Functional Core: build embedding texts with metadata prefix
 * Only passes fields actually used by buildEmbeddingText (memory_type, summary)
 */
function buildEmbeddingTexts(
  memories: readonly Memory[],
  projectName: string
): readonly string[] {
  return memories.map((m) =>
    buildEmbeddingText(
      {
        memory_type: m.memory_type,
        summary: m.summary,
      } as Pick<Memory, 'memory_type' | 'summary'>,
      projectName
    )
  );
}

/**
 * Functional Core: batch array into chunks
 */
function batchArray<T>(arr: readonly T[], size: number): readonly T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    batches.push(arr.slice(i, i + size));
  }
  return batches;
}

/**
 * Imperative Shell: Backfill missing embeddings via Gemini API
 */
async function backfillGemini(
  db: Database,
  memories: readonly Memory[],
  texts: readonly string[],
  apiKey: string
): Promise<{ processed: number; failed: number; errors: readonly string[] }> {
  let processed = 0;
  let failed = 0;
  const errors: string[] = [];

  // Batch into chunks (FR-046: batch embed)
  const memoryBatches = batchArray(memories, MAX_BATCH_SIZE);
  const textBatches = batchArray(texts, MAX_BATCH_SIZE);

  for (let i = 0; i < memoryBatches.length; i++) {
    const memoryBatch = memoryBatches[i];
    const textBatch = textBatches[i];

    try {
      // Fetch embeddings from Gemini
      const embeddings = await embedTexts(textBatch, apiKey);

      // Update DB with embeddings
      for (let j = 0; j < memoryBatch.length; j++) {
        const memory = memoryBatch[j];
        const embedding = embeddings[j];

        try {
          updateMemory(db, memory.id, { embedding: embedding });
          processed++;
        } catch (err) {
          // Individual update failure
          failed++;
          const errMsg = err instanceof Error ? err.message : String(err);
          errors.push(`Failed to update memory ${memory.id}: ${errMsg}`);
        }
      }
    } catch (err) {
      // Batch embedding failure
      failed += memoryBatch.length;
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to embed batch of ${memoryBatch.length} memories: ${errMsg}`);
    }
  }

  return { processed, failed, errors };
}

/**
 * Imperative Shell: Backfill missing embeddings via local model
 */
async function backfillLocal(
  db: Database,
  memories: readonly Memory[],
  texts: readonly string[]
): Promise<{ processed: number; failed: number; errors: readonly string[] }> {
  let processed = 0;
  let failed = 0;
  const errors: string[] = [];

  // Ensure model loaded
  const modelReady = await ensureModelLoaded();
  if (!modelReady) {
    errors.push('Local model failed to load');
    return { processed: 0, failed: memories.length, errors };
  }

  // Process individually (local model doesn't batch)
  for (let i = 0; i < memories.length; i++) {
    const memory = memories[i];
    const text = texts[i];

    try {
      const embedding = await embedLocal(text);
      updateMemory(db, memory.id, { local_embedding: embedding });
      processed++;
    } catch (err) {
      failed++;
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to embed/update memory ${memory.id}: ${errMsg}`);
    }
  }

  return { processed, failed, errors };
}

/**
 * Backfill missing embeddings for memories.
 *
 * Strategy:
 * 1. Query DB for memories with null embeddings
 * 2. If Gemini available: batch embed via Gemini, update embedding
 * 3. If Gemini unavailable: fallback to local, update local_embedding
 * 4. Return summary: { processed, failed, method }
 *
 * @param db - Database instance (project or global)
 * @param projectName - Project name for embedding metadata prefix
 * @param geminiApiKey - Gemini API key (optional)
 * @returns Result with stats or error
 */
export async function backfill(
  db: Database,
  projectName: string,
  geminiApiKey?: string
): Promise<BackfillResult> {
  try {
    // Imperative Shell: fetch data (I/O)
    const allMemories = getActiveMemories(db);

    // Imperative Shell: choose method and use appropriate filter
    if (isGeminiAvailable(geminiApiKey)) {
      const unembedded = filterGeminiUnembedded(allMemories);
      if (unembedded.length === 0) {
        return { ok: true, processed: 0, failed: 0, errors: [], method: 'gemini' };
      }
      const texts = buildEmbeddingTexts(unembedded, projectName);
      process.stderr.write(`[cortex:backfill] INFO: Using Gemini for ${unembedded.length} embeddings\n`);
      const { processed, failed, errors } = await backfillGemini(
        db,
        unembedded,
        texts,
        geminiApiKey!
      );
      return { ok: true, processed, failed, errors, method: 'gemini' };
    } else {
      const unembedded = filterLocalUnembedded(allMemories);
      if (unembedded.length === 0) {
        return { ok: true, processed: 0, failed: 0, errors: [], method: 'local' };
      }
      const texts = buildEmbeddingTexts(unembedded, projectName);
      process.stderr.write(`[cortex:backfill] INFO: Gemini unavailable — falling back to local model for ${unembedded.length} embeddings\n`);
      const { processed, failed, errors } = await backfillLocal(db, unembedded, texts);
      return { ok: true, processed, failed, errors, method: 'local' };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Backfill failed: ${message}` };
  }
}
