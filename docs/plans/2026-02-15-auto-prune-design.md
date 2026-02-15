# Auto-Prune: Background Lifecycle on Session End

## Problem

Stale memories surface because lifecycle/prune only runs on explicit `/prune`. The SessionEnd hook does extract/backfill/generate but never prunes. Memories with decayed confidence stay `active` forever until manual intervention.

## Solution

Detached background lifecycle spawned at session end with smart trigger to avoid redundant runs.

## Mechanism

After extract/backfill/generate completes in `extract-and-generate.sh`, spawn `bun cli.ts lifecycle $CWD --if-needed` as a detached process. Hook returns immediately -- zero added latency.

### Cross-platform detachment

- **Linux**: `setsid` (POSIX, detaches from session process group)
- **macOS**: `nohup` + `disown` (setsid not available by default)

### Smart trigger (`--if-needed`)

Runs lifecycle only when useful. Skips if both conditions hold:
- No new memories since last lifecycle run
- Last run was <2h ago

Runs if either:
- New memories exist (latest `created_at` > `last_lifecycle_at`)
- Fallback interval exceeded (>2h since last run, catches time-based decay)

Timestamp tracked in `.memory/telemetry.json` as `last_lifecycle_at`.

## Files changed

| File | Change |
|------|--------|
| `engine/src/config.ts` | `LIFECYCLE_FALLBACK_HOURS = 2` constant |
| `engine/src/infra/db.ts` | `getLatestMemoryTimestamp()` query |
| `engine/src/commands/lifecycle.ts` | `shouldRunLifecycle()` pure logic, `runLifecycleIfNeeded()` orchestrator |
| `engine/src/cli.ts` | `--if-needed` flag parsing in `handleLifecycle` |
| `hooks/scripts/extract-and-generate.sh` | Detached lifecycle spawn after generate |

## Eventual consistency

Background prune means a brief window where a new session could surface stale memories before the previous session's prune completes. Accepted tradeoff -- next session start loads the freshest cached surface anyway.
