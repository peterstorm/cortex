# PR Remediation Plan — r47

- **Date:** 2026-08-17
- **Branch:** `fix/llm-background-load-guardrails` (base HEAD `4b90dec`)
- **Review Run Directory:** `.claude/reviews/review-and-fix-runs/r47`
- **Authoritative result:** `result.json` (digest `75501b423fa1526ca7254e5b72bcece85fc6ec0de29ac80e830aa1cf6cc63cd9`), published atomically by the Refutation Panel tally (threshold 2/3 lenses; lenses: reproduction, intent, security).
- **Panel outcome:** 3 canonical criticals, **0 refuted**, 3 surviving. All three upheld by `reproduction` + `intent` (security: uncertain, no refutations).
- **Refuted-finding audit:** none — `refuted_critical_findings` is empty; nothing to retain as refuted.

## Scope

Reviewed scope (16 files, from `result.json.scope`):
`.claude/plans/2026-08-16-pr-remediation-r45.md`, `HOW-IT-WORKS.md`, `README.md`,
`engine/src/commands/ai-prune.test.ts`, `engine/src/commands/ai-prune.ts`,
`engine/src/commands/semantic-edges.test.ts`, `engine/src/commands/semantic-edges.ts`,
`engine/src/config.ts`, `engine/src/core/types.ts`,
`engine/src/infra/claude-llm.concurrency.test.ts`, `engine/src/infra/claude-llm.routing.test.ts`,
`engine/src/infra/claude-llm.ts`, `engine/src/infra/db.test.ts`, `engine/src/infra/db.ts`,
`pi/extension.test.ts`, `pi/extension.ts`

Support paths (registered in remediation start input):
- `.claude/plans/2026-08-17-pr-remediation-r47.md` (this plan)
- `engine/src/core/chunk.ts` (new shared file for code-simplifier-5)
- `pi/shutdown-policy.ts` (host for the `isCortexShutdownReason` guard, type-design-analyzer-8 — keeps the known-reason set co-located with the `CortexShutdownReason` type and the shutdown policy)

## Surviving criticals (ALL MANDATORY)

### C1 — `silent-failure-hunter-1` — db.ts:729 (LIKE-over-JSON file_path lookup)
`getActiveCodeMemoriesByFilePath` (db.ts:724) and `getActiveProseMemoriesByFilePath` (db.ts:746)
build `LIKE … ESCAPE '\'` patterns from the **raw** path while matching the
**JSON-serialized** `source_context` (written via `JSON.stringify`, core/types.ts `serializeSourceContext`).
A path containing `\` or `"` can never match (the unescaped backslash acts as a LIKE escape
introducer; the escaped quote matches one char where the data holds two) — verified in code and
reproduced on bun:sqlite by two independent reviewers (silent-failure-hunter; architecture-tech-lead,
who also showed the positive mis-match: query `C:\Users\x` matches stored `C:Usersx`).
Live caller: `index-code.ts:423-424` re-index supersede — `[]` is read as "no old versions", so
re-indexing inserts duplicate memories without superseding, silently.

