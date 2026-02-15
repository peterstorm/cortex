#!/usr/bin/env bash
# Extract and Generate Hook Shim (Stop Hook)
#
# Satisfies:
# - FR-119: Receives Stop hook input as JSON stdin (session_id, transcript_path, cwd)
# - FR-022: Generate triggers after extraction completes
# - FR-046: Backfill missing embeddings after extraction
#
# Architecture:
# Thin shell orchestrator - reads stdin JSON, pipes to extract CLI, then backfills embeddings, then generates surface.
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

# Source GEMINI_API_KEY for embedding backfill (zsh initContent doesn't apply in hook bash context)
GEMINI_ENV="$HOME/.config/sops-nix/secrets/rendered/gemini-env"
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
  if ! echo "$stdin_json" | bun "$CLI_PATH" extract 2>&1 | tee /tmp/cortex-extract.log; then
    log_error "Extract failed (see /tmp/cortex-extract.log)"
    extract_ok=false
  fi

  # Step 2: Backfill embeddings only if extraction succeeded (FR-046)
  if [[ "$extract_ok" == true ]] && [[ -n "$cwd" ]]; then
    log_info "Backfilling embeddings for cwd: $cwd"
    if ! bun "$CLI_PATH" backfill "$cwd" 2>&1 | tee /tmp/cortex-backfill.log; then
      log_error "Backfill failed (see /tmp/cortex-backfill.log)"
    fi
  fi

  # Step 3: Generate push surface (always — stale memories still need fresh surface)
  if [[ -n "$cwd" ]]; then
    log_info "Generating push surface for cwd: $cwd"
    if ! bun "$CLI_PATH" generate "$cwd" 2>&1 | tee /tmp/cortex-generate.log; then
      log_error "Generate failed (see /tmp/cortex-generate.log)"
    fi
  else
    log_error "Could not parse cwd from stdin JSON, skipping generate"
  fi

  # Step 4: Fire-and-forget lifecycle prune (detached, cross-platform)
  # Smart trigger: skips if no new memories and last run <2h ago
  if [[ -n "$cwd" ]]; then
    log_info "Spawning detached lifecycle prune"
    if command -v setsid >/dev/null 2>&1; then
      # Linux: setsid detaches from session process group
      setsid bun "$CLI_PATH" lifecycle "$cwd" --if-needed >/dev/null 2>&1 &
    else
      # macOS: nohup + disown achieves same detachment
      nohup bun "$CLI_PATH" lifecycle "$cwd" --if-needed >/dev/null 2>&1 &
      disown
    fi
  fi

  # Step 5: Fire-and-forget AI prune (detached, cross-platform)
  # Smart trigger: skips if session count < 5 AND memory count < 50
  if [[ -n "$cwd" ]]; then
    log_info "Spawning detached AI prune"
    if command -v setsid >/dev/null 2>&1; then
      setsid bun "$CLI_PATH" ai-prune "$cwd" --if-needed >/dev/null 2>&1 &
    else
      nohup bun "$CLI_PATH" ai-prune "$cwd" --if-needed >/dev/null 2>&1 &
      disown
    fi
  fi

  log_info "Stop hook complete"
}

# Execute main with full error handling - NEVER let errors propagate
if ! main "$@"; then
  log_error "Unhandled error in Stop hook"
fi

# Always exit 0 - never block session
exit 0
