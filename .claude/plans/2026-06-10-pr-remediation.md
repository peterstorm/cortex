# PR Remediation Plan

**Date:** 2026-06-10
**Branch:** research/graphify-adoption
**Findings:** 1 critical, 8 advisory (deduplicated across code-reviewer, silent-failure-hunter, pr-test-analyzer)

## Critical Fixes

### Fix 1: Migrate legacy `.pi/cortex-memory.local.md` surface
- **Source:** silent-failure-hunter
- **File:** pi/extension.ts:70-107
- **Issue:** Existing pi projects have their surface at `.pi/cortex-memory.local.md`. After unification, the only reader checks `.claude/` — finds nothing, injects no memory, leaves a permanently stale orphan. Zero logging.
- **Fix:** Add `migrateLegacySurface(cwd)` — rename legacy file to new path if absent, else unlink; log either way to stderr. Call from `before_agent_start` (before read) and `session_start`.

## Advisory Fixes

### Fix 2: Remove dead `.pi/cortex-memory.local.md` from GITIGNORE_PATTERNS
- **Source:** code-reviewer, silent-failure-hunter, pr-test-analyzer
- **File:** engine/src/config.ts:295
- **Issue:** Nothing writes there anymore; pattern also hides the orphan from `git status`. Migration (Fix 1) removes the file, so the pattern is dead.
- **Fix:** Delete the entry; update GITIGNORE_PATTERNS test to assert the exact list.

### Fix 3: Log surface read failures
- **Source:** silent-failure-hunter
- **File:** pi/extension.ts:106
- **Issue:** Bare `catch {}` — "no surface yet" indistinguishable from "surface unreadable".
- **Fix:** Write one stderr line with path and error.

### Fix 4: Log non-timeout CLI failures in runCli
- **Source:** silent-failure-hunter
- **File:** pi/extension.ts:36-43
- **Issue:** Only timeouts are logged; any other engine failure (generate/load-surface write errors etc.) is silent.
- **Fix:** Log failed command + captured stderr (if any) for non-timeout errors.

### Fix 5: Log spawn failures in runCliDetached
- **Source:** silent-failure-hunter
- **File:** pi/extension.ts:66
- **Issue:** Empty catch — if `bun` missing, semantic-edges/lifecycle/ai-prune silently never run.
- **Fix:** One stderr line.

### Fix 6: Validate cwd positional in CLI
- **Source:** silent-failure-hunter (evidence: untracked `engine/--session/` with a real cortex.db)
- **File:** engine/src/cli.ts (main dispatch)
- **Issue:** Handlers accept flag-like/relative strings as `cwd` and create phantom project dirs.
- **Fix:** Pure `validateCwdArg` (reject non-absolute or `-`-prefixed); apply in main for all cwd-taking subcommands. Add unit tests. Delete the phantom `engine/--session/` dir.

### Fix 7: Pin `.claude` surface path under pi harness env
- **Source:** pr-test-analyzer
- **File:** engine/src/config.test.ts:126-129
- **Issue:** Exact-match test passes against the old harness-branching code too (test env never sets pi vars); redundant `toContain` test adds nothing.
- **Fix:** Repurpose redundant test: stub `PI_CODING_AGENT_DIR` and assert exact `.claude` path.

### Fix 8: Exact branch tests for detectHarness / getGlobalDbPath
- **Source:** pr-test-analyzer
- **File:** engine/src/config.test.ts:28-32
- **Issue:** Disjunctive regex `/\.(claude|pi\/agent)\//` passes for either branch — verifies nothing.
- **Fix:** Env-stubbed exact assertions for both branches, plus direct detectHarness tests.

### Fix 9 (declined): Share path constant between engine and pi extension
- **Source:** pr-test-analyzer
- **Reason:** pi/extension.ts deliberately shells out to the engine CLI and does not import engine modules (separate runtime); cross-package import would couple the pi extension to engine internals. Tests from Fix 7 pin the contract instead.

## Validation Commands
```bash
cd engine && bunx tsc --noEmit
cd engine && bunx vitest run src/config.test.ts src/cli.test.ts
```

Note: full suite has pre-existing failures unrelated to this diff (bun:sqlite resolution under vitest node workers; one extraction property test).
