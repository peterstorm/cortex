# Cortex Engine — Technical Reference

Persistent memory system for Claude Code. Extracts knowledge from sessions, ranks it, and surfaces the most relevant subset as context for future sessions.

Runtime: **Bun** (TypeScript). Storage: **SQLite** (WAL mode). LLM: **Gemini 2.5 Flash** (extraction) + **Gemini Embedding 001** (semantic search). Local fallback: **all-MiniLM-L6-v2** (384-dim Float32).

## Architecture

Strict **Functional Core / Imperative Shell** separation:

```
engine/src/
├── core/           ← Pure functions. No I/O. 100% unit-testable without mocks.
│   ├── types.ts        Factory functions + domain types with invariant validation
│   ├── extraction.ts   Prompt building, response parsing, transcript truncation
│   ├── similarity.ts   Jaccard, cosine, pre-filter classification
│   ├── graph.ts        BFS traversal, in-degree centrality, edge sanitization
│   ├── ranking.ts      Composite rank formula, budget-aware selection
│   ├── surface.ts      Markdown generation, token estimation, budget allocation
│   └── decay.ts        Half-life decay, lifecycle transition logic
│
├── infra/          ← I/O boundary. Side effects live here.
│   ├── db.ts           SQLite CRUD, schema, FTS5, embedding serialization
│   ├── filesystem.ts   PID locking, surface write, gitignore management
│   ├── git-context.ts  Branch, commits, changed files via execSync
│   ├── gemini-llm.ts   Extraction + edge classification API calls
│   ├── gemini-embed.ts Embedding API (768-dim Float64, batch up to 100)
│   └── local-embed.ts  HuggingFace transformers fallback (384-dim Float32)
│
├── commands/       ← Imperative shells. Orchestrate core + infra.
│   ├── extract.ts      Session-end pipeline (transcript → memories → edges)
│   ├── generate.ts     Surface generation + caching
│   ├── remember.ts     Explicit memory creation
│   ├── recall.ts       Semantic/keyword search with graph enrichment
│   ├── forget.ts       Archive by ID or fuzzy query
│   ├── consolidate.ts  Duplicate detection + merge with checkpoint/rollback
│   ├── lifecycle.ts    Decay + archive + prune pass
│   ├── index-code.ts   Prose-code memory pairing
│   ├── traverse.ts     BFS graph walk from memory ID
│   ├── inspect.ts      Telemetry collection + formatting
│   └── backfill.ts     Batch embedding queue processing
│
├── cli.ts          ← Entry point. Thin dispatcher: subcommand → handler.
└── config.ts       ← Pure path resolution + constants. No I/O.
```

## Data Model

### Memory Table

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `content` | TEXT | Full text |
| `summary` | TEXT | Short display text (≤200 chars for manual, LLM-generated for extraction) |
| `memory_type` | TEXT | `architecture` \| `decision` \| `pattern` \| `gotcha` \| `context` \| `progress` \| `code_description` \| `code` |
| `scope` | TEXT | `project` \| `global` |
| `embedding` | BLOB | Float64Array (Gemini, 768-dim) — nullable, queued for backfill |
| `local_embedding` | BLOB | Float32Array (MiniLM, 384-dim) — nullable, fallback |
| `confidence` | REAL | 0–1. Decays over time. Manual memories start at 1.0. |
| `priority` | INTEGER | 1–10. Static (set by LLM or user). |
| `pinned` | INTEGER | 0/1. Pinned = exempt from decay. |
| `source_type` | TEXT | `extraction` \| `manual` \| `code_index` |
| `source_session` | TEXT | Session ID that created it |
| `source_context` | TEXT | JSON: `{branch, commits[], files[]}` or `{file_path, start_line, end_line}` |
| `tags` | TEXT | JSON array of keyword strings |
| `access_count` | INTEGER | Incremented on `/recall`. Delays archival. |
| `last_accessed_at` | TEXT | ISO8601. Reset on access. |
| `status` | TEXT | `active` → `archived` → `pruned` (also `superseded`) |

### Edge Table

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `source_id` | TEXT FK | → memories(id) ON DELETE CASCADE |
| `target_id` | TEXT FK | → memories(id) ON DELETE CASCADE |
| `relation_type` | TEXT | `relates_to` \| `derived_from` \| `contradicts` \| `exemplifies` \| `refines` \| `supersedes` \| `source_of` |
| `strength` | REAL | 0–1 |
| `bidirectional` | INTEGER | 0/1 |
| `status` | TEXT | `active` \| `suggested` |
| UNIQUE | | `(source_id, target_id, relation_type)` |

