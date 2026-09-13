/**
 * Tests for the direct OpenAI-compatible LLM client.
 *
 * Endpoint resolution is exercised through the explicit env overrides and
 * through fixture ~/.pi/agent config (HOME redirected to a temp dir);
 * chatCompletionText uses a stubbed fetch so no network is ever touched.
 */

import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import {
  resolveOpenAiCompatEndpoint,
  chatCompletionText,
  type LlmEndpoint,
} from './llm-client.js';

const ENV_KEYS = ['CORTEX_LLM_API_URL', 'CORTEX_LLM_API_KEY', 'CORTEX_LLM_MODEL',
  'CORTEX_LLM_PROVIDER', 'CORTEX_PI_PROVIDER', 'CORTEX_PI_MODEL', 'PI_PROVIDER', 'PI_MODEL', 'HOME'];

function withEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete Bun.env[key];
    else Bun.env[key] = value;
  }
}

describe('resolveOpenAiCompatEndpoint', () => {
  let fixtureHome: string;

  beforeEach(() => {
    // Start every test from a clean env: Bun.env key deletion must happen
    // explicitly or stale values leak across cases.
    for (const key of ENV_KEYS) delete Bun.env[key];
    fixtureHome = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'cortex-llm-client-'));
  });

  afterAll(() => {
    withEnv(Object.fromEntries(ENV_KEYS.map((k) => [k, undefined])));
    fs.rmSync(fixtureHome, { recursive: true, force: true });
  });

  it('resolves from explicit env overrides and normalizes the base URL', () => {
    withEnv({
      CORTEX_LLM_API_URL: 'http://llm.example/v1/',
      CORTEX_LLM_API_KEY: 'secret',
      CORTEX_LLM_MODEL: 'fast-model',
      CORTEX_LLM_PROVIDER: undefined,
      PI_PROVIDER: undefined,
      HOME: fixtureHome,
    });

    const endpoint = resolveOpenAiCompatEndpoint();
    expect(endpoint).toEqual({ baseUrl: 'http://llm.example/v1', apiKey: 'secret', model: 'fast-model' });
  });

  it('normalizes a /chat/completions suffix out of the base URL', () => {
    withEnv({
      CORTEX_LLM_API_URL: 'http://llm.example/v1/chat/completions',
      CORTEX_LLM_API_KEY: 'secret',
      CORTEX_LLM_MODEL: 'm',
    });

    expect(resolveOpenAiCompatEndpoint()?.baseUrl).toBe('http://llm.example/v1');
  });

  it('returns null when env overrides are incomplete and no provider config exists', () => {
    withEnv({
      CORTEX_LLM_API_URL: 'http://llm.example/v1',
      CORTEX_LLM_API_KEY: undefined,
      CORTEX_LLM_MODEL: undefined,
      HOME: fixtureHome, // empty fixture — no ~/.pi config to fall back to
    });
    expect(resolveOpenAiCompatEndpoint()).toBeNull();
  });

  it('resolves from the pi provider config with a shell-command apiKey', () => {
    withEnv({
      CORTEX_LLM_API_URL: undefined,
      CORTEX_LLM_API_KEY: undefined,
      CORTEX_LLM_MODEL: undefined,
      CORTEX_LLM_PROVIDER: undefined,
      PI_PROVIDER: 'fixture-llm',
      HOME: fixtureHome,
    });
    fs.mkdirSync(nodePath.join(fixtureHome, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'models.json'), JSON.stringify({
      providers: {
        'fixture-llm': {
          baseUrl: 'http://fixture:9000/v1',
          apiKey: '!printf fixture-key',
          models: [{ id: 'fixture-model' }],
        },
      },
    }));
    fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'settings.json'), JSON.stringify({}));

    const endpoint = resolveOpenAiCompatEndpoint();
    expect(endpoint).toEqual({ baseUrl: 'http://fixture:9000/v1', apiKey: 'fixture-key', model: 'fixture-model' });
  });

  it('rejects non-OpenAI-compatible providers', () => {
    withEnv({ PI_PROVIDER: 'anthropic-fixture', HOME: fixtureHome });
    fs.mkdirSync(nodePath.join(fixtureHome, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'models.json'), JSON.stringify({
      providers: {
        'anthropic-fixture': { api: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k', models: [{ id: 'm' }] },
      },
    }));
    expect(resolveOpenAiCompatEndpoint()).toBeNull();
  });

  it.each(['anthropic-messages', 'openai-responses'])(
    'rejects Pi api adapter %s because it does not expose chat/completions',
    (api) => {
      withEnv({ PI_PROVIDER: 'incompatible', HOME: fixtureHome });
      fs.mkdirSync(nodePath.join(fixtureHome, '.pi', 'agent'), { recursive: true });
      fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'models.json'), JSON.stringify({
        providers: {
          incompatible: {
            api,
            baseUrl: 'https://provider.example/v1',
            apiKey: 'k',
            models: [{ id: 'm' }],
          },
        },
      }));

      expect(resolveOpenAiCompatEndpoint()).toBeNull();
    }
  );

  it('accepts Pi openai-completions providers', () => {
    withEnv({ PI_PROVIDER: 'compatible', HOME: fixtureHome });
    fs.mkdirSync(nodePath.join(fixtureHome, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'models.json'), JSON.stringify({
      providers: {
        compatible: {
          api: 'openai-completions',
          baseUrl: 'http://fixture:9000/v1',
          apiKey: 'k',
          models: [{ id: 'fixture-model' }],
        },
      },
    }));

    expect(resolveOpenAiCompatEndpoint()).toEqual({
      baseUrl: 'http://fixture:9000/v1',
      apiKey: 'k',
      model: 'fixture-model',
    });
  });

  it('warns and returns null when the configured provider lacks an apiKey', () => {
    withEnv({ PI_PROVIDER: 'keyless', HOME: fixtureHome });
    fs.mkdirSync(nodePath.join(fixtureHome, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'models.json'), JSON.stringify({
      providers: { keyless: { baseUrl: 'http://x/v1', models: [{ id: 'm' }] } },
    }));
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(resolveOpenAiCompatEndpoint()).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no apiKey/));
    warn.mockRestore();
  });

  it('warns when the configured provider is not defined', () => {
    withEnv({ PI_PROVIDER: 'ghost', HOME: fixtureHome });
    fs.mkdirSync(nodePath.join(fixtureHome, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'models.json'), JSON.stringify({
      providers: {},
    }));
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(resolveOpenAiCompatEndpoint()).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/provider 'ghost' is not defined/));
    warn.mockRestore();
  });

  it('warns when the configured provider has a non-http baseUrl', () => {
    withEnv({ PI_PROVIDER: 'no-http', HOME: fixtureHome });
    fs.mkdirSync(nodePath.join(fixtureHome, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'models.json'), JSON.stringify({
      providers: { 'no-http': { baseUrl: 'file:///tmp/x', apiKey: 'k', models: [{ id: 'm' }] } },
    }));
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(resolveOpenAiCompatEndpoint()).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no http baseUrl/));
    warn.mockRestore();
  });

  it('reports status and stderr when the provider apiKey command fails', () => {
    withEnv({ PI_PROVIDER: 'broken-key', HOME: fixtureHome });
    fs.mkdirSync(nodePath.join(fixtureHome, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'models.json'), JSON.stringify({
      providers: {
        'broken-key': {
          baseUrl: 'http://x/v1',
          apiKey: '!echo key-resolution-failed >&2; exit 3',
          models: [{ id: 'm' }],
        },
      },
    }));
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(resolveOpenAiCompatEndpoint()).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/status=3.*key-resolution-failed/));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/apiKey command resolved empty/));
    warn.mockRestore();
  });

  it('warns when the configured provider has no models[0].id', () => {
    withEnv({ PI_PROVIDER: 'modeless', HOME: fixtureHome });
    fs.mkdirSync(nodePath.join(fixtureHome, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'models.json'), JSON.stringify({
      providers: { modeless: { baseUrl: 'http://x/v1', apiKey: 'k', models: [] } },
    }));
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(resolveOpenAiCompatEndpoint()).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no models\[0\]\.id/));
    warn.mockRestore();
  });

  it('warns when models.json exists but is corrupt instead of silently disabling the direct path', () => {
    withEnv({ PI_PROVIDER: 'fixture-llm', HOME: fixtureHome });
    fs.mkdirSync(nodePath.join(fixtureHome, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'models.json'), '{ not valid json');
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(resolveOpenAiCompatEndpoint()).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not be read\/parsed/));
    warn.mockRestore();
  });

  it('warns when only part of the CORTEX_LLM_* override is set', () => {
    withEnv({
      CORTEX_LLM_API_URL: 'http://llm.example/v1',
      CORTEX_LLM_API_KEY: 'secret',
      CORTEX_LLM_MODEL: undefined,
      HOME: fixtureHome,
    });
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    expect(resolveOpenAiCompatEndpoint()).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/partial CORTEX_LLM_\* configuration/));
    warn.mockRestore();
  });

  it('lets an explicit CORTEX_LLM_PROVIDER override PI_PROVIDER (precedence)', () => {
    withEnv({ CORTEX_LLM_PROVIDER: 'fixture-llm', PI_PROVIDER: 'other-provider', HOME: fixtureHome });
    fs.mkdirSync(nodePath.join(fixtureHome, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'models.json'), JSON.stringify({
      providers: {
        'fixture-llm': { baseUrl: 'http://fixture:9000/v1', apiKey: 'k', models: [{ id: 'fixture-model' }] },
        'other-provider': { baseUrl: 'http://other:9000/v1', apiKey: 'k2', models: [{ id: 'other-model' }] },
      },
    }));
    fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'settings.json'), JSON.stringify({}));

    expect(resolveOpenAiCompatEndpoint()?.model).toBe('fixture-model');
  });

  it('uses the provider selected by the active Pi session before inherited PI_PROVIDER', () => {
    withEnv({
      CORTEX_LLM_PROVIDER: undefined,
      CORTEX_PI_PROVIDER: 'selected-provider',
      PI_PROVIDER: 'provider-at-start',
      HOME: fixtureHome,
    });
    fs.mkdirSync(nodePath.join(fixtureHome, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'models.json'), JSON.stringify({
      providers: {
        'selected-provider': { baseUrl: 'http://selected:9000/v1', apiKey: 'selected', models: [{ id: 'selected-model' }] },
        'provider-at-start': { baseUrl: 'http://initial:9000/v1', apiKey: 'initial', models: [{ id: 'initial-model' }] },
      },
    }));
    fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'settings.json'), JSON.stringify({}));

    expect(resolveOpenAiCompatEndpoint()?.model).toBe('selected-model');
  });

  it('prefers the active session model over models[0] for its own provider', () => {
    withEnv({
      PI_PROVIDER: 'compatible',
      PI_MODEL: 'session-model',
      HOME: fixtureHome,
    });
    fs.mkdirSync(nodePath.join(fixtureHome, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'models.json'), JSON.stringify({
      providers: {
        compatible: {
          api: 'openai-completions',
          baseUrl: 'http://fixture:9000/v1',
          apiKey: 'k',
          // models[0] is stale — the server no longer serves it; the live
          // session model is the reliable signal.
          models: [{ id: 'stale-model' }, { id: 'session-model' }],
        },
      },
    }));

    expect(resolveOpenAiCompatEndpoint()).toEqual({
      baseUrl: 'http://fixture:9000/v1',
      apiKey: 'k',
      model: 'session-model',
    });
  });

  it('does not inherit the session model when the resolved provider differs', () => {
    withEnv({
      PI_PROVIDER: 'compatible',
      PI_MODEL: 'session-model',
      CORTEX_LLM_PROVIDER: 'other',
      HOME: fixtureHome,
    });
    fs.mkdirSync(nodePath.join(fixtureHome, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'models.json'), JSON.stringify({
      providers: {
        compatible: { baseUrl: 'http://fixture:9000/v1', apiKey: 'k', models: [{ id: 'fixture-model' }] },
        other: { baseUrl: 'http://other:9000/v1', apiKey: 'k2', models: [{ id: 'other-model' }] },
      },
    }));

    expect(resolveOpenAiCompatEndpoint()).toEqual({
      baseUrl: 'http://other:9000/v1',
      apiKey: 'k2',
      model: 'other-model',
    });
  });

  it('falls back to models[0] when no active session model is known', () => {
    withEnv({ PI_PROVIDER: 'compatible', HOME: fixtureHome });
    fs.mkdirSync(nodePath.join(fixtureHome, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'models.json'), JSON.stringify({
      providers: {
        compatible: { baseUrl: 'http://fixture:9000/v1', apiKey: 'k', models: [{ id: 'fixture-model' }] },
      },
    }));

    expect(resolveOpenAiCompatEndpoint()?.model).toBe('fixture-model');
  });

  it('lets an explicit Cortex provider override the active Pi provider', () => {
    withEnv({
      CORTEX_LLM_PROVIDER: 'explicit-provider',
      CORTEX_PI_PROVIDER: 'selected-provider',
      HOME: fixtureHome,
    });
    fs.mkdirSync(nodePath.join(fixtureHome, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'models.json'), JSON.stringify({
      providers: {
        'explicit-provider': { baseUrl: 'http://explicit:9000/v1', apiKey: 'explicit', models: [{ id: 'explicit-model' }] },
        'selected-provider': { baseUrl: 'http://selected:9000/v1', apiKey: 'selected', models: [{ id: 'selected-model' }] },
      },
    }));
    fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'settings.json'), JSON.stringify({}));

    expect(resolveOpenAiCompatEndpoint()?.model).toBe('explicit-model');
  });

  it('falls back to settings.defaultProvider when no env provider is set', () => {
    withEnv({ CORTEX_LLM_PROVIDER: undefined, PI_PROVIDER: undefined, HOME: fixtureHome });
    fs.mkdirSync(nodePath.join(fixtureHome, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'models.json'), JSON.stringify({
      providers: {
        'default-fixture': { baseUrl: 'http://fixture:9000/v1', apiKey: 'k', models: [{ id: 'default-model' }] },
      },
    }));
    fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'settings.json'), JSON.stringify({
      defaultProvider: 'default-fixture',
    }));

    expect(resolveOpenAiCompatEndpoint()?.model).toBe('default-model');
  });
});

