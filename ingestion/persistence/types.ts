// Database-shaped rows (snake_case, matching supabase/migrations) and the storage interface the
// ingestion service talks to. Two implementations: MemoryPersistence (tests, dry runs) and
// SupabasePersistence (server-side only). Nothing here runs in the Expo app.
import type { ExtractionCache } from '../ai-extractor.ts';
import type { CanonicalVenue, VenueStore } from '../venue-registry.ts';

export type OrganizerRow = {
  id: string;
  platform: 'instagram';
  handle: string;
  display_name: string | null;
  status: 'active' | 'paused' | 'blocked';
};

export type SourcePostRow = {
  id: string;
  organizer_id: string;
  platform: 'instagram';
  source_post_id: string;
  permalink: string;
  caption: string | null;
  content_hash: string;
  media_type: string | null;
  posted_at: string;
  origin: 'instagram-business-discovery';
  first_seen_at: string;
  last_seen_at: string;
};

export type CandidateRow = {
  id?: string;
  source_post_id: string; // FK to source_posts.id (the row uuid, not the Instagram id)
  extractor: string;
  classification: 'upcoming_event' | 'past_event_recap' | 'unrelated' | 'ambiguous';
  decision: 'reject' | 'hold' | 'eligible';
  action: 'reject' | 'hold' | 'publish' | 'none';
  review_reasons: string[];
  blockers: string[];
  warnings: string[];
  checks: unknown[];
  details: Record<string, unknown>;
  name: string | null;
  name_quality: 'explicit' | 'derived' | 'guessed' | null;
  category: 'concert' | 'nightlife' | 'festival' | 'other' | null;
  /** Manila calendar date. Never combined with start_time in storage. */
  event_date: string | null;
  end_date: string | null;
  /** Manila wall-clock `HH:mm:ss`, null when not announced. */
  start_time: string | null;
  venue_name: string | null;
  venue_area: string | null;
  artists: string[];
  genre: string | null;
  ticket_price_min: number | null;
  ticket_price_max: number | null;
  ticket_is_free: boolean | null;
  ticket_url: string | null;
  event_key: string | null;
  venue_id: string | null;
  /** The full EventCandidate, so a lifecycle record can be rebuilt exactly. */
  snapshot: unknown | null;
};

export type EventStatus = 'published' | 'unpublished' | 'expired';

export type EventRow = {
  id?: string;
  event_key: string;
  title: string;
  title_quality: 'explicit' | 'derived';
  description: string | null;
  category: CandidateRow['category'];
  genre: string | null;
  lineup: string[];
  event_date: string;
  end_date: string | null;
  start_time: string | null;
  venue_id: string;
  ticket_url: string | null;
  ticket_price_min: number | null;
  ticket_price_max: number | null;
  ticket_is_free: boolean | null;
  ticket_info: string | null;
  source_url: string;
  source_label: string | null;
  status: EventStatus;
  published_at: string | null;
  unpublished_at: string | null;
  unpublish_reason: string | null;
  candidate_snapshot: unknown;
};

export type EventSourceRole = 'primary' | 'duplicate' | 'update' | 'cancellation';
export type EventSourceRow = { event_id: string; source_post_id: string; role: EventSourceRole };

export type HistoryRow = { event_id: string; from_state: string | null; to_state: string; actor: 'system' | 'admin'; reason: string; at: string };

export type RunSummary = {
  posts_seen: number;
  posts_new: number;
  posts_changed: number;
  eligible: number;
  held: number;
  rejected: number;
  published: number;
  api_requests: number;
  input_tokens: number;
  output_tokens: number;
};

export type LogEntry = { source_post_id?: string | null; level: 'info' | 'warn' | 'error'; message: string; details?: Record<string, unknown> };

/** What the public map may see: the columns of the public.public_events view. */
export type PublicEventRow = {
  id: string;
  title: string;
  title_is_generated: boolean;
  description: string | null;
  category: string | null;
  genre: string | null;
  lineup: string[];
  event_date: string;
  end_date: string | null;
  start_time: string | null;
  time_known: boolean;
  starts_at: string;
  ticket_url: string | null;
  ticket_price_min: number | null;
  ticket_price_max: number | null;
  ticket_is_free: boolean | null;
  ticket_info: string | null;
  source_url: string;
  source_label: string | null;
  venue_id: string;
  venue_name: string;
  venue_address: string | null;
  venue_area: string | null;
  venue_city: string;
  latitude: number;
  longitude: number;
};

export type UpsertSourcePostResult = { row: SourcePostRow; status: 'new' | 'unchanged' | 'changed' };

/** Server-side storage for the ingestion service. Writes are idempotent by the natural keys noted below. */
export interface PersistenceStore extends VenueStore, ExtractionCache {
  /** Idempotent by (platform, handle). */
  upsertOrganizer(handle: string): Promise<OrganizerRow>;
  /** Idempotent by (platform, source_post_id). A changed caption keeps the old text as a revision. */
  upsertSourcePost(organizerId: string, post: { id: string; permalink: string; caption: string | null; timestamp: string; mediaType?: string | null }, contentHash: string): Promise<UpsertSourcePostResult>;
  /** Venue row ids are database uuids; the domain uses slugs (CanonicalVenue.id). */
  venueRowIdBySlug(slug: string): Promise<string | null>;
  getVenueByRowId(rowId: string): Promise<CanonicalVenue | null>;
  getSourcePost(instagramPostId: string): Promise<SourcePostRow | null>;
  /** Idempotent by source_post_id: one current candidate per post. */
  saveCandidate(row: CandidateRow): Promise<void>;
  getCandidate(sourcePostRowId: string): Promise<CandidateRow | null>;
  /** Idempotent by event_key. Returns the stored row with its id. */
  upsertEvent(row: EventRow): Promise<EventRow & { id: string }>;
  getEventByKey(eventKey: string): Promise<(EventRow & { id: string }) | null>;
  listEvents(statuses: EventStatus[]): Promise<(EventRow & { id: string })[]>;
  /** Idempotent by (event_id, source_post_id); an existing link keeps its original role. */
  addEventSource(link: EventSourceRow): Promise<void>;
  listEventSources(eventId: string): Promise<(EventSourceRow & { permalink: string; instagram_post_id: string })[]>;
  appendHistory(row: HistoryRow): Promise<void>;
  listHistory(eventId: string): Promise<HistoryRow[]>;
  startRun(extractor: string, unattendedPublishing: boolean): Promise<string>;
  finishRun(runId: string, summary: RunSummary, error?: string | null): Promise<void>;
  log(runId: string, entry: LogEntry): Promise<void>;
  /** What the anonymous map would receive (mirrors the public.public_events view). */
  listPublicEvents(todayManila: string): Promise<PublicEventRow[]>;
}
