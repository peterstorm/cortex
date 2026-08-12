# 2026-08-12 Cortex PR Remediation — r18

## Context

- **Branch:** `perf/semantic-edges-direct-llm`
- **Review Run:** `.claude/reviews/review-and-fix-runs/r18` (fresh standalone review, 6-agent cohort, 3-lens refutation panel)
- **Scope:** canonical changed-path union `eaef654..675aeba` — 21 files (the direct-LLM semantic-edge classification feature + v16 remediation)
- **Adjudication (result.json, tally-published):** 14 surviving critical findings (7 unique), 0 refuted, 40 advisory entries (~17 unique)
- **Validation:** `bun test engine/src` (995 tests pre-remediation) + typecheck

## Surviving critical findings → fixes

| # | Finding | Root cause | Fix |
|---|---------|-----------|-----|
| C1 | hunter-1/-8 + arch-1/-3: tolerant-mode parse failures return `[]` which `executeSemanticEdges` permanently retires via `markEdgeClassified` while reporting `ok:true failed:0` | `parseEdgeClassificationResponse` (tolerant) returns bare `[]` on any parse failure; `classifyEdges` cannot distinguish "decline" from "garbage"; the tolerant parser also rejects the prompt's own `{"edges":[...]}` wrapper shape (`!Array.isArray(parsed)`) | Make parse failure a distinct outcome: `EdgeClassificationOutcome = {kind:'ok'; classifications} \| {kind:'unparseable'; reason}`. Tolerant parser accepts both the bare array and the `{"edges":[...]}` wrapper; on JSON/shape failure returns `unparseable`. `classifyEdges` returns the outcome (strict path still throws). `executeSemanticEdges`: `unparseable` → `failed += batch length`, edges left unmarked and retried (same as the thrown-strict path). Adds tests for the wrapper shape on the fallback path. |
| C2 | pta-1/-7: `classifyEdges` transport-based strict/tolerant routing (the C1 fix of v16) has zero regression tests — reverting it would pass CI | No test invokes the real `classifyEdges` (unit tests call the pure parser with explicit options; `semantic-edges.test.ts` mocks `classifyEdges`) | New `engine/src/infra/claude-llm.routing.test.ts`: real `classifyEdges` + real `runLlmPromptDirect` wiring, mocked `llm-client` (`resolveOpenAiCompatEndpoint`, `chatCompletionText`) and mocked `runLlmPrompt`. Direct-success, direct-malformed-throws, fallback-wrapper-accepted (the C1 regression), fallback-garbage → `unparseable`, fallback-decline → `ok []`, empty-pairs no-call. |
| C3 | pta-2/-8: `validateMemoryFields` (v16 C6 updateMemory validation) wholly untested | db.test.ts only ever calls `updateMemory` with valid fields | Add rejection tests to db.test.ts: invalid `memory_type`, invalid `status`, `confidence` out of [0,1], `priority` out of [1,10], empty content, and a valid-path pin. |
| C4 | pta-3/-9: extract availability gate (v16 A01) untested in both branches | extract.test.ts hard-mocks `isClaudeLlmAvailable: () => true` and doesn't mock llm-client (env-leaky) | Make the mocked availability fn a `vi.fn` and mock `resolveOpenAiCompatEndpoint` too. Tests: (a) direct endpoint + no CLI → gate passes (proceeds past the gate); (b) both unavailable → `success:false` with `/No LLM available/`; existing tests unchanged. |
| C5 | comment-1/-9: claude-llm.ts module header still describes a `claude -p`-only CLI client | Header predates the direct-endpoint work | Rewrite header: dual transport — direct OpenAI-compatible endpoint preferred, CLI subprocess fallback. |
| C6 | comment-2/-10: `updateMemory` JSDoc (with `@param db/@param id/@param fields`) orphaned onto `validateMemoryFields(fields, operation)`; `updateMemory` lost its doc | v16 remediation moved the validator in front of the doc block | Move the "Update memory fields" JSDoc block back onto `updateMemory`; `validateMemoryFields` keeps its own doc. |

