/// <reference types="node" />
// Run: npm run ingest:test
// These tests use invented events. Posts get origin 'instagram-business-discovery' only so the
// real_source check can pass; the content itself is synthetic.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyUpdate, createRecord, expireStale, findMatch, publish, reject, unpublish } from './lifecycle.ts';
import { ingest } from './pipeline.ts';
import { DEFAULT_POLICY, evaluateBatch, evaluatePublishing, summarize, type PublishingPolicy } from './publishing.ts';
import { RulesExtractor } from './rules-extractor.ts';
import { SimulatedExtractor } from './simulated-extractor.ts';
import type { ExtractedFields, ExtractionDraft, InstagramPost, ReviewReason } from './types.ts';

const NOW = '2026-10-14T04:00:00Z';
const ON: PublishingPolicy = { ...DEFAULT_POLICY, unattendedPublishingEnabled: true };

const GOOD: ExtractedFields = {
  name: 'Demo Band in Manila',
  nameQuality: 'derived',
  category: 'concert',
  date: '2026-11-20',
  endDate: '2026-11-20',
  startTime: null,
  venueName: 'PICC Plenary Hall',
  venueArea: null,
  artists: ['Demo Band'],
  genre: null,
  ticketPrice: null,
  ticketUrl: 'tickets.example.com/demo',
};

const post = (id: string, origin: InstagramPost['origin'] = 'instagram-business-discovery', timestamp = '2026-09-10T10:00:00Z'): InstagramPost => ({
  id, username: 'demo_promoter', caption: 'ignored by the simulated extractor', timestamp, permalink: `https://example.invalid/${id}`, origin,
});

const sim = new SimulatedExtractor({});

/** Runs one invented post through the real pipeline with a canned (simulated) draft. */
async function item(id: string, fields: Partial<ExtractedFields> = {}, draft: Partial<ExtractionDraft> = {}, origin: InstagramPost['origin'] = 'instagram-business-discovery', ts?: string) {
  const extractor = new SimulatedExtractor({
    [id]: { classification: 'upcoming_event', fields: { ...GOOD, ...fields }, flags: [], ...draft },
  });
  const r = await ingest([post(id, origin, ts)], extractor, { now: NOW });
  return r.items[0];
}
const opts = { now: NOW, extractor: sim.info };
const decide = async (id: string, f: Partial<ExtractedFields> = {}, d: Partial<ExtractionDraft> = {}, policy = DEFAULT_POLICY) =>
  evaluatePublishing(await item(id, f, d), { ...opts, policy });

// ---- eligibility

test('unattended publishing is disabled by default', () => {
  assert.equal(DEFAULT_POLICY.unattendedPublishingEnabled, false);
});

test('a fully valid event is eligible but NOT published while the switch is off', async () => {
  const d = await decide('ok');
  assert.equal(d.decision, 'eligible');
  assert.equal(d.action, 'none');
  assert.deepEqual(d.blockers, []);
  assert.match(d.summary, /disabled/);
  assert.equal(d.venue?.id, 'picc-plenary-hall');
  // Unknown start time and price are warnings, never blockers.
  assert.ok(d.warnings.includes('start_time_known'));
});

test('the same event is published when the switch is on', async () => {
  const d = await decide('ok2', {}, {}, ON);
  assert.equal(d.action, 'publish');
});

test('every decision is explainable: each check has a detail and blockers are failed blocker checks', async () => {
  const d = await decide('why', { venueName: 'Unknown Hall' });
  assert.ok(d.checks.every((c) => c.detail.length > 0));
  const failedBlockers = d.checks.filter((c) => !c.passed && c.severity === 'blocker').map((c) => c.id);
  assert.deepEqual(d.blockers, failedBlockers);
  assert.ok(d.blockers.includes('venue_verified'));
  assert.ok(d.blockers.includes('in_metro_manila'));
});

test('missing, ambiguous or unreliable details hold the event instead of publishing it', async () => {
  const cases: [string, Partial<ExtractedFields>, ReviewReason[], string][] = [
    ['guessed name', { nameQuality: 'guessed' }, [], 'name_reliable'],
    ['no name', { name: null, nameQuality: null }, [], 'name_reliable'],
    ['no venue', { venueName: null }, [], 'venue_named'],
    ['unknown venue', { venueName: 'Unknown Hall' }, [], 'venue_verified'],
    ['no date', { date: null, endDate: null }, ['missing_date' as ReviewReason], 'date_known'],
    ['ambiguous date', { date: null, endDate: null }, ['ambiguous_date'], 'date_known'],
    ['several dates', { date: null, endDate: null }, ['multiple_dates'], 'date_known'],
    ['inferred year', {}, ['year_inferred'], 'date_explicit_year'],
    ['cancelled', {}, ['cancellation_signal'], 'no_cancellation'],
    ['too far ahead', { date: '2030-01-01', endDate: '2030-01-01' }, [], 'date_within_horizon'],
  ];
  for (const [label, fields, flags, blocker] of cases) {
    const d = await decide(`hold-${label}`, fields, { flags });
    assert.equal(d.decision, 'hold', label);
    assert.equal(d.action, 'hold', label);
    assert.ok(d.blockers.includes(blocker as never), `${label}: expected blocker ${blocker}, got ${d.blockers}`);
  }
});

