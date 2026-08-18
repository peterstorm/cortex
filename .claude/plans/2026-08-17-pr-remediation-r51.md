# PR Remediation — r51 standalone review

Date: 2026-08-17
Branch: `fix/llm-background-load-guardrails` (HEAD `e1b26f3`, base `8f88663` vs `origin/main`)
Review Run Directory: `.claude/reviews/review-and-fix-runs/r51` (kind `all`; reviewers:
code-reviewer, silent-failure-hunter, pr-test-analyzer, type-design-analyzer,
comment-analyzer, architecture-tech-lead, code-simplifier)
Canonical result: `r51/result.json` (digest `e7c88f10…`, 24110 bytes)
Refutation panel: 3 lenses (reproduction, intent, test-coverage) × 9 criticals — **9 upheld, 0 refuted**

## Scope

The 19 frozen branch files, verified byte-identical to the working tree at HEAD:

```
.claude/plans/2026-08-16-pr-remediation-r45.md
.claude/plans/2026-08-17-pr-remediation-r47.md
HOW-IT-WORKS.md
README.md
engine/src/commands/ai-prune.ts            engine/src/commands/ai-prune.test.ts
engine/src/commands/semantic-edges.ts      engine/src/commands/semantic-edges.test.ts
engine/src/config.ts
engine/src/core/chunk.ts
engine/src/core/types.ts
engine/src/infra/claude-llm.ts             engine/src/infra/claude-llm.concurrency.test.ts
engine/src/infra/claude-llm.routing.test.ts
engine/src/infra/db.ts                     engine/src/infra/db.test.ts
pi/extension.ts                            pi/extension.test.ts
pi/shutdown-policy.ts
```

## Refuted critical findings

None. Every one of the 9 surviving criticals was attacked by all three panel lenses
and upheld by all three. There is no refuted-finding audit for this round.

## Surviving critical findings (9 IDs → 4 distinct defects)

The 9 IDs are the marker-line and structured-block representations of 4 distinct
defects; each fix below closes every ID listed against it.

### C1 — `pi/extension.test.ts:9` reintroduces `vi.hoisted`, zeroing the whole file
IDs: `silent-failure-hunter-1`, `silent-failure-hunter-3`, `pr-test-analyzer-1`, `pr-test-analyzer-4`

`vi.hoisted` is a vitest-only API. `pi/` has no `package.json`, no `node_modules`, and no
vitest install; `engine/vitest.config.ts` is engine-rooted and never collects `../pi`;
`engine/package.json`'s test script is `bun test`. So `bun test` is the only runner for this
file, and bun's vitest shim has no `hoisted` — the file dies at import with
`TypeError: vi.hoisted is not a function`, dropping all 11 `it()` cases (including the
ephemeral-session no-worker regression and the `isCortexShutdownReason` fail-closed
integration this branch added). Commit `153e032` fixed exactly this; `e1b26f3` reverted it.

**Fix:** restore the plain top-level object form `153e032` established, and replace the
misleading "must come from vi.hoisted" comment with one that records why it must NOT
(`bun`'s `vi` has no `.hoisted`), so this cannot re-enter a third time.

### C2 — `engine/src/core/chunk.ts:12` has no invariant on `size`
IDs: `type-design-analyzer-1`, `type-design-analyzer-5`

`for (let i = 0; i < arr.length; i += size)` never advances for `size <= 0`; the loop pushes
`arr.slice(i, i)` forever until OOM. `chunk` is an exported general-purpose core helper with
no guard, no documented precondition, and no test file at all. Current call sites
(`BATCH_SIZE = 10`, `AI_PRUNE_BATCH_SIZE = 80`) are safe literals; the next caller deriving a
size from config or a CLI argument is not.

**Fix:** reject non-integer and non-positive `size` with a thrown `Error`, document the
precondition, and add `engine/src/core/chunk.test.ts` pinning the guard plus the normal
chunking behaviour.

### C3 — `engine/src/infra/db.ts:417` tags guard does not warn on valid non-array JSON
IDs: `comment-analyzer-1`, `comment-analyzer-2`

The comment states the precedent it follows is "warn-with-row-identity and continue (see
the local_embedding guard in `collectMemoriesWithEmbeddings`)", and that guard warns
unconditionally. The tags code warns only inside the `catch`, so a cell holding valid
non-array JSON (`5`, `null`, `{}`) takes the `Array.isArray` false path and silently yields
`[]`. This also falls short of the r47 plan's own spec for `silent-failure-hunter-2`
("on parse failure or non-array … `console.warn` … and fall back to `[]`") — only the
parse-failure half landed. The single existing test (`db.test.ts:320`, input `'not-json'`)
exercises only the throwing branch.

