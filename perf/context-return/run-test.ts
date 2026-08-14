/**
 * Context-return integration test for pi + vLLM-style backends.
 *
 * Verifies the property: when a subagent finishes, the parent agent's context
 * is "given back" to the backend — the continuation request pi sends after
 * the subagent tool result (a) re-sends the complete pre-subagent
 * conversation as a prefix, and (b) is served from the backend's prefix
 * cache (vLLM `prompt_tokens_details.cached_tokens` ≈ full parent prefix).
 *
 * Flow (all against a hermetic stub vLLM server):
 *
 *   req 1  parent   [system, user]                    -> stub replies tool_call(subagent_probe)
 *   req 2  subagent [system[subagent], user]          -> simulated subagent's own isolated call
 *   req 3  parent   [system, user, tool, tool result] -> stub replies end_turn
 *
 * Run:  bun run perf/context-return/run-test.ts
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startStub, stopStub, getStubState, BLOCK_SIZE, type RecordedRequest } from "./stub-vllm.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const PI_BIN = process.env.PI_BIN ?? join(REPO_ROOT, "node_modules", ".bin", "pi");

export interface AssertionResult {
	name: string;
	pass: boolean;
	detail: string;
}

export interface ContextReturnReport {
	assertions: AssertionResult[];
	requests: readonly RecordedRequest[];
	piStdout: string;
	piStderr: string;
}

function assertState(name: string, pass: boolean, detail: string): AssertionResult {
	return { name, pass, detail };
}

function tokenCount(messages: unknown[]): number {
	let count = 0;
	for (const m of messages as Array<Record<string, unknown>>) {
		count += 1; // role marker
		for (const key of ["content", "tool_calls", "tool_call_id"] as const) {
			if (m[key] === undefined) continue;
			const text = typeof m[key] === "string" ? m[key] : JSON.stringify(m[key]);
			count += text.split(/\s+/).filter(Boolean).length;
			if (key === "tool_call_id") count += 1; // marker
		}
		count += 1; // end marker
	}
	return count;
}

function parsePiEvents(stdout: string): Array<{ type: string; message?: { usage?: { cacheRead?: number; input?: number; output?: number } } }> {
	const events: Array<{ type: string; message?: { usage?: { cacheRead?: number; input?: number; output?: number } } }> = [];
	for (const line of stdout.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const parsed = JSON.parse(trimmed) as { type: string };
			if (parsed && typeof parsed.type === "string") events.push(parsed as never);
		} catch {
			// pi emits non-JSON log lines (version banner, footers) — ignore.
		}
	}
	return events;
}

function runPi(args: string[], env: NodeJS.ProcessEnv, cwd: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null }> {
	return new Promise((resolvePromise) => {
		const child = spawn(PI_BIN, args, {
			// stdin must be closed: pi -p reads stdin until EOF (it supports `echo x | pi`),
			// so an inherited open pipe hangs startup forever.
			stdio: ["ignore", "pipe", "pipe"],
			env,
			cwd,
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d: Buffer) => {
			stdout += d.toString("utf-8");
		});
		child.stderr.on("data", (d: Buffer) => {
			stderr += d.toString("utf-8");
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
		}, timeoutMs);
		child.on("error", (err) => {
			clearTimeout(timer);
			resolvePromise({ stdout, stderr, code: null });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ stdout, stderr, code });
		});
	});
}

export async function runContextReturnTest(opts: { timeoutMs?: number; prompt?: string } = {}): Promise<ContextReturnReport> {
	const timeoutMs = opts.timeoutMs ?? 120_000;
	const prompt = opts.prompt ?? `Run the subagent_probe tool with echo "hello subagent". After the subagent returns, reply with exactly one line: SUBAGENT_DONE`;

	const stubUrl = await startStub();

	const workDir = await mkdtemp(join(tmpdir(), "ctx-return-"));
	const agentDir = join(workDir, "pi-agent");
	const runCwd = join(workDir, "cwd");
	await mkdir(agentDir, { recursive: true });
	await mkdir(runCwd, { recursive: true });

	const modelsJson = {
		providers: {
			local: {
				baseUrl: `${stubUrl}/v1`,
				api: "openai-completions",
				apiKey: "test-key",
				compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
				models: [
					{
						id: "stub-model",
						name: "Stub vLLM",
						reasoning: false,
						contextWindow: 128000,
						maxTokens: 4096,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					},
				],
			},
		},
	};
	await writeFile(join(agentDir, "models.json"), JSON.stringify(modelsJson, null, 2), "utf-8");

	const extensionPath = join(HERE, "probe-extension.ts");

	let piStdout = "";
	let piStderr = "";
	try {
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PI_CODING_AGENT_DIR: agentDir,
			STUB_URL: `${stubUrl}/v1`,
			PI_OFFLINE: "1",
			NO_COLOR: "1",
			HOME: workDir,
			ANTHROPIC_API_KEY: "",
			OPENAI_API_KEY: "",
		};

		const args = [
			"--mode", "json",
			"-p",
			"--no-session",
			"--model", "local/stub-model",
			"--api-key", "test-key",
			"--extension", extensionPath,
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
			"--no-builtin-tools",
			"--tools", "subagent_probe",
			prompt,
		];

		const run = await runPi(args, env, runCwd, timeoutMs);
		piStdout = run.stdout;
		piStderr = run.stderr;

		const requests = getStubState().requests;
		const assertions = buildAssertions(requests, piStdout, run.code, piStderr);
		return { assertions, requests, piStdout, piStderr };
	} finally {
		await stopStub();
		await rm(workDir, { recursive: true, force: true });
	}
}

export function buildAssertions(
	requests: readonly RecordedRequest[],
	piStdout: string,
	piExitCode: number | null,
	piStderr: string,
): AssertionResult[] {
	const out: AssertionResult[] = [];

	const parents = requests.filter((r) => r.kind === "parent");
	const subagents = requests.filter((r) => r.kind === "subagent");
	const req1 = parents[0];
	const resume = parents.find((r) => r.reply === "end_turn" && r.messages.some((m) => (m as { role?: string }).role === "tool"));

	// A. pi exited cleanly and produced the expected request pattern.
	out.push(
		assertState(
			"pi exited 0",
			piExitCode === 0,
			piExitCode === 0 ? "clean exit" : `exit code ${piExitCode}; stderr: ${piStderr.slice(0, 400)}`,
		),
	);
	out.push(
		assertState(
			"request pattern is [parent, subagent, parent-resume]",
			requests.length === 3 && parents.length === 2 && subagents.length === 1,
			`${requests.length} request(s): ${requests.map((r) => r.kind).join(", ") || "(none)"}`,
		),
	);

	if (!req1 || !resume || subagents.length !== 1) {
		out.push(assertState("subagent request happened between the two parent requests", false, "missing requests; cannot verify"));
		return out;
	}
	const sub = subagents[0];

	// B. The subagent ran in between (ordering).
	out.push(
		assertState(
			"subagent request happened between the two parent requests",
			req1.index < sub.index && sub.index < resume.index,
			`indices: parent=${req1.index}, subagent=${sub.index}, resume=${resume.index}`,
		),
	);

	// C. Context is given back: the resume request re-sends the complete
	//    pre-subagent conversation with identical role/content sequence.
	const prefix = resume.messages.slice(0, req1.messages.length);
	const prefixEqual = JSON.stringify(prefix) === JSON.stringify(req1.messages);
	out.push(
		assertState(
			"resume request re-sends full parent context as a prefix",
			prefixEqual && resume.messages.length === req1.messages.length + 2,
			`req1 messages=${req1.messages.length}, resume messages=${resume.messages.length} (expect ${req1.messages.length}+2), prefix equal=${prefixEqual}`,
		),
	);

	// D. The backend's prefix cache serves the whole parent prefix on resume:
	//    cached_tokens == floor(parent prefix tokens / block) * block.
	//    This is the vLLM automatic-prefix-cache proof: the context was
	//    "given back" to the backend verbatim.
	const req1Tokens = tokenCount(req1.messages);
	const expectedCached = Math.floor(req1Tokens / BLOCK_SIZE) * BLOCK_SIZE;
	const cachedOk = resume.cachedTokens === expectedCached && expectedCached > 0;
	out.push(
		assertState(
			"vLLM prefix cache re-serves the entire parent context on resume",
			cachedOk,
			`cached_tokens=${resume.cachedTokens}, expected≈${expectedCached} (floor(${req1Tokens}/${BLOCK_SIZE})*${BLOCK_SIZE}), rawLcp=${resume.rawLcpTokens}`,
		),
	);

	// E. The subagent got an isolated context — no parent conversation leaked
	//    into it, and its own prefix was never cached before.
	out.push(
		assertState(
			"subagent receives isolated context (no parent leak)",
			tokenCount(sub.messages) < req1Tokens / 2 && sub.cachedTokens === 0,
			`subagent prompt tokens=${tokenCount(sub.messages)} vs parent ${req1Tokens}`,
		),
	);

	// F. pi itself surfaced the hand-back: the resume-turn assistant message
	//    reports cacheRead > 0 in its usage (mapped from the response's
	//    prompt_tokens_details.cached_tokens).
	const events = parsePiEvents(piStdout);
	const resumeUsages = events
		.filter((e) => e.type === "message_end")
		.map((e) => e.message?.usage)
		.filter((u): u is NonNullable<typeof u> => u !== undefined);
	const lastUsage = resumeUsages[resumeUsages.length - 1];
	const cacheRead = lastUsage?.cacheRead ?? 0;
	out.push(
		assertState(
			"pi records cacheRead>0 on the resume-turn assistant message",
			cacheRead > 0,
			`last message_end usage: ${JSON.stringify(lastUsage)}`,
		),
	);

	return out;
}

function report(r: ContextReturnReport): string {
	const rows = r.assertions.map((a, i) => `  ${a.pass ? "PASS" : "FAIL"}  [${i + 1}] ${a.name}\n       ${a.detail}`).join("\n");
	return rows;
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

async function main(): Promise<void> {
	let reportObj: ContextReturnReport;
	try {
		reportObj = await runContextReturnTest();
	} catch (err) {
		process.stdout.write(`SETUP FAILURE: ${(err as Error).stack ?? String(err)}\n`);
		process.exitCode = 1;
		return;
	}

	process.stdout.write("\nContext-return test — pi hands parent context back to (stub) vLLM\n");
	process.stdout.write("Requests seen by the backend:\n");
	for (const r of reportObj.requests) {
		process.stdout.write(
			`  req ${r.index}  kind=${r.kind.padEnd(8)} reply=${r.reply.padEnd(9)} messages=${r.messages.length} promptTokens=${r.promptTokens} cachedTokens=${r.cachedTokens}\n`,
		);
	}
	process.stdout.write("\nAssertions:\n");
	process.stdout.write(report(reportObj));
	process.stdout.write("\n");

	const failed = reportObj.assertions.filter((a) => !a.pass);
	process.stdout.write(failed.length === 0 ? "\nAll assertions passed.\n" : `\n${failed.length} assertion(s) failed.\n`);
	process.exitCode = failed.length === 0 ? 0 : 1;
}

if (import.meta.main) {
	await main();
}