test('recaps, unrelated posts, duplicates, past events and synthetic data are rejected automatically', async () => {
  const recap = await item('r1', {}, { classification: 'past_event_recap' });
  assert.equal(evaluatePublishing(recap, opts).decision, 'reject');
  const unrelated = await item('r2', {}, { classification: 'unrelated' });
  assert.equal(evaluatePublishing(unrelated, opts).decision, 'reject');

  const e = new SimulatedExtractor({ dup: { classification: 'upcoming_event', fields: GOOD } });
  const twice = await ingest([post('dup'), post('dup')], e, { now: NOW });
  assert.equal(evaluatePublishing(twice.items[1], opts).decision, 'reject');
  assert.match(evaluatePublishing(twice.items[1], opts).summary, /duplicate/);

  const past = await decide('past', { date: '2026-09-01', endDate: '2026-09-01' });
  assert.equal(past.decision, 'reject');
  const synthetic = evaluatePublishing(await item('syn', {}, {}, 'synthetic'), opts);
  assert.equal(synthetic.decision, 'reject');
  assert.ok(synthetic.blockers.includes('real_source'));
});

test('ambiguous classification is held for enrichment, not rejected', async () => {
  const d = evaluatePublishing(await item('amb', {}, { classification: 'ambiguous' }), opts);
  assert.equal(d.decision, 'hold');
  assert.ok(d.blockers.includes('classification'));
});

test('real data through the rules extractor is held: a guessed name blocks auto-publishing', async () => {
  const p: InstagramPost = {
    ...post('rules-kc'),
    caption: 'THE DEMO BAND IS COMING BACK TO MANILA AFTER 16 YEARS\n\n🗓️ November 20, 2026\n📍 PICC Plenary Hall\n🎫 tickets.example.com/demo',
  };
  const r = await ingest([p], new RulesExtractor(), { now: NOW });
  const d = evaluatePublishing(r.items[0], { now: NOW, extractor: r.extractor, policy: ON });
  assert.equal(d.decision, 'hold');
  assert.deepEqual(d.blockers, ['name_reliable']);
  assert.equal(d.action, 'hold');
  assert.equal(d.venue?.id, 'picc-plenary-hall'); // venue and date checks pass; only the name blocks
});

test('rules extractor flags cancellation wording', async () => {
  const p: InstagramPost = { ...post('cx'), caption: 'UPDATE: the Demo Band concert on November 20, 2026 at PICC Plenary Hall is postponed.' };
  const r = await ingest([p], new RulesExtractor(), { now: NOW });
  assert.ok(r.items[0].reviewReasons.includes('cancellation_signal'));
});

// ---- batch merge

test('posts announcing the same event are merged; every source is preserved', async () => {
  const extractor = new SimulatedExtractor({
    a: { classification: 'upcoming_event', fields: GOOD },
    b: { classification: 'upcoming_event', fields: GOOD },
  });
  const r = await ingest([post('b', undefined, '2026-09-12T00:00:00Z'), post('a', undefined, '2026-09-10T00:00:00Z')], extractor, { now: NOW });
  const ds = evaluateBatch(r.items, { now: NOW, extractor: extractor.info });
  const byId = Object.fromEntries(ds.map((d) => [d.postId, d]));
  assert.equal(byId.a.decision, 'eligible'); // earliest post is primary
  assert.deepEqual(byId.a.mergedSourcePostIds, ['b']);
  assert.equal(byId.b.decision, 'reject');
  const rec = createRecord(r.items[1], byId.a, NOW, [r.items[0]]);
  assert.deepEqual(rec.sourcePostIds.sort(), ['a', 'b']);
  assert.equal(rec.sourceUrls.length, 2);
});

test('monitoring summary counts decisions and ranks blockers', async () => {
  const a = await item('s1');
  const b = await item('s2', { venueName: 'Unknown Hall' });
  const c = await item('s3', { venueName: 'Other Hall' });
  const d = await item('s4', {}, { classification: 'unrelated' });
  const s = summarize(evaluateBatch([a, b, c, d], { now: NOW, extractor: sim.info }));
  assert.deepEqual({ total: s.total, eligible: s.eligible, hold: s.hold, reject: s.reject }, { total: 4, eligible: 1, hold: 2, reject: 1 });
  assert.equal(s.topBlockers[0][1], 2);
});

