/**
 * Remember command - explicit memory creation with type, priority, scope, pinned flag
 * Thin orchestrator: parse args -> create memory -> insert into DB -> output result
 *
 * Satisfies:
 * - FR-041: Explicit memory creation with content, type, and priority
 * - FR-042: Global vs project scope specification
 * - FR-043: Pin memories to prevent confidence decay
 * - FR-044: Tag memories with arbitrary labels
 * - FR-045: Queue embeddings (embedding=null, local_embedding=null) — drained
 *   at the next session start (FR-046), OR immediately when the composition
 *   root injects flushEmbedding (an explicit remember should be recallable
 *   without waiting for the next session)
 */

import { randomUUID } from 'crypto';
import type { Database } from 'bun:sqlite';
import type { MemoryType, MemoryScope, Memory } from '../core/types.js';
import { createMemory, isMemoryType, serializeSourceContext } from '../core/types.js';
import { insertMemory, routeToDatabase, getActiveMemories, supersedeMemory } from '../infra/db.js';
import { tokenize } from '../core/similarity.js';
import { compareForDedup, duplicateFloor, type DedupPolicy } from '../core/calibration.js';
import { carryForward, parseReplacementTag, replacedBy, type ReplacementTag } from '../core/replacement.js';
import { buildEmbeddingText } from '../core/extraction.js';
import { ACTIVE_DEDUP_POLICY } from '../config.js';
import { invalidateSurfaceCache } from './generate.js';

/**
 * Injectable embedding function — matches embedLocal's signature.
 * The imperative shell (cli.ts) injects the real local embedder;
 * tests inject a deterministic fake.
 */
export type EmbedFn = (text: string) => Promise<Float32Array>;

// ============================================================================
// FUNCTIONAL CORE - PURE FUNCTIONS
// ============================================================================

/**
 * Parse command line arguments into structured options
 * Pure function - no side effects
 */
export interface RememberArgs {
  readonly content: string;
  readonly type: MemoryType;
  readonly priority: number;
  readonly scope: MemoryScope;
  readonly pinned: boolean;
  readonly tags: readonly string[];
  readonly sessionId: string;
  /**
   * `--replaces=<tag>`: the new memory is the current version of every other
   * active memory carrying this tag, which it supersedes. The tag is also in
   * `tags`, so the next replacement finds this memory.
   */
  readonly replaces: ReplacementTag | null;
}

export type ParseResult =
  | { readonly success: true; readonly args: RememberArgs }
  | { readonly success: false; readonly error: string };

/**
 * Parse args array into RememberArgs
 * Pure function for testability
 */
export function parseRememberArgs(
  argv: readonly string[],
  sessionId: string
): ParseResult {
  // Expected format:
  // remember <content> [--type=TYPE] [--priority=N] [--scope=SCOPE] [--pinned] [--tags=tag1,tag2] [--replaces=TAG]

  if (argv.length === 0) {
    return {
      success: false,
      error: 'content is required',
    };
  }

  // First arg is content (may be quoted)
  const content = argv[0].trim();

  if (content === '') {
    return {
      success: false,
      error: 'content must not be empty',
    };
  }

  // Parse options from remaining args
  let type: MemoryType = 'context'; // default
  let priority = 5; // default
  let scope: MemoryScope = 'project'; // default
  let pinned = false; // default
  let tags: string[] = [];
  let replaces: ReplacementTag | null = null;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];

    if (arg.startsWith('--type=')) {
      const value = arg.substring(7);
      if (!isMemoryType(value)) {
        return {
          success: false,
          error: `invalid memory type: ${value}. Valid types: architecture, decision, pattern, gotcha, context, progress, code_description, code`,
        };
      }
      type = value;
    } else if (arg.startsWith('--priority=')) {
      const value = parseInt(arg.substring(11), 10);
      if (isNaN(value) || value < 1 || value > 10) {
        return {
          success: false,
          error: `priority must be between 1-10, got: ${arg.substring(11)}`,
        };
      }
      priority = value;
    } else if (arg.startsWith('--scope=')) {
      const value = arg.substring(8);
      if (value !== 'project' && value !== 'global') {
        return {
          success: false,
          error: `scope must be 'project' or 'global', got: ${value}`,
        };
      }
      scope = value;
    } else if (arg === '--pinned') {
      pinned = true;
    } else if (arg.startsWith('--tags=')) {
      const value = arg.substring(7);
      tags = value.split(',').map((t) => t.trim()).filter((t) => t !== '');
    } else if (arg.startsWith('--replaces=')) {
      const parsed = parseReplacementTag(arg.substring('--replaces='.length));
      if (!parsed.ok) {
        return { success: false, error: parsed.error };
      }
      replaces = parsed.tag;
    } else {
      return {
        success: false,
        error: `unknown option: ${arg}`,
      };
    }
  }

  return {
    success: true,
    args: {
      content,
      type,
      priority,
      scope,
      pinned,
      tags: replaces === null || tags.includes(replaces) ? tags : [...tags, replaces],
      sessionId,
      replaces,
    },
  };
}

