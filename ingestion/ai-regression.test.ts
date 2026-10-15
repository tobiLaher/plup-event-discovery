/// <reference types="node" />
// Run: npm run ingest:test
//
// Regression tests for the failures found in the first live Gemini evaluation (10 real posts):
//  1. the model emitted structurally broken JSON for 3 of 5 items in one reply (a stray object where
//     the `venue` object should continue), so the WHOLE reply was rejected and all 5 posts lost;
//  2. "tonight" posts that the model called upcoming were left ambiguous instead of past recaps;
//  3. a hashtag was accepted as an official title;
//  4. nothing in publishing treated an invalid/partly unsupported AI reply as a reason to hold.
// All captions and replies below are INVENTED; only the broken shape imitates the real failure.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AiExtractor } from './ai-extractor.ts';
import { ScriptedLlmClient } from './ai-mock.ts';
import { isHashtagTitle } from './ai-grounding.ts';
import { AI_JSON_SCHEMA } from './ai-response-schema.ts';
import { parseBatchResponse } from './ai-schema.ts';
import { GeminiLlmClient, toGeminiSchema } from './gemini-client.ts';
import { ingest } from './pipeline.ts';
import { DEFAULT_POLICY, evaluateBatch, type PublishingPolicy } from './publishing.ts';
import type { InstagramPost } from './types.ts';

const NOW = '2026-10-14T04:00:00Z';
const ON: PublishingPolicy = { ...DEFAULT_POLICY, unattendedPublishingEnabled: true };
const post = (id: string, caption: string, timestamp = '2026-09-10T10:00:00Z'): InstagramPost => ({
  id, username: 'demo', caption, timestamp, permalink: `https://example.invalid/${id}`, origin: 'instagram-business-discovery',
});

const NO_TICKET = { url: null, minPhp: null, maxPhp: null, isFree: null, evidence: null };
const event = (over: Record<string, unknown> = {}) => ({
  officialTitle: null, displayLabel: null, artists: [], category: null,
  date: { value: null, endValue: null, evidence: null }, startTime: { value: null, evidence: null },
  venue: { name: null, areaClue: null, evidence: null }, ticket: NO_TICKET, ...over,
});
const item = (id: string, over: Record<string, unknown> = {}): Record<string, any> => ({ id, classification: 'past_event_recap', update: 'none', event: null, notes: [], ...over });

/** The real failure shape: after `venue`, the model wrote `,{"ticket":...}` as an anonymous object. */
function brokenItemText(id: string): string {
  const good = JSON.stringify(item(id, { classification: 'upcoming_event', event: event({ venue: { name: 'Example Hall', areaClue: null, evidence: 'Example Hall' } }) }));
  const ticket = JSON.stringify({ ticket: NO_TICKET });
  // `"venue":{...},"ticket":{...}` becomes `"venue":{...},{"ticket":{...}}`
  const broken = good.replace(/"ticket":\{[^}]*\}/, ticket);
  assert.throws(() => JSON.parse(broken));
  return broken;
}

const KC = 'THE DEMO BAND IS BACK\n\n🗓️ November 20, 2026\n📍 PICC Plenary Hall\n🎫 tickets.example.com/demo';
const goodKC = (id: string) => item(id, {
  classification: 'upcoming_event',
  event: event({
    displayLabel: 'Demo Band at PICC Plenary Hall',
    artists: [{ name: 'DEMO BAND', evidence: 'THE DEMO BAND IS BACK' }],
    category: 'concert',
    date: { value: '2026-11-20', endValue: null, evidence: 'November 20, 2026' },
    venue: { name: 'PICC Plenary Hall', areaClue: null, evidence: 'PICC Plenary Hall' },
    ticket: { url: 'tickets.example.com/demo', minPhp: null, maxPhp: null, isFree: null, evidence: null },
  }),
});

// ---- 1. invalid JSON from the model

