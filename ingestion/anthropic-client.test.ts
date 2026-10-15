/// <reference types="node" />
// Run: npm run ingest:test
//
// MOCKED HTTP: no network, no real key. The fake key below is a placeholder string. These tests
// check request shape, error handling, spending guards and that secrets never leak.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiExtractor } from './ai-extractor.ts';
import { AnthropicLlmClient, costUsd, HAIKU_5_5, redact } from './anthropic-client.ts';
import { LlmClientError } from './llm-client.ts';
import { resolveApiKey, parseEnvFile } from './local-env.ts';
import { ingest } from './pipeline.ts';
import type { InstagramPost } from './types.ts';

const FAKE_KEY = 'FAKE-TEST-KEY-0123456789-abcdefghijklmnop-NOT-REAL';
const NOW = '2026-10-14T04:00:00Z';
const post = (id: string, caption: string): InstagramPost => ({
  id, username: 'demo', caption, timestamp: '2026-09-10T10:00:00Z', permalink: `https://example.invalid/${id}`, origin: 'instagram-business-discovery',
});

type Call = { url: string; init: { method: string; headers: Record<string, string>; body: string } };
type Reply = { status?: number; body?: unknown; headers?: Record<string, string>; throws?: Error; rawText?: boolean };

/** A fake fetch that records calls and replies from a script. */
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

const okBody = (text: string, extra: object = {}) => ({
  id: 'msg_test', type: 'message', role: 'assistant', model: HAIKU_5_5, stop_reason: 'end_turn',
  content: [{ type: 'text', text }], usage: { input_tokens: 1000, output_tokens: 200 }, ...extra,
});
const errBody = (type: string, message: string) => ({ type: 'error', error: { type, message } });
const mk = (f: ReturnType<typeof fakeFetch>, o: Partial<ConstructorParameters<typeof AnthropicLlmClient>[0]> = {}) =>
  new AnthropicLlmClient({ apiKey: FAKE_KEY, fetchImpl: f.fn, ...o });
const REQ = { system: 'sys', user: '[{"id":"a","postedOn":"2026-09-10","caption":"hi"}]', maxOutputTokens: 800 };
const fail = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as LlmClientError;
  }
  throw new Error('expected a failure');
};

// ---- request shape

test('sends a correct Messages API request: URL, headers, model, bounded tokens, no sampling params', async () => {
  const f = fakeFetch([{ body: okBody('[]') }]);
  const res = await mk(f).complete(REQ);
  assert.equal(res.text, '[]');
  assert.deepEqual(res.usage, { inputTokens: 1000, outputTokens: 200 });
  const c = f.calls[0];
  assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers['x-api-key'], FAKE_KEY);
  assert.equal(c.init.headers['anthropic-version'], '2023-06-01');
  assert.equal(c.init.headers['content-type'], 'application/json');
  const body = JSON.parse(c.init.body);
  assert.equal(body.model, 'claude-haiku-5-5');
  assert.equal(body.max_tokens, 800);
  assert.equal(body.system, 'sys');
  assert.deepEqual(body.messages, [{ role: 'user', content: REQ.user }]);
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.deepEqual(body.output_config, { effort: 'low' });
  for (const k of ['temperature', 'top_p', 'top_k', 'stream', 'tools']) assert.equal(k in body, false, k);
  assert.equal(JSON.stringify(body).includes(FAKE_KEY), false); // the key is only ever in a header
});

test('output tokens are clamped to the configured ceiling', async () => {
  const f = fakeFetch([{ body: okBody('[]') }]);
  await mk(f, { maxOutputTokensPerRequest: 300 }).complete({ ...REQ, maxOutputTokens: 5000 });
  assert.equal(JSON.parse(f.calls[0].init.body).max_tokens, 300);
});

test('multiple text blocks are joined and non-text blocks ignored', async () => {
  const f = fakeFetch([{ body: okBody('', { content: [{ type: 'thinking', thinking: 'x' }, { type: 'text', text: '[1,' }, { type: 'text', text: '2]' }] }) }]);
  assert.equal((await mk(f).complete(REQ)).text, '[1,2]');
});

// ---- credentials and API errors (all mocked)

test('a missing or malformed key is rejected before any request', async () => {
  const f = fakeFetch([{ body: okBody('[]') }]);
  for (const bad of ['', 'short', 'has space in the key 0123456789']) {
    assert.throws(() => new AnthropicLlmClient({ apiKey: bad, fetchImpl: f.fn }), (e: unknown) => e instanceof LlmClientError && e.kind === 'auth');
  }
  assert.equal(f.calls.length, 0);
});

