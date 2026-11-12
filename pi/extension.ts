/**
 * Cortex Pi Extension
 *
 * Persistent memory for pi — extracts session knowledge, surfaces ranked
 * context, provides semantic recall. Shells out to bun engine CLI for
 * heavy lifting (SQLite, embeddings, LLM extraction).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shouldRunShutdownPipeline, isCortexShutdownReason } from "./shutdown-policy.js";
import { showSurface } from "../engine/src/commands/show-surface.js";
import { nodeCliRunner, type CliRunner } from "./cli-runner.js";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_PATH = join(PACKAGE_ROOT, "engine", "src", "cli.ts");

/** A surface reload blocks the agent's start, so it gets a short leash. */
const SURFACE_RELOAD_TIMEOUT_MS = 10_000;

const defaultCliRunner = nodeCliRunner(CLI_PATH, { CORTEX_PLUGIN_ROOT: PACKAGE_ROOT });

type PiModelSelection = Readonly<{
  provider: string;
  id: string;
}>;

/** Pass the active Pi model to engine subprocesses without mutating global env. */
function getCortexLlmEnvironment(model: PiModelSelection | undefined): NodeJS.ProcessEnv {
  return model
    ? {
      CORTEX_PI_PROVIDER: model.provider,
      CORTEX_PI_MODEL: model.id,
    }
    : {};
}

/**
 * @param pi - The Pi extension API
 * @param cli - The engine boundary. Defaults to the real subprocess adapter;
 *   tests pass a plain-object fake, which is why this file needs no mocking
 *   framework and cannot be broken by one.
 */
