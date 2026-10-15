// Event lifecycle: what happens to an event after it exists. Pure functions over plain records
// (no database yet), each change appended to an audit history. The same operations are what a
// future admin screen would call for exceptions and corrections; routine events never need it.
//
//   held --publish--> published --unpublish--> unpublished --publish--> published
//     \--reject--> rejected          \--expire--> expired
import { manilaDate } from './manila-date.ts';
import { eventKey } from './pipeline.ts';
import type { PublishingDecision, PublishingPolicy } from './publishing.ts';
import type { EventCandidate, IngestItem } from './types.ts';

export type EventState = 'held' | 'published' | 'unpublished' | 'rejected' | 'expired';
export type Actor = 'system' | 'admin';

export type AuditEntry = { at: string; from: EventState | null; to: EventState; actor: Actor; reason: string };

export type EventRecord = {
  id: string;
  state: EventState;
  candidate: EventCandidate;
  /** Verified coordinates, copied from the venue registry. Null until the venue is verified. */
  location: { venueId: string; latitude: number; longitude: number } | null;
  /** Every Instagram post that announced this event; the original sources are never dropped. */
  sourcePostIds: string[];
  sourceUrls: string[];
  history: AuditEntry[];
};

const ALLOWED: Record<EventState, EventState[]> = {
  held: ['published', 'rejected'],
  published: ['unpublished', 'expired'],
  unpublished: ['published', 'rejected'],
  rejected: [],
  expired: [],
};

export type Result = { ok: true; record: EventRecord } | { ok: false; record: EventRecord; error: string };

function move(r: EventRecord, to: EventState, actor: Actor, reason: string, now: string): Result {
  if (!ALLOWED[r.state].includes(to)) return { ok: false, record: r, error: `cannot go from ${r.state} to ${to}` };
  return { ok: true, record: { ...r, state: to, history: [...r.history, { at: now, from: r.state, to, actor, reason }] } };
}

export function createRecord(item: IngestItem, decision: PublishingDecision, now: string, merged: IngestItem[] = []): EventRecord {
  if (!item.candidate) throw new Error('cannot create an event record without a candidate');
  const c = item.candidate;
  const all = [item, ...merged].map((i) => i.candidate).filter((x): x is EventCandidate => x !== null);
  return {
    id: `ev:${eventKey(c) ?? c.sourcePostId}`,
    state: 'held',
    candidate: c,
    location: decision.venue ? { venueId: decision.venue.id, latitude: decision.venue.latitude, longitude: decision.venue.longitude } : null,
    sourcePostIds: all.map((x) => x.sourcePostId),
    sourceUrls: all.map((x) => x.sourceUrl),
    history: [{ at: now, from: null, to: 'held', actor: 'system', reason: decision.summary }],
  };
}

/**
 * Publishing needs a verified location in every case. The system actor also needs the master
 * switch on; an admin can publish an exception by hand without it.
 */
export function publish(r: EventRecord, policy: PublishingPolicy, actor: Actor, reason: string, now: string): Result {
  if (!r.location) return { ok: false, record: r, error: 'no verified venue location' };
  if (actor === 'system' && !policy.unattendedPublishingEnabled) return { ok: false, record: r, error: 'unattended publishing is disabled' };
  return move(r, 'published', actor, reason, now);
}

export const unpublish = (r: EventRecord, actor: Actor, reason: string, now: string) => move(r, 'unpublished', actor, reason, now);
export const reject = (r: EventRecord, actor: Actor, reason: string, now: string) => move(r, 'rejected', actor, reason, now);

/** Published events whose last day has passed leave the map automatically. */
export function expireStale(records: EventRecord[], now: string): EventRecord[] {
  const today = manilaDate(now);
  return records.map((r) => {
    const end = r.candidate.endDate ?? r.candidate.date;
    if (r.state !== 'published' || !end || end >= today) return r;
    const res = move(r, 'expired', 'system', `ended ${end}`, now);
    return res.ok ? res.record : r;
  });
}

export function findMatch(records: EventRecord[], item: IngestItem): EventRecord | null {
  const c = item.candidate;
  const key = c && eventKey(c);
  return records.find((r) => r.sourcePostIds.includes(item.postId) || (key !== null && key === eventKey(r.candidate))) ?? null;
}

const FIELDS = ['name', 'date', 'endDate', 'startTime', 'venueName', 'venueArea', 'ticketUrl'] as const;

/**
 * Applies a fresh extraction of an already-known event. A published event that no longer passes
 * its checks (cancelled, date changed to something ambiguous, ...) is pulled automatically; a
 * changed but still-valid event is updated in place. Sources only ever grow.
 */
export function applyUpdate(r: EventRecord, item: IngestItem, decision: PublishingDecision, policy: PublishingPolicy, now: string): EventRecord {
  let next = r;
  const c = item.candidate;
  if (c && !next.sourcePostIds.includes(c.sourcePostId)) {
    next = { ...next, sourcePostIds: [...next.sourcePostIds, c.sourcePostId], sourceUrls: [...next.sourceUrls, c.sourceUrl] };
  }
  if (decision.decision !== 'eligible') {
    const why = `source update failed checks: ${decision.summary}`;
    if (next.state === 'published') {
      const res = unpublish(next, 'system', why, now);
      return res.ok ? res.record : next;
    }
    if (decision.decision === 'reject' && next.state === 'held') {
      const res = reject(next, 'system', why, now);
      return res.ok ? res.record : next;
    }
    return next;
  }
  if (c) {
    const changed = FIELDS.filter((f) => c[f] !== next.candidate[f]);
    if (changed.length) {
      next = {
        ...next,
        candidate: c,
        location: decision.venue ? { venueId: decision.venue.id, latitude: decision.venue.latitude, longitude: decision.venue.longitude } : next.location,
        history: [...next.history, { at: now, from: next.state, to: next.state, actor: 'system', reason: `updated from source: ${changed.join(', ')}` }],
      };
    }
  }
  if (next.state === 'held' && policy.unattendedPublishingEnabled) {
    const res = publish(next, policy, 'system', 'passed all checks after update', now);
    return res.ok ? res.record : next;
  }
  return next;
}