test('invalid credentials (401) are fatal for the run and the error never contains the key', async () => {
  const f = fakeFetch([{ status: 401, body: errBody('authentication_error', `invalid x-api-key ${FAKE_KEY}`) }]);
  const e = await fail(mk(f).complete(REQ));
  assert.equal(e.kind, 'auth');
  assert.equal(e.status, 401);
  assert.equal(e.fatalForRun, true);
  assert.equal((e.message + e.stack + JSON.stringify(e)).includes(FAKE_KEY), false);
  assert.equal(f.calls.length, 1); // no retry
});

test('rate limit (429): fatal for the run, retry-after kept, no automatic retry', async () => {
  const f = fakeFetch([{ status: 429, headers: { 'retry-after': '30' }, body: errBody('rate_limit_error', 'slow down') }]);
  const e = await fail(mk(f).complete(REQ));
  assert.equal(e.kind, 'rate_limit');
  assert.equal(e.retryAfterSec, 30);
  assert.equal(e.fatalForRun, true);
  assert.equal(f.calls.length, 1);
});

test('other API errors map to distinct kinds', async () => {
  const cases: [number, unknown, string, boolean][] = [
    [529, errBody('overloaded_error', 'busy'), 'overloaded', true],
    [404, errBody('not_found_error', 'model: nope'), 'not_found', true],
    [400, errBody('invalid_request_error', 'Your credit balance is too low to access the API'), 'billing', true],
    [400, errBody('invalid_request_error', 'max_tokens: bad'), 'bad_request', false],
    [413, errBody('request_too_large', 'big'), 'too_large', false],
    [500, errBody('api_error', 'oops'), 'server', false],
    [502, undefined, 'server', false],
  ];
  for (const [status, body, kind, fatal] of cases) {
    const f = fakeFetch([{ status, body, rawText: body === undefined }]);
    const e = await fail(mk(f).complete(REQ));
    assert.equal(e.kind, kind, `${status}`);
    assert.equal(e.fatalForRun, fatal, `${status}`);
  }
});

