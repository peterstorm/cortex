# PR Remediation — Standalone Review r37

- **Date:** 2026-08-14
- **Branch:** `perf/semantic-edges-direct-llm`
- **Review run:** `.claude/reviews/review-and-fix-runs/r37`
- **Review kind:** `all`
- **Exact reviewed scope:** `.claude/plans/2026-08-12-pr-remediation-r18.md`, `.claude/plans/2026-08-12-pr-remediation-r23.md`, `.claude/plans/2026-08-12-pr-remediation.md`, `.claude/plans/2026-08-14-pr-remediation-r32.md`, `.claude/plans/2026-08-14-pr-remediation.md`, `HOW-IT-WORKS.md`, `README.md`, `bun.lock`, `engine/src/cli.test.ts`, `engine/src/cli.ts`, `engine/src/commands/ai-prune.test.ts`, `engine/src/commands/ai-prune.ts`, `engine/src/commands/consolidate.ts`, `engine/src/commands/extract.test.ts`, `engine/src/commands/extract.ts`, `engine/src/commands/index-code.test.ts`, `engine/src/commands/index-code.ts`, `engine/src/commands/ingest-session.test.ts`, `engine/src/commands/ingest-session.ts`, `engine/src/commands/remember.ts`, `engine/src/commands/semantic-edges.test.ts`, `engine/src/commands/semantic-edges.ts`, `engine/src/config.test.ts`, `engine/src/config.ts`, `engine/src/core/extraction.test.ts`, `engine/src/core/extraction.ts`, `engine/src/core/json-utils.test.ts`, `engine/src/core/json-utils.ts`, `engine/src/core/types.test.ts`, `engine/src/core/types.ts`, `engine/src/infra/claude-llm.routing.test.ts`, `engine/src/infra/claude-llm.test.ts`, `engine/src/infra/claude-llm.ts`, `engine/src/infra/db.test.ts`, `engine/src/infra/db.ts`, `engine/src/infra/llm-client.test.ts`, `engine/src/infra/llm-client.ts`, `perf/context-return/README.md`, `perf/context-return/probe-extension.ts`, `perf/context-return/run-test.ts`, `perf/context-return/stub-vllm.ts`, `pi/extension.test.ts`, `pi/extension.ts`.

## Mandatory surviving critical findings

1. **`silent-failure-hunter-1` — AI-prune archive consistency**
   - `engine/src/commands/ai-prune.ts:381`
   - Archive the memory, its edges, and its sourced facts in one database transaction.
   - Add a regression that forces a dependent write to fail and proves the memory/dependents roll back together.

2. **`silent-failure-hunter-2` — mixed-invalid extraction checkpoint loss**
   - `engine/src/core/extraction.ts:294`
   - Make any invalid memory or entity item turn the whole response into `parse_error`; retain the raw response for retry.
   - Replace mixed-filter tests with parser and `executeExtract` checkpoint regressions proving no candidate is persisted and no checkpoint advances.

3. **`silent-failure-hunter-3` — entity fact replacement consistency**
   - `engine/src/commands/extract.ts:985`
   - Atomically supersede the old fact and insert its replacement.
   - Add a failure regression proving the former current fact remains current when replacement insertion fails.

## Advisory dispositions

### Accepted

