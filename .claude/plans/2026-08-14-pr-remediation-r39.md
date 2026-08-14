# PR remediation plan — r39

- **Date:** 2026-08-14
- **Branch:** `perf/semantic-edges-direct-llm`
- **Review authority:** `.claude/reviews/review-and-fix-runs/r39/result.json`
- **Standalone Review Run:** `.claude/reviews/review-and-fix-runs/r39`
- **Reviewed scope:** `.claude/plans/2026-08-12-pr-remediation-r18.md`, `.claude/plans/2026-08-12-pr-remediation-r23.md`, `.claude/plans/2026-08-12-pr-remediation.md`, `.claude/plans/2026-08-14-pr-remediation-r32.md`, `.claude/plans/2026-08-14-pr-remediation-r37.md`, `.claude/plans/2026-08-14-pr-remediation.md`, `HOW-IT-WORKS.md`, `README.md`, `bun.lock`, `engine/src/cli.test.ts`, `engine/src/cli.ts`, `engine/src/commands/ai-prune.test.ts`, `engine/src/commands/ai-prune.ts`, `engine/src/commands/consolidate.ts`, `engine/src/commands/extract.test.ts`, `engine/src/commands/extract.ts`, `engine/src/commands/index-code.test.ts`, `engine/src/commands/index-code.ts`, `engine/src/commands/ingest-session.test.ts`, `engine/src/commands/ingest-session.ts`, `engine/src/commands/remember.ts`, `engine/src/commands/semantic-edges.test.ts`, `engine/src/commands/semantic-edges.ts`, `engine/src/config.test.ts`, `engine/src/config.ts`, `engine/src/core/extraction.test.ts`, `engine/src/core/extraction.ts`, `engine/src/core/json-utils.test.ts`, `engine/src/core/json-utils.ts`, `engine/src/core/types.test.ts`, `engine/src/core/types.ts`, `engine/src/infra/claude-llm.routing.test.ts`, `engine/src/infra/claude-llm.test.ts`, `engine/src/infra/claude-llm.ts`, `engine/src/infra/db.test.ts`, `engine/src/infra/db.ts`, `engine/src/infra/llm-client.test.ts`, `engine/src/infra/llm-client.ts`, `perf/context-return/README.md`, `perf/context-return/probe-extension.ts`, `perf/context-return/run-test.ts`, `perf/context-return/stub-vllm.ts`, `pi/extension.test.ts`, `pi/extension.ts`.

## Mandatory surviving critical findings

1. **`code-reviewer-1` — malformed entity envelopes advance extraction checkpoints**
   - `engine/src/core/extraction.ts:277`
   - Require the optional `entities` field to be absent or an array. Return a parse error for `null`, objects, strings, numbers, and other non-array values.
   - Make parse diagnostics data in the parse-error variant, log the diagnostic only at the `executeExtract` shell boundary, and retain the current retry/no-checkpoint behavior.
   - Add parser regressions and an `executeExtract` regression proving malformed entity envelopes do not create or advance a checkpoint.

2. **`pr-test-analyzer-1` — high-confidence stable memories rely only on an LLM prompt guard**
   - `engine/src/commands/ai-prune.ts:99`
   - Add a pure code-level guard for `architecture` and `decision` memories with confidence `>= 0.8` and enforce it before archive writes for both project and global databases.
   - Add a regression where the LLM nominates protected project/global memories and an ordinary old memory; protected memories must remain active while the ordinary candidate archives.

## Advisory dispositions

### Accepted

1. **`silent-failure-hunter-1` — probe extension hides request failures.**
   - Sound and small. Preserve a usable tool result but include bounded HTTP/fetch/JSON diagnostics in the returned text/details. Add a focused probe-extension test.

2. **`silent-failure-hunter-2` — context-return runner loses spawn/timeout identity.**
   - Sound and small. Return spawn error, signal, and timeout state from `runPi`, make settlement idempotent across `error`/`close`, and include diagnostics in the failed assertion. Add focused spawn-error and timeout tests.

3. **`silent-failure-hunter-3` — index-code continues after re-index lookup failure.**
   - Sound correctness issue. Return an explicit command failure before any insertion when the active-memory lookup fails, preventing stale active versions from being silently retained. Add a regression using an unavailable/closed target database.

4. **`silent-failure-hunter-4` — consolidate ignores all checkpoint unlink failures.**
   - Sound correctness/diagnostic issue. Ignore only `ENOENT`; surface all other cleanup failures so the outer rollback/error path runs. Add focused cleanup tests for `ENOENT` and permission-style failure.