test('network failures and timeouts are errors, not hangs', async () => {
  const down = await fail(mk(fakeFetch([{ throws: new Error('ECONNRESET') }])).complete(REQ));
  assert.equal(down.kind, 'network');
  const slow = new AnthropicLlmClient({
    apiKey: FAKE_KEY, timeoutMs: 20,
    fetchImpl: ((_u: string, init: { signal?: AbortSignal }) => new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as never,
  });
  const t = await fail(slow.complete(REQ));
  assert.equal(t.kind, 'network');
  assert.match(t.message, /timed out/);
});

test('malformed or unusable success responses are rejected', async () => {
  const shape = await fail(mk(fakeFetch([{ body: { id: 'x' } }])).complete(REQ));
  assert.equal(shape.kind, 'bad_response');
  const noUsage = await fail(mk(fakeFetch([{ body: { content: [], stop_reason: 'end_turn' } }])).complete(REQ));
  assert.equal(noUsage.kind, 'bad_response');
  const cut = mk(fakeFetch([{ body: okBody('[{"id":"a"', { stop_reason: 'max_tokens' }) }]));
  const trunc = await fail(cut.complete(REQ));
  assert.equal(trunc.kind, 'truncated');
  assert.equal(cut.totals.outputTokens, 200); // billed usage is still counted
  const refused = await fail(mk(fakeFetch([{ body: okBody('', { stop_reason: 'refusal' }) }])).complete(REQ));
  assert.equal(refused.kind, 'refusal');
});

// ---- spending guards

test('request count, worst-case cost and output ceiling are enforced before sending', async () => {
  const f = fakeFetch([{ body: okBody('[]') }]);
  const c = mk(f, { maxRequests: 2 });
  await c.complete(REQ);
  await c.complete(REQ);
  const third = await fail(c.complete(REQ));
  assert.equal(third.kind, 'budget');
  assert.equal(f.calls.length, 2);

  const g = fakeFetch([{ body: okBody('[]') }]);
  const cheap = mk(g, { maxEstimatedCostUsd: 0.0001 });
  const over = await fail(cheap.complete({ ...REQ, maxOutputTokens: 1500 }));
  assert.equal(over.kind, 'budget');
  assert.equal(g.calls.length, 0);
});

test('cost math and usage totals', async () => {
  assert.equal(costUsd({ inputTokens: 1_000_000, outputTokens: 1_000_000 }), 0.6); // $0.10 + $0.50
  const c = mk(fakeFetch([{ body: okBody('[]') }]));
  await c.complete(REQ);
  await c.complete(REQ);
  assert.deepEqual(c.totals, { requests: 2, inputTokens: 2000, outputTokens: 400 });
  assert.ok(Math.abs(c.spentUsd - 0.0004) < 1e-9);
});

// ---- secret hygiene

test('redact strips key-shaped strings', () => {
  assert.equal(redact('bad key sk-ant-api03-FAKE_example-KEY here'), 'bad key [redacted-key] here');
  assert.equal(redact(`token ${FAKE_KEY} end`), 'token [redacted] end');
  assert.equal(redact('plain words stay'), 'plain words stay');
});

test('API key resolution: environment first, then a local ignored file, never printed', () => {
  assert.deepEqual(resolveApiKey({ ANTHROPIC_API_KEY: ' k1 ' }, 'ANTHROPIC_API_KEY=k2'), { key: 'k1', source: 'environment' });
  assert.deepEqual(resolveApiKey({}, '# c\nANTHROPIC_API_KEY="k2"\n'), { key: 'k2', source: 'local-file' });
  assert.deepEqual(resolveApiKey({}, 'OTHER=1'), { key: null, source: 'missing' });
  assert.deepEqual(resolveApiKey({}, null), { key: null, source: 'missing' });
  assert.deepEqual(parseEnvFile("export A=1\n B = 'two' \n#x\nbad line"), { A: '1', B: 'two' });
});

// ---- integration with the extractor: failures never leak and never loop

const EVENT_REPLY = (id: string) => ({
  id, classification: 'unrelated', update: 'none', event: null, notes: [],
});

test('a fatal API error stops further requests in the run; the batch still completes safely', async () => {
  const f = fakeFetch([{ status: 401, body: errBody('authentication_error', 'invalid') }]);
  const client = mk(f);
  const ex = new AiExtractor({ client, batchSize: 1 });
  const run = await ingest([post('a', 'caption one'), post('b', 'caption two'), post('c', 'caption three')], ex, { now: NOW });
  assert.equal(f.calls.length, 1); // posts b and c were never sent
  assert.equal(run.items.length, 3);
  assert.ok(run.items.every((i) => i.reviewReasons.includes('ai_invalid_response')));
  assert.match(run.items[2].details!.notes.join(' '), /skipped_after_fatal_error/);
});

test('a malformed model reply is isolated and costs only what was billed', async () => {
  const f = fakeFetch([{ body: okBody('Sorry, I cannot help with that.') }]);
  const client = mk(f);
  const run = await ingest([post('a', 'some caption'), post('b', 'another caption')], new AiExtractor({ client }), { now: NOW });
  assert.equal(f.calls.length, 1);
  assert.ok(run.items.every((i) => i.reviewReasons.includes('ai_invalid_response')));
  assert.equal(client.totals.requests, 1);
});

test('maxPosts stops extra posts from being sent at all', async () => {
  const f = fakeFetch((n) => ({ body: okBody(JSON.stringify([EVENT_REPLY('p0'), EVENT_REPLY('p1')])) }));
  const posts = Array.from({ length: 4 }, (_, i) => post(`p${i}`, `caption ${i}`));
  const ex = new AiExtractor({ client: mk(f), batchSize: 2, maxPosts: 2 });
  const run = await ingest(posts, ex, { now: NOW });
  assert.equal(f.calls.length, 1);
  assert.equal(ex.stats.postsSent, 2);
  assert.match(run.items[3].details!.notes.join(' '), /budget_exceeded/);
  assert.equal(JSON.parse(f.calls[0].init.body).messages[0].content.includes('caption 3'), false);
});

test('a well-formed live-style reply flows through grounding', async () => {
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
  const client = mk(fakeFetch([{ body: okBody('```json\n' + JSON.stringify(reply) + '\n```') }]));
  const run = await ingest([post('ok', caption)], new AiExtractor({ client }), { now: NOW });
  const c = run.items[0].candidate!;
  assert.equal(run.items[0].classification, 'upcoming_event');
  assert.equal(c.venueName, 'PICC Plenary Hall');
  assert.equal(c.nameQuality, 'derived');
  assert.equal(c.ticketUrl, 'tickets.example.com/demo');
});
