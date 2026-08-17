/**
 * Cortex Pi Extension
 *
 * Persistent memory for pi — extracts session knowledge, surfaces ranked
 * context, provides semantic recall. Shells out to bun engine CLI for
 * heavy lifting (SQLite, embeddings, LLM extraction).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { shouldRunShutdownPipeline, isCortexShutdownReason } from "./shutdown-policy.js";
import { getSurfaceOutputPath } from "../engine/src/config.js";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_PATH = join(PACKAGE_ROOT, "engine", "src", "cli.ts");

type CliRunResult =
  | Readonly<{ ok: true; output: string }>
  | Readonly<{ ok: false; error: string }>;

/** Run a bun CLI command and retain failure identity. Never throws. */
function runCliResult(args: string[], options?: {
  stdin?: string;
  timeout?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): CliRunResult {
  try {
    const input = options?.stdin ?? "";
    const output = execFileSync("bun", [CLI_PATH, ...args], {
      input,
      timeout: options?.timeout ?? 30_000,
      cwd: options?.cwd,
      encoding: "utf-8",
      env: {
        ...process.env,
        CORTEX_PLUGIN_ROOT: PACKAGE_ROOT,
        ...options?.env,
      },
    }).trim();
    return { ok: true, output };
  } catch (error) {
    // Never block the Pi lifecycle, but preserve enough bounded diagnostics to
    // distinguish "no data" from a broken runtime or engine command.
    const failure = error as Error & {
      status?: number;
      signal?: string;
      stderr?: Buffer | string;
    };
    const message = failure.message ?? String(error);
    const stderr = String(failure.stderr ?? "").trim().slice(0, 1_000);
    const diagnostic = message.includes("TIMEOUT")
      ? `CLI timeout: ${args.join(" ")} (cwd=${options?.cwd ?? process.cwd()})`
      : `CLI failed: bun ${args.join(" ")} ` +
        `(cwd=${options?.cwd ?? process.cwd()}, status=${failure.status ?? "n/a"}, ` +
        `signal=${failure.signal ?? "none"}): ${message}` +
        (stderr === "" ? "" : `\n${stderr}`);
    process.stderr.write(`[cortex] ${diagnostic}\n`);
    return { ok: false, error: diagnostic };
  }
}

/** Best-effort stdout adapter for lifecycle hooks that intentionally degrade. */
function runCli(args: string[], options?: Parameters<typeof runCliResult>[1]): string {
  const result = runCliResult(args, options);
  return result.ok ? result.output : "";
}

/** Run a bun CLI command detached (fire-and-forget). */
function runCliDetached(args: string[], options?: {
  stdin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): void {
  let logFd: number | undefined;
  let outputTarget: number | "inherit" = "inherit";
  try {
    if (options?.cwd) {
      const logDir = join(options.cwd, ".memory", "logs");
      mkdirSync(logDir, { recursive: true });
      logFd = openSync(join(logDir, "pi-detached.log"), "a", 0o600);
      outputTarget = logFd;
    }
  } catch (error) {
    process.stderr.write(
      `[cortex] detached CLI log setup failed for ${args.join(" ")}: ` +
        `${error instanceof Error ? error.message : String(error)}; inheriting output\n`
    );
  }

  try {
    const proc = spawn("bun", [CLI_PATH, ...args], {
      stdio: options?.stdin
        ? ["pipe", outputTarget, outputTarget]
        : ["ignore", outputTarget, outputTarget],
      detached: true,
      cwd: options?.cwd,
      env: {
        ...process.env,
        CORTEX_PLUGIN_ROOT: PACKAGE_ROOT,
        ...options?.env,
      },
    });
    proc.once?.("error", (error) => {
      process.stderr.write(`[cortex] detached CLI spawn failed for ${args.join(" ")}: ${error.message}\n`);
    });
    if (options?.stdin && proc.stdin) {
      proc.stdin.once?.("error", (error) => {
        process.stderr.write(`[cortex] detached CLI stdin failed for ${args.join(" ")}: ${error.message}\n`);
      });
      proc.stdin.write(options.stdin);
      proc.stdin.end();
    }
    proc.unref();
  } catch (error) {
    process.stderr.write(
      `[cortex] detached CLI setup failed for ${args.join(" ")}: ` +
        `${error instanceof Error ? error.message : String(error)}\n`
    );
  } finally {
    if (logFd !== undefined) closeSync(logFd);
  }
}

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

/** Source Gemini API key if available */
function loadGeminiEnv(): void {
  const envFile = join(process.env.HOME ?? "", ".config/sops-nix/secrets/rendered/gemini-env");
  if (existsSync(envFile)) {
    try {
      const content = readFileSync(envFile, "utf-8");
      for (const line of content.split("\n")) {
        const match = line.match(/^export\s+(\w+)=["']?(.+?)["']?\s*$/);
        if (match) process.env[match[1]] = match[2];
      }
    } catch (error) {
      process.stderr.write(
        `[cortex] Failed to read Gemini environment file ${envFile}: ` +
          `${error instanceof Error ? error.message : String(error)}\n`
      );
    }
  }
}

export default function (pi: ExtensionAPI) {
  loadGeminiEnv();

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

    // 2. Load cached surface file
    const parts: string[] = [];
    const surfacePath = getSurfaceOutputPath(cwd);
    if (existsSync(surfacePath)) {
      try {
        const surface = readFileSync(surfacePath, "utf-8").trim();
        if (surface) parts.push(surface);
      } catch (error) {
        process.stderr.write(
          `[cortex] Failed to read memory surface ${surfacePath}: ` +
            `${error instanceof Error ? error.message : String(error)}\n`
        );
      }
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
    runCliDetached(["load-surface", cwd], { cwd });
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
    )) return;

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
      runCliDetached(["ingest-session"], {
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
      const result = runCliResult(["inspect", ctx.cwd], { timeout: 10_000, cwd: ctx.cwd });
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