export default function (pi: ExtensionAPI, cli: CliRunner = defaultCliRunner) {
  /** Best-effort stdout adapter for lifecycle hooks that intentionally degrade. */
  const runCli = (args: readonly string[], options?: Parameters<CliRunner["run"]>[1]): string => {
    const result = cli.run(args, options);
    return result.ok ? result.output : "";
  };

  // Session shutdown can invalidate SessionManager's file reference. Retain
  // immutable session metadata from session_start for transcript extraction.
  let sessionFile: string | undefined;
  let sessionId: string | undefined;
  let activeModel: PiModelSelection | undefined;

  // ─── Before Agent Start: Resolve paths + inject memory surface + prompt recall
  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = ctx.cwd;

    // 1. Resolve ${CLAUDE_PLUGIN_ROOT} for cortex commands
    const systemPrompt = event.systemPrompt
      + `\n\n# Cortex Memory CLI\nWhen cortex commands reference \`\${CLAUDE_PLUGIN_ROOT}\`, use this resolved path instead:\n\`${PACKAGE_ROOT}\`\nFor example: \`bun ${CLI_PATH} recall ${cwd} "query"\`\n`;

    // 2. The memory surface, reloaded first if a `git switch` since it was
    // written left it naming another branch: the same check and reload as
    // Claude Code's UserPromptSubmit hook, from the same engine function.
    const parts: string[] = [];
    const shown = showSurface(cwd, (dir) => {
      cli.run(["load-surface", dir], { cwd: dir, timeout: SURFACE_RELOAD_TIMEOUT_MS });
    });
    if (shown.kind === "shown") {
      const surface = shown.text.trim();
      if (surface) parts.push(surface);
    } else if (shown.kind === "unreadable") {
      process.stderr.write(`[cortex] Failed to read memory surface ${shown.path}: ${shown.error}\n`);
    }

    // 3. Prompt recall (keyword search based on user's prompt)
    if (event.prompt) {
      const hookInput = JSON.stringify({ prompt: event.prompt, cwd });
      const recall = runCli(["prompt-recall"], {
        stdin: hookInput,
        timeout: 5_000,
        cwd,
      });
      if (recall) parts.push(recall);
    }

    const result: Record<string, unknown> = { systemPrompt };

    if (parts.length > 0) {
      result.message = {
        customType: "cortex-memory",
        content: parts.join("\n\n"),
        display: false,
      };
    }

    return result;
  });

  // ─── Session Start: Load cached surface ─────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    sessionFile = ctx.sessionManager.getSessionFile();
    sessionId = ctx.sessionManager.getSessionId();
    activeModel = ctx.model
      ? { provider: ctx.model.provider, id: ctx.model.id }
      : undefined;

    // Surface refresh is cache-backed and safe to complete in the background.
    // An existing surface remains readable while the locked atomic writer
    // refreshes it, so session startup and /new never wait on the engine CLI.
    const cwd = ctx.cwd;
    cli.runDetached(["load-surface", cwd], { cwd });
  });

  pi.on("model_select", async (event) => {
    activeModel = { provider: event.model.provider, id: event.model.id };
  });

  // ─── Session End: enqueue extraction + maintenance asynchronously ──
  pi.on("session_shutdown", async (event, ctx) => {
    // A nested `pi -p` extraction inherits this marker. Never let that child
    // invoke Cortex's shutdown pipeline again: doing so recursively forks one
    // maintenance worker per extraction LLM call.
    // pi types reason as a closed union today, but a future pi version can
    // extend it; the guard fails closed on any reason this policy has not
    // reviewed instead of laundering it through a cast.
    if (!isCortexShutdownReason(event.reason)) {
      console.error(
        `[cortex] Unknown session_shutdown reason '${String(event.reason)}'; skipping shutdown pipeline`
      );
      return;
    }
    if (!shouldRunShutdownPipeline(
      event.reason,
      process.env.CORTEX_EXTRACTING,
    )) {
      // Say why. Its sibling guards above and below both log their skip, and a
      // pipeline that silently does nothing is indistinguishable from one that
      // ran and found nothing — the exact ambiguity that makes "extraction
      // stopped happening" hard to diagnose from a transcript.
      process.stderr.write(
        `[cortex] Shutdown pipeline skipped (reason='${event.reason}'` +
          `${process.env.CORTEX_EXTRACTING === "1" ? ", nested extraction child" : ""})\n`
      );
      return;
    }

    const cwd = ctx.cwd;
    const transcriptPath = ctx.sessionManager.getSessionFile() ?? sessionFile;
    const extractionSessionId = ctx.sessionManager.getSessionId() ?? sessionId ?? "unknown";

    // Persistent sessions have a JSONL transcript. Enqueue the entire ordered
    // pipeline in one detached worker so /new and /q never await extraction,
    // embedding, or maintenance. The transcript remains on disk after the Pi
    // session runtime is torn down, so the worker can safely read it later.
    if (transcriptPath && existsSync(transcriptPath)) {
      const hookInput = JSON.stringify({
        session_id: extractionSessionId,
        transcript_path: transcriptPath,
        cwd,
      });
      const llmEnv = getCortexLlmEnvironment(
        ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : activeModel,
      );
      cli.runDetached(["ingest-session"], {
        stdin: hookInput,
        cwd,
        env: llmEnv,
      });
      return;
    }

    // Ephemeral sessions (subagent spawns run `pi -p --no-session`) have no
    // transcript, so extraction never ran and nothing new entered the store.
    // Running maintenance here would spend LLM budget (semantic-edges,
    // ai-prune) fighting the live agents that spawned this session for server
    // capacity, for no new data: the spawning session's own ingest-session
    // pipeline maintains the store after its extraction, and the next
    // session's session_start refreshes the surface. Manual `maintenance`
    // remains available for catch-up.
    process.stderr.write(
      "[cortex] No persisted Pi session transcript; extraction and maintenance skipped (ephemeral session)\n",
    );
  });

  // ─── Commands ─────────────────────────────────────────────────────────

  pi.registerCommand("cortex-status", {
    description: "Show cortex memory health and stats",
    handler: async (_args, ctx) => {
      const result = cli.run(["inspect", ctx.cwd], { timeout: 10_000, cwd: ctx.cwd });
      if (!result.ok) {
        ctx.ui.notify(`Cortex status failed: ${result.error}`, "error");
      } else if (result.output) {
        ctx.ui.notify(result.output.split("\n").slice(0, 8).join("\n"), "info");
      } else {
        ctx.ui.notify("No cortex data found for this project", "info");
      }
    },
  });
}
