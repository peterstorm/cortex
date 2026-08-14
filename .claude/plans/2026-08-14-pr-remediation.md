# PR Remediation — Standalone Review r25

- **Date:** 2026-08-14
- **Branch:** `perf/semantic-edges-direct-llm`
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/r25`
- **Authority:** `.claude/reviews/review-and-fix-runs/r25/result.json`
- **Refuted criticals:** none

## Exact reviewed scope

- `.claude/plans/2026-08-12-pr-remediation-r18.md`
- `.claude/plans/2026-08-12-pr-remediation-r23.md`
- `.claude/plans/2026-08-12-pr-remediation.md`
- `HOW-IT-WORKS.md`
- `README.md`
- `bun.lock`
- `engine/src/cli.ts`
- `engine/src/commands/ai-prune.test.ts`
- `engine/src/commands/ai-prune.ts`
- `engine/src/commands/consolidate.ts`
- `engine/src/commands/extract.test.ts`
- `engine/src/commands/extract.ts`
- `engine/src/commands/index-code.test.ts`
- `engine/src/commands/index-code.ts`
- `engine/src/commands/ingest-session.test.ts`
- `engine/src/commands/ingest-session.ts`
- `engine/src/commands/remember.ts`
- `engine/src/commands/semantic-edges.test.ts`
- `engine/src/commands/semantic-edges.ts`
- `engine/src/config.test.ts`
- `engine/src/config.ts`
- `engine/src/core/extraction.ts`
- `engine/src/core/json-utils.test.ts`
- `engine/src/core/json-utils.ts`
- `engine/src/core/types.test.ts`
- `engine/src/core/types.ts`
- `engine/src/infra/claude-llm.routing.test.ts`
- `engine/src/infra/claude-llm.test.ts`
- `engine/src/infra/claude-llm.ts`
- `engine/src/infra/db.test.ts`
- `engine/src/infra/db.ts`
- `engine/src/infra/llm-client.test.ts`
- `engine/src/infra/llm-client.ts`
- `perf/context-return/README.md`
- `perf/context-return/probe-extension.ts`
- `perf/context-return/run-test.ts`
- `perf/context-return/stub-vllm.ts`
- `pi/extension.test.ts`
- `pi/extension.ts`

## Surviving critical findings — mandatory fixes

1. **`code-reviewer-1` — lock-skipped extraction can lose a transcript.** Propagate extraction lock contention as a typed deferred ingestion result. Retry deferred extraction with bounded backoff in the detached worker before backfill; exhausted retries become an observable failure rather than success. Add deterministic retry tests.
2. **`code-reviewer-2` — AI prune asks JSON-object mode for an array.** Change the pruning protocol to a top-level `{ "candidates": [...] }` object and use a strict JSON schema for direct requests; update prompt, parser, and transport tests.
3. **`code-reviewer-3` — malformed prune output becomes a successful empty decision.** Replace the lossy array parser with a discriminated `ok | unparseable` outcome. Invalid JSON, the wrong envelope, or invalid candidate entries fail the batch and do not count as reviewed.
4. **`code-reviewer-4` — indexed semantic edges trust model-echoed endpoint direction.** For `pair_index` responses, persist the trusted pair’s source and target IDs. Strengthen the flipped-ID regression test to assert endpoint direction.
5. **`code-reviewer-5` — partial prune failures reset cadence for every memory.** Track validly reviewed memories per batch, retain failed batches as due by not resetting telemetry unless every batch is valid, return partial failure details, and test mixed success/failure.
6. **`silent-failure-hunter-1` — synchronous Pi CLI failures are silent.** Log command, cwd, status/signal, message, and bounded stderr for every non-timeout `execFileSync` failure while preserving best-effort empty output.
7. **`silent-failure-hunter-2` — detached Pi CLI failures are silent.** Give detached workers a persistent project log, observe spawn/stdin errors, and report synchronous setup failures without making shutdown wait.
8. **`silent-failure-hunter-3` — duplicate of malformed prune success.** Resolved by the typed parse outcome and batch-accounting fix in items 3 and 5.
9. **`silent-failure-hunter-4` — mixed extraction output silently drops invalid candidates.** Emit exact invalid memory/entity counts whenever a mixed response is filtered; add parser diagnostics tests.
10. **`pr-test-analyzer-1` — prompt-recall warning paths lack tests.** Add CLI integration coverage proving malformed input remains best-effort successful and emits a warning.
11. **`type-design-analyzer-1` — duplicate of indexed endpoint corruption.** Resolved by trusted pair endpoints and directional assertions in item 4.
12. **`comment-analyzer-1` — `buildMemoryFromArgs` is falsely documented pure.** Correct the contract to state that it creates identity and timestamps at the imperative boundary.
13. **`comment-analyzer-2` — `candidateToMemory` is falsely documented pure.** Correct the contract to state that it creates identity and timestamps during persistence preparation.
14. **`comment-analyzer-3` — `source_context` comment documents one union variant.** Reference serialized `SourceContext`, the actual source of truth.
15. **`comment-analyzer-4` — README says a headless CLI is always required.** Document the direct OpenAI-compatible endpoint as preferred and the headless CLI as fallback.
16. **`architecture-tech-lead-1` — surface path remains harness-split.** Make `.claude/cortex-memory.local.md` the single output/read path, have the Pi extension use the engine resolver, and retain `.pi` only as an explicitly documented legacy ignore path.

## Advisory dispositions

All advisories are **accepted**. Duplicate advisories share one implementation and test obligation rather than causing duplicate code.

1. **`code-reviewer-6` — accepted.** Detached worker diagnostics are operationally necessary and are covered by mandatory item 7.
2. **`silent-failure-hunter-5` — accepted.** Log an existing Gemini environment file’s read failure; silent credential loss is misleading.
3. **`silent-failure-hunter-6` — accepted.** Log a cached surface read failure while preserving best-effort prompt startup.
4. **`silent-failure-hunter-7` — accepted.** Include the local-model load exception in the Jaccard fallback diagnostic.
5. **`silent-failure-hunter-8` — accepted.** Log non-zero API-key shell command status, signal, and bounded stderr.
6. **`pr-test-analyzer-2` — accepted.** Add regression coverage that non-unique edge insertion failures are reported rather than silently ignored.
7. **`pr-test-analyzer-3` — accepted.** Add Pi shutdown coverage for session-start metadata/model fallback when shutdown context omits them.
8. **`pr-test-analyzer-4` — accepted.** Add a negative `updateMemory` scope test.
9. **`type-design-analyzer-2` — accepted.** Validate `scope` with `isMemoryScope` before dynamic SQL writes; covered by the same negative test.
10. **`comment-analyzer-5` — accepted.** Correct the dedup threshold comment to describe merge and duplicate ceilings plus remember behavior.
11. **`comment-analyzer-6` — accepted.** Correct Session End transport documentation to direct-first/CLI-fallback.
12. **`comment-analyzer-7` — accepted.** Document both `.memory/telemetry.json` (maintenance cadence) and `.memory/cortex-status.json` (generated health telemetry), rather than implying one replaces the other.
13. **`architecture-tech-lead-2` — accepted.** Duplicate of detached worker observability; covered by mandatory item 7.

## Authorized support paths outside reviewed scope

- `.claude/plans/2026-08-14-pr-remediation.md` — this remediation plan.
- `engine/src/cli.test.ts` — prompt-recall boundary regression coverage.
- `engine/src/core/extraction.test.ts` — mixed-invalid extraction diagnostic coverage.

## Validation

1. `bun test engine/src/commands/ingest-session.test.ts engine/src/commands/ai-prune.test.ts engine/src/commands/semantic-edges.test.ts engine/src/core/extraction.test.ts engine/src/commands/extract.test.ts engine/src/infra/db.test.ts engine/src/infra/llm-client.test.ts engine/src/cli.test.ts pi/extension.test.ts engine/src/config.test.ts`
2. `bunx tsc --noEmit -p engine/tsconfig.json`
3. `bun test`
4. `git diff --check`
