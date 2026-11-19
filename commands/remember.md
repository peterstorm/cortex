---
name: remember
version: "1.0.0"
description: "Store explicit memory without being asked. PROACTIVELY STORE decisions, architectural patterns, gotchas, and insights as they emerge during conversation — don't wait to be asked."
---

# /remember - Explicit Memory Creation

**PROACTIVE TRIGGER:** Use this AUTOMATICALLY (without being asked) whenever:
- An architectural decision is made (e.g., "we'll use X pattern because Y")
- A gotcha or pitfall is discovered (e.g., "watch out for Z race condition")
- A pattern or best practice is established (e.g., "always validate inputs with Either")
- Important context emerges that should persist across sessions
- User expresses frustration about forgetting something from earlier

## Description

Creates an explicit memory with type, priority, scope, and tags. Bypasses extraction pipeline for immediate storage. Useful for important insights that should be remembered.

## CLI Command

```bash
# Store memory, backfill embeddings, regenerate surface (all in one)
bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts remember <cwd> <content> [options] && \
bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts backfill <cwd> && \
bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts generate <cwd>
```

## Arguments

**Required:**
- `<cwd>` - Project working directory (usually `$PWD`)
- `<content>` - Memory content (quote if contains spaces)

**Optional:**
- `--type=TYPE` - Memory type: architecture, decision, pattern, gotcha, context, progress, code_description (default: context)
- `--priority=N` - Priority 1-10 (default: 5)
- `--scope=SCOPE` - 'project' or 'global' (default: project)
- `--pinned` - Pin memory (prevents decay/archival)
- `--tags=tag1,tag2` - Comma-separated tags
- `--replaces=TAG` - This memory is the new version of whatever is stored under `TAG`. Every other active memory carrying `TAG` in the same database (project or global, following `--scope`) is marked superseded — pinned ones too — with a `supersedes` edge from the new memory. `TAG` is added to this memory's tags, so the next version finds it. If any replaced version was pinned this one is pinned too, at the highest priority among them. The near-duplicate check is skipped (the old version is a near-duplicate by design). `TAG` must be non-empty with no commas or whitespace

A memory that restates a stored one is refused as a near-duplicate. To update a fact on purpose, use `--replaces` rather than rewording until it gets through.

## Usage Examples

### Replace an outdated procedure
```
/remember "Deploy: run release.sh, then tag the commit and push the tag" --type=decision --replaces=deploy-procedure
```
The first memory stored with `--replaces=deploy-procedure` supersedes nothing and carries the tag; each later one supersedes the previous version.

### Store architectural decision
```
/remember "Using functional core / imperative shell pattern for all services" --type=architecture --priority=8
```

### Store gotcha
```
/remember "SQLite WAL mode requires checkpoint before backup" --type=gotcha --priority=9 --pinned
```

### Store pattern with tags
```
/remember "All validation returns Either<Error, T> instead of throwing" --type=pattern --priority=7 --tags=validation,error-handling
```

### Store global knowledge
```
/remember "Embedding vectors are only comparable within one model - never compare across models or across providers" --type=gotcha --scope=global --priority=10 --pinned
```

## Memory Types

- `architecture` - High-level design decisions, system structure
- `decision` - Specific choices made, with rationale
- `pattern` - Reusable approaches, best practices
- `gotcha` - Pitfalls, edge cases, things to avoid
- `context` - Background info, constraints, requirements
- `progress` - Current state, what's done, what's next
- `code_description` - Prose explanation of code structure/purpose

## When to Use Proactively

**DO store immediately when:**
- User says "let's use X approach" → architectural decision
- You discover a bug/edge case → gotcha
- User establishes a coding standard → pattern
- Important context is shared that affects future work → context

**DON'T store:**
- Temporary implementation notes (these decay naturally via extraction)
- Obvious facts already in code
- User explicitly says "just for now" or "temporary"

## Output

Returns memory ID and confirmation that it's stored; with `--replaces`, also `(superseded N: ids)`. Immediately triggers backfill (embeds memory) and regenerates push surface, making memory visible instantly without waiting for session end.

## Integration with Other Skills

- After `/recall`, use `/remember` to fill gaps in existing knowledge
- Use `/forget` to archive if you realize a memory is wrong/outdated
- Use `/consolidate` if similar memories already exist
