/// <reference types="node" />
// Run: npm run ingest:test
//
// Regression tests for the second live Gemini evaluation: a request for 5 posts was cut off at its
// output-token limit (finish reason MAX_TOKENS), and all 5 posts were lost. All content is INVENTED;
// only the size/shape of the problem is modeled on the real run.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiExtractor } from './ai-extractor.ts';
import { ScriptedLlmClient, sentPosts } from './ai-mock.ts';
import { SYSTEM_PROMPT } from './ai-prompt.ts';
import { AnthropicLlmClient } from './anthropic-client.ts';
import {
  EVAL_BASE_REQUESTS, EVAL_BATCH_SIZE, EVAL_FALLBACK_REQUESTS, EVAL_MAX_COST_USD, EVAL_MAX_POSTS, EVAL_MAX_REQUESTS,
  EVAL_MIN_INTERVAL_MS, EVAL_OUTPUT_PER_POST, EVAL_OUTPUT_PER_REQUEST,
} from './eval-limits.ts';
import { GEMINI_PAID_REFERENCE_PRICING, GeminiLlmClient } from './gemini-client.ts';
import { LlmClientError } from './llm-client.ts';
import { ingest } from './pipeline.ts';
import { DEFAULT_POLICY, evaluateBatch, type PublishingPolicy } from './publishing.ts';
import type { InstagramPost } from './types.ts';

const NOW = '2026-10-14T04:00:00Z';
const ON: PublishingPolicy = { ...DEFAULT_POLICY, unattendedPublishingEnabled: true };
const KEY = 'AIzaFAKE-PLACEHOLDER-KEY-0123456789-NOT-REAL';
const post = (id: string, caption = `caption for ${id}`): InstagramPost => ({
  id, username: 'demo', caption, timestamp: '2026-09-10T10:00:00Z', permalink: `https://example.invalid/${id}`, origin: 'instagram-business-discovery',
});

const NO_TICKET = { url: null, minPhp: null, maxPhp: null, isFree: null, evidence: null };
const recap = (id: string) => ({
  id, classification: 'past_event_recap', update: 'none', notes: [],
  event: { officialTitle: null, displayLabel: null, artists: [], category: null, date: { value: null, endValue: null, evidence: null }, startTime: { value: null, evidence: null }, venue: { name: null, areaClue: null, evidence: null }, ticket: NO_TICKET },
});
const KC = 'DEMO BAND IS BACK\n\n🗓️ November 20, 2026\n📍 PICC Plenary Hall\n🎫 tickets.example.com/demo';
const goodKC = (id: string) => ({
  ...recap(id), classification: 'upcoming_event',
  event: {
    officialTitle: null, displayLabel: 'Demo Band at PICC Plenary Hall', artists: [{ name: 'DEMO BAND', evidence: 'DEMO BAND IS BACK' }], category: 'concert',
    date: { value: '2026-11-20', endValue: null, evidence: 'November 20, 2026' }, startTime: { value: null, evidence: null },
    venue: { name: 'PICC Plenary Hall', areaClue: null, evidence: 'PICC Plenary Hall' },
    ticket: { url: 'tickets.example.com/demo', minPhp: null, maxPhp: null, isFree: null, evidence: null },
  },
});

/** A client whose n-th call is scripted: a JSON array string, or a truncation with the partial text received. */
type Step = string | { truncated: string };
function scripted(steps: Step[]) {
  return new ScriptedLlmClient((_req, n) => {
    const s = steps[Math.min(n - 1, steps.length - 1)];
    if (typeof s === 'string') return s;
    throw new LlmClientError('truncated', 'reply cut off at 1200 output tokens', { partialText: s.truncated });
  });
}
const json = (...items: unknown[]) => JSON.stringify(items);

// ---- confirmed cause and the new limits

