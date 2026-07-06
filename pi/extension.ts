/**
 * Cortex Pi Extension
 *
 * Persistent memory for pi — extracts session knowledge, surfaces ranked
 * context, provides semantic recall. Shells out to bun engine CLI for
 * heavy lifting (SQLite, embeddings, LLM extraction).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, openSync, closeSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_PATH = join(PACKAGE_ROOT, "engine", "src", "cli.ts");

/**
 * Env for spawned engine CLIs. The engine decides harness-specific paths
 * (surface file, global DB) by sniffing PI_CODING_AGENT* env vars
 * (engine/src/config.ts detectHarness/getSurfaceOutputPath). If pi's own
 * process doesn't carry that var, the spawned CLI would silently write the
 * surface to .claude/ while this extension reads .pi/ — so force the marker.
 */
function cliEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CORTEX_PLUGIN_ROOT: PACKAGE_ROOT,
    PI_CODING_AGENT: process.env.PI_CODING_AGENT ?? "1",
  };
}

/** Run a bun CLI command, returning stdout. Never throws. */
function runCli(args: string[], options?: {
  stdin?: string;
  timeout?: number;
  cwd?: string;
}): string {
  try {
    const input = options?.stdin ?? "";
    // execFileSync with an argv array — no shell, so cwd/args containing
    // spaces or metacharacters can't break (or inject into) the command.
    return execFileSync("bun", [CLI_PATH, ...args], {
      input,
      timeout: options?.timeout ?? 30_000,
      cwd: options?.cwd,
      encoding: "utf-8",
      env: cliEnv(),
    }).trim();
  } catch (e) {
    // Never block — log and return empty
    const msg = (e as Error).message ?? "";
    if (msg.includes("TIMEOUT")) {
      process.stderr.write(`[cortex] CLI timeout: ${args.join(" ")}\n`);
    } else {
      process.stderr.write(`[cortex] CLI failed (${args.join(" ")}): ${msg}\n`);
    }
    return "";
  }
}

/**
 * Run several bun CLI commands sequentially in ONE detached child.
 * Used for post-session maintenance: sequential execution prevents the
 * SQLite single-writer and telemetry read-modify-write races that
 * concurrent detached spawns caused. Logs go to /tmp/cortex-maintenance.log.
 */
function runCliChainDetached(argsList: string[][], cwd: string): void {
  try {
    const script = [
      `const { execFileSync } = require("node:child_process");`,
      `const chains = JSON.parse(process.argv[2]);`,
      `for (const args of chains) {`,
      `  try { execFileSync("bun", [process.argv[1], ...args], { stdio: "inherit", cwd: process.argv[3] }); }`,
      `  catch (e) { console.error("[cortex-maintenance] step failed:", args[0], e?.message); }`,
      `}`,
    ].join("\n");

    const logFd = openSync("/tmp/cortex-maintenance.log", "a");
    const proc = spawn(
      "bun",
      ["-e", script, CLI_PATH, JSON.stringify(argsList), cwd],
      {
        stdio: ["ignore", logFd, logFd],
        detached: true,
        cwd,
        env: cliEnv(),
      }
    );
    proc.unref();
    closeSync(logFd);
  } catch (e) {
    process.stderr.write(`[cortex] failed to spawn maintenance chain: ${(e as Error).message}\n`);
  }
}

/**
 * Get the surface file path for the current project.
 * Replicates engine getSurfaceOutputPath (engine/src/config.ts): pi harness
 * → .pi/, otherwise .claude/. cliEnv() forces PI_CODING_AGENT for spawned
 * CLIs, so this and the engine always agree on the same path.
 */
function getSurfacePath(cwd: string): string {
  const isPi = Boolean(cliEnv().PI_CODING_AGENT_DIR || cliEnv().PI_CODING_AGENT);
  return join(cwd, isPi ? ".pi" : ".claude", "cortex-memory.local.md");
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
    } catch (e) {
      process.stderr.write(`[cortex] failed to load gemini env (${envFile}): ${(e as Error).message}\n`);
    }
  }
}

export default function (pi: ExtensionAPI) {
  loadGeminiEnv();

  // ─── Before Agent Start: Resolve paths + inject memory surface + prompt recall
  pi.on("before_agent_start", async (event, ctx) => {
    const cwd = ctx.cwd;

    // 1. Resolve ${CLAUDE_PLUGIN_ROOT} for cortex commands
    const systemPrompt = event.systemPrompt
      + `\n\n# Cortex Memory CLI\nWhen cortex commands reference \`\${CLAUDE_PLUGIN_ROOT}\`, use this resolved path instead:\n\`${PACKAGE_ROOT}\`\nFor example: \`bun ${CLI_PATH} recall ${cwd} "query"\`\n`;

    // 2. Load cached surface file
    const parts: string[] = [];
    const surfacePath = getSurfacePath(cwd);
    if (existsSync(surfacePath)) {
      try {
        const surface = readFileSync(surfacePath, "utf-8").trim();
        if (surface) parts.push(surface);
      } catch (e) {
        process.stderr.write(`[cortex] failed to read surface (${surfacePath}): ${(e as Error).message}\n`);
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
    const cwd = ctx.cwd;
    runCli(["load-surface", cwd], { timeout: 10_000, cwd });
  });

  // ─── Session End: Extract + generate + lifecycle ────────────────────
  pi.on("session_shutdown", async (event, ctx) => {
    // Guard: don't extract on reload
    if (event.reason === "reload") return;

    const cwd = ctx.cwd;
    const sessionFile = ctx.sessionManager.getSessionFile();

    // Build stdin JSON matching what the Claude Code hook expects
    const hookInput = JSON.stringify({
      session_id: ctx.sessionManager.getSessionId() ?? "unknown",
      transcript_path: sessionFile ?? "",
      cwd,
    });

    // Step 1: Extract memories from session transcript.
    // Timeout must exceed the engine's inner LLM timeout (90s in
    // claude-llm.ts) — a shorter outer timeout SIGTERMs mid-extraction,
    // losing the chunk without saving a checkpoint.
    const extractResult = runCli(["extract"], {
      stdin: hookInput,
      timeout: 120_000,
      cwd,
    });

    // Step 2: Backfill embeddings
    if (extractResult) {
      runCli(["backfill", cwd], { timeout: 30_000, cwd });
    }

    // Steps 3-6: maintenance — ONE detached chain, run sequentially.
    // Spawning these concurrently made them race: SQLite allows a single
    // writer, and lifecycle + ai-prune both read-modify-write telemetry.json.
    //
    // ORDER MATTERS: generate runs LAST. Lifecycle and ai-prune archive
    // memories — generating the surface before them served just-archived
    // memories for the whole next session.
    runCliChainDetached(
      [
        ["semantic-edges", cwd],
        ["lifecycle", cwd, "--if-needed"],
        ["ai-prune", cwd, "--if-needed"],
        ["generate", cwd],
      ],
      cwd
    );
  });

  // ─── Commands ─────────────────────────────────────────────────────────

  pi.registerCommand("cortex-status", {
    description: "Show cortex memory health and stats",
    handler: async (_args, ctx) => {
      const output = runCli(["inspect", ctx.cwd], { timeout: 10_000, cwd: ctx.cwd });
      if (output) {
        ctx.ui.notify(output.split("\n").slice(0, 8).join("\n"), "info");
      } else {
        ctx.ui.notify("No cortex data found for this project", "info");
      }
    },
  });
}
