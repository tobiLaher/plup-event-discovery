/// <reference types="node" />
// Run: npm run ingest:test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIXTURE_NOW, RECAP_FIXTURE_POSTS, SYNTHETIC_POSTS } from './fixtures.ts';
import { manilaDate, parseDates, parseStartTime } from './manila-date.ts';
import { ingest } from './pipeline.ts';
import { RulesExtractor } from './rules-extractor.ts';
import { SimulatedExtractor } from './simulated-extractor.ts';
import type { InstagramPost } from './types.ts';

const POSTED = '2026-10-10T02:00:00Z';
const post = (id: string, caption: string, timestamp = POSTED): InstagramPost => ({
  id, username: 'demo_promoter', caption, timestamp, permalink: `https://example.invalid/${id}`, origin: 'synthetic',
});
const run = (posts: InstagramPost[], now = FIXTURE_NOW) => ingest(posts, new RulesExtractor(), { now });
const byId = (r: Awaited<ReturnType<typeof run>>, id: string) => r.items.find((i) => i.postId === id)!;

test('manilaDate uses Asia/Manila, not UTC', () => {
  assert.equal(manilaDate('2026-10-13T17:00:00Z'), '2026-10-14');
  assert.equal(manilaDate('2026-10-14T15:59:59Z'), '2026-10-14');
  assert.equal(manilaDate('2026-10-14T16:00:00Z'), '2026-10-15');
  assert.equal(manilaDate('2026-09-14T10:34:01+0000'), '2026-09-14'); // Graph API timestamp format
});

test('parseDates: lists, ranges, and formats', () => {
  assert.deepEqual(parseDates('August 10, 11 & 12, 2026', POSTED).dates, ['2026-08-10', '2026-08-11', '2026-08-12']);
  assert.deepEqual(parseDates('Aug 10-12, 2026', POSTED).dates, ['2026-08-10', '2026-08-11', '2026-08-12']);
  assert.deepEqual(parseDates('10 August 2026', POSTED).dates, ['2026-08-10']);
  assert.deepEqual(parseDates('Oct 31st, 2026', POSTED).dates, ['2026-10-31']);
  assert.deepEqual(parseDates('2026-12-05', POSTED).dates, ['2026-12-05']);
  assert.deepEqual(parseDates('25/12/2026', POSTED).dates, ['2026-12-25']);
});

test('parseDates: missing year is inferred from the post date and flagged', () => {
  const same = parseDates('Nov 14', POSTED);
  assert.deepEqual(same.dates, ['2026-11-14']);
  assert.ok(same.flags.includes('year_inferred'));
  assert.deepEqual(parseDates('Jan 5', POSTED).dates, ['2027-01-05']); // already passed this year -> next year
});

test('parseDates: ambiguous, invalid, relative and scattered dates are flagged, not guessed', () => {
  const amb = parseDates('03/04/2027', POSTED);
  assert.deepEqual(amb.dates, []);
  assert.ok(amb.flags.includes('ambiguous_date'));
  assert.ok(parseDates('Feb 30, 2027', POSTED).flags.includes('ambiguous_date'));
  assert.ok(parseDates('Tonight at 9PM', POSTED).flags.includes('relative_date'));
  assert.ok(parseDates('Bukas na!', POSTED).flags.includes('relative_date'));
  assert.ok(parseDates('Nov 20 Manila, Dec 18 Cebu', POSTED).flags.includes('multiple_dates'));
});

test('parseStartTime prefers show start over doors and never guesses', () => {
  assert.equal(parseStartTime('Doors 7PM, show starts 8PM').startTime, '20:00');
  assert.equal(parseStartTime('8:30 PM').startTime, '20:30');
  assert.equal(parseStartTime('Program at 20:00').startTime, '20:00');
  assert.equal(parseStartTime('12AM').startTime, '00:00');
  assert.equal(parseStartTime('12PM').startTime, '12:00');
  const doors = parseStartTime('Gates open 4PM');
  assert.equal(doors.startTime, null);
  assert.ok(doors.flags.includes('missing_start_time'));
  assert.equal(parseStartTime('No time here').startTime, null);
});

