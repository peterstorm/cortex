# Cortex: How It Works

Cortex is a persistent memory plugin for Claude Code. It automatically learns from your coding sessions and surfaces relevant knowledge when you start new ones.

## The 30-Second Version

```
Session ends → reads transcript → Claude CLI extracts memories → stored in SQLite
Session starts → loads ranked memories → writes to .claude/cortex-memory.local.md
```

Claude Code reads that `.md` file as context, so it "remembers" past sessions.

---

## Two Databases

Cortex maintains **two** SQLite databases:

| Database | Location | Scope |
|---|---|---|
| **Project** | `<project>/.memory/cortex.db` | Project-specific memories (default) |
| **Global** | `~/.claude/memory/cortex-global.db` | Cross-project knowledge |

During extraction, candidates the LLM classifies as scope "global" (e.g., "TypeScript generics work like this" vs "our API uses X pattern") are routed to the **global** database; everything else lands in the project database.

---

## Session Lifecycle

### 1. Session Start (`SessionStart` hook → `load-surface.sh`)

When you start Claude Code:

1. Check for a **cached surface** file (keyed by `sha256(branch:cwd)`)
2. If cache exists and is < 24h old → serve from cache
3. If stale or missing → regenerate from DB (explained in "Surface Generation" below) — but only if the project already has a `.memory/cortex.db`; the hook never creates databases in untouched projects
4. Write result to `.claude/cortex-memory.local.md`

Claude Code loads this file as context. The surface targets ~1500 tokens (hard max 2000) — enough for relevant memories without bloating the context window.

### 2. During Session

**Every prompt** triggers two `UserPromptSubmit` hooks: one pipes the surface file into context, and one (`prompt-recall.sh`) runs keyword recall against your prompt — strict AND search over the prompt's keywords first, then an OR fallback, plus a conservative semantic fallback (cosine floor 0.65) when the keyword path returns nothing. Results already in the surface are deduplicated away.

You can also interact with cortex manually:

| Command | What it does |
|---|---|
| `/remember` | Manually store a specific memory |
| `/recall <query>` | Search memories by semantic similarity or keywords |
| `/forget <id>` | Mark a memory as archived |
| `/index-code` | Index source files as code memories (CLI: `index-code <cwd> <proseId> <codePath>`) |
| `/consolidate` | Merge duplicate/overlapping memories |
| `/inspect` | View memory stats, recent extractions, DB health |
| `/prune` | AI-assisted pruning pass over active memories |

There's also an `entity-query` CLI command for entity-first temporal retrieval (`entity-query <cwd> <query> [--history] [--limit=N]`).

### 3. Session End (`SessionEnd` hook → `extract-and-generate.sh`)

When your session ends, the hook detaches a background worker (so nothing blocks the session) that runs the pipeline sequentially:

1. **Read transcript** — the JSONL file Claude Code writes during the session
2. **Resume from checkpoint** — if transcript > 100KB, extraction is resumable; picks up where it left off
3. **Send to the LLM CLI** — pipes extraction prompt to `claude -p --model haiku` (uses your Anthropic subscription), or `pi -p` when running under the pi agent
4. **Parse response** — validate each memory candidate (type, confidence, priority); global-scoped candidates go to the global DB
5. **Store in DB** — insert memories, compute similarity edges to existing memories
6. **Backfill embeddings** — embed newly stored memories (Gemini, or local fallback)
7. **Maintenance (sequential)** — semantic edge classification, then lifecycle (decay/archive/prune), then AI prune. These used to be concurrent detached spawns, but SQLite allows one writer and lifecycle + AI prune both read-modify-write telemetry — so they now run one after another.
8. **Regenerate surface LAST** — after all archival, so the surface never contains memories archived earlier in the same pipeline; the next session starts fresh

Each step logs to a per-process file `/tmp/cortex-<step>.<pid>.log` (extract, backfill, semantic-edges, lifecycle, ai-prune, generate).

---

## What Gets Extracted (The Extraction Prompt)

The LLM receives your full session transcript (or 100KB chunk) along with git context (branch, recent commits, changed files). It's asked to extract memories in 8 categories:

