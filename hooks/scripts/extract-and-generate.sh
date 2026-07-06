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

  # Steps 4-6: maintenance, run SEQUENTIALLY. This whole worker is already
  # detached from the session, so nothing here blocks the user — and running
  # these concurrently made them race each other: SQLite allows one writer
  # (collisions were silently lost in /dev/null), and lifecycle + ai-prune
  # both read-modify-write telemetry.json. Logs go to /tmp for debuggability.

  # Step 4: Semantic edge classification (claude -p) — upgrades Jaccard
  # 'relates_to' edges to typed relationships
  if [[ "$extract_ok" == true ]] && [[ -n "$cwd" ]]; then
    log_info "Running semantic edge classification"
    if ! bun "$CLI_PATH" semantic-edges "$cwd" >/tmp/cortex-semantic-edges.log 2>&1; then
      log_error "Semantic edges failed (see /tmp/cortex-semantic-edges.log)"
    fi
  fi

  # Step 5: Lifecycle prune — skips if no new memories and last run <2h ago
  if [[ -n "$cwd" ]]; then
    log_info "Running lifecycle prune"
    if ! bun "$CLI_PATH" lifecycle "$cwd" --if-needed >/tmp/cortex-lifecycle.log 2>&1; then
      log_error "Lifecycle failed (see /tmp/cortex-lifecycle.log)"
    fi
  fi

  # Step 6: AI prune — smart trigger decides whether a prune is due
  if [[ -n "$cwd" ]]; then
    log_info "Running AI prune"
    if ! bun "$CLI_PATH" ai-prune "$cwd" --if-needed >/tmp/cortex-ai-prune.log 2>&1; then
      log_error "AI prune failed (see /tmp/cortex-ai-prune.log)"
    fi
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