test('classification of fixtures', async () => {
  const r = await run([...RECAP_FIXTURE_POSTS, ...SYNTHETIC_POSTS]);
  const expected: Record<string, string> = {
    'synthetic-recap-demo-tour': 'past_event_recap',
    'synthetic-upcoming-no-year': 'upcoming_event',
    'synthetic-recap': 'past_event_recap',
    'synthetic-unrelated': 'unrelated',
    'synthetic-upcoming-repost': 'upcoming_event',
    'synthetic-incomplete': 'ambiguous',
    'synthetic-ambiguous-date': 'ambiguous',
    'synthetic-multiple-dates': 'upcoming_event',
    'synthetic-relative': 'ambiguous',
    'synthetic-doors-only': 'upcoming_event',
  };
  for (const [id, cls] of Object.entries(expected)) assert.equal(byId(r, id).classification, cls, id);
});

test('only upcoming/ambiguous posts produce candidates; recaps and unrelated are excluded', async () => {
  const r = await run([...RECAP_FIXTURE_POSTS, ...SYNTHETIC_POSTS]);
  for (const i of r.items) {
    if (i.classification === 'past_event_recap' || i.classification === 'unrelated') {
      assert.equal(i.candidate, null);
      assert.equal(i.reviewStatus, 'excluded');
    }
  }
});

test('publication date is never used as the event date', async () => {
  const r = await run([
    post('a', 'Concert Oct 31, 2026 at the Demo Arena. Tickets on sale now!'),
    post('b', 'Live concert at Demo Arena. Tickets on sale now!'),
  ]);
  assert.equal(byId(r, 'a').candidate?.date, '2026-10-31');
  assert.notEqual(byId(r, 'a').candidate?.date, manilaDate(POSTED));
  assert.equal(byId(r, 'b').candidate?.date, null);
  assert.equal(byId(r, 'b').classification, 'ambiguous');
});

test('past/upcoming switches at Manila midnight', async () => {
  const caption = 'Live gig on October 14, 2026! Tickets on sale now.';
  const before = await run([post('x', caption)], '2026-10-14T15:59:00Z'); // 23:59 Manila, still the 14th
  assert.equal(byId(before, 'x').classification, 'upcoming_event');
  const after = await run([post('x', caption)], '2026-10-14T16:00:00Z'); // 00:00 on the 15th in Manila
  assert.equal(byId(after, 'x').classification, 'past_event_recap');
});

test('a recap that mentions a future date is ambiguous, not auto-upcoming', async () => {
  const r = await run([post('r', 'Thank you for last night! What a night. See you again Dec 12, 2026.')]);
  assert.equal(byId(r, 'r').classification, 'ambiguous');
});

test('duplicate source post ids are excluded', async () => {
  const r = await run(SYNTHETIC_POSTS);
  const dups = r.items.filter((i) => i.postId === 'synthetic-upcoming-complete');
  assert.equal(dups.length, 2);
  assert.equal(dups[0].reviewStatus, 'needs_review'); // also matches the repost below
  assert.equal(dups[1].reviewStatus, 'excluded');
  assert.deepEqual(dups[1].reviewReasons, ['duplicate_source_post']);
  assert.equal(dups[1].candidate, null);
});

test('same event from different posts is flagged for review', async () => {
  const r = await run(SYNTHETIC_POSTS);
  for (const id of ['synthetic-upcoming-complete', 'synthetic-upcoming-repost']) {
    const first = r.items.find((i) => i.postId === id && i.candidate)!;
    assert.ok(first.reviewReasons.includes('possible_duplicate_event'), id);
    assert.equal(first.reviewStatus, 'needs_review');
  }
});