### Extraction Checkpoint Table

Tracks cursor position for resumable extraction when transcripts exceed 100KB.

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PK | UUID |
| `session_id` | TEXT | Session being extracted |
| `cursor_position` | INTEGER | Byte offset into transcript |
| `extracted_at` | TEXT | ISO8601 |

### FTS5 Index

```sql
CREATE VIRTUAL TABLE memories_fts USING fts5(id UNINDEXED, content, summary, tags);
```

Kept in sync via `AFTER INSERT/UPDATE/DELETE` triggers on `memories`.

### Indexes

- `idx_memories_status` — fast `WHERE status = 'active'` queries
- `idx_checkpoints_session` — checkpoint lookup by session
- `idx_edges_source`, `idx_edges_target` — graph traversal

## Session Lifecycle

### Session Start (< 5s budget)

```
SessionStart hook
  → load-surface.sh
    → bun cli.ts load-surface <cwd>
      → computeCacheKey(sha256(branch:cwd))
      → check .memory/surface-cache/{key}.json
      → if valid & < 24h: write cached surface to .claude/cortex-memory.local.md
      → if miss: runGenerate() (full pipeline, see below)
```

### Session End (30s budget)

```
Stop hook (JSON stdin: {session_id, transcript_path, cwd})
  → extract-and-generate.sh
    → Step 1: bun cli.ts extract < stdin_json
        1. readFileSync(transcript_path)
        2. getExtractionCheckpoint(session_id) → resume cursor
        3. truncateTranscript(content, 100KB, cursor) [pure]
        4. getGitContext(cwd) → {branch, commits, files}
        5. buildExtractionPrompt(transcript, git, project) [pure]
        6. Gemini 2.5 Flash → raw response
        7. parseExtractionResponse(response) → MemoryCandidate[] [pure]
        8. For each candidate:
           a. candidateToMemory() [pure] → Memory
           b. insertMemory(db, memory)
           c. computeSimilarityAndCreateEdges():
              - tokenize both → Jaccard pre-filter
              - < 0.1: skip
              - 0.1–0.4: relates_to edge (active)
              - 0.4–0.5: relates_to edge (suggested)
              - > 0.6: strong relates_to edge
        9. saveExtractionCheckpoint(cursor)
       10. runLifecycle(db) — decay/archive/prune
       11. invalidateSurfaceCache(cwd) — delete all .json in surface-cache/

    → Step 2: bun cli.ts generate <cwd>
        (See Surface Generation Pipeline below)
```

Both hooks exit 0 unconditionally — never block session.

## Surface Generation Pipeline

The pipeline that builds `.claude/cortex-memory.local.md`:

```
1. getCurrentBranch(cwd)                          [I/O: git]
2. getActiveMemories(projectDb)                   [I/O: SQLite]
   getActiveMemories(globalDb)                    [I/O: SQLite]
   → merge into allMemories[]
3. getAllEdges(projectDb), getAllEdges(globalDb)   [I/O: SQLite]
4. computeAllCentrality(allEdges)                 [pure: in-degree / max]
5. Attach centrality to each memory               [pure: map]
6. selectForSurface(memories, {branch, 400, 550}) [pure: rank + budget]
     → computeRank() per memory
     → sort by rank descending
     → first pass: fill per-category budgets
     → second pass: overflow high-value into unused budget
7. generateSurface(ranked, branch, staleness)     [pure: markdown]
     → group by category
     → render bullet list with tags
     → truncate if > 550 tokens (4 chars/token heuristic)
8. wrapInMarkers(content)                         [pure]
     → <!-- CORTEX_MEMORY_START --> ... <!-- CORTEX_MEMORY_END -->
9. writeSurface(path, content, lockDir)           [I/O: PID lock + write]
10. writeCache(cacheDir, branch, cwd, surface)    [I/O: JSON file]
11. writeTelemetry(path, stats)                   [I/O: JSON file]
```

## Ranking Formula

```
rank = (confidence × 0.50)
     + (priority/10 × 0.20)
     + (centrality × 0.15)
     + (log(access_count + 1) / maxAccessLog × 0.15)
     + branch_boost
```

- `confidence`: LLM-assigned, decays over time. Manual memories = 1.0.
- `priority`: 1–10 static. LLM-assigned or user-specified.
- `centrality`: In-degree count / max in-degree. Hub memories rank higher.
- `access_count`: `/recall` increments. Logarithmic to prevent runaway.
- `branch_boost`: +0.1 if `source_context.branch === currentBranch`.

Clamped to [0, 1].

### Per-Category Line Budgets

