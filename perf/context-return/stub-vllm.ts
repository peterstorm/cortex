/**
 * Stub vLLM server for the context-return test.
 *
 * Emulates the parts of vLLM's OpenAI-compatible endpoint that matter for
 * prefix-cache semantics:
 *
 *   1. Stateless chat completions (SSE streamed, exactly like real vLLM).
 *   2. Automatic prefix caching: per request, `usage.prompt_tokens_details.
 *      cached_tokens` reports how many prompt tokens were served from a
 *      previously-seen prefix (rounded down to the vLLM block size, default
 *      16 tokens).
 *   3. A `/metrics` endpoint with vLLM-style prefix cache counters, and a
 *      `/requests` endpoint that dumps the full raw request log so tests can
 *      assert on what pi actually sent.
 *
 * The reply policy is script-like, mirroring the real pi<->vLLM loop:
 *
 *   - requests whose system prompt contains the "[subagent]" marker get a
 *     plain end_turn reply (these are the simulated subagent's own calls),
 *   - parent requests that contain a `tool` role get an end_turn reply,
 *   - any other parent request gets a `tool_calls` reply invoking the
 *     `subagent_probe` tool registered by probe-extension.ts.
 *
 * Tokenization is intentionally simple (whitespace + role/element markers).
 * It is deterministic, so prefix equality in the test suite is exact.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const BLOCK_SIZE = Number(process.env.STUB_BLOCK_SIZE ?? "16");
const SUBAGENT_MARKER = "[subagent]";

export type RequestKind = "parent" | "subagent";
export type ReplyKind = "tool_call" | "end_turn";

export interface RecordedRequest {
	/** Monotonic order index, starting at 0. */
	index: number;
	kind: RequestKind;
	reply: ReplyKind;
	/** Raw JSON body pi/subagent sent. */
	messages: unknown[];
	/** Full raw body (includes tools, stream options, etc.). */
	rawBody: unknown;
	promptTokens: number;
	cachedTokens: number;
	/** Number of tokens of the longest previously-seen prefix (pre-rounding). */
	rawLcpTokens: number;
	at: string;
}

interface StubState {
	requests: RecordedRequest[];
	/** Token sequence of every request seen so far (for LCP computation). */
	seen: string[][];
	/** Total cached tokens served (vLLM: vllm:prefix_cache_hit). */
	prefixCacheHitTokens: number;
	/** Total prompt tokens processed (vLLM: vllm:num_prefix_tokens). */
	numPrefixTokens: number;
}

const state: StubState = { requests: [], seen: [], prefixCacheHitTokens: 0, numPrefixTokens: 0 };

/* ------------------------------------------------------------------ */
/* Tokenization                                                         */
/* ------------------------------------------------------------------ */

function tokenize(text: string): string[] {
	return text.split(/\s+/).filter(Boolean);
}

/**
 * Deterministic token stream for one chat message. The exact mapping doesn't
 * matter — what matters is that equal messages always produce equal tokens,
 * so the prefix-cache LCP math is exact.
 */
function messageTokens(message: Record<string, unknown>): string[] {
	const tokens: string[] = [];
	const role = typeof message.role === "string" ? message.role : "?";
	tokens.push(`<|role:${role}|>`);
	const content = message.content;
	if (typeof content === "string") {
		tokens.push(...tokenize(content));
	} else if (Array.isArray(content)) {
		for (const part of content) tokens.push(...tokenize(JSON.stringify(part)));
	}
	if (message.tool_calls !== undefined) {
		tokens.push(...tokenize(JSON.stringify(message.tool_calls)));
	}
	if (typeof message.tool_call_id === "string") {
		tokens.push(`<|tool_call_id:${message.tool_call_id}|>`);
	}
	tokens.push("<|end|>");
	return tokens;
}

function promptTokens(messages: unknown[]): string[] {
	return messages.flatMap((m) => messageTokens(m as Record<string, unknown>));
}

/** Longest common prefix length of two token sequences. */
function lcp(a: string[], b: string[]): number {
	const n = Math.min(a.length, b.length);
	let i = 0;
	while (i < n && a[i] === b[i]) i++;
	return i;
}

/* ------------------------------------------------------------------ */
/* vLLM-style prefix cache                                              */
/* ------------------------------------------------------------------ */

function computeCachedTokens(tokens: string[]): { cached: number; rawLcp: number } {
	let rawLcp = 0;
	for (const prior of state.seen) {
		rawLcp = Math.max(rawLcp, lcp(tokens, prior));
	}
	// vLLM hashes cache in fixed token blocks; a prefix only hits when the
	// block hash chain matches, so the cached portion is floor(lcp/block)*block.
	return { cached: Math.floor(rawLcp / BLOCK_SIZE) * BLOCK_SIZE, rawLcp };
}

