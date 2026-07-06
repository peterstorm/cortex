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
import { basename, join } from 'node:path';
import type { Database } from 'bun:sqlite';
import type { GitContext, HookInput, Memory, MemoryCandidate } from '../core/types.js';
import { createMemory } from '../core/types.js';
import {
  truncateTranscript,
  buildExtractionPrompt,
  parseExtractionResponse,
  buildEmbeddingText,
} from '../core/extraction.js';
import type { EntityFactCandidate, EntityProfile } from '../core/entities.js';
import {
  tokenize,
  hybridSimilarity,
  hybridSimilarityScored,
  classifySimilarity,
} from '../core/similarity.js';
import { embedLocal, ensureModelLoaded } from '../infra/local-embed.ts';
import {
  insertMemory,
  updateMemory,
  getMemory,
  getExtractionCheckpoint,
  saveExtractionCheckpoint,
  getActiveMemories,
  insertEdge,
  upsertEntity,
  insertFact,
  getCurrentFacts,
  supersedeFact,
  getAllEntities,
} from '../infra/db.js';
import { extractMemories, isClaudeLlmAvailable } from '../infra/claude-llm.js';
import { getGitContext } from '../infra/git-context.js';
import { acquireLock, releaseLock } from '../infra/lock.js';
import { runLifecycle } from './lifecycle.js';
import { invalidateSurfaceCache } from './generate.js';
import {
  DEDUP_SIMILARITY_THRESHOLD,
  MERGE_CEILING_THRESHOLD,
  INTRA_BATCH_DEDUP_THRESHOLD,
  EXTRACT_MAX_CHUNKS_PER_RUN,
  MAX_EDGES_PER_MEMORY,
  getLockDir,
} from '../config.js';

// ============================================================================
// RESULT TYPES
// ============================================================================

export interface FactConflict {
  readonly entityName: string;
  readonly predicate: string;
  readonly oldValue: string;
  readonly newValue: string;
}