test('incomplete info stays null and is flagged for review', async () => {
  const r = await run(SYNTHETIC_POSTS);
  const c = byId(r, 'synthetic-doors-only');
  assert.equal(c.candidate?.startTime, null);
  assert.equal(c.candidate?.startsAt, null);
  assert.equal(c.candidate?.venueArea, null);
  assert.equal(c.candidate?.ticketPrice, null);
  assert.deepEqual(c.candidate?.artists, []);
  assert.equal(c.reviewStatus, 'needs_review');
  for (const reason of ['missing_start_time', 'missing_venue'] as const) assert.ok(c.reviewReasons.includes(reason), reason);
  assert.ok(byId(r, 'synthetic-ambiguous-date').reviewReasons.includes('ambiguous_date'));
  assert.ok(byId(r, 'synthetic-relative').reviewReasons.includes('relative_date'));
  assert.ok(byId(r, 'synthetic-multiple-dates').reviewReasons.includes('multiple_dates'));
  assert.ok(byId(r, 'synthetic-upcoming-no-year').reviewReasons.includes('year_inferred'));
});

test('a guessed name keeps an otherwise complete post in review; never auto-published', async () => {
  const r = await run([SYNTHETIC_POSTS[0]]);
  const i = r.items[0];
  assert.equal(i.reviewStatus, 'needs_review');
  assert.ok(i.reviewReasons.includes('name_unverified'));
  assert.equal(i.candidate?.startsAt, '2026-10-31T20:00:00+08:00');
  assert.equal(i.candidate?.venueName, 'Demo Rooftop Bar');
  assert.equal(i.candidate?.venueArea, 'Poblacion, Makati');
  assert.deepEqual(i.candidate?.artists, ['DJ Placeholder', 'Sample Selecta']);
  assert.equal(i.candidate?.ticketPrice?.minPhp, 500);
  assert.equal(i.candidate?.ticketPrice?.maxPhp, 800);
  assert.equal(i.candidate?.sourceOrigin, 'synthetic');
  assert.ok(i.reviewReasons.includes('unverified_extractor'));
  const all = await run([...RECAP_FIXTURE_POSTS, ...SYNTHETIC_POSTS]);
  assert.ok(all.items.every((x) => ['needs_review', 'ready_for_approval', 'excluded'].includes(x.reviewStatus)));
});

test('genre is optional', async () => {
  const r = await run([post('g', 'Community craft fair concert Nov 21, 2026 at Demo Hall, Pasig. Tickets on sale now!')]);
  assert.equal(byId(r, 'g').candidate?.genre, null);
});

test('every fixture is labeled synthetic, and the recap fixture is classified as a past recap', async () => {
  assert.ok(RECAP_FIXTURE_POSTS.every((p) => p.origin === 'synthetic' && p.id.startsWith('synthetic-')));
  assert.ok(SYNTHETIC_POSTS.every((p) => p.origin === 'synthetic' && p.id.startsWith('synthetic-')));
  const r = await run(RECAP_FIXTURE_POSTS);
  assert.equal(r.items[0].classification, 'past_event_recap');
});

test('pipeline accepts any extractor (simulated adapter is labeled as such)', async () => {
  const sim = new SimulatedExtractor({
    'synthetic-x': {
      classification: 'upcoming_event',
      fields: { name: 'Canned', nameQuality: 'derived', date: '2026-12-01', endDate: '2026-12-01', startTime: '19:00', venueName: 'V', venueArea: 'A', artists: [], genre: null, category: 'concert', ticketPrice: null, ticketUrl: null },
    },
  });
  const r = await ingest([post('synthetic-x', 'ignored'), post('synthetic-y', 'ignored')], sim, { now: FIXTURE_NOW });
  assert.equal(r.extractor.kind, 'simulated');
  assert.equal(r.items[0].reviewStatus, 'ready_for_approval');
  assert.equal(r.items[1].classification, 'unrelated');
});

// --- Regression tests from the first real-data validation (paraphrased / synthetic, not real captions) ---

