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

## Output Sections

### Memory Counts
- **Active:** Memories in search/surface rotation
- **Archived:** Memories hidden from search (via `/forget` or lifecycle)
- **Pruned:** Deleted memories (lifecycle cleanup)
- **Total:** Sum of all statuses

Breakdown by:
- Scope (project vs. global)
- Type (architecture, decision, pattern, gotcha, etc.)
- Pinned (decay-immune memories)

### Embedding Status
- **With voyage embeddings:** Memories embedded by Voyage AI
- **With local embeddings:** Memories with fallback embeddings
- **Pending queue:** Memories awaiting embedding
- **No embeddings:** Memories skipped (code type, or embedding failed)

### Extraction Stats
- **Extraction count:** Total extraction sessions
- **Last extraction:** Timestamp of most recent extraction
- **Cursor position:** Progress through last transcript
- **Avg memories per extraction:** Trend over time

### Graph Metrics
- **Total edges:** Count of memory relationships
- **Edge types:** Breakdown (relates_to, derived_from, contradicts, etc.)
- **Suggested edges:** Auto-detected but unconfirmed
- **Avg centrality:** Mean in-degree across memories

### Surface Cache
- **Cached branches:** List of branches with cached surfaces
- **Cache age:** Time since last generation
- **Staleness warnings:** Caches >24h old

### Lifecycle Health
- **Last lifecycle run:** When decay/archival last executed
- **Archived this run:** Count from last lifecycle
- **Pruned this run:** Count from last lifecycle
- **Avg confidence:** Mean confidence score (indicates decay health)

## Interpreting Results

### Healthy System
- Active memories: 20-80 (not too sparse, not too cluttered)
- Pending embeddings: <10 (queue processing keeps up)
- Avg confidence: >0.6 (memories are fresh and useful)
- Cache age: <24h (surfaces stay current)

### Warning Signs
- Active memories: >100 (run `/consolidate` to merge duplicates)
- Pending embeddings: >50 (run `/backfill` to process queue)
- Avg confidence: <0.4 (memories decaying, may need archival)
- No edges: Graph isn't forming (extraction may be failing)

### Critical Issues
- Active memories: 0 (extraction pipeline broken)
- All memories: 0 (database corrupted or wrong path)
- Avg confidence: 0 (lifecycle misconfigured)

## When to Use

**Diagnostic scenarios:**
- `/recall` returns nothing → check active memory count
- Push surface empty → check cache age, memory counts
- Slow searches → check pending embedding queue
- Duplicate results → check consolidation metrics

**Verification scenarios:**
- After `/consolidate` → verify similar pairs reduced
- After `/forget` → verify archived count increased
- After extraction → verify extraction count incremented
- After backfill → verify pending queue cleared

## Output Format

Human-readable formatted text with sections, counts, and timestamps. Also writes detailed JSON to telemetry log file for programmatic analysis.

## Integration with Other Skills

- Before `/recall`, check active count to estimate result quality
- After `/consolidate`, verify duplicate reduction
- Before `/remember`, check if memory already exists
- After lifecycle, verify archival/prune counts are reasonable