| Type | What it captures | Example |
|---|---|---|
| `architecture` | System design, structure, patterns | "The app uses FC/IS with pure business logic in core/" |
| `decision` | Choices made with rationale | "Chose SQLite over Postgres for single-user embedded use" |
| `pattern` | Reusable code/design patterns | "All API routes follow parse → service → format pattern" |
| `gotcha` | Pitfalls, edge cases, warnings | "vi.mock() at module level leaks between test files" |
| `context` | Background info, explanations | "The SOPS setup uses age keys, not GPG" |
| `progress` | Status updates, completed work | "Completed wave 6, all 729 tests passing" |
| `code_description` | Prose explanation of code | "The ranking formula weights confidence 50%, priority 20%" |
| `code` | Raw source code (paired with descriptions) | Actual code snippets |

Each memory gets:
- **Confidence** (0-1): How clear and actionable is this knowledge?
- **Priority** (1-10): How important is it?
- **Scope**: Project-specific or globally useful?
- **Tags**: Keywords for searchability

---

## How Memories Are Ranked

When generating the surface or returning search results, memories are scored using a composite formula:

```
rank = (confidence × 0.50)
     + (priority/10 × 0.20)
     + (centrality × 0.15)
     + (log(access+1)/maxLog × 0.15)
     + branch_boost (0.1 if same branch)
```

- **Confidence**: LLM's assessment of quality (decays over time)
- **Priority**: LLM's assessment of importance (static)
- **Centrality**: Graph metric — memories connected to many others rank higher
- **Access frequency**: Memories you search for often rank higher (logarithmic to avoid runaway)
- **Branch boost**: Memories from the current git branch get a +0.1 nudge

---

## Surface Generation

The "push surface" is the markdown file Claude reads at session start. It's generated by:

1. Fetch all active memories from both project + global DBs
2. Compute graph centrality for all memories
3. Rank using the formula above
4. Select top memories within **per-category line budgets**:

| Category | Line Budget |
|---|---|
| Architecture | 25 |
| Decision | 25 |
| Pattern | 25 |
| Gotcha | 20 |
| Progress | 30 |
| Context | 15 |
| Code Description | 10 |
| Code | 0 (excluded — too large) |

5. Allow high-value memories to overflow into unused budget from other categories
6. Target ~1500 tokens total, hard max 2000 (including ~200 tokens of markdown overhead)
7. Wrap in `<!-- CORTEX_MEMORY_START -->` / `<!-- CORTEX_MEMORY_END -->` markers
8. Cache the result keyed by `sha256(branch:cwd)`

---

## Memory Graph (Similarity Edges)

When new memories are inserted, they're compared to all existing active memories. The system uses a **two-tier similarity** approach:

### Tier 1: Edge classification (at insertion time)

Hybrid similarity per pair — cosine on local embeddings when both sides have one, Jaccard token overlap otherwise. Classification bands are calibrated PER SIMILARITY SPACE, because raw 384-dim local (BGE) cosine runs "hot": same-domain memories about different aspects routinely score 0.6-0.75, while Jaccard is much better separated:

| Band | Jaccard score | Local cosine score | Action |
|---|---|---|---|
| ignore | < 0.1 | < 0.6 | Skip entirely |
| relate | 0.1 - 0.4 | 0.6 - 0.75 | Create `relates_to` edge (strength = score) |
| suggest | 0.4 - 0.5 | 0.75 - 0.82 | Create `suggested` edge for review |
| consolidate | > 0.5 | ≥ 0.82 | Create strong `relates_to` edge (strength = score) |

Each new memory keeps at most its 3 strongest edges — a structural guard against O(n²) edge explosion in dense projects.

### Tier 2: Cosine Similarity on Embeddings (wired)

`cosineSimilarity()` in `core/similarity.ts` is used throughout: `/recall` and the prompt-recall hook rank results by cosine similarity, and `/consolidate` detects duplicate pairs via hybrid similarity (Jaccard + cosine) with per-space thresholds — 0.5 for Jaccard and Gemini-768 cosine, 0.8 for raw local-BGE cosine.

### Semantic Edge Classification

Jaccard-created `relates_to` edges are upgraded to typed relationships by the `semantic-edges` pipeline, which runs in the SessionEnd worker: it batches edge pairs to the headless LLM CLI (`claude -p --model haiku` by default), which classifies each pair into a typed relation with a strength score.

### Edge Types

`relates_to`, `derived_from`, `contradicts`, `exemplifies`, `refines`, `supersedes`, `source_of`

