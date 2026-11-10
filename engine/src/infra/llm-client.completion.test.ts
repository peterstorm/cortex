/**
 * chatCompletion: the completion plus the identity of the model that
 * answered and its token usage. fetch is stubbed; no network is touched.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { chatCompletion, resetServedModelCheck, type LlmEndpoint } from './llm-client.js';

const endpoint: LlmEndpoint = { baseUrl: 'http://llm.example/v1', apiKey: 'secret', model: 'requested' };
const original = globalThis.fetch;

function respond(body: Record<string, unknown>): void {
  globalThis.fetch = (async (url: string | URL) =>
    String(url).endsWith('/models')
      ? new Response(JSON.stringify({ data: [] }), { status: 200 })
      : new Response(JSON.stringify(body), { status: 200 })) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = original;
  resetServedModelCheck();
});

describe('chatCompletion', () => {
  it('reports the model the provider says answered, and its token usage', async () => {
    respond({
      model: 'glm-5.3-flash-v15',
      usage: { prompt_tokens: 1234, completion_tokens: 56 },
      choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }],
    });
    expect(await chatCompletion(endpoint, 'p')).toEqual({
      content: 'hi',
      model: 'glm-5.3-flash-v15',
      promptTokens: 1234,
      completionTokens: 56,
    });
  });

  it('falls back to the requested model and unknown usage when the provider omits them', async () => {
    respond({ usage: { prompt_tokens: -1 }, choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }] });
    expect(await chatCompletion(endpoint, 'p')).toEqual({
      content: 'hi',
      model: 'requested',
      promptTokens: null,
      completionTokens: null,
    });
  });
});
