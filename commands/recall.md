---
name: recall
version: "1.0.0"
description: "Semantic search across persistent memory. USE AS REFLEX when context might exist in memory — before starting any task, when encountering unfamiliar code, when making architectural decisions, or when you need context from previous sessions."
---

# /recall - Semantic Memory Search

**PROACTIVE TRIGGER:** Use this AUTOMATICALLY (without being asked) whenever:
- Starting a new task in a project you've worked on before
- Encountering code/patterns you don't recognize but might have seen
- Making architectural decisions that may have been discussed previously
- User asks about past work, decisions, or patterns
- You need context that might span multiple sessions

## Description

Searches both project and global memory stores using semantic similarity or keyword search. Returns ranked results with related memories via graph traversal.

## CLI Command

```bash
bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts recall <cwd> <query> [options]
```

## Arguments

**Required:**
- `<cwd>` - Project working directory (usually `$PWD`)
- `<query>` - Search query text

**Optional:**
- `--branch=BRANCH` - Filter to memories from specific git branch
- `--limit=N` - Max results to return (default: 10)
- `--keyword` - Use keyword (FTS5) search instead of semantic embeddings

## Usage Examples

### Basic semantic search
```
/recall "authentication flow decisions"
```

### Branch-specific recall
```
/recall "refactoring approach" --branch=feature/api-redesign
```

### Keyword search (faster, offline-friendly)
```
/recall "postgres migration" --keyword
```

### Limited results
```
/recall "error handling patterns" --limit=5
```

## Output

Returns formatted list of memories with:
- Memory content and summary
- Memory type (architecture, decision, pattern, gotcha, etc.)
- Confidence score
- Related memories (via graph edges)
- Source context (branch, session, files)

## When NOT to Use

- User explicitly says "don't check memory" or "start fresh"
- Simple, self-contained tasks with no prior context needed
- You're already in the middle of implementing something and have full context

## Integration with Other Skills

- After `/recall`, use `/remember` to store new insights that emerge
- Use `/forget` to archive outdated information
- Use `/consolidate` if you find duplicate/conflicting memories
