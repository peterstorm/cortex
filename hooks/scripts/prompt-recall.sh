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

# Pipe stdin JSON to prompt-recall command, suppress stderr
cat | bun "$CLI_PATH" prompt-recall 2>/dev/null || true

exit 0
