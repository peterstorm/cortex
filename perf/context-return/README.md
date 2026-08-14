# Context-return test: does pi hand the parent context back to vLLM after a subagent?

## The question

vLLM is stateless over the OpenAI-compatible protocol: every turn is a fresh
`/chat/completions` request that must re-send the whole conversation. When pi
runs a subagent (spawned as a separate, isolated pi process, then the parent
resumes), the only way the parent's context survives — and the only way
vLLM's automatic prefix cache stays worthwhile — is if the *resume request*
re-sends the complete pre-subagent conversation as a byte-identical prefix.

This harness tests exactly that, hermetically (no real vLLM or LLM needed):

1. **Context continuity** — the request pi sends after the subagent tool
   result re-sends the full parent conversation (identical role/content
   sequence) plus the tool result.
2. **Cache hand-back** — vLLM's prefix cache re-serves that entire prefix:
   `usage.prompt_tokens_details.cached_tokens` on the resume turn ≈ the full
   pre-subagent context size (rounded down to vLLM's 16-token hash-block).
3. **Isolation** — the subagent's own request carries no parent context.
4. **pi's own accounting** — pi maps `cached_tokens` → `cacheRead` and records
   it on the resume-turn assistant message usage (the same number you'd see
   in a real session file).

## How it works

A stub server emulates the vLLM parts that matter (OpenAI-compatible SSE
streaming, automatic prefix caching with block-granular LCP, `/metrics`).
A probe pi extension registers one tool, `subagent_probe`, whose
`execute` simulates a subagent: it makes its own independent request to the
backend and returns the answer. The scripted reply policy mirrors the real
parent/subagent request pattern:

| req | kind | messages | stub reply |
|-----|------|----------|------------|
| 1 | parent | `[system, user]` | `tool_calls → subagent_probe` |
| 2 | subagent | `[system[subagent], user]` | end_turn (isolated context) |
| 3 | parent | `[system, user, assistant(tool_calls), tool(result)]` | end_turn |

When the first-turn parent prompt is 231 tokens and the resume turn reports
`cached_tokens=224` (= `floor(231/16)*16`), the entire parent context came
back from the cache.

## Run

```bash
bun run perf/context-return/run-test.ts        # from repo root
```

Requires `node_modules/.bin/pi` (the pi package is a dev dependency of the
repo). Override the binary with `PI_BIN`. Exit code 0 = all assertions pass.

The stub is spawned in-process on an ephemeral port; a throwaway
`PI_CODING_AGENT_DIR` + `HOME` are created and deleted, so nothing in
`~/.pi` is touched.

## Against a real vLLM

The stub is the deterministic check. To confirm with your real server:

```bash
# 1. serve with automatic prefix caching (default in recent releases)
vllm serve <model> --enable-prefix-caching --log-requests

# 2. point pi at it (copy the models.json the harness generates, or:)
mkdir -p /tmp/vllm-pi && cat > /tmp/vllm-pi/models.json <<'EOF'
{ "providers": { "local": { "baseUrl": "http://127.0.0.1:8000/v1",
    "api": "openai-completions", "apiKey": "dummy",
    "compat": { "supportsDeveloperRole": false, "supportsReasoningEffort": false },
    "models": [ { "id": "<model>", "reasoning": false, "contextWindow": 32768,
      "maxTokens": 8192, "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 } } ] } } }
EOF

# 3. run the same scenario (real model must actually call the tool; prompt accordingly)
PI_CODING_AGENT_DIR=/tmp/vllm-pi HOME=/tmp/vllm-pi STUB_URL=http://127.0.0.1:8000/v1 \
  node_modules/.bin/pi --mode json -p --no-session --model local/<model> --api-key dummy \
  -e perf/context-return/probe-extension.ts --no-extensions --no-skills --no-prompt-templates \
  --no-context-files --no-builtin-tools \
  'Call subagent_probe with echo "hello". Then reply SUBAGENT_DONE.'

# 4. read the verdict from the resume-turn message_end usage:
#    cacheRead ≈ input of the first assistant turn (minus one 16-token block).
#    Also watch vLLM: --log-requests prints per-request prefix cache hits.
```

**Caveat — eviction vs. context loss.** vLLM's prefix cache is an LRU over
hash blocks. If the subagent's own requests are large and the cache allocation
small, the parent's prefix can be evicted before the resume turn, so
`cached_tokens` comes back partial (or zero). That is *not* a pi context bug —
assertion `[4]` (prefix equality at the message level) is the pi-side truth;
`cached_tokens` is the cache-economics number. In the hermetic test the
subagent traffic is tiny, so the two agree.

## Files

- `stub-vllm.ts` — emulated vLLM (SSE, prefix cache with 16-token blocks,
  `GET /metrics`, `GET /requests` for debugging).
- `probe-extension.ts` — pi extension registering `subagent_probe`, whose
  execute simulates the isolated subagent call.
- `run-test.ts` — orchestrator: boots stub, writes throwaway pi config,
  runs pi headless (`--mode json -p`), asserts the 7 properties, prints a
  report, exits non-zero on failure.
