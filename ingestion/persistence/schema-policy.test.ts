/// <reference types="node" />
// Run: npm run ingest:test
//
// STATIC checks of supabase/migrations/*.sql. They read the SQL text; they do NOT run it on Postgres, so they
// cannot prove the policies behave correctly at runtime. They do catch the mistakes that matter most: a new
// table with no RLS, a private table readable by the mobile roles, a column the store writes that the schema
// does not have, or a public view that exposes internals.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { FakePostgrest } from './fake-postgrest.ts';
import { PUBLIC_EVENTS_SELECT } from './public-events.ts';
import { persistIngestion, adminPublishCandidate } from './sync.ts';
import { KC, KC_CANCEL, KC_TIME, kcReply, makeExtractor, ON, post } from './test-helpers.ts';
import { SupabasePersistence } from './supabase-store.ts';
import { VenueResolver } from '../venue-resolver.ts';
import type { PublicEventRow } from './types.ts';

const dir = 'supabase/migrations';
const file = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort().at(-1)!;
const sql = readFileSync(`${dir}/${file}`, 'utf8').split('\r\n').join('\n'); // Windows checkouts use CRLF
const lower = sql.toLowerCase();

const tables = [...sql.matchAll(/create table public\.(\w+)\s*\(/g)].map((m) => m[1]);
const PUBLIC_READ = ['events', 'venues'];
const PRIVATE = tables.filter((t) => !PUBLIC_READ.includes(t));

/** Column names of one `create table`, from its body. */
function columns(table: string): string[] {
  const start = sql.indexOf(`create table public.${table} (`);
  const body = sql.slice(start, sql.indexOf('\n);', start));
  return body.split('\n').slice(1)
    .map((l) => l.match(/^\s{2}([a-z_]+)\s+/)?.[1])
    .filter((c): c is string => Boolean(c) && !['unique', 'check', 'primary', 'foreign', 'constraint'].includes(c!));
}

test('the migration defines the expected tables', () => {
  for (const t of ['organizers', 'source_posts', 'event_candidates', 'venues', 'events', 'event_sources', 'event_history', 'ingestion_runs', 'ingestion_logs']) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
});

test('every table has Row Level Security enabled', () => {
  for (const t of tables) assert.match(lower, new RegExp(`alter table public\\.${t}\\s+enable row level security`), t);
});

test('private tables have no policies and no privileges for the mobile roles', () => {
  for (const t of PRIVATE) {
    assert.match(lower, new RegExp(`revoke all on table public\\.${t}\\s+from anon, authenticated`), `${t} must revoke anon/authenticated`);
    assert.doesNotMatch(lower, new RegExp(`create policy \\w+ on public\\.${t}\\b`), `${t} must not have any policy`);
    assert.doesNotMatch(lower, new RegExp(`grant [^;]*on (table )?public\\.${t}\\b[^;]*to [^;]*(anon|authenticated|public)`), `${t} must not be granted to the mobile roles`);
  }
  for (const seq of ['event_history_id_seq', 'ingestion_logs_id_seq']) assert.match(lower, new RegExp(`revoke all on sequence public\\.${seq}`));
});

test('only events and venues have policies, read-only, for anon/authenticated, limited to published data', () => {
  const policies = [...sql.matchAll(/create policy (\w+) on public\.(\w+)\s+for (\w+) to ([\w, ]+)\s+using \(([\s\S]*?)\);/g)];
  assert.deepEqual(policies.map((p) => p[2]).sort(), ['events', 'venues']);
  for (const p of policies) {
    assert.equal(p[3], 'select');
    assert.equal(p[4].trim(), 'anon, authenticated');
  }
  assert.match(policies.find((p) => p[2] === 'events')![5], /status = 'published'/);
  assert.match(policies.find((p) => p[2] === 'venues')![5], /e\.status = 'published'/);
  assert.doesNotMatch(lower, /create policy[^;]*for (insert|update|delete|all)/); // writes are server-only
});

test('the mobile roles get column-level read access to events and venues, without internal columns', () => {
  const evGrant = sql.match(/grant select \(([^)]+)\)\s+on public\.events to anon, authenticated/)![1].split(',').map((c) => c.trim());
  for (const secret of ['event_key', 'candidate_snapshot', 'unpublish_reason', 'unpublished_at', 'published_at', 'created_at', 'updated_at']) assert.equal(evGrant.includes(secret), false, secret);
  for (const need of ['id', 'title', 'event_date', 'start_time', 'venue_id', 'source_url', 'status']) assert.ok(evGrant.includes(need), need);
  const vGrant = sql.match(/grant select \(([^)]+)\)\s+on public\.venues to anon, authenticated/)![1].split(',').map((c) => c.trim());
  for (const secret of ['provider_refs', 'verification', 'name_key', 'aliases', 'slug']) assert.equal(vGrant.includes(secret), false, secret);
  assert.match(lower, /revoke all on table public\.events\s+from anon, authenticated/);
  assert.match(lower, /revoke all on table public\.venues\s+from anon, authenticated/);
});

