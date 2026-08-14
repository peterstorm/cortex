/**
 * Probe extension for the context-return test.
 *
 * Registers a single custom tool, `subagent_probe`, that simulates a real
 * subagent the way pi extensions do it in production: the "subagent" runs in
 * an isolated context and makes its own, independent request to the LLM
 * backend. Here the request goes straight to the stub vLLM server (marked
 * with the "[subagent]" system marker so the stub classifies it as subagent
 * traffic), and its answer is returned as the tool result.
 *
 * No other extension features are used — the whole point is that the parent
 * session must carry its own context across this tool call without help.
 */
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const STUB_URL = process.env.STUB_URL ?? "http://127.0.0.1:8799/v1";
const MAX_FAILURE_DIAGNOSTIC_CHARS = 200;
const PROBE_TIMEOUT_MS = 10_000;

function boundedFailureDiagnostic(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(0, MAX_FAILURE_DIAGNOSTIC_CHARS);
}

export default function registerContextReturnProbe(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "subagent_probe",
		label: "Subagent Probe",
		description: "Simulates a subagent: runs an isolated LLM request against the backend and returns its answer.",
		promptSnippet: "Call subagent_probe to simulate running a subagent",
		promptGuidelines: ["Use subagent_probe when asked to run a subagent."],
		parameters: Type.Object({
			echo: Type.String({ description: "Payload to echo through the subagent" }),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, _ctx): Promise<AgentToolResult> {
			let subagentText = "(subagent request failed)";
			let failure: string | null = null;
			const requestController = new AbortController();
			const cancelRequest = (): void => {
				requestController.abort(signal.reason ?? new Error("subagent probe cancelled"));
			};
			if (signal.aborted) cancelRequest();
			else signal.addEventListener("abort", cancelRequest, { once: true });
			const timeout = setTimeout(() => {
				requestController.abort(new Error(`subagent probe timed out after ${PROBE_TIMEOUT_MS}ms`));
			}, PROBE_TIMEOUT_MS);

			try {
				const res = await fetch(`${STUB_URL}/chat/completions`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						authorization: "Bearer test-key",
					},
					body: JSON.stringify({
						model: "stub-model",
						stream: false,
						messages: [
							{
								role: "system",
								content: "[subagent] You are a subagent with an isolated context window.",
							},
							{ role: "user", content: `Echo this payload back: ${params.echo}` },
						],
					}),
					signal: requestController.signal,
				});
				if (!res.ok) {
					throw new Error(`HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ""}`);
				}
				const data = (await res.json()) as {
					choices?: Array<{ message?: { content?: string | null } }>;
				};
				subagentText = data.choices?.[0]?.message?.content ?? "(empty subagent response)";
			} catch (error) {
				failure = boundedFailureDiagnostic(error);
				subagentText = `(subagent request failed: ${failure})`;
			} finally {
				clearTimeout(timeout);
				signal.removeEventListener("abort", cancelRequest);
			}
			return {
				content: [{ type: "text", text: `Subagent returned: ${subagentText}` }],
				details: { simulated: true, subagentText, ...(failure === null ? {} : { failure }) },
			};
		},
	});
}
