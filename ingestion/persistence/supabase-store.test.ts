/// <reference types="node" />
// Run: npm run ingest:test
// Server-key safety and the exact PostgREST calls the Supabase store makes (against a fake PostgREST).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServerSupabase, SupabasePersistence } from './supabase-store.ts';
import { FakePostgrest } from './fake-postgrest.ts';
import { KC, kcReply, makeExtractor, ON, post } from './test-helpers.ts';
import { persistIngestion } from './sync.ts';
import { VenueResolver } from '../venue-resolver.ts';

const SERVICE_KEY = 'sb_secret_FAKE_PLACEHOLDER_0123456789_NOT_A_REAL_KEY';
const URL = 'https://abcdefgh.supabase.co';
const made: { url: string; key: string; opts: any }[] = [];
const fakeCreate = (url: string, key: string, opts: object) => {
  made.push({ url, key, opts });
  return new FakePostgrest() as never;
};
const env = (over: Record<string, string | undefined> = {}) => ({ SUPABASE_URL: URL, SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, ...over });

test('server client: needs both variables and never persists a session', () => {
  assert.throws(() => createServerSupabase({}, fakeCreate), /must be set in the server environment/);
  assert.throws(() => createServerSupabase({ SUPABASE_URL: URL }, fakeCreate), /must be set/);
  made.length = 0;
  createServerSupabase(env({ SUPABASE_URL: `${URL}/rest/v1/` }), fakeCreate);
  assert.equal(made[0].url, URL); // pasted API suffix is tolerated
  assert.equal(made[0].key, SERVICE_KEY);
  assert.deepEqual(made[0].opts, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
});

test('server client refuses a publishable key, a key that is also exposed to the app, and app/browser runtimes', () => {
  assert.throws(() => createServerSupabase(env({ SUPABASE_SERVICE_ROLE_KEY: 'sb_publishable_abcdefghijklmnop' }), fakeCreate), /publishable key/);
  assert.throws(() => createServerSupabase(env({ EXPO_PUBLIC_SUPABASE_KEY: SERVICE_KEY }), fakeCreate), /EXPO_PUBLIC_SUPABASE_KEY/);
  assert.doesNotThrow(() => createServerSupabase(env({ EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_different_value_0123' }), fakeCreate));
  const g = globalThis as Record<string, unknown>;
  try {
    g.document = {};
    assert.throws(() => createServerSupabase(env(), fakeCreate), /never be used in the app or a browser/);
  } finally {
    delete g.document;
  }
  // The error text names variables only; it never contains the key itself.
  try {
    createServerSupabase(env({ EXPO_PUBLIC_X: SERVICE_KEY }), fakeCreate);
  } catch (e) {
    assert.equal((e as Error).message.includes(SERVICE_KEY), false);
  }
});

test('database errors are surfaced without long secret-looking strings', async () => {
  const bad = { from: () => ({ upsert: () => ({ select: () => ({ single: async () => ({ data: null, error: { message: `boom ${SERVICE_KEY}${SERVICE_KEY}`, code: '42501' } }) }) }) }) };
  const store = new SupabasePersistence(bad as never);
  await assert.rejects(store.upsertOrganizer('demo'), (e: Error) => !e.message.includes(SERVICE_KEY) && /42501/.test(e.message));
});

test('every write uses its natural key, so retries and re-runs cannot duplicate rows', async () => {
  const fake = new FakePostgrest();
  const store = new SupabasePersistence(fake as never, () => new Date('2026-10-14T04:00:00Z'));
  const { extractor } = makeExtractor(store, { a: kcReply('a') });
  await persistIngestion([post('a', KC)], { store, extractor, resolver: new VenueResolver({ store, providers: [] }), policy: ON, now: '2026-10-14T04:00:00Z' });
  const keyed = fake.calls.filter((c) => c.op === 'upsert').reduce<Record<string, Set<string | undefined>>>((m, c) => ((m[c.table] ??= new Set()).add(c.onConflict), m), {});
  assert.deepEqual([...keyed.organizers], ['platform,handle']);
  assert.deepEqual([...keyed.event_candidates], ['source_post_id']);
  assert.deepEqual([...keyed.events], ['event_key']);
  assert.deepEqual([...keyed.event_sources], ['event_id,source_post_id']);
  assert.deepEqual([...keyed.venues], ['slug']);
  assert.deepEqual([...keyed.venue_evidence], ['venue_id,provider,place_id']);
  assert.deepEqual([...keyed.source_post_revisions], ['source_post_id,content_hash']);
  assert.deepEqual([...keyed.extraction_cache], ['cache_key']);
  // Links and revisions never overwrite what is already there.
  assert.ok(fake.calls.filter((c) => c.table === 'event_sources' && c.op === 'upsert').every((c) => c.ignoreDuplicates));
  assert.ok(fake.calls.filter((c) => c.table === 'source_post_revisions' && c.op === 'upsert').every((c) => c.ignoreDuplicates));
});

test('the store never reads or writes the public view, and writes nothing to events unless an event is public', async () => {
  const fake = new FakePostgrest();
  const store = new SupabasePersistence(fake as never);
  const { extractor } = makeExtractor(store, { a: kcReply('a') });
  await persistIngestion([post('a', KC)], { store, extractor, resolver: new VenueResolver({ store, providers: [] }), now: '2026-10-14T04:00:00Z' }); // policy OFF
  assert.equal(fake.calls.some((c) => c.table === 'public_events'), false);
  assert.equal(fake.calls.some((c) => c.table === 'events' && c.op !== 'select'), false);
  assert.equal(fake.rows('events').length, 0);
});
