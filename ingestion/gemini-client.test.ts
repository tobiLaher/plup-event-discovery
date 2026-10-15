/// <reference types="node" />
// Run: npm run ingest:test
//
// MOCKED HTTP: no network and no real key. The key below is an obvious placeholder.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiExtractor } from './ai-extractor.ts';
import { DEFAULT_GEMINI_MODEL, GEMINI_FREE_TIER_MODELS, GeminiLlmClient } from './gemini-client.ts';
import { LlmClientError, redact } from './llm-client.ts';
import { resolveSecret } from './local-env.ts';
import { ingest } from './pipeline.ts';
import type { InstagramPost } from './types.ts';

const FAKE_KEY = 'AIzaFAKE-PLACEHOLDER-KEY-0123456789-NOT-REAL';
const NOW = '2026-10-14T04:00:00Z';
const post = (id: string, caption: string): InstagramPost => ({
  id, username: 'demo', caption, timestamp: '2026-09-10T10:00:00Z', permalink: `https://example.invalid/${id}`, origin: 'instagram-business-discovery',
});

type Call = { url: string; init: { method: string; headers: Record<string, string>; body: string } };
type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; throws?: Error; rawText?: boolean };

function fakeFetch(replies: Reply[] | ((n: number) => Reply)) {
  const calls: Call[] = [];
  const fn = async (url: string, init: Call['init'] & { signal?: AbortSignal }) => {
    calls.push({ url, init });
    const r = typeof replies === 'function' ? replies(calls.length) : replies[Math.min(calls.length - 1, replies.length - 1)];
    if (r.throws) throw r.throws;
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (n: string) => r.headers?.[n.toLowerCase()] ?? null },
      json: async () => {
        if (r.rawText) throw new Error('not json');
        return r.body;
      },
    };
  };
  return { fn: fn as never, calls };
}

const okBody = (text: string, over: Record<string, unknown> = {}) => ({
  candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', ...over }],
  usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 200, totalTokenCount: 1200 },
});
const errBody = (code: number, status: string, message: string, details: unknown[] = []) => ({ error: { code, status, message, details } });
const noWait = { sleep: async () => {}, minIntervalMs: 0 };
const mk = (f: ReturnType<typeof fakeFetch>, o: Partial<ConstructorParameters<typeof GeminiLlmClient>[0]> = {}) =>
  new GeminiLlmClient({ apiKey: FAKE_KEY, fetchImpl: f.fn, ...noWait, ...o });
const REQ = { system: 'sys', user: '[{"id":"a","postedOn":"2026-09-10","caption":"hi"}]', maxOutputTokens: 800 };
const fail = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as LlmClientError;
  }
  throw new Error('expected a failure');
};

// ---- request shape and free-tier model rules

test('sends a correct generateContent request with the key in a header only', async () => {
  const f = fakeFetch([{ body: okBody('[]') }]);
  const res = await mk(f).complete(REQ);
  assert.equal(res.text, '[]');
  assert.deepEqual(res.usage, { inputTokens: 1000, outputTokens: 200 });
  const c = f.calls[0];
  assert.equal(c.url, `https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_GEMINI_MODEL}:generateContent`);
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers['x-goog-api-key'], FAKE_KEY);
  assert.equal(c.url.includes(FAKE_KEY), false); // never in the URL
  assert.equal(c.init.body.includes(FAKE_KEY), false);
  const body = JSON.parse(c.init.body);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: 'sys' }] });
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: REQ.user }] }]);
  assert.deepEqual(body.generationConfig, { maxOutputTokens: 800, responseMimeType: 'application/json' });
  for (const k of ['tools', 'safetySettings', 'cachedContent', 'serviceTier']) assert.equal(k in body, false, k);
});

test('only free-tier Flash-Lite models are accepted; the default is the one Google recommends for new projects', () => {
  assert.equal(DEFAULT_GEMINI_MODEL, 'gemini-3.5-flash-lite');
  for (const m of GEMINI_FREE_TIER_MODELS) assert.doesNotThrow(() => new GeminiLlmClient({ apiKey: FAKE_KEY, model: m }));
  for (const bad of ['gemini-2.5-pro', 'gemini-3.1-pro-preview', 'gemini-3.8-flash', '../evil']) {
    assert.throws(() => new GeminiLlmClient({ apiKey: FAKE_KEY, model: bad }), (e: unknown) => e instanceof LlmClientError && /allowlist/.test(e.message));
  }
});

