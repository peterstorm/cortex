/**
 * Tests for the direct OpenAI-compatible LLM client.
 *
 * Endpoint resolution is exercised through the explicit env overrides and
 * through fixture ~/.pi/agent config (HOME redirected to a temp dir);
 * chatCompletionText uses a stubbed fetch so no network is ever touched.
 */

import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as nodePath from 'node:path';
import {
  resolveOpenAiCompatEndpoint,
  chatCompletionText,
  completionBudget,
  findServedModelMismatch,
  parseCompletionReply,
  resetServedModelCheck,
  backgroundThinking,
  parseEffortOverride,
  parseServedModelIds,
  reasoningEffortFor,
  thinkingCannotBeDisabled,
  THINKING_DISABLED_KWARGS,
  type LlmEndpoint,
} from './llm-client.js';

const ENV_KEYS = ['CORTEX_LLM_API_URL', 'CORTEX_LLM_API_KEY', 'CORTEX_LLM_MODEL',
  'CORTEX_LLM_PROVIDER', 'CORTEX_PI_PROVIDER', 'CORTEX_PI_MODEL', 'PI_PROVIDER', 'PI_MODEL', 'HOME',
  'CORTEX_LLM_REASONING_EFFORT'];

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

  it('treats a field of the wrong type as absent', () => {
    // A numeric model id is not a model: the provider is rejected with the
    // same warning as a missing one, and a numeric defaultProvider selects
    // nothing at all.
    withEnv({ PI_PROVIDER: 'numeric', HOME: fixtureHome });
    fs.mkdirSync(nodePath.join(fixtureHome, '.pi', 'agent'), { recursive: true });
    fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'models.json'), JSON.stringify({
      providers: { numeric: { baseUrl: 'http://x/v1', apiKey: 'k', models: [{ id: 42 }] } },
    }));
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      expect(resolveOpenAiCompatEndpoint()).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/no models\[0\]\.id/));

      withEnv({ PI_PROVIDER: undefined });
      fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'settings.json'), JSON.stringify({ defaultProvider: 7 }));
      expect(resolveOpenAiCompatEndpoint()).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('resolves any models.json to an endpoint or to null, never a throw', () => {
    // models.json is wire data the user edits by hand. Whatever its shape,
    // resolution must answer, and whatever it answers must be well typed.
    // An apiKey starting with '!' is a shell command, so no generated value
    // holds such a string at any depth: arbitrary text must not reach bash.
    const noCommand = fc.jsonValue().filter((v) => !JSON.stringify(v).includes('"!'));
    // Valid values mixed in, so the resolving branch is reached, not only the rejections.
    const providerShaped = fc.record(
      {
        api: fc.oneof(noCommand, fc.constant('openai-completions')),
        baseUrl: fc.oneof(noCommand, fc.constant('http://fixture:9000/v1')),
        apiKey: fc.oneof(noCommand, fc.constant('k')),
        models: fc.oneof(noCommand, fc.constant([{ id: 'fixture-model' }])),
      },
      { requiredKeys: [] },
    );
    const config = fc.oneof(
      noCommand,
      fc.record({ providers: noCommand }),
      fc.record({ providers: fc.record({ p: providerShaped }) }),
    );
    withEnv({ PI_PROVIDER: 'p', HOME: fixtureHome });
    fs.mkdirSync(nodePath.join(fixtureHome, '.pi', 'agent'), { recursive: true });
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    let resolved = 0;

    try {
      fc.assert(
        fc.property(config, (models) => {
          fs.writeFileSync(nodePath.join(fixtureHome, '.pi', 'agent', 'models.json'), JSON.stringify(models));
          const endpoint = resolveOpenAiCompatEndpoint();
          if (endpoint === null) return;
          resolved++;
          expect(endpoint.baseUrl.startsWith('http')).toBe(true);
          expect(typeof endpoint.apiKey).toBe('string');
          expect(endpoint.apiKey.length).toBeGreaterThan(0);
          expect(typeof endpoint.model).toBe('string');
        }),
        { numRuns: 300 },
      );
    } finally {
      warn.mockRestore();
    }
    expect(resolved).toBeGreaterThan(0);
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

  it('posts the thinking-disabled body (both chat-template conventions) and returns content', async () => {
    let captured: { url: string; headers: Headers; body: unknown } | null = null;
    await withStubbedFetch(async (url, init) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 });
      }
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
      // DeepSeek-style templates read `thinking`, Qwen3-style read `enable_thinking`;
      // both must be sent because the served model's family is not known in advance.
      chat_template_kwargs: { thinking: false, enable_thinking: false },
      response_format: { type: 'json_schema' },
    });
  });

  it('disables thinking under both known chat-template conventions in the shared constant', () => {
    expect(THINKING_DISABLED_KWARGS).toEqual({ thinking: false, enable_thinking: false });
    expect(Object.isFrozen(THINKING_DISABLED_KWARGS)).toBe(true);
  });

  it('uses json_object mode when jsonSchema is not supplied', async () => {
    const bodies: unknown[] = [];
    await withStubbedFetch(async (url, init) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 });
      }
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

  it('names the thinking-model failure when only reasoning_content is returned', async () => {
    // A thinking model that ignored the disable kwargs burns its budget on
    // reasoning and returns empty content — this must not read like a network glitch.
    await withStubbedFetch(async (url) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{
          message: { content: '', reasoning_content: 'We need to respond with a single word' },
          finish_reason: 'length',
        }],
      }), { status: 200 });
    }, async () => {
      await expect(chatCompletionText(endpoint, 'x', { maxTokens: 8 }))
        .rejects.toThrow(/only reasoning_content.*thinking/s);
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
    // A fetch stub that never settles for the completion: only the AbortController
    // can release it. The /models probe answers fast so the 2s probe budget does
    // not inflate this test.
    await withStubbedFetch((url, init) => {
      if (String(url).endsWith('/models')) {
        return Promise.resolve(new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 }));
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(init.signal?.reason ?? new Error('aborted'));
        });
      });
    }, async () => {
      await expect(chatCompletionText(endpoint, 'x', { timeoutMs: 10 }))
        .rejects.toThrow(/timed out after 10ms/);
    });
  });

  it('warns once when the endpoint does not serve the requested model', async () => {
    // Local routing servers accept any model name; the one-shot probe surfaces
    // the stale configured name where the operator is already looking.
    resetServedModelCheck();
    const modelCalls: string[] = [];
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await withStubbedFetch(async (url) => {
      const u = String(url);
      if (u.endsWith('/models')) {
        modelCalls.push(u);
        return new Response(JSON.stringify({ data: [{ id: 'qwen3.8-27b' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 });
    }, async () => {
      expect(await chatCompletionText(endpoint, 'first')).toBe('ok');
      expect(await chatCompletionText(endpoint, 'second')).toBe('ok');
    });
    // One probe per process, not one per completion call.
    expect(modelCalls).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/not in the served model list/));
    warn.mockRestore();
  });

  it('lets the probe fail (500 /models) without breaking the completion', async () => {
    resetServedModelCheck();
    await withStubbedFetch(async (url) => {
      if (String(url).endsWith('/models')) return new Response('boom', { status: 500 });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 });
    }, async () => {
      await expect(chatCompletionText(endpoint, 'x')).resolves.toBe('ok');
    });
  });

  it('stays quiet when the served list does not contain the requested name but /models is unreadable', async () => {
    resetServedModelCheck();
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await withStubbedFetch(async (url) => {
      if (String(url).endsWith('/models')) return new Response('<html>error</html>', { status: 200 });
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }), { status: 200 });
    }, async () => {
      await expect(chatCompletionText(endpoint, 'x')).resolves.toBe('ok');
    });
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/not in the served model list/));
    warn.mockRestore();
  });

  it('throws a readable error when the response body is not JSON', async () => {
    await withStubbedFetch(async () => new Response('<html>gateway error</html>', { status: 200 }), async () => {
      await expect(chatCompletionText(endpoint, 'x')).rejects.toThrow(
        /Unexpected token|Unexpected end|JSON/
      );
    });
  });
});