/**
 * Build a Memory object from parsed args at the persistence boundary.
 * Allocates a UUID and current timestamps, so callers must not treat repeated
 * calls with equal arguments as referentially transparent.
 *
 * Note: embeddings are null to queue for backfill (FR-045)
 * Summary is derived from content (first 200 chars)
 * Confidence is 1.0 for explicit memories (high trust)
 */
export function buildMemoryFromArgs(args: RememberArgs): Memory {
  const id = randomUUID();
  const now = new Date().toISOString();

  // Generate summary from content (first 200 chars)
  const summary =
    args.content.length <= 200
      ? args.content
      : args.content.substring(0, 197) + '...';

  // Build source_context with session info
  const sourceContext = serializeSourceContext({
    source: 'manual',
    session_id: args.sessionId,
  });

  return createMemory({
    id,
    content: args.content,
    summary,
    memory_type: args.type,
    scope: args.scope,
    confidence: 1.0, // Explicit memories have full confidence
    priority: args.priority,
    pinned: args.pinned,
    source_type: 'manual',
    source_session: args.sessionId,
    source_context: sourceContext,
    tags: args.tags,
    embedding: null, // Queue for backfill
    local_embedding: null, // Queue for backfill
    access_count: 0,
    last_accessed_at: now,
    created_at: now,
    updated_at: now,
    status: 'active',
  });
}

/**
 * Check if content is a near-duplicate of any existing memory.
 * Pure function — uses hybrid Jaccard+cosine similarity.
 *
 * When a candidate embedding is provided and the policy is calibrated for
 * cosine, it is compared against existing memories' current-model embeddings
 * (catches paraphrased duplicates). Otherwise, and for any existing memory
 * without a vector, the comparison is Jaccard. Each score is read against its
 * own space's duplicate floor: the lowest score at which extraction would not
 * store the new memory on its own either.
 *
 * @param content - New memory content to check
 * @param summary - New memory summary (derived from content)
 * @param existingMemories - Active memories from DB
 * @param candidateEmbedding - Optional current-model embedding of the new memory
 * @param policy - Duplicate thresholds per space (default: the active model's)
 * @returns The matching memory summary if duplicate, null otherwise
 */
export function findDuplicate(
  content: string,
  summary: string,
  existingMemories: readonly Memory[],
  candidateEmbedding: Float32Array | null = null,
  policy: DedupPolicy = ACTIVE_DEDUP_POLICY
): string | null {
  // Symmetric tokenization: summary+content for both candidate and existing
  const candidateTokens = tokenize(`${summary} ${content}`);

  for (const existing of existingMemories) {
    const existingTokens = tokenize(`${existing.summary} ${existing.content}`);
    const { score, thresholds } = compareForDedup(
      candidateTokens, existingTokens, candidateEmbedding, existing.local_embedding, policy
    );
    if (score >= duplicateFloor(thresholds.existing)) {
      return existing.summary;
    }
  }

  return null;
}

/**
 * Format success result as JSON
 * Pure function
 */
export interface RememberResult {
  readonly success: true;
  readonly memory_id: string;
  readonly scope: MemoryScope;
  readonly message: string;
  /** Ids of the memories `--replaces` superseded; empty without the flag. */
  readonly superseded: readonly string[];
}

export function formatSuccessResult(memory: Memory, superseded: readonly string[] = []): RememberResult {
  return {
    success: true,
    memory_id: memory.id,
    scope: memory.scope,
    message: `Memory created (${memory.scope} scope, priority ${memory.priority}${memory.pinned ? ', pinned' : ''})`,
    superseded,
  };
}

/**
 * Format error result as JSON
 * Pure function
 */
export interface RememberError {
  readonly success: false;
  readonly error: string;
}

export function formatErrorResult(error: string): RememberError {
  return {
    success: false,
    error,
  };
}

// ============================================================================
// IMPERATIVE SHELL - I/O ORCHESTRATION
// ============================================================================

/**
 * Options for executeRemember's dedup embedding.
 */
export interface RememberOptions {
  /** Embedding function for cosine dedup (injected by shell; null = Jaccard-only) */
  readonly embedFn?: EmbedFn | null;
  /**
   * Project name for a project-scoped memory's embedding prefix; a global
   * memory embeds as `global` whatever this is (buildEmbeddingText), so the
   * candidate's vector matches the one backfill stores for it
   */
  readonly projectName?: string;
  /** Project root; when provided, the surface cache is invalidated after insert */
  readonly projectRoot?: string;
  /**
   * Post-insert embedding flush. The standard queue is drained at the next
   * session start (FR-046); an explicit remember should be semantically
   * searchable NOW, so the composition root injects the backfill here.
   * Omitted (tests, non-CLI entry points) = legacy queue-only behavior.
   * Best-effort by contract: a flush failure is logged, never fatal — the
   * memory stays queued and the next backfill picks it up.
   */
  readonly flushEmbedding?: (db: Database, memory: Memory) => Promise<void>;
}

