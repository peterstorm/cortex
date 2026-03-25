#!/usr/bin/env bash
# Prompt Recall Hook Shim (UserPromptSubmit Hook)
#
# Reads the user's prompt from stdin JSON, pipes it to the prompt-recall
# CLI command which extracts keywords and runs FTS5 search for relevant memories.
#
# Architecture:
# Thin shell orchestrator - pipes stdin to CLI command.
# ALL errors caught, NEVER block prompt submission (exit 0 always).

set -euo pipefail

# Resolve plugin root (this script is in hooks/scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CLI_PATH="${PLUGIN_ROOT}/engine/src/cli.ts"

# Pipe stdin JSON to prompt-recall command, suppress stderr
cat | bun "$CLI_PATH" prompt-recall 2>/dev/null || true

exit 0
