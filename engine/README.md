# Cortex Engine — Technical Reference

Persistent memory system for Claude Code. Extracts knowledge from sessions, ranks it, and surfaces the most relevant subset as context for future sessions.

Runtime: **Bun** (TypeScript). Storage: **SQLite** via `bun:sqlite` (WAL mode, built into Bun). LLM: headless coding-agent CLI — **`claude -p --model haiku`** by default, or **`pi -p`** under the pi agent (extraction, AI prune, edge classification). Embeddings: local only — **potion-retrieval-32M** (`minishlab/potion-retrieval-32M`, a model2vec static model, 512-dim Float32) run in-process on CPU through `@huggingface/transformers` and `onnxruntime-node`. There is no remote embedding provider and no API key.

## Architecture

Strict **Functional Core / Imperative Shell** separation:

```
engine/src/
├── core/           ← Pure functions. No I/O. 100% unit-testable without mocks.
│   ├── types.ts        Factory functions + domain types with invariant validation
│   ├── extraction.ts   Prompt building, response parsing, transcript truncation
│   ├── similarity.ts   Jaccard, cosine, pre-filter classification
│   ├── calibration.ts  Per-model cosine calibration types, dedup verdicts per space
│   ├── restatement.ts  distinctFacts (recall) + planRestatements (dedupe)
│   ├── replacement.ts  remember --replaces: tag parser, what a replacement supersedes
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
│   └── local-embed.ts  The only embedder: potion-retrieval-32M via transformers.js (512-dim Float32)
│
├── commands/       ← Imperative shells. Orchestrate core + infra.
│   ├── extract.ts      Session-end pipeline (transcript → memories → edges)
│   ├── generate.ts     Surface generation + caching
│   ├── remember.ts     Explicit memory creation
│   ├── recall.ts       Semantic/keyword search with graph enrichment
│   ├── forget.ts       Archive by ID or fuzzy query
│   ├── consolidate.ts  Duplicate detection + merge with checkpoint/rollback
│   ├── dedupe.ts       Supersede restatements of newer memories (maintenance step)
│   ├── lifecycle.ts    Decay + archive + prune pass
│   ├── ai-prune.ts     LLM-driven pruning of low-value memories
│   ├── semantic-edges.ts  Typed edge classification via LLM (manual command only)
│   ├── prompt-recall.ts   UserPromptSubmit semantic-first recall + strict keyword AND
│   ├── entity-query.ts    Entity-first temporal retrieval
│   ├── index-code.ts   Prose-code memory pairing
│   ├── traverse.ts     BFS graph walk from memory ID
│   ├── inspect.ts      Telemetry collection + formatting
│   ├── show-surface.ts The surface a prompt is shown, reloaded on a branch switch
│   └── backfill.ts     Batch embedding queue processing
│
├── cli.ts          ← Entry point. Thin dispatcher: subcommand → handler.
├── show-surface-hook.ts ← Per-prompt entry for show-surface.sh (kept off cli.ts's import graph)
├── project-session.ts ← Shell. Locates the project a cwd belongs to, opens
│                     its database and the global one, runs one command,
│                     always closes both; a throw becomes "<Command> failed".
├── command-result.ts  ← The CLI command outcome: succeeded | deferred | failed.
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
| `embedding` | BLOB | Float64Array, nullable. Legacy: left from the removed remote embedding provider. Nothing computes it now, so new rows hold null; see [Embedding Strategy](#embedding-strategy) for what still reads it |
| `local_embedding` | BLOB | Float32Array (potion-retrieval-32M, 512-dim), nullable until backfill embeds the row. The vector recall ranks on |
| `local_embedding_model` | TEXT | Model id that produced `local_embedding`. A row tagged with another model (or untagged) is skipped by recall and re-embedded by backfill |
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
| `transcript_length` | INTEGER | Transcript size in bytes when saved; a smaller file later means it was rewritten, and the cursor resets to 0. Null only on legacy rows |
| `projection_version` | INTEGER | Projection the cursor was produced under; any other value (null on legacy rows) resets the cursor to 0 |

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

The hook re-invokes itself as a detached worker (`setsid`, or `spawn({detached: true})` on macOS) so the pipeline survives Claude Code reaping the hook's process group. It runs three commands **sequentially**: `extract`, then `backfill` (only when extract succeeded), then `maintenance`, which runs its own three steps one after another behind a per-project lock — SQLite allows one writer, and lifecycle + ai-prune both read-modify-write telemetry.json. Each command logs to `/tmp/cortex-{extract,backfill,maintenance}.<pid>.log`; the worker deletes such logs once they are a week old. The hook needs no API key for embeddings; on NixOS it puts a 64-bit `libstdc++` on `LD_LIBRARY_PATH` for `onnxruntime-node` (`CORTEX_ONNX_LD_PATH` pins the directory, otherwise it probes the nix store).

```
SessionEnd hook (JSON stdin: {session_id, transcript_path, cwd})
  → extract-and-generate.sh (detaches worker, exits 0)
    → Step 1: bun cli.ts extract < stdin_json     (per-project extract.lock)
        1. getExtractionCheckpoint(session_id) → resume cursor; reset to 0
           when its projection_version is not the current one
        2. readProjectedChunks(transcript_path, cursor) → up to 5 chunks of
           ≤100KB of what the model saw, streamed from the cursor; reset to 0
           and re-read if the transcript shrank below the checkpoint; no
           transcript file at all (a session that ended before its first
           line) succeeds with nothing extracted, any other read error fails
        3. getGitContext(cwd) → {branch, commits, files}; known entities
        4. For each chunk:
           a. buildExtractionPrompt(chunk, git, project, entities) [pure]
           b. LLM: direct OpenAI-compatible endpoint, else headless CLI
              (claude -p --model haiku, or pi -p) → raw response
           c. parseExtractionResponse(response) → memories + entity facts [pure]
           d. Route candidates by scope: global-scoped → global DB,
              everything else → project DB
           e. deduplicateCandidates() [pure] → skip / merge into an existing
              memory / keep; insert the kept ones
           f. computeSimilarityAndCreateEdges():
              - hybrid similarity (local cosine if both embedded, else Jaccard)
              - classify with per-space bands (Jaccard: 0.1/0.4/0.5,
                local cosine: 0.6/0.75/0.82) → active/suggested edges
              - keep top 3 strongest edges per new memory
           g. upsert entities and facts (superseding a changed fact)
           h. saveExtractionCheckpoint(chunk end) — a chunk with any failed
              write keeps the old cursor, so it is retried
        5. Only once the transcript's end is reached:
           runLifecycle(projectDb) — decay/archive/prune
           invalidateSurfaceCache(root) if anything was inserted

    → Step 2: bun cli.ts backfill <cwd>       (embed new memories; skipped
                                               when extract failed)
    → Step 3: bun cli.ts maintenance <cwd>    (per-project maintenance.lock;
                                               a second run skips)
        1. lifecycle <cwd> --if-needed
        2. dedupe <cwd>                       (supersede restatements; stored
                                               vectors only, no LLM, no model)
        3. ai-prune <cwd> --if-needed
        4. generate <cwd>                     (LAST, after archival — see
                                               Surface Generation Pipeline)
