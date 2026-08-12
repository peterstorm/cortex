# 2026-08-12 Cortex PR Remediation — r23

## Context

- **Branch:** `perf/semantic-edges-direct-llm` (worktree carries the r18 remediation, uncommitted)
- **Review Run:** `.claude/reviews/review-and-fix-runs/r23` (fresh standalone review on the fixed engine — finalize persisted the canonical T2 refutation-panel checkpoint: `completedPanelCheckpoint` schemaVersion 2 with full event prefix)
- **Scope:** canonical changed-path union — 25 files (post-r18-remediation state)
- **Adjudication (result.json, tally-published):** 9 surviving critical findings (6 unique), 0 refuted, 45 advisories
- Earlier runs: r18 (legacy completion, unrepairable, `done`), r19/r20 (blocked remediation starts), r21/r22 (panel retries rejected: model omitted/typoed manifest finding ids → both attempts exhausted → stuck awaiting-refutation; engine has no re-issue path)
- **Validation:** `bun test engine/src` (1039 tests pre-remediation) + zero-new-tsc-errors check vs baseline

## Surviving critical findings → fixes

| # | Finding | Fix |
|---|---------|-----|
| C1 | hunter-1/-9: `handlePromptRecall` whole-handler bare catch erases every failure with zero logging (cli.ts:1201); inner surface-read and DB-open catches equally silent | Keep the never-fail contract but log every swallowed failure: outer catch → `[cortex] WARN: prompt-recall failed (best-effort, continuing): <err>`; surface-read catch and both database open failures → WARN lines naming cwd/path. |
| C2 | hunter-2/-10: `computeSimilarityAndCreateEdges` empty catch swallows every `insertEdge` error (SQLITE_BUSY, FK, disk), silently dropping related edges (extract.ts:771) | Bind the error; log with edge context (`Edge <src> -> <tgt> insert failed: <err>`) unless `/unique constraint/i` (intended dedup skip). |
| C3 | pta-1/-6 + arch-1(ADV): ai-prune gate is CLI-only; direct-endpoint-only setups never prune (ai-prune.ts:249) | Wire `callClaudePrune` through `runLlmPromptDirect(prompt, AI_PRUNE_TIMEOUT_MS, { jsonMode: true })`; gate becomes `resolveOpenAiCompatEndpoint() === null && !isClaudeLlmAvailable()` with the dual-transport error. |
| C4 | comment-1: ai-prune header + README.md:400 claim direct-endpoint-first that the code never had | Implemented by C3 (header becomes true); keep header, README sentence, adjust the External Services table wording if needed. |
| C5 | comment-2: config.ts:250 + extract.ts:633 claim intra-batch threshold is "higher than" cross-session, but both are 0.75 | Rewrite both comments: thresholds are equal; the real distinction is that intra-batch dedup runs regardless of the existing-memory match outcome. |
| C6 | comment-3 (+tda-2): `SourceContext` declared as the shared source_context schema but imported nowhere; extract (`{branch,commits,files}`) and index-code (`{file_path,...}`) emit shapes matching no union member | Extend the union (`extraction` gains `commits`/`files`; `code_index` gains the discriminant); add `serializeSourceContext(ctx)` in types.ts; all four producers (extract.ts, index-code.ts, remember.ts, consolidate.ts) build source_context through it. |

## Accepted advisories

