/// <reference types="node" />
// Run: npm run ingest:test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PUBLIC_EVENTS_SELECT, toAppEvent } from './public-events.ts';
import type { PublicEventRow } from './types.ts';

const row = (over: Partial<PublicEventRow> = {}): PublicEventRow => ({
  id: 'e1', title: 'Demo Band at PICC Plenary Hall', title_is_generated: true, description: null, category: 'concert', genre: null, lineup: ['DEMO BAND'],
  event_date: '2026-11-20', end_date: null, start_time: null, time_known: false, starts_at: '2026-11-20T04:00:00.000Z',
  ticket_url: 'tickets.example.com/demo', ticket_price_min: null, ticket_price_max: null, ticket_is_free: null, ticket_info: null,
  source_url: 'https://www.instagram.com/p/example/', source_label: 'Instagram @demo_promoter',
  venue_id: 'v1', venue_name: 'PICC Plenary Hall', venue_address: 'Vicente Sotto Street, Pasay', venue_area: null, venue_city: 'Pasay', latitude: 14.5554, longitude: 120.9833, ...over,
});

test('maps a public row to the app event with an honest unknown time and no invented price', () => {
  const e = toAppEvent(row());
  assert.equal(e.timeUnknown, true);
  assert.equal(e.startsAt, '2026-11-20T04:00:00.000Z');
  assert.equal(e.venue, 'PICC Plenary Hall');
  assert.equal(e.area, 'Pasay'); // falls back to the city when no area is stored
  assert.deepEqual([e.latitude, e.longitude], [14.5554, 120.9833]);
  assert.equal(e.ticketInfo, undefined); // unknown price stays unknown
  assert.equal(e.ticketUrl, 'https://tickets.example.com/demo'); // scheme added so the link opens
  assert.equal(e.sourceUrl, 'https://www.instagram.com/p/example/');
  assert.equal(e.sourceLabel, 'Instagram @demo_promoter');
  assert.equal(e.isDemo, false);
  assert.deepEqual(e.lineup, ['DEMO BAND']);
});

test('a known start time is passed through and prices are formatted, never guessed', () => {
  assert.equal(toAppEvent(row({ time_known: true, start_time: '20:00:00', starts_at: '2026-11-20T12:00:00.000Z' })).timeUnknown, false);
  assert.equal(toAppEvent(row({ ticket_is_free: true })).ticketInfo, 'Free entry');
  assert.equal(toAppEvent(row({ ticket_price_min: 500, ticket_price_max: 800 })).ticketInfo, '₱500 – ₱800');
  assert.equal(toAppEvent(row({ ticket_price_min: 500, ticket_price_max: 500 })).ticketInfo, '₱500');
  assert.equal(toAppEvent(row({ ticket_url: 'https://already.example/x' })).ticketUrl, 'https://already.example/x');
  assert.equal(toAppEvent(row({ ticket_url: null })).ticketUrl, undefined);
  assert.equal(toAppEvent(row({ lineup: [] })).lineup, undefined);
});

test('the public select list contains no internal columns', () => {
  for (const hidden of ['event_key', 'candidate', 'snapshot', 'caption', 'unpublish', 'verification', 'provider']) assert.equal(PUBLIC_EVENTS_SELECT.includes(hidden), false, hidden);
});
