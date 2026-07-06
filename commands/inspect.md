---
name: inspect
version: "1.0.0"
description: "Display memory health, queue status, and diagnostic info. USE to understand system state, debug issues, or verify operations completed successfully."
---

# /inspect - Memory System Diagnostics

**PROACTIVE TRIGGER:** Use this when:
- User asks "how's memory doing?" or "what's stored?"
- Debugging why `/recall` isn't finding expected results
- After major operations (consolidate, lifecycle, backfill) to verify success
- Memory behavior seems off (stale surfaces, missing context)
- User expresses frustration about memory quality

## Description

Displays telemetry, memory counts, embedding queue status, and system health metrics for both project and global databases.

## CLI Command

```bash
bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts inspect <cwd>
```

## Arguments

**Required:**
- `<cwd>` - Project working directory

**Optional:**
- None

## Usage Example

```
/inspect
```

## Output

JSON printed to stdout with these fields (combined across project + global DBs):

### `memory_counts`
- **total:** Number of *active* memories across both databases
- **by_type:** Active count per memory type (architecture, decision, pattern, gotcha, context, progress, code_description, code)
- **by_scope:** Active count per scope (project vs. global)

### `edge_count`
Total number of edges across both databases.

### `embedding_queue_size`
Active memories with no embedding yet (neither Gemini nor local) — the backfill queue.

### `cache_staleness`
- **exists:** Whether the surface cache directory exists
- **age_hours:** Age of the most recent cache file (>24h means the surface will regenerate at next session start)

### `last_extraction` (if present)
Status (`success`/`failure`), timestamp, and error message of the last recorded extraction, read from `.memory/telemetry.json`.

## Interpreting Results

### Healthy System
- Active memories: 20-80 (not too sparse, not too cluttered)
- Embedding queue: <10 (backfill keeps up)
- Cache age: <24h (surfaces stay current)
- Edge count growing over time (graph is forming)

### Warning Signs
- Active memories: >100 (run `/consolidate` or `/prune`)
- Embedding queue: >50 (run `backfill` to process queue)
- Edge count 0 with many memories (extraction/edge creation may be failing)

### Critical Issues
- Active memories: 0 (extraction pipeline broken)
- Cache doesn't exist after sessions ended (generate step failing — check `/tmp/cortex-generate.log`)

## When to Use

**Diagnostic scenarios:**
- `/recall` returns nothing → check active memory count
- Push surface empty → check cache age, memory counts
- Slow searches → check embedding queue size
- Duplicate results → check total count, then run `/consolidate`

**Verification scenarios:**
- After `/consolidate` → verify active count dropped (merged pairs superseded)
- After extraction → verify counts grew / `last_extraction` updated
- After backfill → verify embedding queue cleared

## Integration with Other Skills

- Before `/recall`, check active count to estimate result quality
- After `/consolidate`, verify duplicate reduction
- Before `/remember`, check if memory already exists
- After lifecycle, verify counts moved in the expected direction