```

Dedupe runs after lifecycle, so it does not compare what was just archived, and before ai-prune, so the LLM never spends a review on copies. Maintenance does not run `semantic-edges`. On 139,123 recorded pairs the LLM pass typed 545 (0.4%) and left the rest unchanged, and only `traverse` reads an edge's type (centrality is in-degree over every edge; prompt recall reads none). `maintenance.e2e.test.ts` pins this: it runs the real command against a closed LLM port and asserts no edge was asked about.

Pi runs the same three commands in one detached `ingest-session` worker, which retries a deferred or transiently failed extract until the transcript is drained before it backfills. Every detached Pi child appends to `<cwd>/.memory/logs/pi-detached.log`, each run opened by a `===== <ISO time> <command> =====` header (the engine's own lines carry no timestamps). Past 5 MiB the log is renamed to `pi-detached.log.1` before the next run opens it, so one previous generation is kept.

All hooks exit 0 unconditionally — never block session. Errors surface only in `/tmp/cortex-*.log` (`load-surface` keeps its log only when it fails).

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
     → Entities section first: selectSurfaceEntities picks up to 5 entities
       with a current fact, most recently learned-about first, never file
       paths (`.claude/plans/x.md` is something to open, not to know about)
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

classifySimilarity(score, cosineBands) — cosineBands is the active model's
calibration edgeBands, or null (then the score is Jaccard's):
  jaccard (null):        ignore <0.1 | relate <0.4 | suggest ≤0.5 | consolidate >0.5
  BGE-small edge bands:  ignore <0.6 | relate <0.75 | suggest <0.82 | consolidate ≥0.82
  potion-retrieval-32M:  no edge bands → computeEdgeCandidates passes no vectors, Jaccard only

relate/consolidate → active relates_to edge, suggest → suggested edge.
Cap: top MAX_EDGES_PER_MEMORY (3) strongest edges per new memory.
```