export interface ExtractionResult {
  readonly success: boolean;
  readonly extracted_count: number;
  readonly edge_count: number;
  readonly cursor_position: number;
  readonly dedup_skipped?: number;
  readonly dedup_merged?: number;
  readonly entity_conflicts?: readonly FactConflict[];
  /** True when this run was skipped because another extraction holds the lock */
  readonly skipped?: boolean;
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
  projectDb: Database,
  globalDb: Database | null = null
): Promise<ExtractionResult> {
  // Concurrency guard: extraction runs detached on SessionEnd with no other
  // coordination — two overlapping runs would snapshot active memories at
  // the same time and double-insert candidates. Same per-project PID-lock
  // pattern as semantic-edges.
  const lockFile = join(getLockDir(input.cwd), 'extract.lock');
  if (!acquireLock(lockFile)) {
    logInfo('Another extraction is already running for this project — skipping');
    return {
      success: true,
      extracted_count: 0,
      edge_count: 0,
      cursor_position: 0,
      skipped: true,
      error: 'skipped: another extraction running',
    };
  }

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
    let cursor = checkpoint?.cursor_position ?? 0;

    // Checkpoint invalidation: if the transcript file was rewritten shorter
    // (compaction/resume), a stale cursor points past EOF and extraction
    // stays dead forever. Reset to 0 — dedup absorbs any re-extraction.
    if (
      cursor > transcriptContent.length ||
      (checkpoint?.transcript_length != null &&
        checkpoint.transcript_length > transcriptContent.length)
    ) {
      logInfo(
        `Transcript shrank (cursor=${cursor}, stored_length=${checkpoint?.transcript_length ?? 'n/a'}, current_length=${transcriptContent.length}) — resetting cursor to 0`
      );
      cursor = 0;
    }

    // I/O: chunk-invariant context, fetched once per run
    const gitContext = getGitContext(input.cwd);
    const projectName = basename(input.cwd);
    const knownEntityProfiles = buildKnownEntityProfiles(projectDb);
    if (knownEntityProfiles.length > 0) {
      logInfo(`Injecting ${knownEntityProfiles.length} known entities into extraction prompt`);
    }

    // Aggregate stats across chunks
    let totalInserted = 0;
    let edgeCount = 0;
    let dedupSkipped = 0;
    let dedupMergedCount = 0;
    const entityConflicts: FactConflict[] = [];

    // Per-chunk failure result: cursor stays at the failed chunk's start so
    // the next run retries it; progress from earlier chunks in this run is
    // already checkpointed.
    const chunkFailure = (error: string): ExtractionResult => ({
      success: false,
      extracted_count: totalInserted,
      edge_count: edgeCount,
      cursor_position: cursor,
      dedup_skipped: dedupSkipped > 0 ? dedupSkipped : undefined,
      dedup_merged: dedupMergedCount > 0 ? dedupMergedCount : undefined,
      entity_conflicts: entityConflicts.length > 0 ? entityConflicts : undefined,
      error,
    });

    // FR-012: process 100KB chunks until the transcript is drained. The hook
    // fires once per session end, so a single chunk per run would leave most
    // of a long session unextracted. Capped to bound worst-case runtime.
    for (
      let chunkIndex = 0;
      chunkIndex < EXTRACT_MAX_CHUNKS_PER_RUN && cursor < transcriptContent.length;
      chunkIndex++
    ) {
      // Pure: Truncate transcript if >100KB (FR-012)
      const { truncated, newCursor } = truncateTranscript(transcriptContent, 100_000, cursor);

      // Skip if no new content
      if (truncated.trim() === '') {
        cursor = newCursor;
        break;
      }

      // Pure: Build extraction prompt (with entity context)
      const prompt = buildExtractionPrompt(truncated, gitContext, projectName, knownEntityProfiles);

      // I/O: Call Claude CLI for extraction (async)
      logInfo(`Using Claude for memory extraction (chunk ${chunkIndex + 1}, cursor ${cursor})`);
      let response: string;
      try {
        response = await extractMemories(prompt);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logError(`Claude extraction failed: ${message}`);
        // Leave the cursor where it was: a transient LLM failure (timeout,
        // rate limit) must not permanently discard up to 100KB of transcript.
        // The next extract run for this session retries the same chunk.
        return chunkFailure(`Claude extraction failed: ${message}`);
      }

      // Pure: Parse extraction response (memories + entities)
      const parseOutcome = parseExtractionResponse(response);
      if (parseOutcome.kind === 'parse_error') {
        // Malformed LLM output is NOT "nothing to extract" — advancing the
        // checkpoint would permanently consume this chunk with zero
        // extraction. Mirror the invocation-failure path above.
        logError('Extraction response could not be parsed — checkpoint not advanced');
        return chunkFailure('Extraction response parse error');
      }
      const candidates = parseOutcome.memories;
      const entityCandidates = parseOutcome.entities;

      if (candidates.length === 0 && entityCandidates.length === 0) {
        // Genuinely-empty chunk — advance checkpoint and move on
        saveExtractionCheckpoint(projectDb, {
          session_id: input.session_id,
          cursor_position: newCursor,
          extracted_at: new Date().toISOString(),
          transcript_length: transcriptContent.length,
        });
        cursor = newCursor;
        continue;
      }

      // I/O: Fetch existing memories fresh per chunk — dedup and edges must
      // see memories inserted by earlier chunks in this run
      const existingMemories = getActiveMemories(projectDb);

      // I/O: Generate local embeddings for candidates (async, for hybrid dedup)
      // Non-fatal: if embedding fails, dedup falls back to Jaccard-only
      const candidateEmbeddings = await generateCandidateEmbeddings(candidates, projectName);

      // Route by scope (FR-008): global-scoped candidates go to the global DB
      // so they're visible from other projects; without this the scope
      // classification is dead weight. Falls back to project when no global
      // DB was provided (tests, legacy callers).
      const projectCandidates: MemoryCandidate[] = [];
      const projectEmbeddings = new Map<number, Float32Array>();
      const globalCandidates: MemoryCandidate[] = [];
      const globalEmbeddings = new Map<number, Float32Array>();

      candidates.forEach((candidate, i) => {
        const embedding = candidateEmbeddings.get(i);
        if (globalDb && candidate.scope === 'global') {
          if (embedding) globalEmbeddings.set(globalCandidates.length, embedding);
          globalCandidates.push(candidate);
        } else {
          if (embedding) projectEmbeddings.set(projectCandidates.length, embedding);
          projectCandidates.push(candidate);
        }
      });

      // Dedup + merge + insert one scope's candidates against one DB
      const processScope = (
        db: Database,
        scopedCandidates: readonly MemoryCandidate[],
        scopedEmbeddings: Map<number, Float32Array>,
        existing: readonly Memory[]
      ): { inserted: Memory[]; skipped: number; merged: number } => {
        const { kept, skipped, merges } = deduplicateCandidates(
          scopedCandidates, existing, DEDUP_SIMILARITY_THRESHOLD, scopedEmbeddings, MERGE_CEILING_THRESHOLD
        );

        // Process merges: append new content to existing memories. Dead
        // merge targets (archived/superseded since the snapshot) cause the
        // candidate to be inserted as a NEW memory instead of being dropped.
        const embeddingFor = (candidate: MemoryCandidate): Float32Array | null =>
          scopedEmbeddings.get(scopedCandidates.indexOf(candidate)) ?? null;
        const mergeResult = applyDedupMerges(
          db, merges, embeddingFor, input.session_id, gitContext
        );

        // Process each candidate — individual insert failures are non-fatal.
        // Intentional: we continue inserting remaining candidates even if one
        // fails, because partial extraction is better than none (FR-010).
        const inserted: Memory[] = [...mergeResult.fallbackInserted];
        for (const candidate of kept) {
          try {
            const memory = candidateToMemory(
              candidate, input.session_id, gitContext, embeddingFor(candidate)
            );
            insertMemory(db, memory);
            inserted.push(memory);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            logError(`Failed to insert memory: ${message}`);
          }
        }

        return { inserted, skipped, merged: mergeResult.merged };
      };

      const projectResult = processScope(projectDb, projectCandidates, projectEmbeddings, existingMemories);
      const globalResult = globalDb && globalCandidates.length > 0
        ? processScope(globalDb, globalCandidates, globalEmbeddings, getActiveMemories(globalDb))
        : { inserted: [] as Memory[], skipped: 0, merged: 0 };

      if (globalResult.inserted.length > 0) {
        logInfo(`Routed ${globalResult.inserted.length} global-scoped memories to global DB`);
      }

      const chunkSkipped = projectResult.skipped + globalResult.skipped;
      const chunkMerged = projectResult.merged + globalResult.merged;
      dedupSkipped += chunkSkipped;
      dedupMergedCount += chunkMerged;
      if (chunkSkipped > 0) {
        logInfo(`Dedup: skipped ${chunkSkipped} near-duplicate candidates (hybrid)`);
      }
      if (chunkMerged > 0) {
        logInfo(`Dedup: merged ${chunkMerged} candidates into existing memories`);
      }

      // Edges and entity facts stay project-DB-only: edges/facts have FK
      // constraints into the same database, so cross-DB links are impossible.
      const insertedMemories: Memory[] = projectResult.inserted;

      // Compute similarity and create edges (FR-061)
      if (insertedMemories.length > 0) {
        try {
          edgeCount += computeSimilarityAndCreateEdges(
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

      // Process entity-fact candidates from extraction
      if (entityCandidates.length > 0 && insertedMemories.length > 0) {
        try {
          const entityResult = processEntityFacts(projectDb, entityCandidates, insertedMemories);
          if (entityResult.entitiesCreated > 0 || entityResult.factsCreated > 0) {
            logInfo(`Entities: ${entityResult.entitiesCreated} entities, ${entityResult.factsCreated} facts created`);
          }
          // Log conflicts prominently
          for (const conflict of entityResult.conflicts) {
            logInfo(`FACT CHANGED: ${conflict.entityName} "${conflict.predicate}" was "${conflict.oldValue}" → now "${conflict.newValue}"`);
          }
          entityConflicts.push(...entityResult.conflicts);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          logError(`Entity processing failed: ${message}`);
          // Non-fatal - continue
        }
      }

      totalInserted += projectResult.inserted.length + globalResult.inserted.length;

      // I/O: Save checkpoint (FR-004) — per chunk so partial progress persists
      saveExtractionCheckpoint(projectDb, {
        session_id: input.session_id,
        cursor_position: newCursor,
        extracted_at: new Date().toISOString(),
        transcript_length: transcriptContent.length,
      });
      cursor = newCursor;
    }

    // I/O: Run lifecycle (decay, archive, prune) — once per run
    try {
      runLifecycle(projectDb);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Lifecycle failed: ${message}`);
      // Non-fatal - continue
    }

    // I/O: Invalidate surface cache since new memories were extracted (FR-022)
    if (totalInserted > 0) {
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
      extracted_count: totalInserted,
      edge_count: edgeCount,
      cursor_position: cursor,
      dedup_skipped: dedupSkipped > 0 ? dedupSkipped : undefined,
      dedup_merged: dedupMergedCount > 0 ? dedupMergedCount : undefined,
      entity_conflicts: entityConflicts.length > 0 ? entityConflicts : undefined,
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
  } finally {
    releaseLock(lockFile);
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

/** A merge target: candidate content should be appended to an existing memory */
export interface DeduplicateMerge {
  readonly candidate: MemoryCandidate;
  readonly existingMemoryId: string;
}

/**
 * Apply dedup merges: append each candidate's content to its existing
 * merge-target memory.
 *
 * The merge targets come from a snapshot of active memories; a target may
 * have been archived/superseded/pruned (or deleted) concurrently. In that
 * case the candidate is inserted as a NEW memory instead — silently merging
 * into a dead memory (or dropping the candidate) would lose the extraction.
 *
 * I/O boundary — writes to database.
 *
 * @param db - Database instance
 * @param merges - Merge targets from deduplicateCandidates
 * @param embeddingFor - Lookup for a candidate's local embedding (may return null)
 * @param sessionId - Current session ID for source tracking
 * @param gitContext - Git context for fallback-inserted memories
 * @returns Count of successful merges and memories inserted as fallback
 */
export function applyDedupMerges(
  db: Database,
  merges: readonly DeduplicateMerge[],
  embeddingFor: (candidate: MemoryCandidate) => Float32Array | null,
  sessionId: string,
  gitContext: GitContext
): { merged: number; fallbackInserted: Memory[] } {
  let merged = 0;
  const fallbackInserted: Memory[] = [];

  for (const merge of merges) {
    try {
      const existingMem = getMemory(db, merge.existingMemoryId);
      if (!existingMem || existingMem.status !== 'active') {
        // Merge target is gone or no longer active — insert as new memory
        logInfo(
          `Merge target ${merge.existingMemoryId} is ${existingMem ? `'${existingMem.status}'` : 'missing'} — inserting candidate as new memory`
        );
        const memory = candidateToMemory(
          merge.candidate, sessionId, gitContext, embeddingFor(merge.candidate)
        );
        insertMemory(db, memory);
        fallbackInserted.push(memory);
        continue;
      }
      updateMemory(db, merge.existingMemoryId, {
        content: `${existingMem.content}\n---\n${merge.candidate.content}`,
        // Null out embeddings so backfill regenerates with updated content
        embedding: null,
        local_embedding: null,
      });
      merged++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logError(`Failed to merge into ${merge.existingMemoryId}: ${message}`);
    }
  }

  return { merged, fallbackInserted };
}

/**
 * Deduplicate extraction candidates against existing memories and each other.
 * Pure function — uses hybrid Jaccard+cosine similarity to filter near-duplicates.
 *
 * Three outcomes per candidate:
 * - score >= mergeCeiling: **skip** (true duplicate)
 * - score in [threshold, mergeCeiling): **merge** into existing memory
 * - score < threshold: **keep** (new memory)
 *
 * @param candidates - Parsed extraction candidates
 * @param existingMemories - All active memories from DB
 * @param threshold - Similarity threshold for dedup (default DEDUP_SIMILARITY_THRESHOLD)
 * @param candidateEmbeddings - Map of candidate index → local embedding (optional)
 * @param mergeCeiling - Score at or above which candidates are skipped instead of merged (default MERGE_CEILING_THRESHOLD)
 * @returns Kept candidates, count of skipped duplicates, and merge targets
 */
export function deduplicateCandidates(
  candidates: readonly MemoryCandidate[],
  existingMemories: readonly Memory[],
  threshold: number = DEDUP_SIMILARITY_THRESHOLD,
  candidateEmbeddings: Map<number, Float32Array> = new Map(),
  mergeCeiling: number = MERGE_CEILING_THRESHOLD,
  intraBatchThreshold: number = INTRA_BATCH_DEDUP_THRESHOLD
): { kept: MemoryCandidate[]; skipped: number; merges: DeduplicateMerge[] } {
  // Pre-tokenize existing memories once
  const existingTokenSets = existingMemories.map(
    (m) => tokenize(`${m.summary} ${m.content}`)
  );
  // Only use local_embedding (384-dim) for cosine comparison — avoids dimension
  // mismatch with candidate embeddings which are always 384-dim local.
  const existingEmbeddings = existingMemories.map(
    (m) => m.local_embedding ?? null
  );

  const kept: MemoryCandidate[] = [];
  const keptTokenSets: ReadonlySet<string>[] = [];
  const keptEmbeddings: (Float32Array | null)[] = [];
  const merges: DeduplicateMerge[] = [];
  let skipped = 0;

  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const candidateTokens = tokenize(`${candidate.summary} ${candidate.content}`);
    const candidateEmbedding = candidateEmbeddings.get(i) ?? null;

    // Check against existing memories (hybrid)
    let bestScore = 0;
    let bestMatchIndex = -1;
    for (let j = 0; j < existingTokenSets.length; j++) {
      const score = hybridSimilarity(
        candidateTokens,
        existingTokenSets[j],
        candidateEmbedding,
        existingEmbeddings[j]
      );
      if (score > bestScore) {
        bestScore = score;
        bestMatchIndex = j;
      }
    }

    // Check against already-kept candidates in this batch (intra-batch dedup).
    // Runs REGARDLESS of the existing-memory match outcome: a candidate that
    // duplicates an already-kept candidate must be skipped even when it also
    // matches an existing memory — otherwise near-identical content lands
    // both as a new memory (the kept candidate) and appended to an existing
    // one (this candidate merged into its match).
    // Uses a higher threshold than cross-session dedup because candidates from
    // the same session naturally share domain vocabulary and semantic space.
    let intraBatchDuplicate = false;
    for (let j = 0; j < keptTokenSets.length; j++) {
      const score = hybridSimilarity(
        candidateTokens,
        keptTokenSets[j],
        candidateEmbedding,
        keptEmbeddings[j]
      );
      if (score >= intraBatchThreshold) {
        intraBatchDuplicate = true;
        break;
      }
    }

    if (intraBatchDuplicate) {
      // Intra-batch duplicates are always skipped (no merge target)
      skipped++;
    } else if (bestScore >= mergeCeiling) {
      // True duplicate — skip entirely
      skipped++;
    } else if (bestScore >= threshold && bestMatchIndex >= 0) {
      // Similar but not identical — merge into existing memory
      merges.push({
        candidate,
        existingMemoryId: existingMemories[bestMatchIndex].id,
      });
    } else {
      kept.push(candidate);
      keptTokenSets.push(candidateTokens);
      keptEmbeddings.push(candidateEmbedding);
    }
  }

  return { kept, skipped, merges };
}

/** An edge to create between a new memory and an existing one */
export interface EdgeCandidate {
  readonly targetId: string;
  readonly score: number;
  readonly strength: number;
  readonly status: 'active' | 'suggested';
}

/**
 * Compute the edges a single new memory should get against existing memories.
 * Pure function — no I/O.
 *
 * Classification is SPACE-AWARE: when both sides have local embeddings the
 * score is raw 384-dim BGE cosine (runs hot — same-domain pairs score
 * 0.6-0.75), so the calibrated 'local-cosine' bands apply; Jaccard fallback
 * keeps the original FR-059 bands. Without this, nearly every same-project
 * pair landed in consolidate/suggest → O(n²) relates_to edges, all fed to
 * the semantic-edges LLM pass.
 *
 * Structural guard: only the `maxEdges` strongest non-ignore candidates are
 * kept per new memory.
 *
 * Action → edge mapping: relate → active (strength = score band value),
 * suggest → suggested, consolidate → active (strength = score).
 *
 * @param newMem - Newly inserted memory
 * @param existingMemories - Active memories to compare against
 * @param maxEdges - Cap on edges per new memory (default MAX_EDGES_PER_MEMORY)
 * @returns Edge candidates sorted by score descending, capped at maxEdges
 */
export function computeEdgeCandidates(
  newMem: Memory,
  existingMemories: readonly Memory[],
  maxEdges: number = MAX_EDGES_PER_MEMORY
): readonly EdgeCandidate[] {
  const newTokens = tokenize(`${newMem.summary} ${newMem.content}`);
  // Only use local_embedding (384-dim) for cosine comparison — avoids dimension
  // mismatch with Gemini embeddings (768-dim). Matches dedup strategy.
  const newEmbedding = newMem.local_embedding ?? null;

  const candidates: EdgeCandidate[] = [];

  for (const existingMem of existingMemories) {
    if (newMem.id === existingMem.id) continue;

    const existingTokens = tokenize(`${existingMem.summary} ${existingMem.content}`);
    const existingEmbedding = existingMem.local_embedding ?? null;

    const { score, method } = hybridSimilarityScored(
      newTokens, existingTokens, newEmbedding, existingEmbedding
    );
    // Cosine here always means the local 384-dim space (see above)
    const action = classifySimilarity(score, method === 'cosine' ? 'local-cosine' : 'jaccard');

    if (action.action === 'ignore') continue;

    candidates.push({
      targetId: existingMem.id,
      score,
      strength: action.action === 'consolidate' ? score : action.strength,
      status: action.action === 'suggest' ? 'suggested' : 'active',
    });
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, maxEdges);
}

/**
 * Compute similarity between new memories and existing, create edges
 * I/O boundary - inserts edges into DB
 *
 * Space-aware classification + per-memory edge cap live in the pure core
 * (computeEdgeCandidates); this shell only persists the results (FR-061).
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
    for (const candidate of computeEdgeCandidates(newMem, existingMemories)) {
      try {
        insertEdge(db, {
          source_id: newMem.id,
          target_id: candidate.targetId,
          relation_type: 'relates_to',
          strength: candidate.strength,
          bidirectional: true,
          status: candidate.status,
        });
        edgeCount++;
      } catch {
        // Duplicate edge constraint - skip silently
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
 * Process extracted entity-fact candidates: upsert entities, insert facts,
 * supersede conflicting facts (same entity + predicate, different object).
 * I/O boundary — writes to database.
 *
 * @param db - Database instance
 * @param candidates - Extracted entity-fact candidates
 * @param sourceMemories - Memories from this extraction batch (for source linking)
 * @returns Count of entities/facts created and any detected conflicts
 */
function processEntityFacts(
  db: Database,
  candidates: readonly EntityFactCandidate[],
  sourceMemories: readonly Memory[]
): { entitiesCreated: number; factsCreated: number; conflicts: readonly FactConflict[] } {
  let entitiesCreated = 0;
  let factsCreated = 0;
  const conflicts: FactConflict[] = [];

  // Use the first inserted memory as default source (best we can do without per-fact attribution)
  const defaultSourceId = sourceMemories[0]?.id;
  if (!defaultSourceId) return { entitiesCreated: 0, factsCreated: 0, conflicts: [] };

  const now = new Date().toISOString();

  for (const candidate of candidates) {
    // Upsert entity (returns existing ID if already known)
    const entityId = upsertEntity(db, candidate.entity_name, candidate.entity_type);

    // Check if this is a new entity (no existing facts = likely new)
    const existingFacts = getCurrentFacts(db, entityId);
    if (existingFacts.length === 0) {
      entitiesCreated++;
    }

    // Check for conflicting fact: same predicate, different object → supersede
    const conflicting = existingFacts.find(
      (f) => f.predicate.toLowerCase() === candidate.predicate.toLowerCase() &&
             f.object.toLowerCase() !== candidate.object.toLowerCase()
    );
    if (conflicting) {
      supersedeFact(db, conflicting.id);
      conflicts.push({
        entityName: candidate.entity_name,
        predicate: candidate.predicate,
        oldValue: conflicting.object,
        newValue: candidate.object,
      });
    }

    // Skip if exact duplicate fact already exists
    const exactDup = existingFacts.find(
      (f) => f.predicate.toLowerCase() === candidate.predicate.toLowerCase() &&
             f.object.toLowerCase() === candidate.object.toLowerCase()
    );
    if (exactDup) continue;

    // Insert new fact
    const factId = randomUUID();
    insertFact(db, {
      id: factId,
      entity_id: entityId,
      predicate: candidate.predicate,
      object: candidate.object,
      source_memory_id: defaultSourceId,
      confidence: 0.7, // Default confidence for extracted facts
      valid_from: now,
      valid_to: null,
      created_at: now,
    });
    factsCreated++;
  }

  return { entitiesCreated, factsCreated, conflicts };
}

/**
 * Build entity profiles from the project DB for injection into extraction prompt.
 * Skips entities with no current facts. Max 20 entities (prompt budget).
 * I/O: Reads from database.
 */
function buildKnownEntityProfiles(db: Database): readonly EntityProfile[] {
  const entities = getAllEntities(db);
  const profiles: EntityProfile[] = [];

  for (const entity of entities) {
    const facts = getCurrentFacts(db, entity.id);
    if (facts.length === 0) continue;
    profiles.push({ entity, currentFacts: facts, sourceMemories: [] });
    if (profiles.length >= 20) break;
  }

  return profiles;
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