- A1 code-reviewer-1/-2: `CORTEX_LLM_BINARY` documented but never read; `CORTEX_LLM_MODEL` ignored in the claude branch → implement both in `getLlmBinary`/`buildLlmInvocation` (+ tests); docs become true.
- A2 hunter-4: `getDefaultProvider` empty catch → warn when `~/.pi/agent/settings.json` exists but cannot be read/parsed (ENOENT stays silent).
- A3 hunter-5: `readTelemetry` empty catch → warn when the telemetry file exists but cannot be read/parsed (ai-prune.ts).
- A4 hunter-6: `runShellCommand` swallow → log the caught spawn error so `!command` apiKey failures aren't all misreported as "resolved empty" (llm-client.ts).
- A5 hunter-7: `--limit=abc` parses to NaN → validate in `handleSemanticEdges` (usage error before any LLM run) (cli.ts).
- A6 hunter-8: `parsePruneResponse` silently drops invalid items → count + `[cortex:ai-prune] WARN` when items are dropped (ai-prune.ts).
- A7 pta-3: consecutive-failure counter reset on success untested → routing test (success between failures suppresses the recurrence suffix).
- A8 pta-4: duplicate `pair_index` collapses in `byIndex` and is misreported as "mixed indexed/unindexed" → detect duplicates with an accurate error + dedicated test (semantic-edges.ts).
- A9 tda-1: `createEdge` never validates `EdgeStatus` → `EDGE_STATUSES` + `isEdgeStatus` guard in `createEdge` (types.ts).
- A10 tda-4: `createMemory` doesn't validate `scope`/`source_type` → `MEMORY_SCOPES`/`SOURCE_TYPES` + guards (types.ts).
- A11 tda-7: `MemoryPair.memory_type` widened to `string` → type as `MemoryType` at the LLM boundary (claude-llm.ts).
- A12 comment-4: cli.ts subcommand header omits ai-prune/maintenance/semantic-edges/load-surface/entity-query → sync the list.
- A13 comment-5: ai-prune trigger docs omit the 1.25× growth floor → update header and doc comments to point at `shouldRunAiPrune`.
- A14 comment-6: extract.ts "6. Call Claude CLI" + log predate the dual transport → "Call the LLM (direct endpoint first, CLI subprocess as fallback)".
- A15 comment-7: `deduplicateCandidates` JSDoc documents 3 outcomes but the code has 4 → document intra-batch always-skip + `@param intraBatchThreshold`.
- A16 comment-8: FR-108 comment says embedding text is `... summary content`, code embeds only summary → fix comment.
- A17 comment-9: `runLlmPrompt` doc names only Claude CLI; timeout message says "Extraction LLM CLI timed out" → neutral wording (claude-llm.ts).
- A18 comment-10: cli.ts header claims FR-120 JSONL parsing → remove/repair the claim.
- A19 arch-2: `updateMemory` permits `{ archived_at }` alone on an active row → reject non-null `archived_at` with no/ambiguous status unless the stored row is archived/pruned (read the row).

## Rejected advisories (disposition)

- pta-2 (runLlmPrompt subprocess spawn-harness test): flaky environment coupling; CLI-not-found branch covered; classic spawn path is legacy. Parked.
- tda-3 (apply the unused brands `MemoryId`/`EdgeId`/`GeminiEmbedding`/`LocalEmbedding`): compile-time brand migration across the DB layer; no live bug. Parked.
- tda-5/-6/-8 (CommandResult/ExtractionResult unions, strict-throw totality): parked type-hygiene; strict throw is the documented batch-failure contract.
- arch-3 (clock injection into core factories): pure-core refactor with no live bug. Parked.

## Validation

- `bun test engine/src`: **1052 pass / 0 fail** (1039 at review time; +13 new tests)
- Typecheck: `bunx tsc --noEmit` vs pristine 675aeba worktree — zero NEW errors (residual errors are pre-existing Bun-global/bun:sqlite/line-shift noise, verified by diff)

## Execution record

- C1: `handlePromptRecall` outer catch, surface-read catch, and DB-open fallback now WARN to stderr with the error while keeping the never-fail contract.
- C2: `computeSimilarityAndCreateEdges` catch binds the error; only `/unique constraint/i` stays silent, everything else logs with edge IDs.
- C3/C4: ai-prune routes through `runLlmPromptDirect` (direct endpoint first, jsonMode) with the dual gate `resolveOpenAiCompatEndpoint() === null && !isClaudeLlmAvailable()`; header/README claims are now true. Gate tests added (endpoint-only proceeds; neither → `/no LLM available/i`).
- C5: config.ts + extract.ts comments now state the equal-threshold truth and the real intra-batch distinction.
- C6: `SourceContext` union extended (`extraction` commits/files, `code_index` discriminant); `serializeSourceContext` added; all four producers (extract/index-code/remember/consolidate) serialize through it; serialization tests added.
- Advisories: env overrides implemented (`CORTEX_LLM_BINARY`, `CORTEX_LLM_MODEL` claude branch) + tests; settings.json/telemetry corrupt-read warnings; `runShellCommand` spawn-error log; `--limit` NaN validation; prune drop-count warning; counter-reset routing test; duplicate pair_index detection + test; `createEdge` EdgeStatus guard; `createMemory` scope/source_type guards; `MemoryPair.memory_type: MemoryType` (+ `EdgeEndpointMemory`); cli.ts subcommand list + FR-120 header; ai-prune trigger docs; extract "Call LLM" labels; deduplicateCandidates 4-outcome JSDoc; FR-108 embedding comment; neutral runLlmPrompt docs; `updateMemory` archived_at-only rejection (+ re-anchor allowance) tests.

## Remediation run

- **Source run:** `r23` (immutable authority; `completedPanelCheckpoint` = T2 schemaVersion 2 with full event prefix — verified)
- **Support paths (not in reviewed scope):** `.claude/plans/2026-08-12-pr-remediation-r23.md`, `engine/src/commands/ai-prune.test.ts`, `engine/src/commands/index-code.ts`, `engine/src/commands/index-code.test.ts`, `engine/src/commands/remember.ts`, `engine/src/commands/remember.test.ts`, `engine/src/commands/consolidate.ts`, `engine/src/commands/consolidate.test.ts`