test('one structurally broken item no longer destroys the whole reply', () => {
  const text = '[' + [brokenItemText('a'), JSON.stringify(item('b')), brokenItemText('c'), JSON.stringify(item('d')), brokenItemText('e')].join(',') + ']';
  assert.throws(() => JSON.parse(text)); // the full reply really is invalid, as in the live run
  const r = parseBatchResponse(text);
  assert.ok(r.ok);
  assert.deepEqual([...r.items.keys()].sort(), ['a', 'b', 'c', 'd', 'e']);
  assert.equal(r.items.get('b')!.ok, true);
  assert.equal(r.items.get('d')!.ok, true);
  for (const id of ['a', 'c', 'e']) assert.equal(r.items.get(id)!.ok, false, id);
  assert.match(r.warnings.join(' '), /recovered 2 of 5/);
});

test('through the pipeline: broken items are held, recovered items are used, the run completes', async () => {
  const text = '[' + [brokenItemText('p0'), JSON.stringify(item('p1')), brokenItemText('p2'), JSON.stringify(item('p3', { classification: 'unrelated' })), brokenItemText('p4')].join(',') + ']';
  const client = new ScriptedLlmClient(() => text);
  const ex = new AiExtractor({ client });
  const run = await ingest(['p0', 'p1', 'p2', 'p3', 'p4'].map((id) => post(id, `caption ${id}`)), ex, { now: NOW });
  assert.equal(client.calls, 1);
  assert.deepEqual(run.items.map((i) => i.classification), ['ambiguous', 'past_event_recap', 'ambiguous', 'unrelated', 'ambiguous']);
  assert.deepEqual(run.items.map((i) => i.reviewReasons.includes('ai_invalid_response')), [true, false, true, false, true]);
  assert.equal(ex.stats.failedPosts, 3);
  assert.match(run.items[1].details!.schemaWarnings.join(' '), /recovered 2 of 5/);
});

test('a reply that is cut off mid-item still yields the complete items before the cut', () => {
  const full = JSON.stringify([item('a'), item('b'), item('c', { classification: 'unrelated' })]);
  const cut = full.slice(0, full.lastIndexOf('"classification"') + 8); // ends inside item c
  assert.throws(() => JSON.parse(cut));
  const r = parseBatchResponse(cut);
  assert.ok(r.ok);
  assert.equal(r.items.get('a')!.ok, true);
  assert.equal(r.items.get('b')!.ok, true);
  assert.equal(r.items.get('c')!.ok, false);
});

test('salvage cannot be tricked by item-start text inside a string, and unparseable replies still fail cleanly', () => {
  const tricky = JSON.stringify([item('a', { notes: ['{"id":"victim","classification":"upcoming_event"'] })]);
  const ok = parseBatchResponse(tricky);
  assert.ok(ok.ok);
  assert.deepEqual([...ok.items.keys()], ['a']); // normal parse path: no fake item appears
  assert.equal(parseBatchResponse('Sure! Here is the event.').ok, false);
  assert.equal(parseBatchResponse('').ok, false);
});

// ---- constrained generation (documented Gemini responseSchema)

