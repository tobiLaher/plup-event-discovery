// Domain objects <-> database rows. Dates and times stay separate end to end: the event date is a Manila
// calendar date, the start time a nullable Manila wall-clock time; they are never joined in storage.
import { createHash } from 'node:crypto';
import type { EventRecord } from '../lifecycle.ts';
import type { PublishingDecision } from '../publishing.ts';
import type { EventCandidate, IngestItem } from '../types.ts';
import type { CandidateRow, EventRow, EventStatus } from './types.ts';

export const contentHash = (caption: string | null) => createHash('sha256').update(caption ?? '').digest('hex').slice(0, 32);

/** `HH:mm` -> `HH:mm:00` for a Postgres time column; null stays null (time not announced). */
export const toDbTime = (hhmm: string | null) => (hhmm ? `${hhmm}:00` : null);
/** `HH:mm:ss` -> `HH:mm`. */
export const fromDbTime = (t: string | null) => (t ? t.slice(0, 5) : null);

export function candidateRow(args: {
  item: IngestItem;
  decision: PublishingDecision;
  sourcePostRowId: string;
  extractor: string;
  venueRowId: string | null;
  eventKey: string | null;
}): CandidateRow {
  const { item, decision } = args;
  const c = item.candidate;
  return {
    source_post_id: args.sourcePostRowId,
    extractor: args.extractor,
    classification: item.classification,
    decision: decision.decision,
    action: decision.action,
    review_reasons: item.reviewReasons,
    blockers: decision.blockers,
    warnings: decision.warnings,
    checks: decision.checks,
    details: (item.details ?? {}) as unknown as Record<string, unknown>,
    name: c?.name ?? null,
    name_quality: c?.nameQuality ?? null,
    category: c?.category ?? null,
    event_date: c?.date ?? null,
    end_date: c?.endDate ?? null,
    start_time: toDbTime(c?.startTime ?? null),
    venue_name: c?.venueName ?? null,
    venue_area: c?.venueArea ?? null,
    artists: c?.artists ?? [],
    genre: c?.genre ?? null,
    ticket_price_min: c?.ticketPrice?.minPhp ?? null,
    ticket_price_max: c?.ticketPrice?.maxPhp ?? null,
    ticket_is_free: c?.ticketPrice?.isFree ?? null,
    ticket_url: c?.ticketUrl ?? null,
    event_key: args.eventKey,
    venue_id: args.venueRowId,
    snapshot: c ?? null,
  };
}

const PUBLIC_STATES: EventStatus[] = ['published', 'unpublished', 'expired'];

/** A lifecycle record that has been (or was) public becomes an events row. Held/rejected records never do. */
export function eventRowFromRecord(record: EventRecord, eventKey: string, venueRowId: string): EventRow {
  const c = record.candidate;
  if (!PUBLIC_STATES.includes(record.state as EventStatus)) throw new Error(`a ${record.state} event is never stored as a public event`);
  if (!c.name || (c.nameQuality !== 'explicit' && c.nameQuality !== 'derived')) throw new Error('an event needs a reliable title to be stored');
  if (!c.date) throw new Error('an event needs a date to be stored');
  const firstPublished = record.history.find((h) => h.to === 'published');
  const lastUnpublished = [...record.history].reverse().find((h) => h.to === 'unpublished' || h.to === 'expired');
  return {
    event_key: eventKey,
    title: c.name,
    title_quality: c.nameQuality,
    description: null,
    category: c.category,
    genre: c.genre,
    lineup: c.artists,
    event_date: c.date,
    end_date: c.endDate && c.endDate !== c.date ? c.endDate : null,
    start_time: toDbTime(c.startTime),
    venue_id: venueRowId,
    ticket_url: c.ticketUrl,
    ticket_price_min: c.ticketPrice?.minPhp ?? null,
    ticket_price_max: c.ticketPrice?.maxPhp ?? null,
    ticket_is_free: c.ticketPrice?.isFree ?? null,
    ticket_info: null,
    source_url: record.sourceUrls[0] ?? c.sourceUrl,
    source_label: `Instagram @${c.sourceUsername}`,
    status: record.state as EventStatus,
    published_at: firstPublished?.at ?? null,
    unpublished_at: record.state === 'published' ? null : (lastUnpublished?.at ?? null),
    unpublish_reason: record.state === 'published' ? null : (lastUnpublished?.reason ?? null),
    candidate_snapshot: c,
  };
}

/** Rebuilds the lifecycle record from stored rows, so applyUpdate/expireStale can run on it. */
export function recordFromRows(
  row: EventRow & { id: string },
  venue: { slug: string; latitude: number; longitude: number },
  sources: { instagram_post_id: string; permalink: string }[],
  history: { from_state: string | null; to_state: string; actor: 'system' | 'admin'; reason: string; at: string }[],
): EventRecord {
  return {
    id: `ev:${row.event_key}`,
    state: row.status,
    candidate: row.candidate_snapshot as EventCandidate,
    location: { venueId: venue.slug, latitude: venue.latitude, longitude: venue.longitude },
    sourcePostIds: sources.map((s) => s.instagram_post_id),
    sourceUrls: sources.map((s) => s.permalink),
    history: history.map((h) => ({ at: h.at, from: h.from_state as EventRecord['state'] | null, to: h.to_state as EventRecord['state'], actor: h.actor, reason: h.reason })),
  };
}
