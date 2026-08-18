# PR Remediation — r55

- **Branch**: `fix/llm-background-load-guardrails`
- **HEAD at review**: `0d18eab`
- **Review Run Directory**: `.claude/reviews/review-and-fix-runs/r55`
- **Authority**: `.claude/reviews/review-and-fix-runs/r55/result.json` (digest `13657ad9d80dfc2cfdc10223f320bb78badbc5bb34e881cf0a1b4750a297a5cf`)
- **Reviewers**: code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer, comment-analyzer, architecture-tech-lead, code-simplifier
- **Refutation Panel**: 3 lenses (reproduction, intent, blast-radius) over 1 critical finding

## Scope

The 30-file frozen scope of run r55 — `engine/src/cli.ts`, `engine/src/commands/{ai-prune,consolidate,semantic-edges}.{ts,test.ts}`,
`engine/src/config.ts`, `engine/src/core/{chunk,types}.{ts,test.ts}`, `engine/src/infra/{claude-llm,db,llm-test-helpers}.ts` and
sibling tests, `pi/{cli-runner,extension,shutdown-policy}.{ts,test.ts}`, `HOW-IT-WORKS.md`, `README.md`, and the four prior
remediation plans.

## Counts

| | |
|---|---|
| Critical found | 1 |
| Critical refuted | 0 |
| Critical surviving (mandatory) | 1 |
| Advisory entries in `result.json` | 23 |
| Advisory unique claims after dedup | 14 (+1 that restates the critical) |
| Advisory accepted | 14 |
| Advisory deferred | 0 |
| Advisory dismissed | 0 |

`result.json` carries both the marker-line and findings-block representation of several claims, so the 23 advisory entries
collapse to 14 distinct pieces of work. Every duplicate pair is recorded below against the item it duplicates.

## Refuted findings audit

**None.** The Refutation Panel ran all three lenses against the single critical finding and every lens returned `upheld`.
Verbatim panel reasoning is retained in `result.json.panel` and summarised under the critical below. No finding was
refuted, so nothing is exempt from remediation on refutation grounds.

---

## Surviving critical (mandatory)

### C1 — `pr-test-analyzer-1` · `engine/src/core/types.ts:397-412`

**Claim.** `resolveArchiveAnchor`'s explicit `archived_at: null` branch — the r53 fix for the archived-row-with-no-anchor
data-integrity bug — has zero test coverage. No downstream validation catches a regression, so deleting the branch would
silently reintroduce a bug this codebase has already shipped twice.

**Panel verdict: upheld 3/3.**

- *reproduction*: all 11 assertions in the `resolveArchiveAnchor` describe block (`types.test.ts:994-1059`) and every
  `updateMemory` test in `db.test.ts` pass either a status-only patch or a non-null `archived_at`; no test anywhere passes
  `archived_at: null` as a patch value, so the branch at `types.ts:403-411` is never entered. Deleting it leaves the suite
  green — the null falls past `patch.archived_at != null` and past `patch.archived_at === undefined` to the terminal return,
  persisting `status='archived'` with a null anchor.
- *intent*: `.claude/plans/2026-08-17-pr-remediation-r53.md:82-83` states the fix as "refuse an explicit null anchor when the
  resolved status is archived/pruned; regression test both directions", so the missing test contradicts stated intent rather
  than reflecting a deliberate choice. `createMemory` (`types.ts:329-338`) only rejects a non-null anchor on a status that
  must not hold one — it never requires one for archived/pruned — so the branch is the sole enforcement point.
- *blast-radius*: an archived row whose anchor was wrongly cleared reads back clean through `createMemory`, and
  `lifecycle.ts:222-245` then anchors prune eligibility on the `updated_at` fallback instead, silently shifting the FR-091
  grace window before `deleteEdgesForMemory` hard-deletes edges. Containment: no shipped caller currently passes
  `archived_at: null`, which narrows how soon the blast lands but does not refute the claim — the guard exists precisely for
  that untested arrival path.

**Fix.** Add the missing regression cases to the `resolveArchiveAnchor` suite in `engine/src/core/types.test.ts`, both
directions: an explicit `archived_at: null` paired with a resolved status of `archived` and of `pruned` must be refused;
the same explicit null paired with `active` and `superseded` must be allowed through. Each case must fail if the branch at
`types.ts:403-411` is deleted.