test('output tokens are clamped; thought parts are excluded and thinking tokens count as output', async () => {
  const f = fakeFetch([{ body: { candidates: [{ content: { parts: [{ text: 'secret thoughts', thought: true }, { text: '[1,' }, { text: '2]' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 7 } } }]);
  const c = mk(f, { maxOutputTokensPerRequest: 300 });
  const res = await c.complete({ ...REQ, maxOutputTokens: 5000 });
  assert.equal(JSON.parse(f.calls[0].init.body).generationConfig.maxOutputTokens, 300);
  assert.equal(res.text, '[1,2]');
  assert.deepEqual(res.usage, { inputTokens: 10, outputTokens: 12 });
});

// ---- credentials and API errors (all mocked)

test('a missing or malformed key is rejected before any request', () => {
  const f = fakeFetch([{ body: okBody('[]') }]);
  for (const bad of ['', 'short', 'has space in the key 0123456789']) {
    assert.throws(() => new GeminiLlmClient({ apiKey: bad, fetchImpl: f.fn }), (e: unknown) => e instanceof LlmClientError && e.kind === 'auth');
  }
  assert.equal(f.calls.length, 0);
});

test('an invalid key is fatal for the run, not retried, and never echoed', async () => {
  const f = fakeFetch([{ status: 400, body: errBody(400, 'INVALID_ARGUMENT', `API key not valid. Please pass a valid API key. (${FAKE_KEY})`) }]);
  const e = await fail(mk(f).complete(REQ));
  assert.equal(e.kind, 'auth');
  assert.equal(e.fatalForRun, true);
  assert.equal((e.message + e.stack + JSON.stringify(e)).includes(FAKE_KEY), false);
  assert.equal(f.calls.length, 1);
  const leaked = await fail(mk(fakeFetch([{ status: 403, body: errBody(403, 'PERMISSION_DENIED', 'Your API key was reported as leaked. Please use another API key.') }])).complete(REQ));
  assert.equal(leaked.kind, 'auth');
});

test('free-tier quota exhaustion (429) stops the run, keeps the suggested delay, no retry', async () => {
  const f = fakeFetch([{ status: 429, body: errBody(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded for metric', [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '32s' }]) }]);
  const e = await fail(mk(f).complete(REQ));
  assert.equal(e.kind, 'rate_limit');
  assert.equal(e.retryAfterSec, 32);
  assert.equal(e.fatalForRun, true);
  assert.match(e.message, /do not enable billing/);
  assert.equal(f.calls.length, 1);
});

test('other API errors map to distinct kinds', async () => {
  const cases: [number, unknown, string, boolean][] = [
    [503, errBody(503, 'UNAVAILABLE', 'overloaded'), 'overloaded', true],
    [404, errBody(404, 'NOT_FOUND', 'models/gemini-2.5-flash-lite is not found for API version v1beta'), 'not_found', true],
    [400, errBody(400, 'INVALID_ARGUMENT', 'Invalid JSON payload'), 'bad_request', false],
    [413, errBody(413, 'INVALID_ARGUMENT', 'too big'), 'too_large', false],
    [500, errBody(500, 'INTERNAL', 'oops'), 'server', false],
    [502, undefined, 'server', false],
  ];
  for (const [status, body, kind, fatal] of cases) {
    const e = await fail(mk(fakeFetch([{ status, body, rawText: body === undefined }])).complete(REQ));
    assert.equal(e.kind, kind, `${status}`);
    assert.equal(e.fatalForRun, fatal, `${status}`);
  }
});

test('network failures and timeouts are errors, not hangs', async () => {
  assert.equal((await fail(mk(fakeFetch([{ throws: new Error('ECONNRESET') }])).complete(REQ))).kind, 'network');
  const slow = new GeminiLlmClient({
    apiKey: FAKE_KEY, timeoutMs: 20, ...noWait,
    fetchImpl: ((_u: string, init: { signal?: AbortSignal }) => new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as never,
  });
  const t = await fail(slow.complete(REQ));
  assert.equal(t.kind, 'network');
  assert.match(t.message, /timed out/);
});

test('malformed, blocked, truncated and refused responses are rejected; billed usage is still counted', async () => {
  assert.equal((await fail(mk(fakeFetch([{ body: { hello: 1 } }])).complete(REQ))).kind, 'bad_response');
  const blocked = await fail(mk(fakeFetch([{ body: { promptFeedback: { blockReason: 'SAFETY' } } }])).complete(REQ));
  assert.equal(blocked.kind, 'refusal');
  const cut = mk(fakeFetch([{ body: okBody('[{"id":"a"', { finishReason: 'MAX_TOKENS' }) }]));
  assert.equal((await fail(cut.complete(REQ))).kind, 'truncated');
  assert.equal(cut.totals.outputTokens, 200);
  const safety = await fail(mk(fakeFetch([{ body: okBody('', { finishReason: 'SAFETY' }) }])).complete(REQ));
  assert.equal(safety.kind, 'refusal');
  const noCand = await fail(mk(fakeFetch([{ body: { candidates: [], usageMetadata: { promptTokenCount: 5 } } }])).complete(REQ));
  assert.equal(noCand.kind, 'refusal');
  const noParts = await fail(mk(fakeFetch([{ body: { candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 5 } } }])).complete(REQ));
  assert.equal(noParts.kind, 'bad_response');
});

// ---- free-tier pacing and spending guards

test('requests are throttled to the configured gap and capped in number', async () => {
  let now = 1_000_000;
  const waits: number[] = [];
  const f = fakeFetch([{ body: okBody('[]') }]);
  const c = new GeminiLlmClient({
    apiKey: FAKE_KEY, fetchImpl: f.fn, minIntervalMs: 6000, maxRequests: 2,
    clock: () => now, sleep: async (ms) => { waits.push(ms); now += ms; },
  });
  await c.complete(REQ);
  now += 1000; // only 1 s later
  await c.complete(REQ);
  assert.deepEqual(waits, [5000]);
  const third = await fail(c.complete(REQ));
  assert.equal(third.kind, 'budget');
  assert.equal(f.calls.length, 2);
});

test('the worst-case cost cap (paid-tier reference) is enforced before sending', async () => {
  const f = fakeFetch([{ body: okBody('[]') }]);
  const e = await fail(mk(f, { maxEstimatedCostUsd: 0.000001 }).complete(REQ));
  assert.equal(e.kind, 'budget');
  assert.equal(f.calls.length, 0);
});

// ---- secret hygiene

test('redact strips Google API keys; secret lookup reads GEMINI_API_KEY from env first, then the ignored file', () => {
  assert.equal(redact(`bad ${FAKE_KEY} here`).includes('FAKE'), false);
  assert.deepEqual(resolveSecret('GEMINI_API_KEY', { GEMINI_API_KEY: ' k1 ' }, 'GEMINI_API_KEY=k2'), { key: 'k1', source: 'environment' });
  assert.deepEqual(resolveSecret('GEMINI_API_KEY', {}, 'GEMINI_API_KEY="k2"'), { key: 'k2', source: 'local-file' });
  assert.deepEqual(resolveSecret('GEMINI_API_KEY', { ANTHROPIC_API_KEY: 'x' }, null), { key: null, source: 'missing' });
});

// ---- integration with the extractor

test('a fatal quota error stops the run and the batch still completes safely', async () => {
  const f = fakeFetch([{ status: 429, body: errBody(429, 'RESOURCE_EXHAUSTED', 'Quota exceeded') }]);
  const ex = new AiExtractor({ client: mk(f), batchSize: 1 });
  const run = await ingest([post('a', 'caption one'), post('b', 'caption two'), post('c', 'caption three')], ex, { now: NOW });
  assert.equal(f.calls.length, 1);
  assert.ok(run.items.every((i) => i.reviewReasons.includes('ai_invalid_response')));
  assert.match(run.items[2].details!.notes.join(' '), /skipped_after_fatal_error/);
});

test('a well-formed Gemini reply flows through schema validation and grounding', async () => {
  const caption = 'DEMO BAND LIVE!\nNovember 20, 2026\n📍 PICC Plenary Hall\n🎫 tickets.example.com/demo';
  const reply = [{
    id: 'ok', classification: 'upcoming_event', update: 'none', notes: [],
    event: {
      officialTitle: null, displayLabel: 'Demo Band at PICC Plenary Hall', artists: [{ name: 'DEMO BAND', evidence: 'DEMO BAND LIVE' }], category: 'concert',
      date: { value: '2026-11-20', endValue: null, evidence: 'November 20, 2026' }, startTime: { value: null, evidence: null },
      venue: { name: 'PICC Plenary Hall', areaClue: null, evidence: 'PICC Plenary Hall' },
      ticket: { url: 'tickets.example.com/demo', minPhp: null, maxPhp: null, isFree: null, evidence: null },
    },
  }];
  const run = await ingest([post('ok', caption)], new AiExtractor({ client: mk(fakeFetch([{ body: okBody(JSON.stringify(reply)) }])) }), { now: NOW });
  const c = run.items[0].candidate!;
  assert.equal(run.items[0].classification, 'upcoming_event');
  assert.equal(c.venueName, 'PICC Plenary Hall');
  assert.equal(c.nameQuality, 'derived');
  assert.equal(c.ticketUrl, 'tickets.example.com/demo');
});