/**
 * Execute remember command
 * I/O boundary - orchestrates pure functions with database operations
 *
 * @param argv - Command arguments (excluding 'remember' command name)
 * @param sessionId - Current session ID
 * @param projectDb - Project database instance
 * @param globalDb - Global database instance
 * @param options - Optional embed function + project name for cosine dedup
 * @returns JSON result object
 */
export async function executeRemember(
  argv: readonly string[],
  sessionId: string,
  projectDb: Database,
  globalDb: Database,
  options: RememberOptions = {}
): Promise<RememberResult | RememberError> {
  // Parse args (pure)
  const parseResult = parseRememberArgs(argv, sessionId);

  if (!parseResult.success) {
    return formatErrorResult(parseResult.error);
  }

  const args = parseResult.args;

  // Build the persistence-boundary memory object (allocates ID/timestamps)
  let memory: Memory;
  try {
    memory = buildMemoryFromArgs(args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return formatErrorResult(`failed to create memory: ${message}`);
  }

  // Route to appropriate database based on scope (pure routing)
  const targetDb = routeToDatabase(memory.scope, projectDb, globalDb);

  // --replaces: the caller states this is a new version, so it is not checked
  // for duplicates — the memory it replaces is, by design, its near-duplicate.
  if (args.replaces === null) {
    const duplicateOf = await findDuplicateIn(targetDb, memory, options);
    if (duplicateOf.kind === 'duplicate') {
      return formatErrorResult(`near-duplicate of existing memory: "${duplicateOf.summary}"`);
    }
    if (duplicateOf.kind === 'failed') {
      return formatErrorResult(`dedup check failed; memory not inserted: ${duplicateOf.message}`);
    }
  }

  // Insert, and supersede what it replaces, in one transaction: a crash
  // between the two would leave two current versions of one fact (I/O). The
  // replaced set is read inside the transaction, before the insert, so the
  // written memory can carry their pin and priority forward.
  let written: Readonly<{ memory: Memory; superseded: readonly string[] }>;
  try {
    written = targetDb.transaction(() => {
      const replacesTag = args.replaces;
      if (replacesTag === null) {
        insertMemory(targetDb, memory);
        return { memory, superseded: [] };
      }
      const replaced = replacedBy(memory.id, replacesTag, getActiveMemories(targetDb));
      const current = carryForward(memory, replaced);
      insertMemory(targetDb, current);
      for (const old of replaced) supersedeMemory(targetDb, old.id, current.id);
      return { memory: current, superseded: replaced.map((old) => old.id) };
    })();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return formatErrorResult(`failed to insert memory: ${message}`);
  }

  // Invalidate cached surfaces: the visible memory set changed (I/O)
  if (options.projectRoot !== undefined) {
    invalidateSurfaceCache(options.projectRoot);
  }

  // Make the new memory searchable immediately: the embedding queue is
  // normally drained at the next session start (FR-046), but an explicit
  // remember should be recallable without waiting. Best-effort — on failure
  // the memory stays queued and the next backfill catches up.
  if (options.flushEmbedding !== undefined) {
    try {
      await options.flushEmbedding(targetDb, written.memory);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[cortex:remember] WARN: post-insert embedding flush failed (memory stays queued for next backfill): ${message}\n`
      );
    }
  }

  // Format success result (pure)
  return formatSuccessResult(written.memory, written.superseded);
}

type DuplicateCheck =
  | Readonly<{ kind: 'unique' }>
  | Readonly<{ kind: 'duplicate'; summary: string }>
  | Readonly<{ kind: 'failed'; message: string }>;

/**
 * Check the new memory against the active memories of its database (I/O).
 *
 * Embeds the candidate for cosine dedup (catches paraphrased duplicates) and
 * degrades to Jaccard-only when the embedder is absent or fails. Whether
 * cosine dedup is safe at all is a deployment decision, made at the
 * composition root (cli.ts), which supplies embedFn only when the active local
 * model has a dedup calibration: a hit here DROPS the new memory, and an
 * uncalibrated space produces hits on unrelated content.
 */
async function findDuplicateIn(
  targetDb: Database,
  memory: Memory,
  options: RememberOptions
): Promise<DuplicateCheck> {
  let candidateEmbedding: Float32Array | null = null;
  const embedFn = options.embedFn ?? null;
  if (embedFn !== null) {
    try {
      const embeddingText = buildEmbeddingText(memory, options.projectName ?? 'unknown');
      candidateEmbedding = await embedFn(embeddingText);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[cortex:remember] WARN: candidate embedding failed, dedup degrades to Jaccard: ${message}\n`
      );
    }
  }

  try {
    const duplicateOf = findDuplicate(
      memory.content, memory.summary, getActiveMemories(targetDb), candidateEmbedding
    );
    return duplicateOf === null ? { kind: 'unique' } : { kind: 'duplicate', summary: duplicateOf };
  } catch (err) {
    return { kind: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}