test('regression: short announcement with date + pin + ticket emoji and no event keywords is upcoming', async () => {
  const r = await run([post('kc', [
    'THE DEMO BAND IS COMING BACK TO MANILA AFTER 16 YEARS',
    '',
    '🗓️ November 20, 2026',
    '📍 Example Plenary Hall',
    '🎫 tickets.example.com/demoband',
  ].join('\n'))]);
  const i = byId(r, 'kc');
  assert.equal(i.classification, 'upcoming_event');
  assert.equal(i.candidate?.date, '2026-11-20');
  assert.equal(i.candidate?.venueName, 'Example Plenary Hall');
  assert.equal(i.candidate?.venueArea, null); // never inferred
  assert.equal(i.candidate?.ticketUrl, 'tickets.example.com/demoband');
  assert.equal(i.candidate?.ticketPrice, null);
  assert.equal(i.candidate?.startTime, null);
  assert.ok(i.reviewReasons.includes('missing_start_time'));
  assert.ok(i.reviewReasons.includes('name_unverified')); // first-line name is only a guess
  assert.equal(i.reviewStatus, 'needs_review');
});

test('regression: yearless "August 16" is upcoming when posted before it and past afterwards', async () => {
  const caption = 'LAST CHANCE! Catch the Demo Band on the final tour stop!\n🗓 August 16\n📍 Sample Convention Center\n🎫 Tickets at tickets.example.com';
  const posted = '2026-08-11T06:31:00Z';
  const during = await run([post('y', caption, posted)], '2026-08-12T00:00:00Z');
  assert.equal(byId(during, 'y').classification, 'upcoming_event');
  assert.equal(byId(during, 'y').candidate?.date, '2026-08-16');
  assert.ok(byId(during, 'y').reviewReasons.includes('year_inferred'));
  assert.equal(byId(during, 'y').candidate?.ticketUrl, 'tickets.example.com');
  const after = await run([post('y', caption, posted)], '2026-10-14T04:00:00Z');
  assert.equal(byId(after, 'y').classification, 'past_event_recap');
});

test('regression: "tonight" on an old post is a past recap; on a fresh post it stays ambiguous', async () => {
  const caption = 'Day 1 of the demo tour, see you tonight!';
  const old = await run([post('t', caption, '2026-08-10T07:00:00Z')], '2026-10-14T04:00:00Z');
  assert.equal(byId(old, 't').classification, 'past_event_recap');
  const fresh = await run([post('t', caption, '2026-10-14T01:00:00Z')], '2026-10-14T04:00:00Z');
  assert.equal(byId(fresh, 't').classification, 'ambiguous');
  assert.ok(byId(fresh, 't').reviewReasons.includes('relative_date'));
});

test('regression: thank-you post without dates is a recap, not "unrelated"', async () => {
  const r = await run([post('th', 'Thank you for three unforgettable nights in Manila! Until we meet again.')]);
  assert.equal(byId(r, 'th').classification, 'past_event_recap');
});

test('regression: merchandise post with no event wording stays unrelated', async () => {
  const r = await run([post('m', 'Limited edition vinyl now available online. Link in bio. Limited stocks only!')]);
  assert.equal(byId(r, 'm').classification, 'unrelated');
});

test('ticketUrl extraction', async () => {
  const r = await run([
    post('u1', 'Concert Nov 21, 2026 at Demo Hall. Tickets at tickets.example.com/demo!'),
    post('u2', 'Concert Nov 21, 2026 at Demo Hall. Tickets on sale now.'),
  ]);
  assert.equal(byId(r, 'u1').candidate?.ticketUrl, 'tickets.example.com/demo');
  assert.equal(byId(r, 'u2').candidate?.ticketUrl, null);
});

test('regression: "just a week ago" reminiscing is a recap, not an ambiguous announcement', async () => {
  const r = await run([post('ago', 'Take us back to three unforgettable nights with the Demo Band, just a week ago. Who was there?')]);
  assert.equal(byId(r, 'ago').classification, 'past_event_recap');
});