describe('thinkingCannotBeDisabled', () => {
  it.each([
    'glm-5.3-flash-hyperflare-tp2-v16',
    'glm-5.3-flash-hyperflare-tp2-cyber-hybrid',
    'GLM-5.3-Flash',
    'glm-5.3-flash-exl3-k4-vision-fp8kv-mtp-359k-v11.1',
  ])('is true for the GLM-family id %s', (id) => {
    expect(thinkingCannotBeDisabled([id])).toBe(true);
  });

  it.each(['warmind-1017-native', 'deepseek-v4.1-flash-native', 'qwen3.8-27b', 'm'])(
    'is false for %s, whose template has an off switch',
    (id) => {
      expect(thinkingCannotBeDisabled([id])).toBe(false);
    },
  );

  it('is false when nothing is known and true when any served model is GLM-family', () => {
    expect(thinkingCannotBeDisabled([])).toBe(false);
    expect(thinkingCannotBeDisabled(['qwen3.8-27b', 'glm-5.3-flash-hyperflare-tp2-v16'])).toBe(true);
  });
});

describe('parseEffortOverride', () => {
  it('treats unset and blank as auto', () => {
    expect(parseEffortOverride(undefined)).toEqual({ kind: 'auto' });
    expect(parseEffortOverride('  ')).toEqual({ kind: 'auto' });
  });

  it.each(['low', 'medium', 'high', 'max'] as const)('accepts %s, ignoring case and whitespace', (effort) => {
    expect(parseEffortOverride(` ${effort.toUpperCase()} `)).toEqual({ kind: 'effort', effort });
  });

  it.each(['none', 'off', 'NONE'])('reads %s as "send no effort"', (raw) => {
    expect(parseEffortOverride(raw)).toEqual({ kind: 'none' });
  });

  it('keeps an unrecognised value so it can be reported', () => {
    expect(parseEffortOverride('turbo')).toEqual({ kind: 'invalid', raw: 'turbo' });
  });
});

