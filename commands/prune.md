---
name: prune
version: "1.0.0"
description: "AI-powered memory pruning. Reviews all active memories and archives stale, redundant, or low-value ones. Use periodically to keep memory lean and high-signal."
---

# /prune - AI-Powered Memory Pruning

**PROACTIVE TRIGGER:** Use this when:
- Memory count exceeds 50 active memories
- Surface is frequently truncated
- After major project changes that invalidate old context
- User says "clean up memory" or "memory is noisy"

## Description

You (Claude) act as the pruner. Fetch all active memories, evaluate each for relevance, and archive the ones that are stale, redundant, or too granular. No Gemini involved — this uses your judgment.

## Procedure

### Step 1: Fetch all active memories

Run this to get every active memory (project + global):

```bash
bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts inspect <cwd>
```

Then query the databases directly for full detail:

```bash
bun -e "
import Database from 'bun:sqlite';
const db = new Database('<cwd>/.memory/cortex.db', { readonly: true });
const rows = db.query(\"SELECT id, memory_type, summary, confidence, access_count, pinned, created_at FROM memories WHERE status = 'active' ORDER BY memory_type, created_at\").all();
for (const r of rows) {
  console.log(r.memory_type + ' | ' + r.id.slice(0,8) + ' | conf=' + r.confidence + ' acc=' + r.access_count + (r.pinned ? ' PIN' : '') + ' | ' + r.summary.slice(0,140));
}
console.log('Total:', rows.length);
db.close();
"
```

Also check the global DB at `~/.claude/memory/cortex-global.db` with the same query.

### Step 2: Evaluate each memory

For each memory, decide: **keep** or **archive**. Apply these criteria:

**ARCHIVE if:**
- **Redundant**: Another active memory covers the same information
- **Stale**: Refers to resolved issues, old session context, or completed tasks
- **Too granular**: Implementation details better found by reading code (e.g. "the Edge object has fields X, Y, Z")
- **One-time observation**: Session-specific context that won't help future sessions (e.g. "user started task X", "git status shows Y")
- **Generic tip**: Not project-specific, just general best practices the LLM already knows
- **Superseded**: A newer memory covers this with updated information

**KEEP if:**
- **Actionable**: Describes a pattern, gotcha, or decision that affects future work
- **Structural**: Describes where things live or how systems connect (but only one per concept)
- **Pinned**: Never archive pinned memories
- **High access**: Frequently accessed memories are clearly useful
- **Unique**: No other memory covers this information

### Step 3: Present the archive list

Show the user a table of memories to archive with reasons:

| ID | Type | Reason | Summary (truncated) |
|----|------|--------|---------------------|

Wait for user confirmation before proceeding.

### Step 4: Archive in batch

After user confirms, archive efficiently via direct DB update:

```bash
bun -e "
import Database from 'bun:sqlite';
const db = new Database('<cwd>/.memory/cortex.db');
const ids = [/* list of full UUIDs */];
const placeholders = ids.map(() => '?').join(',');
db.prepare('UPDATE memories SET status = ?, updated_at = ? WHERE id IN (' + placeholders + ')').run('archived', new Date().toISOString(), ...ids);
console.log('Archived', ids.length, 'memories');
const remaining = db.query(\"SELECT COUNT(*) as c FROM memories WHERE status = 'active'\").get();
console.log('Active remaining:', remaining.c);
db.close();
"
```

### Step 5: Regenerate surface

```bash
bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts generate <cwd>
```

## Guidelines

- **Be aggressive**: Better to archive too much than too little. Archived memories aren't deleted and can be restored.
- **One per concept**: If 3 memories describe database locations, keep the most comprehensive one.
- **Favor summaries over details**: Keep "Cortex uses project + global SQLite DBs" over separate memories for each DB path.
- **Progress/context decay fast**: These are usually session-specific and stale quickly.
- **Architecture is stable but bloats**: Merge conceptually similar architecture memories by keeping the best one.

## Output

Report: how many reviewed, how many archived, how many remaining. Show before/after memory type distribution.
