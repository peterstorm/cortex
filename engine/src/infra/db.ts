/**
 * SQLite database layer for Cortex memory system
 * Pure I/O boundary - all functions perform side effects
 * Schema management, CRUD operations, and FTS5 search
 */

import { Database } from 'bun:sqlite';
import { randomUUID } from 'crypto';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import type {
  Memory,
  Edge,
  ExtractionCheckpoint,
  MemoryScope,
  MemoryType,
  MemoryStatus,
  SourceType,
  EdgeRelation,
} from '../core/types.js';
import { createMemory, createEdge, createExtractionCheckpoint, isEdgeRelation, isEdgeStatus, isMemoryType, isMemoryStatus, isMemoryScope, resolveArchiveAnchor } from '../core/types.js';
import type { Entity, Fact, EntityType } from '../core/entities.js';
import { createEntity, createFact, isEntityType } from '../core/entities.js';
import { LOCAL_EMBED_MODEL } from '../config.js';

// ============================================================================
// SCHEMA INITIALIZATION
// ============================================================================

const SCHEMA = `
-- Memory table with all domain fields
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  summary TEXT NOT NULL,
  memory_type TEXT NOT NULL,
  scope TEXT NOT NULL,
  embedding BLOB,
  local_embedding BLOB,
  local_embedding_model TEXT,
  confidence REAL NOT NULL,
  priority INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  source_type TEXT NOT NULL,
  source_session TEXT NOT NULL,
  source_context TEXT NOT NULL,
  tags TEXT NOT NULL, -- JSON array
  access_count INTEGER NOT NULL DEFAULT 0,
  last_accessed_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  archived_at TEXT
);

-- Edge table with unique constraint per FR-106
CREATE TABLE IF NOT EXISTS edges (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation_type TEXT NOT NULL,
  strength REAL NOT NULL,
  bidirectional INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  classified_at TEXT,
  classify_hash TEXT,
  last_failed_at TEXT,
  FOREIGN KEY (source_id) REFERENCES memories(id) ON DELETE CASCADE,
  FOREIGN KEY (target_id) REFERENCES memories(id) ON DELETE CASCADE,
  UNIQUE (source_id, target_id, relation_type)
);

-- Extraction checkpoint table
CREATE TABLE IF NOT EXISTS extraction_checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  cursor_position INTEGER NOT NULL,
  extracted_at TEXT NOT NULL,
  transcript_length INTEGER,
  projection_version INTEGER
);

-- FTS5 virtual table for keyword search (FR-101)
-- Using standalone FTS table (not external content) for better Bun compatibility
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED,
  content,
  summary,
  tags
);

-- Triggers to keep FTS5 in sync with memories table
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(id, content, summary, tags)
  VALUES (new.id, new.content, new.summary, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  DELETE FROM memories_fts WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
  DELETE FROM memories_fts WHERE id = old.id;
  INSERT INTO memories_fts(id, content, summary, tags)
  VALUES (new.id, new.content, new.summary, new.tags);
END;

-- Index on status for getActiveMemories optimization
CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status);

-- Index on session_id for checkpoint lookups
CREATE INDEX IF NOT EXISTS idx_checkpoints_session ON extraction_checkpoints(session_id);

-- Indexes on edges for graph traversal
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);

-- Entity table: named things (people, projects, tools, concepts)
CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_entities_name_type
  ON entities(LOWER(name), entity_type);

-- FTS5 for entity name search
CREATE VIRTUAL TABLE IF NOT EXISTS entities_fts USING fts5(
  id UNINDEXED, name, aliases
);

CREATE TRIGGER IF NOT EXISTS entities_ai AFTER INSERT ON entities BEGIN
  INSERT INTO entities_fts(id, name, aliases) VALUES (new.id, new.name, new.aliases);
END;
CREATE TRIGGER IF NOT EXISTS entities_ad AFTER DELETE ON entities BEGIN
  DELETE FROM entities_fts WHERE id = old.id;
END;
CREATE TRIGGER IF NOT EXISTS entities_au AFTER UPDATE ON entities BEGIN
  DELETE FROM entities_fts WHERE id = old.id;
  INSERT INTO entities_fts(id, name, aliases) VALUES (new.id, new.name, new.aliases);
END;

-- Fact table: temporal assertions about entities (subject-predicate-object)
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object TEXT NOT NULL,
  source_memory_id TEXT NOT NULL,
  confidence REAL NOT NULL,
  valid_from TEXT NOT NULL,
  valid_to TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE,
  FOREIGN KEY (source_memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity_id);
CREATE INDEX IF NOT EXISTS idx_facts_source ON facts(source_memory_id);
CREATE INDEX IF NOT EXISTS idx_facts_valid ON facts(valid_to);
`;

/**
 * Current schema version stamped into PRAGMA user_version.
 * Bump when the schema changes in a way old code cannot safely handle.
 */
export const CURRENT_SCHEMA_VERSION = 1;

/**
 * Initialize database schema and enable optimizations
 * I/O: Creates/modifies database file
 *
 * Schema versioning (PRAGMA user_version):
 * - 0 (fresh or legacy DB): run schema + migrations, stamp current version
 * - equal to CURRENT_SCHEMA_VERSION: proceed (schema/migrations are idempotent)
 * - greater than CURRENT_SCHEMA_VERSION: fail fast — old code must not
 *   touch (and potentially corrupt) a newer database
 */