| Category | Lines |
|---|---|
| architecture | 25 |
| decision | 25 |
| pattern | 25 |
| gotcha | 20 |
| progress | 30 |
| context | 15 |
| code_description | 10 |
| code | 0 (excluded) |

Target: 400 tokens. Hard max: 550 tokens. Overflow allowed: high-value memories redistribute unused budget from under-populated categories.

## Decay & Lifecycle

### Half-Life by Type

| Type | Half-life (days) |
|---|---|
| architecture | ∞ (stable) |
| decision | ∞ (stable) |
| code_description | ∞ (stable) |
| code | ∞ (stable) |
| pattern | 60 |
| gotcha | 45 |
| context | 30 |
| progress | 7 |

### Modifiers (each doubles effective half-life)

- `access_count > 10` → ×2
- `centrality > 0.5` → ×2

Stacking: A frequently-accessed, well-connected pattern memory: 60 × 2 × 2 = 240 day half-life.

### Formula

```
decayed_confidence = original_confidence × (0.5 ^ (age_days / half_life))
```

### Transitions

```
active
  → if confidence < 0.3 for 14+ days AND centrality ≤ 0.5 AND not pinned
    → archived
      → if archived for 30+ days with no access
        → pruned
```

Exemptions:
- `pinned = true` → never decays
- `centrality > 0.5` → hub protection (never archived)
- Accessing via `/recall` resets `last_accessed_at` → delays archival

## Similarity & Edge Creation

### Jaccard Pre-Filter (at insertion time)

```
tokenize(summary + content) for new and existing memory
jaccardSimilarity(tokensA, tokensB) → score [0, 1]
jaccardPreFilter(score):
  < 0.1  → definitely_different → skip
  0.1–0.6 → maybe → classifySimilarity():
    0.1–0.4 → relates_to edge (active)
    0.4–0.5 → relates_to edge (suggested)
    0.5+    → consolidation candidate (logged)
  > 0.6  → definitely_similar → strong relates_to edge
```

### Cosine Similarity (at search time)

Used by `/recall` when embeddings available. `cosineSimilarity(Float64Array, Float64Array)`. Planned for edge creation in the "maybe" Jaccard range once embeddings are backfilled.

### Tokenizer

Lowercases, strips punctuation, splits on whitespace, returns `Set<string>`.

## Embedding Strategy

**Dual embedding** with Gemini primary, local fallback:

| Model | API | Dimensions | Type | Column |
|---|---|---|---|---|
| gemini-embedding-001 | Google AI | 768 | Float64Array | `embedding` |
| all-MiniLM-L6-v2 | Local (HuggingFace) | 384 | Float32Array | `local_embedding` |

### Embedding Text Format

```
[memory_type] [project:name] summary text
```

For queries:
```
[query] [project:name] user query text
```

Prefix alignment ensures type-aware and project-aware similarity.

### Backfill

Memories are inserted with `embedding = null` to avoid blocking extraction. The `backfill` command processes the queue:
1. Fetch all active memories with null embeddings
2. Build embedding texts with metadata prefix
3. Batch up to 100 per API call (Gemini limit)
4. Update DB with resulting vectors
5. Falls back to local model if no API key

### Code Memory Rule

Raw code is **never** sent to the embedding API. `code` type memories have `embedding = null, local_embedding = null` permanently. Search finds them via `source_of` edges from their paired `code_description` memory.

## Command Reference

### extract

Stop hook pipeline. Reads JSON from stdin: `{session_id, transcript_path, cwd}`. Never throws — returns result object with error field.

### generate

Builds surface from ranked memories. Args: `<cwd>`. Opens both DBs, runs full pipeline, writes surface + cache + telemetry.

### remember

Explicit memory creation. Args: `<cwd> <content> [--type=TYPE] [--priority=N] [--scope=SCOPE] [--pinned] [--tags=t1,t2]`. Defaults: type=context, priority=5, scope=project, confidence=1.0.

### recall

Semantic or keyword search. Args: `<cwd> <query> [--branch=B] [--limit=N] [--keyword]`. Searches both DBs, merges results (project first), follows `source_of` edges for linked code, BFS depth-2 for related memories. Updates `access_count` and `last_accessed_at`.

### forget

Archive by ID or fuzzy keyword query. Tries ID lookup in project → global, then FTS5 search. Returns candidates for confirmation.

### consolidate

Detect duplicate pairs (Jaccard > 0.5, or cosine if embeddings available). Creates checkpoint before merge for rollback safety. Merge is human-only — pairs returned for review, caller invokes `mergePair()`. Merged memory gets confidence=1.0, higher priority of the two, combined tags, `supersedes` edges to old memories.