/* ------------------------------------------------------------------ */
/* Reply policy                                                         */
/* ------------------------------------------------------------------ */

function classify(messages: unknown[]): { kind: RequestKind; reply: ReplyKind } {
	const sys = messages.find(
		(m) =>
			(m as Record<string, unknown>).role === "system" &&
			typeof (m as Record<string, unknown>).content === "string" &&
			((m as Record<string, unknown>).content as string).includes(SUBAGENT_MARKER),
	);
	if (sys) return { kind: "subagent", reply: "end_turn" };
	const hasToolRole = messages.some((m) => (m as Record<string, unknown>).role === "tool");
	return { kind: "parent", reply: hasToolRole ? "end_turn" : "tool_call" };
}

/* ------------------------------------------------------------------ */
/* SSE helpers                                                          */
/* ------------------------------------------------------------------ */

function sse(res: ServerResponse, obj: Record<string, unknown>): void {
	res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

function usageChunk(promptTokens: number, cachedTokens: number, completionTokens: number): Record<string, unknown> {
	return {
		id: "chatcmpl-stub",
		object: "chat.completion.chunk",
		created: 0,
		model: "stub-model",
		choices: [],
		usage: {
			prompt_tokens: promptTokens,
			completion_tokens: completionTokens,
			total_tokens: promptTokens + completionTokens,
			prompt_tokens_details: { cached_tokens: cachedTokens },
		},
	};
}

function toolCallChunk(id: string, name: string, args: string): Record<string, unknown> {
	return {
		id: "chatcmpl-stub",
		object: "chat.completion.chunk",
		created: 0,
		model: "stub-model",
		choices: [
			{
				index: 0,
				delta: {
					role: "assistant",
					content: "",
					tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: args } }],
				},
				finish_reason: null,
			},
		],
	};
}

function textChunk(id: string, text: string): Record<string, unknown> {
	return {
		id: "chatcmpl-stub",
		object: "chat.completion.chunk",
		created: 0,
		model: "stub-model",
		choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
	};
}

function finishChunk(id: string, finishReason: string): Record<string, unknown> {
	return {
		id: "chatcmpl-stub",
		object: "chat.completion.chunk",
		created: 0,
		model: "stub-model",
		choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
	};
}

/* ------------------------------------------------------------------ */
/* HTTP handler                                                         */
/* ------------------------------------------------------------------ */

async function readBody(req: IncomingMessage): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks).toString("utf-8");
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

async function handleCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
	const rawBody = await readBody(req);
	let body: Record<string, unknown>;
	try {
		body = JSON.parse(rawBody) as Record<string, unknown>;
	} catch {
		sendJson(res, 400, { error: { message: "invalid json" } });
		return;
	}

	const messages = Array.isArray(body.messages) ? (body.messages as unknown[]) : [];
	const { kind, reply } = classify(messages);
	const tokens = promptTokens(messages);
	const { cached, rawLcp } = computeCachedTokens(tokens);

	const record: RecordedRequest = {
		index: state.requests.length,
		kind,
		reply,
		messages,
		rawBody: body,
		promptTokens: tokens.length,
		cachedTokens: cached,
		rawLcpTokens: rawLcp,
		at: new Date().toISOString(),
	};
	state.requests.push(record);
	state.seen.push(tokens);
	state.numPrefixTokens += tokens.length;
	state.prefixCacheHitTokens += cached;

	const wantsStream = body.stream !== false;
	const completionTokens = 4;
	const id = "chatcmpl-stub";

	if (!wantsStream) {
		const finishReason = reply === "tool_call" ? "tool_calls" : "stop";
		const message: Record<string, unknown> = { role: "assistant", content: "" };
		if (reply === "tool_call") {
			message.tool_calls = [
				{
					id: "call_subagent_probe",
					type: "function",
					function: { name: "subagent_probe", arguments: JSON.stringify({ echo: "hello subagent" }) },
				},
			];
		} else {
			message.content = kind === "subagent" ? "echo:hello subagent (subagent)" : "SUBAGENT_DONE";
		}
		sendJson(res, 200, {
			id,
			object: "chat.completion",
			created: 0,
			model: "stub-model",
			choices: [{ index: 0, message, finish_reason: finishReason }],
			usage: {
				prompt_tokens: tokens.length,
				completion_tokens: completionTokens,
				total_tokens: tokens.length + completionTokens,
				prompt_tokens_details: { cached_tokens: cached },
			},
		});
		return;
	}

	res.writeHead(200, {
		"content-type": "text/event-stream; charset=utf-8",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});

	sse(res, {
		id,
		object: "chat.completion.chunk",
		created: 0,
		model: "stub-model",
		choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
	});

	if (reply === "tool_call") {
		sse(res, toolCallChunk("call_subagent_probe", "subagent_probe", JSON.stringify({ echo: "hello subagent" })));
		sse(res, finishChunk(id, "tool_calls"));
	} else {
		sse(res, textChunk(id, kind === "subagent" ? "echo:hello subagent (subagent)" : "SUBAGENT_DONE"));
		sse(res, finishChunk(id, "stop"));
	}

	sse(res, usageChunk(tokens.length, cached, completionTokens));
	res.write("data: [DONE]\n\n");
	res.end();
}

