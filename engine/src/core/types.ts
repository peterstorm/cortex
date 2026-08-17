/**
 * Core domain types for Cortex memory system.
 * Uses readonly domain shapes, literal and nominal types, discriminated
 * unions, and factory validation for construction-time invariants.
 */

// ============================================================================
// SOURCE CONTEXT
// ============================================================================

/** Shared schema for source_context JSON — used by extract, remember, index-code */
export type SourceContext =
  | { readonly source: 'extraction'; readonly session_id: string; readonly branch?: string; readonly commits?: readonly string[]; readonly files?: readonly string[] }
  | { readonly source: 'manual'; readonly session_id: string }
  | { readonly source: 'code_index'; readonly file_path: string; readonly start_line?: number; readonly end_line?: number; readonly session_id?: string }
  | { readonly source: 'consolidation'; readonly merged_from: readonly string[]; readonly session_id: string };

/**
 * Serialize a SourceContext for storage in memory.source_context.
 *
 * Every producer (extract, remember, index-code, consolidate) builds the
 * stored JSON through this helper so the union stays the single source of
 * truth for the serialized shapes.
 */
export function serializeSourceContext(context: SourceContext): string {
  return JSON.stringify(context);
}

// Memory Type (FR-103)
export type MemoryType =
  | 'architecture'
  | 'decision'
  | 'pattern'
  | 'gotcha'
  | 'context'
  | 'progress'
  | 'code_description'
  | 'code';

export const MEMORY_TYPES: readonly MemoryType[] = [
  'architecture',
  'decision',
  'pattern',
  'gotcha',
  'context',
  'progress',
  'code_description',
  'code',
] as const;

// Memory Status (FR-105)
export type MemoryStatus = 'active' | 'superseded' | 'archived' | 'pruned';

export const MEMORY_STATUSES: readonly MemoryStatus[] = [
  'active',
  'superseded',
  'archived',
  'pruned',
] as const;

// Memory Scope
export type MemoryScope = 'project' | 'global';

export const MEMORY_SCOPES: readonly MemoryScope[] = ['project', 'global'] as const;

/**
 * Build the type guard for a closed string union from its member list.
 *
 * Every union in this file needs the same check — "is a string, and is one of
 * these" — and hand-writing it six times produced two different casting styles
 * for one idea. One factory means one place to read, and a new union gets its
 * guard for free instead of a seventh copy that may drift.
 */
function unionGuard<T extends string>(members: readonly T[]): (value: unknown) => value is T {
  const allowed: ReadonlySet<string> = new Set(members);
  return (value: unknown): value is T => typeof value === 'string' && allowed.has(value);
}

export const isMemoryScope = unionGuard(MEMORY_SCOPES);

// Source Type
export type SourceType = 'extraction' | 'manual' | 'code_index';

export const SOURCE_TYPES: readonly SourceType[] = ['extraction', 'manual', 'code_index'] as const;

export const isSourceType = unionGuard(SOURCE_TYPES);

// Core Memory domain object (FR-103)
export interface Memory {
  readonly id: string;
  readonly content: string;
  readonly summary: string;
  readonly memory_type: MemoryType;
  readonly scope: MemoryScope;
  readonly embedding: Float64Array | null;
  readonly local_embedding: Float32Array | null;
  readonly confidence: number; // 0-1
  readonly priority: number; // 1-10
  readonly pinned: boolean;
  readonly source_type: SourceType;
  readonly source_session: string;
  readonly source_context: string; // JSON-serialized SourceContext
  readonly tags: readonly string[];
  readonly access_count: number;
  readonly last_accessed_at: string; // ISO8601
  readonly created_at: string; // ISO8601
  readonly updated_at: string; // ISO8601
  readonly status: MemoryStatus;
  /** When the memory was archived (ISO8601). Null while active; anchors the archive→prune grace period. */
  readonly archived_at: string | null;
}

// Edge Relation Type (FR-104)
export type EdgeRelation =
  | 'relates_to'
  | 'derived_from'
  | 'contradicts'
  | 'exemplifies'
  | 'refines'
  | 'supersedes'
  | 'source_of';