describe('chatCompletionText', () => {
  const endpoint: LlmEndpoint = { baseUrl: 'http://llm.example/v1', apiKey: 'secret', model: 'm' };

  /** Swap globalThis.fetch for the duration of one test (runner-agnostic). */
  async function withStubbedFetch(
    impl: (url: string | URL, init?: RequestInit) => Promise<Response>,
    run: () => Promise<void>,
  ): Promise<void> {
    const original = globalThis.fetch;
    globalThis.fetch = impl as typeof fetch;
    try {
      await run();
    } finally {
      globalThis.fetch = original;
    }
  }

  it('posts the thinking-disabled body and returns content', async () => {
    let captured: { url: string; headers: Headers; body: unknown } | null = null;
    await withStubbedFetch(async (url, init) => {
      captured = { url: String(url), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"edges":[]}' }, finish_reason: 'stop' }],
      }), { status: 200 });
    }, async () => {
      const content = await chatCompletionText(endpoint, 'classify', { jsonSchema: { type: 'object' }, maxTokens: 512 });
      expect(content).toBe('{"edges":[]}');
    });

    expect(captured).not.toBeNull();
    const seen = captured as unknown as { url: string; headers: Headers; body: unknown };
    expect(seen.url).toBe('http://llm.example/v1/chat/completions');
    expect(seen.headers.get('authorization')).toBe('Bearer secret');
    expect(seen.body).toMatchObject({
      model: 'm',
      max_tokens: 512,
      temperature: 0,
      chat_template_kwargs: { thinking: false },
      response_format: { type: 'json_schema' },
    });
  });

  it('uses json_object mode when jsonSchema is not supplied', async () => {
    const bodies: unknown[] = [];
    await withStubbedFetch(async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }), { status: 200 });
    }, async () => {
      await chatCompletionText(endpoint, 'classify', { jsonMode: true });
    });
    expect(bodies[0]).toMatchObject({ response_format: { type: 'json_object' } });
  });

  it('throws on non-OK status', async () => {
    await withStubbedFetch(async () => new Response('boom', { status: 503 }), async () => {
      await expect(chatCompletionText(endpoint, 'x')).rejects.toThrow(/503/);
    });
  });

  it('throws on empty content', async () => {
    await withStubbedFetch(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '' }, finish_reason: 'stop' }],
    }), { status: 200 }), async () => {
      await expect(chatCompletionText(endpoint, 'x')).rejects.toThrow(/empty content/);
    });
  });

  it('names max_tokens truncation instead of a generic parse error', async () => {
    await withStubbedFetch(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"edges": [' }, finish_reason: 'length' }],
    }), { status: 200 }), async () => {
      await expect(chatCompletionText(endpoint, 'x', { maxTokens: 128 })).rejects.toThrow(/truncated.*max_tokens=128/);
    });
  });

  it('throws a timeout-named error when the request exceeds timeoutMs', async () => {
    // A fetch stub that never settles: only the AbortController can release it.
    await withStubbedFetch((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(init.signal?.reason ?? new Error('aborted'));
      });
    }), async () => {
      await expect(chatCompletionText(endpoint, 'x', { timeoutMs: 10 }))
        .rejects.toThrow(/timed out after 10ms/);
    });
  });

  it('throws a readable error when the response body is not JSON', async () => {
    await withStubbedFetch(async () => new Response('<html>gateway error</html>', { status: 200 }), async () => {
      await expect(chatCompletionText(endpoint, 'x')).rejects.toThrow(
        /Unexpected token|Unexpected end|JSON/
      );
    });
  });
});
