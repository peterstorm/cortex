#!/usr/bin/env bash
# Prompt Recall Hook Shim (UserPromptSubmit Hook)
#
# Reads the user's prompt from stdin JSON, pipes it to the prompt-recall
# CLI command which ranks memories semantically against the prompt (strict keyword
# AND matches supplement; keyword OR only when the embedder is unavailable).
#
# Architecture:
# Thin shell orchestrator - pipes stdin to CLI command.
# ALL errors caught, NEVER block prompt submission (exit 0 always).
# Warnings land in ${CORTEX_LOG_DIR:-~/.local/state/cortex}/prompt-recall.log.

set -euo pipefail

# Resolve plugin root (this script is in hooks/scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CLI_PATH="${PLUGIN_ROOT}/engine/src/cli.ts"

# Local embeddings run through onnxruntime-node, whose native library needs
# libstdc++ at runtime. On NixOS that is not on the default library path, so a
# hook process finds no libstdc++ and embedding silently degrades. Probe the
# store unless CORTEX_ONNX_LD_PATH pins it explicitly; a no-op elsewhere.
#
# infra/native-library-path.ts does the same resolution for every OTHER entry
# point (a direct `bun cli.ts backfill`, /remember, /recall), where it costs a
# re-exec because the loader reads LD_LIBRARY_PATH only at process start. This
# block is what keeps the per-prompt hook path off that second process: set the
# variable here, and the engine sees a resolvable library and proceeds.
if [[ -z "${CORTEX_ONNX_LD_PATH:-}" && -d /nix/store ]]; then
  for _candidate in /nix/store/*-gcc-*-lib/lib; do
    _so="${_candidate}/libstdc++.so.6"
    [[ -e "$_so" ]] || continue
    # Byte 4 of an ELF header is its class: 2 = 64-bit. The store also holds
    # 32-bit gcc outputs, and picking one fails at dlopen with
    # "wrong ELF class: ELFCLASS32" — which surfaces as a generic embedding
    # failure, so check rather than guess.
    if [[ "$(od -An -t u1 -j 4 -N 1 "$(readlink -f "$_so")" 2>/dev/null | tr -d " ")" == "2" ]]; then
      CORTEX_ONNX_LD_PATH="$_candidate"
      break
    fi
  done
fi
if [[ -n "${CORTEX_ONNX_LD_PATH:-}" ]]; then
  export LD_LIBRARY_PATH="${CORTEX_ONNX_LD_PATH}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

# Pipe stdin JSON to prompt-recall. Its stdout is the injected block and goes
# to Claude Code untouched (fd 3). The CLI appends its own warnings (embedder
# down → keyword search, a database that will not open) to the prompt-recall
# log, so they are recorded under Pi too, where no shim runs. What it cannot
# log is its own crash: a non-zero exit (bun cannot start, an import fails).
# That stderr is appended here, timestamped, to the same size-capped log,
# whose path engine/src/infra/prompt-recall-log.ts resolves identically.
# A hook's stderr reaches neither the model nor the user, hence the log.
LOG_DIR="${CORTEX_LOG_DIR:-${XDG_STATE_HOME:-$HOME/.local/state}/cortex}"
LOG_FILE="${LOG_DIR}/prompt-recall.log"
LOG_MAX_BYTES=1048576

exec 3>&1
recall_status=0
recall_stderr="$(cat | bun "$CLI_PATH" prompt-recall 2>&1 1>&3)" || recall_status=$?
exec 3>&-

if (( recall_status != 0 )) && [[ -n "$recall_stderr" ]]; then
  {
    mkdir -p "$LOG_DIR"
    # POSIX forms only: `stat -c` and `date -I` are GNU-only, and on macOS
    # they fail silently inside this block — no rotation, empty timestamps.
    if [[ -f "$LOG_FILE" ]] && (( $(wc -c < "$LOG_FILE") > LOG_MAX_BYTES )); then
      mv -f "$LOG_FILE" "${LOG_FILE}.1"
    fi
    stamp="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    while IFS= read -r line; do
      printf '%s %s\n' "$stamp" "$line"
    done <<< "$recall_stderr" >> "$LOG_FILE"
  } 2>/dev/null || true
fi

exit 0
