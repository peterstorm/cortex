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

Creates a prose-code memory pair: embeds the prose description for semantic search, stores raw code separately, links via `source_of` edge. Enables finding code via natural language queries.

## CLI Command

```bash
bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts index-code <cwd> <proseId> <codePath>
```

## Arguments

**Required:**
- `<cwd>` - Project working directory
- `<proseId>` - Memory ID of prose description (from `/remember` or existing memory)
- `<codePath>` - File path to code file

## Usage Flow

1. First, create prose description:
   ```
   /remember "Pure ranking function computing composite score from confidence, priority, centrality, and access" --type=code_description
   ```
   Returns: `memory-abc123`

2. Then, index the code:
   ```
   /index-code memory-abc123 ./engine/src/core/ranking.ts
   ```

## What Gets Stored

- **Prose memory:** Embedded for semantic search, appears in push surface
- **Code memory:** Raw code content, NOT embedded (security + cost)
- **Edge:** `source_of` relation linking prose → code
- **Retrieval:** `/recall` returns prose, prose's edges surface the code

## Use Cases

### Index key functions
```
/remember "Decay confidence using exponential half-life formula, with pinned/centrality modifiers" --type=code_description
/index-code {memoryId} ./engine/src/core/decay.ts
```

### Index architectural patterns
```
/remember "Functional core: pure similarity classification returning discriminated union action" --type=architecture
/index-code {memoryId} ./engine/src/core/similarity.ts
```

### Index domain types
```
/remember "Memory type as discriminated union with 8 variants, immutable fields" --type=pattern
/index-code {memoryId} ./engine/src/core/types.ts
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

Returns code memory ID and confirms prose-code link. Code becomes discoverable via `/recall` on prose description.

## Integration with Other Skills

- Use `/recall` to find prose descriptions of code
- Use `/traverse` to explore code relationships via edges
- Use `/forget` to archive if code is refactored away