## Accepted advisories → fixes

| # | Advisory | Fix |
|---|----------|-----|
| A1 | code-reviewer-1/-2 + hunter-4/-11: strict-mode warns-and-drops out-of-range/invalid items, then the pair is permanently retired — contradicting the code's own "must never degrade into a permanent declined verdict" invariant | Add `minimum: 0, maximum: 1` to `strength` in `EDGE_CLASSIFICATION_SCHEMA`; strict mode **throws** when any item is dropped (batch counted failed, edges retried), with the dropped count in the error. |
| A2 | hunter-2/-9: `readJsonConfig` swallows parse errors → corrupt `~/.pi/agent/models.json` silently disables the direct endpoint | Warn (`[cortex:llm] WARN`) when the file exists but cannot be read/parsed; distinguish ENOENT (absent = fine, no warn). |
| A3 | hunter-3/-10: a DB write error inside a batch is caught by the batch catch → misattributed "Batch classification failed" + `failed += batch length` double-counts | Per-edge `try/catch` around the replace/mark mutations: log `Edge <id> write failed (not a classification failure)`; `failed++` per edge; the batch catch covers only `classifyEdges`/join-correctness failures. |
| A4 | hunter-5/-12: no circuit breaker → every batch pays the direct failure + subprocess with no recurrence signal | Per-process consecutive-failure counter in `runLlmPromptDirect`: subsequent failure warnings carry `(N consecutive direct-endpoint failures)`; counter resets on success. |
| A5 | hunter-6/-13: partial `CORTEX_LLM_*` env config silently ignored/falls through | When 1–2 of URL/key/model are set, `warnResolution` naming the missing variables before falling through to pi config. |
| A6 | hunter-7/-14: 90s timeout aborts with no reason → opaque "operation was aborted" | `controller.abort(new Error('LLM request timed out after <ms>ms'))`; rethrow a timeout-named error on `AbortError`. Test with a signal-aware fetch stub. |
| A7 | pta-4/-10: only the no-apiKey warn branch is tested | Add resolution warn-branch tests: unknown provider id, non-http baseUrl, failed `!command` key, missing `models[0].id`, provider precedence. |
| A8 | pta-5/-11: `chatCompletionText` timeout and `response.json()` failure untested | Timeout test (above) + non-JSON response body test. |
| A9 | pta-6/-12: `executeSemanticEdges` only tested with a single batch; concurrency and mixed accounting untested | Multi-batch tests: 12 edges → batch 1 (10) `unparseable`, batch 2 (2) typed → `classified:2, failed:10`, 10 edges unmarked; mixed ok/throw batch accounting. |
| A10 | tda-1/-4: `getEdgesForMemory` drops `classified_at`/`classify_hash` → classified edges materialize as never-attempted | Pass both fields into `createEdge` in `getEdgesForMemory` (as every other read path does); pin with a test. |
| A11 | tda-3/-6: status↔`archived_at` coupling comment-only | `createMemory`: throw on `status:'active'` with `archived_at` set, and on `archived_at` set with a non-`archived` status. `updateMemory`: maintain the coupling — flip to `archived` without `archived_at` writes `archived_at = now`; flip to `active` clears it; `active` + non-null `archived_at` in fields throws. Fix/extend tests. |
| A12 | comment-3..8/-11..16: stale/inaccurate docs (extractMemories lead, buildLlmInvocation claim, `mapLimit` "Pure function" label, getRelatesToEdgesWithMemories doc, strict-mode comment, tolerant-parser doc) | Rewrite each doc to match behavior (tolerant-parser doc after C1 fix). |
| A13 | arch-2/-4: classification join keyed on LLM-echoed IDs silently discards valid (direction-flipped/omitted) classifications and retires them | Deterministic protocol: add `pair_index` (1-based, integer) to `EDGE_CLASSIFICATION_SCHEMA` (required), `EdgeClassification` (optional for tolerant/legacy), and the prompt. Join by index when any entry carries it (all must — else corrupt → batch failure; out-of-range/duplicate index → batch failure, retried). Entries without `pair_index` keep the legacy id-key join. |