export const EDGE_RELATIONS: readonly EdgeRelation[] = [
  'relates_to',
  'derived_from',
  'contradicts',
  'exemplifies',
  'refines',
  'supersedes',
  'source_of',
] as const;

// Edge Status
export type EdgeStatus = 'active' | 'suggested' | 'archived';

export const EDGE_STATUSES: readonly EdgeStatus[] = ['active', 'suggested', 'archived'] as const;

export const isEdgeStatus = unionGuard(EDGE_STATUSES);

// Graph edge (FR-104)
export interface Edge {
  readonly id: string;
  readonly source_id: string;
  readonly target_id: string;
  readonly relation_type: EdgeRelation;
  readonly strength: number; // 0-1
  readonly bidirectional: boolean;
  readonly status: EdgeStatus;
  readonly created_at: string; // ISO8601
  /** ISO8601 timestamp of the last semantic-classification attempt; null when never attempted. */
  readonly classified_at: string | null;
  /** Hash of the endpoint memories' content at the last attempt; null when never attempted. */
  readonly classify_hash: string | null;
  /**
   * ISO8601 timestamp of the last FAILED classification attempt; null when
   * never failed (or when a later attempt answered). Within the failure
   * backoff window a same-content failure is not re-asked, so an unhealthy
   * server is not re-hammered on every maintenance run.
   */
  readonly last_failed_at: string | null;
}

// Extraction Checkpoint (FR-004, FR-105)
export interface ExtractionCheckpoint {
  readonly id: string;
  readonly session_id: string;
  /**
   * Resume position. Under projection_version >= 1 this is a RAW BYTE offset
   * into the transcript file, always on a line boundary. Legacy checkpoints
   * (projection_version null) held a character offset into the entire file
   * read as one string; the two are not comparable, so legacy rows are reset
   * on load.
   */
  readonly cursor_position: number;
  readonly extracted_at: string; // ISO8601
  /**
   * Transcript size when the checkpoint was saved. Under projection_version
   * >= 1 this is the raw file size in BYTES; legacy rows held content length
   * in characters. Used to detect a rewritten/shrunken transcript so the
   * cursor can be reset instead of pointing past EOF.
   */
  readonly transcript_length: number | null;
  /**
   * Projection contract the cursor was produced under. Null for legacy
   * checkpoints written before projection existed. A mismatch against the
   * current PROJECTION_VERSION forces the cursor back to 0 — an offset is only
   * meaningful under the projection that produced it, and reusing one across
   * versions would silently skip transcript. Re-extraction is safe: dedup
   * absorbs it.
   */
  readonly projection_version: number | null;
}

// Hook Input
export interface HookInput {
  readonly session_id: string;
  readonly transcript_path: string;
  readonly cwd: string;
}

// Search Result
export interface SearchResult {
  readonly memory: Memory;
  readonly score: number;
  readonly source: 'project' | 'global';
  readonly related: readonly Memory[];
}

// Memory Candidate (extracted before DB insertion)
export interface MemoryCandidate {
  readonly content: string;
  readonly summary: string;
  readonly memory_type: MemoryType;
  readonly scope: MemoryScope;
  readonly confidence: number;
  readonly priority: number;
  readonly tags: readonly string[];
}

/**
 * Similarity space a score was computed in. Scores are NOT comparable across
 * spaces: raw cosine on local BGE-small-en-v1.5 embeddings runs "hot"
 * (same-domain memories about different aspects routinely score 0.6-0.75),
 * while Jaccard is much better separated. Thresholds and classification bands
 * must be calibrated per space.
 *
 * A space is also per MODEL, not merely per family: the 'local-cosine' bands
 * belong to BGE-small-en-v1.5 specifically. See LOCAL_COSINE_CALIBRATED, which
 * keeps an uncalibrated local model out of destructive comparisons entirely.
 */
export type SimilaritySpace = 'jaccard' | 'local-cosine';

// Similarity Action (discriminated union)
export type SimilarityAction =
  | { action: 'ignore' }
  | { action: 'relate'; strength: number }
  | { action: 'suggest'; strength: number }
  | { action: 'consolidate' };