function initializeSchema(db: Database): void {
  // WAL allows only one writer; the SessionEnd pipeline spawns detached
  // workers (semantic-edges, lifecycle, ai-prune) that can collide. Without
  // a busy timeout a collision throws SQLITE_BUSY immediately. Pi records
  // detached output in .memory/logs/pi-detached.log (or inherits output if
  // log setup fails), but the write still needs a bounded retry window.
  // MUST be set BEFORE the WAL pragma: journal_mode=WAL itself takes a write
  // lock, so a concurrent writer would otherwise cause an unprotected
  // SQLITE_BUSY on open.
  db.run('PRAGMA busy_timeout = 5000');

  // Enable WAL mode for concurrent access (FR-100)
  db.run('PRAGMA journal_mode = WAL');

  // Enable foreign key constraints
  db.run('PRAGMA foreign_keys = ON');

  // Schema version check BEFORE any schema mutation
  const versionRow = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const schemaVersion = versionRow.user_version;

  if (schemaVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${schemaVersion} is newer than supported version ` +
        `${CURRENT_SCHEMA_VERSION} — refusing to open (update the cortex plugin)`
    );
  }

  // Execute schema creation (idempotent) + migrations
  db.exec(SCHEMA);

  migrateCheckpointUniqueness(db);
  migrateArchivedAt(db);
  migrateCheckpointTranscriptLength(db);
  migrateCheckpointProjectionVersion(db);
  migrateLocalEmbeddingModel(db);
  migrateEdgeClassifiedAt(db);

  if (schemaVersion < CURRENT_SCHEMA_VERSION) {
    db.run(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
  }
}

/**
 * Idempotent migration: add memories.archived_at for existing databases.
 * CREATE TABLE IF NOT EXISTS won't alter tables that already exist in the
 * wild, so the column is added via a guarded ALTER TABLE.
 *
 * archived_at records WHEN a memory was archived — prune eligibility uses
 * it as a grace period anchor (legacy archived rows keep NULL and fall
 * back to updated_at).
 */
function migrateArchivedAt(db: Database): void {
  const columns = db.prepare(`PRAGMA table_info(memories)`).all() as { name: string }[];
  if (columns.some((c) => c.name === 'archived_at')) return;
  db.run(`ALTER TABLE memories ADD COLUMN archived_at TEXT`);
}

/**
 * Idempotent migration: add edges.classified_at / edges.classify_hash /
 * edges.last_failed_at for existing databases. classified_at + classify_hash
 * record when an edge was last answered by the semantic-edges LLM pass (and
 * the endpoint content hash at that time) so declined/typed edges are not
 * re-classified on every maintenance run. last_failed_at records the last
 * FAILED attempt so a same-content failure is not re-asked within the backoff
 * window (an unhealthy server is not re-hammered every run).
 */
function migrateEdgeClassifiedAt(db: Database): void {
  const columns = db.prepare(`PRAGMA table_info(edges)`).all() as { name: string }[];
  const names = new Set(columns.map((c) => c.name));
  if (!names.has('classified_at')) {
    db.run(`ALTER TABLE edges ADD COLUMN classified_at TEXT`);
  }
  if (!names.has('classify_hash')) {
    db.run(`ALTER TABLE edges ADD COLUMN classify_hash TEXT`);
  }
  if (!names.has('last_failed_at')) {
    db.run(`ALTER TABLE edges ADD COLUMN last_failed_at TEXT`);
  }
}

/**
 * Idempotent migration: add extraction_checkpoints.transcript_length.
 * Stores the transcript content length at checkpoint time so a rewritten
 * (shrunken) transcript can be detected and the cursor reset to 0.
 */
function migrateCheckpointTranscriptLength(db: Database): void {
  const columns = db.prepare(`PRAGMA table_info(extraction_checkpoints)`).all() as { name: string }[];
  if (columns.some((c) => c.name === 'transcript_length')) return;
  db.run(`ALTER TABLE extraction_checkpoints ADD COLUMN transcript_length INTEGER`);
}

/**
 * Idempotent migration: add extraction_checkpoints.projection_version.
 *
 * A cursor is an offset into projected transcript text, so it is only valid
 * under the projection that produced it. Existing rows stay NULL, which reads
 * as "legacy" and forces a reset to 0 on next load: the transcript is
 * re-extracted and dedup absorbs the duplicates. Backfilling a version here
 * would assert a compatibility that does not hold — the legacy cursor was a
 * character offset into the raw file, not a byte offset.
 */
function migrateCheckpointProjectionVersion(db: Database): void {
  const columns = db.prepare(`PRAGMA table_info(extraction_checkpoints)`).all() as { name: string }[];
  if (columns.some((c) => c.name === 'projection_version')) return;
  db.run(`ALTER TABLE extraction_checkpoints ADD COLUMN projection_version INTEGER`);
}

/**
 * Idempotent migration: add memories.local_embedding_model.
 *
 * Vectors from different embedding models are not comparable, and mixing them
 * in one column produces no error — only quietly wrong similarity scores. This
 * column tags each local vector with the model that produced it so reads can
 * filter to one model, making a future model swap safe.
 *
 * Existing rows are left NULL, which excludes them from local similarity
 * search until re-embedded. At the time this landed no row in any database
 * carried a local embedding, so nothing is actually excluded.
 */
function migrateLocalEmbeddingModel(db: Database): void {
  const columns = db.prepare(`PRAGMA table_info(memories)`).all() as { name: string }[];
  if (columns.some((c) => c.name === 'local_embedding_model')) return;
  db.run(`ALTER TABLE memories ADD COLUMN local_embedding_model TEXT`);
}

/**
 * One-time migration: extraction_checkpoints.session_id must be unique so
 * saveExtractionCheckpoint can UPSERT. Older databases may hold duplicate
 * rows from concurrent writers — keep the latest inserted row per session
 * (the highest rowid), then index.
 */
function migrateCheckpointUniqueness(db: Database): void {
  const existing = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_checkpoints_session_unique'`)
    .get();
  if (existing) return;

  db.run(`
    DELETE FROM extraction_checkpoints
    WHERE rowid NOT IN (
      SELECT MAX(rowid) FROM extraction_checkpoints GROUP BY session_id
    )
  `);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_checkpoints_session_unique ON extraction_checkpoints(session_id)`);
}

/**
 * Open or create database at specified path with schema initialization
 * I/O: Opens/creates database file
 *
 * @param path - Database file path (or :memory: for in-memory)
 * @returns Database instance with schema initialized
 */
export function openDatabase(path: string): Database {
  const db = new Database(path);
  initializeSchema(db);
  return db;
}

/**
 * Open an EXISTING database read-only, skipping schema init/migrations.
 *
 * For hot read-only paths (the prompt-recall hook runs on EVERY user prompt):
 * opening read-write + running the full DDL/migration block per prompt is
 * wasted work and takes the writer lock. Throws if the file doesn't exist —
 * callers must check first and fall back to openDatabase when creating.
 *
 * @param path - Existing database file path
 * @returns Read-only database instance (writes throw)
 */
export function openDatabaseReadOnly(path: string): Database {
  return new Database(path, { readonly: true });
}

// ============================================================================
// MEMORY CRUD OPERATIONS
// ============================================================================

/**
 * Serialize Float64Array or Float32Array to Buffer for BLOB storage
 */
function serializeEmbedding(arr: Float64Array | Float32Array): Buffer {
  return Buffer.from(arr.buffer.slice(arr.byteOffset, arr.byteOffset + arr.byteLength));
}

/**
 * Deserialize Buffer to Float64Array
 */
function deserializeFloat64Array(buffer: Buffer): Float64Array {
  return new Float64Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / Float64Array.BYTES_PER_ELEMENT);
}

/**
 * Deserialize Buffer to Float32Array
 */
function deserializeFloat32Array(buffer: Buffer): Float32Array {
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / Float32Array.BYTES_PER_ELEMENT);
}

/**
 * Raw memories-table row shape. Enum-valued columns are typed with the domain
 * unions; SQLite enforces NOT NULL/UNIQUE/FK only, so enum and range
 * invariants are enforced at the application boundary — createMemory on
 * insert, validateMemoryFields on update (see updateMemory).
 */
type MemoryRow = {
  id: string;
  content: string;
  summary: string;
  memory_type: MemoryType;
  scope: MemoryScope;
  embedding: Buffer | null;
  local_embedding: Buffer | null;
  confidence: number;
  priority: number;
  pinned: number;
  source_type: SourceType;
  source_session: string;
  source_context: string;
  tags: string;
  access_count: number;
  last_accessed_at: string;
  created_at: string;
  updated_at: string;
  status: MemoryStatus;
  archived_at: string | null;
};

/**
 * Read a JSON-serialized string array out of a TEXT cell, falling back to `[]`
 * with a diagnostic when the cell is corrupt.
 *
 * One corrupt cell must not abort every read that maps rows: the corrupt-row
 * precedent in this file is warn-with-row-identity and continue (see the
 * local_embedding guard in collectMemoriesWithEmbeddings). The row itself is
 * still readable, so its list field falls back to none.
 *
 * Both corruption shapes warn, which is the whole point of sharing this: a
 * cell holding valid JSON that is not an array (`5`, `null`, `{}`) never
 * enters the catch, and warning only there would degrade silently while
 * claiming parity with a guard that warns unconditionally.
 *
 * @param rowLabel - Row identity for the diagnostic, e.g. `Memory mem-1`.
 * @param column - Column name for the diagnostic, e.g. `tags`.
 */
function parseJsonStringArray(cell: string, rowLabel: string, column: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cell);
  } catch {
    console.warn(`[cortex:db] ${rowLabel}: ${column} deserialized to invalid JSON; falling back to []`);
    return [];
  }
  if (!Array.isArray(parsed)) {
    console.warn(
      `[cortex:db] ${rowLabel}: ${column} deserialized to ${parsed === null ? 'null' : typeof parsed}, not an array; falling back to []`
    );
    return [];
  }
  return parsed as string[];
}

/**
 * Convert a raw database row to a Memory domain object.
 * Pure helper — centralizes the row-to-Memory mapping used by all query functions.
 */
function rowToMemory(row: MemoryRow): Memory {
  const tags = parseJsonStringArray(row.tags, `Memory ${row.id}`, 'tags');

  return createMemory({
    id: row.id,
    content: row.content,
    summary: row.summary,
    memory_type: row.memory_type,
    scope: row.scope,
    embedding: row.embedding ? deserializeFloat64Array(row.embedding) : null,
    local_embedding: row.local_embedding ? deserializeFloat32Array(row.local_embedding) : null,
    confidence: row.confidence,
    priority: row.priority,
    pinned: row.pinned === 1,
    source_type: row.source_type,
    source_session: row.source_session,
    source_context: row.source_context,
    tags,
    access_count: row.access_count,
    last_accessed_at: row.last_accessed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    status: row.status,
    archived_at: row.archived_at ?? null,
  });
}

/**
 * Insert memory into database
 * I/O: Writes to database
 *
 * @param db - Database instance
 * @param memory - Memory to insert (must be valid via createMemory)
 * @returns Generated memory ID
 */
export function insertMemory(db: Database, memory: Memory): string {
  const stmt = db.prepare(`
    INSERT INTO memories (
      id, content, summary, memory_type, scope,
      embedding, local_embedding, local_embedding_model,
      confidence, priority, pinned,
      source_type, source_session, source_context,
      tags, access_count, last_accessed_at,
      created_at, updated_at, status, archived_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    memory.id,
    memory.content,
    memory.summary,
    memory.memory_type,
    memory.scope,
    memory.embedding ? serializeEmbedding(memory.embedding) : null,
    memory.local_embedding ? serializeEmbedding(memory.local_embedding) : null,
    // Tag the producing model alongside the vector — see migrateLocalEmbeddingModel.
    memory.local_embedding ? LOCAL_EMBED_MODEL : null,
    memory.confidence,
    memory.priority,
    memory.pinned ? 1 : 0,
    memory.source_type,
    memory.source_session,
    memory.source_context,
    JSON.stringify(memory.tags),
    memory.access_count,
    memory.last_accessed_at,
    memory.created_at,
    memory.updated_at,
    memory.status,
    memory.archived_at
  );

  return memory.id;
}

