---
name: forget
version: "1.0.0"
description: "Archive outdated or incorrect memories. USE when user says something is wrong, when you discover contradictions, or when memories become obsolete. Proactively clean up memory to maintain accuracy."
---

# /forget - Archive Memories

**PROACTIVE TRIGGER:** Use this AUTOMATICALLY when:
- User corrects you: "that's wrong" or "we changed that"
- You discover contradictory memories during `/recall`
- A memory refers to code/patterns that have been refactored away
- User says "ignore that" or "forget about X"
- Lifecycle archival leaves memories you know are obsolete

## Description

Archives a memory by ID or fuzzy query. Archived memories don't appear in search results or push surfaces, but aren't deleted (can be restored if needed).

## CLI Command

```bash
bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts forget <cwd> <idOrQuery>
```

## Arguments

**Required:**
- `<cwd>` - Project working directory
- `<idOrQuery>` - Memory ID (exact match) or text query (fuzzy search)

## Usage Examples

### Forget by ID (exact)
```
/forget memory-abc123
```

### Forget by query (finds first match)
```
/forget "old authentication approach"
```

### Archive incorrect decision
```
/forget "using redis for session storage"
```

## How It Works

1. Tries exact ID match in project DB
2. If not found, tries global DB
3. If still not found, does fuzzy text search in project DB
4. If not found, tries fuzzy search in global DB
5. Archives first match found

## Archival vs. Deletion

- **Archived:** Status set to 'archived', hidden from search/surface
- **NOT deleted:** Can be restored if needed (future feature)
- **Edges preserved:** Relationship graph remains intact
- **Pruning:** Lifecycle may prune very old archived memories (30+ days)

## When to Use Proactively

**DO archive immediately when:**
- User corrects a wrong memory: "no, we decided against that"
- You find contradictions in `/recall` results
- A memory references deleted/refactored code
- User expresses frustration about outdated context

**DON'T archive:**
- Low-confidence memories (lifecycle handles this automatically)
- Memories that are still relevant but not currently needed
- When unsure — ask user first

## Output

Returns confirmation with memory ID that was archived, or "Memory not found" if no match.

## Integration with Other Skills

- After `/recall` shows outdated info, use `/forget` to clean it up
- Use `/consolidate` to merge duplicates before forgetting
- Check `/inspect` to see archival stats
- Lifecycle command runs automatic archival based on decay
