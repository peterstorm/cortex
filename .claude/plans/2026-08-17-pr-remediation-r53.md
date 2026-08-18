# PR Remediation — r53

**Branch:** `fix/llm-background-load-guardrails`
**Review Run Directory:** `.claude/reviews/review-and-fix-runs/r53`
**Authoritative result:** `.claude/reviews/review-and-fix-runs/r53/result.json`
**Base → Head:** `8f88663` → `fe86712`

## Exact reviewed scope (23 files)

`.claude/plans/2026-08-16-pr-remediation-r45.md`, `.claude/plans/2026-08-17-pr-remediation-r47.md`,
`.claude/plans/2026-08-17-pr-remediation-r51.md`, `HOW-IT-WORKS.md`, `README.md`,
`engine/src/commands/ai-prune.test.ts`, `engine/src/commands/ai-prune.ts`,
`engine/src/commands/semantic-edges.test.ts`, `engine/src/commands/semantic-edges.ts`,
`engine/src/config.ts`, `engine/src/core/chunk.test.ts`, `engine/src/core/chunk.ts`,
`engine/src/core/types.test.ts`, `engine/src/core/types.ts`,
`engine/src/infra/claude-llm.concurrency.test.ts`, `engine/src/infra/claude-llm.routing.test.ts`,
`engine/src/infra/claude-llm.ts`, `engine/src/infra/db.test.ts`, `engine/src/infra/db.ts`,
`engine/src/infra/llm-test-helpers.ts`, `pi/extension.test.ts`, `pi/extension.ts`,
`pi/shutdown-policy.ts`

## Adjudication summary

| | Count |
|---|---|
| Reviewers run | 7 |
| Critical findings raised | 0 |
| Refuted criticals | 0 |
| **Surviving criticals (mandatory)** | **0** |
| Advisories published | 33 (31 unique; `pr-test-analyzer-3/-4` duplicate `-1/-2`) |
| Advisories accepted | 30 |
| Advisories deferred | 1 |
| Advisories dismissed | 0 |

No critical findings existed, so the Refutation Panel did not run and
`refuted_critical_findings` is empty. There is nothing to audit as refuted.

## Surviving critical findings

None. The review produced zero criticals across all seven reviewers.

## Refuted critical findings

None (no criticals were raised, so no panel adjudication occurred).

## Advisory dispositions

### Accepted (30)

**Silent-failure / robustness**

1. `silent-failure-hunter-1` — `rowToEdge` (`db.ts:1307`) validates `relation_type`
   but casts `row.status` unchecked; a corrupt status throws out of `createEdge`
   and kills every edge query instead of degrading one row.
   **Fix:** narrow `status` with the existing `isEdgeStatus` guard and drop the
   row with the same diagnostic the `relation_type` path already emits.
2. `silent-failure-hunter-2` — `runAiPrune` has no top-level try/catch, so
   DB/telemetry exceptions surface as unhandled rejections.
   **Fix:** wrap the body and return a structured failure result.
3. `silent-failure-hunter-3` — a per-candidate archive transaction failure aborts
   the remaining batch loop.
   **Fix:** guard each archive, log, count the failure, continue.
4. `silent-failure-hunter-4` — `recordBatchFailure`'s `markEdgeFailed` is
   unguarded inside the catch handler; a DB error there rejects the whole
   `mapLimit` and discards every sibling batch's counts.
   **Fix:** guard each `markEdgeFailed` write per edge.
5. `silent-failure-hunter-5` — the `shouldRunShutdownPipeline` early return skips
   the pipeline with no diagnostic, unlike its sibling guards.
   **Fix:** emit the skip reason on stderr.
6. `silent-failure-hunter-6` + `code-simplifier-12` + `code-simplifier-1` —
   `getExtractionCheckpoint`, `upsertEntity` and the three Fact readers cast rows
   via `as any`, bypassing the typed-row protection the file introduced to stop
   column drift, and the three Fact readers inline the same untyped mapper.
   **Fix:** declare `ExtractionCheckpointRow`, `EntityIdRow` and `FactRow`, and
   route all three Fact readers through one shared `rowToFact` mapper.

**Correctness**