/**
 * Validate the mutable Memory fields before an UPDATE. updateMemory bypasses
 * the createMemory factory, so this mirrors its construction-time guards
 * (non-empty text, enum membership, confidence/priority ranges) to keep
 * invalid Memory instances unpublishable through either write path.
 */
function validateMemoryFields(fields: Partial<Memory>, operation: string): void {
  if (fields.content !== undefined && fields.content.trim() === '') {
    throw new Error(`${operation}: content must not be empty`);
  }
  if (fields.summary !== undefined && fields.summary.trim() === '') {
    throw new Error(`${operation}: summary must not be empty`);
  }
  if (fields.memory_type !== undefined && !isMemoryType(fields.memory_type)) {
    throw new Error(`${operation}: invalid memory_type: ${fields.memory_type}`);
  }
  if (fields.status !== undefined && !isMemoryStatus(fields.status)) {
    throw new Error(`${operation}: invalid status: ${fields.status}`);
  }
  if (fields.scope !== undefined && !isMemoryScope(fields.scope)) {
    throw new Error(`${operation}: invalid scope: ${fields.scope}`);
  }
  if (fields.confidence !== undefined &&
      (Number.isNaN(fields.confidence) || fields.confidence < 0 || fields.confidence > 1)) {
    throw new Error(`${operation}: confidence must be in [0, 1], got ${fields.confidence}`);
  }
  if (fields.priority !== undefined &&
      (Number.isNaN(fields.priority) || fields.priority < 1 || fields.priority > 10)) {
    throw new Error(`${operation}: priority must be in [1, 10], got ${fields.priority}`);
  }
}

/**
 * Update memory fields
 * I/O: Writes to database
 *
 * Maintains the status/archived_at coupling: flipping to 'archived' without
 * an archived_at writes the current time (the archive→prune grace-period
 * anchor), flipping to 'active' clears it, and a contradiction (active with
 * a non-null archived_at) is refused.
 *
 * @param db - Database instance
 * @param id - Memory ID to update
 * @param fields - Partial memory fields to update
 */
export function updateMemory(db: Database, id: string, fields: Partial<Memory>): void {
  // Load the row's current coupling state once, decide purely, then persist.
  // The decision itself lives in resolveArchiveAnchor (core/types.ts) because
  // a partial patch can leave either half of the pair implicit, so the rule
  // needs both the patch and the stored row to be evaluated at all.
  const touchesAnchor = fields.status !== undefined || fields.archived_at !== undefined;
  const currentRow = touchesAnchor
    ? db.prepare('SELECT status, archived_at FROM memories WHERE id = ?').get(id) as
        { status?: MemoryStatus; archived_at?: string | null } | null
    : null;
  const resolved = resolveArchiveAnchor(
    { id, status: currentRow?.status, archived_at: currentRow?.archived_at },
    { status: fields.status, archived_at: fields.archived_at },
    new Date()
  );
  if (!resolved.ok) {
    throw new Error(`updateMemory: ${resolved.reason}`);
  }
  if (resolved.archived_at !== fields.archived_at) {
    fields = { ...fields, archived_at: resolved.archived_at };
  }
  validateMemoryFields(fields, 'updateMemory');
  const updates: string[] = [];
  const values: (string | number | Uint8Array | null)[] = [];

  // Build dynamic UPDATE statement based on provided fields
  if (fields.content !== undefined) {
    updates.push('content = ?');
    values.push(fields.content);
  }
  if (fields.summary !== undefined) {
    updates.push('summary = ?');
    values.push(fields.summary);
  }
  if (fields.memory_type !== undefined) {
    updates.push('memory_type = ?');
    values.push(fields.memory_type);
  }
  if (fields.scope !== undefined) {
    updates.push('scope = ?');
    values.push(fields.scope);
  }
  if (fields.embedding !== undefined) {
    updates.push('embedding = ?');
    values.push(fields.embedding ? serializeEmbedding(fields.embedding) : null);
  }
  if (fields.local_embedding !== undefined) {
    updates.push('local_embedding = ?');
    values.push(fields.local_embedding ? serializeEmbedding(fields.local_embedding) : null);
    // The model tag is written with the vector, never separately — otherwise a
    // vector could outlive the record of what produced it.
    updates.push('local_embedding_model = ?');
    values.push(fields.local_embedding ? LOCAL_EMBED_MODEL : null);
  }
  if (fields.confidence !== undefined) {
    updates.push('confidence = ?');
    values.push(fields.confidence);
  }
  if (fields.priority !== undefined) {
    updates.push('priority = ?');
    values.push(fields.priority);
  }
  if (fields.pinned !== undefined) {
    updates.push('pinned = ?');
    values.push(fields.pinned ? 1 : 0);
  }
  if (fields.tags !== undefined) {
    updates.push('tags = ?');
    values.push(JSON.stringify(fields.tags));
  }
  if (fields.access_count !== undefined) {
    updates.push('access_count = ?');
    values.push(fields.access_count);
  }
  if (fields.last_accessed_at !== undefined) {
    updates.push('last_accessed_at = ?');
    values.push(fields.last_accessed_at);
  }
  if (fields.status !== undefined) {
    updates.push('status = ?');
    values.push(fields.status);
  }
  if (fields.archived_at !== undefined) {
    updates.push('archived_at = ?');
    values.push(fields.archived_at);
  }

  // Always update updated_at timestamp
  updates.push('updated_at = ?');
  values.push(new Date().toISOString());

  if (updates.length === 1) {
    // Only updated_at changed, nothing to do
    return;
  }

  values.push(id);

  const query = `UPDATE memories SET ${updates.join(', ')} WHERE id = ?`;
  const stmt = db.prepare(query);

  stmt.run(...values);
}

/**
 * Get memory by ID
 * I/O: Reads from database
 *
 * @param db - Database instance
 * @param id - Memory ID
 * @returns Memory or null if not found
 */
export function getMemory(db: Database, id: string): Memory | null {
  const stmt = db.prepare(`
    SELECT * FROM memories WHERE id = ?
  `);

  const row = stmt.get(id) as MemoryRow | undefined;
  if (!row) {
    return null;
  }

  return rowToMemory(row);
}

/**
 * Get multiple memories by IDs in a single query
 * I/O: Reads from database
 *
 * Defaults to ACTIVE memories only: this function backs recall enrichment
 * and graph traversal, where archived/superseded memories resurfacing as
 * "related" leaks retracted knowledge back into context. Pass 'any' to
 * opt into all statuses explicitly (e.g. traverse --include-archived).
 *
 * @param db - Database instance
 * @param ids - Array of memory IDs
 * @param statuses - Statuses to include (default ['active']), or 'any'
 * @returns Readonly array of memories (matching IDs only)
 */
export function getMemoriesByIds(
  db: Database,
  ids: readonly string[],
  statuses: readonly MemoryStatus[] | 'any' = ['active']
): readonly Memory[] {
  if (ids.length === 0) {
    return [];
  }
  if (statuses !== 'any' && statuses.length === 0) {
    return [];
  }

  // Build parameterized query with placeholders
  const idPlaceholders = ids.map(() => '?').join(',');
  const statusFilter =
    statuses === 'any'
      ? ''
      : ` AND status IN (${statuses.map(() => '?').join(',')})`;
  const stmt = db.prepare(`
    SELECT * FROM memories WHERE id IN (${idPlaceholders})${statusFilter}
  `);

  const params = statuses === 'any' ? [...ids] : [...ids, ...statuses];
  const rows = stmt.all(...params) as MemoryRow[];

  return rows.map(rowToMemory);
}