test('limits: 2 posts per request, 5 base requests, bounded fallback, headroom over the observed ~250-450 tokens per item', () => {
  assert.equal(EVAL_BATCH_SIZE, 2);
  assert.equal(EVAL_MAX_POSTS, 10);
  assert.equal(EVAL_BASE_REQUESTS, 5);
  assert.equal(EVAL_MAX_REQUESTS, EVAL_BASE_REQUESTS + EVAL_FALLBACK_REQUESTS);
  assert.equal(EVAL_OUTPUT_PER_REQUEST, EVAL_OUTPUT_PER_POST * 2);
  assert.equal(EVAL_OUTPUT_PER_REQUEST, 1400);
  assert.ok(EVAL_OUTPUT_PER_POST >= 450 * 1.3, 'each post must have headroom over the largest observed item');
  // The failing setup was 1,500 tokens for 5 posts (300 each), below what 5 verbose items needed.
  assert.ok(EVAL_OUTPUT_PER_POST > 300 * 1.5);
});

test('limits: the plan fits the free tier pacing and the worst-case cost cap', () => {
  assert.ok(EVAL_MAX_REQUESTS * EVAL_MIN_INTERVAL_MS <= 60_000, 'even with every fallback the run takes at most a minute');
  const price = GEMINI_PAID_REFERENCE_PRICING['gemini-3.5-flash-lite'];
  const perRequest = (1500 * 1.2 * price.inputPerMTok + EVAL_OUTPUT_PER_REQUEST * price.outputPerMTok) / 1_000_000;
  assert.ok(perRequest * EVAL_MAX_REQUESTS < EVAL_MAX_COST_USD, 'paid-tier worst case stays under the cap (free tier bills $0)');
});

test('output verbosity: the prompt asks for compact JSON and short evidence, and stays small', () => {
  assert.match(SYSTEM_PROMPT, /COMPACT JSON on one line/);
  assert.match(SYSTEM_PROMPT, /at most 60 characters/);
  assert.match(SYSTEM_PROMPT, /Never invent/); // anti-hallucination rules kept
  assert.match(SYSTEM_PROMPT, /UNTRUSTED DATA/);
  assert.ok(Math.ceil(SYSTEM_PROMPT.length / 4) < 1000, 'system prompt is repeated per request, keep it small');
  // A deliberately large item (3 artists, 60-char evidence everywhere) must fit twice in one request even pretty-printed.
  const ev = 'x'.repeat(60);
  const big = { id: '1234567890123456', classification: 'upcoming_event', update: 'none', notes: [ev], event: { officialTitle: ev, displayLabel: ev, artists: [1, 2, 3].map(() => ({ name: ev, evidence: ev })), category: 'concert', date: { value: '2026-11-20', endValue: '2026-11-21', evidence: ev }, startTime: { value: '20:00', evidence: ev }, venue: { name: ev, areaClue: ev, evidence: ev }, ticket: { url: ev, minPhp: 500, maxPhp: 800, isFree: false, evidence: ev } } };
  const prettyTokens = Math.ceil((JSON.stringify([big, big], null, 2).length / 4) * 1.35);
  assert.ok(prettyTokens < EVAL_OUTPUT_PER_REQUEST, `${prettyTokens} should be below ${EVAL_OUTPUT_PER_REQUEST}`);
});

// ---- batching

test('10 posts are sent as 5 requests of 2, each with the per-post output allowance and the reply schema', async () => {
  const c = new ScriptedLlmClient((req) => JSON.stringify(sentPosts(req).map((p) => recap(p.id))));
  const ex = new AiExtractor({ client: c, batchSize: EVAL_BATCH_SIZE, maxPosts: EVAL_MAX_POSTS, maxOutputTokensPerPost: EVAL_OUTPUT_PER_POST, splitOnTruncation: true });
  const posts = Array.from({ length: 10 }, (_, i) => post(`p${i}`));
  const run = await ingest(posts, ex, { now: NOW });
  assert.equal(c.calls, 5);
  assert.deepEqual(c.requests.map((r) => sentPosts(r).length), [2, 2, 2, 2, 2]);
  assert.ok(c.requests.every((r) => r.maxOutputTokens === EVAL_OUTPUT_PER_REQUEST && r.jsonSchema));
  assert.equal(run.items.filter((i) => i.classification === 'past_event_recap').length, 10);
  assert.equal(ex.stats.truncatedReplies, 0);
  assert.equal(ex.stats.fallbackRequests, 0);
});