**Fix (verified against code):** replace the LIKE pattern with `json_extract(source_context, '$.file_path') = ?`
— exact, parameterized, escape-free, parses at the query boundary (Parse Don't Validate);
`json_extract` returns NULL (no match, no throw) on malformed stored JSON. Consolidate the two
identical function bodies into one private helper parameterized by `memory_type`
(absorbs code-simplifier-2 and architecture-tech-lead-1). Keep both exported names
(caller `index-code.ts` is out of scope).

**Tests (db.test.ts — today there are ZERO for both functions):**
- plain path found; path with spaces found;
- path containing a double quote found (only its own row);
- path containing a backslash found (only its own row) — pins the exact-row contract;
- wrong path (including the `C:Usersx`-style collapsed form) does not match.

### C2 — `type-design-analyzer-1` — db.ts:533 (updateMemory coupling gap)
`updateMemory`'s three status/archived_at coupling guards (db.ts:534-553) all require
`fields.archived_at` to be present (or `status === 'active'`). A **status-only** update to
`'superseded'` on a row whose `archived_at` is non-NULL passes every guard; the dynamic UPDATE
never touches `archived_at`; the persisted pair `(superseded, anchor)` is exactly what
`createMemory` rejects on every read (core/types.ts:325-334), so `getMemory` and
`getMemoriesByIds(ids,'any')` throw (verified against code; reproduced by type-design-analyzer).
Current writers re-check `active` first, so it is latent — but the write boundary fails to enforce
the invariant its own docstring promises ("Maintains the status/archived_at coupling").

**Fix (verified against code):** add the mirror of the existing archived_at-only row-read guard
(db.ts:543-548): when the payload sets a status that cannot carry an anchor
(≠ `active`/`archived`/`pruned`) and omits `archived_at`, read the row's current anchor and
reject if non-NULL. `active` is excluded because it auto-clears the anchor (existing behavior,
pinned by db.test.ts:340); `archived`/`pruned` may legally carry an anchor. Existing guards and
their error messages are preserved (tests at db.test.ts:289/318/340/364 must pass unchanged).

**Tests (db.test.ts):**
- archive a memory, then `updateMemory(db, id, { status: 'superseded' })` → throws;
- control: supersede an active row (anchor NULL) → succeeds;
- control: reactivate an archived row (`{ status: 'active' }`) → succeeds, anchor cleared.

### C3 — `comment-analyzer-1` — claude-llm.ts:274 (orphaned JSDoc)
The "Max in-flight LLM calls per process…" block (claude-llm.ts:273-278) sits above
`envPositiveInt` (line 283, which has its own doc block) instead of its subject
`maxConcurrentLlmCalls` (line 290, undocumented). Residue of the r45 `envPositiveInt` extraction.
Verified in code. Absorbs code-simplifier-14 (same block, same move).

**Fix:** move the block to directly above `maxConcurrentLlmCalls`. No behavior change.

## Advisory dispositions (31 total: 27 accepted, 3 deferred, 1 dismissed)

### Accepted (fixed this round)

| ID | Location | Fix |
|---|---|---|
| silent-failure-hunter-2 | db.ts:430 | Guard `JSON.parse(row.tags)` in `rowToMemory`: on parse failure or non-array, `console.warn` with `memory.id` and fall back to `[]` (mirrors the embedding corrupt-row precedent, db.ts:826/965, "#9"). Test: corrupt tags cell → row readable, warn emitted, tags `[]`. |
| silent-failure-hunter-3 | db.ts:1179/1271 | Add the stderr warn the sibling mappers already emit for invalid `relation_type` — implemented inside the shared mapper (folded into type-design-analyzer-2). |
| pr-test-analyzer-1 | semantic-edges.ts:152 | Test the unparseable-`last_failed_at` (NaN) branch: seed `last_failed_at='not-a-date'` with matched hash → edge is re-asked (pins the fail-safe direction). |
| pr-test-analyzer-2 | claude-llm.ts:398 | Test the real `runLlmPromptDirectUnbounded` fallback return: stub `Bun.spawn` (following the `Bun.which` stub idiom in the concurrency tests) with the endpoint unconfigured → returned `{ direct: false }`. |
| pr-test-analyzer-3 | pi/extension.ts:177 | Happy-path test for `before_agent_start`: surface content + prompt-recall output joined into returned `message.content`, resolved plugin root in `systemPrompt` (follows the existing fake-`ExtensionAPI`/handlers pattern in extension.test.ts). |
| pr-test-analyzer-4 | claude-llm.ts:323 | Pin `CORTEX_LLM_MAX_DIRECT_FAILURES` invalid values (`'0'`, `'abc'`) → fallback 3, closing the `envPositiveInt` contract table. |
| type-design-analyzer-2 | db.ts:1269 | Consolidate all four edge read paths (`getEdgesForMemory`, `getAllEdges`, `getRelatesToEdges`, `getRelatesToEdgesWithMemories`) on one shared row→`createEdge` mapper (the r44 root-cause duplication). Behavior-identical except the two silent drops gain the warn (silent-failure-hunter-3). |
| type-design-analyzer-5 | types.ts:381 | `createEdge`: non-empty validation of `id`/`source_id`/`target_id` mirroring `createMemory` (SQLite NOT NULL does not reject empty strings). |
| type-design-analyzer-7 | db.ts:388/653 | Memory read paths cast to the existing `MemoryRow`/`MemoryRow[]` instead of `any` (19 sites) — one stated trust level per row kind in the file (absorbs code-simplifier-12). |
| type-design-analyzer-8 | pi/extension.ts:248 | Replace the laundered `event.reason as CortexShutdownReason` cast with a runtime known-reason check: unknown future pi reasons skip the pipeline (fail-closed, matching the policy's intent) and emit a bounded stderr diagnostic. The guard lives in `pi/shutdown-policy.ts` (`isCortexShutdownReason`, registered support path) so the known-reason set stays in one place with the type it guards; `extension.ts` fails closed on the check. |
| comment-analyzer-2 | db.ts:999 | `insertEdge` `@param` doc: note the optional `classified_at`/`classify_hash`/`last_failed_at` the function persists. |
| comment-analyzer-3 | semantic-edges.ts:14 | Header flow step 2: "Load source/target memories in a single JOIN" (matches `getRelatesToEdgesWithMemories` and the body comment at :217-218). |
| comment-analyzer-4 | claude-llm.ts:177 | `runLlmPrompt` `@throws`: add "empty response" (thrown at :240); same gap in `extractMemories` `@throws` (:411, omission flagged by the same reviewer) also noted. |
| architecture-tech-lead-1 | db.ts:724 | Same defect, same fix as C1 — resolved by C1 (`json_extract` + path tests). |
| code-simplifier-1 | db.ts:845 | One pure `buildFts5Query(tokens, joiner)`; `searchByKeyword` delegates to `searchByKeywordWithJoiner`; `searchEntities` uses the shared builder. Injection-quoting rule lives in one place; behavior identical (empty-token handling preserved). |
| code-simplifier-2 | db.ts:724/746 | Resolved by C1 (single private helper parameterized by `memory_type`). |
| code-simplifier-3 | db.ts:809/946 | One `collectMemoriesWithEmbeddings(rows)` helper for the duplicated row loop (`rowToMemory`, null-embedding guard, warn, push). |
| code-simplifier-4 | db.ts:1702/1723/1758 | One `rowToEntity` helper for the triplicated 6-field mapping (consistent with `rowToMemory`/`edgeRowsToEdges` precedent). |
| code-simplifier-5 | ai-prune.ts:317 / semantic-edges.ts:64 | One shared chunk helper in new `engine/src/core/chunk.ts` (registered support path); both commands import it. |
| code-simplifier-6 | claude-llm.ts:584/626 | Shared `unwrapEdgesArray(parsed)` and `normalizeClassifications(valid)` for strict/tolerant modes; the strict/tolerant distinction reduces to the error channel. |
| code-simplifier-7 | claude-llm.ts:251/330/356 | Named `DirectLlmOptions` type referenced in `LlmPromptTransport`, `runLlmPromptDirect`, `runLlmPromptDirectUnbounded` (zero signature change). |
| code-simplifier-8 | config.ts:20 | `getPluginRoot`: factor the `typeof Bun` env ternary into one `const env`, matching `detectHarness`. |
| code-simplifier-9 | types.ts:211 | Delete unused `StopHookInput` export (verified: zero importers repo-wide). |
| code-simplifier-10 | pi/extension.ts:129 | Inline `getSurfacePath` pass-through at its single call site (verified: no test references the name). |
| code-simplifier-11 | db.test.ts:72 | File-local `makeMemory(id, overrides)` factory (mirrors `ai-prune.test.ts:49` and this file's `seedMemory`); convert all 39 `createMemory({…})` call sites; new r47 tests use it. |
| code-simplifier-13 | claude-llm.ts:106, db.ts:1543-44 | Hoist inline `require('fs')` / `require('node:os')` / `require('node:path')` to top-level imports (node builtins; zero behavior change). |
| code-simplifier-14 | claude-llm.ts:275 | Same block, same fix as C3 — resolved by C3. |

### Deferred (concrete evidence-based reasons)

| ID | Location | Reason |
|---|---|---|
| type-design-analyzer-3 | types.ts:12 | Wiring `MemoryId`/`EdgeId`/`LocalEmbedding` brands through the `Memory`/`Edge` interfaces and every db/CLI/commands signature is a caller-visible API change spanning the entire reviewed scope plus out-of-scope consumers (`cli.ts`, `commands/`); it needs its own design pass for where brands cross the DB boundary. Not a complete fix practical inside this remediation. |
| type-design-analyzer-4 | types.ts:265 | Enforcing `source_context` parse-in-`createMemory` converts legacy malformed rows from readable to throwing on **every read** — a data-compatibility decision (audit/migration) this round cannot make safely. The consumer defect the advisory cites (LIKE lookup stops matching malformed JSON) is fixed by C1, and `json_extract` returns NULL (no match, no throw) on malformed JSON. |
| type-design-analyzer-6 | ai-prune.ts:39 | Converting `AiPruneResult` to a discriminated union is a caller-visible result-type change consumed out of scope (`cli.ts` surface rendering); a separate coordinated signature change. No in-scope defect hinges on it. |

### Dismissed

| ID | Location | Reason |
|---|---|---|
| code-simplifier-12 | db.ts:653 | Exact duplicate of type-design-analyzer-7 (same file, same 19 `as any` casts, same `MemoryRow` remedy) — one accepted fix covers both. |

## Validation

1. `cd engine && bunx tsc --noEmit` — zero net-new errors vs the pre-remediation baseline (known pre-existing errors: `bun:sqlite`/`Bun` type gaps; compare against base worktree).
2. `cd engine && bun test` — full engine suite (baseline 149 pass in scope + all other engine tests) must pass; new r47 regression tests included.
3. `cd pi && bun test` (or repo test script) — pi extension suite including the new `before_agent_start` happy-path and shutdown-unknown-reason tests.
4. Behavioral spot-checks pinned by tests, not assumed: json_extract exact-row matching (C1), updateMemory rejection (C2), JSDoc position (C3 — visual + tsc).
