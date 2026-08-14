# PR Remediation — Standalone Review r34

- **Date:** 2026-08-14
- **Branch:** `perf/semantic-edges-direct-llm`
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/r34`
- **Authority:** `.claude/reviews/review-and-fix-runs/r34/result.json`
- **Panel:** reproduction, intent, and security lenses; threshold 2
- **Panel result:** 6 surviving critical findings, 0 refuted critical findings

## Exact reviewed scope

- `.claude/plans/2026-08-12-pr-remediation-r18.md`
- `.claude/plans/2026-08-12-pr-remediation-r23.md`
- `.claude/plans/2026-08-12-pr-remediation.md`
- `.claude/plans/2026-08-14-pr-remediation-r32.md`
- `.claude/plans/2026-08-14-pr-remediation.md`
- `HOW-IT-WORKS.md`
- `README.md`
- `bun.lock`
- `engine/src/cli.test.ts`
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
- `engine/src/core/extraction.test.ts`
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

1. **`code-reviewer-1` — retryable extraction failures are never retried.** Replace the contradictory boolean-based extraction result with a discriminated outcome that distinguishes success, lock/chunk deferral, retryable failure, and terminal failure. Propagate retryability through the CLI ingestion adapter. Make the detached worker retry both deferred and retryable failed extraction attempts with bounded backoff, but stop immediately on terminal failures. Add tests for transient failure → retry success → backfill and exhausted retryable failure.
2. **`silent-failure-hunter-1` — edge persistence failures are checkpointed away.** Keep duplicate-edge conflicts idempotent, but propagate every non-unique edge insertion failure to `executeExtract`, return a retryable checkpoint-blocking failure, and add a regression proving the chunk checkpoint does not advance.
3. **`pr-test-analyzer-1` — entity/fact persistence failure lacks checkpoint regression coverage.** Inject an entity persistence failure through the extraction shell and prove the result is retryable and the chunk checkpoint remains absent/unchanged.
4. **`pr-test-analyzer-2` — the CLI ingestion adapter lacks deferred/retry integration coverage.** Export a narrow ingestion boundary suitable for direct testing, inject operations, and prove a deferred extract is retried before backfill. The test must cover the adapter that converts extraction command outcomes into ingestion outcomes, not only the lower-level retry loop.
5. **`comment-analyzer-1` — tolerant edge-parser documentation contradicts behavior.** Document that any invalid item makes the tolerant batch unparseable and retryable; do not describe invalid items as dropped.
6. **`comment-analyzer-2` — checkpoint restore documentation contradicts behavior.** Document the actual validated ATTACH → transactional table replacement/FTS cleanup → DETACH implementation.

## Advisory dispositions

1. **`code-reviewer-2` — accepted.** `CORTEX_PI_PROVIDER` is the current model-selection authority passed by the Pi extension. Resolve provider precedence as `CORTEX_LLM_PROVIDER` → `CORTEX_PI_PROVIDER` → `PI_PROVIDER` → configured default and add a model-switch/provider-precedence test.
2. **`silent-failure-hunter-2` — accepted.** Log the read-only database-open failure before attempting the read-write best-effort fallback so the operational downgrade is observable; add diagnostic coverage.
3. **`silent-failure-hunter-3` — accepted.** Preserve the existing friendly ENOENT message, but include the actual error code/message for other `statSync` failures. Add a deterministic injected/stat failure test if practical, otherwise cover a real non-ENOENT filesystem shape.
4. **`pr-test-analyzer-3` — accepted.** Add a global-memory AI-prune regression proving the global record is archived, `archived_at` is set, global edges/facts are cleaned up, and the surface cache is invalidated.
5. **`type-design-analyzer-1` — deferred.** The claim is sound, but changing `Memory.id` to `MemoryId` requires a repository-wide storage/API migration across DB hydration, search, commands, tests, and consumers beyond this focused remediation. The present factories still validate non-empty IDs; no concrete swapped-ID defect was identified.
6. **`type-design-analyzer-2` — deferred.** The claim is sound, but branding `Edge.id` and both endpoint IDs requires the same cross-repository DB and graph API migration. The current edge factory enforces endpoint inequality and relation/status invariants; this change is not needed for the surviving correctness defects.
7. **`type-design-analyzer-3` — deferred.** A validated `SerializedSourceContext` newtype would require parsing or trusted construction at every DB hydration and fixture boundary. Producers already centralize serialization through `serializeSourceContext`; complete migration is broader than the reviewed checkpoint/retry fixes.
8. **`type-design-analyzer-4` — accepted.** The extraction result ADT directly prevents contradictory success/skipped/deferred/error combinations and provides the retryable/terminal distinction required by `code-reviewer-1`.
9. **`comment-analyzer-3` — accepted.** Update the AI-prune handler comment to direct OpenAI-compatible endpoint first, CLI fallback, and the current session-interval/memory-growth trigger.
10. **`comment-analyzer-4` — accepted.** Correct the core-types header to describe readonly domain shapes, literal/nominal types, discriminated unions, and factory validation without claiming every type has one shape.
11. **`comment-analyzer-5` — accepted.** Qualify the LLM client header: direct calls disable thinking; schema-guided decoding is call-specific, while extraction uses JSON mode.
12. **`comment-analyzer-6` — accepted.** Move the extraction-prompt JSDoc directly above `buildExtractionPrompt`, leaving `stripInjectedMemorySurface` with only its own contract.
13. **`architecture-tech-lead-1` — deferred.** `executeExtract` is broad, but introducing a complete `ExtractionDependencies` port and decomposing the workflow is a large architecture migration. The planned narrow injectable ingestion boundary and failure-path tests address the reviewed defects without destabilizing the full extraction pipeline.
14. **`architecture-tech-lead-2` — deferred.** Requiring clocks in all core factories and turning parser diagnostics into returned data is sound but changes construction and parsing contracts across many consumers. No timestamp or stderr correctness defect survives this review; schedule it with the broader functional-core migration rather than partially applying it here.

## Accepted advisory fixes

- Update direct-provider selection and tests in `engine/src/infra/llm-client.ts` and `engine/src/infra/llm-client.test.ts`.
- Add prompt-recall downgrade diagnostics and improve cwd diagnostics in `engine/src/cli.ts` with tests in `engine/src/cli.test.ts`.
- Add global AI-prune side-effect coverage in `engine/src/commands/ai-prune.test.ts`.
- Implement the extraction outcome ADT as part of mandatory retry remediation and update all affected tests/callers.
- Correct the four accepted documentation/comment findings in `engine/src/cli.ts`, `engine/src/core/types.ts`, `engine/src/infra/claude-llm.ts`, and `engine/src/core/extraction.ts`.

## Refuted-finding audit

No critical finding was refuted. All six canonical critical findings survived the panel threshold. Reproduction and intent upheld every finding; the security lens upheld the two runtime integrity findings and was uncertain on the four test/documentation findings.

## Authorized support paths outside reviewed scope

None. The plan and every implementation/test path are already in the frozen reviewed scope.

## Validation

1. `bun test engine/src/commands/ingest-session.test.ts engine/src/commands/extract.test.ts engine/src/infra/llm-client.test.ts engine/src/commands/ai-prune.test.ts engine/src/cli.test.ts`
2. `rm -rf /tmp/cortex-build-r34 && bun build engine/src/cli.ts --target=bun --outdir /tmp/cortex-build-r34`
3. `bun test`
4. `git diff --check`