/**
 * Get all active memories (status='active')
 * I/O: Reads from database
 *
 * @param db - Database instance
 * @returns Readonly array of active memories
 */
export function getActiveMemories(db: Database): readonly Memory[] {
  const stmt = db.prepare(`
    SELECT * FROM memories WHERE status = 'active'
  `);

  const rows = stmt.all() as MemoryRow[];

  return rows.map(rowToMemory);
}

/**
 * Get active memories of the given type matching a file path in source_context.
 * I/O: Reads from database
 *
 * source_context is stored as JSON (serializeSourceContext), so the lookup
 * parses it at the query boundary with json_extract instead of pattern-
 * matching the serialized text: a LIKE over the JSON breaks on paths that
 * contain a backslash or a double quote (their JSON-escaped forms), silently
 * matching no row — and a backslash path could even match a different file's
 * collapsed form. json_extract is exact and parameterized. createMemory does
 * not validate source_context, so a corrupt cell is reachable; json_valid
 * guards it so malformed rows are skipped (no match), never a throw — one
 * bad row must not break a whole index pass.
 */
function getActiveMemoriesByFilePath(
  db: Database,
  memoryType: 'code' | 'code_description',
  filePath: string
): readonly Memory[] {
  const stmt = db.prepare(`
    SELECT * FROM memories
    WHERE status = 'active'
      AND memory_type = ?
      AND CASE WHEN json_valid(source_context)
               THEN json_extract(source_context, '$.file_path') END = ?
  `);
  const rows = stmt.all(memoryType, filePath) as MemoryRow[];

  return rows.map(rowToMemory);
}

/**
 * Get active code memories matching a file path in source_context.
 * I/O: Reads from database
 */
export function getActiveCodeMemoriesByFilePath(
  db: Database,
  filePath: string
): readonly Memory[] {
  return getActiveMemoriesByFilePath(db, 'code', filePath);
}

/**
 * Get active code_description (prose) memories matching a file path in source_context.
 * Used for superseding old prose memories on re-index.
 * I/O: Reads from database
 */
export function getActiveProseMemoriesByFilePath(
  db: Database,
  filePath: string
): readonly Memory[] {
  return getActiveMemoriesByFilePath(db, 'code_description', filePath);
}

/**
 * Get all archived memories (status='archived')
 * I/O: Reads from database
 *
 * @param db - Database instance
 * @returns Readonly array of archived memories
 */
export function getArchivedMemories(db: Database): readonly Memory[] {
  const stmt = db.prepare(`
    SELECT * FROM memories WHERE status = 'archived'
  `);

  const rows = stmt.all() as MemoryRow[];

  return rows.map(rowToMemory);
}

/**
 * SQL predicate selecting rows whose embedding is usable, plus the bound
 * parameters it needs.
 *
 * Vectors must come from the CURRENT model. Vectors from two models share a
 * column but not a vector space, and comparing across them returns
 * plausible-looking scores rather than an error — the failure mode is "semantic
 * search got a bit worse", which is invisible.
 *
 * Both read paths (all-rows and by-IDs) build their predicate here so the
 * guarantee cannot hold on one and silently lapse on the other.
 */
function embeddingPredicate(): {
  readonly sql: string;
  readonly params: readonly string[];
} {
  return {
    sql: `local_embedding IS NOT NULL AND local_embedding_model = ?`,
    params: [LOCAL_EMBED_MODEL],
  };
}

/**
 * Fetch all active memories that carry a usable embedding.
 * I/O only — returns raw candidates for pure ranking in core/similarity.ts.
 *
 * @param db - Database instance
 * @returns Readonly array of {memory, embedding} pairs
 */
export function getMemoriesWithEmbedding(
  db: Database
): readonly { memory: Memory; embedding: Float32Array }[] {
  const pred = embeddingPredicate();
  const stmt = db.prepare(
    `SELECT * FROM memories WHERE ${pred.sql} AND status = 'active'`
  );

  const rows = stmt.all(...pred.params) as MemoryRow[];

  return collectMemoriesWithEmbeddings(rows);
}

/**
 * Shared row loop for the two embedding read paths: map each row, skip rows
 * whose local_embedding cannot deserialize (with the #9 diagnostic), keep the
 * rest. Both paths must apply the same skip policy — a row skipped in one
 * path and returned in the other would rank differently by query shape.
 */
function collectMemoriesWithEmbeddings(
  rows: readonly MemoryRow[]
): { memory: Memory; embedding: Float32Array }[] {
  const results: { memory: Memory; embedding: Float32Array }[] = [];

  for (const row of rows) {
    const memory = rowToMemory(row);

    const memoryEmbedding = memory.local_embedding;
    if (!memoryEmbedding) {
      // Skip corrupt row instead of crashing (#9)
      console.warn(`[cortex:db] Skipping memory ${memory.id}: local_embedding deserialized to null`);
      continue;
    }

    results.push({ memory, embedding: memoryEmbedding });
  }

  return results;
}

/**
 * Search memories by keyword using FTS5
 * I/O: Reads from database
 *
 * @param db - Database instance
 * @param query - Keyword search query (FTS5 syntax)
 * @param limit - Maximum number of results
 * @returns Readonly array of memories ranked by FTS5 relevance
 */
export function searchByKeyword(
  db: Database,
  query: string,
  limit: number
): readonly Memory[] {
  // Split into tokens and search with FTS5 implicit-AND semantics (the same
  // joiner as searchByKeywordAnd); token quoting is buildFts5Query's job.
  return searchByKeywordWithJoiner(db, query.split(/\s+/), limit, ' ');
}

/**
 * Search memories by keyword using FTS5 with OR semantics
 * I/O: Reads from database
 *
 * @param db - Database instance
 * @param tokens - Pre-tokenized keywords (caller handles stop-word filtering)
 * @param limit - Maximum number of results
 * @returns Readonly array of active memories ranked by FTS5 relevance
 */
export function searchByKeywordOr(
  db: Database,
  tokens: readonly string[],
  limit: number
): readonly Memory[] {
  return searchByKeywordWithJoiner(db, tokens, limit, ' OR ');
}

/**
 * Search memories where ALL tokens appear (FTS5 implicit-AND).
 * Stricter than OR — only returns memories matching every token.
 * Caller should fall back to OR if this returns empty for short prompts.
 *
 * @param db - Database instance
 * @param tokens - Pre-tokenized keywords (caller handles stop-word filtering)
 * @param limit - Maximum number of results
 * @returns Readonly array of active memories ranked by FTS5 relevance
 */
export function searchByKeywordAnd(
  db: Database,
  tokens: readonly string[],
  limit: number
): readonly Memory[] {
  return searchByKeywordWithJoiner(db, tokens, limit, ' ');
}

function searchByKeywordWithJoiner(
  db: Database,
  tokens: readonly string[],
  limit: number,
  joiner: ' ' | ' OR '
): readonly Memory[] {
  if (tokens.length === 0) return [];

  const stmt = db.prepare(`
    SELECT m.*
    FROM memories m
    JOIN memories_fts fts ON m.id = fts.id
    WHERE memories_fts MATCH ?
    AND m.status = 'active'
    ORDER BY rank
    LIMIT ?
  `);

  const safeQuery = buildFts5Query(tokens, joiner);

  // MATCH '' is an FTS5 syntax error — empty/whitespace tokens mean no results
  if (safeQuery.length === 0) return [];

  const rows = stmt.all(safeQuery, limit) as MemoryRow[];

  return rows.map(rowToMemory);
}

/**
 * Build a safe FTS5 MATCH expression from raw tokens: each token is
 * double-quote-escaped and wrapped in quotes, so FTS5 syntax operators (e.g.
 * hyphens in UUIDs being parsed as column/NOT operators) can never be
 * injected. The joiner picks the semantics: ' ' is FTS5 implicit AND,
 * ' OR ' is OR. Pure; shared by every FTS5 MATCH builder in this file.
 */