test('the public view runs with the caller\'s rights, shows only published upcoming events, and exposes no internals', () => {
  const view = sql.slice(sql.indexOf('create view public.public_events'), sql.indexOf('revoke all on public.public_events'));
  assert.match(view, /with \(security_invoker = true\)/);
  assert.match(view, /e\.status = 'published'/);
  assert.match(view, /at time zone 'Asia\/Manila'/);
  assert.match(view, /e\.start_time is not null\)\s+as time_known/);
  for (const hidden of ['event_key', 'candidate_snapshot', 'unpublish_reason', 'provider_refs', 'verification', 'caption']) assert.equal(view.includes(hidden), false, hidden);
  assert.match(lower, /grant select on public\.public_events to anon, authenticated/);
});

test('the view columns match what the app mapper selects and the PublicEventRow type', () => {
  const from = sql.indexOf('create view public.public_events');
  const view = sql.slice(sql.indexOf('select', from) + 6, sql.indexOf('from public.events e', from)); // the select list only
  const cols = [...view.matchAll(/(?:\bas\s+(\w+)|\be\.(\w+)|\bv\.(\w+))\s*(?:,|\n|$)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  const selected = PUBLIC_EVENTS_SELECT.split(',');
  assert.deepEqual([...new Set(cols)].sort(), [...selected].sort());
  const sample: PublicEventRow = {
    id: '', title: '', title_is_generated: false, description: null, category: null, genre: null, lineup: [], event_date: '', end_date: null, start_time: null, time_known: false, starts_at: '',
    ticket_url: null, ticket_price_min: null, ticket_price_max: null, ticket_is_free: null, ticket_info: null, source_url: '', source_label: null, venue_id: '', venue_name: '',
    venue_address: null, venue_area: null, venue_city: '', latitude: 0, longitude: 0,
  };
  assert.deepEqual(Object.keys(sample).sort(), [...selected].sort());
});

test('safety constraints are in the schema itself', () => {
  assert.match(sql, /title_quality\s+text not null check \(title_quality in \('explicit', 'derived'\)\)/); // guessed names can't be public
  assert.match(sql, /venue_id\s+uuid not null references public\.venues/); // an event needs a venue
  assert.match(sql, /verification\s+jsonb not null check \(verification ->> 'status' = 'verified'\)/); // only verified venues exist
  assert.match(sql, /latitude between 14\.35 and 14\.80/);
  assert.match(sql, /longitude between 120\.90 and 121\.20/);
  assert.match(sql, /simulated\s+boolean not null default false check \(simulated = false\)/); // no simulated evidence
  assert.match(sql, /origin = 'instagram-business-discovery'/); // no synthetic posts
  assert.match(sql, /event_date\s+date not null/);
  assert.match(sql, /\n  start_time\s+time,\n/); // nullable: start time may be unknown
  assert.doesNotMatch(sql, /start_time\s+time not null/);
  assert.match(sql, /event_key\s+text not null unique/); // idempotency
  assert.match(sql, /unique \(platform, source_post_id\)/);
  assert.match(sql, /unique \(event_id, source_post_id\)/);
  assert.match(sql, /unattended_publishing\s+boolean not null default false/);
});

test('the migration contains no credentials and grants nothing to the public pseudo-role', () => {
  assert.doesNotMatch(sql, /eyJ[A-Za-z0-9_-]{20,}/); // JWT-shaped
  assert.doesNotMatch(lower, /sb_secret_|service_role_key|password\s*=/);
  assert.doesNotMatch(lower, /grant [^;]* to public\b/);
  assert.doesNotMatch(lower, /grant [^;]*\bto service_role/); // service_role already has access; no need to widen anything
});

test('every column the store writes exists in the schema', async () => {
  const fake = new FakePostgrest();
  const store = new SupabasePersistence(fake as never, () => new Date('2026-10-14T04:00:00Z'));
  const NOW = '2026-10-14T04:00:00Z';
  const replies = { a: kcReply('a'), b: kcReply('b', { time: { value: '20:00', evidence: 'show starts 8PM' } }), c: kcReply('c', { update: 'postponed' }) };
  const { extractor } = makeExtractor(store, replies);
  await persistIngestion([post('a', KC), post('b', KC_TIME), post('c', KC_CANCEL)], { store, extractor, resolver: new VenueResolver({ store, providers: [] }), policy: ON, now: NOW });
  await persistIngestion([post('a', KC + ' (edited)')], { store, extractor: makeExtractor(store, replies).extractor, resolver: new VenueResolver({ store, providers: [] }), now: NOW });
  await adminPublishCandidate(store, 'a', 'admin test', NOW).catch(() => undefined);
  const exercised = [...fake.writtenColumns.entries()];
  assert.ok(exercised.length >= 10, 'the scenario should touch most tables');
  for (const [table, written] of exercised) {
    const known = new Set(columns(table));
    for (const col of written) assert.ok(known.has(col), `${table}.${col} is written by the store but is not in the migration`);
  }
});