// Git Context
export interface GitContext {
  readonly branch: string;
  readonly recent_commits: readonly string[];
  readonly changed_files: readonly string[];
}

// Factory Functions with Validation

/**
 * Refuse a score outside its closed range (pure).
 *
 * The three factories below all enforce a [min, max] score with an identical
 * NaN-guarded comparison and an identical message. One named check keeps the
 * bound and the wording from drifting between them — a Memory that rejects
 * confidence 1.5 while its Candidate accepts it is a real divergence, not a
 * stylistic one.
 *
 * @throws when the value is NaN or outside [min, max].
 */
function assertInRange(field: string, value: number, min: number, max: number): void {
  if (Number.isNaN(value) || value < min || value > max) {
    throw new Error(`${field} must be in [${min}, ${max}], got ${value}`);
  }
}

/** @throws when a required identity/content string is empty after trimming. */
function requireNonEmpty(field: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    throw new Error(`${field} must not be empty`);
  }
  return trimmed;
}

/**
 * Validate and create a Memory with invariants checked.
 * Throws if invariants violated (parse, don't validate pattern).
 */
export function createMemory(input: {
  id: string;
  content: string;
  summary: string;
  memory_type: MemoryType;
  scope: MemoryScope;
  confidence: number;
  priority: number;
  source_type: SourceType;
  source_session: string;
  source_context: string;
  tags?: readonly string[];
  pinned?: boolean;
  embedding?: Float64Array | null;
  local_embedding?: Float32Array | null;
  access_count?: number;
  last_accessed_at?: string;
  created_at?: string;
  updated_at?: string;
  status?: MemoryStatus;
  archived_at?: string | null;
}): Memory {
  // Validate non-empty strings
  const trimmedId = requireNonEmpty('id', input.id);
  const trimmedContent = requireNonEmpty('content', input.content);
  const trimmedSummary = requireNonEmpty('summary', input.summary);
  const trimmedSourceSession = requireNonEmpty('source_session', input.source_session);

  assertInRange('confidence', input.confidence, 0, 1);
  assertInRange('priority', input.priority, 1, 10);

  // The union members are validated unconditionally: the input type declares
  // them required, so an `!== undefined` guard would be a branch the compiler
  // proves dead while leaving untyped JSON-sourced callers — the only callers
  // that can actually pass undefined — unchecked.
  if (!isMemoryType(input.memory_type)) {
    throw new Error(`invalid memory_type: ${input.memory_type}`);
  }
  if (!isMemoryScope(input.scope)) {
    throw new Error(`invalid scope: ${input.scope}`);
  }
  if (!isSourceType(input.source_type)) {
    throw new Error(`invalid source_type: ${input.source_type}`);
  }

  const status = input.status ?? 'active';
  if (!isMemoryStatus(status)) {
    throw new Error(`invalid status: ${status}`);
  }

  // The archived_at field is the archive anchor: it must be null while the
  // memory is active; archived and pruned memories may carry it (pruning
  // keeps the anchor for the retention window).
  const archivedAt = input.archived_at ?? null;
  if (status === 'active' && archivedAt !== null) {
    throw new Error('active memory must not have archived_at set');
  }
  if (archivedAt !== null && status !== 'archived' && status !== 'pruned') {
    throw new Error(`status ${status} must not have archived_at set (only archived memories anchor an archive timestamp)`);
  }



  const now = new Date().toISOString();

  return {
    id: trimmedId,
    content: trimmedContent,
    summary: trimmedSummary,
    memory_type: input.memory_type,
    scope: input.scope,
    embedding: input.embedding ?? null,
    local_embedding: input.local_embedding ?? null,
    confidence: input.confidence,
    priority: input.priority,
    pinned: input.pinned ?? false,
    source_type: input.source_type,
    source_session: trimmedSourceSession,
    source_context: input.source_context,
    tags: [...(input.tags ?? [])],
    access_count: input.access_count ?? 0,
    last_accessed_at: input.last_accessed_at ?? now,
    created_at: input.created_at ?? now,
    updated_at: input.updated_at ?? now,
    status,
    archived_at: archivedAt,
  };
}

