// SupabasePersistence: the PersistenceStore on a real Supabase project, using the SERVICE ROLE key.
// SERVER ONLY. That key bypasses Row Level Security, so it must never exist in the Expo app, in an
// EXPO_PUBLIC_* variable, or in Git. createServerSupabase() refuses to build a client if it looks misused.
//
// STATUS: exercised only against a fake PostgREST in tests (supabase-store.test.ts). It has not talked to a
// real Supabase project yet.
import { createClient } from '@supabase/supabase-js';
import { PROMPT_VERSION } from '../ai-prompt.ts';
import type { AiResult } from '../ai-schema.ts';
import type { CanonicalVenue, LookupAttempt, VenueEvidence } from '../venue-registry.ts';
import { normalizeVenueName } from '../venue-names.ts';
import type {
  CandidateRow, EventRow, EventSourceRow, EventStatus, HistoryRow, LogEntry, OrganizerRow, PersistenceStore,
  PublicEventRow, RunSummary, SourcePostRow, UpsertSourcePostResult,
} from './types.ts';

// A deliberately small structural type, so tests can pass a fake and the real client also fits.
type Db = { from(table: string): any };

type Res<T> = { data: T | null; error: { message: string; code?: string } | null };

/** Throws a short, secret-free error. PostgREST messages never contain our keys, but keep them bounded anyway. */
function must<T>(res: Res<T>, what: string): T | null {
  if (res.error) throw new Error(`supabase ${what} failed: ${res.error.message.replace(/[A-Za-z0-9_\-]{32,}/g, '[redacted]').slice(0, 200)}${res.error.code ? ` (${res.error.code})` : ''}`);
  return res.data;
}

export type ServerEnv = Record<string, string | undefined>;

/**
 * Builds the server-side client from SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. Refuses to run when:
 *  - either variable is missing,
 *  - the key is a publishable (public) key,
 *  - the key's value also appears in any EXPO_PUBLIC_* variable (it would be bundled into the app),
 *  - the code appears to run inside a browser or React Native.
 */
export function createServerSupabase(env: ServerEnv = process.env, createClientImpl: (url: string, key: string, opts: object) => Db = createClient as never): Db {
  const rawUrl = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!rawUrl || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in the server environment');
  if (key.startsWith('sb_publishable_')) throw new Error('SUPABASE_SERVICE_ROLE_KEY holds a publishable key; the server needs the secret/service-role key');
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('EXPO_PUBLIC_') && value && value.trim() === key) throw new Error(`the service-role key is also set in ${name}; EXPO_PUBLIC_* values are bundled into the app. Remove it`);
  }
  const g = globalThis as { document?: unknown; navigator?: { product?: string } };
  if (typeof g.document !== 'undefined' || g.navigator?.product === 'ReactNative') throw new Error('the service-role key must never be used in the app or a browser');
  const url = rawUrl.replace(/\/rest\/v1\/?$/, '').replace(/\/$/, '');
  return createClientImpl(url, key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}

const VENUE_SELECT = '*, venue_evidence(*)';

function evidenceFromRow(r: any): VenueEvidence {
  return {
    provider: r.provider, dataset: r.dataset, supports: r.supports, placeId: r.place_id === '' ? null : r.place_id, name: r.name, city: r.city, address: r.address,
    latitude: r.latitude, longitude: r.longitude, retrievedAt: new Date(r.retrieved_at).toISOString(), ...(r.url ? { url: r.url } : {}),
  };
}

function venueFromRow(r: any, slugById: Map<string, string>): CanonicalVenue {
  return {
    id: r.slug, name: r.name, key: r.name_key, aliases: r.aliases ?? [], kind: r.kind, parentId: r.parent_id ? (slugById.get(r.parent_id) ?? null) : null,
    address: { street: r.address, area: r.area, city: r.city }, latitude: r.latitude, longitude: r.longitude, providerRefs: r.provider_refs ?? [],
    evidence: (r.venue_evidence ?? []).map(evidenceFromRow),
    verification: { status: 'verified', verifiedAt: new Date(r.verified_at).toISOString(), checks: r.verification?.checks ?? [] },
  };
}

export class SupabasePersistence implements PersistenceStore {
  private readonly db: Db;
  private readonly clock: () => Date;

  constructor(db: Db, clock: () => Date = () => new Date()) {
    this.db = db;
    this.clock = clock;
  }
  private now = () => this.clock().toISOString();