function buildFts5Query(tokens: readonly string[], joiner: ' ' | ' OR '): string {
  return tokens
    .filter(t => t.length > 0)
    .map(t => '"' + t.replace(/"/g, '""') + '"')
    .join(joiner);
}

/**
 * Fetch memories with embeddings filtered to a set of IDs.
 * Used by semantic pre-filter: FTS5 narrows candidates, then cosine ranks the subset.
 * I/O: Reads from database
 */
export function getMemoriesWithEmbeddingByIds(
  db: Database,
  ids: readonly string[]
): readonly { memory: Memory; embedding: Float32Array }[] {
  if (ids.length === 0) return [];

  const placeholders = ids.map(() => '?').join(',');
  const pred = embeddingPredicate();
  const stmt = db.prepare(`
    SELECT * FROM memories WHERE id IN (${placeholders}) AND ${pred.sql} AND status = 'active'
  `);

  const rows = stmt.all(...ids, ...pred.params) as MemoryRow[];

  return collectMemoriesWithEmbeddings(rows);
}

/**
 * Get the most recent created_at timestamp across all active/archived memories.
 * Used by lifecycle --if-needed to detect new memories since last run.
 * I/O: Reads from database
 *
 * @param db - Database instance
 * @returns ISO timestamp string or null if no memories exist
 */
export function getLatestMemoryTimestamp(db: Database): string | null {
  const stmt = db.prepare(`
    SELECT MAX(created_at) as latest FROM memories WHERE status IN ('active', 'archived')
  `);
  const row = stmt.get() as { latest: string | null } | null;
  return row?.latest ?? null;
}

// ============================================================================
// EDGE CRUD OPERATIONS
// ============================================================================

/**
 * Insert edge into database
 * I/O: Writes to database
 *
 * @param db - Database instance
 * @param edge - Edge to insert (without id and created_at; classified_at/classify_hash/last_failed_at optional, default null)
 * @returns Generated edge ID
 * @throws If unique constraint violated (duplicate edge)
 */
export function insertEdge(
  db: Database,
  edge: Omit<Edge, 'id' | 'created_at' | 'classified_at' | 'classify_hash' | 'last_failed_at'> & {
    classified_at?: string | null;
    classify_hash?: string | null;
    last_failed_at?: string | null;
  }
): string {
  const id = randomUUID();
  const created_at = new Date().toISOString();

  const validated = createEdge({
    id,
    source_id: edge.source_id,
    target_id: edge.target_id,
    relation_type: edge.relation_type,
    strength: edge.strength,
    bidirectional: edge.bidirectional,
    status: edge.status,
    created_at,
    classified_at: edge.classified_at ?? null,
    classify_hash: edge.classify_hash ?? null,
    last_failed_at: edge.last_failed_at ?? null,
  });

  const stmt = db.prepare(`
    INSERT INTO edges (id, source_id, target_id, relation_type, strength, bidirectional, status, created_at, classified_at, classify_hash, last_failed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    validated.id,
    validated.source_id,
    validated.target_id,
    validated.relation_type,
    validated.strength,
    validated.bidirectional ? 1 : 0,
    validated.status,
    validated.created_at,
    validated.classified_at,
    validated.classify_hash,
    validated.last_failed_at
  );

  return validated.id;
}

/**
 * Get all edges for a memory (both outgoing and incoming if bidirectional)
 * I/O: Reads from database
 *
 * @param db - Database instance
 * @param memoryId - Memory ID
 * @returns Readonly array of edges
 */
export function getEdgesForMemory(db: Database, memoryId: string): readonly Edge[] {
  const stmt = db.prepare(`
    SELECT * FROM edges
    WHERE (source_id = ? OR (target_id = ? AND bidirectional = 1))
    AND status IN ('active', 'suggested')
  `);

  const rows = stmt.all(memoryId, memoryId) as unknown as EdgeRow[];

  return edgeRowsToEdges(rows);
}

/**
 * Get all active or suggested edges in the database.
 * Archived edges are intentionally excluded.
 * I/O: Reads from database
 *
 * @param db - Database instance
 * @returns Readonly array of active/suggested edges
 */
export function getAllEdges(db: Database): readonly Edge[] {
  const stmt = db.prepare(`SELECT * FROM edges WHERE status IN ('active', 'suggested')`);
  const rows = stmt.all() as unknown as EdgeRow[];

  return edgeRowsToEdges(rows);
}

/**
 * Get all 'relates_to' edges (similarity pre-filter candidates produced by
 * hybrid local-embedding/Jaccard matching)
 * I/O: Reads from database
 *
 * @param db - Database instance
 * @returns Readonly array of relates_to edges
 */
export function getRelatesToEdges(db: Database): readonly Edge[] {
  const stmt = db.prepare(`
    SELECT * FROM edges WHERE relation_type = 'relates_to' AND status IN ('active', 'suggested')
  `);

  return edgeRowsToEdges(stmt.all() as unknown as EdgeRow[]);
}

/**
 * Slim endpoint-memory projection used by the classification pre-filter.
 *
 * memory_type is read straight off the joined memories row, NOT through
 * rowToMemory, so nothing on this path re-checks it — the value is validated
 * here at the boundary (see getRelatesToEdgesWithMemories) rather than assumed
 * from the insert-time createMemory call.
 */
export interface EdgeEndpointMemory {
  readonly id: string;
  readonly content: string;
  readonly summary: string;
  readonly memory_type: MemoryType;
}

export interface EdgeWithMemories {
  readonly edge: Edge;
  readonly source: EdgeEndpointMemory;
  readonly target: EdgeEndpointMemory;
}

/**
 * Get relates_to edges joined with their endpoint memories.
 *
 * Returns all active/suggested relates_to edges; the caller selects
 * never-attempted (classified_at IS NULL) or content-changed candidates by
 * comparing a content hash against edge.classify_hash. One query replaces
 * N×2 getMemory lookups.
 */
export function getRelatesToEdgesWithMemories(db: Database): readonly EdgeWithMemories[] {
  const stmt = db.prepare(`
    SELECT
      e.*,
      s.content AS s_content, s.summary AS s_summary, s.memory_type AS s_memory_type,
      t.content AS t_content, t.summary AS t_summary, t.memory_type AS t_memory_type
    FROM edges e
    JOIN memories s ON s.id = e.source_id
    JOIN memories t ON t.id = e.target_id
    WHERE e.relation_type = 'relates_to'
      AND e.status IN ('active', 'suggested')
    ORDER BY e.created_at
  `);

  const rows = stmt.all() as unknown as Array<EdgeRow & {
    s_content: string; s_summary: string; s_memory_type: string;
    t_content: string; t_summary: string; t_memory_type: string;
  }>;
  return rows.flatMap((row) => {
    const edge = rowToEdge(row);
    if (edge === null) return [];

    // The endpoint memory_type values bypass rowToMemory entirely on this raw
    // JOIN, so they get the same validate-and-drop treatment rowToEdge gives
    // relation_type one function below. Feeding an out-of-domain type into a
    // classification prompt with no diagnostic is the failure this prevents.
    if (!isMemoryType(row.s_memory_type) || !isMemoryType(row.t_memory_type)) {
      console.warn(
        `[cortex:db] Skipping edge ${row.id}: invalid endpoint memory_type ` +
        `(source '${row.s_memory_type}', target '${row.t_memory_type}')`
      );
      return [];
    }

    return [
      {
        edge,
        source: {
          id: row.source_id,
          content: row.s_content,
          summary: row.s_summary,
          memory_type: row.s_memory_type,
        },
        target: {
          id: row.target_id,
          content: row.t_content,
          summary: row.t_summary,
          memory_type: row.t_memory_type,
        },
      },
    ];
  });
}

/**
 * Record that an edge was attempted by the semantic classification pass,
 * along with the endpoint content hash at attempt time. Idempotent; missing
 * edges (already replaced) are a no-op.
 */
export function markEdgeClassified(
  db: Database,
  edgeId: string,
  at: string,
  contentHash: string
): void {
  // An answered edge clears any prior failure record: the backoff only makes
  // sense while the edge is still unclassified.
  db.prepare(`UPDATE edges SET classified_at = ?, classify_hash = ?, last_failed_at = NULL WHERE id = ?`).run(
    at,
    contentHash,
    edgeId
  );
}

/**
 * Record a FAILED semantic-classification attempt for an edge: the failure
 * timestamp plus the endpoint content hash at failure time, so candidate
 * selection can apply the failure backoff (skip while the content is
 * unchanged and the failure is recent; re-ask once the backoff elapses, and
 * immediately when the content changed, since that is new information).
 * Never sets classified_at — a failure must not make the edge look answered.
 */
export function markEdgeFailed(
  db: Database,
  edgeId: string,
  at: string,
  contentHash: string
): void {
  db.prepare(`UPDATE edges SET last_failed_at = ?, classify_hash = ? WHERE id = ?`).run(
    at,
    contentHash,
    edgeId
  );
}

/**
 * Count active memories created after the given ISO8601 timestamp.
 * This is the AI-prune watermark: "new work since the last successful
 * prune". Archived memories are excluded (they are not in the review
 * population); the watermark timestamp comes from telemetry.
 */
export function countActiveMemoriesCreatedAfter(db: Database, sinceIso: string): number {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM memories WHERE status = 'active' AND created_at > ?`
  ).get(sinceIso) as { n: number };
  return row.n;
}

/**
 * Raw edges-table row shape, the counterpart to MemoryRow. Declared for the
 * same reason: an untyped `Record<string, unknown>` lets a column addition or
 * rename drift past the compiler and surface as a silent runtime miscoercion.
 * That is exactly the class of defect r44's dropped last_failed_at belonged
 * to. `relation_type` and `status` stay `string` here because they are the
 * unvalidated cell values — rowToEdge narrows them to the domain unions.
 */
type EdgeRow = {
  id: string;
  source_id: string;
  target_id: string;
  relation_type: string;
  strength: number;
  bidirectional: number;
  status: string;
  created_at: string;
  classified_at: string | null;
  classify_hash: string | null;
  last_failed_at: string | null;
};

/**
 * Map one edges-table row to an Edge, or null (with a stderr diagnostic) when
 * relation_type is not a domain value. Every edge read path routes through
 * this single mapper: r44's last_failed_at omission lived in four separate
 * copies of this mapping, where one drifted copy silently falsified the
 * failure-backoff signal — a shared mapper makes that drift structurally
 * impossible and keeps the invalid-row drop diagnosable in every path.
 */
function rowToEdge(row: EdgeRow): Edge | null {
  // Narrowed into consts because the guards below do not survive into the
  // readRow closure — a property narrowing is discarded at the callback
  // boundary, and re-casting there would undo the parsing these guards do.
  const relationType = row.relation_type;
  const status = row.status;
  if (!isEdgeRelation(relationType)) {
    console.warn(`[cortex:db] Skipping edge ${row.id}: invalid relation_type '${relationType}'`);
    return null;
  }
  // status gets the same treatment as relation_type rather than a cast: both
  // are unvalidated cell values, and createEdge throws on an invalid status.
  // A cast would turn one corrupt cell into an exception thrown out of every
  // edge read in the process — none of the four callers catch it — instead of
  // dropping the one unreadable row the way this mapper already promises.
  if (!isEdgeStatus(status)) {
    console.warn(`[cortex:db] Skipping edge ${row.id}: invalid status '${status}'`);
    return null;
  }
  return readRow(`edge ${row.id}`, () =>
    createEdge({
      id: row.id,
      source_id: row.source_id,
      target_id: row.target_id,
      relation_type: relationType,
      strength: Number(row.strength),
      bidirectional: row.bidirectional === 1,
      status,
      created_at: row.created_at,
      classified_at: row.classified_at ?? null,
      classify_hash: row.classify_hash ?? null,
      last_failed_at: row.last_failed_at ?? null,
    })
  );
}

/**
 * Construct a domain object from a row, dropping the row (with a diagnostic)
 * when its constructor refuses it.
 *
 * The union-cell guards in the mappers below parse what the TYPE system needs —
 * a `string` column narrowed to `EdgeStatus`/`EntityType` before it reaches a
 * factory that demands one. They cannot cover the VALUE invariants the factory
 * also enforces (empty name, empty predicate, confidence outside [0,1],
 * strength outside [0,1]), and re-stating those in each mapper would put the
 * same rules in two places for the same rows.
 *
 * So the factory stays the single owner of the invariants and this turns its
 * refusal into the outcome every read path here already promises: one
 * unreadable row is skipped and named, not an exception thrown out of every
 * read in the process. The scope is deliberately one constructor call — this is
 * a corrupt-cell boundary, not a catch-all around I/O.
 */
function readRow<T>(rowLabel: string, construct: () => T): T | null {
  try {
    return construct();
  } catch (err) {
    console.warn(`[cortex:db] Skipping ${rowLabel}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Map rows through a mapper that drops unreadable ones. */
function readRows<R, T>(rows: readonly R[], map: (row: R) => T | null): readonly T[] {
  return rows.flatMap((row) => {
    const mapped = map(row);
    return mapped === null ? [] : [mapped];
  });
}

function edgeRowsToEdges(rows: readonly EdgeRow[]): readonly Edge[] {
  return readRows(rows, rowToEdge);
}

/** Narrow a SQLite cell to a string (columns are NOT NULL by schema). */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}

/**
 * Delete an edge by ID
 * I/O: Writes to database
 *
 * @param db - Database instance
 * @param edgeId - Edge ID to delete
 */
export function deleteEdge(db: Database, edgeId: string): void {
  db.prepare(`DELETE FROM edges WHERE id = ?`).run(edgeId);
}

/**
 * Soft-delete (archive) all edges connected to a memory.
 * Used on memory archive — preserves edges for potential recovery.
 * I/O: Writes to database
 *
 * @param db - Database instance
 * @param memoryId - Memory ID whose edges to archive
 * @returns Number of edges archived
 */
export function archiveEdgesForMemory(db: Database, memoryId: string): number {
  const result = db.prepare(
    `UPDATE edges SET status = 'archived' WHERE source_id = ? OR target_id = ?`
  ).run(memoryId, memoryId);
  return result.changes;
}

/**
 * Delete all edges connected to a memory (source or target)
 * I/O: Writes to database
 *
 * @param db - Database instance
 * @param memoryId - Memory ID whose edges to remove
 * @returns Number of edges deleted
 */
export function deleteEdgesForMemory(db: Database, memoryId: string): number {
  const result = db.prepare(`DELETE FROM edges WHERE source_id = ? OR target_id = ?`).run(memoryId, memoryId);
  return result.changes;
}

/**
 * Re-point all non-supersedes edges from one memory to another.
 * Used when merging memories: the merged memory inherits the graph
 * connections (source_of pairings, typed semantic edges) of its members
 * instead of starting with zero connections.
 *
 * Handles:
 * - Self-references: edges that would connect toId to itself after
 *   re-pointing (e.g. an edge between the two merged members) are dropped.
 * - Unique constraint: edges that would duplicate an existing
 *   (source, target, relation_type) triple after re-pointing are dropped.
 * - Supersedes edges are left untouched (they record merge history).
 *
 * I/O: Writes to database. Caller should wrap in a transaction.
 *
 * @param db - Database instance
 * @param fromId - Memory ID whose edges to re-point
 * @param toId - Memory ID that inherits the edges (must exist)
 * @returns Number of edges re-pointed
 */
export function repointEdgesToMemory(db: Database, fromId: string, toId: string): number {
  // Drop edges that would self-reference after re-pointing
  db.prepare(`
    DELETE FROM edges
    WHERE relation_type != 'supersedes'
      AND ((source_id = ? AND target_id = ?) OR (source_id = ? AND target_id = ?))
  `).run(fromId, toId, toId, fromId);

  // Drop edges that would violate the (source, target, relation) unique
  // constraint after re-pointing the source side
  db.prepare(`
    DELETE FROM edges
    WHERE relation_type != 'supersedes'
      AND source_id = ?
      AND EXISTS (
        SELECT 1 FROM edges e2
        WHERE e2.source_id = ?
          AND e2.target_id = edges.target_id
          AND e2.relation_type = edges.relation_type
      )
  `).run(fromId, toId);

  // Same for the target side
  db.prepare(`
    DELETE FROM edges
    WHERE relation_type != 'supersedes'
      AND target_id = ?
      AND EXISTS (
        SELECT 1 FROM edges e2
        WHERE e2.target_id = ?
          AND e2.source_id = edges.source_id
          AND e2.relation_type = edges.relation_type
      )
  `).run(fromId, toId);

  // Re-point surviving edges
  const r1 = db.prepare(
    `UPDATE edges SET source_id = ? WHERE source_id = ? AND relation_type != 'supersedes'`
  ).run(toId, fromId);
  const r2 = db.prepare(
    `UPDATE edges SET target_id = ? WHERE target_id = ? AND relation_type != 'supersedes'`
  ).run(toId, fromId);

  return r1.changes + r2.changes;
}

/**
 * Re-point facts sourced from one memory to another.
 * Used when merging memories so facts don't dangle on superseded members.
 * I/O: Writes to database
 *
 * @returns Number of facts re-pointed
 */
export function repointFactSources(db: Database, fromId: string, toId: string): number {
  const result = db.prepare(
    `UPDATE facts SET source_memory_id = ? WHERE source_memory_id = ?`
  ).run(toId, fromId);
  return result.changes;
}

/**
 * Hard-delete pruned memories older than retentionDays.
 * Permanently removes data to reclaim space. Run after lifecycle.
 * I/O: Deletes from database
 *
 * @param db - Database instance
 * @param retentionDays - Days to keep pruned memories before hard-delete
 * @returns Number of memories permanently deleted
 */
export function vacuumPrunedMemories(db: Database, retentionDays: number): number {
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const result = db.prepare(
    `DELETE FROM memories WHERE status = 'pruned' AND updated_at < ?`
  ).run(cutoff);
  return result.changes;
}

// ============================================================================
// EXTRACTION CHECKPOINT OPERATIONS
// ============================================================================

/**
 * Raw extraction_checkpoints row shape. Declared for the same reason as
 * MemoryRow and EdgeRow: an `as any` here lets a column rename drift past the
 * compiler and reach createExtractionCheckpoint as undefined, which is exactly
 * the silent-column-drift class the typed rows exist to prevent.
 */
type ExtractionCheckpointRow = {
  id: string;
  session_id: string;
  cursor_position: number;
  extracted_at: string;
  transcript_length: number | null;
  projection_version: number | null;
};

/**
 * Get extraction checkpoint for session
 * I/O: Reads from database
 *
 * @param db - Database instance
 * @param sessionId - Session ID
 * @returns Checkpoint or null if not found
 */
export function getExtractionCheckpoint(
  db: Database,
  sessionId: string
): ExtractionCheckpoint | null {
  const stmt = db.prepare(`
    SELECT * FROM extraction_checkpoints WHERE session_id = ?
  `);

  const row = stmt.get(sessionId) as ExtractionCheckpointRow | null;
  if (!row) {
    return null;
  }

  return createExtractionCheckpoint({
    id: row.id,
    session_id: row.session_id,
    cursor_position: row.cursor_position,
    extracted_at: row.extracted_at,
    transcript_length: row.transcript_length ?? null,
    projection_version: row.projection_version ?? null,
  });
}

/**
 * Save or update extraction checkpoint
 * I/O: Writes to database
 *
 * @param db - Database instance
 * @param checkpoint - Checkpoint to save (without id)
 */
export function saveExtractionCheckpoint(
  db: Database,
  checkpoint: Omit<ExtractionCheckpoint, 'id' | 'transcript_length' | 'projection_version'> & {
    readonly transcript_length?: number | null;
    readonly projection_version?: number | null;
  }
): void {
  // Respect caller's extracted_at if provided, otherwise use current timestamp
  const extracted_at = checkpoint.extracted_at ?? new Date().toISOString();

  const validated = createExtractionCheckpoint({
    id: randomUUID(),
    session_id: checkpoint.session_id,
    cursor_position: checkpoint.cursor_position,
    extracted_at,
    transcript_length: checkpoint.transcript_length ?? null,
    projection_version: checkpoint.projection_version ?? null,
  });

  // Atomic UPSERT — a check-then-insert would let two concurrent workers
  // both observe "no checkpoint" and insert duplicate rows.
  const stmt = db.prepare(`
    INSERT INTO extraction_checkpoints (id, session_id, cursor_position, extracted_at, transcript_length, projection_version)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      cursor_position = excluded.cursor_position,
      extracted_at = excluded.extracted_at,
      transcript_length = excluded.transcript_length,
      projection_version = excluded.projection_version
  `);

  stmt.run(
    validated.id,
    validated.session_id,
    validated.cursor_position,
    validated.extracted_at,
    validated.transcript_length,
    validated.projection_version
  );
}

// ============================================================================
// WHOLE-DATABASE SNAPSHOT/RESTORE FOR CONSOLIDATION SAFETY
//
// Named "snapshot", not "checkpoint": an ExtractionCheckpoint is a transcript
// resume cursor, and these are a full-database VACUUM INTO backup. They are
// unrelated concepts, and while both wore the word "checkpoint" as sibling
// exports of this module nothing in the names told a reader — or a future
// edit — which of the two it was touching.
// ============================================================================

/**
 * Validate path to prevent SQL injection via single quote
 * @throws if path contains single quote
 */
function validatePath(path: string): void {
  if (path.includes("'")) {
    throw new Error('Path contains invalid character: single quote');
  }
}

/**
 * Create a whole-database snapshot (backup).
 * I/O: Creates backup file using VACUUM INTO
 *
 * Only the DESTINATION differs between an on-disk database and an in-memory
 * one; the timestamp, the injection check and the VACUUM are the same work, so
 * the branch picks a path and the single write below runs it.
 *
 * @param db - Database instance
 * @returns Path to the snapshot file
 */
export function createDbSnapshot(db: Database): string {
  const filename = db.filename;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const isInMemory = !filename || filename === ':memory:';

  const snapshotPath = isInMemory
    ? joinPath(tmpdir(), `cortex-snapshot-${timestamp}.db`)
    : `${filename}.snapshot-${timestamp}`;

  // Validate path to prevent SQL injection
  validatePath(snapshotPath);

  // Use VACUUM INTO to create a backup
  db.run(`VACUUM INTO '${snapshotPath}'`);

  return snapshotPath;
}

/**
 * Allowlist of known table names to prevent SQL injection
 */
const ALLOWED_TABLES = new Set(['memories', 'edges', 'extraction_checkpoints', 'entities', 'facts']);

/**
 * Validate table name against allowlist
 * @throws if table name not in allowlist
 */
function validateTableName(name: string): void {
  if (!ALLOWED_TABLES.has(name)) {
    throw new Error(`Table name not in allowlist: ${name}`);
  }
}

/**
 * Restore the database from a whole-database snapshot.
 *
 * Validates and attaches the snapshot to the open database, validates every
 * copied table, transactionally replaces main-table contents and cleans FTS
 * orphans, then detaches the snapshot even when restoration fails.
 *
 * @param db - Database instance
 * @param snapshotPath - Path to the snapshot file
 */
export function restoreDbSnapshot(db: Database, snapshotPath: string): void {
  // Validate path to prevent SQL injection
  validatePath(snapshotPath);

  // Attach the snapshot database and copy all data
  db.run(`ATTACH DATABASE '${snapshotPath}' AS snapshot`);

  try {
    // Get all regular table names from the snapshot (exclude FTS tables)
    const tables = db.query(`
      SELECT name FROM snapshot.sqlite_master
      WHERE type='table'
        AND name NOT LIKE 'sqlite_%'
        AND name NOT LIKE '%_fts%'
    `).all() as { name: string }[];

    // Validate every table name BEFORE mutating anything — a mid-loop
    // failure would otherwise leave the database half-restored.
    for (const { name } of tables) {
      validateTableName(name);
    }

    // All-or-nothing restore: a partial restore is worse than no restore.
    const tx = db.transaction(() => {
      for (const { name } of tables) {
        // Use double quotes for table identifiers (SQL standard)
        db.run(`DELETE FROM main."${name}"`);
        db.run(`INSERT INTO main."${name}" SELECT * FROM snapshot."${name}"`);
      }

      // The insert triggers resync FTS rows for restored ids, but FTS rows
      // whose ids are ABSENT from the restored tables would linger as
      // orphans (phantom search hits). Clean them up explicitly.
      db.run(`DELETE FROM memories_fts WHERE id NOT IN (SELECT id FROM main.memories)`);
      db.run(`DELETE FROM entities_fts WHERE id NOT IN (SELECT id FROM main.entities)`);
    });
    tx();
  } finally {
    // Always detach — a stuck ATTACH makes every retry fail with
    // "database snapshot is already in use".
    db.run('DETACH DATABASE snapshot');
  }
}

// ============================================================================
// SCOPE ROUTING
// ============================================================================

/**
 * Route to appropriate database based on memory scope
 * Pure function - accepts pre-opened databases
 *
 * @param scope - Memory scope (project or global)
 * @param projectDb - Pre-opened project database
 * @param globalDb - Pre-opened global database
 * @returns Database instance for the scope
 */
export function routeToDatabase(
  scope: MemoryScope,
  projectDb: Database,
  globalDb: Database
): Database {
  return scope === 'project' ? projectDb : globalDb;
}

// ============================================================================
// ENTITY CRUD OPERATIONS
// ============================================================================

/**
 * Upsert entity by name + type (case-insensitive match).
 * Returns existing entity ID if found, otherwise inserts and returns new ID.
 * I/O: Reads/writes database
 */
export function upsertEntity(
  db: Database,
  name: string,
  entityType: EntityType,
  aliases: readonly string[] = []
): string {
  // Try exact match first (case-insensitive). Only the id is read back, so the
  // row is narrowed to the one column this path uses rather than cast to `any`.
  const existing = db.prepare(
    `SELECT id FROM entities WHERE LOWER(name) = LOWER(?) AND entity_type = ?`
  ).get(name, entityType) as { id: string } | null;

  if (existing) {
    return existing.id;
  }

  const id = randomUUID();
  const now = new Date().toISOString();
  const entity = createEntity({
    id,
    name,
    entity_type: entityType,
    aliases,
    created_at: now,
    updated_at: now,
  });

  db.prepare(`
    INSERT INTO entities (id, name, entity_type, aliases, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(entity.id, entity.name, entity.entity_type, JSON.stringify(entity.aliases), entity.created_at, entity.updated_at);

  return entity.id;
}

/**
 * Get entity by exact name (case-insensitive).
 * I/O: Reads from database
 */
export function getEntityByName(db: Database, name: string): Entity | null {
  const row = db.prepare(
    `SELECT * FROM entities WHERE LOWER(name) = LOWER(?)`
  ).get(name) as Record<string, unknown> | undefined;

  if (!row) return null;

  return rowToEntity(row);
}

/**
 * Search entities via FTS5 on name and aliases.
 * I/O: Reads from database
 */
export function searchEntities(
  db: Database,
  query: string,
  limit: number = 10
): readonly Entity[] {
  const safeQuery = buildFts5Query(query.split(/\s+/), ' OR ');

  if (safeQuery.length === 0) return [];

  const rows = db.prepare(`
    SELECT e.*
    FROM entities e
    JOIN entities_fts fts ON e.id = fts.id
    WHERE entities_fts MATCH ?
    LIMIT ?
  `).all(safeQuery, limit) as unknown as Array<Record<string, unknown>>;

  return readRows(rows, rowToEntity);
}

/**
 * Get all entities from database, ordered by name.
 * I/O: Reads from database
 */
export function getAllEntities(db: Database): readonly Entity[] {
  const rows = db.prepare(
    `SELECT * FROM entities ORDER BY name`
  ).all() as unknown as Array<Record<string, unknown>>;

  return readRows(rows, rowToEntity);
}

/**
 * Centralizes the row-to-Entity mapping used by all entity query functions
 * (the same convention as rowToMemory and the edge mappers).
 *
 * `aliases` goes through the same corrupt-cell guard as Memory.tags: this
 * mapper backs getEntityByName, searchEntities and getAllEntities, so an
 * unguarded JSON.parse would let one bad cell throw a context-free SyntaxError
 * out of every entity read rather than degrade that one row.
 *
 * `entity_type` gets the treatment rowToEdge's status does, for the same
 * reason: it is an unvalidated cell that createEntity refuses, and a cast would
 * turn one corrupt row into an exception thrown out of all three readers —
 * none of which catch it — instead of dropping the row it belongs to. There is
 * no CHECK constraint on the column, so the guard is the only thing standing
 * between a hand-edited or migrated cell and every entity read.
 */
function rowToEntity(row: Record<string, unknown>): Entity | null {
  const id = asString(row.id);
  const entityType = asString(row.entity_type);
  if (!isEntityType(entityType)) {
    console.warn(`[cortex:db] Skipping entity ${id}: invalid entity_type '${entityType}'`);
    return null;
  }
  return readRow(`entity ${id}`, () =>
    createEntity({
      id,
      name: asString(row.name),
      entity_type: entityType,
      aliases: parseJsonStringArray(asString(row.aliases), `Entity ${id}`, 'aliases'),
      created_at: asString(row.created_at),
      updated_at: asString(row.updated_at),
    })
  );
}

// ============================================================================
// FACT CRUD OPERATIONS
// ============================================================================

/**
 * Raw facts-table row shape, and the one mapper every fact read goes through.
 *
 * The three readers below (`getCurrentFacts`, `getAllFacts`,
 * `getFactsByMemory`) each carried their own copy of this nine-field mapping
 * over an `any[]`, which is the same shape of hazard `rowToEdge` was extracted
 * to end: three copies of one mapping is three places a new column can be
 * added to two of them.
 */
type FactRow = {
  id: string;
  entity_id: string;
  predicate: string;
  object: string;
  source_memory_id: string;
  confidence: number;
  valid_from: string;
  valid_to: string | null;
  created_at: string;
};

/**
 * Facts have no union-typed cell, but createFact still refuses an empty
 * predicate/object and a confidence outside [0,1] — none of which the schema
 * constrains. Unguarded, one such row threw out of all three readers below;
 * dropping it names the row and leaves the rest of the entity's knowledge
 * readable.
 */
function rowToFact(row: FactRow): Fact | null {
  return readRow(`fact ${row.id}`, () =>
    createFact({
      id: row.id,
      entity_id: row.entity_id,
      predicate: row.predicate,
      object: row.object,
      source_memory_id: row.source_memory_id,
      confidence: row.confidence,
      valid_from: row.valid_from,
      valid_to: row.valid_to,
      created_at: row.created_at,
    })
  );
}

/**
 * Insert a new fact.
 * I/O: Writes to database
 */
export function insertFact(db: Database, fact: Fact): string {
  db.prepare(`
    INSERT INTO facts (id, entity_id, predicate, object, source_memory_id, confidence, valid_from, valid_to, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fact.id,
    fact.entity_id,
    fact.predicate,
    fact.object,
    fact.source_memory_id,
    fact.confidence,
    fact.valid_from,
    fact.valid_to,
    fact.created_at
  );

  return fact.id;
}

/**
 * Get current (non-superseded) facts for an entity.
 * I/O: Reads from database
 *
 * Defense in depth: facts whose source memory is no longer active are
 * excluded even if their valid_to was never set (archive paths are supposed
 * to supersede facts, but a missed path must not keep reporting retracted
 * knowledge). Facts with no resolvable source memory are kept.
 */
export function getCurrentFacts(db: Database, entityId: string): readonly Fact[] {
  const rows = db.prepare(
    `SELECT f.* FROM facts f
     LEFT JOIN memories m ON m.id = f.source_memory_id
     WHERE f.entity_id = ? AND f.valid_to IS NULL
       AND (m.id IS NULL OR m.status = 'active')
     ORDER BY f.created_at DESC`
  ).all(entityId) as FactRow[];

  return readRows(rows, rowToFact);
}

/**
 * Get all facts for an entity (including superseded).
 * I/O: Reads from database
 */
export function getAllFacts(db: Database, entityId: string): readonly Fact[] {
  const rows = db.prepare(
    `SELECT * FROM facts WHERE entity_id = ? ORDER BY created_at DESC`
  ).all(entityId) as FactRow[];

  return readRows(rows, rowToFact);
}

/**
 * Supersede a fact by setting valid_to to now.
 * I/O: Writes to database
 */
export function supersedeFact(db: Database, factId: string): void {
  db.prepare(
    `UPDATE facts SET valid_to = ? WHERE id = ?`
  ).run(new Date().toISOString(), factId);
}

/**
 * Supersede all current facts sourced from a memory (set valid_to = now).
 * Called when a memory is archived (forget, lifecycle, ai-prune) so
 * entity-query stops reporting knowledge whose source was retracted.
 * I/O: Writes to database
 *
 * @returns Number of facts superseded
 */
export function supersedeFactsForMemory(db: Database, memoryId: string): number {
  const result = db.prepare(
    `UPDATE facts SET valid_to = ? WHERE source_memory_id = ? AND valid_to IS NULL`
  ).run(new Date().toISOString(), memoryId);
  return result.changes;
}

/**
 * Get all facts sourced from a specific memory.
 * I/O: Reads from database
 */
export function getFactsByMemory(db: Database, memoryId: string): readonly Fact[] {
  const rows = db.prepare(
    `SELECT * FROM facts WHERE source_memory_id = ?`
  ).all(memoryId) as FactRow[];

  return readRows(rows, rowToFact);
}