7. `code-reviewer-1` — `resolveArchiveAnchor` accepts an explicit
   `archived_at: null` alongside `status: 'archived'`/`'pruned'`, silently
   producing an archived row with no anchor (every other status/anchor
   contradiction is refused).
   **Fix:** refuse an explicit null anchor when the resolved status is
   archived/pruned; regression test both directions.

**Test coverage**

8. `pr-test-analyzer-1` (= `-3`) — `recordSuccessfulAiPrune` is never
   round-tripped: no test reads the telemetry file back or calls
   `runAiPruneIfNeeded` twice to prove the watermark advances.
   **Fix:** add a two-call test against a real telemetry file.
9. `pr-test-analyzer-2` (= `-4`) — `isCortexShutdownReason` has no direct unit
   test and no integration test drives an unrecognized reason through
   `session_shutdown`.
   **Fix:** add both.

**Type design**

10. `type-design-analyzer-1` — `MemoryId`/`EdgeId` are declared and never applied.
    The reviewer offered two complete fixes: apply them, or delete them.
    **Applying was attempted first and measured**, since `rules/architecture.md`
    lists IDs among its value objects: `Memory.id: MemoryId`, `Edge.id: EdgeId`,
    `Edge.source_id`/`target_id: MemoryId`, branded inside the factories, with
    repository parameters left as `string`. That raised the checkout from 144 to
    **409 `tsc` errors — +265, across 15+ files outside this review's scope**,
    almost all test fixtures assigning a plain `string` id to a Memory literal.
    Since `tsc` is not a gate here, those errors would have been invisible to
    the test suites while leaving the codebase materially worse typed, and
    fixing all 265 is a mechanical sweep across the whole engine that this
    remediation has no mandate for.
    **Fix applied:** delete the dead brands. `MemoryId`, `EdgeId` and their
    equally-unused sibling `LocalEmbedding` are removed from
    `engine/src/core/types.ts`; nothing in the repository referenced any of
    them. The finding — "declared but never applied" — is resolved, and a
    future change that wants branded identities starts from an honest blank
    rather than three declarations that promised safety they never provided.
11. `type-design-analyzer-2` — `AiPruneResult`'s independent optional
    `skipped`/`error` fields admit states no call site produces.
    **Fix:** a three-arm discriminated union (`completed | skipped | partial`)
    that keeps the real partial-success arm the reviewer identified.
12. `type-design-analyzer-3` + `code-simplifier-4` — `createMemory`'s
    `scope`/`source_type` guards test `!== undefined` against required fields
    (dead branch), and both factories inline a `memory_type` check instead of the
    exported `isMemoryType`.
    **Fix:** validate unconditionally; use the exported guards.

**Docs**

13. `comment-analyzer-1` — `llm-test-helpers.ts:5` claims five call sites across
    three suites; there are eight across four.
    **Fix:** correct the docstring and name `ai-prune.test.ts`.

**Architecture**

14. `architecture-tech-lead-2` + `code-simplifier-6` — `createCheckpoint`/
    `restoreCheckpoint` (whole-DB `VACUUM INTO` backup) collide with
    `ExtractionCheckpoint` (transcript resume cursor) in one module, and
    `createCheckpoint` duplicates timestamp/validate/VACUUM across both branches.
    **Fix:** rename to `createDbSnapshot`/`restoreDbSnapshot` (the code comment
    already calls it a snapshot) and collapse the duplicated branch to a single
    path selection. Support path: `engine/src/commands/consolidate.ts`.
15. `architecture-tech-lead-3` + `code-simplifier-8` + `code-simplifier-9` —
    `pi/extension.ts`'s subprocess boundary has no port, so its tests mock
    `node:child_process` — a seam that has already killed the whole file twice —
    and `runCliResult`/`runCliDetached` duplicate env building while the
    error-stringify idiom repeats at four catch sites.
    **Fix:** introduce a `CliRunner` port with the real adapter in
    `pi/cli-runner.ts`, inject it through a defaulted `registerCortex` parameter,
    share one env builder and one `describeError` helper, and rewrite
    `pi/extension.test.ts` to inject a plain-object fake with no `vi.mock` at all.

**Duplication (distill)**