  async upsertOrganizer(handle: string): Promise<OrganizerRow> {
    const h = handle.toLowerCase().replace(/^@/, '');
    if (!h || /[@\s]/.test(h)) throw new Error('invalid organizer handle');
    const res = await this.db.from('organizers').upsert({ platform: 'instagram', handle: h }, { onConflict: 'platform,handle' }).select().single();
    return must<OrganizerRow>(res, 'upsert organizer')!;
  }

  async getSourcePost(instagramPostId: string): Promise<SourcePostRow | null> {
    const res = await this.db.from('source_posts').select().eq('platform', 'instagram').eq('source_post_id', instagramPostId).maybeSingle();
    return must<SourcePostRow>(res, 'get source post');
  }

  async upsertSourcePost(organizerId: string, post: { id: string; permalink: string; caption: string | null; timestamp: string; mediaType?: string | null }, contentHash: string): Promise<UpsertSourcePostResult> {
    const existing = await this.getSourcePost(post.id);
    const now = this.now();
    if (!existing) {
      const res = await this.db.from('source_posts').insert({
        organizer_id: organizerId, platform: 'instagram', source_post_id: post.id, permalink: post.permalink, caption: post.caption, content_hash: contentHash,
        media_type: post.mediaType ?? null, posted_at: new Date(post.timestamp).toISOString(), origin: 'instagram-business-discovery', first_seen_at: now, last_seen_at: now,
      }).select().single();
      const row = must<SourcePostRow>(res, 'insert source post')!;
      await this.revision(row.id, contentHash, post.caption);
      return { row, status: 'new' };
    }
    const changed = existing.content_hash !== contentHash;
    const patch = changed ? { caption: post.caption, content_hash: contentHash, permalink: post.permalink, last_seen_at: now } : { last_seen_at: now };
    const res = await this.db.from('source_posts').update(patch).eq('id', existing.id).select().single();
    const row = must<SourcePostRow>(res, 'update source post')!;
    if (changed) await this.revision(row.id, contentHash, post.caption);
    return { row, status: changed ? 'changed' : 'unchanged' };
  }

  private async revision(sourcePostId: string, contentHash: string, caption: string | null) {
    must(await this.db.from('source_post_revisions').upsert({ source_post_id: sourcePostId, content_hash: contentHash, caption }, { onConflict: 'source_post_id,content_hash', ignoreDuplicates: true }), 'record revision');
  }

  async saveCandidate(row: CandidateRow): Promise<void> {
    must(await this.db.from('event_candidates').upsert(row, { onConflict: 'source_post_id' }), 'save candidate');
  }
  async getCandidate(sourcePostRowId: string): Promise<CandidateRow | null> {
    return must<CandidateRow>(await this.db.from('event_candidates').select().eq('source_post_id', sourcePostRowId).maybeSingle(), 'get candidate');
  }

  async upsertEvent(row: EventRow): Promise<EventRow & { id: string }> {
    const { id: _id, ...rest } = row;
    return must<EventRow & { id: string }>(await this.db.from('events').upsert(rest, { onConflict: 'event_key' }).select().single(), 'upsert event')!;
  }
  async getEventByKey(eventKey: string) {
    return must<EventRow & { id: string }>(await this.db.from('events').select().eq('event_key', eventKey).maybeSingle(), 'get event');
  }
  async listEvents(statuses: EventStatus[]) {
    return must<(EventRow & { id: string })[]>(await this.db.from('events').select().in('status', statuses), 'list events') ?? [];
  }
  async addEventSource(link: EventSourceRow): Promise<void> {
    // ignoreDuplicates: an existing link keeps its original role.
    must(await this.db.from('event_sources').upsert(link, { onConflict: 'event_id,source_post_id', ignoreDuplicates: true }), 'add event source');
  }
  async listEventSources(eventId: string) {
    const rows = must<any[]>(await this.db.from('event_sources').select('event_id, source_post_id, role, source_posts(permalink, source_post_id)').eq('event_id', eventId), 'list event sources') ?? [];
    return rows.map((r) => ({ event_id: r.event_id, source_post_id: r.source_post_id, role: r.role, permalink: r.source_posts.permalink, instagram_post_id: r.source_posts.source_post_id }));
  }
  async appendHistory(row: HistoryRow) {
    must(await this.db.from('event_history').insert(row), 'append history');
  }
  async listHistory(eventId: string): Promise<HistoryRow[]> {
    return must<HistoryRow[]>(await this.db.from('event_history').select('event_id, from_state, to_state, actor, reason, at').eq('event_id', eventId).order('at', { ascending: true }), 'list history') ?? [];
  }

