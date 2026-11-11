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
import { getActiveMemoriesNeedingEmbedding, updateMemory } from '../infra/db.js';
import { embedLocal, ensureModelLoaded } from '../infra/local-embed.js';


/**
 * Discriminated union for backfill result
 */
export type BackfillResult =
  | { ok: true; processed: number; failed: number; errors: readonly string[]; method: 'local' }
  | { ok: false; error: string };

/**
 * Functional Core: build embedding texts with metadata prefix
 */
function buildEmbeddingTexts(
  memories: readonly Memory[],
  projectName: string
): readonly string[] {
  return memories.map((m) => buildEmbeddingText(m, projectName));
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

  // Ensure model loaded. `ensureModelLoaded` returns a bare boolean, so the
  // reason is only recoverable by asking the embedder to embed something —
  // otherwise the real cause is lost and every failure reads the same. That
  // mattered in practice: a 32-bit libstdc++ on LD_LIBRARY_PATH surfaced as
  // "Local model failed to load" with no hint of "wrong ELF class".
  const modelReady = await ensureModelLoaded();
  if (!modelReady) {
    let reason = 'unknown cause';
    try {
      await embedLocal('probe');
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
    errors.push(`Local model failed to load: ${reason}`);
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
 * 1. Query DB for active memories recall cannot see: no vector, or a vector
 *    from another model (getActiveMemoriesNeedingEmbedding). `code` memories
 *    are excluded by design (FR-053).
 * 2. Embed them with the local static model, update local_embedding
 * 3. Return summary: { processed, failed, method }
 *
 * @param db - Database instance (project or global)
 * @param projectName - Project name for embedding metadata prefix
 * @returns Result with stats or error
 */
export async function backfill(
  db: Database,
  projectName: string
): Promise<BackfillResult> {
  try {
    // Imperative Shell: fetch data (I/O)

    let totalProcessed = 0;
    let totalFailed = 0;
    const allErrors: string[] = [];
    // Embed every memory recall cannot see. These are consumed by recall and
    // prompt-recall, which is the whole point of storing them; dedup and
    // consolidation deliberately do NOT use cosine (see LOCAL_COSINE_CALIBRATED),
    // but that no longer makes the vectors unread.
    const localUnembedded = getActiveMemoriesNeedingEmbedding(db);
    if (localUnembedded.length > 0) {
      const texts = buildEmbeddingTexts(localUnembedded, projectName);
      process.stderr.write(`[cortex:backfill] INFO: Backfilling local embeddings for ${localUnembedded.length} memories\n`);
      const { processed, failed, errors } = await backfillLocal(db, localUnembedded, texts);
      totalProcessed += processed;
      totalFailed += failed;
      allErrors.push(...errors);
    }

    return { ok: true, processed: totalProcessed, failed: totalFailed, errors: allErrors, method: 'local' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Backfill failed: ${message}` };
  }
}
