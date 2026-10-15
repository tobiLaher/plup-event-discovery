// Shared helpers for the persistence tests. All captions and model replies are INVENTED. Posts carry the real
// origin label only so they pass the storage rule that rejects synthetic data; the content is fictional.
import { AiExtractor } from '../ai-extractor.ts';
import { ScriptedLlmClient, sentPosts } from '../ai-mock.ts';
import { manilaDate } from '../manila-date.ts';
import { DEFAULT_POLICY, type PublishingPolicy } from '../publishing.ts';
import type { InstagramPost } from '../types.ts';
import { VenueResolver } from '../venue-resolver.ts';
import { FakePostgrest } from './fake-postgrest.ts';
import { MemoryPersistence } from './memory-store.ts';
import { SupabasePersistence } from './supabase-store.ts';
import type { PersistenceStore } from './types.ts';

export const ON: PublishingPolicy = { ...DEFAULT_POLICY, unattendedPublishingEnabled: true };
export const OFF: PublishingPolicy = DEFAULT_POLICY;

export const post = (id: string, caption: string, timestamp = '2026-09-10T10:00:00Z', username = 'demo_promoter'): InstagramPost => ({
  id, username, caption, timestamp, permalink: `https://example.invalid/p/${id}`, origin: 'instagram-business-discovery',
});

export const KC = 'DEMO BAND IS BACK\n\n🗓️ November 20, 2026\n📍 PICC Plenary Hall\n🎫 tickets.example.com/demo';
export const KC_TIME = 'DEMO BAND IS BACK\n\n🗓️ November 20, 2026 · show starts 8PM\n📍 PICC Plenary Hall\n🎫 tickets.example.com/demo';
export const KC_CANCEL = 'UPDATE: the DEMO BAND show on November 20, 2026 at PICC Plenary Hall is postponed.';

const NO_TICKET = { url: null, minPhp: null, maxPhp: null, isFree: null, evidence: null };
const emptyEvent = () => ({
  officialTitle: null, displayLabel: null, artists: [], category: null, date: { value: null, endValue: null, evidence: null },
  startTime: { value: null, evidence: null }, venue: { name: null, areaClue: null, evidence: null }, ticket: NO_TICKET,
});

export const recapReply = (id: string) => ({ id, classification: 'past_event_recap', update: 'none', event: emptyEvent(), notes: [] });

/** A fully supported upcoming-event reply for the KC captions (override pieces per test). */
export function kcReply(id: string, opts: { time?: { value: string; evidence: string }; update?: string; label?: string } = {}) {
  return {
    id, classification: 'upcoming_event', update: opts.update ?? 'none', notes: [],
    event: {
      ...emptyEvent(),
      displayLabel: opts.label ?? 'Demo Band at PICC Plenary Hall',
      artists: [{ name: 'DEMO BAND', evidence: 'DEMO BAND' }],
      category: 'concert',
      date: { value: '2026-11-20', endValue: null, evidence: 'November 20, 2026' },
      startTime: opts.time ?? { value: null, evidence: null },
      venue: { name: 'PICC Plenary Hall', areaClue: null, evidence: 'PICC Plenary Hall' },
      ticket: { url: 'tickets.example.com/demo', minPhp: null, maxPhp: null, isFree: null, evidence: null },
    },
  };
}

/** An extractor whose scripted "model" answers from `replies` (default: recap), caching into the store. */
export function makeExtractor(store: PersistenceStore, replies: Record<string, unknown>) {
  const client = new ScriptedLlmClient((req) => JSON.stringify(sentPosts(req).map((p) => replies[p.id] ?? recapReply(p.id))));
  return { client, extractor: new AiExtractor({ client, cache: store, batchSize: 2 }) };
}

export type Harness = {
  name: 'memory' | 'supabase (fake PostgREST)';
  store: PersistenceStore;
  resolver: (clock: () => Date) => VenueResolver;
  counts: () => Record<string, number>;
  rows: (table: string) => Record<string, any>[];
  fake?: FakePostgrest;
};

export function makeMemory(clock: () => Date): Harness {
  const store = new MemoryPersistence(clock);
  return {
    name: 'memory', store,
    resolver: (c) => new VenueResolver({ store, providers: [], clock: c }),
    counts: () => ({ organizers: store.organizers.size, posts: store.sourcePosts.size, revisions: store.revisions.length, candidates: store.candidates.size, events: store.events.size, links: store.eventSources.length, history: store.history.length, runs: store.runs.size, logs: store.logs.length }),
    rows: (t) => {
      const m: Record<string, Record<string, any>[]> = { events: [...store.events.values()], candidates: [...store.candidates.values()], posts: [...store.sourcePosts.values()], links: store.eventSources, history: store.history, logs: store.logs };
      return m[t] ?? [];
    },
  };
}

export function makeSupabase(clock: () => Date): Harness {
  const fake = new FakePostgrest(() => manilaDate(clock().toISOString()));
  const store = new SupabasePersistence(fake as never, clock);
  const t = (n: string) => fake.rows(n);
  return {
    name: 'supabase (fake PostgREST)', store, fake,
    resolver: (c) => new VenueResolver({ store, providers: [], clock: c }),
    counts: () => ({ organizers: t('organizers').length, posts: t('source_posts').length, revisions: t('source_post_revisions').length, candidates: t('event_candidates').length, events: t('events').length, links: t('event_sources').length, history: t('event_history').length, runs: t('ingestion_runs').length, logs: t('ingestion_logs').length }),
    rows: (n) => {
      const m: Record<string, string> = { events: 'events', candidates: 'event_candidates', posts: 'source_posts', links: 'event_sources', history: 'event_history', logs: 'ingestion_logs' };
      return t(m[n] ?? n);
    },
  };
}
