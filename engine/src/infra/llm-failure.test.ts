import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  describeRefusal,
  LlmEndpointSaturatedError,
  LlmProviderRefusedError,
  providerRefusalIn,
  stopsFurtherLlmCalls,
  type ProviderRefusal,
} from './llm-failure.js';

// Every stderr below is copied from pi-detached.log (the part after
// "Extraction LLM CLI exited with code 1: "), so the classifier is pinned to
// what pi actually prints, not to what we imagine it prints.
const BETWEEN_TOOLS_400 =
  '400 {"type":"error","error":{"type":"invalid_request_error","message":"To turn thinking off on this model, ' +
  'send \\"thinking\\": {\\"type\\": \\"between_tools\\"} instead of {\\"type\\": \\"disabled\\"}."}}';
const ELOOP_LINE =
  'cleanup-stale-subagents: stat failed for /tmp/claude-subagents/ledger-test.callstart.json: ' +
  'ELOOP: too many symbolic links encountered';

describe('providerRefusalIn', () => {
  it.each<[string, string, ProviderRefusal]>([
    ['the between_tools 400', BETWEEN_TOOLS_400, { kind: 'http-status', status: 400 }],
    ['an exhausted quota', '429 quota exceeded', { kind: 'http-status', status: 429 }],
    ['rejected credentials', '401 "Unauthorized"', { kind: 'http-status', status: 401 }],
    ['a forbidden request', '403 forbidden', { kind: 'http-status', status: 403 }],
    [
      'a provider missing from the catalog',
      'Error: Unknown provider "desktop-muse". Use --list-models to see available providers/models.',
      { kind: 'unknown-provider' },
    ],
    [
      'an API key command that fails',
      'API key auth failed for provider desktop-vllm: Failed to resolve API key for provider "desktop-vllm" from shell command',
      { kind: 'auth-failed' },
    ],
    [
      'a Codex model the account may not use',
      "Codex error: The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.",
      { kind: 'model-unsupported' },
    ],
    [
      'the same refusal as a bare JSON body',
      `{"detail":"The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account."}`,
      { kind: 'model-unsupported' },
    ],
    // A crashed extension logs first; the refusal that follows still counts.
    ['a refusal after unrelated log lines', `${ELOOP_LINE}\n${ELOOP_LINE}\n429 quota exceeded`, { kind: 'http-status', status: 429 }],
  ])('reads %s as a refusal', (_what, stderr, refusal) => {
    expect(providerRefusalIn(stderr)).toEqual(refusal);
  });

  it.each([
    ['a request timeout', '408 Request Timeout'],
    ['a dropped connection', 'Connection error.'],
    ['an unreachable server', 'Connection error.: connect ECONNREFUSED 192.168.0.80:8000'],
    ['a crashed extension alone', ELOOP_LINE],
    // Flags one message, not the provider: the next batch may well pass.
    [
      'a content safeguard on one message',
      'Cyber safeguards flagged this message. If this is legitimate security work, you can apply for the Cyber Verification Program',
    ],
    // A 4xx inside a line is a path or a count, not pi reporting a status.
    ['a status-like number mid-line', 'wrote 404 memories to /tmp/x, then Connection error.'],
    ['empty stderr', ''],
  ])('reads %s as possibly transient', (_what, stderr) => {
    expect(providerRefusalIn(stderr)).toBeNull();
  });

  const oneLine = (text: string): string => text.replace(/\n/g, ' ');
  const refusingStatus = fc.integer({ min: 400, max: 499 }).filter((status) => status !== 408);
  const unrelatedLine = fc
    .string({ maxLength: 60 })
    .map(oneLine)
    .filter((line) => providerRefusalIn(line) === null);

  it('finds a refusing 4xx on any line, whatever precedes it', () => {
    fc.assert(
      fc.property(fc.array(unrelatedLine, { maxLength: 5 }), refusingStatus, fc.string({ maxLength: 40 }), (before, status, rest) => {
        const stderr = [...before, `${status} ${oneLine(rest)}`].join('\n');
        expect(providerRefusalIn(stderr)).toEqual({ kind: 'http-status', status });
      }),
    );
  });

  it('never reads a timeout or a non-4xx status as a refusal', () => {
    const notRefusing = fc.oneof(fc.constant(408), fc.integer({ min: 100, max: 399 }), fc.integer({ min: 500, max: 599 }));
    fc.assert(
      fc.property(notRefusing, (status) => {
        expect(providerRefusalIn(`${status} upstream said no`)).toBeNull();
      }),
    );
  });
});

describe('describeRefusal', () => {
  it.each<[ProviderRefusal, string]>([
    [{ kind: 'http-status', status: 429 }, 'HTTP 429'],
    [{ kind: 'unknown-provider' }, 'unknown provider'],
    [{ kind: 'auth-failed' }, 'API key auth failed'],
    [{ kind: 'model-unsupported' }, 'model not supported for this account'],
  ])('names %o as %s', (refusal, words) => {
    expect(describeRefusal(refusal)).toBe(words);
  });

  it('puts the refusal and the provider detail in the error message', () => {
    const error = new LlmProviderRefusedError({ kind: 'http-status', status: 429 }, '429 quota exceeded');
    expect(error.message).toBe('LLM provider refused the request (HTTP 429): 429 quota exceeded');
    expect(error.name).toBe('LlmProviderRefusedError');
  });
});

describe('stopsFurtherLlmCalls', () => {
  it.each([
    ['a saturated endpoint', new LlmEndpointSaturatedError(3), true],
    ['a provider refusal', new LlmProviderRefusedError({ kind: 'auth-failed' }, 'API key auth failed'), true],
    ['an ordinary failure', new Error('Connection error.'), false],
    ['a thrown string', '429 quota exceeded', false],
    ['nothing', undefined, false],
  ])('answers for %s', (_what, err, stops) => {
    expect(stopsFurtherLlmCalls(err)).toBe(stops);
  });
});