5. **`comment-analyzer-1` — stale extraction table name.**
   - Sound and trivial. Change `extractions` to `extraction_checkpoints` in the FR-004 comment.

6. **`comment-analyzer-2` — README direct-LLM environment table is incomplete.**
   - Sound and user-facing. Add `CORTEX_LLM_API_URL` and `CORTEX_LLM_API_KEY`, and clarify `CORTEX_LLM_MODEL` covers both explicit direct configuration and CLI override.

7. **`comment-analyzer-3` — HOW-IT-WORKS direct-LLM environment table is incomplete.**
   - Sound and user-facing. Mirror the corrected direct endpoint variables and model semantics.

8. **`architecture-tech-lead-1` — pure extraction parser writes stderr.**
   - Sound and directly adjacent to critical 1. Add a parse-error diagnostic field, remove parser I/O, and log at the extraction shell boundary. Update parser tests to assert returned diagnostics rather than spying on stderr.

### Deferred

1. **`type-design-analyzer-1` — embedding brands do not enforce dimensions.**
   - Deferred because the brands are currently unused aliases while `Memory`, SQLite materialization, embedding providers, and many tests intentionally carry raw typed arrays of varying fixture dimensions. Enforcing dimensions correctly requires a coordinated persistence/provider/domain migration, not a local constructor check that callers bypass.

2. **`type-design-analyzer-2` — `source_context` accepts arbitrary strings.**
   - Deferred because persisted legacy rows and many tests use `{}` or intentionally malformed JSON, while ranking/recall currently define tolerant behavior for those rows. A safe fix needs a parsed `SourceContext` value object plus DB migration/legacy decoding across all producers and consumers; tightening only `createMemory` would strand existing data and bypass DB materialization.

3. **`type-design-analyzer-3` — `CommandResult` permits contradictory states.**
   - Deferred as a cross-cutting CLI contract migration: command handlers, maintenance aggregation, ingestion adapters, output formatting, and tests all consume the current shape. It should be converted atomically to a discriminated union in a dedicated change rather than partially adapted during data-loss remediation.

4. **`architecture-tech-lead-2` — concrete LLM imports instead of ports.**
   - Deferred as a cross-command architecture migration spanning extraction, semantic edges, AI prune, routing, and their test harnesses. The current remediation can close the correctness gaps without mixing a broad dependency-inversion rewrite into the same verified patch.

### Dismissed

1. **`pr-test-analyzer-2` — no stale-hash semantic-edge reclassification test.**
   - Dismissed as already covered. `engine/src/infra/db.test.ts` has `classifiable edges respect attempt tracking and content changes`, which marks a `relates_to` edge with the current `classify_hash`, verifies unchanged content excludes it, mutates endpoint content, and verifies the edge re-qualifies.

## Refuted critical audit — retain, do not fix

- **`code-reviewer-2` — indexed semantic classifications allegedly persist directional relations backwards.**
  - **Intent lens:** The prompt defines relation direction relative to trusted Pair Source/Target; `pair_index` binds the response to that pair, and echoed IDs are diagnostic. Trusting echoed orientation would contradict the protocol.
  - **Blast-radius lens:** Keeping trusted indexed endpoints prevents malformed/reversed model echoes from redefining endpoints.
  - **Disposition:** Refuted by 2 of 3 panel lenses; no semantic-edge orientation change will be made.

## Planned support paths outside reviewed scope

- `.claude/plans/2026-08-14-pr-remediation-r39.md`
- `engine/src/commands/consolidate.test.ts`
- `perf/context-return/probe-extension.test.ts`
- `perf/context-return/run-test.test.ts`

## Validation

1. Focused tests:
   - `cd engine && bun test src/core/extraction.test.ts src/commands/extract.test.ts src/commands/ai-prune.test.ts src/commands/index-code.test.ts src/commands/consolidate.test.ts`
   - `bun test perf/context-return/probe-extension.test.ts perf/context-return/run-test.test.ts`
2. Runtime build:
   - `rm -rf /tmp/cortex-r39-build && bun build engine/src/cli.ts pi/extension.ts perf/context-return/run-test.ts perf/context-return/probe-extension.ts --target=bun --outdir /tmp/cortex-r39-build`
3. Full relevant suites:
   - `bun test`
   - `bun test pi/extension.test.ts perf/context-return/probe-extension.test.ts perf/context-return/run-test.test.ts`
4. Context-return integration proof:
   - `bun run perf/context-return/run-test.ts`
5. Repository witness before remediation registration:
   - `git status --short`