### Graph Uses

- **Centrality scoring** in surface ranking formula
- **Graph traversal** in `/recall` (depth-2 BFS finds related memories)
- **Consolidation candidates** (high similarity → `/consolidate` can merge them)

---

## Memory Lifecycle (Decay → Archive → Prune)

Memories aren't permanent. After every extraction, the lifecycle runs:

### Decay
Confidence decays over time based on age and access patterns. Highly connected memories (high centrality) decay slower. Pinned memories are exempt.

### Archive
If decayed confidence drops below 0.3 AND the memory hasn't been accessed in 14+ days → status changes to `archived`. Archived memories don't appear in the surface.

### Prune
If a memory has been archived for 30+ days with no access → status changes to `pruned`. Pruned memories are effectively deleted (still in DB but invisible to all queries).

### AI Prune
On top of decay, an AI prune pass has the LLM review active memories in batches and archive stale, redundant, or low-value ones. It runs in the SessionEnd worker when 5+ sessions have passed since the last prune, or when the active count reaches max(50, 1.25 × the count at the last prune) — the growth backoff stops it firing every session.

**Escape hatch**: Accessing a memory (via `/recall`) resets its access timestamp and boosts it back above the threshold.

---

## Semantic Search (Recall)

`/recall <query>` searches using two methods:

### Semantic (default, requires `GEMINI_API_KEY`)
1. Embed the query via Gemini Embedding API (`gemini-embedding-001`)
2. Query is prefixed: `[query] [project:name] <your query>`
3. Memories are prefixed: `[memory_type] [project:name] <summary>`
4. Cosine similarity search against stored embeddings in both DBs (archived and superseded memories are excluded)
5. Results merged (project first), enriched with graph-traversed related memories

### Keyword (fallback, or `--keyword` flag)
- FTS5 full-text search on memory content and summary
- No API key needed
- Less precise but works offline

### Embedding Backfill
Memories are inserted without embeddings (to avoid blocking extraction). A background `backfill` command computes embeddings for all un-embedded memories in batch. This runs periodically or can be triggered manually.

---

## File Layout

```
<project>/
  .memory/
    cortex.db              # Project SQLite database
    surface-cache/         # Cached surface files (branch-keyed)
    locks/                 # PID lock files for concurrent access
    cortex-status.json     # Telemetry (last generation, timing)
  .claude/
    cortex-memory.local.md # The surface file Claude reads

~/.claude/
  memory/
    cortex-global.db       # Global SQLite database
  plugins/
    cortex/
      .claude-plugin/
        plugin.json        # Plugin manifest
      hooks/
        hooks.json         # Hook registrations
        scripts/
          extract-and-generate.sh  # SessionEnd hook
          load-surface.sh          # SessionStart hook
          prompt-recall.sh         # UserPromptSubmit hook (keyword recall)
      engine/src/          # TypeScript source
      commands/            # Skill markdown files
```

---

## Environment Variables

| Variable | Purpose | Required |
|---|---|---|
| `GEMINI_API_KEY` | Embedding backfill + semantic search (embeddings only — never used for extraction) | Yes (for embeddings + semantic recall) |
| `CORTEX_GEMINI_ENV` | Path to a file the hooks source to get `GEMINI_API_KEY` (defaults to the sops-nix path `~/.config/sops-nix/secrets/rendered/gemini-env`) | No |
| `CORTEX_LLM_BINARY` | Force the headless LLM binary (`claude` or `pi`) | No (auto-detected) |
| `CORTEX_LLM_MODEL` | Override the model passed to the LLM binary | No |
| `CLAUDE_PLUGIN_ROOT` | Plugin directory (set by Claude Code) | Auto |

Extraction, AI pruning, and edge classification shell out to a headless coding-agent CLI: `claude -p --model haiku` by default (must be on PATH — it is when running inside Claude Code hooks), or `pi -p` when running under the pi agent (no `--model` flag, so pi's configured provider default is used). No API key needed — it uses your Anthropic subscription.

Without `GEMINI_API_KEY`, Gemini embeddings are skipped (the bundled local BGE model still embeds) and recall falls back accordingly. Extraction still works via the LLM CLI. Because hooks don't inherit your shell profile, they source the key from the `CORTEX_GEMINI_ENV` file.