describe('reasoningEffortFor', () => {
  const glm = ['glm-5.3-flash-hyperflare-tp2-cyber-hybrid'];
  const warmind = ['warmind-1017-native'];

  it('asks a GLM-family model for the lowest effort it accepts', () => {
    expect(reasoningEffortFor(glm, { kind: 'auto' })).toBe('low');
    expect(reasoningEffortFor(glm, { kind: 'invalid', raw: 'turbo' })).toBe('low');
  });

  it('sends nothing to a model with an off switch', () => {
    expect(reasoningEffortFor(warmind, { kind: 'auto' })).toBeUndefined();
    expect(reasoningEffortFor([], { kind: 'auto' })).toBeUndefined();
  });

  it('lets an explicit effort win on any model', () => {
    expect(reasoningEffortFor(warmind, { kind: 'effort', effort: 'high' })).toBe('high');
    expect(reasoningEffortFor(glm, { kind: 'effort', effort: 'max' })).toBe('max');
  });

  it('lets none suppress the hint even for a GLM-family model', () => {
    expect(reasoningEffortFor(glm, { kind: 'none' })).toBeUndefined();
  });
});

/** Swap globalThis.fetch for one test (runner-agnostic), restoring it afterwards. */
async function stubFetch(
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

describe('reasoning effort on the direct path', () => {
  // The session is pinned to WARMIND; what the server answers with is another matter.
  const pinned: LlmEndpoint = { baseUrl: 'http://llm.example/v1', apiKey: 'secret', model: 'warmind-1017-native' };
  const ok = () => new Response(JSON.stringify({ choices: [{ message: { content: '{}' }, finish_reason: 'stop' }] }), { status: 200 });

  beforeEach(() => {
    delete Bun.env.CORTEX_LLM_REASONING_EFFORT;
    resetServedModelCheck();
  });
  afterEach(() => {
    delete Bun.env.CORTEX_LLM_REASONING_EFFORT;
  });

  /** Serve these ids from /models and return the completion request body Cortex sent. */
  async function sentBody(servedIds: readonly string[], endpoint: LlmEndpoint = pinned): Promise<Record<string, unknown>> {
    let body: Record<string, unknown> = {};
    await stubFetch(async (url, init) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: servedIds.map((id) => ({ id })) }), { status: 200 });
      }
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return ok();
    }, async () => {
      await chatCompletionText(endpoint, 'extract', { jsonMode: true });
    });
    return body;
  }

  it('asks for the lowest effort when GLM answers although the session is pinned to WARMIND', async () => {
    const body = await sentBody(['glm-5.3-flash-hyperflare-tp2-cyber-hybrid']);
    expect(body.reasoning_effort).toBe('low');
    // Still sent: harmless to GLM and right for every engine whose template has an off switch.
    expect(body.chat_template_kwargs).toEqual({ thinking: false, enable_thinking: false });
  });

  it('sends exactly the request it always sent to a model with an off switch', async () => {
    expect(await sentBody(['warmind-1017-native'])).not.toHaveProperty('reasoning_effort');
    resetServedModelCheck();
    expect(await sentBody(['qwen3.8-27b'])).not.toHaveProperty('reasoning_effort');
  });

  it('trusts what the server serves over what the config says', async () => {
    const configuredGlm: LlmEndpoint = { ...pinned, model: 'glm-5.3-flash-hyperflare-tp2-v16' };
    // A ds4 engine behind a GLM-named config must not be handed a thinking budget it never asked for.
    expect(await sentBody(['warmind-1017-native'], configuredGlm)).not.toHaveProperty('reasoning_effort');
  });

  it('falls back to the configured name when the server cannot be asked', async () => {
    const failedProbe = async (endpoint: LlmEndpoint): Promise<Record<string, unknown>> => {
      let body: Record<string, unknown> = {};
      await stubFetch(async (url, init) => {
        if (String(url).endsWith('/models')) return new Response('boom', { status: 500 });
        body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return ok();
      }, async () => {
        await chatCompletionText(endpoint, 'extract');
      });
      return body;
    };
    expect((await failedProbe({ ...pinned, model: 'glm-5.3-flash-hyperflare-tp2-v16' })).reasoning_effort).toBe('low');
    resetServedModelCheck();
    expect(await failedProbe({ ...pinned, model: 'qwen3.8-27b' })).not.toHaveProperty('reasoning_effort');
  });

  it('honours an explicit effort on any model', async () => {
    Bun.env.CORTEX_LLM_REASONING_EFFORT = 'high';
    expect((await sentBody(['warmind-1017-native'])).reasoning_effort).toBe('high');
  });

  it('lets none suppress the hint even for a GLM-family model', async () => {
    Bun.env.CORTEX_LLM_REASONING_EFFORT = 'none';
    expect(await sentBody(['glm-5.3-flash-hyperflare-tp2-cyber-hybrid'])).not.toHaveProperty('reasoning_effort');
  });

  // GLM at effort low still spent a prune batch's whole max_tokens thinking and
  // answered nothing; the budget closes the reasoning and leaves the answer its share.
  it('caps a GLM server\'s reasoning and keeps the whole answer budget on top', async () => {
    const body = await sentBody(['glm-5.3-flash-hyperflare-tp2-cyber-hybrid']);
    expect(body.thinking_token_budget).toBe(1_024);
    expect(body.max_tokens).toBe(2_048 + 1_024);
  });

  it('sends neither a reasoning budget nor extra tokens to a model with an off switch', async () => {
    const body = await sentBody(['warmind-1017-native']);
    expect(body).not.toHaveProperty('thinking_token_budget');
    expect(body.max_tokens).toBe(2_048);
  });

  it('sizes the reasoning budget by the explicit effort', async () => {
    Bun.env.CORTEX_LLM_REASONING_EFFORT = 'high';
    const body = await sentBody(['warmind-1017-native']);
    expect(body.thinking_token_budget).toBe(8_192);
    expect(body.max_tokens).toBe(2_048 + 8_192);
  });

  it('drops the reasoning budget with the hint when the effort is none', async () => {
    Bun.env.CORTEX_LLM_REASONING_EFFORT = 'none';
    const body = await sentBody(['glm-5.3-flash-hyperflare-tp2-cyber-hybrid']);
    expect(body).not.toHaveProperty('thinking_token_budget');
    expect(body.max_tokens).toBe(2_048);
  });

  it('reports an unrecognised override once and still protects a GLM server', async () => {
    Bun.env.CORTEX_LLM_REASONING_EFFORT = 'turbo';
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const first = await sentBody(['glm-5.3-flash-hyperflare-tp2-cyber-hybrid']);
    const second = await sentBody(['glm-5.3-flash-hyperflare-tp2-cyber-hybrid']);
    const warnings = warn.mock.calls.filter(([text]) => /CORTEX_LLM_REASONING_EFFORT/.test(String(text)));
    warn.mockRestore();
    expect(first.reasoning_effort).toBe('low');
    expect(second.reasoning_effort).toBe('low');
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[0])).toMatch(/turbo/);
  });

  it('probes once per minute, so a primary switch is noticed mid-run', async () => {
    const modelCalls: string[] = [];
    const now = vi.spyOn(Date, 'now');
    let served = 'warmind-1017-native';
    const bodies: Array<Record<string, unknown>> = [];
    await stubFetch(async (url, init) => {
      if (String(url).endsWith('/models')) {
        modelCalls.push(String(url));
        return new Response(JSON.stringify({ data: [{ id: served }] }), { status: 200 });
      }
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return ok();
    }, async () => {
      now.mockReturnValue(1_000_000);
      await chatCompletionText(pinned, 'one');
      now.mockReturnValue(1_030_000);
      await chatCompletionText(pinned, 'two');
      served = 'glm-5.3-flash-hyperflare-tp2-cyber-hybrid';
      now.mockReturnValue(1_061_000);
      await chatCompletionText(pinned, 'three');
    });
    now.mockRestore();
    expect(modelCalls).toHaveLength(2);
    expect(bodies.map((body) => body.reasoning_effort)).toEqual([undefined, undefined, 'low']);
  });

  it('names the override in the reasoning-only failure', async () => {
    await stubFetch(async (url) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 });
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: '', reasoning_content: 'thinking...' }, finish_reason: 'length' }],
      }), { status: 200 });
    }, async () => {
      await expect(chatCompletionText({ ...pinned, model: 'm' }, 'x', { maxTokens: 8 }))
        .rejects.toThrow(/CORTEX_LLM_REASONING_EFFORT/);
    });
  });
});