16. `code-simplifier-2` — confidence/priority range checks duplicated between
    `createMemory` and `createMemoryCandidate`. **Fix:** shared validators.
17. `code-simplifier-3` — six string-union guards in two casting styles.
    **Fix:** one `unionGuard` factory.
18. `code-simplifier-5` — `parseEdgeClassificationResponse`'s strict and tolerant
    branches duplicate unwrap/filter/message. **Fix:** one shared validation step.
19. `code-simplifier-7` — `archiveProjectMemory`/`archiveGlobalMemory` are the
    same closure over two databases. **Fix:** one factory.
20. `code-simplifier-10` — the archive if/else duplicates `totalArchived++` and
    the log line in both arms. **Fix:** select the archiver, then act once.
21. `code-simplifier-11` — `pairContentHash` recomputed in the catch block.
    **Fix:** compute once per pair.
22. `code-simplifier-13` — `types.test.ts` repeats a 10-field literal per test.
    **Fix:** base + override factory.
23. `code-simplifier-14` — `db.test.ts` closes the DB at the end of every `it()`.
    **Fix:** shared `afterEach`.
24. `code-simplifier-15` — duplicate `Object.assign` error fixture in
    `extension.test.ts`. **Fix:** small factory.

### Deferred (1)

- `architecture-tech-lead-1` — *"`db.ts` is a god module spanning five unrelated
  aggregate repositories."* **Deferred.** The claim is sound: one 1934-line
  module holds Memory CRUD, Edge/graph CRUD, the extraction-checkpoint
  repository, the DB-snapshot mechanism and the Entity/Fact repository, mirrored
  by a single 1940-line test suite. It is deferred because the fix is a pure
  reorganization that rewrites ~3900 lines and rewrites the import surface of
  every db consumer across the engine — most of them outside this review's
  23-file scope — while changing no behavior. Bundling it with the 30 behavioral
  and hygiene fixes here would produce a diff nobody can review, and it earns its
  own change with its own review. The two locality problems that *are* fixable in
  place — the `checkpoint` name collision (#14) and the untyped row casts (#6) —
  are accepted above and reduce the module's worst hazards in the meantime.

### Dismissed (0)

None.

## Incidental fix (not from a finding)

Building the `CliRunner` adapter's real-subprocess tests exposed dead code in
the diagnostic it inherited from `pi/extension.ts`: the timeout branch keyed on
`message.includes("TIMEOUT")`, but the runtime reports `ETIMEDOUT`, which does
not contain the substring `TIMEOUT`. Every timeout had therefore always been
reported through the generic exit-status branch. The branch now keys on
`failure.code === "ETIMEDOUT"` and `pi/cli-runner.test.ts` pins it with a real
child that outlives its timeout. Recorded here because it is a behaviour change
no reviewer asked for.

## Support paths (changes outside the reviewed 23 files)

| Path | Why |
|---|---|
| `engine/src/cli.ts` | Consumer of `AiPruneResult`; switches on the new discriminant. |
| `engine/src/commands/consolidate.ts` | Sole caller of the renamed snapshot functions. |
| `engine/src/commands/consolidate.test.ts` | Asserts on the renamed helper and result field. |
| `pi/cli-runner.ts` (new) | The extracted `CliRunner` port and adapter. |
| `pi/cli-runner.test.ts` (new) | Adapter tests, real subprocesses, no mocks. |
| `pi/shutdown-policy.test.ts` | Home of the new `isCortexShutdownReason` tests. |
| `.claude/plans/2026-08-17-pr-remediation-r53.md` (new) | This plan. |

## Validation gates

Executable gates for this repository (`bunx tsc --noEmit` does **not** pass on
this checkout and is not a gate — 144 pre-existing errors, almost all
`Cannot find name 'Bun'` / `Cannot find module 'bun:sqlite'` from missing bun
type declarations):

```bash
cd engine && bun test          # baseline: 1219 pass / 0 fail across 38 files
cd .. && bun test pi/          # baseline: 22 pass / 0 fail across 2 files
cd engine && bunx tsc --noEmit 2>&1 | grep -c '^src/'   # must stay <= 144
```

Remediation is installed only if all three hold after the changes.