## Rejected advisory (disposition)

- **tda-2/-5** (`ExtractionResult` `success:true` + `error:'skipped…'` contradiction → discriminated union): no live bug; the union change ripples through the CLI output contract, the extract-and-generate hook, and consumers outside the reviewed scope. Deferred to a dedicated type-hygiene change.

## Refuted critical findings

None — panel tally: 0 refuted (all 14 survived; `silent-failure-hunter-1/-8` were refuted under the `intent` lens but upheld under `reproduction` + `test-coverage`, threshold 2).

## Validation

- `bun test engine/src`: **1039 pass / 0 fail** (995 at review time; +44 new tests)
- Typecheck: `bunx tsc --noEmit` — zero NEW errors vs baseline 675aeba (residual errors are pre-existing Bun-global/bun:sqlite typing noise, verified by pristine-worktree diff)
- Re-run of scoped suites during iteration: `claude-llm.test.ts`, `claude-llm.routing.test.ts`, `semantic-edges.test.ts`, `extract.test.ts`, `db.test.ts`, `llm-client.test.ts`, `types.test.ts`

## Remediation run

- **Source run:** `r18` (immutable authority)
- **Support paths (not in reviewed scope):** `.claude/plans/2026-08-12-pr-remediation-r18.md` (this plan), `engine/src/commands/extract.test.ts`, `engine/src/infra/claude-llm.routing.test.ts`, `engine/src/core/types.test.ts`

## Execution record

- C1: tolerant parser accepts the `{"edges":[...]}` wrapper; `EdgeClassificationOutcome` tri-state; `executeSemanticEdges` counts unparseable batches failed and leaves edges unmarked. Regression tests in `claude-llm.routing.test.ts` + `semantic-edges.test.ts`.
- C2: `classifyEdges(pairs, transport)` with injectable transport; 7 routing tests drive the real `{ strict: direct }` wiring.
- C3: six `updateMemory` rejection tests in db.test.ts.
- C4: extract.test.ts now toggles availability (vi.fn) and mocks llm-client; both gate branches tested.
- C5: module header rewritten to lead with the dual transport.
- C6: `updateMemory` JSDoc restored; `validateMemoryFields` keeps its own doc.
- A1: schema bounds `minimum:0/maximum:1` + strict throw on dropped items (`1 of N items with invalid shape`).
- A2: `readJsonConfig` warns on corrupt-but-present config.
- A3: per-edge write guard with `failed++` per edge; batch catch covers only classification/join failures.
- A4: per-process consecutive-failure counter; recurrence suffix in fallback warnings (tested in routing suite).
- A5: partial `CORTEX_LLM_*` env warns naming the missing variables.
- A6: abort carries a reason; timeout surfaces as `timed out after <ms>ms` (tested with signal-aware fetch stub).
- A7/A8: resolution warn-branch tests (unknown provider, non-http baseUrl, empty `!command`, missing model id, precedence) + timeout/non-JSON-body tests.
- A9: multi-batch test (10 failed + 2 classified, correct unmarking) + DB-write-failure per-edge test.
- A10: `getEdgesForMemory` materializes `classified_at`/`classify_hash` + parity test.
- A11: `createMemory`/`updateMemory` status↔`archived_at` coupling enforced (active⇒null, anchor on archive, clear on reactivation; pruned keeps the anchor).
- A12: all six stale/misleading doc blocks corrected.
- A13: `pair_index` protocol (schema integer required, prompt enum, optional tolerant key) with all-or-none join rule, out-of-range/mixed → batch failure; flipped-ID join test.