// ---- truncation handling

test('a cut-off reply keeps the items that finished and fails only the unfinished post', async () => {
  const full = json(goodKC('a'), recap('b'));
  const cut = full.slice(0, full.indexOf('{"id":"b"') + 40); // inside item b
  const c = scripted([{ truncated: cut }]);
  const ex = new AiExtractor({ client: c, batchSize: 2 });
  const run = await ingest([post('a', KC), post('b')], ex, { now: NOW });
  assert.equal(c.calls, 1); // no fallback unless enabled
  assert.equal(run.items[0].classification, 'upcoming_event');
  assert.match(run.items[0].details!.schemaWarnings.join(' '), /recovered from a truncated reply/);
  assert.equal(run.items[1].classification, 'ambiguous');
  assert.ok(run.items[1].reviewReasons.includes('ai_invalid_response'));
  assert.match(run.items[1].details!.notes.join(' '), /truncated/);
  assert.equal(ex.stats.truncatedReplies, 1);
  assert.equal(ex.stats.failedPosts, 1);
});

test('with splitOnTruncation the unfinished posts are re-sent one per request, once', async () => {
  const c = scripted([{ truncated: '[{"id":"a","classif' }, json(goodKC('a')), json(recap('b'))]);
  const ex = new AiExtractor({ client: c, batchSize: 2, splitOnTruncation: true });
  const run = await ingest([post('a', KC), post('b')], ex, { now: NOW });
  assert.equal(c.calls, 3);
  assert.deepEqual(c.requests.map((r) => sentPosts(r).map((p) => p.id)), [['a', 'b'], ['a'], ['b']]);
  assert.equal(run.items[0].classification, 'upcoming_event');
  assert.equal(run.items[1].classification, 'past_event_recap');
  assert.equal(ex.stats.fallbackRequests, 2);
  assert.equal(ex.stats.postsSent, 2); // fallback re-sends are not new posts
});

test('a one-post request that is cut off is not split or retried again', async () => {
  const c = scripted([{ truncated: '[{"id":"a"' }, { truncated: '[{"id":"a"' }, { truncated: '[{"id":"b"' }]);
  const ex = new AiExtractor({ client: c, batchSize: 2, splitOnTruncation: true });
  const run = await ingest([post('a'), post('b')], ex, { now: NOW });
  assert.equal(c.calls, 3); // 1 pair + 1 each, then stop
  assert.ok(run.items.every((i) => i.reviewReasons.includes('ai_invalid_response')));
  assert.equal(ex.stats.failedPosts, 2);
});

