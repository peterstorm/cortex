#!/usr/bin/env bash
# Extract and Generate Hook Shim (Stop Hook)
#
# Satisfies:
# - FR-119: Receives Stop hook input as JSON stdin (session_id, transcript_path, cwd)
# - FR-022: Generate triggers after extraction completes
# - FR-046: Backfill missing embeddings after extraction
#
# Architecture:
# Thin shell orchestrator - reads stdin JSON, pipes to extract CLI, backfills
# embeddings, runs maintenance (semantic-edges, lifecycle, ai-prune), and
# generates the surface LAST so it reflects post-archival state.
# ALL errors caught and logged, NEVER block session (exit 0 always).
#
# Usage (invoked by Stop hook):
# echo '{"session_id":"...","transcript_path":"...","cwd":"..."}' | ./extract-and-generate.sh

set -euo pipefail

# Guard: prevent recursive hook storm — claude -p spawned by extraction
# inherits CORTEX_EXTRACTING=1, so its SessionEnd hook exits immediately
if [[ "${CORTEX_EXTRACTING:-}" == "1" ]]; then
  exit 0
fi

# Resolve plugin root (this script is in hooks/scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CLI_PATH="${PLUGIN_ROOT}/engine/src/cli.ts"

# Source GEMINI_API_KEY for embedding backfill (zsh initContent doesn't apply
# in hook bash context). Override the default sops-nix location with
# CORTEX_GEMINI_ENV for non-NixOS setups.
GEMINI_ENV="${CORTEX_GEMINI_ENV:-$HOME/.config/sops-nix/secrets/rendered/gemini-env}"
if [[ -f "$GEMINI_ENV" ]]; then
  source "$GEMINI_ENV"
fi

# Logging helper
log_error() {
  echo "[cortex-hook] ERROR: $*" >&2
}

log_info() {
  echo "[cortex-hook] INFO: $*" >&2
}

# Per-process log files: fixed /tmp paths clobber each other when multiple
# detached workers run concurrently (one per session Stop). Include the PID.
EXTRACT_LOG="/tmp/cortex-extract.$$.log"
BACKFILL_LOG="/tmp/cortex-backfill.$$.log"
MAINTENANCE_LOG="/tmp/cortex-maintenance.$$.log"

# Main execution wrapped in error handler
main() {
  # Read stdin JSON (Stop hook input)
  local stdin_json
  stdin_json=$(cat)

  if [[ -z "$stdin_json" ]]; then
    log_error "No stdin input (expected JSON with session_id, transcript_path, cwd)"
    return 0  # Never block session
  fi

  log_info "Received Stop hook input, starting extraction..."

  # Parse cwd from stdin JSON for generate command
  local cwd
  cwd=$(echo "$stdin_json" | bun -e "console.log(JSON.parse(require('fs').readFileSync(0, 'utf8')).cwd)" 2>/dev/null || echo "")

  # Step 1: Extract (pipe stdin JSON to CLI)
  local extract_ok=true
  if ! echo "$stdin_json" | bun "$CLI_PATH" extract 2>&1 | tee "$EXTRACT_LOG"; then
    log_error "Extract failed (see $EXTRACT_LOG)"
    extract_ok=false
  fi

  # Step 2: Backfill embeddings only if extraction succeeded (FR-046)
  if [[ "$extract_ok" == true ]] && [[ -n "$cwd" ]]; then
    log_info "Backfilling embeddings for cwd: $cwd"
    if ! bun "$CLI_PATH" backfill "$cwd" 2>&1 | tee "$BACKFILL_LOG"; then
      log_error "Backfill failed (see $BACKFILL_LOG)"
    fi
  fi

  # Step 3: The worker is already detached. Run one per-project-locked
  # maintenance command instead of spawning independent semantic-edge,
  # lifecycle, AI-prune, and generate processes.
  if [[ -n "$cwd" ]]; then
    log_info "Running locked maintenance pipeline for cwd: $cwd"
    if ! bun "$CLI_PATH" maintenance "$cwd" >"$MAINTENANCE_LOG" 2>&1; then
      log_error "Maintenance failed (see $MAINTENANCE_LOG)"
    fi
  else
    log_error "Could not parse cwd from stdin JSON, skipping maintenance"
  fi

  log_info "Stop hook complete"
}

# Worker mode: invoked by the detached child to actually run the pipeline.
# Reaches this branch only via the parent's self-reinvocation below; the JSON
# payload arrives via a temp file (arg 2) so detachment doesn't depend on a
# live stdin pipe to the reaped parent.
if [[ "${1:-}" == "--worker" ]]; then
  input_file="${2:-}"
  if [[ -n "$input_file" && -f "$input_file" ]]; then
    exec < "$input_file"
  fi
  if ! main; then
    log_error "Unhandled error in detached worker"
  fi
  [[ -n "$input_file" ]] && rm -f "$input_file"
  exit 0
fi

# Parent mode: Claude Code declares a 300s SessionEnd timeout in hooks.json,
# but in practice the parent reaps this hook's PROCESS GROUP before claude -p
# finishes, leaving extract.log with only the "Using Claude" line and no DB
# writes. The worker must therefore run in a NEW process group: setsid does
# that on Linux; on macOS (no setsid binary) nohup+disown does NOT — it only
# ignores SIGHUP and edits the shell job table — so we detach via
# node:child_process spawn({detached: true}), which calls setsid(2) directly.
# Tradeoff: errors no longer surface to the session UI; rely on /tmp/cortex-*.log.
stdin_json=$(cat)
if [[ -z "$stdin_json" ]]; then
  log_error "No stdin input — nothing to detach"
  exit 0
fi

SCRIPT_PATH="${BASH_SOURCE[0]}"
TMP_INPUT="$(mktemp /tmp/cortex-hook-input-XXXXXX.json)"
printf '%s' "$stdin_json" > "$TMP_INPUT"

if command -v setsid >/dev/null 2>&1; then
  setsid bash "$SCRIPT_PATH" --worker "$TMP_INPUT" >/dev/null 2>&1 &
else
  bun -e '
    const { spawn } = require("node:child_process");
    const child = spawn("bash", [process.argv[1], "--worker", process.argv[2]], {
      detached: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.unref();
  ' "$SCRIPT_PATH" "$TMP_INPUT"
fi

exit 0