/**
 * The status/archived_at coupling, resolved for a PARTIAL update (pure).
 *
 * The invariant is "archived_at is non-null only while status is archived or
 * pruned". createMemory can enforce it directly because it sees a whole
 * Memory; updateMemory cannot, because it takes a `Partial<Memory>` patch in
 * which either half may be absent and the missing half is whatever the stored
 * row already holds. That is also why the coupling is not expressible as a
 * discriminated union on Memory: `{ status: 'archived' }` on its own is a
 * legitimate patch, and no partial over such a union admits it.
 *
 * So the coupling lives here instead — one named pure function, given the
 * row's current values and the incoming patch, deciding both whether the
 * result is legal and what archived_at should become. The shell reads the row
 * once, calls this, and persists; it holds no coupling logic of its own.
 *
 * @param current - The stored row's status and anchor.
 * @param patch - The requested change; `undefined` means "leave alone".
 * @returns The resolved anchor, or the reason the patch is refused. The
 *   `archived_at` arm is `undefined` when the patch leaves the anchor
 *   untouched, mirroring the patch semantics the caller already speaks.
 */
export function resolveArchiveAnchor(
  current: { id: string; status?: MemoryStatus; archived_at?: string | null },
  patch: { status?: MemoryStatus; archived_at?: string | null },
  now: Date
):
  | { ok: true; archived_at: string | null | undefined }
  | { ok: false; reason: string } {
  // An explicit null CLEARS the anchor, and is legal only when the row ends up
  // in a status that must not carry one. Clearing it while the memory stays
  // archived or pruned leaves the retention window (FR-091) with nothing to
  // measure from — the same status/anchor contradiction the non-null cases
  // below refuse, arriving from the other side. `patch.archived_at === null`
  // is not `undefined`, so neither of those branches would have caught it.
  if (patch.archived_at === null) {
    const resolvedStatus = patch.status ?? current.status;
    if (resolvedStatus === 'archived' || resolvedStatus === 'pruned') {
      return {
        ok: false,
        reason: `memory ${current.id} is ${resolvedStatus}; archived_at must not be cleared (only archived/pruned memories anchor an archive timestamp)`,
      };
    }
    return { ok: true, archived_at: null };
  }

  // An explicit anchor is only ever legal alongside an archived/pruned status,
  // whether that status arrives in this patch or is already on the row.
  if (patch.archived_at != null) {
    if (patch.status === 'active') {
      return { ok: false, reason: 'active memory must not have archived_at set' };
    }
    if (patch.status !== undefined && patch.status !== 'archived' && patch.status !== 'pruned') {
      return {
        ok: false,
        reason: `status ${patch.status} must not have archived_at set (only archived/pruned memories anchor an archive timestamp)`,
      };
    }
    if (patch.status === undefined && current.status !== 'archived' && current.status !== 'pruned') {
      return {
        ok: false,
        reason: `memory ${current.id} is ${String(current.status)}; cannot set archived_at without archiving it`,
      };
    }
    return { ok: true, archived_at: patch.archived_at };
  }

  // A status-only change inherits the row's existing anchor, so a status that
  // cannot carry one must not be reachable from a row that has one. 'archived'
  // stamps a fresh anchor and 'active' clears it, so neither can conflict;
  // 'pruned' legitimately keeps the anchor through the retention window.
  if (patch.status !== undefined && patch.archived_at === undefined) {
    if (patch.status === 'archived') {
      return { ok: true, archived_at: now.toISOString() };
    }
    if (patch.status === 'active') {
      return { ok: true, archived_at: null };
    }
    if (patch.status !== 'pruned' && current.archived_at != null) {
      return {
        ok: false,
        reason: `memory ${current.id} has archived_at set; status ${patch.status} must not carry an archive anchor (only archived/pruned memories anchor an archive timestamp)`,
      };
    }
  }

  return { ok: true, archived_at: patch.archived_at };
}

/**
 * Validate and create an Edge with invariants checked.
 */