describe('backgroundThinking', () => {
  const pinned: LlmEndpoint = { baseUrl: 'http://llm.example/v1', apiKey: 'secret', model: 'warmind-1017-native' };

  beforeEach(() => {
    delete Bun.env.CORTEX_LLM_REASONING_EFFORT;
    resetServedModelCheck();
  });
  afterEach(() => {
    delete Bun.env.CORTEX_LLM_REASONING_EFFORT;
  });

  const serving = (...ids: string[]) => async (url: string | URL): Promise<Response> =>
    String(url).endsWith('/models')
      ? new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 })
      : new Response('unexpected', { status: 500 });

  it('is off for a model with an off switch', async () => {
    await stubFetch(serving('warmind-1017-native'), async () => {
      expect(await backgroundThinking(pinned)).toBe('off');
    });
  });

  it('is low for a GLM server behind a session pinned to WARMIND', async () => {
    await stubFetch(serving('glm-5.3-flash-hyperflare-tp2-cyber-hybrid'), async () => {
      expect(await backgroundThinking(pinned)).toBe('low');
    });
  });

  it('follows an explicit effort or none', async () => {
    await stubFetch(serving('glm-5.3-flash-hyperflare-tp2-cyber-hybrid'), async () => {
      Bun.env.CORTEX_LLM_REASONING_EFFORT = 'high';
      expect(await backgroundThinking(pinned)).toBe('high');
      Bun.env.CORTEX_LLM_REASONING_EFFORT = 'none';
      expect(await backgroundThinking(pinned)).toBe('off');
    });
  });
});

