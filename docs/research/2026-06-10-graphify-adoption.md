# Graphify research: what cortex should adopt

**Date:** 2026-06-10
**Source:** https://github.com/safishamsi/graphify (Python, MIT, ~64k stars, YC S26)

## TL;DR

Graphify and cortex solve different problems — graphify maps a **codebase/corpus**
into a knowledge graph the agent queries instead of grepping files; cortex stores
**conversation memories**. The core product isn't transferable, but several of its
retrieval and graph mechanics map cleanly onto cortex's recall pipeline. Best
adoptions, ranked: BM25/IDF-tiered lexical ranking, hub-damped graph traversal,
vocab-constrained query expansion, budget-capped recall output with truncation
hints, and — the big one — community clustering with hierarchical summaries.

## What graphify is

A skill + Python library for ~20 coding agents (Claude Code, Codex, Cursor, …).
`/graphify .` builds a persistent NetworkX graph from:

- **Code** — tree-sitter AST extraction, 28 languages, fully local, zero LLM cost.
  Classes, functions, imports, call graphs, plus "rationale" nodes mined from
  `# NOTE:/# WHY:/# HACK:` comments and docstrings.
- **Docs/PDFs/images** — the *host agent* dispatches parallel subagents as the
  extraction LLM (no API key needed); results cached per file by SHA256.
- **Video/audio** — local faster-whisper, transcription prompt seeded with the
  corpus's top god nodes to bias domain vocabulary.

It is "GraphRAG without embeddings" — no vector store anywhere. Nodes carry
`{id, label, file_type, source_file, source_location}`; edges carry a relation
(`calls`, `imports`, `semantically_similar_to`, …), a provenance tier
(EXTRACTED = 1.0, INFERRED = 0.95/0.85/0.75/0.65/0.55, AMBIGUOUS = human review),
and an optional `context` (call/import/field/return_type) used for filtering.
Leiden/Louvain clustering assigns communities. Storage is a flat
`graphify-out/graph.json`, meant to be committed, with a git union-merge driver
so parallel commits never conflict.

Integration surface: per-platform skills, PreToolUse hooks that fire on
`grep|rg|find|Read|Glob` and nudge the agent toward `graphify query` instead
(never blocking, fails open), a CLAUDE.md always-on block, an MCP server
(stdio or Streamable HTTP), and git post-commit hooks that do detached AST-only
rebuilds.

## The token-reduction claim, honestly assessed

Headline: **"71.5x fewer tokens per query vs reading the raw files"** (52-file
mixed corpus). Their own table discloses 5.4x on a 4-file corpus and ~1x on 6
files ("six files already fits in a context window").

Methodology caveat (`benchmark.py`): corpus tokens are estimated
(`words * 100 // 75`, or `nodes * 50` words when unavailable); query tokens are
`len(text) // 4` of the served subgraph. So 71.5x compares a budget-capped
subgraph render against an *estimated full-corpus read on every question* —
real agents grep/read selectively, so the realistic multiplier is much lower.
They also acknowledge the one-time LLM build cost (tracked in `cost.json`).

The real levers, in order:

1. **Pull-based, budget-capped subgraph serving.** `graphify query` matches seed
   nodes lexically, BFS/DFS-expands to depth 3, and renders a compact node/edge
   text serialization under a hard ~2000-token budget, with explicit truncation
   notices: `(truncated — N more nodes cut. Narrow with context_filter=['call'])`.
   The agent gets structure, not file bodies.
2. **Zero-LLM extraction for code** — all AST, local; LLM only for docs/images,
   only at build time, cached by content hash so it never repeats.
3. **Behavioral steering** — hooks and rules push the agent to query the graph
   *before* spending tokens on raw reads.

Cortex already has analogs for (2): checkpointed extraction, surface caching,
code never embedded. The gap is in (1) — cortex is push-heavy (static surface
every session) with a thinner pull path.

## How graphify's retrieval works (the parts worth copying)

- **Lexical scoring with IDF weighting** so rare identifiers dominate common
  words, plus tiered bonuses: exact ×1000, prefix ×100, substring ×1, whole-query
  exact/prefix tier ×10, source-file match ×0.5.
- **Seed selection with a score gap:** top-3 scored nodes, but seeds scoring
  <20% of the top are dropped — noise terms can't steal seed slots.
- **Hub damping:** nodes above p99 degree (floor 50) are never expanded as
  transit nodes unless they are seeds — prevents god-node blowup during BFS.
- **Context filters inferred from question intent:** "what calls X" → filter to
  `call` edges.
- **Vocab-constrained query expansion (their best trick):** the skill dumps the
  graph's actual label-token vocabulary to a file, then the LLM picks ≤12
  expansion terms *only from that list* (cross-language too: Russian
  "аутентификация" → `auth` iff `auth` exists in the vocab), prints the
  expansion for auditability, and refuses to traverse on zero vocab matches.
  The LLM is the semantic layer; the engine stays lexical and deterministic.
