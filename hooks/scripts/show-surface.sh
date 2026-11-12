#!/usr/bin/env bash
# Show Surface Hook Shim (UserPromptSubmit Hook)
#
# Prints the push surface beside the session (.claude/cortex-memory.local.md)
# so it reaches the model with every prompt.
#
# The surface is written for one branch, at SessionStart and after each
# session ends. A `git switch` in between leaves the previous branch's surface
# on disk, and it would be shown, under the wrong branch name, until the next
# session. So before printing, compare the branch the file names with the
# branch checked out now, and on a mismatch ask `load-surface` for the right
# one (it serves that branch's cache, or regenerates).
#
# Architecture:
# Thin shell orchestrator. The common path is one git call and one cat; bun
# starts only when the branch changed. ALL errors caught, NEVER block prompt
# submission (exit 0 always).
#
# Usage (invoked by the UserPromptSubmit hook, in the session directory):
# ./show-surface.sh [cwd]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CLI_PATH="${PLUGIN_ROOT}/engine/src/cli.ts"

cwd="${1:-$PWD}"
surface="${cwd}/.claude/cortex-memory.local.md"

# No surface: this project does not use cortex, or has nothing to show.
[[ -f "$surface" ]] || exit 0

# The branch the surface was generated for: its "**Branch:** <name>" header.
surface_branch="$(sed -n 's/^\*\*Branch:\*\* //p' "$surface" 2>/dev/null | head -n 1)"

# Same answer as the engine's getCurrentBranch: "unknown" outside a repository.
current_branch="$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
current_branch="${current_branch:-unknown}"

if [[ -n "$surface_branch" && "$surface_branch" != "$current_branch" ]]; then
  bun "$CLI_PATH" load-surface "$cwd" >/dev/null 2>&1 || true
fi

cat "$surface" 2>/dev/null || true
exit 0
