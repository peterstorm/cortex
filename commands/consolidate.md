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

Detects similar memory pairs using embedding cosine similarity and Jaccard pre-filtering. Reports candidates for consolidation. Currently detection-only (manual merge in v1, auto-merge in future).

## CLI Command

```bash
bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts consolidate <cwd>
```

## Arguments

**Required:**
- `<cwd>` - Project working directory

**Optional:**
- None (operates on all active memories in project DB)

## Usage Example

```
/consolidate
```

Returns: `Found 3 similar pairs`

## How It Works

1. **Jaccard pre-filter:** Tokenizes memory content, computes Jaccard similarity
   - Score >0.6 = definitely similar
   - Score <0.1 = definitely different
   - Score 0.1-0.6 = maybe (proceed to embedding check)

2. **Embedding similarity:** Computes cosine similarity on embeddings
   - Score >0.5 = consolidation candidate

3. **Classification:**
   - 0.5-0.7: Similar, should review for merge
   - 0.7-0.9: Very similar, likely duplicates
   - >0.9: Near-identical, definitely merge

4. **Output:** List of memory pairs with similarity scores

## Consolidation Strategy (Manual v1)

When consolidation reports similar pairs:

1. **Review both memories** to understand differences
2. **Choose merge approach:**
   - Keep higher-priority memory, archive the other
   - Create new combined memory with `/remember`, archive both originals
   - Keep both if subtle differences matter

3. **Archive duplicates** with `/forget`

## Future: Auto-Merge (v2)

Planned features:
- Automatic merge when >0.9 similarity
- Interactive prompt for 0.5-0.9 range
- Merge preview with combined content
- Rollback via checkpoint/restore

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

- **Read-only in v1:** Only reports duplicates, doesn't modify
- **Checkpoint:** Future merge will checkpoint DB before changes
- **Rollback:** Can restore from checkpoint if merge goes wrong

## Output

Returns count of similar pairs found. Detailed pair list written to telemetry logs.

## Integration with Other Skills

- Run `/consolidate` before `/recall` if memory feels cluttered
- Use `/forget` to manually archive duplicates after review
- Check `/inspect` for memory count trends
- Lifecycle decay reduces duplicates naturally over time