### lifecycle

Decay + archive + prune pass. Runs automatically after extraction. Computes centrality, applies decay formula, transitions per rules above. Processes both active and archived memories.

### index-code

Prose-code memory pairing. Creates two memories: `code_description` (with embedding) + `code` (without), linked via `source_of` edge. Re-indexing supersedes old versions for same file path. All writes in a single transaction.

### traverse

BFS graph traversal from a memory ID. Options: `--depth` (0–10, default 2), `--edgeTypes` (comma-separated), `--direction` (outgoing/incoming/both), `--minStrength` (0–1). Batch-fetches discovered memories in single query.

### inspect

Telemetry display. Queries both DBs for stats: memory counts by type/scope, edge count, embedding queue size, cache staleness. Reads `.memory/cortex-status.json` for last extraction info.

### backfill

Batch embedding processing. Fetches un-embedded memories, embeds via Gemini (batch up to 100) or local fallback. Updates DB with vectors.

### load-surface

SessionStart fast path. Checks cache, serves if fresh, or triggers full generate.

## Concurrency & Locking

- **SQLite WAL mode**: Concurrent reads while single writer holds. Enabled in `openDatabase()`.
- **PID-based file locking**: Surface writes protected by `.memory/locks/surface.lock`. Stale locks (dead PID) auto-overridden. Atomic creation via `O_EXCL` flag.
- **Transaction safety**: Consolidation merges, index-code, all multi-write operations use `db.transaction()`.
- **Checkpoint/rollback**: Consolidation creates `VACUUM INTO` backup before mutating. Restores on failure.

## File Locations

| File | Location | Gitignored |
|---|---|---|
| Project DB | `<project>/.memory/cortex.db` | Yes |
| Global DB | `~/.claude/memory/cortex-global.db` | N/A |
| Surface | `<project>/.claude/cortex-memory.local.md` | Yes |
| Cache | `<project>/.memory/surface-cache/{hash}.json` | Yes |
| Locks | `<project>/.memory/locks/` | Yes |
| Telemetry | `<project>/.memory/cortex-status.json` | Yes |
| Extract log | `/tmp/cortex-extract.log` | N/A |
| Generate log | `/tmp/cortex-generate.log` | N/A |

`.gitignore` patterns auto-added by `ensureGitignored()`: `.memory/`, `.claude/cortex-memory.local.md`.

## Environment

| Variable | Purpose | Required |
|---|---|---|
| `GEMINI_API_KEY` | Extraction LLM + embedding API | Yes (for extraction + semantic search) |
| `CLAUDE_PLUGIN_ROOT` | Plugin directory | Auto-set by Claude Code |

Without `GEMINI_API_KEY`: extraction skipped, recall falls back to FTS5 keyword search, backfill uses local model.

## Testing

```bash
cd engine && bun test          # vitest run
cd engine && bun test:watch    # vitest watch
```

Dependencies: `vitest`, `fast-check` (property-based). All core/ functions testable with plain data — no mocks needed.

## Constants

| Constant | Value | Source |
|---|---|---|
| `MAX_TRANSCRIPT_BYTES` | 100KB | `config.ts` |
| `EXTRACTION_TIMEOUT_MS` | 30s | `config.ts` |
| `SURFACE_MAX_TOKENS` | 600 | `config.ts` |
| `SURFACE_STALE_HOURS` | 24h | `config.ts` |
| `CONSOLIDATION_EXTRACTION_THRESHOLD` | 10 | `config.ts` |
| `CONSOLIDATION_ACTIVE_THRESHOLD` | 80 | `config.ts` |
| `ARCHIVE_THRESHOLD_DAYS` | 7 | `config.ts` |
| `PRUNE_THRESHOLD_DAYS` | 90 | `config.ts` |
| `DEFAULT_SEARCH_LIMIT` | 10 | `config.ts` |
| `DEFAULT_TRAVERSAL_DEPTH` | 2 | `config.ts` |
| `EMBEDDING_DIMENSIONS` (Gemini) | 768 | `gemini-embed.ts` |
| `MAX_BATCH_SIZE` (Gemini) | 100 | `gemini-embed.ts` |
| Local embedding dimensions | 384 | `local-embed.ts` |
| Gemini model (extraction) | `gemini-2.5-flash` | `gemini-llm.ts` |
| Gemini model (embedding) | `gemini-embedding-001` | `gemini-embed.ts` |
| Local model | `Xenova/all-MiniLM-L6-v2` | `local-embed.ts` |