*(Advisory `code-reviewer-2` / `code-reviewer-6` restate this same claim and are discharged by this fix.)*

---

## Advisory dispositions

All 14 distinct advisories are **accepted**. Every one is a sound claim with a complete, in-scope fix; none needs work
outside the reviewed scope, and none is speculative. No advisory is deferred or dismissed.

### A1 — accepted · `code-reviewer-1` / `code-reviewer-5` · `engine/src/infra/db.ts:1830,1862`

`rowToEntity` casts `entity_type` unchecked into `createEntity`, and `rowToFact` feeds unvalidated
`predicate`/`object`/`confidence` into `createFact`. Both throw on corrupt data, with no guard in
`getEntityByName`/`searchEntities`/`getAllEntities` or `getCurrentFacts`/`getAllFacts`/`getFactsByMemory` — one corrupt row
kills every read. This is the exact hazard `rowToEdge` was hardened against in the same diff, left unfixed in the two
sibling mappers.

**Fix.** Give both mappers the `rowToEdge` treatment: validate the union-typed cell with the existing type guard, and on
failure drop the row with a diagnostic instead of throwing. Regression tests mirroring the existing corrupt-`memory_type`
case, for both entity and fact reads.

### A2 — accepted · `code-reviewer-3` / `code-reviewer-7` · `engine/src/infra/db.ts:1315`

`rowToEdge`'s new `isEdgeStatus` guard has no regression test.

**Fix.** Corrupt an edge's `status` column and assert the row is dropped with a diagnostic rather than thrown, analogous to
the existing corrupt-`memory_type` test.

### A3 — accepted · `code-reviewer-4` / `code-reviewer-8` / `pr-test-analyzer-4` · `engine/src/commands/semantic-edges.ts:315-331`

`recordBatchFailure`'s inner try/catch around `markEdgeFailed` is untested. `semantic-edges.test.ts:407` covers a different
write path (`insertEdge` replacement failing), not `markEdgeFailed` throwing inside the guard added for it.

**Fix.** Force `markEdgeFailed` to throw for one edge and assert sibling batches' `failed`/`classified` counts survive.

### A4 — accepted · `silent-failure-hunter-1` · `engine/src/commands/semantic-edges.ts:415`

In `executeSemanticEdges`' per-edge write catch block, the unique-constraint recovery call `markEdgeClassified` is
unguarded, unlike its sibling `markEdgeFailed` in `recordBatchFailure`, which is deliberately wrapped for the documented
reason that an escaping error inside a `mapLimit` worker rejects `Promise.all`, discards every concurrently-running batch's
accounting, and leaves an abandoned runner executing against a DB connection the caller is about to close.

**Fix.** Wrap the recovery call in the same guard as its sibling, with a diagnostic on failure, and add a test driving
`executeSemanticEdges` through the unique-constraint recovery path with a throwing `markEdgeClassified`.

### A5 — accepted · `pr-test-analyzer-2` · `engine/src/commands/ai-prune.ts:365-380`

`runAiPrune`'s top-level try/catch is untested; nothing proves a thrown exception becomes a structured
`{ kind: 'failed' }` result with partial-progress counters preserved.

**Fix.** Drive an exception through the catch and assert the structured failure result, including preserved
`archived`/`reviewed` counters.

### A6 — accepted · `pr-test-analyzer-3` · `engine/src/commands/ai-prune.ts:522-539`

The per-candidate archive-failure-continues-the-loop fix is only exercised by a single-candidate test
(`ai-prune.test.ts:693`) whose own comment claims multi-candidate continuation it cannot prove.

**Fix.** Seed two candidates, make the first `archive()` throw, assert the second is still archived and that
`archiveFailures`/`result.archived` reflect both outcomes. Correct the overclaiming comment at `ai-prune.test.ts:722-724`.

### A7 — accepted · `type-design-analyzer-1` · `engine/src/core/types.ts:460-512`

`createEdge` calls `requireNonEmpty` on `id`/`source_id`/`target_id` but discards the trimmed return values, storing raw
untrimmed input — asymmetric with `createMemory`, which its own comment claims to mirror. The self-reference check at
`types.ts:481` also compares untrimmed values, so `"mem-1"` vs `"mem-1 "` escapes the no-self-edge invariant.

