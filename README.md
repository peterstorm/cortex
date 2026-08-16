# Cortex

Persistent memory plugin for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Automatically learns from your coding sessions and surfaces relevant knowledge in future ones.

```
Session ends  → reads transcript → extracts memories → stores in SQLite
Session starts → loads ranked memories → writes context file for Claude
```

Claude Code reads `.claude/cortex-memory.local.md` as context, giving it "memory" across sessions.

## Table of Contents

- [How It Works](#how-it-works)
- [Installation](#installation)
- [Commands](#commands)
- [Architecture](#architecture)
- [Memory Model](#memory-model)
- [Ranking & Surface Generation](#ranking--surface-generation)
- [Memory Graph](#memory-graph)
- [Similarity & Deduplication](#similarity--deduplication)
- [Semantic Search](#semantic-search)
- [Memory Lifecycle](#memory-lifecycle)
- [Configuration](#configuration)
- [File Layout](#file-layout)
- [Development](#development)

## How It Works

### Session Start

A `SessionStart` hook loads a cached "surface" — a compact markdown summary of the most relevant memories. The cache is keyed by `sha256(branch:cwd)` and valid for 24 hours. If stale or missing, it regenerates from the database — but only for projects that already have a `.memory/cortex.db` (the hook never creates databases in untouched projects). In Pi, this cache refresh is detached so startup and `/new` do not wait on the engine CLI; an existing surface remains readable until the atomic refresh completes. Additionally, a `UserPromptSubmit` hook pipes the surface file contents on every prompt, and a second `UserPromptSubmit` hook (`prompt-recall.sh`) runs keyword recall against your prompt — strict AND search over prompt keywords first, OR fallback, plus a conservative semantic fallback (0.65 cosine floor) when keywords find nothing.

### During a Session

Seven slash commands let you interact with memory directly: `/remember`, `/recall`, `/forget`, `/consolidate`, `/inspect`, `/prune`, and `/index-code`.

### Session End

A `SessionEnd` hook detaches a background worker (so nothing blocks the session) that runs the pipeline sequentially:

1. **Extract** — Stream the session transcript (JSONL), project it to what the model actually saw (dropping subagent `details`, tool-result siblings and snapshots — ~96% of bytes on subagent-heavy sessions) and read it in resumable 100KB chunks of that projection, add git context (branch, commits, changed files), and use the configured direct OpenAI-compatible endpoint with thinking disabled, falling back to a headless coding-agent CLI when no direct endpoint is available; each invocation is bounded to five chunks, and the detached ingestion worker retries deferred or transiently failed extraction until the cursor reaches EOF before backfill; global-scoped candidates are routed to the global DB, while entity-only/global-only responses receive a project-local provenance memory so extracted facts are retained
2. **Backfill** — Compute embeddings for newly extracted memories (local static model, no API)
3. **Semantic Edges** — Classify similarity-created `relates_to` edges into typed relationships
4. **Lifecycle** — Decay confidence, archive stale memories, prune old ones
5. **AI Prune** — When due, the LLM evaluates active memories and archives low-value ones
6. **Generate** — Rebuild the surface file LAST, after all archival, so the next session never starts from a surface containing just-archived memories

Steps 3-6 run through one per-project-locked `maintenance` command. Simultaneous session shutdowns therefore cannot multiply expensive LLM workers, and a separate AI-prune lock protects manual invocations. Claude Code's detached hook worker writes PID-scoped extraction, backfill, and maintenance logs under `/tmp`.

The Pi extension launches extract → backfill → maintenance as one detached `ingest-session` worker. Its `session_shutdown` handler returns immediately, so `/new` and `/q` do not wait for transcript ingestion. Ephemeral sessions — subagent spawns run `pi -p --no-session` — have no persisted transcript, so their shutdown spawns **nothing** (no extraction, no maintenance): nothing new entered the store, and running ai-prune/semantic-edges would only spend LLM budget competing with the live agents that spawned the session. The spawning session's own ingestion pipeline maintains the store, and manual `bun engine/src/cli.ts maintenance <cwd>` remains available for catch-up.

Nested extraction LLMs inherit `CORTEX_EXTRACTING=1`; both Pi and Claude Code shutdown handlers treat that marker as a terminal no-op. This invariant prevents a headless extraction process from recursively spawning another maintenance pipeline. All hooks remain non-blocking and never fail the parent session.

## Installation

### Prerequisites

- [Bun](https://bun.sh) runtime
- Claude Code CLI (provides `claude` binary on PATH)

### Setup (marketplace install)

The repo ships a self-marketplace manifest (`.claude-plugin/marketplace.json`), so you can install straight from git:

```
/plugin marketplace add <repo-url>
/plugin install cortex@cortex
```

Then install engine dependencies inside the installed plugin's `engine/` directory (`bun install`).

### Setup (manual clone)

1. Clone this repo into your Claude Code plugins directory:
   ```bash
   # Typically ~/.claude/plugins/
   git clone <repo-url> ~/.claude/plugins/cortex
   ```

2. Install engine dependencies:
   ```bash
   cd ~/.claude/plugins/cortex/engine
   bun install
   ```

3. Restart Claude Code — the plugin registers automatically via `plugin.json` and `hooks.json`.

## Commands

| Command | Purpose | When to Use |
|---|---|---|
| `/remember` | Store an explicit memory | Architectural decisions, gotchas, patterns, insights |
| `/recall <query>` | Semantic or keyword search | Before starting tasks, encountering unfamiliar code, making decisions |
| `/forget <id\|query>` | Archive a memory | When information is outdated, incorrect, or contradictory |
| `/consolidate` | Detect and merge duplicate memories | Periodically (every 10-20 extractions) or when memory feels cluttered |
| `/inspect` | View memory health & stats | Diagnostics — counts, queue sizes, extraction stats, graph metrics |
| `/prune` | AI-powered pruning pass | Periodically to keep memory lean and high-signal |
| `/index-code` | Pair prose with source code | When important code is written — creates a searchable code memory |

### `/remember`

```
/remember "Architecture: Using FC/IS pattern for all business logic"
  --type=architecture --priority=8 --scope=project --pinned --tags=design,core
```

Options:
- `--type`: `architecture`, `decision`, `pattern`, `gotcha`, `context`, `progress`, `code_description`
- `--priority`: 1-10 (default 5)
- `--scope`: `project` or `global` (default project)
- `--pinned`: Exempt from decay
- `--tags`: Comma-separated keywords

### `/recall`

```
/recall "authentication flow" --limit=5
/recall "database schema" --keyword     # Force FTS5 keyword search
/recall "deployment config" --branch=feature/deploy
```

Returns matched memories enriched with graph-traversed related memories (depth 2).

### `/index-code`

```
/remember "The ranking formula weights confidence 50%, priority 20%..." --type=code_description
# → memory-abc123
/index-code memory-abc123 ./engine/src/core/ranking.ts
```

Creates a `code` type memory linked to the prose description via a `source_of` edge. Code is discoverable through searching for its prose description.

## Architecture

Cortex follows a **Functional Core / Imperative Shell** design:

```
┌───────────────────────────────────────────────────────┐
│              Functional Core  (engine/src/core/)       │
│                                                       │
│  Pure functions. No I/O. No side effects. Testable.   │
│                                                       │
│  types.ts       Domain types + validation             │
│  extraction.ts  Extraction prompt build/parse         │
│  similarity.ts  Jaccard, cosine, classification       │
│  graph.ts       BFS traversal, centrality             │
│  ranking.ts     Composite rank, budget selection      │
│  surface.ts     Markdown generation, token budgets    │
│  decay.ts       Exponential decay, lifecycle rules    │
└───────────────────────────────────────────────────────┘
                          ↕
┌───────────────────────────────────────────────────────┐
│            Imperative Shell  (engine/src/infra/)      │
│                                                       │
│  All side effects live here: SQLite, APIs, fs, git    │
│                                                       │
│  db.ts           SQLite CRUD, schema, FTS5            │
│  filesystem.ts   PID locking, surface write           │
│  git-context.ts  Branch, commits, changed files       │
│  claude-llm.ts   Headless LLM CLI client (claude/pi)  │
│  local-embed.ts  HuggingFace transformers fallback    │
└───────────────────────────────────────────────────────┘
                          ↕
┌───────────────────────────────────────────────────────┐
│           Commands  (engine/src/commands/)             │
│                                                       │
│  Orchestrate core + infra for each operation          │
│                                                       │
│  extract.ts, generate.ts, remember.ts, recall.ts,     │
│  forget.ts, consolidate.ts, lifecycle.ts, ai-prune.ts │
│  index-code.ts, backfill.ts, semantic-edges.ts,       │
│  inspect.ts, traverse.ts                              │
└───────────────────────────────────────────────────────┘
```

### Two Databases

| Database | Location | Scope |
|---|---|---|
| **Project** | `<project>/.memory/cortex.db` | Project-specific memories (default) |
| **Global** | Claude: `~/.claude/memory/cortex-global.db`; Pi: `~/.pi/agent/memory/cortex-global.db` | Cross-project knowledge |

During extraction, candidates the LLM classifies as scope `"global"` are routed to the active harness's global database; everything else lands in the project database.

### External Services

| Service | Purpose | Required |
|---|---|---|
| OpenAI-compatible LLM endpoint | Preferred transport for memory extraction, AI pruning, and edge classification; configure `CORTEX_LLM_API_URL`, `CORTEX_LLM_API_KEY`, and `CORTEX_LLM_MODEL`, or a compatible Pi provider | No (falls back to a headless CLI) |
| Headless agent CLI (`claude -p --model haiku`, or `pi -p` under the Pi agent) | Fallback transport when no direct OpenAI-compatible endpoint is configured, or a single direct call fails | No (required only when the direct endpoint is unavailable; override with `CORTEX_LLM_BINARY`/`CORTEX_LLM_MODEL`. After 3 consecutive direct failures the fallback is suppressed — the server is saturated and escalation would only add load — and the work is deferred to the next run; tune with `CORTEX_LLM_MAX_DIRECT_FAILURES`) |
| HuggingFace Transformers | Local embedding (EmbeddingGemma-300M ONNX, 768-dim) | Bundled |

## Memory Model

### Memory Types

Each extracted memory is classified into one of eight types:

| Type | What It Captures | Decay |
|---|---|---|
| `architecture` | System design, structure, patterns | None (stable) |
| `decision` | Choices made with rationale | None (stable) |
| `pattern` | Reusable code/design patterns | 60-day half-life |
| `gotcha` | Pitfalls, edge cases, warnings | 45-day half-life |
| `context` | Background info, explanations | 30-day half-life |
| `progress` | Status updates, completed work | 7-day half-life |
| `code_description` | Prose explanation of code | None (stable) |
| `code` | Raw source code (paired with descriptions) | None (stable) |

### Memory Fields

Each memory carries:
- **Content** — full text
- **Summary** — short (<=200 chars), used in surface
- **Confidence** (0-1) — LLM's quality assessment, decays over time
- **Priority** (1-10) — importance rating, static
- **Scope** — `project` or `global`
- **Tags** — keyword array for searchability
- **Pinned** — exempt from decay when true
- **Status** — `active` → `archived` → `pruned`
- **Embeddings** — local static model (512-dim Float32), no API key
- **Source context** — session ID, git branch, commits, changed files

## Ranking & Surface Generation

### Composite Ranking Formula

Every memory is scored for surface inclusion and search result ordering:

```
rank = (confidence × 0.50)
     + (priority/10 × 0.20)
     + (centrality × 0.15)
     + (log(access+1)/maxLog × 0.15)
     + branch_boost (0.1 if same branch)
```

A **recency decay** multiplier is applied (unless pinned):

```
rank *= 1 / (1 + max(0, age_days) / 14)
```

### Surface Generation

The surface is the markdown file Claude reads at session start. Generation:

1. Fetch all active memories from both databases
2. Compute graph centrality (in-degree / max)
3. Score each memory using the ranking formula
4. Select top memories within per-category line budgets:

| Category | Budget |
|---|---|
| Architecture | 25 lines |
| Decision | 25 lines |
| Pattern | 25 lines |
| Gotcha | 20 lines |
| Progress | 30 lines |
| Context | 15 lines |
| Code Description | 10 lines |
| Code | 0 (excluded) |

5. High-value memories overflow into unused budget from under-populated categories
6. Target ~1500 tokens, hard max 2000 (including ~200 tokens of markdown overhead)
7. Wrap in `<!-- CORTEX_MEMORY_START/END -->` markers
8. Cache keyed by `sha256(branch:cwd)`

## Memory Graph

Memories are connected through typed edges, forming a knowledge graph.

### Edge Types

| Type | Meaning | Directionality |
|---|---|---|
| `relates_to` | Generic similarity | Bidirectional |
| `derived_from` | Conceptual dependency | Directional |
| `contradicts` | Conflicting information | Bidirectional |
| `exemplifies` | Concrete example of concept | Directional |
| `refines` | Improvement or clarification | Directional |
| `supersedes` | Replaces or obsoletes | Directional |
| `source_of` | Links prose description to code | Directional |

### Graph Uses

- **Centrality** — Memories connected to many others rank higher in the surface
- **Search enrichment** — `/recall` follows edges (depth-2 BFS) to find related memories
- **Code discovery** — `source_of` edges link prose descriptions to raw code blocks

## Similarity & Deduplication

### Two-Tier Approach

**Tier 1: Edge classification** (at insertion time)

Hybrid similarity — cosine on local embeddings when both sides have one, Jaccard token overlap otherwise — with bands calibrated per similarity space. Raw local cosine on BGE-small-en-v1.5 runs "hot" (same-domain memories about different aspects routinely score 0.6-0.75), so it uses higher cutoffs. These bands belong to that specific model; when a different local model is active they are disabled rather than reused (see `LOCAL_COSINE_CALIBRATED`):

| Band | Jaccard score | Local cosine score | Action |
|---|---|---|---|
| ignore | < 0.1 | < 0.6 | Skip |
| relate | 0.1 - 0.4 | 0.6 - 0.75 | Create `relates_to` edge |
| suggest | 0.4 - 0.5 | 0.75 - 0.82 | Create suggested edge for review |
| consolidate | > 0.5 | ≥ 0.82 | Create strong `relates_to` edge |

Each new memory keeps at most its 3 strongest edges (structural guard against edge explosion).

**Tier 2: Cosine Similarity** (embeddings)

Used by `/recall` for search ranking and by `/consolidate` for duplicate detection. Consolidation thresholds are per-space: Jaccard flags pairs above 0.5; raw local cosine flags pairs above 0.8 — but only when the active local model is the calibrated one, otherwise local cosine is excluded from consolidation entirely.

### Consolidation

`/consolidate` scans all active memory pairs using the hybrid Jaccard + cosine approach and prints each candidate pair (IDs, similarity %, type, priority, summary, content) for review. Approved pairs are merged one at a time via `consolidate <cwd> --merge --a=<idA> --b=<idB> --summary=<text> --content=<text>` — the merged memory supersedes both originals, and its embeddings start null so backfill re-embeds the new content.

## Semantic Search

`/recall` supports two search modes:

### Semantic (default, always available)

1. Embed query locally: `[query] [project:name] <user query>`
2. Cosine similarity against stored embeddings in both databases (archived and superseded memories are excluded)
3. Merge results (project-scoped first); with `--branch`, the filter is applied before the result limit so branch matches aren't cut off
4. Enrich with depth-2 graph traversal
5. Update access count (boosts ranking, delays archival)

### Keyword (fallback, or `--keyword` flag)

FTS5 full-text search on content, summary, and tags. Useful when an exact term matters more than meaning.

### Embedding Strategy

Memories are inserted **without** embeddings to avoid blocking extraction. A background `backfill` command computes them asynchronously:

| Model | Dimensions | Storage Column | When |
|---|---|---|---|
| potion-retrieval-32M (local, static) | 512 (Float32) | `local_embedding` | Always — runs on CPU in-process, no API key |

Embedding text format: `[memory_type] [project:name] summary` — enables type-aware and project-aware similarity.

`code` type memories are never embedded (security + cost). They're found via `source_of` edges from their paired `code_description`.

## Memory Lifecycle

Memories aren't permanent. A decay-archive-prune lifecycle keeps knowledge fresh:

### Decay

Confidence decays exponentially based on memory type half-life:

```
decayed_confidence = original × 0.5^(age_days / half_life)
```

Half-life is boosted by access frequency and graph centrality:

```
effective_half_life = base × (1 + log2(1 + access_count) × 0.3) × (1 + centrality)
```

Pinned memories and those with centrality > 0.5 are exempt.

### Archive

If decayed confidence is below 0.3 and the memory hasn't been accessed in 14+ days (and not pinned, centrality <= 0.5) → status changes to `archived`. Archived memories don't appear in the surface or search results.

**Escape hatch:** Accessing a memory via `/recall` resets its `last_accessed_at`, delaying archival.

### Prune

Archived memories with no access for 30+ days → status changes to `pruned` (effectively deleted, still in DB but invisible).

### AI Prune

The LLM evaluates active memories in batches and archives low-value ones. Triggered by a watermark: it runs when **20+ active memories were created since the last successful prune** (telemetry `last_ai_prune_at`) or when that successful prune is **7+ days old** (staleness floor), subject to a 6h minimum interval between runs. The watermark advances only on a fully successful run, so a failed prune keeps the review owed and retries on the next maintenance pass. Session *count* deliberately no longer triggers it — subagent-heavy runs end many sessions per hour, which used to turn a full multi-batch LLM re-review into a per-session tax. It runs inside the per-project-locked maintenance pipeline and also holds an AI-prune-specific lock.

## Configuration

### Environment Variables

| Variable | Purpose | Required |
|---|---|---|
| `CORTEX_ONNX_LD_PATH` | Directory holding a 64-bit `libstdc++.so.6` for onnxruntime. Hooks probe the nix store when unset; needed on NixOS, a no-op elsewhere | No |
| `CORTEX_LLM_API_URL` | Base URL (or `/chat/completions` URL) for an explicit OpenAI-compatible LLM endpoint | No |
| `CORTEX_LLM_API_KEY` | API key for the explicit OpenAI-compatible LLM endpoint | Required with `CORTEX_LLM_API_URL` |
| `CORTEX_LLM_BINARY` | Force the headless LLM binary (`claude` or `pi`) | No (auto-detected) |
| `CORTEX_LLM_MODEL` | Model for explicit direct endpoint configuration, or override passed to the fallback LLM binary | Required with explicit direct endpoint config; otherwise no (`haiku` for claude; none for pi) |
| `CORTEX_LLM_MAX_DIRECT_FAILURES` | Consecutive direct-endpoint failures after which the headless-CLI fallback is suppressed (work is deferred instead of escalating load on a saturated server) | No (default 3) |
| `CORTEX_LLM_MAX_CONCURRENCY` | Max in-flight LLM calls per engine process (extraction, edge classification, AI prune, and any subprocess fallback share the pool) so background work stays a bounded share of a server live agents rely on | No (default 2; 1 is most conservative) |
| `CLAUDE_PLUGIN_ROOT` | Plugin directory | Auto-set by Claude Code |

Extraction, AI pruning, and edge classification prefer a **direct OpenAI-compatible endpoint** when one is configured: `CORTEX_LLM_API_URL`, `CORTEX_LLM_API_KEY`, and `CORTEX_LLM_MODEL` (or the pi provider config in `~/.pi/agent/models.json` — the active provider's `baseUrl`/`apiKey`/first model). Calls disable model thinking and use schema-guided JSON output where supported. Without a configured endpoint they fall back to a headless coding-agent CLI: `claude -p --model haiku` by default, or `pi -p --thinking off` when running under the pi agent. A single direct-call failure still falls back, but once failures reach the saturation threshold (default 3, `CORTEX_LLM_MAX_DIRECT_FAILURES`) the fallback is suppressed and the call throws: a saturated local server (empty content, timeouts) would only get worse from full agent-loop subprocesses, so the caller defers the work (unmarked edges, un-advanced checkpoints) and retries on the next run. All LLM calls also draw from a per-process concurrency pool (default 2, `CORTEX_LLM_MAX_CONCURRENCY`), so background work cannot flood a shared server — even when the server merely queues rather than errors.

### Key Constants

| Constant | Value | Purpose |
|---|---|---|
| `MAX_TRANSCRIPT_BYTES` | 100 KB | Chunk size of PROJECTED transcript per extraction step |
| LLM call timeout | 90s | Extraction / edge-classification time budget |
| `SURFACE_STALE_HOURS` | 24h | Cache expiry |
| `RECENCY_HALF_LIFE_DAYS` | 14 | Ranking decay half-life |
| `PRUNE_THRESHOLD_DAYS` | 30 | Archived → pruned transition |
| `AI_PRUNE_SESSION_INTERVAL` | 5 | Run AI prune every N sessions |
| `AI_PRUNE_MEMORY_THRESHOLD` | 50 | AI prune trigger count |
| `DEFAULT_SEARCH_LIMIT` | 10 | Results per `/recall` |
| `DEFAULT_TRAVERSAL_DEPTH` | 2 | BFS depth for graph walks |

## File Layout

```
<project>/
  .memory/
    cortex.db                   # Project SQLite database
    surface-cache/              # Cached surfaces (branch-keyed)
    locks/                      # PID lock files
    cortex-status.json          # Generated health telemetry (extraction stats, timing)
    telemetry.json              # Maintenance and AI-prune cadence state
  .claude/
    cortex-memory.local.md      # Surface file Claude reads

~/.claude/
  memory/
    cortex-global.db            # Claude global SQLite database
  plugins/
    cortex/
      .claude-plugin/
        plugin.json             # Plugin manifest
      hooks/
        hooks.json              # Hook registrations
        scripts/
          extract-and-generate.sh   # SessionEnd hook
          load-surface.sh           # SessionStart hook
          prompt-recall.sh          # UserPromptSubmit hook (keyword recall)
      engine/src/               # TypeScript source
      commands/                 # Skill markdown files

~/.pi/agent/
  memory/
    cortex-global.db            # Pi global SQLite database
```

All `.memory/` contents and `cortex-memory.local.md` are gitignored automatically.

## Development

### Prerequisites

- [Bun](https://bun.sh) >= 1.0

### Install & Test

```bash
cd engine
bun install
bun test          # vitest run
bun test:watch    # vitest watch mode
```

### CLI Usage

```bash
# Internal commands (called by hooks)
bun engine/src/cli.ts extract < input.json
bun engine/src/cli.ts generate <cwd>
bun engine/src/cli.ts load-surface <cwd>
bun engine/src/cli.ts backfill <cwd>
bun engine/src/cli.ts lifecycle <cwd> --if-needed
bun engine/src/cli.ts ai-prune <cwd> --if-needed
bun engine/src/cli.ts semantic-edges <cwd>
bun engine/src/cli.ts maintenance <cwd>

# Manual commands
bun engine/src/cli.ts remember <cwd> "content" --type=pattern
bun engine/src/cli.ts recall <cwd> "query"
bun engine/src/cli.ts forget <cwd> "id-or-query"
bun engine/src/cli.ts consolidate <cwd> [--threshold=N]
bun engine/src/cli.ts consolidate <cwd> --merge --a=<idA> --b=<idB> --summary=<text> --content=<text>
bun engine/src/cli.ts inspect <cwd>
bun engine/src/cli.ts index-code <cwd> <proseId> <codePath>
bun engine/src/cli.ts traverse <cwd> <memoryId> [maxDepth]
```

### Testing Strategy

- **Unit tests** (`core/*.test.ts`) — Pure functions tested with property-based testing via [fast-check](https://github.com/dubzzz/fast-check)
- **Integration tests** (`infra/*.test.ts`, `commands/*.test.ts`) — SQLite test databases, API mocks

### Dependencies

| Package | Purpose |
|---|---|
| `bun:sqlite` | SQLite (WAL mode, FTS5) — built into Bun, no install needed |
| `@huggingface/transformers` | Local embedding model fallback |
| `ts-pattern` | Exhaustive pattern matching |
| `vitest` | Test framework |
| `fast-check` | Property-based testing |

## License

MIT
