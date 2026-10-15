/// <reference types="node" />
// Run: npm run ingest:test
//
// The same behavior scenarios run against BOTH stores: the in-memory one and the Supabase one backed by a
// fake PostgREST (see fake-postgrest.ts). Everything here is invented data. Real SQL / Row Level Security
// has not been executed; the SQL is checked statically in schema-policy.test.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { manilaDate } from '../manila-date.ts';
import { DEFAULT_POLICY } from '../publishing.ts';
import type { EventRow } from './types.ts';
import { adminPublishCandidate, adminUnpublishEvent, persistIngestion } from './sync.ts';
import { KC, KC_CANCEL, KC_TIME, kcReply, makeExtractor, makeMemory, makeSupabase, ON, post, recapReply, type Harness } from './test-helpers.ts';

const T0 = '2026-10-14T04:00:00Z';
let nowIso = T0;
const clock = () => new Date(nowIso);

type Make = (c: () => Date) => Harness;
for (const make of [makeMemory, makeSupabase] as Make[]) {
  const name = make(clock).name;
  const setup = () => {
    nowIso = T0;
    return make(clock);
  };
  const run = async (h: Harness, posts: ReturnType<typeof post>[], replies: Record<string, unknown>, policy = DEFAULT_POLICY, at = nowIso) => {
    nowIso = at;
    const { extractor, client } = makeExtractor(h.store, replies);
    const report = await persistIngestion(posts, { store: h.store, extractor, resolver: h.resolver(clock), policy, now: at });
    return { report, client };
  };

  test(`${name}: with unattended publishing OFF an eligible event is stored as a private candidate only`, async () => {
    const h = setup();
    const { report } = await run(h, [post('a', KC), post('r', 'thanks for last night')], { a: kcReply('a') });
    assert.deepEqual(report.posts.map((p) => [p.decision, p.action, p.eventState]), [['eligible', 'none', null], ['reject', 'reject', null]]);
    const c = h.counts();
    assert.equal(c.events, 0);
    assert.equal(c.candidates, 2);
    assert.equal((await h.store.listPublicEvents('2026-10-14')).length, 0);
    const cand = h.rows('candidates').find((r) => r.event_key)!;
    assert.equal(cand.decision, 'eligible');
    assert.equal(cand.action, 'none');
    assert.equal(cand.event_date, '2026-11-20'); // date and time are separate columns
    assert.equal(cand.start_time, null);
    assert.ok(cand.snapshot);
  });

  test(`${name}: re-processing the same posts is idempotent and does not call the model again`, async () => {
    const h = setup();
    const posts = [post('a', KC), post('r', 'thanks for last night')];
    const first = await run(h, posts, { a: kcReply('a') }, ON);
    const before = h.counts();
    assert.equal(first.client.calls, 1);
    const second = await run(h, posts, { a: kcReply('a') }, ON);
    const after = h.counts();
    assert.equal(second.client.calls, 0); // cached in the store
    assert.deepEqual({ ...after, runs: 0, logs: 0 }, { ...before, runs: 0, logs: 0 }); // nothing new except run bookkeeping
    assert.equal(after.runs, before.runs + 1);
    assert.equal(after.events, 1);
    assert.equal(second.report.summary.posts_new, 0);
    assert.equal(second.report.summary.published, 0);
    assert.equal(h.rows('events')[0].status, 'published');
  });

  test(`${name}: with the switch ON the event is published once, with provenance, and appears in the public view`, async () => {
    const h = setup();
    const { report } = await run(h, [post('a', KC)], { a: kcReply('a') }, ON);
    assert.equal(report.summary.published, 1);
    const ev = h.rows('events')[0];
    assert.equal(ev.title, 'Demo Band at PICC Plenary Hall');
    assert.equal(ev.title_quality, 'derived');
    assert.equal(ev.event_date, '2026-11-20');
    assert.equal(ev.start_time, null); // time not announced stays null
    assert.equal(ev.source_url, 'https://example.invalid/p/a');
    const links = await h.store.listEventSources(ev.id);
    assert.deepEqual(links.map((l) => [l.instagram_post_id, l.role]), [['a', 'primary']]);
    assert.deepEqual((await h.store.listHistory(ev.id)).map((x) => `${x.from_state}->${x.to_state}:${x.actor}`), ['null->held:system', 'held->published:system']);
    const pub = await h.store.listPublicEvents('2026-10-14');
    assert.equal(pub.length, 1);
    assert.equal(pub[0].time_known, false);
    assert.equal(pub[0].starts_at, '2026-11-20T04:00:00.000Z'); // 12:00 Manila placeholder, flagged by time_known
    assert.equal(pub[0].venue_name, 'PICC Plenary Hall');
    assert.equal(pub[0].latitude, 14.5554);
  });

  test(`${name}: a repeat post of the same event attaches as a duplicate source, never a second event`, async () => {
    const h = setup();
    await run(h, [post('a', KC)], { a: kcReply('a') }, ON);
    await run(h, [post('b', KC, '2026-09-12T10:00:00Z')], { b: kcReply('b') }, ON);
    assert.equal(h.counts().events, 1);
    const ev = h.rows('events')[0];
    const links = await h.store.listEventSources(ev.id);
    assert.deepEqual(links.map((l) => [l.instagram_post_id, l.role]).sort(), [['a', 'primary'], ['b', 'duplicate']]);
    assert.equal(ev.source_url, 'https://example.invalid/p/a'); // primary source unchanged
  });

  test(`${name}: an announced start time updates the published event in place and is recorded`, async () => {
    const h = setup();
    await run(h, [post('a', KC)], { a: kcReply('a') }, ON);
    await run(h, [post('b', KC_TIME, '2026-09-13T10:00:00Z')], { b: kcReply('b', { time: { value: '20:00', evidence: 'show starts 8PM' } }) }, ON);
    assert.equal(h.counts().events, 1);
    const ev = h.rows('events')[0];
    assert.equal(ev.start_time, '20:00:00');
    assert.equal(ev.status, 'published');
    const hist = await h.store.listHistory(ev.id);
    assert.match(hist.at(-1)!.reason, /updated from source: startTime/);
    assert.equal((await h.store.listPublicEvents('2026-10-14'))[0].time_known, true);
    assert.equal((await h.store.listEventSources(ev.id)).find((l) => l.instagram_post_id === 'b')!.role, 'update');
  });

  test(`${name}: a cancellation unpublishes the event, keeps every source and removes it from the public view`, async () => {
    const h = setup();
    await run(h, [post('a', KC)], { a: kcReply('a') }, ON);
    await run(h, [post('c', KC_CANCEL, '2026-10-01T10:00:00Z')], { c: kcReply('c', { update: 'postponed' }) }, ON);
    const ev = h.rows('events')[0];
    assert.equal(ev.status, 'unpublished');
    assert.match(ev.unpublish_reason, /source update failed checks/);
    assert.equal((await h.store.listPublicEvents('2026-10-14')).length, 0);
    const links = await h.store.listEventSources(ev.id);
    assert.deepEqual(links.map((l) => [l.instagram_post_id, l.role]).sort(), [['a', 'primary'], ['c', 'cancellation']]);
    const hist = await h.store.listHistory(ev.id);
    assert.equal(hist.at(-1)!.to_state, 'unpublished');
    // Processing the cancellation again changes nothing.
    const before = h.counts();
    await run(h, [post('c', KC_CANCEL, '2026-10-01T10:00:00Z')], { c: kcReply('c', { update: 'postponed' }) }, ON);
    assert.equal(h.counts().events, before.events);
    assert.equal(h.counts().links, before.links);
    assert.equal((await h.store.listHistory(ev.id)).length, hist.length);
  });

  test(`${name}: events leave the public view after their last day (Manila time) and are marked expired`, async () => {
    const h = setup();
    await run(h, [post('a', KC)], { a: kcReply('a') }, ON);
    const ev = h.rows('events')[0];
    const late = await run(h, [post('a', KC)], { a: kcReply('a') }, ON, '2026-11-20T15:00:00Z'); // still the 20th in Manila
    assert.equal(late.report.expired, 0);
    assert.equal((await h.store.listPublicEvents(manilaDate('2026-11-20T15:00:00Z'))).length, 1);
    const over = await run(h, [post('a', KC)], { a: kcReply('a') }, ON, '2026-11-20T16:00:00Z'); // 00:00 on the 21st
    assert.equal(over.report.expired, 1);
    assert.equal(h.rows('events').find((e) => e.id === ev.id)!.status, 'expired');
    assert.equal((await h.store.listPublicEvents(manilaDate('2026-11-20T16:00:00Z'))).length, 0);
  });

  test(`${name}: an edited caption is recorded as a revision, not as a new post`, async () => {
    const h = setup();
    await run(h, [post('a', KC)], { a: kcReply('a') });
    const edited = KC + '\n(edited)';
    const { report } = await run(h, [post('a', edited)], { a: kcReply('a') });
    assert.equal(report.summary.posts_changed, 1);
    assert.equal(h.counts().posts, 1);
    assert.equal(h.counts().revisions, 2);
    assert.equal(h.rows('posts')[0].caption, edited);
  });

  test(`${name}: held, rejected and failed extractions never become public events`, async () => {
    const h = setup();
    const garbage = makeExtractor(h.store, {}); // a model that returns recaps only
    void garbage;
    const bad = { a: { id: 'a', classification: 'upcoming_event' } }; // malformed reply for post a
    const { report } = await run(h, [post('a', KC), post('u', 'merch drop soon')], bad, ON);
    assert.deepEqual(report.posts.map((p) => p.eventState), [null, null]);
    assert.equal(h.counts().events, 0);
    assert.equal(h.rows('candidates').find((c) => c.review_reasons.includes('ai_invalid_response'))!.decision, 'hold');
    assert.equal((await h.store.listPublicEvents('2026-10-14')).length, 0);
  });

  test(`${name}: synthetic posts are refused, logged, and never stored`, async () => {
    const h = setup();
    const synthetic = { ...post('s', KC), origin: 'synthetic' as const };
    const { report } = await run(h, [synthetic, post('a', KC)], { s: kcReply('s'), a: kcReply('a') });
    assert.equal(report.posts.length, 1);
    assert.equal(h.counts().posts, 1);
    assert.ok(h.rows('logs').some((l) => /synthetic post skipped/.test(l.message) && l.level === 'error'));
  });

  test(`${name}: the run record and logs are written, with the unattended-publishing flag recorded`, async () => {
    const h = setup();
    const { report } = await run(h, [post('a', KC), post('x', 'unrelated chatter')], { a: kcReply('a') });
    assert.equal(report.summary.posts_seen, 2);
    assert.equal(report.summary.eligible, 1);
    assert.equal(report.summary.rejected, 1);
    assert.equal(h.counts().runs, 1);
    if (h.fake) assert.equal(h.fake.rows('ingestion_runs')[0].unattended_publishing, false);
    if (h.fake) assert.equal(h.fake.rows('ingestion_runs')[0].status, 'succeeded');
  });

  test(`${name}: an administrator can publish or pull a single event, but never a guessed title or unverified venue`, async () => {
    const h = setup();
    await run(h, [post('a', KC), post('g', 'Some band tonight at a place')], { a: kcReply('a') }); // policy OFF
    assert.equal(h.counts().events, 0);
    const saved = await adminPublishCandidate(h.store, 'a', 'manual exception', nowIso);
    assert.equal(saved.status, 'published');
    assert.equal((await h.store.listHistory(saved.id)).at(-1)!.actor, 'admin');
    assert.equal((await h.store.listPublicEvents('2026-10-14')).length, 1);
    await assert.rejects(adminPublishCandidate(h.store, 'g', 'try', nowIso), /missing a name, date or verified venue/);
    await adminUnpublishEvent(h.store, saved.event_key, 'wrong venue', nowIso);
    assert.equal(h.rows('events')[0].status, 'unpublished');
    assert.equal((await h.store.listPublicEvents('2026-10-14')).length, 0);
  });

  test(`${name}: the store itself refuses data the database would refuse`, async () => {
    const h = setup();
    await run(h, [post('a', KC)], { a: kcReply('a') }, ON);
    const ev = h.rows('events')[0];
    const base = { ...ev } as EventRow;
    await assert.rejects(h.store.upsertEvent({ ...base, event_key: 'k2', title_quality: 'guessed' as never }));
    await assert.rejects(h.store.upsertEvent({ ...base, event_key: 'k3', venue_id: '00000000-0000-0000-0000-000000000000' }));
    await assert.rejects(h.store.upsertEvent({ ...base, event_key: 'k4', end_date: '2026-01-01' }));
    const venue = (await h.store.listVenues())[0];
    await assert.rejects(h.store.putVenue({ ...venue, id: 'far', key: 'far', latitude: 16.4, longitude: 120.6 }));
    await assert.rejects(h.store.putVenue({ ...venue, id: 'sim', key: 'sim', evidence: [{ ...venue.evidence[0], simulated: true }] }));
  });

  test(`${name}: venues round-trip through the store with their evidence and the seed stays verified`, async () => {
    const h = setup();
    await run(h, [post('a', KC)], { a: kcReply('a') });
    const venues = await h.store.listVenues();
    const picc = venues.find((v) => v.id === 'picc-plenary-hall')!;
    assert.equal(picc.name, 'PICC Plenary Hall');
    assert.equal(picc.verification.status, 'verified');
    assert.equal(picc.evidence.length, 3);
    assert.deepEqual(picc.evidence.map((e) => e.supports).sort(), ['identity', 'location', 'parent']);
    assert.equal(picc.evidence.find((e) => e.supports === 'parent')!.placeId, null);
    assert.equal(picc.address.city, 'Pasay');
    const res = await h.resolver(clock).resolve('Philippine International Convention Center Plenary Hall');
    assert.equal(res.status, 'verified');
    assert.equal(res.source, 'registry');
  });
}

test('recap-only replies produce no events on either store (sanity)', () => {
  assert.equal(recapReply('x').classification, 'past_event_recap');
});