- **Feedback loop:** answered queries are saved back as graph nodes
  (`graphify save-result`), so the graph self-improves.

## Recommendations for cortex

### 1. IDF/BM25-tiered ranking in keyword recall — cheap, high value

Cortex's keyword tier (`engine/src/commands/prompt-recall.ts`) does
AND-first/OR-fallback FTS5 matching but no relevance ranking within results.
SQLite FTS5 ships `bm25()` — order the keyword tier by BM25 with an exact-match
bonus. Directly improves which 3–5 memories get injected per prompt, nearly free.

### 2. Hub damping + seed score-gap in graph enrichment — cheap

Recall does depth-2 BFS over edges (`engine/src/core/graph.ts`,
`engine/src/commands/recall.ts`). As the graph grows, a high-centrality memory
will drag in everything it touches. Adopt: don't expand nodes above p99 degree
unless they're seeds; drop enrichment seeds scoring below 20% of the top hit.
Prevents the noise blowup that's otherwise coming as the edge table grows.

### 3. Vocab-constrained query expansion in the /recall skill — clever, free

Cortex has the perfect substrate: distinct `tags` plus entity names. Add a step
to the recall skill (engine support: a `vocab` subcommand that dumps distinct
tags/entity names): expand the user's query only with terms that actually exist
in the store, then search. Bridges the lexical gap on the keyword path without
a Gemini call — helps exactly when the semantic tier is unavailable. Keep the
expansion in the engine-adjacent skill as a thin step; print the expansion for
auditability like graphify does.

### 4. Budget-capped recall output with truncation hints

When cortex recall truncates or limits, signal it and suggest how to narrow:
`(12 more matches cut — narrow with --type=gotcha or a tag filter)`.
Self-describing truncation turns a silent quality loss into a follow-up query.

### 5. Community clustering + hierarchical summaries — biggest token win, biggest lift

Graphify runs Leiden/Louvain over the graph and serves community-scoped context.
Cortex version: cluster memories via the edge graph (Louvain over `edges` is
enough at cortex scale), generate one summary memory per community, and have the
static surface show community summaries instead of N individual lines — recall
drills into members on demand. This is how the surface stays flat (~1500 tokens)
as the store grows to thousands of memories. Needs a design doc
(docs/plans/) rather than a quick patch: clustering cadence, summary
regeneration triggers, how pinned/high-priority memories bypass summarization.

### 6. Sanitize memory content before hook injection — security, do regardless

Graphify runs `sanitize_label` on every LLM-derived field served via MCP to
block prompt injection and ANSI escapes originating from corpus documents.
Cortex injects extracted memory content straight into SessionStart /
UserPromptSubmit context — and that content comes from transcripts, which can
contain adversarial text (pasted issues, web content). Strip ANSI escapes and
neutralize injection-shaped content at surface-render time
(`engine/src/core/surface.ts`) and in prompt-recall output.

### 7. Query-intent → relation/type filtering — nice-to-have

Graphify infers edge filters from question words. Cortex analog in
prompt-recall: "why did we…" → boost `decision`/`derived_from`;
"watch out / broken / fails" → boost `gotcha`/`contradicts`. Small heuristic.

## Explicitly not adopting

- **Tree-sitter code extraction** — different domain. Cortex's deliberate
  prose-paired `/index-code` design (code never embedded, found via `source_of`
  edges) is the right call for a memory system.
- **MinHash-LSH dedup** — graphify needs it for thousands of nodes per build;
  cortex's Jaccard + cosine hybrid is fine at current scale.
- **Committed graph + git union-merge driver** — interesting future direction
  for team-shared memory, but a structural change (cortex's SQLite is
  gitignored by design). Filed away, not built.
- **PreToolUse steering hooks** — graphify needs them to redirect file reads;
  cortex's injection points (SessionStart/UserPromptSubmit) are already the
  right surface.

## A caution from their weaknesses

Graphify's 615-line skill is littered with ALL-CAPS guardrails because they made
the LLM execute a long natural-language program, and agent behavior drifts.
Cortex's architecture — deterministic TypeScript engine, hooks, thin skills —
is the better division of labor. Keep new features (like vocab expansion)
mostly in the engine, with the skill as a thin trigger.

## Key graphify files (for future reference)

- `graphify/serve.py` — retrieval, token budget, MCP server
- `graphify/extract.py` — tree-sitter extraction (~11.7k lines)
- `graphify/cluster.py` — Leiden/Louvain communities
- `graphify/dedup.py` — MinHash + Jaro-Winkler entity merge
- `graphify/benchmark.py` — the 71.5x methodology
- `skills/claude/references/query.md` — vocab-constrained query expansion
- `docs/how-it-works.md`, `ARCHITECTURE.md`
