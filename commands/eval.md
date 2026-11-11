---
name: eval
version: "1.0.0"
description: "Score what an agent answers from cortex's memory against a test set of real cases, before and after a change. USE before and after changing extraction, ranking, pruning or consolidation, and when the user asks whether memory is actually helping."
---

# /eval - Measure Memory Against Real Cases

**PROACTIVE TRIGGER:** Use this when:
- A change to extraction, ranking, pruning or consolidation is about to land (answer a "before" run first)
- That change has landed (answer an "after" run and score it against the before)
- The user asks whether cortex is helping, or which of two setups is better

## Description

Applies Team0's "Measure before you build" to cortex's read path. Each case in `<project>/.memory/eval/questions.jsonl` is asked of a tool-less model. That model gets exactly what the hooks would inject (the push surface plus the prompt-recall block), or nothing in the `none` baseline. A judge then scores every answer 0-1 on `correct_current`, `relevant`, `missed`, `ordered` and `context_complete`, with one table for practice cases and one for held-out cases. Full details are in the README's "Evaluation" section.

## CLI Command

```bash
bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts eval validate --cwd=<cwd>
bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts eval answer <run> [--condition=cortex|none] --cwd=<cwd>
bun ${CLAUDE_PLUGIN_ROOT}/engine/src/cli.ts eval score <run> [<run>] [--dry-run] --cwd=<cwd>
```

## Arguments

**Required:**
- `validate | answer | score` - the step
- `<run>` - run name (lowercase letters, digits, `.`, `_`, `-`) for `answer`; one or two run names for `score`

**Optional:**
- `--condition=none` - answer with no memory: the baseline
- `--dry-run` - for `score`, show what would be judged without calling a model
- `--dir=<path>` - eval directory (default `<cwd>/.memory/eval`)

## Usage Example

```
/eval validate
/eval answer cortex-2026-11-09
/eval score none-1 cortex-2026-11-09
```

## Rules

- **Never write truths into memory.** Do not `/remember` anything from `questions.jsonl`, and do not quote expected answers back into the conversation when you don't need to. A session that writes or reviews the eval set must have its session id listed in `eval.json` `authoring_sessions`, so eval reads refuse what it taught the memory.
- **Never tune against held-out cases.** Once a held-out failure has been inspected and fixed for, move that case to `practice` and add a fresh held-out case.
- **Never delete a run.** The before is the baseline every later run is compared to.
- **A refused resume is a new experiment.** Start a new run name; don't edit `run.json`.
- **Scoring sends data to the judge endpoint.** Say which endpoint before scoring real work data.

## Interpreting Results

- `correct_current` and `missed` should rise **together** on held_out. Memory that says little is rarely wrong and misses everything.
- `relevant` falling as memory grows means junk is getting in.
- A `<- mixed models` flag means a routing server swapped weights mid-run, so the run is not a clean comparison.
- A `<- the runs read different ... databases` flag means the two snapshots came from different project or global databases (another harness, another machine), so the change measures the data, not cortex.
- A `<- check the judge` flag on a measure means its scores can't be trusted until the judge is fixed or that measure is scored by hand.