**Fix:** warn on the non-array branch too, with the memory id and the offending shape, so
code and comment agree. Add a `db.test.ts` regression for valid-but-non-array tags.

### C4 — `rowToEntity`'s unguarded `JSON.parse(row.aliases)` aborts every entity read
IDs: `architecture-tech-lead-1` (and advisories `silent-failure-hunter-2`, `silent-failure-hunter-4`)

`db.ts:1752` parses `aliases` with no try/catch, while its own docstring claims "the same
convention as `rowToMemory` and the edge mappers". `rowToEntity` backs `getEntityByName`,
`searchEntities`, and `getAllEntities`, so one corrupt cell throws a context-free
`SyntaxError` out of all three. `db.test.ts` contains zero `aliases` references.

**Fix:** mirror the (now-complete) `rowToMemory` guard — warn with the entity id on parse
failure or non-array, fall back to `[]`. Add `db.test.ts` regressions for both corruption
shapes across the three read paths.

## Advisory dispositions

All 15 advisory IDs (10 distinct claims) are **accepted**. None deferred, none dismissed.

| ID(s) | Claim | Disposition |
|---|---|---|
| `silent-failure-hunter-2`, `-4` | `rowToEntity` aliases unguarded | **accepted** — same defect as C4; closed by that fix |
| `pr-test-analyzer-2`, `-5` | `createEdge` empty-string guards untested | **accepted** — mirror the tested `createMemory` guards |
| `pr-test-analyzer-3` | AI-prune cross-DB watermark summation untested; `countActiveMemoriesCreatedAfter` has no boundary test | **accepted** |
| `type-design-analyzer-2`, `-6` | status/`archived_at` coupling lives in scattered I/O-bound guards | **accepted, with a stated deviation** (see below) |
| `type-design-analyzer-3`, `-7` | `rowToEdge` maps untyped `Record<string, unknown>` unlike `MemoryRow` | **accepted** — introduce `EdgeRow` |
| `type-design-analyzer-4`, `-8` | `s_memory_type`/`t_memory_type` cast unvalidated | **accepted** — validate like `relation_type` |
| `architecture-tech-lead-2` | `LlmPromptTransport` seam never threaded to real callers | **accepted** — thread through both commands, drop the module mocks |
| `architecture-tech-lead-3` | pure join logic inlined in the batch worker; `unique constraint` string-sniffing | **accepted** — extract a pure joiner, prefer the SQLite error code |
| `code-simplifier-1` | duplicated `Bun.which` stub-and-restore across 5 tests | **accepted** — shared helper |
| `code-simplifier-2` | inlined `pairContentHash` literals coupled to `seedMemory` | **accepted** — shared helper |

### Stated deviation on `type-design-analyzer-2` / `-6`

