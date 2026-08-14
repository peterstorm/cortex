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

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx): Promise<AgentToolResult> {
			let subagentText = "(subagent request failed)";
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
				});
				const data = (await res.json()) as {
					choices?: Array<{ message?: { content?: string | null } }>;
				};
				subagentText = data.choices?.[0]?.message?.content ?? "(empty subagent response)";
			} catch {
				// Keep the tool result usable; the test fails on missing traffic anyway.
			}
			return {
				content: [{ type: "text", text: `Subagent returned: ${subagentText}` }],
				details: { simulated: true, subagentText },
			};
		},
	});
}