// ---- lifecycle

async function heldRecord(id = 'life') {
  const it = await item(id);
  const dec = evaluatePublishing(it, { ...opts, policy: ON });
  return { it, dec, rec: createRecord(it, dec, NOW) };
}

test('system cannot publish while unattended publishing is disabled; an admin can', async () => {
  const { rec } = await heldRecord();
  const blocked = publish(rec, DEFAULT_POLICY, 'system', 'auto', NOW);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.record.state, 'held');
  const viaAdmin = publish(rec, DEFAULT_POLICY, 'admin', 'manual exception', NOW);
  assert.equal(viaAdmin.ok, true);
  assert.equal(viaAdmin.record.state, 'published');
  const sys = publish(rec, ON, 'system', 'auto', NOW);
  assert.equal(sys.ok && sys.record.state, 'published');
});

test('nothing publishes without a verified location, even by an admin', async () => {
  const it = await item('noloc', { venueName: 'Unknown Hall' });
  const rec = createRecord(it, evaluatePublishing(it, opts), NOW);
  assert.equal(rec.location, null);
  const res = publish(rec, ON, 'admin', 'try', NOW);
  assert.equal(res.ok, false);
});

test('invalid transitions are refused and history records every change', async () => {
  const { rec } = await heldRecord();
  assert.equal(unpublish(rec, 'system', 'x', NOW).ok, false); // held -> unpublished is not allowed
  const pub = publish(rec, ON, 'system', 'auto', NOW);
  assert.ok(pub.ok);
  const un = unpublish(pub.record, 'admin', 'wrong venue', NOW);
  assert.ok(un.ok);
  assert.deepEqual(un.record.history.map((h) => `${h.from}->${h.to}:${h.actor}`), ['null->held:system', 'held->published:system', 'published->unpublished:admin']);
  assert.equal(reject(un.record, 'admin', 'bad data', NOW).ok, true);
});

test('published events expire automatically after their last day', async () => {
  const { rec } = await heldRecord();
  const pub = publish(rec, ON, 'system', 'auto', NOW);
  assert.ok(pub.ok);
  assert.equal(expireStale([pub.record], '2026-11-20T15:00:00Z')[0].state, 'published'); // still the 20th in Manila
  assert.equal(expireStale([pub.record], '2026-11-20T16:00:00Z')[0].state, 'expired'); // 00:00 on the 21st in Manila
});

test('a later cancellation post automatically unpublishes the event and keeps the source', async () => {
  const { rec } = await heldRecord('orig');
  const pub = publish(rec, ON, 'system', 'auto', NOW);
  assert.ok(pub.ok);
  const cancel = await item('orig', {}, { flags: ['cancellation_signal'] });
  const dec = evaluatePublishing(cancel, { ...opts, policy: ON });
  assert.equal(dec.decision, 'hold');
  assert.equal(findMatch([pub.record], cancel)?.id, pub.record.id);
  const after = applyUpdate(pub.record, cancel, dec, ON, NOW);
  assert.equal(after.state, 'unpublished');
  assert.match(after.history.at(-1)!.reason, /no_cancellation/);
  assert.deepEqual(after.sourceUrls, pub.record.sourceUrls);
});

test('a corrected date updates a published event in place; a broken one pulls it', async () => {
  const { rec } = await heldRecord('upd');
  const pub = publish(rec, ON, 'system', 'auto', NOW);
  assert.ok(pub.ok);

  const moved = await item('upd', { date: '2026-11-27', endDate: '2026-11-27' });
  const ok = applyUpdate(pub.record, moved, evaluatePublishing(moved, { ...opts, policy: ON }), ON, NOW);
  assert.equal(ok.state, 'published');
  assert.equal(ok.candidate.date, '2026-11-27');
  assert.match(ok.history.at(-1)!.reason, /updated from source: date, endDate/);

  const broken = await item('upd', { date: null, endDate: null }, { flags: ['ambiguous_date'] });
  const pulled = applyUpdate(ok, broken, evaluatePublishing(broken, { ...opts, policy: ON }), ON, NOW);
  assert.equal(pulled.state, 'unpublished');
});

test('a held event that later passes all checks publishes itself only when the switch is on', async () => {
  const bad = await item('late', { nameQuality: 'guessed' });
  const held = createRecord(bad, evaluatePublishing(bad, opts), NOW);
  const fixed = await item('late');
  const dec = evaluatePublishing(fixed, { ...opts, policy: ON });
  assert.equal(applyUpdate(held, fixed, dec, DEFAULT_POLICY, NOW).state, 'held');
  assert.equal(applyUpdate(held, fixed, dec, ON, NOW).state, 'published');
});