### Per-model cosine calibration (`config.ts`, types in `core/calibration.ts`)

Every absolute cosine cutoff belongs to one embedding model, so they live in one record per model:

```ts
type DuplicateBands =
  | { kind: 'skip-only'; skipFrom }              // no merge band can exist
  | { kind: 'merge-then-skip'; mergeFrom; skipFrom };
type DedupThresholds = { existing: DuplicateBands; intraBatch: number };
type CosineCalibration = {
  dedup: DedupThresholds;
  consolidationCandidate: number;
  edgeBands: CosineEdgeBands | null;   // null: edges stay on Jaccard
  restatement: number | null;          // null: dedupe disabled
  distinctRecall: number | null;       // null: distinct recall is a no-op
};
cosineCalibrationFor(model): CosineCalibration | null   // null: uncalibrated → Jaccard everywhere
```

`ACTIVE_COSINE_CALIBRATION` is the record for `LOCAL_EMBED_MODEL`; `ACTIVE_DEDUP_POLICY` (`{ jaccard: JACCARD_DEDUP, cosine: dedup | null }`) is what extraction and `remember` compare against. `compareForDedup` scores a pair in exactly one space and returns that space's thresholds, so a cosine score is never read against Jaccard bands or the reverse; `dedupVerdict` maps a score to keep / merge / skip.

| | Jaccard | potion-retrieval-32M (active) | BGE-small-en-v1.5 |
|---|---|---|---|
| dedup vs stored | merge-then-skip 0.75 / 0.85 | skip-only 0.92 | merge-then-skip 0.75 / 0.85 |
| dedup within batch | 0.75 | 0.92 | 0.75 |
| `remember` refusal (`duplicateFloor`) | 0.75 | 0.92 | 0.75 |
| `consolidate` candidates | 0.5 | 0.85 | 0.8 |
| edge bands | Jaccard bands | none | 0.6 / 0.75 / 0.82 |
| `dedupe` restatement | — | 0.90 | — |
| distinct recall | — | 0.80 | — |

The measurement behind each record (corpus, graded pairs per band, failure modes) is the comment above it in `config.ts`.

### Distinct facts and restatements (`core/restatement.ts`)

- `distinctFacts(ranked, memoryOf, threshold)` — order-preserving: drops an item when an already-KEPT item of the same `memory_type` is at or above `threshold` cosine. Items without a current-model vector are kept; a null threshold returns the list unchanged. `recall` applies it to the merged project + global list before `limit` (over-fetching `limit × 5` while it is on); prompt-recall applies it to the semantic hits before their slot cut and to the merged semantic + strict-keyword list before its limit.
- `planRestatements(memories, threshold)` — the `dedupe` plan, as data: per type, newest first (ties by id), each memory joins its most similar newer leader at or above `threshold` or becomes a leader. No chaining; pinned memories lead but are never superseded; `code` and unembedded memories are left out. Planning over the survivors yields nothing (idempotent), and the plan does not depend on input order.

### Cosine Similarity (at search time)

