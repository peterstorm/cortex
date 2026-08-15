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
import { LOCAL_COSINE_CALIBRATED, LOCAL_EMBED_MODEL } from '../config.js';

/**
 * Discriminated union for backfill result
 */
export type BackfillResult =
  | { ok: true; processed: number; failed: number; errors: readonly string[]; method: 'gemini' | 'local' }
  | { ok: false; error: string };

/**
 * Functional Core: filter memories missing Gemini embedding
 *
 * FR-053: `code` memories are created with embedding:null BY DESIGN
 * (raw source code is retrieved via its paired code_description, and its
 * summary is just the first 200 chars of raw code) — never embed them.
 */
function filterGeminiUnembedded(memories: readonly Memory[]): readonly Memory[] {
  return memories.filter((m) => m.embedding === null && m.memory_type !== 'code');
}

/**
 * Functional Core: filter memories missing local embedding
 * FR-053: `code` memories are never embedded (see filterGeminiUnembedded).
 */
function filterLocalUnembedded(memories: readonly Memory[]): readonly Memory[] {
  return memories.filter((m) => m.local_embedding === null && m.memory_type !== 'code');
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
 * 3. If local cosine is enabled: embed locally, update local_embedding
 * 4. Return summary: { processed, failed, method }
 *
 * @param db - Database instance (project or global)
 * @param projectName - Project name for embedding metadata prefix
 * @param geminiApiKey - Gemini API key (optional)
 * @param localCosineEnabled - Whether local embeddings have any consumer.
 *   Defaults to LOCAL_COSINE_CALIBRATED. When false, step 3 is skipped
 *   entirely: dedup, edge creation and consolidation all fall back to Jaccard,
 *   so the vectors would be written and never read. Exposed as a parameter so
 *   both branches stay under test regardless of the configured model.
 * @returns Result with stats or error
 */
export async function backfill(
  db: Database,
  projectName: string,
  geminiApiKey?: string,
  localCosineEnabled: boolean = LOCAL_COSINE_CALIBRATED
): Promise<BackfillResult> {
  try {
    // Imperative Shell: fetch data (I/O)
    const allMemories = getActiveMemories(db);

    let totalProcessed = 0;
    let totalFailed = 0;
    const allErrors: string[] = [];
    let primaryMethod: 'gemini' | 'local' = 'local';

    // Step 1: Backfill Gemini embeddings if API available
    if (isGeminiAvailable(geminiApiKey)) {
      primaryMethod = 'gemini';
      const geminiUnembedded = filterGeminiUnembedded(allMemories);
      if (geminiUnembedded.length > 0) {
        const texts = buildEmbeddingTexts(geminiUnembedded, projectName);
        process.stderr.write(`[cortex:backfill] INFO: Using Gemini for ${geminiUnembedded.length} embeddings\n`);
        const { processed, failed, errors } = await backfillGemini(
          db,
          geminiUnembedded,
          texts,
          geminiApiKey!
        );
        totalProcessed += processed;
        totalFailed += failed;
        allErrors.push(...errors);
      }
    }

    // Step 2: backfill local embeddings, but only while something reads them.
    //
    // `local_embedding` exists for exactly one purpose in this codebase: being
    // a same-dimension partner for cosine comparison during dedup, edge
    // creation, and consolidation. Recall does not use it — both recall paths
    // require Gemini to be available and embed the query via Gemini, so their
    // 'local' branch is unreachable.
    //
    // When LOCAL_COSINE_CALIBRATED is false those three consumers all fall back
    // to Jaccard, which leaves this step computing vectors nothing will read —
    // a model load (~12s cold, ~1.6 GB resident) plus ~130 ms per memory, per
    // backfill. So production and consumption are governed by the same switch:
    // it is not possible to have local vectors with no reader, or a reader with
    // no vectors.
    //
    // Consequence to be aware of when re-enabling: opening the gate requires a
    // backfill run before cosine comparison has anything to compare.
    const localUnembedded = filterLocalUnembedded(allMemories);
    if (!localCosineEnabled) {
      if (localUnembedded.length > 0) {
        process.stderr.write(
          `[cortex:backfill] INFO: Skipping local embeddings for ${localUnembedded.length} memories — local cosine is disabled (${LOCAL_EMBED_MODEL} is not the calibrated model), so nothing would read them\n`
        );
      }
    } else if (localUnembedded.length > 0) {
      const texts = buildEmbeddingTexts(localUnembedded, projectName);
      process.stderr.write(`[cortex:backfill] INFO: Backfilling local embeddings for ${localUnembedded.length} memories\n`);
      const { processed, failed, errors } = await backfillLocal(db, localUnembedded, texts);
      totalProcessed += processed;
      totalFailed += failed;
      allErrors.push(...errors);
    }

    return { ok: true, processed: totalProcessed, failed: totalFailed, errors: allErrors, method: primaryMethod };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Backfill failed: ${message}` };
  }
}
