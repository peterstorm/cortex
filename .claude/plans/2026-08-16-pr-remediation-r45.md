# PR Remediation — r45 standalone review (speed/efficiency focus)

Date: 2026-08-16
Branch: `fix/llm-background-load-guardrails` (HEAD `1ea0438`, base `8f88663` vs `origin/main`)
Review Run Directory: `.claude/reviews/review-and-fix-runs/r45` (kind `simplify`;
reviewers: code-reviewer, architecture-tech-lead, code-simplifier)
Canonical result: `r45/result.json` (digest `378f09b4…`)

## Scope

The 15 frozen branch files (same scope r44 reviewed; worktree clean, byte-identical to HEAD):
HOW-IT-WORKS.md, README.md, engine/src/commands/ai-prune{.test,}.ts,
engine/src/commands/semantic-edges{.test,}.ts, engine/src/config.ts,
engine/src/core/types.ts, engine/src/infra/claude-llm{.ts,.concurrency.test.ts,.routing.test.ts},
engine/src/infra/db{.test,}.ts, pi/extension{.test,}.ts

## Carried critical (from dead run r44 — mandatory fix)

r44 dead-ended in its refutation panel before the loom fix
(`07e94b0` in loom: parser tolerance + durable blocked state). Its evidence is
durable in `r44/`:

- **`standalone-review:code-simplifier-1`** (critical, upheld 2/2 by the
  parseable lenses — reproduction + blast-radius; the third transcript,
  intent lens, was unparseable but substantively also concluded upheld):
  `engine/src/infra/db.ts:1269` — `edgeRowsToEdges` omits `last_failed_at`
  when building `Edge`, so `getRelatesToEdges` reports never-failed (`null`)
  for edges with a recorded failure. All three sibling read paths
  (`getEdgesForMemory`, `getAllEdges`, `getRelatesToEdgesWithMemories`)
  round-trip the field; the `null` is a documented, load-bearing assertion
  ("null when never failed"). The column is new on this branch, so this is
  the branch's own divergence. Zero production callers today
  (`getRelatesToEdgesWithMemories` is the live path) — a contract fix on an
  exported API, not a live-behavior change.
- **Fix**: pass `last_failed_at: (row.last_failed_at ?? null) as string | null`
  in `edgeRowsToEdges` (mirrors the sibling mappers exactly).
- **Regression test** (db.test.ts): seed edge → `markEdgeFailed` →
  `getRelatesToEdges` returns the recorded `last_failed_at` (and
  `classified_at` null) → `markEdgeClassified` → `last_failed_at` clears to
  null. Pins the read contract so the mapper can never silently drop the
  column again.

Not re-surfaced in r45 (code-simplifier roll variance — r45's simplifier
advisories are a different set), but the code is unchanged and the finding
remains verified; fixing it here avoids burning another full review cycle.

## r45 findings — adjudication

Surviving criticals: **0**. Refuted criticals: **0** (no refutation panel
was needed in r45). Advisories: **8** (all accepted; two of them are one fix).

| ID | Disposition | Fix |
|---|---|---|
| code-reviewer-1 (README.md:406) | **accepted** | Replace the two deleted-constant rows (`AI_PRUNE_SESSION_INTERVAL`, `AI_PRUNE_MEMORY_THRESHOLD`) with the four live watermark constants from config.ts (20 / 7d / 6h / 8) |
| code-reviewer-2 (README.md:193) | **accepted** | External Services row: retired `EmbeddingGemma-300M ONNX 768-dim` → live `minishlab/potion-retrieval-32M`, 512-dim static (model2vec) |
| architecture-tech-lead-1 (README.md:193) | **accepted (duplicate of code-reviewer-2)** | Same one-line fix resolves both; claims differ in wording, so the engine kept them as two findings |
| code-simplifier-1 (claude-llm.ts:246) | **accepted** | Move the orphaned "Run a prompt through the LLM" JSDoc from above `LlmPromptTransport` to `runLlmPromptDirectUnbounded` (the function it describes; the `direct`-flag paragraph belongs there) |
| code-simplifier-2 (claude-llm.ts:289/326) | **accepted** | Extract one `envPositiveInt(env, name, fallback)` helper; `maxConcurrentLlmCalls` and `getDirectFailureFallbackThreshold` become one-liners with identical behavior (non-integer or <1 → fallback) |
| code-simplifier-3 (semantic-edges.ts:245/305) | **accepted** | Extract a local `recordBatchFailure(batchPairs)` (markEdgeFailed loop + `failed += length`); the unparseable branch and the catch block call it — the two retry-safety paths can no longer diverge |
| code-simplifier-4 (semantic-edges.ts:134) | **accepted** | Spell the rows type as the exported `EdgeWithMemories[]` instead of `readonly ReturnType<typeof getRelatesToEdgesWithMemories>[number][]` |
| code-simplifier-5 (semantic-edges.ts:136) | **accepted** | Make `now: Date` required (matching siblings `shouldRunAiPrune`/`isTooYoungToArchive`); pass `new Date()` at the one production call site and at the 8 db.test.ts call sites (explicit clock, behavior-preserving) |

Deferred/dismissed: none. Every r45 advisory has a concrete, in-scope,
low-risk fix.

## Refuted-findings audit

None in r45 (no critical set → no panel). r44's panel: 2 upheld, 0 refuted
(third lens unparseable — see carried critical above). Nothing to audit as
refuted.

## Validation commands

1. `bun test engine/src/infra/db.test.ts engine/src/infra/claude-llm.concurrency.test.ts engine/src/infra/claude-llm.routing.test.ts engine/src/commands/semantic-edges.test.ts engine/src/commands/ai-prune.test.ts pi/extension.test.ts` (the 6 in-scope test files; r44/r45 reviewers confirmed 148 pass / 0 fail at HEAD — must stay green, plus the new regression test)
2. `bunx tsc --noEmit` — no NEW errors vs the pre-existing `bun:sqlite`/`Bun` type-gap baseline (Bun builds are the executable gates on this branch)

## Out of scope (noted, not fixed)

- r44 advisory `code-simplifier-5` (triplicated inline options type + `direct`
  parameter-name collision in claude-llm.ts): not re-surfaced in r45; the
  parameter rename has a wider API surface than this round warrants.
- architecture-tech-lead's sub-threshold notes (dead `getRelatesToEdges`
  mapper landmine — resolved by the carried critical's fix; `loadGeminiEnv`
  machine-specific sops-nix path — accepted personal-infrastructure
  accommodation, inert elsewhere).
- The 0.65-vs-0.45 cosine-floor question (recall implementation is outside
  the frozen scope; flagged for a separate verification, not a branch defect).