Used by `/recall` and prompt-recall for ranking when embeddings are available (relative order, no calibration), and by `consolidate` via hybrid similarity for duplicate-pair detection (0.5 Jaccard, the calibration's `consolidationCandidate` for cosine).

### Tokenizer

Lowercases, strips punctuation, splits on whitespace, returns `Set<string>`.

## Embedding Strategy

**One local model, no remote provider** (`infra/local-embed.ts`):

| Model | Runs | Dimensions | Type | Column |
|---|---|---|---|---|
| potion-retrieval-32M (`minishlab/potion-retrieval-32M`, model2vec static) | In-process on CPU, `@huggingface/transformers` on `onnxruntime-node` | 512 | Float32Array | `local_embedding` |

The model id and width are constants in `config.ts` (`LOCAL_EMBED_MODEL`, `LOCAL_EMBEDDING_DIMENSIONS`). A static model was chosen because the prompt-recall hook starts a fresh `bun` process per prompt, so load time is paid every time.

Each row records the model that embedded it in `local_embedding_model`. Recall only ranks rows tagged with the current model; backfill re-embeds the rest. `rowToMemory` enforces the same rule for every `Memory` read: `memory.local_embedding` is filled only when the row's tag is `LOCAL_EMBED_MODEL`, so dedup, consolidation, `dedupe` and distinct recall can never compare vectors from two models.

Every absolute cosine cutoff comes from the active model's calibration (see [Per-model cosine calibration](#per-model-cosine-calibration-configts-types-in-corecalibrationts)). When the model has a dedup calibration, extraction embeds its candidates (project candidates with the project prefix, global ones with `global`), dedups them by cosine and stores the vector it computed; when the model has none, extraction embeds nothing and dedups on Jaccard, and `remember` gets no embedder. Recall ranking always uses cosine: it needs relative order, not absolute cutoffs.

**The `embedding` column** (Float64 BLOB) is what remains of the removed remote provider. No code computes a vector for it. It is still part of the `Memory` type, so it is stored when a caller passes one and read back with the row. No similarity reads it — `remember`'s duplicate check used to fall back to it, but a vector of unknown provenance is exactly what the calibration rule keeps out. A memory holding only this vector is still in the backfill queue, and `inspect` counts it there.

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

`remember` inserts memories with `local_embedding = null`, and so does extraction when the active model has no cosine calibration (with one, extraction stores the vector it computed for dedup). `index-code` embeds its description inline. The `backfill` command processes the queue:
1. Fetch active, non-`code` memories recall cannot see: no `local_embedding`, or one from another model (`getActiveMemoriesNeedingEmbedding`)
2. Build embedding texts with metadata prefix
3. Embed them one at a time with the local model (it does not batch)
4. Write `local_embedding` and its model tag

If the model cannot load, every queued memory is reported as failed, with the load error.

`inspect`'s `embedding_queue_size` is the length of that same query over both databases, so it is the number of memories the next `backfill` will try to embed: 0 means backfill has nothing to do.

### Code Memory Rule

Raw code is **never** embedded. `code` type memories have `embedding = null, local_embedding = null` permanently. Search finds them via `source_of` edges from their paired `code_description` memory.

## Command Reference

### extract

SessionEnd hook pipeline. Reads JSON from stdin: `{session_id, transcript_path, cwd}`. Routes global-scoped candidates to the global DB, everything else to the project DB. Never throws — returns result object with error field.

### generate

Builds surface from ranked memories. Args: `<cwd>`. Opens both DBs, runs full pipeline, writes surface + cache + the generation status file (`.memory/cortex-status.json`).

### remember

Explicit memory creation. Args: `<cwd> <content> [--type=TYPE] [--priority=N] [--scope=SCOPE] [--pinned] [--tags=t1,t2] [--replaces=TAG]`. Defaults: type=context, priority=5, scope=project, confidence=1.0.

A new memory is refused as a near-duplicate at its similarity space's duplicate floor (`duplicateFloor`: the merge floor where a merge band exists, else the skip floor — 0.75 Jaccard, 0.92 potion cosine). The candidate is embedded for that check only when the active model has a cosine calibration.

`--replaces=TAG` (parsed at the CLI boundary by `parseReplacementTag`: non-empty, no commas, no whitespace) makes the new memory the current version of `TAG`: in one transaction it is inserted and every other active memory carrying `TAG` in the same database — pinned ones included — is superseded via `supersedeMemory` (status `superseded`, `supersedes` edge new → old, edges and facts re-pointed). The tag is added to the new memory's tags, and the duplicate check is skipped. The output appends `(superseded N: ids)`.

### recall

Semantic or keyword search. Args: `<cwd> <query> [--branch=B] [--limit=N] [--keyword]`. Searches both DBs, merges results (project first), follows `source_of` edges for linked code, BFS depth-2 for related memories. Updates `access_count` and `last_accessed_at`. Semantic search excludes archived and superseded memories; the `--branch` filter and distinct recall (`distinctFacts`, see above) are applied before the result limit (with over-fetch) so branch matches and distinct facts aren't cut off; an empty keyword query returns empty results rather than erroring.

### forget

Archive by ID or fuzzy keyword query. Tries ID lookup in project → global, then FTS5 search. Returns candidates for confirmation.

### consolidate

Two modes, project DB only.

**List mode** — `consolidate <cwd> [--threshold=N]`: detects duplicate pairs via hybrid similarity (cosine when both sides share an embedding type, Jaccard otherwise) and prints each pair with IDs, similarity %, type, priority, summary, and content for human review. Default threshold is per similarity space — 0.5 for Jaccard, the active calibration's `consolidationCandidate` for cosine (0.85 potion, 0.8 BGE); an uncalibrated model compares on Jaccard only. `--threshold=N` overrides uniformly.

**Merge mode** — `consolidate <cwd> --merge --a=<idA> --b=<idB> --summary=<text> --content=<text>`: merges one reviewed pair. The merged memory gets confidence 1.0 (human-approved), the higher priority of the two, combined tags, pinned if either was pinned, and null embeddings (backfill re-embeds the new content). Both originals are marked `superseded` with `supersedes` edges, and the new memory ID is printed. Run `backfill` + `generate` afterwards.

### dedupe

Restatement cleanup. Args: `<cwd> [--dry-run]`. For the project and the global database separately (one transaction each) it plans with `planRestatements` at the active calibration's `restatement` cosine and supersedes each older memory by the newer one it restates (`supersedeMemory`). `--dry-run` prints every pair (`cos`, kept and superseded id + summary) and writes nothing. A pair whose members are no longer both active when the transaction runs is skipped. Idempotent: a second run supersedes 0. Invalidates the surface cache when it superseded anything. With no restatement calibration it prints `Dedupe disabled: <model> has no restatement calibration` and touches nothing. Runs in every `maintenance` pass.

### lifecycle

Decay + archive + prune pass. Runs automatically after extraction. Computes centrality, applies decay formula, transitions per rules above. Processes both active and archived memories.

### index-code

Prose-code memory pairing. Creates two memories: `code_description` (with embedding) + `code` (without), linked via `source_of` edge. Re-indexing supersedes old versions for same file path. All writes in a single transaction.

### semantic-edges

Manual only; `maintenance` never runs it. Args: `<cwd>`. Sends batches of `relates_to` edge pairs to the LLM and rewrites each to the typed relation it names. A pair judged unrelated, or plain `relates_to`, keeps its edge unchanged and is stamped so it is not asked again until either memory's content changes; a failed batch is backed off for 24h.

### traverse

BFS graph traversal from a memory ID. Args: `traverse <cwd> <memoryId> [maxDepth]` — a single positional max depth (default 2); no other flags. Tries the project DB first, then the global DB. Batch-fetches discovered memories in single query.

### inspect

Telemetry display (JSON output). Queries both DBs for stats: active memory counts by type/scope, edge count, embedding queue size (what the next `backfill` would embed; see [Backfill](#backfill)), cache staleness. `memory_counts.unreadable` counts rows stored as active that do not hold a valid memory (for example a priority outside 1–10 written by another tool): every read skips such a row with a `[cortex:db] Skipping memory <id>: <reason>` line on stderr and leaves it in the file, so one bad row costs only itself. Reads `.memory/telemetry.json` for `maintenance`: when `lifecycle` and `ai-prune` last succeeded (`last_lifecycle_at`, `last_ai_prune_at`; null for never). Each advances its mark only on success, so a date that stops moving is a step failing on every run. It does not read `.memory/cortex-status.json`.

### backfill

Batch embedding processing. Fetches active memories with no usable vector (none, or one from another model), embeds each with the local model, and writes `local_embedding`.

### show-surface (hook entry, not a subcommand)

`bun show-surface-hook.ts <cwd>`, run by the `UserPromptSubmit` hook on every prompt: prints the surface beside `<cwd>`. When the surface's `**Branch:**` header is not the header the renderer would write for the checked-out branch (`surfaceIsForBranch`), it first runs `cli.ts load-surface <cwd>`. The comparison is between renderings because the renderer escapes and trims branch names (`<`, a leading `#`, CORTEX markers, more than 200 characters); comparing against the raw name reloaded such a branch on every prompt. The pi extension calls the same `showSurface` before each agent start, with its own CLI runner as the reload. It is a separate entry rather than a `cli.ts` subcommand so that the per-prompt process does not load the whole engine (about 40 ms per start against 105 ms).

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
| Project DB | `<repository root>/.memory/cortex.db` (main worktree; the directory itself outside git; `.memory/standalone` opts a directory out) | Yes |
| Global DB | `${XDG_DATA_HOME:-~/.local/share}/cortex/global.db` (shared by every harness; `CORTEX_GLOBAL_DB` overrides) | N/A |
| Surface | `<session directory>/.claude/cortex-memory.local.md` (beside the session, which may be a worktree or a subdirectory of the repository) | Yes |
| Cache | `<repository root>/.memory/surface-cache/{hash}.json` | Yes |
| Locks | `<repository root>/.memory/locks/` (`surface.lock`, and `merge.lock` while stray databases are merged) | Yes |
| Generation status | `<repository root>/.memory/cortex-status.json` — written by `generate` after each surface build: `last_generation`, `branch`, `memory_count`, `selected_count`, `duration_ms` | Yes |
| Telemetry | `<repository root>/.memory/telemetry.json` — maintenance cadence state, read and merged by `lifecycle` (`last_lifecycle_at`) and `ai-prune` (`last_ai_prune_at`); also the file `inspect` reads | Yes |
| Eval | `<repository root>/.memory/eval/` by default, beside the memory it measures (`--dir` overrides) | Yes |
| Pipeline logs | `/tmp/cortex-{extract,backfill,maintenance}.<pid>.log` per session end, `/tmp/cortex-load-surface.<pid>.log` for a failed session start; removed after 7 days | N/A |
| Pi detached log | `<session directory>/.memory/logs/pi-detached.log` — every detached Pi child, one dated header per run; rotated to `.log.1` past 5 MiB | Yes |

`.gitignore` patterns auto-added by `ensureGitignored()`: `.memory/`, `.claude/cortex-memory.local.md`, `.pi/cortex-memory.local.md`.

## Environment

| Variable | Purpose | Required |
|---|---|---|
| `CORTEX_ONNX_LD_PATH` | Directory holding a 64-bit `libstdc++.so.6` for `onnxruntime-node` (local embeddings). Hooks probe the nix store when unset | No (needed on NixOS only) |
| `CORTEX_LLM_BINARY` | Force headless LLM binary (`claude` or `pi`) | No (auto-detected) |
| `CORTEX_LLM_MODEL` | Override model for the LLM binary | No (`haiku` for claude; none for pi) |
| `CLAUDE_PLUGIN_ROOT` | Plugin directory | Auto-set by Claude Code |

Extraction, AI prune, and edge classification shell out to a headless coding-agent CLI: `claude -p --model haiku` by default, or `pi -p` when running under the pi agent (no `--model` flag — pi's configured provider default is used). Embeddings need no key or network service: they are computed in-process. If the embedder cannot load or embed, `recall` falls back to keyword search and backfill reports the memories as failed; extraction still works.

## Testing

```bash
cd engine && bun run test         # bun test --isolate (the vitest API, run by Bun)
cd engine && bun run test:watch   # same, in watch mode
cd engine && bun run typecheck    # tsc --noEmit -p . (also a CI step)
```

Use the scripts, not a bare `bun test`: `vi.mock` is process-wide under Bun, so
per-file `--isolate` is what keeps one file's module mocks out of the others.
The scripts also run the suite through `src/with-native-library-path.ts`, which
puts onnxruntime's libstdc++ on the loader path the way the CLI does for itself
(on NixOS it is not on the default path; elsewhere the wrapper changes nothing).
Without it the local-embedding tests cannot import the model on NixOS.

The engine pins `onnxruntime-node` to 1.24.3 through `overrides` in
`package.json`: earlier versions make Bun panic at process exit (status 134)
once the embedding model has loaded.

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
| `AI_PRUNE_MIN_NEW_MEMORIES` | 20 | `config.ts` |
| `AI_PRUNE_MAX_AGE_DAYS` | 7 | `config.ts` |
| `AI_PRUNE_MIN_INTERVAL_HOURS` | 6 | `config.ts` |
| `DEFAULT_SEARCH_LIMIT` | 10 | `config.ts` |
| `DEFAULT_TRAVERSAL_DEPTH` | 2 | `config.ts` |
| `LOCAL_EMBEDDING_DIMENSIONS` | 512 | `config.ts` |
| LLM CLI (extraction/prune/edges) | `claude -p --model haiku` (or `pi -p`) | `claude-llm.ts` |
| `LOCAL_EMBED_MODEL` | `minishlab/potion-retrieval-32M` | `config.ts` |
| `cosineCalibrationFor(model)` | potion-retrieval-32M, bge-small-en-v1.5 (others: null → Jaccard) | `config.ts` |
| `JACCARD_DEDUP` | merge 0.75 / skip 0.85, intra-batch 0.75 | `config.ts` |
