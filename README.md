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

A `SessionStart` hook loads a cached "surface" — a compact markdown summary of the most relevant memories. The cache is keyed by `sha256(branch:cwd)` and valid for 24 hours. If stale or missing, it regenerates from the database — but only for projects that already have a `.memory/cortex.db` (the hook never creates databases in untouched projects). Additionally, a `UserPromptSubmit` hook pipes the surface file contents on every prompt, and a second `UserPromptSubmit` hook (`prompt-recall.sh`) runs keyword recall against your prompt — strict AND search over prompt keywords first, OR fallback, plus a conservative semantic fallback (0.65 cosine floor) when keywords find nothing.

### During a Session

Seven slash commands let you interact with memory directly: `/remember`, `/recall`, `/forget`, `/consolidate`, `/inspect`, `/prune`, and `/index-code`.

### Session End

A `SessionEnd` hook detaches a background worker (so nothing blocks the session) that runs the pipeline sequentially:

1. **Extract** — Read the session transcript (JSONL), truncate if >100KB (resumable via cursor checkpoints), add git context (branch, commits, changed files), and pipe to a headless coding-agent CLI (`claude -p --model haiku` by default) for memory extraction; global-scoped candidates are routed to the global DB
2. **Backfill** — Compute embeddings for newly extracted memories (Gemini API, or local HuggingFace fallback)
3. **Semantic Edges** — Classify similarity-created `relates_to` edges into typed relationships
4. **Lifecycle** — Decay confidence, archive stale memories, prune old ones
5. **AI Prune** — When due, the LLM evaluates active memories and archives low-value ones
6. **Generate** — Rebuild the surface file LAST, after all archival, so the next session never starts from a surface containing just-archived memories

The maintenance steps (3-5) run sequentially — not as concurrent detached spawns — because SQLite allows one writer and lifecycle + AI prune both read-modify-write telemetry. Each step logs to a per-process file `/tmp/cortex-<step>.<pid>.log` (extract, backfill, semantic-edges, lifecycle, ai-prune, generate).

All hooks exit 0 unconditionally — errors are logged, never surfaced. A `CORTEX_EXTRACTING=1` environment variable prevents recursive hook storms when `claude -p` is invoked during extraction.

## Installation

### Prerequisites