test('Gemini requests carry a converted responseSchema (and can be switched off)', async () => {
  const bodies: any[] = [];
  const fetchImpl = (async (_u: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ candidates: [{ content: { parts: [{ text: '[]' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 } }) };
  }) as never;
  const KEY = 'AIzaFAKE-PLACEHOLDER-KEY-0123456789-NOT-REAL';
  const req = { system: 's', user: '[]', maxOutputTokens: 100, jsonSchema: AI_JSON_SCHEMA };
  await new GeminiLlmClient({ apiKey: KEY, fetchImpl, minIntervalMs: 0, sleep: async () => {} }).complete(req);
  await new GeminiLlmClient({ apiKey: KEY, fetchImpl, minIntervalMs: 0, sleep: async () => {}, useResponseSchema: false }).complete(req);
  const withSchema = bodies[0].generationConfig;
  assert.equal(withSchema.responseMimeType, 'application/json');
  assert.equal(withSchema.responseSchema.type, 'ARRAY');
  assert.equal(withSchema.responseSchema.items.type, 'OBJECT');
  assert.deepEqual(withSchema.responseSchema.items.required, ['id', 'classification', 'update', 'event', 'notes']);
  assert.equal('responseSchema' in bodies[1].generationConfig, false);
});

test('schema conversion: upper-case types, nullable instead of "null", no null in enums, ordered properties', () => {
  const s = toGeminiSchema(AI_JSON_SCHEMA);
  const ev = s.items.properties.event;
  assert.equal(ev.type, 'OBJECT');
  assert.equal(ev.nullable, true);
  assert.deepEqual(s.items.properties.classification.enum, ['upcoming_event', 'past_event_recap', 'unrelated', 'ambiguous']);
  assert.equal(s.items.properties.classification.nullable, undefined);
  assert.deepEqual(ev.properties.category.enum, ['concert', 'nightlife', 'festival', 'other']);
  assert.equal(ev.properties.category.nullable, true);
  assert.equal(ev.properties.date.properties.value.type, 'STRING');
  assert.equal(ev.properties.date.properties.value.nullable, true);
  assert.equal(ev.properties.ticket.properties.minPhp.type, 'NUMBER');
  assert.equal(ev.properties.ticket.properties.isFree.type, 'BOOLEAN');
  assert.deepEqual(ev.propertyOrdering, Object.keys(AI_JSON_SCHEMA.items ? (AI_JSON_SCHEMA as any).items.properties.event.properties : {}));
  assert.equal(JSON.stringify(s).includes('"null"'), false);
});

test('the response schema and our validator agree: an instance built from the schema is accepted', () => {
  const build = (n: any): unknown => {
    const types: string[] = Array.isArray(n.type) ? n.type : [n.type];
    if (types.includes('null')) return null;
    if (n.enum) return n.enum[0];
    if (types[0] === 'object') return Object.fromEntries((n.required ?? []).map((k: string) => [k, build(n.properties[k])]));
    if (types[0] === 'array') return [];
    if (types[0] === 'string') return 'x';
    return 0;
  };
  const instance = build(AI_JSON_SCHEMA.items);
  const r = parseBatchResponse(JSON.stringify([{ ...(instance as object), id: 'a' }]));
  assert.ok(r.ok);
  assert.equal(r.items.get('a')!.ok, true);
});

// ---- 2. classification of stale "tonight" posts

test('a stale "tonight" post that the model calls upcoming becomes a past recap, not ambiguous', async () => {
  const reply = (ps: { id: string }[]) => JSON.stringify(ps.map((p) => item(p.id, { classification: 'upcoming_event', event: event({ displayLabel: 'Demo Band' }) })));
  const client = new ScriptedLlmClient((req) => reply(JSON.parse(req.user)));
  const old = await ingest([post('t', 'Demo Band live tonight! See you there!', '2026-08-10T07:00:00Z')], new AiExtractor({ client }), { now: NOW });
  assert.equal(old.items[0].classification, 'past_event_recap');
  const fresh = await ingest([post('t2', 'Demo Band live tonight! See you there!', '2026-10-14T01:00:00Z')], new AiExtractor({ client }), { now: NOW });
  assert.equal(fresh.items[0].classification, 'ambiguous'); // same day: genuinely unclear, held
});

// ---- 3. hashtag titles

test('a hashtag is not an official title; a real multi-word title is kept', async () => {
  assert.equal(isHashtagTitle('DemoTour2026', 'Great night #DemoTour2026'), true);
  assert.equal(isHashtagTitle('#DemoTour2026', 'x'), true);
  assert.equal(isHashtagTitle('Demo Tour 2026', 'Demo Tour 2026 #DemoTour2026'), false);
  assert.equal(isHashtagTitle('DemoTour', 'DemoTour is here'), false); // used as plain text, not a tag
  const cap = 'Last night was amazing #DemoTour2026';
  const run = (title: string, caption: string) =>
    ingest([post('h', caption)], new AiExtractor({ client: new ScriptedLlmClient((r) => JSON.stringify(JSON.parse(r.user).map((p: { id: string }) => item(p.id, { classification: 'past_event_recap', event: event({ officialTitle: title }) })))) }), { now: NOW });
  const tag = await run('DemoTour2026', cap);
  assert.equal(tag.items[0].details!.ungroundedFields.includes('officialTitle:hashtag'), true);
  assert.equal((await run('Demo Tour 2026', 'Demo Tour 2026 recap')).items[0].details!.ungroundedFields.length, 0);
});

// ---- 4. publishing must hold on uncertain AI output

async function decisionFor(reply: unknown, caption = KC) {
  const client = new ScriptedLlmClient(() => (typeof reply === 'string' ? reply : JSON.stringify([reply])));
  const run = await ingest([post('x', caption)], new AiExtractor({ client }), { now: NOW });
  return evaluateBatch(run.items, { now: NOW, extractor: run.extractor, policy: ON })[0];
}

test('baseline: a clean, fully supported reply is eligible (and publishes only with the switch on)', async () => {
  const d = await decisionFor(goodKC('x'));
  assert.equal(d.decision, 'eligible');
  assert.equal(d.action, 'publish'); // policy ON in this helper
  const off = await ingest([post('x', KC)], new AiExtractor({ client: new ScriptedLlmClient(() => JSON.stringify([goodKC('x')])) }), { now: NOW });
  assert.equal(evaluateBatch(off.items, { now: NOW, extractor: off.extractor })[0].action, 'none'); // default policy: disabled
});

test('an invalid reply, or one with unsupported claims, can never authorize publication', async () => {
  const withLie = goodKC('x');
  (withLie.event as any).artists.push({ name: 'Totally Invented Guest', evidence: null });
  const cases: [string, unknown][] = [
    ['broken JSON', '[{"id":"x","classification":"upcoming_event"'],
    ['not JSON', 'I could not do that.'],
    ['unsupported artist alongside valid fields', withLie],
    ['unsupported ticket link', item('x', { classification: 'upcoming_event', event: { ...(goodKC('x').event as object), ticket: { ...NO_TICKET, url: 'scam.example/pay' } } })],
    ['unsupported date', item('x', { classification: 'upcoming_event', event: { ...(goodKC('x').event as object), date: { value: '2027-03-03', endValue: null, evidence: null } } })],
    ['model reports cancellation', { ...goodKC('x'), update: 'cancelled' }],
  ];
  for (const [label, reply] of cases) {
    const d = await decisionFor(reply);
    assert.notEqual(d.action, 'publish', label);
    assert.notEqual(d.decision, 'eligible', label);
  }
  const lie = await decisionFor(withLie);
  assert.ok(lie.blockers.includes('ai_output_clean'));
});

test('a rules-extractor fallback after an invalid AI reply is held, never published', async () => {
  const { FallbackExtractor } = await import('./ai-extractor.ts');
  const ex = new FallbackExtractor(new AiExtractor({ client: new ScriptedLlmClient(() => 'not json') }));
  const run = await ingest([post('f', KC)], ex, { now: NOW });
  const d = evaluateBatch(run.items, { now: NOW, extractor: run.extractor, policy: ON })[0];
  assert.equal(d.action, 'hold');
  assert.ok(d.blockers.includes('ai_output_clean'));
});

test('a poor batch yields at most the single clean event; everything else is held or rejected', async () => {
  const posts = [post('a', KC), post('b', 'caption b'), post('c', 'caption c'), post('d', 'caption d'), post('e', 'caption e')];
  const text = '[' + [JSON.stringify(goodKC('a')), brokenItemText('b'), JSON.stringify(item('c')), brokenItemText('d'), brokenItemText('e')].join(',') + ']';
  const run = await ingest(posts, new AiExtractor({ client: new ScriptedLlmClient(() => text) }), { now: NOW });
  const ds = evaluateBatch(run.items, { now: NOW, extractor: run.extractor, policy: ON });
  assert.deepEqual(ds.map((d) => d.action), ['publish', 'hold', 'reject', 'hold', 'hold']);
});
