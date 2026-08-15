/**
 * Core domain types for Cortex memory system.
 * Uses readonly domain shapes, literal and nominal types, discriminated
 * unions, and factory validation for construction-time invariants.
 */

// ============================================================================
// BRANDED TYPES
// ============================================================================

/** Branded type for memory IDs — prevents argument-swap bugs */
export type MemoryId = string & { readonly __brand: 'MemoryId' };
export const MemoryId = (s: string): MemoryId => s as MemoryId;

/** Branded type for edge IDs */
export type EdgeId = string & { readonly __brand: 'EdgeId' };
export const EdgeId = (s: string): EdgeId => s as EdgeId;

/** Branded type for Gemini embeddings (Float64, 768-dim) */
export type GeminiEmbedding = Float64Array & { readonly __brand: 'GeminiEmbedding' };
export const GeminiEmbedding = (a: Float64Array): GeminiEmbedding => a as GeminiEmbedding;

/** Branded type for local embeddings (Float32; width set by LOCAL_EMBEDDING_DIMENSIONS) */
export type LocalEmbedding = Float32Array & { readonly __brand: 'LocalEmbedding' };
export const LocalEmbedding = (a: Float32Array): LocalEmbedding => a as LocalEmbedding;

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

export function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === 'string' && (MEMORY_SCOPES as readonly string[]).includes(value);
}

// Source Type
export type SourceType = 'extraction' | 'manual' | 'code_index';

export const SOURCE_TYPES: readonly SourceType[] = ['extraction', 'manual', 'code_index'] as const;

export function isSourceType(value: unknown): value is SourceType {
  return typeof value === 'string' && (SOURCE_TYPES as readonly string[]).includes(value);
}

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

export function isEdgeStatus(value: unknown): value is EdgeStatus {
  return typeof value === 'string' && (EDGE_STATUSES as readonly string[]).includes(value);
}

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

// Alias for backward compatibility
export type StopHookInput = HookInput;

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
 * while Jaccard and Gemini-768 cosine are much better separated. Thresholds and
 * classification bands must be calibrated per space.
 *
 * A space is also per MODEL, not merely per family: the 'local-cosine' bands
 * belong to BGE-small-en-v1.5 specifically. See LOCAL_COSINE_CALIBRATED, which
 * keeps an uncalibrated local model out of destructive comparisons entirely.
 */
export type SimilaritySpace = 'jaccard' | 'local-cosine' | 'gemini-cosine';

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
  const trimmedId = input.id.trim();
  if (trimmedId === '') {
    throw new Error('id must not be empty');
  }

  const trimmedContent = input.content.trim();
  if (trimmedContent === '') {
    throw new Error('content must not be empty');
  }

  const trimmedSummary = input.summary.trim();
  if (trimmedSummary === '') {
    throw new Error('summary must not be empty');
  }

  const trimmedSourceSession = input.source_session.trim();
  if (trimmedSourceSession === '') {
    throw new Error('source_session must not be empty');
  }

  // Validate confidence [0, 1]
  if (Number.isNaN(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error(`confidence must be in [0, 1], got ${input.confidence}`);
  }

  // Validate priority [1, 10]
  if (Number.isNaN(input.priority) || input.priority < 1 || input.priority > 10) {
    throw new Error(`priority must be in [1, 10], got ${input.priority}`);
  }

  // Validate memory_type
  if (!MEMORY_TYPES.includes(input.memory_type)) {
    throw new Error(`invalid memory_type: ${input.memory_type}`);
  }

  // Validate scope
  if (input.scope !== undefined && !isMemoryScope(input.scope)) {
    throw new Error(`invalid scope: ${input.scope}`);
  }

  // Validate source_type
  if (input.source_type !== undefined && !isSourceType(input.source_type)) {
    throw new Error(`invalid source_type: ${input.source_type}`);
  }

  // Validate status
  const status = input.status ?? 'active';
  if (!MEMORY_STATUSES.includes(status)) {
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
}): Edge {
  // Validate no self-referencing edges
  if (input.source_id === input.target_id) {
    throw new Error('source_id and target_id must not be equal (no self-referencing edges)');
  }

  // Validate strength [0, 1]
  if (Number.isNaN(input.strength) || input.strength < 0 || input.strength > 1) {
    throw new Error(`strength must be in [0, 1], got ${input.strength}`);
  }

  // Validate relation_type
  if (!EDGE_RELATIONS.includes(input.relation_type)) {
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
  // Validate confidence [0, 1]
  if (Number.isNaN(input.confidence) || input.confidence < 0 || input.confidence > 1) {
    throw new Error(`confidence must be in [0, 1], got ${input.confidence}`);
  }

  // Validate priority [1, 10]
  if (Number.isNaN(input.priority) || input.priority < 1 || input.priority > 10) {
    throw new Error(`priority must be in [1, 10], got ${input.priority}`);
  }

  // Validate memory_type
  if (!MEMORY_TYPES.includes(input.memory_type)) {
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

/**
 * Type guard for MemoryType.
 */
export function isMemoryType(value: unknown): value is MemoryType {
  return (
    typeof value === 'string' &&
    MEMORY_TYPES.includes(value as MemoryType)
  );
}

/**
 * Type guard for EdgeRelation.
 */
export function isEdgeRelation(value: unknown): value is EdgeRelation {
  return (
    typeof value === 'string' &&
    EDGE_RELATIONS.includes(value as EdgeRelation)
  );
}

/**
 * Type guard for MemoryStatus.
 */
export function isMemoryStatus(value: unknown): value is MemoryStatus {
  return (
    typeof value === 'string' &&
    MEMORY_STATUSES.includes(value as MemoryStatus)
  );
}