test('fallbacks respect the request cap of the real Gemini client, then the run stops', async () => {
  const calls: unknown[] = [];
  const replies = [
    { candidates: [{ content: { parts: [{ text: '[{"id":"a"' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 1200 } },
    { candidates: [{ content: { parts: [{ text: json(recap('a')) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 100 } },
  ];
  const fetchImpl = (async (_u: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body));
    const body = replies[Math.min(calls.length - 1, replies.length - 1)];
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
  }) as never;
  const client = new GeminiLlmClient({ apiKey: KEY, fetchImpl, maxRequests: 2, minIntervalMs: 0, sleep: async () => {} });
  const ex = new AiExtractor({ client, batchSize: 2, splitOnTruncation: true, maxOutputTokensPerPost: 600 });
  const run = await ingest([post('a'), post('b'), post('c'), post('d')], ex, { now: NOW });
  assert.equal(calls.length, 2, 'never more requests than the cap');
  assert.equal((calls[0] as any).generationConfig.maxOutputTokens, 1200);
  assert.equal(run.items[0].classification, 'past_event_recap'); // a: recovered by the one-post fallback
  for (const i of run.items.slice(1)) assert.ok(i.reviewReasons.includes('ai_invalid_response'), i.postId);
  assert.match(run.items[3].details!.notes.join(' '), /skipped_after_fatal_error/);
  assert.equal(client.totals.requests, 2);
});

test('truncation in one request never contaminates posts in another, and truncated posts cannot publish', async () => {
  const c = scripted([json(goodKC('a'), recap('b')), { truncated: '[{"id":"c","classification":"upcoming_event","event":{"officialTitle":null' }]);
  const ex = new AiExtractor({ client: c, batchSize: 2 });
  const posts = [post('a', KC), post('b'), post('c', KC), post('d')];
  const run = await ingest(posts, ex, { now: NOW });
  const ds = evaluateBatch(run.items, { now: NOW, extractor: run.extractor, policy: ON });
  assert.deepEqual(ds.map((d) => d.action), ['publish', 'reject', 'hold', 'hold']);
  assert.equal(run.items[2].candidate!.venueName, null); // nothing from the cut-off text was used
  assert.ok(ds[2].blockers.includes('ai_output_clean'));
  assert.ok(ds[3].blockers.includes('ai_output_clean'));
});

test('a recovered item from a cut-off reply still faces full grounding', async () => {
  // Item "a" is complete JSON but claims a venue the caption does not contain.
  const lie = goodKC('a');
  lie.event.venue.name = 'Imaginary Dome';
  const cut = json(lie, recap('b')).slice(0, -30);
  const run = await ingest([post('a', KC), post('b')], new AiExtractor({ client: scripted([{ truncated: cut }]), batchSize: 2 }), { now: NOW });
  assert.ok(run.items[0].details!.ungroundedFields.includes('venue'));
  assert.equal(run.items[0].candidate?.venueName ?? null, null);
  const d = evaluateBatch(run.items, { now: NOW, extractor: run.extractor, policy: ON })[0];
  assert.notEqual(d.action, 'publish');
});

// ---- clients expose the partial text safely

test('Gemini: the truncation error carries the partial text out of band, with usage still counted', async () => {
  const body = { candidates: [{ content: { parts: [{ text: 'secret thoughts', thought: true }, { text: '[{"id":"a"' }] }, finishReason: 'MAX_TOKENS' }], usageMetadata: { promptTokenCount: 700, candidatesTokenCount: 900, thoughtsTokenCount: 300 } };
  const client = new GeminiLlmClient({ apiKey: KEY, fetchImpl: (async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => body })) as never, minIntervalMs: 0, sleep: async () => {} });
  let err: LlmClientError | null = null;
  try {
    await client.complete({ system: 's', user: 'u', maxOutputTokens: 1200 });
  } catch (e) {
    err = e as LlmClientError;
  }
  assert.ok(err);
  assert.equal(err.kind, 'truncated');
  assert.equal(err.fatalForRun, false);
  assert.equal(err.partialText, '[{"id":"a"'); // thought parts excluded
  assert.equal(err.message.includes('id'), false); // partial text is never in the message
  assert.equal(JSON.stringify(err).includes('{"id"'), false); // nor enumerable/loggable
  assert.deepEqual(client.totals, { requests: 1, inputTokens: 700, outputTokens: 1200 }); // billed tokens counted
});

test('Anthropic client also exposes partial text on truncation', async () => {
  const fetchImpl = (async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ content: [{ type: 'text', text: '[{"id":"a"' }], stop_reason: 'max_tokens', usage: { input_tokens: 5, output_tokens: 9 } }) })) as never;
  const c = new AnthropicLlmClient({ apiKey: 'FAKE-TEST-KEY-0123456789-abcdefghijklmnop-NOT-REAL', fetchImpl });
  try {
    await c.complete({ system: 's', user: 'u', maxOutputTokens: 100 });
    assert.fail('expected truncation');
  } catch (e) {
    assert.equal((e as LlmClientError).kind, 'truncated');
    assert.equal((e as LlmClientError).partialText, '[{"id":"a"');
  }
});