The advisory proposes a discriminated union
(`{status:'active'|'superseded'; archived_at:null} | {status:'archived'|'pruned'; archived_at:string|null}`).
That specific remedy does **not** close the defect surface it names, for a concrete reason:
`updateMemory` takes `Partial<Memory>` patches, and a partial over that union cannot express
`{ status: 'archived' }` on its own — every real caller passes exactly such a patch. The union
would therefore leave all four runtime guards in place, and it protects raw-SQL backfill paths
(the advisory's stated risk) not at all, since those bypass TypeScript entirely. Every read
path already funnels through `createMemory`, which enforces the coupling today.

What *is* in reach, and is what this plan implements, is the substance of the complaint —
the coupling logic scattered across four order-dependent guards with two extra `SELECT`
round-trips: extract it into a pure `resolveArchiveAnchor(current, patch)` function in
`engine/src/core/types.ts`, fed by **one** row read instead of two, returning either a
rejection reason or the resolved patch. The invariant then lives in one named, directly
unit-tested place in the functional core, and `updateMemory` becomes load → pure decide →
persist. Behaviour is preserved exactly, including every existing error message.

## Accepted advisory fixes

1. **`EdgeRow`** (`db.ts`) — declare the raw edges-row shape mirroring `MemoryRow`; type
   `rowToEdge`/`edgeRowsToEdges` and the four `stmt.all()` call sites against it, dropping the
   `as unknown as Array<Record<string, unknown>>` double-casts.
2. **Endpoint `memory_type` validation** (`db.ts:getRelatesToEdgesWithMemories`) — validate
   `s_memory_type`/`t_memory_type` with `isMemoryType`, warn-and-drop the row like the sibling
   `relation_type` guard, and correct the `EdgeEndpointMemory` docstring that wrongly claims
   the values are `createMemory`-validated on this JOIN path.
3. **`resolveArchiveAnchor`** (`core/types.ts`, `db.ts:updateMemory`) — as described above.
4. **Transport seam threaded** (`semantic-edges.ts`, `ai-prune.ts`, both test files) — add an
   optional `LlmPromptTransport` to `executeSemanticEdges`'s options and to `runAiPrune`/
   `runAiPruneIfNeeded`, default `runLlmPromptDirect`, pass it down to `classifyEdges` /
   `callClaudePrune`; replace `vi.mock('../infra/claude-llm.js', …)` and
   `vi.mock('../infra/llm-client.js', …)` in both command test suites with plain fakes.
5. **`joinClassificationsToPairs`** (`semantic-edges.ts`) — extract the pure classification→pair
   join and its duplicate/out-of-range/mixed-mode validation into an exported pure function
   returning a discriminated result; unit-test it directly.
6. **Typed unique-constraint check** (`semantic-edges.ts`) — prefer the `bun:sqlite` error
   `code` (`SQLITE_CONSTRAINT_UNIQUE`/`SQLITE_CONSTRAINT_PRIMARYKEY`) and keep the message
   regex only as a documented fallback.
7. **`withBunWhichUnavailable`** — shared test helper in a new
   `engine/src/infra/llm-test-helpers.ts`, used by the 5 duplicated blocks.
8. **`matchingContentHash`** (`semantic-edges.test.ts`) — helper mirroring `seedMemory`'s
   content template, replacing the 3 inlined `pairContentHash` literals.
9. **`createEdge` guard tests** (`core/types.test.ts`) — empty/whitespace `id`, `source_id`,
   `target_id`.
10. **Watermark tests** (`db.test.ts`, `ai-prune.test.ts`) — direct
    `countActiveMemoriesCreatedAfter` boundary test (strictly-after, archived excluded) plus a
    `runAiPruneIfNeeded` case with new memories in *both* databases.

## Validation commands

1. `cd engine && bun test` — full engine suite (must be green).
2. `cd pi && bun test` — pi suite; `extension.test.ts` must report its full `it()` count
   executing, not a load error. This is the gate C1 exists for.
3. `cd engine && bunx tsc --noEmit` — compared against the pre-existing baseline only
   (`bun:sqlite`/`Bun` ambient gaps and `db.test.ts` `require()`-typed params predate this
   branch); no new errors permitted.

## Support paths (not in the reviewed scope)

- `.claude/plans/2026-08-17-pr-remediation-r51.md` (this plan)
- `engine/src/core/chunk.test.ts` (new regression file for C2)
- `engine/src/core/types.test.ts` (existing; gains `createEdge` and `resolveArchiveAnchor` tests)
- `engine/src/infra/llm-test-helpers.ts` (new shared test helper)