export function createEdge(input: {
  id: string;
  source_id: string;
  target_id: string;
  relation_type: EdgeRelation;
  strength: number;
  bidirectional?: boolean;
  status?: EdgeStatus;
  created_at?: string;
  classified_at?: string | null;
  classify_hash?: string | null;
  last_failed_at?: string | null;
}): Edge {
  // Validate non-empty identity strings (createMemory's equivalent): SQLite
  // NOT NULL does not reject empty strings, so an empty id/source_id/target_id
  // would otherwise be insertable and unfindable.
  requireNonEmpty('id', input.id);
  requireNonEmpty('source_id', input.source_id);
  requireNonEmpty('target_id', input.target_id);

  // Validate no self-referencing edges
  if (input.source_id === input.target_id) {
    throw new Error('source_id and target_id must not be equal (no self-referencing edges)');
  }

  assertInRange('strength', input.strength, 0, 1);

  if (!isEdgeRelation(input.relation_type)) {
    throw new Error(`invalid relation_type: ${input.relation_type}`);
  }

  // Validate status
  const status = input.status ?? 'active';
  if (!isEdgeStatus(status)) {
    throw new Error(`invalid edge status: ${status}`);
  }

  const now = new Date().toISOString();

  return {
    id: input.id,
    source_id: input.source_id,
    target_id: input.target_id,
    relation_type: input.relation_type,
    strength: input.strength,
    bidirectional: input.bidirectional ?? false,
    status,
    created_at: input.created_at ?? now,
    classified_at: input.classified_at ?? null,
    classify_hash: input.classify_hash ?? null,
    last_failed_at: input.last_failed_at ?? null,
  };
}

/**
 * Validate and create an ExtractionCheckpoint.
 */
export function createExtractionCheckpoint(input: {
  id: string;
  session_id: string;
  cursor_position: number;
  extracted_at?: string;
  transcript_length?: number | null;
  projection_version?: number | null;
}): ExtractionCheckpoint {
  // Validate cursor_position >= 0
  if (Number.isNaN(input.cursor_position) || input.cursor_position < 0) {
    throw new Error(
      `cursor_position must be >= 0, got ${input.cursor_position}`
    );
  }

  // Validate transcript_length >= 0 when provided
  const transcript_length = input.transcript_length ?? null;
  if (transcript_length !== null && (Number.isNaN(transcript_length) || transcript_length < 0)) {
    throw new Error(
      `transcript_length must be >= 0 or null, got ${transcript_length}`
    );
  }

  // Validate projection_version >= 0 when provided
  const projection_version = input.projection_version ?? null;
  if (
    projection_version !== null &&
    (Number.isNaN(projection_version) || projection_version < 0)
  ) {
    throw new Error(
      `projection_version must be >= 0 or null, got ${projection_version}`
    );
  }

  return {
    id: input.id,
    session_id: input.session_id,
    cursor_position: input.cursor_position,
    extracted_at: input.extracted_at ?? new Date().toISOString(),
    transcript_length,
    projection_version,
  };
}

/**
 * Validate and create a MemoryCandidate.
 */
export function createMemoryCandidate(input: {
  content: string;
  summary: string;
  memory_type: MemoryType;
  scope: MemoryScope;
  confidence: number;
  priority: number;
  tags?: readonly string[];
}): MemoryCandidate {
  assertInRange('confidence', input.confidence, 0, 1);
  assertInRange('priority', input.priority, 1, 10);

  if (!isMemoryType(input.memory_type)) {
    throw new Error(`invalid memory_type: ${input.memory_type}`);
  }

  return {
    content: input.content,
    summary: input.summary,
    memory_type: input.memory_type,
    scope: input.scope,
    confidence: input.confidence,
    priority: input.priority,
    tags: [...(input.tags ?? [])],
  };
}

/** Type guard for MemoryType. */
export const isMemoryType = unionGuard(MEMORY_TYPES);

/** Type guard for EdgeRelation. */
export const isEdgeRelation = unionGuard(EDGE_RELATIONS);

/** Type guard for MemoryStatus. */
export const isMemoryStatus = unionGuard(MEMORY_STATUSES);
