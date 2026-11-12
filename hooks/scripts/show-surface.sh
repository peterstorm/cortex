#!/usr/bin/env bash
# Show Surface Hook Shim (UserPromptSubmit Hook)
#
# Prints the push surface beside the session (.claude/cortex-memory.local.md)
# so it reaches the model with every prompt, reloaded first if a `git switch`
# since it was written left it naming another branch.
#
# Architecture:
# Thin shell. The decision (is this surface for the checked-out branch?) and
# the reload live in the engine (engine/src/commands/show-surface.ts), which
# the pi extension calls too, so both harnesses show the same surface. The
# comparison has to be made against the header the renderer would write for
# the current branch, since rendering escapes and trims branch names; a shell
# comparison against the raw name reloaded such a branch on every prompt.
# ALL errors caught, NEVER block prompt submission (exit 0 always).
#
# Usage (invoked by the UserPromptSubmit hook, in the session directory):
# ./show-surface.sh [cwd]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOOK_ENTRY="${PLUGIN_ROOT}/engine/src/show-surface-hook.ts"

cwd="${1:-$PWD}"
surface="${cwd}/.claude/cortex-memory.local.md"

# No surface: this project does not use cortex, or has nothing to show. Checked
# here only so that a project without cortex does not pay for starting bun on
# every prompt; the engine checks again and decides everything else.
[[ -e "$surface" ]] || exit 0

# bun missing or failing outright prints nothing; show the file as it is then.
bun "$HOOK_ENTRY" "$cwd" || cat "$surface" 2>/dev/null || true
exit 0
