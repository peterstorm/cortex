/**
 * Extract command: Session-end memory extraction pipeline
 *
 * Satisfies:
 * - FR-001: Extract memories automatically at session end
 * - FR-004: Track cursor position via extractions table
 * - FR-009: Complete extraction within 30 seconds (p95)
 * - FR-010: Handle extraction errors without blocking session closure
 * - FR-011: Log extraction errors to inspect later
 * - FR-012: Support resumable extraction if transcript >100KB
 *
 * Imperative shell - orchestrates I/O and pure functions:
 * 1. Read transcript file
 * 2. Get extraction checkpoint
 * 3. Truncate if needed (pure)
 * 4. Get git context
 * 5. Build extraction prompt (pure)
 * 6. Call Claude CLI
 * 7. Parse response (pure)
 * 8. For each candidate:
 *    - Insert memory
 *    - Compute similarity + create edges
 * 9. Save checkpoint
 * 10. Run lifecycle
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { HookInput, Memory, MemoryCandidate } from '../core/types.js';
import { createMemory } from '../core/types.js';
import {
  truncateTranscript,
  buildExtractionPrompt,
  parseExtractionResponse,
  buildEmbeddingText,
} from '../core/extraction.js';
import {
  tokenize,
  hybridSimilarity,
  classifySimilarity,
} from '../core/similarity.js';
import { embedLocal, ensureModelLoaded } from '../infra/local-embed.ts';
import {
  insertMemory,
  getExtractionCheckpoint,
  saveExtractionCheckpoint,
  getActiveMemories,
  insertEdge,
} from '../infra/db.js';
import { extractMemories, isClaudeLlmAvailable } from '../infra/claude-llm.js';
import { getGitContext } from '../infra/git-context.js';
import { runLifecycle } from './lifecycle.js';
import { invalidateSurfaceCache } from './generate.js';
import { DEDUP_SIMILARITY_THRESHOLD } from '../config.js';

// ============================================================================
// RESULT TYPES
// ============================================================================

export interface ExtractionResult {
  readonly success: boolean;
  readonly extracted_count: number;
  readonly edge_count: number;
  readonly cursor_position: number;
  readonly dedup_skipped?: number;
  readonly error?: string;
}

// ============================================================================
// IMPERATIVE SHELL - I/O ORCHESTRATION
// ============================================================================

/**
 * Execute extraction command
 * I/O boundary - orchestrates pure functions with external operations
 *
 * NEVER throws - all errors caught and returned in result for FR-010
 *
 * @param input - Hook input from stdin
 * @param projectDb - Project database instance
 * @returns Extraction result
 */