  async startRun(extractor: string, unattendedPublishing: boolean) {
    const row = must<{ id: string }>(await this.db.from('ingestion_runs').insert({ extractor, unattended_publishing: unattendedPublishing }).select('id').single(), 'start run')!;
    return row.id;
  }
  async finishRun(runId: string, summary: RunSummary, error: string | null = null) {
    must(await this.db.from('ingestion_runs').update({ ...summary, status: error ? 'failed' : 'succeeded', finished_at: this.now(), error }).eq('id', runId), 'finish run');
  }
  async log(runId: string, entry: LogEntry) {
    must(await this.db.from('ingestion_logs').insert({ run_id: runId, source_post_id: entry.source_post_id ?? null, level: entry.level, message: entry.message, details: entry.details ?? {} }), 'write log');
  }

  // ---- venues
  async listVenues(): Promise<CanonicalVenue[]> {
    const rows = must<any[]>(await this.db.from('venues').select(VENUE_SELECT), 'list venues') ?? [];
    const slugById = new Map(rows.map((r) => [r.id as string, r.slug as string]));
    return rows.map((r) => venueFromRow(r, slugById));
  }
  async putVenue(v: CanonicalVenue): Promise<void> {
    if (v.evidence.some((e) => e.simulated)) throw new Error('simulated evidence can never be stored');
    if (v.verification.status !== 'verified') throw new Error('only verified venues can be stored');
    const parent = v.parentId ? await this.venueRowIdBySlug(v.parentId) : null;
    const saved = must<{ id: string }>(await this.db.from('venues').upsert({
      slug: v.id, name: v.name, name_key: v.key || normalizeVenueName(v.name), aliases: v.aliases, kind: v.kind, parent_id: parent, address: v.address.street, area: v.address.area, city: v.address.city,
      latitude: v.latitude, longitude: v.longitude, provider_refs: v.providerRefs, verification: v.verification, verified_at: v.verification.verifiedAt,
    }, { onConflict: 'slug' }).select('id').single(), 'upsert venue')!;
    if (v.evidence.length) {
      must(await this.db.from('venue_evidence').upsert(v.evidence.map((e) => ({
        venue_id: saved.id, provider: e.provider, dataset: e.dataset, supports: e.supports, place_id: e.placeId ?? '', name: e.name, city: e.city, address: e.address,
        latitude: e.latitude, longitude: e.longitude, retrieved_at: e.retrievedAt, url: e.url ?? null, simulated: false,
      })), { onConflict: 'venue_id,provider,place_id', ignoreDuplicates: true }), 'upsert venue evidence');
    }
  }
  async venueRowIdBySlug(slug: string) {
    return must<{ id: string }>(await this.db.from('venues').select('id').eq('slug', slug).maybeSingle(), 'venue id')?.id ?? null;
  }
  async getVenueByRowId(rowId: string): Promise<CanonicalVenue | null> {
    const row = must<any>(await this.db.from('venues').select(VENUE_SELECT).eq('id', rowId).maybeSingle(), 'get venue');
    if (!row) return null;
    const parentSlug = row.parent_id ? must<{ slug: string }>(await this.db.from('venues').select('slug').eq('id', row.parent_id).maybeSingle(), 'parent venue')?.slug : undefined;
    return venueFromRow(row, new Map(row.parent_id && parentSlug ? [[row.parent_id, parentSlug]] : []));
  }
  async getAttempt(key: string): Promise<LookupAttempt | null> {
    const r = must<any>(await this.db.from('venue_lookup_attempts').select().eq('name_key', key).maybeSingle(), 'get lookup attempt');
    return r ? { key: r.name_key, at: new Date(r.at).toISOString(), status: r.status, reasons: r.reasons ?? [] } : null;
  }
  async putAttempt(a: LookupAttempt): Promise<void> {
    must(await this.db.from('venue_lookup_attempts').upsert({ name_key: a.key, at: a.at, status: a.status, reasons: a.reasons }, { onConflict: 'name_key' }), 'put lookup attempt');
  }

  // ---- extraction cache
  async get(key: string): Promise<AiResult | null> {
    return must<{ result: AiResult }>(await this.db.from('extraction_cache').select('result').eq('cache_key', key).maybeSingle(), 'get cache')?.result ?? null;
  }
  async set(key: string, value: AiResult): Promise<void> {
    must(await this.db.from('extraction_cache').upsert({ cache_key: key, prompt_version: PROMPT_VERSION, result: value }, { onConflict: 'cache_key' }), 'set cache');
  }

  async listPublicEvents(_todayManila: string): Promise<PublicEventRow[]> {
    return must<PublicEventRow[]>(await this.db.from('public_events').select('*').order('starts_at', { ascending: true }), 'list public events') ?? [];
  }
}
