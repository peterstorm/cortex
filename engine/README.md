# Cortex Engine — Technical Reference

Persistent memory system for Claude Code. Extracts knowledge from sessions, ranks it, and surfaces the most relevant subset as context for future sessions.

Runtime: **Bun** (TypeScript). Storage: **SQLite** via `bun:sqlite` (WAL mode, built into Bun). LLM: headless coding-agent CLI — **`claude -p --model haiku`** by default, or **`pi -p`** under the pi agent (extraction, AI prune, edge classification). Embeddings: **Gemini Embedding 001** (semantic search), local fallback **BGE-small-en-v1.5** (384-dim Float32).

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
│   ├── claude-llm.ts   Headless LLM CLI client (claude -p / pi -p): extraction + edge classification
│   ├── gemini-embed.ts Embedding API (768-dim Float64, batch up to 100)
│   └── local-embed.ts  HuggingFace transformers fallback (BGE-small-en-v1.5, 384-dim Float32)
│
├── commands/       ← Imperative shells. Orchestrate core + infra.
│   ├── extract.ts      Session-end pipeline (transcript → memories → edges)
│   ├── generate.ts     Surface generation + caching
│   ├── remember.ts     Explicit memory creation
│   ├── recall.ts       Semantic/keyword search with graph enrichment
│   ├── forget.ts       Archive by ID or fuzzy query
│   ├── consolidate.ts  Duplicate detection + merge with checkpoint/rollback
│   ├── lifecycle.ts    Decay + archive + prune pass
│   ├── ai-prune.ts     LLM-driven pruning of low-value memories
│   ├── semantic-edges.ts  Typed edge classification via LLM CLI
│   ├── prompt-recall.ts   UserPromptSubmit keyword recall + semantic fallback
│   ├── entity-query.ts    Entity-first temporal retrieval
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
| `local_embedding` | BLOB | Float32Array (BGE-small-en-v1.5, 384-dim) — nullable, fallback |
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
      → if miss or stale (>24h): runGenerate() (full pipeline, see below)
        — only if .memory/cortex.db already exists; never creates DBs
          in projects that don't use cortex
```

### Session End (detached worker)

The hook re-invokes itself as a detached worker (`setsid`, or `spawn({detached: true})` on macOS) so the pipeline survives Claude Code reaping the hook's process group. Steps run **sequentially** — SQLite allows one writer, and lifecycle + ai-prune both read-modify-write telemetry.json. Each step logs to `/tmp/cortex-<step>.log`. The hook sources `GEMINI_API_KEY` from `$CORTEX_GEMINI_ENV` (default: sops-nix path).

```
SessionEnd hook (JSON stdin: {session_id, transcript_path, cwd})
  → extract-and-generate.sh (detaches worker, exits 0)
    → Step 1: bun cli.ts extract < stdin_json
        1. readFileSync(transcript_path)
        2. getExtractionCheckpoint(session_id) → resume cursor
        3. truncateTranscript(content, 100KB, cursor) [pure]
        4. getGitContext(cwd) → {branch, commits, files}
        5. buildExtractionPrompt(transcript, git, project) [pure]
        6. Headless LLM CLI (claude -p --model haiku, or pi -p) → raw response
        7. parseExtractionResponse(response) → MemoryCandidate[] [pure]
        8. Route candidates by scope: global-scoped → global DB,
           everything else → project DB. For each candidate:
           a. candidateToMemory() [pure] → Memory
           b. insertMemory(db, memory)
           c. computeSimilarityAndCreateEdges():
              - hybrid similarity (local cosine if both embedded, else Jaccard)
              - classify with per-space bands (Jaccard: 0.1/0.4/0.5,
                local cosine: 0.6/0.75/0.82) → active/suggested edges
              - keep top 3 strongest edges per new memory
        9. saveExtractionCheckpoint(cursor)
       10. runLifecycle(projectDb) — decay/archive/prune
       11. invalidateSurfaceCache(cwd) — delete all .json in surface-cache/

    → Step 2: bun cli.ts backfill <cwd>       (embed new memories)
    → Step 3: bun cli.ts semantic-edges <cwd> (typed edge classification)
    → Step 4: bun cli.ts lifecycle <cwd> --if-needed
    → Step 5: bun cli.ts ai-prune <cwd> --if-needed
    → Step 6: bun cli.ts generate <cwd>       (LAST, after archival — see
                                               Surface Generation Pipeline)
