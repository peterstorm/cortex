/**
 * The engine-CLI subprocess boundary, as an owned port plus its real adapter.
 *
 * The extension used to call `execFileSync`/`spawn` from `node:child_process`
 * directly, which left its tests with nothing to intercept but the vendor
 * module itself — `vi.mock('node:child_process', ...)`. That seam is sensitive
 * to hoisting differences between vitest and bun's vitest shim, and it has
 * killed the whole extension suite at import twice (fixed in 153e032, reverted
 * in e1b26f3): every test in the file silently stopped running.
 *
 * With the boundary owned here, the extension depends on a two-method
 * interface that a plain object satisfies, so its tests need no mocking
 * framework at all. `node:child_process` is reached from exactly one place —
 * `nodeCliRunner` below — and the process-level details it owns (the log file,
 * stdio wiring, detachment) stay behind it.
 */

import { closeSync, mkdirSync, openSync } from "node:fs";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";

export type CliRunResult =
  | Readonly<{ ok: true; output: string }>
  | Readonly<{ ok: false; error: string }>;

export type CliRunOptions = Readonly<{
  stdin?: string;
  timeout?: number;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}>;

export type CliDetachedOptions = Readonly<{
  stdin?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}>;

/**
 * How the extension reaches the engine. Both methods are total: neither
 * throws, because a Pi lifecycle hook must never be blocked by a broken
 * engine, and a failure that cannot be seen is worse than one that is
 * reported.
 */
export type CliRunner = Readonly<{
  /** Run to completion and retain failure identity. */
  run(args: readonly string[], options?: CliRunOptions): CliRunResult;
  /** Fire and forget: the caller never awaits the child. */
  runDetached(args: readonly string[], options?: CliDetachedOptions): void;
}>;

/** One message shape for a caught unknown, used at every catch site here. */
export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Build the real adapter for a resolved CLI entrypoint.
 *
 * @param cliPath - Absolute path to the engine's cli.ts
 * @param baseEnv - Environment every child inherits on top of process.env
 */
export function nodeCliRunner(cliPath: string, baseEnv: NodeJS.ProcessEnv): CliRunner {
  // One env builder for both methods: they differ in how they start a child,
  // never in what environment it gets, and two copies of this spread is how a
  // variable ends up passed to one path and not the other.
  const childEnv = (overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({
    ...process.env,
    ...baseEnv,
    ...overrides,
  });

  return {
    run(args, options) {
      try {
        const output = execFileSync("bun", [cliPath, ...args], {
          input: options?.stdin ?? "",
          timeout: options?.timeout ?? 30_000,
          cwd: options?.cwd,
          encoding: "utf-8",
          env: childEnv(options?.env),
        }).trim();
        return { ok: true, output };
      } catch (error) {
        // Never block the Pi lifecycle, but preserve enough bounded diagnostics
        // to distinguish "no data" from a broken runtime or engine command.
        const failure = error as Error & {
          status?: number;
          signal?: string;
          code?: string;
          stderr?: Buffer | string;
        };
        const message = failure.message ?? String(error);
        const stderr = String(failure.stderr ?? "").trim().slice(0, 1_000);
        // Timeouts are identified by `code`, not by scanning the message: the
        // runtime spells this "ETIMEDOUT", which does NOT contain the substring
        // "TIMEOUT", so the message test this replaces never once matched and
        // every timeout was reported through the generic branch.
        const diagnostic = failure.code === "ETIMEDOUT"
          ? `CLI timeout: ${args.join(" ")} (cwd=${options?.cwd ?? process.cwd()})`
          : `CLI failed: bun ${args.join(" ")} ` +
            `(cwd=${options?.cwd ?? process.cwd()}, status=${failure.status ?? "n/a"}, ` +
            `signal=${failure.signal ?? "none"}): ${message}` +
            (stderr === "" ? "" : `\n${stderr}`);
        process.stderr.write(`[cortex] ${diagnostic}\n`);
        return { ok: false, error: diagnostic };
      }
    },

    runDetached(args, options) {
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
            `${describeError(error)}; inheriting output\n`
        );
      }

      try {
        const proc = spawn("bun", [cliPath, ...args], {
          stdio: options?.stdin
            ? ["pipe", outputTarget, outputTarget]
            : ["ignore", outputTarget, outputTarget],
          detached: true,
          cwd: options?.cwd,
          env: childEnv(options?.env),
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
          `[cortex] detached CLI setup failed for ${args.join(" ")}: ${describeError(error)}\n`
        );
      } finally {
        if (logFd !== undefined) closeSync(logFd);
      }
    },
  };
}
