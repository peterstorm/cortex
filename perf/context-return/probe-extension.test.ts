import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import registerContextReturnProbe from "./probe-extension.ts";

type RegisteredProbe = {
	execute: (
		toolCallId: string,
		params: { echo: string },
		signal: AbortSignal,
		onUpdate: undefined,
		context: unknown,
	) => Promise<AgentToolResult>;
};

function captureProbe(): RegisteredProbe {
	let registered: RegisteredProbe | null = null;
	registerContextReturnProbe({
		registerTool(tool: RegisteredProbe) {
			registered = tool;
		},
	} as unknown as ExtensionAPI);
	if (registered === null) throw new Error("probe tool was not registered");
	return registered;
}

async function executeProbe(signal: AbortSignal = new AbortController().signal): Promise<AgentToolResult> {
	return captureProbe().execute(
		"tool-call-1",
		{ echo: "hello" },
		signal,
		undefined,
		{},
	);
}

const originalFetch = globalThis.fetch;

afterEach(() => {
	vi.useRealTimers();
	globalThis.fetch = originalFetch;
});

describe("subagent_probe failure diagnostics", () => {
	it("returns the fetch failure while keeping the tool result usable", async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(
			new Error("ECONNREFUSED stub backend"),
		) as unknown as typeof fetch;

		const result = await executeProbe();
		const details = result.details as { failure?: string; subagentText: string };

		expect(details.failure).toBe("ECONNREFUSED stub backend");
		expect(details.subagentText).toContain("subagent request failed: ECONNREFUSED stub backend");
		expect(result.content).toEqual([
			{ type: "text", text: expect.stringContaining("ECONNREFUSED stub backend") },
		]);
	});

	it("reports non-success HTTP status without trying to parse the response", async () => {
		const json = vi.fn();
		globalThis.fetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 503,
			statusText: "Service Unavailable",
			json,
		}) as unknown as typeof fetch;

		const result = await executeProbe();
		const details = result.details as { failure?: string };

		expect(details.failure).toBe("HTTP 503 Service Unavailable");
		expect(json).not.toHaveBeenCalled();
	});

	it("propagates tool cancellation to the in-flight request", async () => {
		const controller = new AbortController();
		globalThis.fetch = vi.fn((_input, init) => new Promise((_resolve, reject) => {
			const requestSignal = init?.signal;
			if (!requestSignal) throw new Error("missing request signal");
			requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
		})) as unknown as typeof fetch;

		const pending = executeProbe(controller.signal);
		controller.abort(new Error("operator cancelled probe"));
		const result = await pending;
		const details = result.details as { failure?: string };

		expect(details.failure).toBe("operator cancelled probe");
	});

	it("times out a stalled backend request", async () => {
		vi.useFakeTimers();
		globalThis.fetch = vi.fn((_input, init) => new Promise((_resolve, reject) => {
			const requestSignal = init?.signal;
			if (!requestSignal) throw new Error("missing request signal");
			requestSignal.addEventListener("abort", () => reject(requestSignal.reason), { once: true });
		})) as unknown as typeof fetch;

		const pending = executeProbe();
		vi.advanceTimersByTime(10_000);
		const result = await pending;
		const details = result.details as { failure?: string };

		expect(details.failure).toBe("subagent probe timed out after 10000ms");
	});

	it("bounds diagnostics returned through tool content and details", async () => {
		globalThis.fetch = vi.fn().mockRejectedValue(
			new Error("x".repeat(500)),
		) as unknown as typeof fetch;

		const result = await executeProbe();
		const details = result.details as { failure?: string };

		expect(details.failure).toHaveLength(200);
	});
});