**Fix.** Capture and use the trimmed values exactly as `createMemory` does, including in the self-reference comparison.
Test that a padded id is normalised and that a padded self-edge is rejected.

### A8 — accepted · `type-design-analyzer-2` · `engine/src/cli.ts:86-93`

`CommandResult` is a flat bag of independent optional fields sitting between two proper discriminated unions.
`extractionToCommandResult` (`cli.ts:270`) constructs `success: true` and `deferred: true` simultaneously, and
`commandToIngestionStep` (`cli.ts:1350-1362`) must re-disambiguate by checking `result.deferred` before `result.success` in
a compiler-unenforced order.

**Fix.** Model it as the three real outcomes — `succeeded` / `deferred` / `failed` — as a discriminated union, making the
ambiguous state unrepresentable and turning `commandToIngestionStep` into a total, order-independent `switch`. Update every
construction and consumption site in `cli.ts` and its tests.

### A9 — accepted · `comment-analyzer-1` / `comment-analyzer-4` · `engine/src/commands/consolidate.ts:380`

The JSDoc describing `executeConsolidate` (its params, return type, and FR references) is attached to
`removeSnapshotFile`, an unrelated void-returning helper; `executeConsolidate` has no docstring of its own.

**Fix.** Move the docstring to `executeConsolidate`.

### A10 — accepted · `comment-analyzer-2` / `comment-analyzer-5` · `engine/src/commands/ai-prune.ts:369`

The catch-block comment is grammatically garbled and unparseable on first read, though its underlying claim is accurate.

**Fix.** Reword to state the sibling relationship and the consequence clearly.

### A11 — accepted · `comment-analyzer-3` / `comment-analyzer-6` · `pi/extension.test.ts:9`

The header claims "This file mocks NOTHING" while the file calls `vi.fn()` twice to spy on a `notify` callback.

**Fix.** Narrow the claim to what is true and load-bearing: the file mocks no *module* — the engine boundary is a
plain-object `CliRunner` fake, not `vi.mock(...)`.

### A12 — accepted · `code-simplifier-1` · `engine/src/commands/consolidate.ts:440-451`

`executeConsolidate`'s pass loop always runs exactly one iteration because of an unconditional `break`, making `maxPasses`
dead beyond gating loop entry and making a reader trace the loop to discover it.

**Fix.** Replace with straight-line code and a comment stating why a second detection pass cannot differ (FR-082: pairs are
returned for human review, never auto-merged, so a second pass over the same DB state finds the same pairs). Retire the
now-inert `maxPasses` option, or keep it only where a live caller still supplies it.

### A13 — accepted · `code-simplifier-2` · `engine/src/cli.ts:136-173` vs `:1196-1219`

`readStdinJson` and `handlePromptRecall` independently re-implement the identical stdin read/concat/decode loop.

**Fix.** Extract `readStdinText(): Promise<string | null>` and have both callers apply their own parsing on top.

### A14 — accepted · `code-simplifier-3` · `engine/src/cli.ts:225-258` vs `:631-649`

`initDatabases` and the head of `handleConsolidate` duplicate project-DB directory-prep and gitignore steps.

**Fix.** Extract a `prepareProjectDbDir(cwd)` helper both call, leaving each caller's genuinely different invalid-cwd
handling (`process.exit(1)` vs `CommandResult`) local to it.

---

## Not remediated (recorded, not a finding)

The architecture reviewer returned zero findings and explicitly declined to re-raise `engine/src/infra/db.ts` spanning five
aggregates (Memory, Edge, ExtractionCheckpoint, Entity, Fact). That item was surfaced and deliberately deferred in
`.claude/plans/2026-08-17-pr-remediation-r53.md:174-185`: it is a pure ~3900-line reorganisation touching import surfaces
well outside this review's scope, with no behaviour change, and deserves its own reviewable diff. Nothing in this scope
changed that calculus. It is not a finding in `result.json` and is not remediated here.

## Validation commands

```bash
bun test                 # engine suite
bun test pi/             # pi suite
bunx tsc --noEmit        # error count must not exceed the pre-existing baseline (144)
```

Per `.claude/plans/2026-08-14-pr-remediation-r37.md`, `bunx tsc --noEmit` does not currently pass clean; the gate is that
the error count does not regress. `bun test` and `bun test pi/` must be fully green.
