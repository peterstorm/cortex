# Auto-Prune: Background Lifecycle + AI Pruning on Session End

## Problem

Stale memories surface because lifecycle/prune only runs on explicit `/prune`. The SessionEnd hook does extract/backfill/generate but never prunes. Memories with decayed confidence stay `active` forever until manual intervention. Algorithmic pruning catches old/unused memories but can't detect semantically wrong or redundant content.

## Solution

Two-layer auto-pruning on session end, both fully detached and async:

1. **Algorithmic lifecycle** — decay, archive, prune based on time/access/centrality
2. **AI prune** — `claude -p` (headless) evaluates memory content for staleness, redundancy, granularity

## Layer 1: Algorithmic Lifecycle

After extract/backfill/generate in `extract-and-generate.sh`, spawn `bun cli.ts lifecycle $CWD --if-needed` detached.

### Smart trigger

Skips if both:
- No new memories since last run
- Last run <2h ago

Runs if either:
- New memories exist (`created_at` > `last_lifecycle_at`)
- Fallback interval exceeded (>2h, catches time-based decay)

## Layer 2: AI Prune

After lifecycle, spawn `bun cli.ts ai-prune $CWD --if-needed` detached.

### Smart trigger

Runs if EITHER fires first:
- `sessions_since_ai_prune >= 5`
- Active memory count >= 50

Session counter increments every session end, resets after successful prune.

### Mechanism

1. Fetch all active memory summaries from project + global DBs
2. Build structured prompt with pruning criteria (redundant, stale, too granular, one-time, generic, superseded)
3. Call `claude -p --model haiku` with `CORTEX_EXTRACTING=1` guard (prevents hook storms)
4. Parse JSON response: `[{"id": "...", "reason": "..."}]`
5. Batch archive flagged memories (never pinned — hardcoded safety check)
6. Reset session counter in telemetry

### Cross-platform detachment

- **Linux**: `setsid` (POSIX)
- **macOS**: `nohup` + `disown`

## Hook flow

```
extract → backfill → generate → detach lifecycle --if-needed → detach ai-prune --if-needed
```

## Files changed

| File | Change |
|------|--------|
| `engine/src/config.ts` | `LIFECYCLE_FALLBACK_HOURS`, `AI_PRUNE_SESSION_INTERVAL`, `AI_PRUNE_MEMORY_THRESHOLD`, `AI_PRUNE_TIMEOUT_MS` |
| `engine/src/infra/db.ts` | `getLatestMemoryTimestamp()` |
| `engine/src/commands/lifecycle.ts` | `shouldRunLifecycle()`, `runLifecycleIfNeeded()` |
| `engine/src/commands/ai-prune.ts` | **New.** `shouldRunAiPrune()`, `buildPrunePrompt()`, `parsePruneResponse()`, `runAiPrune()`, `runAiPruneIfNeeded()` |
| `engine/src/cli.ts` | `ai-prune` subcommand + `--if-needed` flag |
| `hooks/scripts/extract-and-generate.sh` | Detached lifecycle + ai-prune spawns |
| `.memory/telemetry.json` | `last_lifecycle_at`, `sessions_since_ai_prune`, `last_ai_prune_at` |

## Eventual consistency

Background prune means a brief window where a new session could surface stale memories. Accepted — next session start loads freshest cached surface.
