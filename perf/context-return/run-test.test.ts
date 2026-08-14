import { EventEmitter } from "node:events";
import type { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildAssertions, runPi } from "./run-test.ts";

function fakeChild(kill: (signal: NodeJS.Signals) => boolean) {
	return Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill,
	});
}

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