export async function executeExtract(
  input: HookInput,
  projectDb: Database
): Promise<ExtractionResult> {
  try {
    // Validate Claude CLI availability
    if (!isClaudeLlmAvailable()) {
      logInfo('Claude CLI not found on PATH — extraction skipped');
      return {
        success: false,
        extracted_count: 0,
        edge_count: 0,
        cursor_position: 0,
        error: 'Claude CLI not available',
      };
    }

    // I/O: Read transcript file
    let transcriptContent: string;
    try {
      transcriptContent = readFileSync(input.transcript_path, 'utf-8');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Failed to read transcript: ${message}`);
      return {
        success: false,
        extracted_count: 0,
        edge_count: 0,
        cursor_position: 0,
        error: `Failed to read transcript: ${message}`,
      };
    }

    // I/O: Get extraction checkpoint for resumable extraction (FR-004)
    const checkpoint = getExtractionCheckpoint(projectDb, input.session_id);
    const cursorStart = checkpoint?.cursor_position ?? 0;

    // Pure: Truncate transcript if >100KB (FR-012)
    const { truncated, newCursor } = truncateTranscript(
      transcriptContent,
      100_000,
      cursorStart
    );

    // Skip if no new content
    if (truncated.trim() === '') {
      return {
        success: true,
        extracted_count: 0,
        edge_count: 0,
        cursor_position: newCursor,
      };
    }

    // I/O: Get git context
    const gitContext = getGitContext(input.cwd);

    // Pure: Derive project name from cwd
    const projectName = basename(input.cwd);

    // Pure: Build extraction prompt
    const prompt = buildExtractionPrompt(truncated, gitContext, projectName);

    // I/O: Call Claude CLI for extraction (async)
    logInfo('Using Claude for memory extraction');
    let response: string;
    try {
      response = await extractMemories(prompt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Claude extraction failed: ${message}`);
      // Save checkpoint at newCursor to advance past failed chunk (no retry)
      saveExtractionCheckpoint(projectDb, {
        session_id: input.session_id,
        cursor_position: newCursor,
        extracted_at: new Date().toISOString(),
      });
      return {
        success: false,
        extracted_count: 0,
        edge_count: 0,
        cursor_position: newCursor,
        error: `Claude extraction failed: ${message}`,
      };
    }

    // Pure: Parse extraction response
    const candidates = parseExtractionResponse(response);

    if (candidates.length === 0) {
      // No memories extracted - still save checkpoint
      saveExtractionCheckpoint(projectDb, {
        session_id: input.session_id,
        cursor_position: newCursor,
        extracted_at: new Date().toISOString(),
      });

      return {
        success: true,
        extracted_count: 0,
        edge_count: 0,
        cursor_position: newCursor,
      };
    }

    // I/O: Fetch existing memories once — used for dedup and edge computation
    const existingMemories = getActiveMemories(projectDb);

    // I/O: Generate local embeddings for candidates (async, for hybrid dedup)
    // Non-fatal: if embedding fails, dedup falls back to Jaccard-only
    const candidateEmbeddings = await generateCandidateEmbeddings(candidates, projectName);

    // Pure: Dedup candidates against existing memories (hybrid Jaccard + cosine)
    const { kept: dedupedCandidates, skipped: dedupSkipped } =
      deduplicateCandidates(candidates, existingMemories, DEDUP_SIMILARITY_THRESHOLD, candidateEmbeddings);

    if (dedupSkipped > 0) {
      logInfo(`Dedup: skipped ${dedupSkipped} near-duplicate candidates (hybrid)`);
    }

    // Process each candidate — individual insert failures are non-fatal.
    // Intentional: we continue inserting remaining candidates even if one fails,
    // because partial extraction is better than none (FR-010).
    const insertedMemories: Memory[] = [];
    for (const candidate of dedupedCandidates) {
      try {
        const candidateIndex = candidates.indexOf(candidate);
        const localEmbedding = candidateEmbeddings.get(candidateIndex) ?? null;
        const memory = candidateToMemory(candidate, input.session_id, gitContext, localEmbedding);
        insertMemory(projectDb, memory);
        insertedMemories.push(memory);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`Failed to insert memory: ${message}`);
      }
    }

    // Compute similarity and create edges (FR-061)
    let edgeCount = 0;
    if (insertedMemories.length > 0) {
      try {
        edgeCount = computeSimilarityAndCreateEdges(
          projectDb,
          insertedMemories,
          existingMemories
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`Failed to compute similarity: ${message}`);
        // Non-fatal - continue
      }
    }

    // I/O: Save checkpoint (FR-004)
    saveExtractionCheckpoint(projectDb, {
      session_id: input.session_id,
      cursor_position: newCursor,
      extracted_at: new Date().toISOString(),
    });

    // I/O: Run lifecycle (decay, archive, prune)
    try {
      runLifecycle(projectDb);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Lifecycle failed: ${message}`);
      // Non-fatal - continue
    }

    // I/O: Invalidate surface cache since new memories were extracted (FR-022)
    if (insertedMemories.length > 0) {
      try {
        invalidateSurfaceCache(input.cwd);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`Cache invalidation failed: ${message}`);
        // Non-fatal - continue
      }
    }

    return {
      success: true,
      extracted_count: insertedMemories.length,
      edge_count: edgeCount,
      cursor_position: newCursor,
      dedup_skipped: dedupSkipped > 0 ? dedupSkipped : undefined,
    };
  } catch (err) {
    // Catch-all for unexpected errors (FR-010, FR-011)
    const message = err instanceof Error ? err.message : String(err);
    logError(`Unexpected extraction error: ${message}`);
    return {
      success: false,
      extracted_count: 0,
      edge_count: 0,
      cursor_position: 0,
      error: `Unexpected error: ${message}`,
    };
  }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Convert memory candidate to full Memory object
 * Pure function - builds domain object
 */
function candidateToMemory(
  candidate: MemoryCandidate,
  sessionId: string,
  gitContext: { branch: string; recent_commits: readonly string[]; changed_files: readonly string[] },
  localEmbedding: Float32Array | null = null
): Memory {
  const id = randomUUID();
  const now = new Date().toISOString();

  const sourceContext = JSON.stringify({
    branch: gitContext.branch,
    commits: gitContext.recent_commits.slice(0, 3), // Top 3 commits
    files: gitContext.changed_files.slice(0, 10),   // Top 10 files
  });

  return createMemory({
    id,
    content: candidate.content,
    summary: candidate.summary,
    memory_type: candidate.memory_type,
    scope: candidate.scope,
    confidence: candidate.confidence,
    priority: candidate.priority,
    pinned: false,
    source_type: 'extraction',
    source_session: sessionId,
    source_context: sourceContext,
    tags: candidate.tags,
    embedding: null, // Queue Gemini for backfill
    local_embedding: localEmbedding, // Store if generated (saves backfill step)
    access_count: 0,
    last_accessed_at: now,
    created_at: now,
    updated_at: now,
    status: 'active',
  });
}

/**
 * Deduplicate extraction candidates against existing memories and each other.
 * Pure function — uses hybrid Jaccard+cosine similarity to filter near-duplicates.
 *
 * @param candidates - Parsed extraction candidates
 * @param existingMemories - All active memories from DB
 * @param threshold - Similarity threshold for dedup (default DEDUP_SIMILARITY_THRESHOLD)
 * @param candidateEmbeddings - Map of candidate index → local embedding (optional)
 * @returns Kept candidates and count of skipped duplicates
 */
export function deduplicateCandidates(
  candidates: readonly MemoryCandidate[],
  existingMemories: readonly Memory[],
  threshold: number = DEDUP_SIMILARITY_THRESHOLD,
  candidateEmbeddings: Map<number, Float32Array> = new Map()
): { kept: MemoryCandidate[]; skipped: number } {
  // Pre-tokenize existing memories once
  const existingTokenSets = existingMemories.map(
    (m) => tokenize(`${m.summary} ${m.content}`)
  );
  // Pre-extract existing embeddings (prefer local to match candidate dimensions)
  const existingEmbeddings = existingMemories.map(
    (m) => m.local_embedding ?? m.embedding ?? null
  );

  const kept: MemoryCandidate[] = [];
  const keptTokenSets: ReadonlySet<string>[] = [];
  const keptEmbeddings: (Float32Array | null)[] = [];
  let skipped = 0;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const candidateTokens = tokenize(`${candidate.summary} ${candidate.content}`);
    const candidateEmbedding = candidateEmbeddings.get(i) ?? null;

    // Check against existing memories (hybrid)
    let isDuplicate = false;
    for (let j = 0; j < existingTokenSets.length; j++) {
      const score = hybridSimilarity(
        candidateTokens,
        existingTokenSets[j],
        candidateEmbedding,
        existingEmbeddings[j]
      );
      if (score >= threshold) {
        isDuplicate = true;
        break;
      }
    }

    // Check against already-kept candidates in this batch (intra-batch dedup)
    if (!isDuplicate) {
      for (let j = 0; j < keptTokenSets.length; j++) {
        const score = hybridSimilarity(
          candidateTokens,
          keptTokenSets[j],
          candidateEmbedding,
          keptEmbeddings[j]
        );
        if (score >= threshold) {
          isDuplicate = true;
          break;
        }
      }
    }

    if (isDuplicate) {
      skipped++;
    } else {
      kept.push(candidate);
      keptTokenSets.push(candidateTokens);
      keptEmbeddings.push(candidateEmbedding);
    }
  }

  return { kept, skipped };
}

/**
 * Compute similarity between new memories and existing, create edges
 * I/O boundary - inserts edges into DB
 *
 * Uses Jaccard pre-filter to avoid unnecessary comparisons (FR-061)
 *
 * @param db - Database instance
 * @param newMemories - Newly inserted memories
 * @param existingMemories - Pre-fetched active memories (avoids redundant DB call)
 * @returns Number of edges created
 */
function computeSimilarityAndCreateEdges(
  db: Database,
  newMemories: readonly Memory[],
  existingMemories: readonly Memory[]
): number {
  let edgeCount = 0;

  for (const newMem of newMemories) {
    const newTokens = tokenize(`${newMem.summary} ${newMem.content}`);
    const newEmbedding = newMem.local_embedding ?? newMem.embedding;

    for (const existingMem of existingMemories) {
      if (newMem.id === existingMem.id) continue;

      const existingTokens = tokenize(`${existingMem.summary} ${existingMem.content}`);
      const existingEmbedding = existingMem.local_embedding ?? existingMem.embedding;

      const score = hybridSimilarity(newTokens, existingTokens, newEmbedding, existingEmbedding);

      if (score < 0.1) continue;

      const action = classifySimilarity(score);

      if (action.action === 'relate') {
        try {
          insertEdge(db, {
            source_id: newMem.id,
            target_id: existingMem.id,
            relation_type: 'relates_to',
            strength: action.strength,
            bidirectional: true,
            status: 'active',
          });
          edgeCount++;
        } catch {
          // Duplicate edge constraint - skip silently
        }
      } else if (action.action === 'suggest') {
        try {
          insertEdge(db, {
            source_id: newMem.id,
            target_id: existingMem.id,
            relation_type: 'relates_to',
            strength: action.strength,
            bidirectional: true,
            status: 'suggested',
          });
          edgeCount++;
        } catch {
          // Duplicate edge constraint - skip silently
        }
      } else if (action.action === 'consolidate') {
        try {
          insertEdge(db, {
            source_id: newMem.id,
            target_id: existingMem.id,
            relation_type: 'relates_to',
            strength: score,
            bidirectional: true,
            status: 'active',
          });
          edgeCount++;
        } catch {
          // Duplicate edge constraint - skip silently
        }
      }
    }
  }

  return edgeCount;
}

/**
 * Generate local embeddings for extraction candidates.
 * I/O boundary — calls async local embedding model.
 * Returns Map<candidateIndex, Float32Array> for successfully embedded candidates.
 * Non-fatal: returns empty map if model unavailable.
 */
async function generateCandidateEmbeddings(
  candidates: readonly MemoryCandidate[],
  projectName: string
): Promise<Map<number, Float32Array>> {
  const embeddings = new Map<number, Float32Array>();

  try {
    const modelReady = await ensureModelLoaded();
    if (!modelReady) {
      logInfo('Local embedding model unavailable — falling back to Jaccard-only dedup');
      return embeddings;
    }
  } catch {
    logInfo('Local embedding model failed to load — falling back to Jaccard-only dedup');
    return embeddings;
  }

  for (let i = 0; i < candidates.length; i++) {
    try {
      const text = buildEmbeddingText(candidates[i], projectName);
      const embedding = await embedLocal(text);
      embeddings.set(i, embedding);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Failed to embed candidate ${i}: ${message}`);
      // Non-fatal: this candidate will use Jaccard-only
    }
  }

  return embeddings;
}

/**
 * Log error to stderr (FR-011)
 * Non-blocking error reporting
 */
function logError(message: string): void {
  process.stderr.write(`[cortex:extract] ERROR: ${message}\n`);
}

/**
 * Log info to stderr
 */
function logInfo(message: string): void {
  process.stderr.write(`[cortex:extract] INFO: ${message}\n`);
}
