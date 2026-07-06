---
name: consolidate
version: "1.0.0"
description: "Find and merge duplicate memories. RUN periodically (every 10-20 extractions or when memory store feels cluttered) to keep knowledge clean and reduce noise."
---

# /consolidate - Merge Duplicate Memories

**PROACTIVE TRIGGER:** Run this AUTOMATICALLY when:
- Memory store has grown large (80+ active memories)
- After 10+ extraction sessions
- `/recall` returns obviously duplicate results
- User expresses confusion about conflicting information
- Before major refactoring (to ensure clean slate)

## Description

Detects similar memory pairs using hybrid similarity (Jaccard token overlap + embedding cosine) and prints each pair in full for review. You then merge approved pairs one at a time with the `--merge` flag — the merged memory supersedes both originals.

## CLI Commands

**List similar pairs:**

```bash
bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts consolidate <cwd> [--threshold=N]
```

**Merge one reviewed pair:**

```bash
bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts consolidate <cwd> --merge \
  --a=<idA> --b=<idB> \
  --summary="<merged summary>" --content="<merged content>"
```

## Arguments

**Required:**
- `<cwd>` - Project working directory (consolidate operates on the project DB only)

**Optional (list mode):**
- `--threshold=N` - Uniform similarity threshold in (0, 1]. Default is per similarity space: 0.5 for Jaccard/Gemini-cosine pairs, 0.8 for raw local-embedding cosine (which scores same-domain pairs 0.6-0.75 even when they are not duplicates)

**Required (merge mode):**
- `--merge` - Switch to merge mode
- `--a=<idA>`, `--b=<idB>` - IDs of the pair to merge
- `--summary=<text>` - Summary for the merged memory
- `--content=<text>` - Content for the merged memory

## Workflow

1. **List pairs:** Run list mode. Each similar pair is printed with IDs, similarity %, type, priority, summary, and full content.

2. **Review each pair** with the user:
   - Truly duplicate → write a merged summary + content that preserves the best of both
   - Related but distinct → skip (keep both)
   - One is outdated → use `/forget` on the stale one instead of merging

3. **Merge each approved pair** with a `--merge` call. This creates the new merged memory (embeddings start null so backfill re-embeds the new text), marks both originals as `superseded` with `supersedes` edges, and prints the new memory ID.

4. **Refresh embeddings + surface** after all merges:
   ```bash
   bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts backfill <cwd>
   bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts generate <cwd>
   ```

## How Detection Works

1. **Embedding similarity:** Cosine similarity on stored embeddings when both sides have the same type (Gemini-Gemini or local-local)
2. **Jaccard fallback:** Token-overlap similarity when embeddings are unavailable or mismatched
3. **Per-space threshold:** Pairs scoring above their space's threshold (0.5 Jaccard/Gemini, 0.8 local cosine) are reported

Rough interpretation of local-cosine scores (the common case):
- 0.6-0.75: Same domain, usually different aspects — routinely NOT duplicates
- 0.8-0.85: Very similar, likely duplicates
- \>0.85: Near-identical, almost always merge

## Merge Semantics

- Merged memory: confidence 1.0 (human-approved), higher priority of the two, combined tags, pinned if either was pinned, global scope if either was global
- Originals: status set to `superseded` (hidden from search/surface), linked via `supersedes` edges
- Embeddings: nulled on the merged memory — `backfill` re-embeds the new content

## When to Run

**Good times to consolidate:**
- Weekly maintenance (if active project)
- After completing a major feature
- Before starting new work phase
- When `/recall` feels noisy/duplicative

**Don't consolidate:**
- In the middle of active work
- When very few memories exist (<20 active)
- Right after extraction (let memories settle)

## Safety

- **List mode is read-only** — nothing changes until you call `--merge`
- **Merge is human-approved** — you write the merged summary/content per pair
- **Originals aren't deleted** — superseded memories stay in the DB

## Integration with Other Skills

- Run `/consolidate` before `/recall` if memory feels cluttered
- Use `/forget` to archive one-sided duplicates instead of merging
- Check `/inspect` for memory count trends
- Lifecycle decay reduces duplicates naturally over time