/* ------------------------------------------------------------------ */
/* Server lifecycle                                                     */
/* ------------------------------------------------------------------ */

let server: ReturnType<typeof createServer> | null = null;
let url: string | null = null;

export async function startStub(): Promise<string> {
	state.requests = [];
	state.seen = [];
	state.prefixCacheHitTokens = 0;
	state.numPrefixTokens = 0;

	server = createServer(async (req, res) => {
		const path = (req.url ?? "/").split("?")[0];
		try {
			if (req.method === "POST" && path === "/v1/chat/completions") {
				await handleCompletions(req, res);
			} else if (req.method === "GET" && path === "/v1/models") {
				sendJson(res, 200, { object: "list", data: [{ id: "stub-model", object: "model" }] });
			} else if (req.method === "GET" && path === "/metrics") {
				const text = [
					"# vLLM-style prefix cache metrics (emulated)",
					`vllm:prefix_cache_hit ${state.prefixCacheHitTokens}`,
					`vllm:num_prefix_tokens ${state.numPrefixTokens}`,
					`vllm:num_cached_tokens ${state.prefixCacheHitTokens}`,
					`stub_block_size ${BLOCK_SIZE}`,
					"",
				].join("\n");
				res.writeHead(200, { "content-type": "text/plain" });
				res.end(text);
			} else if (req.method === "GET" && path === "/requests") {
				sendJson(res, 200, state.requests);
			} else {
				sendJson(res, 404, { error: { message: `not found: ${path}` } });
			}
		} catch (err) {
			sendJson(res, 500, { error: { message: String(err) } });
		}
	});

	await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("stub failed to bind");
	url = `http://127.0.0.1:${(address as { port: number }).port}`;
	return url;
}

export async function stopStub(): Promise<void> {
	if (!server) return;
	const s = server;
	server = null;
	url = null;
	await new Promise<void>((resolve) => s.close(() => resolve()));
}

export function getStubState(): Readonly<StubState> {
	return state;
}

export { BLOCK_SIZE };

/* ------------------------------------------------------------------ */
/* Direct invocation: `bun stub-vllm.ts` listens on $STUB_PORT (8799)   */
/* ------------------------------------------------------------------ */

if (import.meta.main) {
	await startStub();
	const port = Number(process.env.STUB_PORT ?? "8799");
	// startStub binds an ephemeral port; re-bind by creating the listener anew.
	if (server) {
		await stopStub();
	}
	state.requests = [];
	state.seen = [];
	state.prefixCacheHitTokens = 0;
	state.numPrefixTokens = 0;
	server = createServer(async (req, res) => {
		const path = (req.url ?? "/").split("?")[0];
		try {
			if (req.method === "POST" && path === "/v1/chat/completions") {
				await handleCompletions(req, res);
			} else if (req.method === "GET" && path === "/v1/models") {
				sendJson(res, 200, { object: "list", data: [{ id: "stub-model", object: "model" }] });
			} else if (req.method === "GET" && path === "/metrics") {
				const text = [
					"# vLLM-style prefix cache metrics (emulated)",
					`vllm:prefix_cache_hit ${state.prefixCacheHitTokens}`,
					`vllm:num_prefix_tokens ${state.numPrefixTokens}`,
					`vllm:num_cached_tokens ${state.prefixCacheHitTokens}`,
					`stub_block_size ${BLOCK_SIZE}`,
					"",
				].join("\n");
				res.writeHead(200, { "content-type": "text/plain" });
				res.end(text);
			} else if (req.method === "GET" && path === "/requests") {
				sendJson(res, 200, state.requests);
			} else {
				sendJson(res, 404, { error: { message: `not found: ${path}` } });
			}
		} catch (err) {
			sendJson(res, 500, { error: { message: String(err) } });
		}
	});
	await new Promise<void>((resolve) => server!.listen(port, "127.0.0.1", resolve));
	process.stdout.write(`stub-vllm listening on http://127.0.0.1:${port}\n`);
}
