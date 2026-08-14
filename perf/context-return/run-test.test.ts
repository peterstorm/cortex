import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { RecordedRequest } from "./stub-vllm.ts";
import { buildAssertions, runPi } from "./run-test.ts";

function fakeChild(kill: (signal: NodeJS.Signals) => boolean) {
	return Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill,
	});
}

describe("buildAssertions context-return proof", () => {
	it("accepts a valid parent, isolated subagent, and cached parent resume trace", () => {
		const parentMessages = [
			{ role: "system", content: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty" },
			{ role: "user", content: "run the probe and then restore all parent context" },
		];
		const requests: RecordedRequest[] = [
			{
				index: 0,
				kind: "parent",
				reply: "tool_call",
				messages: parentMessages,
				rawBody: {},
				promptTokens: 33,
				cachedTokens: 0,
				rawLcpTokens: 0,
				at: "2026-08-14T00:00:00.000Z",
			},
			{
				index: 1,
				kind: "subagent",
				reply: "end_turn",
				messages: [
					{ role: "system", content: "[subagent] isolated context" },
					{ role: "user", content: "echo hello" },
				],
				rawBody: {},
				promptTokens: 9,
				cachedTokens: 0,
				rawLcpTokens: 0,
				at: "2026-08-14T00:00:01.000Z",
			},
			{
				index: 2,
				kind: "parent",
				reply: "end_turn",
				messages: [
					...parentMessages,
					{ role: "assistant", tool_calls: [{ id: "probe-1", function: { name: "subagent_probe", arguments: "{}" } }] },
					{ role: "tool", tool_call_id: "probe-1", content: "Subagent returned: hello" },
				],
				rawBody: {},
				promptTokens: 42,
				cachedTokens: 32,
				rawLcpTokens: 33,
				at: "2026-08-14T00:00:02.000Z",
			},
		];
		const piStdout = `${JSON.stringify({
			type: "message_end",
			message: { usage: { input: 42, output: 3, cacheRead: 32 } },
		})}\n`;

		const assertions = buildAssertions(requests, piStdout, 0, "", {
			signal: null,
			timedOut: false,
		});

		expect(assertions).toHaveLength(7);
		expect(assertions.every((assertion) => assertion.pass)).toBe(true);
	});
});

describe("runPi process diagnostics", () => {
	it("preserves spawn errors instead of reporting only a null exit code", async () => {
		const child = fakeChild(() => false);
		const spawnError = (() => {
			queueMicrotask(() => child.emit("error", Object.assign(new Error("spawn fake-pi ENOENT"), { code: "ENOENT" })));
			return child;
		}) as unknown as typeof spawn;

		const result = await runPi([], {}, "/tmp", 1_000, "fake-pi", spawnError);

		expect(result).toMatchObject({
			code: null,
			signal: null,
			timedOut: false,
		});
		expect(result.error).toContain("ENOENT");

		const exitAssertion = buildAssertions([], "", result.code, result.stderr, result)[0];
		expect(exitAssertion.detail).toContain("spawn error");
		expect(exitAssertion.detail).toContain("ENOENT");
	});

	it("distinguishes a timeout from a generic null exit", async () => {
		let child: ReturnType<typeof fakeChild>;
		child = fakeChild((signal) => {
			queueMicrotask(() => child.emit("close", null, signal));
			return true;
		});
		const hangingSpawn = (() => child) as unknown as typeof spawn;

		const result = await runPi([], {}, "/tmp", 10, "fake-pi", hangingSpawn);

		expect(result.code).toBeNull();
		expect(result.timedOut).toBe(true);
		expect(result.signal).toBe("SIGKILL");
		expect(result.error).toBeUndefined();

		const exitAssertion = buildAssertions([], "", result.code, result.stderr, result)[0];
		expect(exitAssertion.detail).toContain("timed out");
		expect(exitAssertion.detail).toContain("SIGKILL");
	});
});
