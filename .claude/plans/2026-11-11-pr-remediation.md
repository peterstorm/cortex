# PR #24 remediation plan (2026-11-11)

Branch: `feat/repo-scoped-project-db` (PR #24, base `main`). PR #23
(`feat/shared-global-db`) was folded into #24 and closed; #24 carries all of
its commits.

## Scope and review runs

The combined diff (41 files, about 290 KB) is larger than one registered
review may read, so it was reviewed as two exact scopes, each by the full
seven-reviewer roster. Runs root: `.claude/reviews/review-and-fix-runs/`.

| Run | Scope | Emitted/admitted | After refutation |
| --- | --- | --- | --- |
| `pr24-eval` | 15 files: the eval harness (`commands/eval*.ts`, `core/eval-*.ts`, `infra/llm-client*`, `commands/read-admission.test.ts`, `commands/eval.md`) | 0 critical, 12 advisory | 0 surviving critical, 0 refuted, 12 advisory |
| `pr24-db` | 26 files: the shared global database, the repository-scoped project database, CLI wiring and docs | 0 critical, 18 advisory | 0 surviving critical, 0 refuted, 18 advisory |

In `pr24-db`, the first `silent-failure-hunter` attempt was rejected by the
engine for incomplete read coverage and reissued; the second attempt is the
one in the canonical result.

## Surviving criticals, repair groups, checks

None in either run. No Declared Repair Group, no sibling disposition, no
selected check ID and no Historical RED declaration apply. The remediation
start input declares `defectFamily: {"kind": "not-required"}`.

## Refuted-finding audit

No critical finding was emitted, so no Refutation Panel ran and nothing was
refuted.

## Advisory dispositions (DECLARED)

Published immediately after triage, before any edit:

| Policy run | Source | Publication digest |
| --- | --- | --- |
| `pr24-eval-policy` | `pr24-eval` | `907106f636c67ce4dcee831b0ca5e8bca413810fe802f50b081c11348df48fef` (initial revision) |
| `pr24-db-policy` | `pr24-db` | `48244db8c0279dffe6961fc3f5b27ef13910cfce7b3086a62a5827bee77b2f42` (initial revision) |

### `pr24-eval` (12 accepted)

| Finding | Decision | Reason and fix |
| --- | --- | --- |
| silent-failure-hunter-1 | accepted | `openSnapshot` only checked that the file existed. It now takes the manifest's sources and throws when a recorded global source has no snapshot file. |
| silent-failure-hunter-2 | accepted | The keyword fallback was invisible to a run. Every answer records the recall path behind its context, and the report flags runs with keyword-fallback answers. |
| pr-test-analyzer-1 | accepted | A torn final line made a run unreadable and the next append would have glued onto it. An unterminated tail is dropped on read and repaired before appending. |
| type-design-analyzer-1 | accepted | `parseManifest` accepted a condition that contradicts `memory.kind`. The condition is now derived from the memory and cross-checked at the parse boundary. |
| comment-analyzer-1 | accepted | The default eval directory is `<cwd>/.memory/eval`. Header comment, `commands/eval.md` and README corrected. |
| architecture-tech-lead-1 | accepted | The reuse rule (`planCase`) and the run identity (`planRun`, `startManifest`) take no I/O. Moved to the pure core with direct and property tests; hashing and file writes stay in the shell. |
| architecture-tech-lead-2 | accepted | Same defect as silent-failure-hunter-2, plus a handle leak: `MemoryContext` returns the context with its recall path, and the snapshot databases are closed when composing the surface throws. |
| architecture-tech-lead-3 | accepted | `MemoryAdmission` moves to `core/admission.ts`. The eval keeps calling `composeSurface` and prompt recall on purpose: it measures the reads the hooks really make. |
| code-simplifier-1 | accepted | `caseToRow` had no production caller. It is now the round-trip helper in `eval-set.test.ts`. |
| code-simplifier-2 | accepted | One `parseJsonObject` defines "expected a JSON object" for both parsers. |
| code-simplifier-3 | accepted | The repeated options literal and try/finally in `eval-adapters.test.ts` collapse into one helper; no assertion changed. |
| code-simplifier-4 | accepted | Absent summaries map to `null` at the call site, so report cells take `number | null` only. |

### `pr24-db` (15 accepted, 2 dismissed, 1 deferred)

| Finding | Decision | Reason and fix |
| --- | --- | --- |
| silent-failure-hunter-1 | accepted | A git timeout or refusal silently re-rooted the project at the session directory. Only "not a git repository" and a missing git binary are the quiet fallback; anything else logs a WARN naming the cause. |
| pr-test-analyzer-1 | accepted | New end-to-end case: `remember` and `load-surface` from a linked-worktree subdirectory, asserting where the database, cache, locks and surface land. `extract` needs an LLM, so its project wiring became a required parameter instead. |
| pr-test-analyzer-2 | accepted | `migrateProjectDb` tests for a held `merge.lock` (busy) and an unreadable stray among several (earlier merged, failed one left in place). |
| pr-test-analyzer-3 | dismissed | Already covered by `commands/read-admission.test.ts` in the same PR (the other review slice): the semantic, strict-AND and degraded keyword paths each skip a refused memory. |
| pr-test-analyzer-4 | accepted | Added the mixed case: one admitted and one refused fact on the same entity. |
| type-design-analyzer-1 | dismissed | `locateProject` is the only producer and its property tests pin root and strays per scope. Every consumer reads the same fields, so a per-scope union would add a match at each call site and remove no branch. |
| type-design-analyzer-2 | accepted | An omitted root silently recreated the per-directory split. `GenerateOptions.root` and `executeExtract`'s project are required. |
| type-design-analyzer-3 | accepted | The precedence order is stated on `ProjectLocation.strays`, where it is produced. |
| comment-analyzer-1 | accepted | The `project-db.ts` header names the per-prompt recall hook as the exception. |
| comment-analyzer-2 | accepted | The engine README table separates the session directory (surface file) from the repository root (database, cache, locks, telemetry). |
| architecture-tech-lead-1 | deferred | A project-session module would change the interface of about fifteen handlers: an interface redesign for a `deepen` session, not a remediation. Behaviour is correct today and the reviewer names no failing path. |
| architecture-tech-lead-2 | accepted | Root is required in generate and extract, and commands that take the project root name the parameter `projectRoot`. A branded type is not adopted: the required parameters already make the omission a compile error. |
| architecture-tech-lead-3 | accepted | The decisions in the eval handlers (answer summary and failure wording, which runs get a judge-agreement table) are pure functions in `commands/eval.ts` with unit tests. Port wiring stays in `cli.ts`. |
| architecture-tech-lead-4 | accepted | `MemoryAdmission` and `admitAll` live in `core/admission.ts`. |
| code-simplifier-1 | accepted | `getGlobalDbPath` had no production caller and invited opening the global path without the legacy merge. Deleted. |
| code-simplifier-2 | accepted | Both prompt-recall sites use the shared `admitAll`. |
| code-simplifier-3 | accepted | `composeSurface` calls `admit` once per memory. |
| code-simplifier-4 | accepted | One helper derives the directories from the session up to its checkout top. |

## Fixes outside the canonical findings

- **`db-merge.ts` copy statement.** The rejected first `silent-failure-hunter`
  attempt in `pr24-db` noted that `INSERT OR IGNORE` also swallows NOT NULL and
  CHECK failures, so a row the target refuses for a reason other than a key
  clash was counted as "already present" and its only copy moved aside. It is
  not in the canonical result. I verified it against SQLite's conflict rules and
  fixed it: the statement is `INSERT ... ON CONFLICT DO NOTHING`, which ignores
  key clashes only. A regression test merges a fact whose entity is gone.
- **`classifyProbeFailure` is total.** The property test written for
  silent-failure-hunter-1 found that stringifying an odd thrown value could
  itself throw inside the catch block. It no longer does.
- **`remember.test.ts`.** Two cache-invalidation tests passed the old `cwd`
  option name; they follow the rename to `projectRoot`.

## Validation commands

Run from `engine/`:

- `bun run test`: 1497 pass, 1 fail. The failure is
  `local-embed > caching behavior > reuses loaded model for multiple embeddings`,
  which needs a `libstdc++` this machine does not have; it fails the same way on
  `main`. Before the remediation the count was 1436 pass, 1 fail.
- `bunx tsc --noEmit -p .`: 95 errors, the same count as before the
  remediation. None is in code this remediation adds.

These development runs are DECLARED by the parent. No critical survived, so the
engine observes no repair check.

## Registered remediation

One run, sourced at `pr24-db`. The two slices share code (`core/admission.ts`,
`generate.ts`, `prompt-recall.ts`, `cli.ts`), so their fixes cannot be
installed apart without hand-staging. Every touched path outside `pr24-db`'s
frozen scope, including the `pr24-eval` files and this plan, is named as a
support path at start.
