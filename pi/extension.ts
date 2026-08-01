/**
 * Cortex Pi Extension
 *
 * Persistent memory for pi — extracts session knowledge, surfaces ranked
 * context, provides semantic recall. Shells out to bun engine CLI for
 * heavy lifting (SQLite, embeddings, LLM extraction).
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { execSync, spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CLI_PATH = join(PACKAGE_ROOT, "engine", "src", "cli.ts");

/** Run a bun CLI command, returning stdout. Never throws. */
function runCli(args: string[], options?: {
  stdin?: string;
  timeout?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  try {
    const input = options?.stdin ?? "";
    return execSync(`bun "${CLI_PATH}" ${args.join(" ")}`, {
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
  } catch (e) {
    // Never block — log and return empty
    const msg = (e as Error).message ?? "";
    if (msg.includes("TIMEOUT")) {
      process.stderr.write(`[cortex] CLI timeout: ${args.join(" ")}\n`);
    }
    return "";
  }
}

/** Run a bun CLI command detached (fire-and-forget). */
function runCliDetached(args: string[], options?: {
  stdin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): void {
  try {
    const proc = spawn("bun", [CLI_PATH, ...args], {
      stdio: options?.stdin ? ["pipe", "ignore", "ignore"] : ["ignore", "ignore", "ignore"],
      detached: true,
      cwd: options?.cwd,
      env: {
        ...process.env,
        CORTEX_PLUGIN_ROOT: PACKAGE_ROOT,
        ...options?.env,
      },
    });
    if (options?.stdin && proc.stdin) {
      proc.stdin.write(options.stdin);
      proc.stdin.end();
    }
    proc.unref();
  } catch {}
}

/** Get the surface file path for current project */
function getSurfacePath(cwd: string): string {
  return join(cwd, ".pi", "cortex-memory.local.md");
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
    } catch {}
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
    const surfacePath = getSurfacePath(cwd);
    if (existsSync(surfacePath)) {
      try {
        const surface = readFileSync(surfacePath, "utf-8").trim();
        if (surface) parts.push(surface);
      } catch {}
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

    const cwd = ctx.cwd;
    runCli(["load-surface", cwd], { timeout: 10_000, cwd });
  });

  pi.on("model_select", async (event) => {
    activeModel = { provider: event.model.provider, id: event.model.id };
  });

  // ─── Session End: Extract + generate + lifecycle ────────────────────
  pi.on("session_shutdown", async (event, ctx) => {
    // A nested `pi -p` extraction inherits this marker. Never let that child
    // invoke Cortex's shutdown pipeline again (or emit a second empty-path error).
    if (event.reason === "reload" || process.env.CORTEX_EXTRACTING === "1") return;

    const cwd = ctx.cwd;
    const transcriptPath = ctx.sessionManager.getSessionFile() ?? sessionFile;
    const extractionSessionId = ctx.sessionManager.getSessionId() ?? sessionId ?? "unknown";
    const llmEnv = getCortexLlmEnvironment(
      ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : activeModel,
    );

    // Persistent sessions have a JSONL transcript. In-memory/ephemeral Pi
    // sessions do not, so skip only extraction rather than passing an empty
    // path through to the engine and producing an ENOENT error.
    let extractResult = "";
    if (transcriptPath && existsSync(transcriptPath)) {
      const hookInput = JSON.stringify({
        session_id: extractionSessionId,
        transcript_path: transcriptPath,
        cwd,
      });
      extractResult = runCli(["extract"], {
        stdin: hookInput,
        timeout: 60_000,
        cwd,
        env: llmEnv,
      });
    } else {
      process.stderr.write("[cortex] No persisted Pi session transcript; extraction skipped\n");
    }

    // Step 2: Backfill embeddings
    if (extractResult) {
      runCli(["backfill", cwd], { timeout: 30_000, cwd });
    }

    // Step 3: Semantic edges (fire-and-forget)
    runCliDetached(["semantic-edges", cwd], { cwd, env: llmEnv });

    // Step 4: Generate push surface
    runCli(["generate", cwd], { timeout: 30_000, cwd });

    // Step 5: Lifecycle prune (fire-and-forget)
    runCliDetached(["lifecycle", cwd, "--if-needed"], { cwd });

    // Step 6: AI prune (fire-and-forget)
    runCliDetached(["ai-prune", cwd, "--if-needed"], { cwd });
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