1. **`code-reviewer-1` — exact duplicate edge replay.** Sound correctness issue: ordinary duplicate extraction can add a generic edge beside an existing typed edge. Give extraction memories deterministic session/chunk/candidate identities and replay relationships only when the exact persisted identity proves this is a retry; add ordinary-duplicate and retry regressions.
2. **`code-reviewer-2` — incompatible Pi provider API types.** Sound transport-selection bug. Replace the incomplete blacklist with an `openai-completions` allowlist for explicit Pi API identifiers while preserving legacy providers that omit `api`; test `anthropic-messages`, `openai-responses`, and `openai-completions`.
3. **`code-reviewer-3` — prose delimiter blocks later JSON.** Sound parser bug. Scan successive object/array starts until a balanced, parseable JSON value is found; add bracket- and brace-prefix regressions.
4. **`silent-failure-hunter-4` — malformed prompt-recall payload is silent.** Sound observability gap. Warn for non-empty valid JSON lacking string `prompt`/`cwd` while keeping the hook successful; add a CLI regression.
5. **`silent-failure-hunter-5` — corrupt selected embedding is silent.** Sound observability gap. Match the full-scan warning behavior and include memory ID/column; add a corrupt-row regression.
6. **`pr-test-analyzer-1` — global memory write failure checkpoint test.** Practical missing invariant test. Add a global-DB insert failure regression proving the project checkpoint remains unchanged.
7. **`pr-test-analyzer-2` — provenance retry idempotency assertion.** Practical missing invariant test. Extend the failed entity-processing retry regression to prove exactly one deterministic provenance memory exists.
8. **`comment-analyzer-1` — README global DB path.** Correct the documentation to distinguish Claude and Pi paths.
9. **`comment-analyzer-2` — HOW-IT-WORKS global DB path.** Apply the same harness-specific correction.
10. **`comment-analyzer-3` — schema-guided decoding overclaim.** Reword the comment to state that strict decoding is requested where supported and malformed provider output remains possible.
11. **`comment-analyzer-4` — strict edge parser contract comment.** Update the comment to document accepted array/envelope forms and optional `pair_index` without weakening runtime retry behavior.
12. **`comment-analyzer-5` — detached worker logging comment.** Update the DB comment to describe Pi's detached log and fallback inherited output instead of `/dev/null`.

### Deferred

1. **`type-design-analyzer-1` — brand `Memory.id`.** Sound but cross-cutting: changing persisted/domain IDs requires coordinated migration across every repository, command, and test and is not needed to repair this review's concrete data-loss paths.
2. **`type-design-analyzer-2` — brand edge IDs/endpoints.** Sound but the same broad graph-repository migration would substantially expand risk beyond the reviewed regressions.
3. **`type-design-analyzer-3` — parse `Memory.source_context`.** Sound boundary-design improvement, but changing the stored-memory shape from serialized SQLite text to a parsed union requires a dedicated persistence anti-corruption-layer refactor.
4. **`type-design-analyzer-4` — enforce embedding dimensions.** Sound invariant goal, but current tests and ranking utilities intentionally use reduced vectors; dimension enforcement requires a deliberate production/test embedding abstraction rather than a local cast change.
5. **`architecture-tech-lead-1` — remove factory wall clocks.** Sound purity improvement, but all factories already permit explicit timestamps and requiring a clock value everywhere is a broad API migration with no demonstrated correctness failure in this patch.
6. **`architecture-tech-lead-2` — extract pure extraction write planners.** Directionally sound but too broad for this remediation; the mandatory transactional/checkpoint fixes are safer as focused changes before restructuring the entire use case.
7. **`architecture-tech-lead-3` — semantic-edge ports.** Directionally sound but unrelated to surviving correctness findings and requires a dedicated orchestration/API refactor.

### Dismissed

None.

## Refuted critical audit

`result.json.refuted_critical_findings` is empty. The panel retained all three critical findings. For `silent-failure-hunter-2`, the intent lens argued that warn-and-filter was previously deliberate, but reproduction and blast-radius upheld permanent checkpoint loss, meeting the 2-of-3 survival threshold.

## Validation

Run from `engine/` unless noted:

1. `bun test src/core/extraction.test.ts src/core/json-utils.test.ts src/commands/extract.test.ts src/commands/ai-prune.test.ts src/infra/llm-client.test.ts src/infra/db.test.ts src/cli.test.ts`
2. `bun test`
3. `bun build src/cli.ts --target=bun --outdir /tmp/cortex-build`
4. From repository root: `bun test pi/extension.test.ts`
5. From repository root: `bun build pi/extension.ts --target=bun --outdir /tmp/cortex-pi-build`
6. From repository root: `git diff --check`

`bunx tsc --noEmit` was also attempted from `engine/`, but this repository does not currently have a passing TypeScript gate: its existing `tsconfig.json` lacks Bun types/`allowImportingTsExtensions` and reports numerous pre-existing errors across untouched modules. The configured Bun test suite plus successful Bun production bundles are therefore the executable validation gates for this remediation.