```

All hooks exit 0 unconditionally — never block session. Errors surface only in `/tmp/cortex-*.log`.

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
6. selectForSurface(memories, {branch, 1300, 1800}) [pure: rank + budget]
   (1500 target / 2000 max, minus 200-token markdown overhead)
     → computeRank() per memory
     → sort by rank descending
     → first pass: fill per-category budgets
     → second pass: overflow high-value into unused budget
7. generateSurface(ranked, branch, staleness)     [pure: markdown]
     → group by category
     → render bullet list with tags
     → truncate if over max budget (4 chars/token heuristic)
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

Target: 1500 tokens. Hard max: 2000 tokens (`SURFACE_MAX_TOKENS`), including ~200 tokens of markdown overhead. Overflow allowed: high-value memories redistribute unused budget from under-populated categories.

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

### Edge classification (at insertion time)

```
hybridSimilarityScored(tokens, tokens, localEmbA, localEmbB) → {score, method}
  method = cosine  when both sides have local embeddings (same dims)
  method = jaccard otherwise (with <0.1 pre-filter → score 0)

classifySimilarity(score, space) — bands calibrated PER SPACE:
  jaccard / gemini-cosine:  ignore <0.1 | relate <0.4 | suggest ≤0.5 | consolidate >0.5
  local-cosine (runs hot):  ignore <0.6 | relate <0.75 | suggest <0.82 | consolidate ≥0.82

