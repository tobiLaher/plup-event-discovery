// In-memory PersistenceStore for tests and dry runs. It enforces the same natural keys and the same
// CHECK/FK rules as the SQL migration (unique keys, no event without a verified venue, no guessed or
// simulated data, Metro Manila coordinates), so behavior verified here maps onto the real schema.
import { randomUUID } from 'node:crypto';
import type { AiResult } from '../ai-schema.ts';
import { inMetroManila } from '../venues.ts';
import type { CanonicalVenue, LookupAttempt } from '../venue-registry.ts';
import type {
  CandidateRow, EventRow, EventSourceRow, EventStatus, HistoryRow, LogEntry, OrganizerRow, PersistenceStore,
  PublicEventRow, RunSummary, SourcePostRow, UpsertSourcePostResult,
} from './types.ts';

type EventRowId = EventRow & { id: string };

export class MemoryPersistence implements PersistenceStore {
  readonly organizers = new Map<string, OrganizerRow>();
  readonly sourcePosts = new Map<string, SourcePostRow>();
  readonly revisions: { source_post_id: string; content_hash: string; caption: string | null }[] = [];
  readonly candidates = new Map<string, CandidateRow>();
  readonly events = new Map<string, EventRowId>();
  readonly eventSources: (EventSourceRow & { id: string })[] = [];
  readonly history: HistoryRow[] = [];
  readonly runs = new Map<string, { extractor: string; unattended: boolean; summary: RunSummary | null; error: string | null }>();
  readonly logs: (LogEntry & { run_id: string })[] = [];
  readonly aiCache = new Map<string, AiResult>();
  readonly attempts = new Map<string, LookupAttempt>();
  private venues = new Map<string, { rowId: string; venue: CanonicalVenue }>();
  private readonly clock: () => Date;

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock;
  }
  private now = () => this.clock().toISOString();

  // ---- organizers and posts
  async upsertOrganizer(handle: string): Promise<OrganizerRow> {
    const h = handle.toLowerCase().replace(/^@/, '');
    if (!h || /[@\s]/.test(h)) throw new Error('invalid organizer handle');
    const existing = this.organizers.get(h);
    if (existing) return existing;
    const row: OrganizerRow = { id: randomUUID(), platform: 'instagram', handle: h, display_name: null, status: 'active' };
    this.organizers.set(h, row);
    return row;
  }

  async upsertSourcePost(organizerId: string, post: { id: string; permalink: string; caption: string | null; timestamp: string; mediaType?: string | null }, contentHash: string): Promise<UpsertSourcePostResult> {
    const existing = this.sourcePosts.get(post.id);
    const now = this.now();
    if (!existing) {
      const row: SourcePostRow = {
        id: randomUUID(), organizer_id: organizerId, platform: 'instagram', source_post_id: post.id, permalink: post.permalink, caption: post.caption,
        content_hash: contentHash, media_type: post.mediaType ?? null, posted_at: new Date(post.timestamp).toISOString(), origin: 'instagram-business-discovery', first_seen_at: now, last_seen_at: now,
      };
      this.sourcePosts.set(post.id, row);
      this.revisions.push({ source_post_id: row.id, content_hash: contentHash, caption: post.caption });
      return { row, status: 'new' };
    }
    if (existing.content_hash === contentHash) {
      existing.last_seen_at = now;
      return { row: existing, status: 'unchanged' };
    }
    // An edited caption: keep the new text current and the old/new versions as revisions.
    if (!this.revisions.some((r) => r.source_post_id === existing.id && r.content_hash === contentHash)) this.revisions.push({ source_post_id: existing.id, content_hash: contentHash, caption: post.caption });
    Object.assign(existing, { caption: post.caption, content_hash: contentHash, permalink: post.permalink, last_seen_at: now });
    return { row: existing, status: 'changed' };
  }

  async getSourcePost(instagramPostId: string) {
    return this.sourcePosts.get(instagramPostId) ?? null;
  }

  // ---- candidates
  async saveCandidate(row: CandidateRow): Promise<void> {
    if (!this.postByRowId(row.source_post_id)) throw new Error('candidate must reference a stored source post');
    if (row.event_date && row.end_date && row.end_date < row.event_date) throw new Error('end_date before event_date');
    if (row.venue_id && ![...this.venues.values()].some((v) => v.rowId === row.venue_id)) throw new Error('candidate venue is not a stored verified venue');
    const prior = this.candidates.get(row.source_post_id);
    this.candidates.set(row.source_post_id, { ...row, id: prior?.id ?? randomUUID() });
  }
  async getCandidate(sourcePostRowId: string) {
    return this.candidates.get(sourcePostRowId) ?? null;
  }
  private postByRowId(rowId: string) {
    return [...this.sourcePosts.values()].find((p) => p.id === rowId) ?? null;
  }

  // ---- events
  async upsertEvent(row: EventRow): Promise<EventRowId> {
    if (row.title_quality !== 'explicit' && row.title_quality !== 'derived') throw new Error('guessed titles can never be public');
    if (!row.title) throw new Error('event needs a title');
    if (row.end_date && row.end_date < row.event_date) throw new Error('end_date before event_date');
    if (![...this.venues.values()].some((v) => v.rowId === row.venue_id)) throw new Error('event must reference a verified venue');
    if (!['published', 'unpublished', 'expired'].includes(row.status)) throw new Error('invalid status');
    const prior = this.events.get(row.event_key);
    const stored: EventRowId = { ...row, id: prior?.id ?? randomUUID() };
    this.events.set(row.event_key, stored);
    return stored;
  }
  async getEventByKey(eventKey: string) {
    return this.events.get(eventKey) ?? null;
  }
  async listEvents(statuses: EventStatus[]) {
    return [...this.events.values()].filter((e) => statuses.includes(e.status));
  }
  async addEventSource(link: EventSourceRow): Promise<void> {
    if (![...this.events.values()].some((e) => e.id === link.event_id)) throw new Error('unknown event');
    if (!this.postByRowId(link.source_post_id)) throw new Error('unknown source post');
    if (this.eventSources.some((s) => s.event_id === link.event_id && s.source_post_id === link.source_post_id)) return; // keeps the original role
    this.eventSources.push({ ...link, id: randomUUID() });
  }
  async listEventSources(eventId: string) {
    return this.eventSources
      .filter((s) => s.event_id === eventId)
      .map((s) => {
        const p = this.postByRowId(s.source_post_id)!;
        return { event_id: s.event_id, source_post_id: s.source_post_id, role: s.role, permalink: p.permalink, instagram_post_id: p.source_post_id };
      });
  }
  async appendHistory(row: HistoryRow) {
    this.history.push(row);
  }
  async listHistory(eventId: string) {
    return this.history.filter((h) => h.event_id === eventId);
  }

  // ---- runs and logs
  async startRun(extractor: string, unattendedPublishing: boolean) {
    const id = randomUUID();
    this.runs.set(id, { extractor, unattended: unattendedPublishing, summary: null, error: null });
    return id;
  }
  async finishRun(runId: string, summary: RunSummary, error: string | null = null) {
    const r = this.runs.get(runId);
    if (!r) throw new Error('unknown run');
    r.summary = summary;
    r.error = error;
  }
  async log(runId: string, entry: LogEntry) {
    if (!this.runs.has(runId)) throw new Error('unknown run');
    this.logs.push({ ...entry, run_id: runId });
  }

  // ---- venues (VenueStore) with the same rules as the venues / venue_evidence tables
  async listVenues() {
    return [...this.venues.values()].map((v) => v.venue);
  }
  async putVenue(v: CanonicalVenue) {
    if (v.verification.status !== 'verified') throw new Error('only verified venues can be stored');
    if (!inMetroManila(v)) throw new Error('venue is outside Metro Manila');
    if (v.evidence.some((e) => e.simulated)) throw new Error('simulated evidence can never be stored');
    const prior = this.venues.get(v.id);
    this.venues.set(v.id, { rowId: prior?.rowId ?? randomUUID(), venue: v });
  }
  async getAttempt(key: string) {
    return this.attempts.get(key) ?? null;
  }
  async putAttempt(a: LookupAttempt) {
    this.attempts.set(a.key, a);
  }
  async venueRowIdBySlug(slug: string) {
    return this.venues.get(slug)?.rowId ?? null;
  }
  async getVenueByRowId(rowId: string) {
    return [...this.venues.values()].find((v) => v.rowId === rowId)?.venue ?? null;
  }

  // ---- extraction cache
  async get(key: string) {
    return this.aiCache.get(key) ?? null;
  }
  async set(key: string, value: AiResult) {
    this.aiCache.set(key, value);
  }

  // ---- what the anonymous map would see (mirror of public.public_events)
  async listPublicEvents(todayManila: string): Promise<PublicEventRow[]> {
    return [...this.events.values()]
      .filter((e) => e.status === 'published' && (e.end_date ?? e.event_date) >= todayManila)
      .map((e) => {
        const v = [...this.venues.values()].find((x) => x.rowId === e.venue_id)!;
        const time = e.start_time ?? '12:00:00';
        return {
          id: e.id, title: e.title, title_is_generated: e.title_quality === 'derived', description: e.description, category: e.category, genre: e.genre, lineup: e.lineup,
          event_date: e.event_date, end_date: e.end_date, start_time: e.start_time, time_known: e.start_time !== null,
          starts_at: new Date(`${e.event_date}T${time}+08:00`).toISOString(),
          ticket_url: e.ticket_url, ticket_price_min: e.ticket_price_min, ticket_price_max: e.ticket_price_max, ticket_is_free: e.ticket_is_free, ticket_info: e.ticket_info,
          source_url: e.source_url, source_label: e.source_label,
          venue_id: v.rowId, venue_name: v.venue.name, venue_address: v.venue.address.street, venue_area: v.venue.address.area, venue_city: v.venue.address.city,
          latitude: v.venue.latitude, longitude: v.venue.longitude,
        };
      });
  }
}