- [Bun](https://bun.sh) runtime
- Claude Code CLI (provides `claude` binary on PATH)
- `GEMINI_API_KEY` environment variable (for embeddings + semantic search; without it, recall falls back to keyword search)

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

3. Set up the Gemini API key (optional but recommended):
   ```bash
   export GEMINI_API_KEY="your-key-here"
   ```

   Hooks don't inherit your shell profile — they source the key from a file instead. By default they look at the sops-nix path (`~/.config/sops-nix/secrets/rendered/gemini-env`); set `CORTEX_GEMINI_ENV` to point at any file that exports `GEMINI_API_KEY`.

4. Restart Claude Code — the plugin registers automatically via `plugin.json` and `hooks.json`.

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
│  extraction.ts  Transcript truncation, prompt/parse   │
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
│  gemini-embed.ts Gemini embedding API                 │
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
| **Global** | `~/.claude/memory/cortex-global.db` | Cross-project knowledge |

During extraction, candidates the LLM classifies as scope `"global"` are routed to the global database; everything else lands in the project database.

### External Services

| Service | Purpose | Required |
|---|---|---|
| Headless agent CLI (`claude -p --model haiku`, or `pi -p` under the pi agent) | Memory extraction, AI pruning, edge classification | Yes (uses your Anthropic subscription; override with `CORTEX_LLM_BINARY`/`CORTEX_LLM_MODEL`) |
| Gemini Embedding-001 | Semantic embeddings (768-dim) — the only thing `GEMINI_API_KEY` is used for | No (falls back to local) |
| HuggingFace Transformers | Local embedding fallback (BGE-small-en-v1.5, 384-dim) | Bundled |

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
- **Embeddings** — Gemini (768-dim Float64) and/or local (384-dim Float32)
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

Hybrid similarity — cosine on local embeddings when both sides have one, Jaccard token overlap otherwise — with bands calibrated per similarity space. Raw 384-dim local cosine runs "hot" (same-domain memories about different aspects routinely score 0.6-0.75), so it uses higher cutoffs:

| Band | Jaccard score | Local cosine score | Action |
|---|---|---|---|
| ignore | < 0.1 | < 0.6 | Skip |
| relate | 0.1 - 0.4 | 0.6 - 0.75 | Create `relates_to` edge |
| suggest | 0.4 - 0.5 | 0.75 - 0.82 | Create suggested edge for review |
| consolidate | > 0.5 | ≥ 0.82 | Create strong `relates_to` edge |

Each new memory keeps at most its 3 strongest edges (structural guard against edge explosion).

**Tier 2: Cosine Similarity** (embeddings)

Used by `/recall` for search ranking and by `/consolidate` for duplicate detection. Consolidation thresholds are per-space: Jaccard and Gemini-768 cosine flag pairs above 0.5; raw local-BGE cosine flags pairs above 0.8.

### Consolidation

`/consolidate` scans all active memory pairs using the hybrid Jaccard + cosine approach and prints each candidate pair (IDs, similarity %, type, priority, summary, content) for review. Approved pairs are merged one at a time via `consolidate <cwd> --merge --a=<idA> --b=<idB> --summary=<text> --content=<text>` — the merged memory supersedes both originals, and its embeddings start null so backfill re-embeds the new content.

## Semantic Search

`/recall` supports two search modes:

### Semantic (default, requires `GEMINI_API_KEY`)

1. Embed query via Gemini: `[query] [project:name] <user query>`
2. Cosine similarity against stored embeddings in both databases (archived and superseded memories are excluded)
3. Merge results (project-scoped first); with `--branch`, the filter is applied before the result limit so branch matches aren't cut off
4. Enrich with depth-2 graph traversal
5. Update access count (boosts ranking, delays archival)

### Keyword (fallback, or `--keyword` flag)

FTS5 full-text search on content, summary, and tags. No API key needed, works offline.

### Embedding Strategy

Memories are inserted **without** embeddings to avoid blocking extraction. A background `backfill` command computes them asynchronously:

| Model | Dimensions | Storage Column | When |
|---|---|---|---|
| Gemini Embedding-001 | 768 (Float64) | `embedding` | When `GEMINI_API_KEY` available |
| BGE-small-en-v1.5 (local) | 384 (Float32) | `local_embedding` | Fallback when no API key |

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

The LLM evaluates active memories in batches and archives low-value ones. Triggered when 5+ sessions have passed since the last prune, or when the active memory count reaches max(50, 1.25 × the count at the last prune) — the growth backoff prevents a full prune from firing every session once the store stays above the base threshold. Runs as part of the detached SessionEnd worker.

## Configuration

### Environment Variables

| Variable | Purpose | Required |
|---|---|---|
| `GEMINI_API_KEY` | Embeddings + semantic search (embeddings only — never used for extraction) | No (falls back to keyword search + local embeddings) |
| `CORTEX_GEMINI_ENV` | Path to a file hooks source to get `GEMINI_API_KEY` (default: sops-nix path) | No |
| `CORTEX_LLM_BINARY` | Force the headless LLM binary (`claude` or `pi`) | No (auto-detected) |
| `CORTEX_LLM_MODEL` | Override the model passed to the LLM binary | No (`haiku` for claude; none for pi) |
| `CLAUDE_PLUGIN_ROOT` | Plugin directory | Auto-set by Claude Code |

Extraction, AI pruning, and edge classification shell out to a headless coding-agent CLI: `claude -p --model haiku` by default, or `pi -p` when running under the pi agent (no `--model` flag, so pi's configured provider default is used). No separate API key needed — it uses your Anthropic subscription.

### Key Constants

| Constant | Value | Purpose |
|---|---|---|
| `MAX_TRANSCRIPT_BYTES` | 100 KB | Trigger resumable extraction |
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
    cortex-status.json          # Telemetry (extraction stats, timing)
  .claude/
    cortex-memory.local.md      # Surface file Claude reads

~/.claude/
  memory/
    cortex-global.db            # Global SQLite database
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