relate/consolidate → active relates_to edge, suggest → suggested edge.
Cap: top MAX_EDGES_PER_MEMORY (3) strongest edges per new memory.
```

### Cosine Similarity (at search time)

Used by `/recall` and prompt-recall when embeddings are available, and by `consolidate` via hybrid similarity for duplicate-pair detection with per-space thresholds (`consolidationThresholdFor`: 0.5 Jaccard/Gemini, 0.8 local cosine).

### Tokenizer

Lowercases, strips punctuation, splits on whitespace, returns `Set<string>`.

## Embedding Strategy

**Dual embedding** with Gemini primary, local fallback:

| Model | API | Dimensions | Type | Column |
|---|---|---|---|---|
| gemini-embedding-001 | Google AI | 768 | Float64Array | `embedding` |
| BGE-small-en-v1.5 (`Xenova/bge-small-en-v1.5`) | Local (HuggingFace) | 384 | Float32Array | `local_embedding` |

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

SessionEnd hook pipeline. Reads JSON from stdin: `{session_id, transcript_path, cwd}`. Routes global-scoped candidates to the global DB, everything else to the project DB. Never throws — returns result object with error field.

### generate

Builds surface from ranked memories. Args: `<cwd>`. Opens both DBs, runs full pipeline, writes surface + cache + telemetry.

### remember

Explicit memory creation. Args: `<cwd> <content> [--type=TYPE] [--priority=N] [--scope=SCOPE] [--pinned] [--tags=t1,t2]`. Defaults: type=context, priority=5, scope=project, confidence=1.0.

### recall

Semantic or keyword search. Args: `<cwd> <query> [--branch=B] [--limit=N] [--keyword]`. Searches both DBs, merges results (project first), follows `source_of` edges for linked code, BFS depth-2 for related memories. Updates `access_count` and `last_accessed_at`. Semantic search excludes archived and superseded memories; the `--branch` filter is applied before the result limit (with over-fetch) so branch matches aren't cut off; an empty keyword query returns empty results rather than erroring.

### forget

Archive by ID or fuzzy keyword query. Tries ID lookup in project → global, then FTS5 search. Returns candidates for confirmation.

### consolidate

Two modes, project DB only.

**List mode** — `consolidate <cwd> [--threshold=N]`: detects duplicate pairs via hybrid similarity (cosine when both sides share an embedding type, Jaccard otherwise) and prints each pair with IDs, similarity %, type, priority, summary, and content for human review. Default threshold is per similarity space — 0.5 for Jaccard and Gemini-768 cosine, 0.8 for raw local-BGE cosine (which scores same-domain non-duplicates 0.6-0.75); `--threshold=N` overrides uniformly.

**Merge mode** — `consolidate <cwd> --merge --a=<idA> --b=<idB> --summary=<text> --content=<text>`: merges one reviewed pair. The merged memory gets confidence 1.0 (human-approved), the higher priority of the two, combined tags, pinned if either was pinned, and null embeddings (backfill re-embeds the new content). Both originals are marked `superseded` with `supersedes` edges, and the new memory ID is printed. Run `backfill` + `generate` afterwards.

### lifecycle

Decay + archive + prune pass. Runs automatically after extraction. Computes centrality, applies decay formula, transitions per rules above. Processes both active and archived memories.

### index-code

Prose-code memory pairing. Creates two memories: `code_description` (with embedding) + `code` (without), linked via `source_of` edge. Re-indexing supersedes old versions for same file path. All writes in a single transaction.

### traverse

BFS graph traversal from a memory ID. Args: `traverse <cwd> <memoryId> [maxDepth]` — a single positional max depth (default 2); no other flags. Tries the project DB first, then the global DB. Batch-fetches discovered memories in single query.

### inspect

Telemetry display (JSON output). Queries both DBs for stats: active memory counts by type/scope, edge count, embedding queue size, cache staleness. Reads `.memory/telemetry.json` for the last extraction record.

### backfill

Batch embedding processing. Fetches un-embedded memories, embeds via Gemini (batch up to 100) or local fallback. Updates DB with vectors.

### load-surface

SessionStart fast path. Checks cache and serves if fresh (<24h); on cache miss or staleness it runs the full generate pipeline — but only if the project already has a `.memory/cortex.db` (never creates databases in untouched projects).

## Concurrency & Locking

- **SQLite WAL mode**: Concurrent reads while single writer holds. Enabled in `openDatabase()`.
- **PID-based file locking**: Surface writes protected by `.memory/locks/surface.lock`. Stale locks (dead PID) auto-overridden. Atomic creation via `O_EXCL` flag.
- **Transaction safety**: Consolidation merges, index-code, all multi-write operations use `db.transaction()`.
- **Transaction-per-merge**: Each consolidate `--merge` runs all writes (insert merged, supersede originals, create edges) in a single transaction. A `VACUUM INTO` checkpoint/restore path also exists in `consolidate.ts` for batch consolidation runs.

## File Locations

| File | Location | Gitignored |
|---|---|---|
| Project DB | `<project>/.memory/cortex.db` | Yes |
| Global DB | `~/.claude/memory/cortex-global.db` | N/A |
| Surface | `<project>/.claude/cortex-memory.local.md` | Yes |
| Cache | `<project>/.memory/surface-cache/{hash}.json` | Yes |
| Locks | `<project>/.memory/locks/` | Yes |
| Telemetry | `<project>/.memory/cortex-status.json` | Yes |
| Pipeline logs | `/tmp/cortex-{extract,backfill,generate,semantic-edges,lifecycle,ai-prune}.log` | N/A |

`.gitignore` patterns auto-added by `ensureGitignored()`: `.memory/`, `.claude/cortex-memory.local.md`, `.pi/cortex-memory.local.md`.

## Environment

| Variable | Purpose | Required |
|---|---|---|
| `GEMINI_API_KEY` | Embedding API only (semantic search) — extraction does NOT use it | No (backfill falls back to local model) |
| `CORTEX_GEMINI_ENV` | Path to file hooks source for `GEMINI_API_KEY` (default: sops-nix path) | No |
| `CORTEX_LLM_BINARY` | Force headless LLM binary (`claude` or `pi`) | No (auto-detected) |
| `CORTEX_LLM_MODEL` | Override model for the LLM binary | No (`haiku` for claude; none for pi) |
| `CLAUDE_PLUGIN_ROOT` | Plugin directory | Auto-set by Claude Code |

Extraction, AI prune, and edge classification shell out to a headless coding-agent CLI: `claude -p --model haiku` by default, or `pi -p` when running under the pi agent (no `--model` flag — pi's configured provider default is used). Without `GEMINI_API_KEY`: recall falls back to local-embedding/keyword search, backfill uses the local model. Extraction still works.

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
| LLM call timeout (extraction / edge classification) | 90s | `claude-llm.ts` |
| `SURFACE_MAX_TOKENS` | 2000 | `config.ts` |
| `SURFACE_STALE_HOURS` | 24h | `config.ts` |
| `CONSOLIDATION_EXTRACTION_THRESHOLD` | 10 | `config.ts` |
| `CONSOLIDATION_ACTIVE_THRESHOLD` | 80 | `config.ts` |
| `PRUNE_THRESHOLD_DAYS` | 30 | `config.ts` |
| `AI_PRUNE_SESSION_INTERVAL` | 5 | `config.ts` |
| `AI_PRUNE_MEMORY_THRESHOLD` | 50 | `config.ts` |
| `DEFAULT_SEARCH_LIMIT` | 10 | `config.ts` |
| `DEFAULT_TRAVERSAL_DEPTH` | 2 | `config.ts` |
| `EMBEDDING_DIMENSIONS` (Gemini) | 768 | `gemini-embed.ts` |
| `MAX_BATCH_SIZE` (Gemini) | 100 | `gemini-embed.ts` |
| Local embedding dimensions | 384 | `local-embed.ts` |
| LLM CLI (extraction/prune/edges) | `claude -p --model haiku` (or `pi -p`) | `claude-llm.ts` |
| Gemini model (embedding) | `gemini-embedding-001` | `gemini-embed.ts` |
| Local model | `Xenova/bge-small-en-v1.5` | `local-embed.ts` |
