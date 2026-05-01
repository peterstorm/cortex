#!/usr/bin/env bash
# Load Surface Hook Shim (SessionStart Hook)
#
# Satisfies:
# - FR-019: Session start loads cached push surface (<5s)
# - FR-020: Surface is branch-aware
# - FR-021: Cache avoids regeneration delay
#
# Architecture:
# Thin shell orchestrator - calls load-surface CLI command.
# ALL errors caught and logged, NEVER block session (exit 0 always).
#
# Usage (invoked by SessionStart hook):
# echo '{"session_id":"...","cwd":"..."}' | ./load-surface.sh
# Falls back to ./load-surface.sh <cwd> when invoked manually without stdin.

set -euo pipefail

# Resolve plugin root (this script is in hooks/scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CLI_PATH="${PLUGIN_ROOT}/engine/src/cli.ts"

# Logging helper
log_error() {
  echo "[cortex-hook] ERROR: $*" >&2
}

log_info() {
  echo "[cortex-hook] INFO: $*" >&2
}

# Main execution wrapped in error handler
main() {
  # SessionStart hook passes JSON on stdin; manual invocation may pass cwd as $1.
  local cwd="${1:-}"

  if [[ -z "$cwd" ]] && [[ ! -t 0 ]]; then
    local stdin_json
    stdin_json=$(cat)
    if [[ -n "$stdin_json" ]]; then
      cwd=$(echo "$stdin_json" | bun -e "console.log(JSON.parse(require('fs').readFileSync(0, 'utf8')).cwd ?? '')" 2>/dev/null || echo "")
    fi
  fi

  if [[ -z "$cwd" ]]; then
    log_error "No cwd provided (expected SessionStart JSON on stdin or cwd as \$1)"
    return 0  # Never block session
  fi

  log_info "Loading cached surface for cwd: $cwd"

  # Load cached surface (writes to .claude/cortex-memory.local.md if available)
  if ! bun "$CLI_PATH" load-surface "$cwd" 2>&1 | tee /tmp/cortex-load-surface.log; then
    log_error "Load-surface failed (see /tmp/cortex-load-surface.log)"
  fi

  log_info "SessionStart hook complete"
}

# Execute main with full error handling - NEVER let errors propagate
if ! main "$@"; then
  log_error "Unhandled error in SessionStart hook"
fi

# Always exit 0 - never block session
exit 0
