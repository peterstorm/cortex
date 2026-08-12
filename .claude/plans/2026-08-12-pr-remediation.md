# 2026-08-12 Cortex PR Remediation

## Context

- **Branch:** `perf/semantic-edges-direct-llm` (PR #15, stacked on #14 `fix/review-findings-0.2.0`)
- **Review Run:** `.claude/reviews/review-and-fix-runs/v16` (76 files, 6-agent cohort, 3-lens refutation panel)
- **Adjudication (result.json, tally-published):** 11 surviving criticals, 34 advisories, **0 refuted**
- **Validation:** `bun test` (engine) + scoped `bunx tsc --noEmit`

## Surviving critical findings → fixes

| # | Finding | Fix |
|---|---------|-----|
| C1 | hunter-1/-6: strict JSON parsing applied to subprocess-fallback responses (claude-llm.ts:294) | `runLlmPromptDirect` returns `{ text, direct }`; strict parse only when `direct`; tolerant parse otherwise |
| C2 | hunter-2: replace-edge catch swallows DB error; conflicted edge re-asked forever (semantic-edges.ts:240) | Log error with edge/pair/relation; on unique-constraint conflict mark edge classified (retirement) so re-ask loop terminates |
| C3 | pta-1/-6: `executeSemanticEdges` has zero tests | New `engine/src/commands/semantic-edges.test.ts` (mocked `classifyEdges`, in-memory DB): declined marking, typed replacement, batch failure, lock-skip, no-LLM guard |
| C4 | pta-2/-7: `llm-client.ts` has zero tests | New `engine/src/infra/llm-client.test.ts` (env override + fixture HOME + stubbed fetch): resolution precedence, NON_OPENAI_APIS filter, baseUrl normalization, `!command` key, body construction, error paths |
| C5 | tda-1: false "schema CHECK constraints" comment (db.ts:336) | Correct the comment to state application-level enforcement |
| C6 | tda-2: `updateMemory` persists unvalidated enum/range fields (db.ts:444) | Validate `memory_type`/`status`/`scope`/`confidence`/`priority` before write (mirrors createMemory) |
| C7 | comment-1: HOW-IT-WORKS.md:170 documents CLI-only LLM path | Rewrite: direct OpenAI-compatible endpoint first, CLI fallback, `CORTEX_LLM_API_*` env vars |
| C8 | comment-2: `ARCHIVE_THRESHOLD_DAYS` dead constant documents 7d, runtime is 14d (config.ts:192) | Delete the dead constant; align comment with the running 14-day behavior |

## Accepted advisories

- A01/A03 extract.ts availability gate must accept the direct endpoint (same family as C1)
- A02/A04/A08/A11/A33 duplicates of C1 — covered by C1
- A05 strict-mode item filter silently drops invalid entries → log dropped count
- A06 endpoint resolution fails silently → one-line WARN when user-visible config is rejected
- A07 `finish_reason` discarded → truncation error names `max_tokens`/`finish_reason=length`
- A09/A12 strict-mode `{"edges":[...]}` shape + invalid-entry tests → added to claude-llm.test.ts
- A10/A13 unreachable "missing endpoint memory" diagnostics → simplify branch; drop unused `skipped` const
- A19 typed-edge replacement hardcodes `bidirectional: true` → set from relation type (directional for supersedes/derived_from/source_of/refines/exemplifies)
- A20 `SemanticEdgesResult.skipped` is a const 0 → remove the field (result contract; check callers)
- A21 `EXTRACTION_TIMEOUT_MS` dead constant → delete (same family as C8)
- A23 cli.ts:956 "via Claude Haiku" doc → describe direct-endpoint-first
- A24 claude-llm.ts:360 stale duplicate doc on parseEdgeClassificationResponse → delete superseded block
- A30 README.md:400 shell-out-only claim → document resolution order + env vars
- A31 ai-prune.ts:3 "claude -p (headless)" header → direct-endpoint-first language
- A32 duplicate of C2 — covered
- A34 testability seam — covered by C3/C4 (mocked boundaries, no port refactor)

## Rejected advisories (documented, not fixed)

- A14 rowToMemory throw-vs-skip: data-layer degradation behavior, broader change; park
- A15 createMemory partial validation (scope/source_type/source_context/timestamps): contract expansion; C6 covers the runtime write path
- A16 dead branded types: cleanup only; park
- A17 `source_context` JSON-string: architecture change (typed source_context serialization); park
- A18 hybridSimilarity threshold blending: calibration-sensitive dedup change; park
- A22 backfill doc, A25 remember doc, A26 recall header, A27 prompt-recall header, A28 cli header subcommand list, A29 filesystem "Pure" label: pre-existing doc staleness outside this PR's LLM-path scope; park

## Refuted critical findings audit

- **0 refuted.** Panel threshold 2 (k-of-3 majority); all findings upheld by reproduction and intent lenses; blast-radius upheld all. No refutation evidence to retain.

## Validation commands

```bash
cd engine && bun test
cd engine && bunx tsc --noEmit   # scoped: no new errors in changed files
```
