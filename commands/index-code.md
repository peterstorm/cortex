---
name: index-code
version: "1.0.0"
description: "Index important code blocks with prose descriptions. USE when user shares critical code worth remembering — creates prose-code pairing for semantic search and context retrieval."
---

# /index-code - Code Block Indexing

**PROACTIVE TRIGGER:** Use this AUTOMATICALLY when:
- User shares a code snippet and explains its purpose/importance
- You write code that implements a key pattern/architecture decision
- A complex code block needs to be findable via semantic search later
- User says "this is important" or "remember this code"

## Description

Creates a prose-code memory pair in ONE command: embeds the prose summary for semantic search, stores raw code separately (never embedded), and links them via a `source_of` edge. Enables finding code via natural language queries.

## CLI Command

```bash
bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts index-code <cwd> <filePath> <summary> [--start=N] [--end=N] [--scope=project|global] [--tags=tag1,tag2] [--session=ID]
```

## Arguments

**Required:**
- `<cwd>` - Project working directory (absolute path)
- `<filePath>` - Path to the code file to index
- `<summary>` - Prose description of the code (this is what gets embedded and searched)

**Optional flags:**
- `--start=N` - First line of the code block (1-based, inclusive)
- `--end=N` - Last line of the code block (1-based, inclusive; must be >= start)
- `--scope=project|global` - Memory scope (default: `project`)
- `--tags=tag1,tag2` - Comma-separated tags applied to both memories
- `--session=ID` - Session ID recorded on the memories (default: `manual-index`)

## Usage

Single command — no separate `/remember` step needed:

```bash
bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts index-code /path/to/project ./engine/src/core/ranking.ts "Pure ranking function computing composite score from confidence, priority, centrality, and access" --start=40 --end=95 --tags=ranking,core
```

## What Gets Stored

- **Prose memory** (`code_description`): the summary, embedded for semantic search, appears in push surface
- **Code memory** (`code`): raw code content (whole file, or the `--start`/`--end` line range), NOT embedded (security + cost)
- **Edge:** `source_of` relation linking prose → code
- **Re-indexing:** existing code/prose memories for the same file path are superseded automatically
- **Retrieval:** `/recall` returns prose; the prose memory's edges surface the code

## Use Cases

### Index key functions
```bash
... index-code <cwd> ./engine/src/core/decay.ts "Decay confidence using exponential half-life formula, with pinned/centrality modifiers"
```

### Index a specific block with tags
```bash
... index-code <cwd> ./engine/src/core/similarity.ts "Pure similarity classification returning discriminated union action" --start=96 --end=118 --tags=similarity,architecture
```

### Index globally-relevant patterns
```bash
... index-code <cwd> ./engine/src/core/types.ts "Memory type as discriminated union with 8 variants, immutable fields" --scope=global
```

## Why Not Embed Code Directly?

- **Security:** Raw code may contain secrets, never sent to embedding API (FR-053, NFR-018)
- **Cost:** Code tokens are expensive, prose summaries are cheap
- **Relevance:** Semantic search on prose descriptions is more accurate than raw code

## When NOT to Use

- Trivial utility functions (getters, simple transforms)
- Auto-generated code (migrations, boilerplate)
- Code that's temporary or will change soon
- User explicitly says "just implementing this quickly"

## Output

Returns the code memory ID and confirms the prose-code link (plus how many old versions were superseded). Code becomes discoverable via `/recall` on the prose description.

## Integration with Other Skills

- Use `/recall` to find prose descriptions of code
- Use the traverse CLI to explore code relationships via edges: `bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts traverse <cwd> <memoryId> [maxDepth]`
- Use `/forget` to archive if code is refactored away