describe('completionBudget', () => {
  const efforts = ['low', 'medium', 'high', 'max'] as const;
  const answerTokens = fc.integer({ min: 1, max: 65_536 });

  it('gives the whole budget to the answer when no reasoning is expected', () => {
    expect(completionBudget(2_048, undefined)).toEqual({ kind: 'answer-only', maxTokens: 2_048 });
  });

  it.each([['low', 1_024], ['medium', 4_096], ['high', 8_192], ['max', 16_384]] as const)(
    'bounds %s reasoning at %i tokens',
    (effort, thinkingTokens) => {
      expect(completionBudget(2_048, effort)).toEqual({
        kind: 'reasoning-bounded',
        maxTokens: 2_048 + thinkingTokens,
        thinkingTokens,
      });
    },
  );

  it('never lets reasoning take tokens the answer was sized for', () => {
    fc.assert(
      fc.property(answerTokens, fc.option(fc.constantFrom(...efforts), { nil: undefined }), (answer, effort) => {
        const budget = completionBudget(answer, effort);
        const reasoning = budget.kind === 'reasoning-bounded' ? budget.thinkingTokens : 0;
        expect(budget.maxTokens - reasoning).toBe(answer);
        expect(reasoning).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('allows more reasoning for a higher effort', () => {
    fc.assert(
      fc.property(answerTokens, (answer) => {
        const reasoning = efforts.map((effort) => {
          const budget = completionBudget(answer, effort);
          return budget.kind === 'reasoning-bounded' ? budget.thinkingTokens : 0;
        });
        expect(reasoning).toEqual([...reasoning].sort((a, b) => a - b));
        expect(new Set(reasoning).size).toBe(efforts.length);
      }),
    );
  });
});

describe('parseCompletionReply', () => {
  it('reads every field of a well-formed reply', () => {
    expect(parseCompletionReply({
      model: 'glm-5.3-flash-hyperflare-tp2-uncensored',
      choices: [{ message: { content: '{}', reasoning_content: 'hmm' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 3 },
    })).toEqual({
      model: 'glm-5.3-flash-hyperflare-tp2-uncensored',
      content: '{}',
      reasoning: 'hmm',
      finishReason: 'stop',
      promptTokens: 12,
      completionTokens: 3,
    });
  });

  const absent = {
    model: undefined,
    content: undefined,
    reasoning: undefined,
    finishReason: undefined,
    promptTokens: null,
    completionTokens: null,
  };

  it.each([
    ['null', null],
    ['a string', 'gateway error'],
    ['an empty object', {}],
    ['choices that are not a list', { choices: { message: { content: 'x' } } }],
    ['an empty choices list', { choices: [] }],
    ['a choice that is not an object', { choices: ['x'] }],
    ['a message that is not an object', { choices: [{ message: 'x' }] }],
  ])('reads %s as a reply with nothing in it', (_what, payload) => {
    expect(parseCompletionReply(payload)).toEqual(absent);
  });

  it('drops each mistyped field on its own, keeping the rest', () => {
    expect(parseCompletionReply({
      model: 7,
      choices: [{ message: { content: 'answer', reasoning_content: ['x'] }, finish_reason: null }],
      usage: { prompt_tokens: -1, completion_tokens: 2.5 },
    })).toEqual({ ...absent, content: 'answer' });
  });

  it('never throws, whatever the server sends', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (payload) => {
        expect(() => parseCompletionReply(payload)).not.toThrow();
      }),
    );
  });
});

describe('parseServedModelIds', () => {
  it('reads the ids of an OpenAI /models payload, in order', () => {
    expect(parseServedModelIds({ object: 'list', data: [{ id: 'a' }, { id: 'b', owned_by: 'x' }] })).toEqual(['a', 'b']);
  });

  it('skips entries without a string id instead of failing the whole payload', () => {
    expect(parseServedModelIds({ data: [{ id: 'a' }, { id: 7 }, {}, null, 'b', { id: 'c' }] })).toEqual(['a', 'c']);
  });

  it.each([
    ['null', null],
    ['a string', 'models'],
    ['an array', [{ id: 'a' }]],
    ['an object without data', { models: [{ id: 'a' }] }],
    ['data that is not a list', { data: { id: 'a' } }],
    ['an empty list', { data: [] }],
  ])('yields nothing for %s', (_label, payload) => {
    expect(parseServedModelIds(payload)).toEqual([]);
  });
});

describe('findServedModelMismatch', () => {
  it('returns null when the requested model is served', () => {
    expect(findServedModelMismatch('m', ['other', 'm'])).toBeNull();
  });

  it('returns null when the served list is empty (inconclusive)', () => {
    expect(findServedModelMismatch('m', [])).toBeNull();
  });

  it('names both sides when the requested model is not served', () => {
    expect(findServedModelMismatch('deepseek-v4-flash', ['qwen3.8-27b']))
      .toMatch(/deepseek-v4-flash.*qwen3\.8-27b/s);
  });
});
