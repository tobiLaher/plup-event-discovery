// The ingestion service: runs the existing pipeline (extract -> dedupe -> venue resolution -> publishing
// checks -> lifecycle) and persists every step through a PersistenceStore. Re-running it over the same
// posts changes nothing (all writes are idempotent by natural key). Unattended publishing stays off unless
// the policy says otherwise, so by default nothing becomes public here.
import type { EventExtractor } from '../extractor.ts';
import { applyUpdate, createRecord, expireStale, publish, unpublish, type EventRecord } from '../lifecycle.ts';
import { manilaDate } from '../manila-date.ts';
import { eventKey, ingest } from '../pipeline.ts';
import { DEFAULT_POLICY, evaluateBatch, type PublishingPolicy } from '../publishing.ts';
import type { EventCandidate, InstagramPost } from '../types.ts';
import { SEED_VENUES } from '../venue-registry.ts';
import { resolveVenuesForItems, type VenueResolver } from '../venue-resolver.ts';
import { candidateRow, contentHash, eventRowFromRecord, recordFromRows } from './mapping.ts';
import type { EventRow, EventSourceRole, PersistenceStore, RunSummary } from './types.ts';

/** Idempotent: puts the verified seed venues (PICC Plenary Hall) into a store that doesn't have them yet. */
export async function seedVenues(store: PersistenceStore): Promise<void> {
  const have = new Set((await store.listVenues()).map((v) => v.id));
  for (const v of SEED_VENUES) if (!have.has(v.id)) await store.putVenue(v);
}

async function loadRecord(store: PersistenceStore, row: EventRow & { id: string }): Promise<EventRecord> {
  const venue = await store.getVenueByRowId(row.venue_id);
  if (!venue) throw new Error('stored event references a missing venue');
  const sources = await store.listEventSources(row.id);
  const history = await store.listHistory(row.id);
  return recordFromRows(row, { slug: venue.id, latitude: venue.latitude, longitude: venue.longitude }, sources, history);
}

/** Writes the event row and any new history entries (those beyond `knownHistory`). */
async function persistRecord(store: PersistenceStore, record: EventRecord, knownHistory: number): Promise<EventRow & { id: string }> {
  if (!record.location) throw new Error('refusing to store an event without a verified venue');
  const venueRowId = await store.venueRowIdBySlug(record.location.venueId);
  if (!venueRowId) throw new Error('event venue is not in the store');
  const saved = await store.upsertEvent(eventRowFromRecord(record, record.id.replace(/^ev:/, ''), venueRowId));
  for (const h of record.history.slice(knownHistory)) {
    await store.appendHistory({ event_id: saved.id, from_state: h.from, to_state: h.to, actor: h.actor, reason: h.reason, at: h.at });
  }
  return saved;
}

export type SyncPostReport = {
  postId: string;
  decision: 'reject' | 'hold' | 'eligible';
  action: 'reject' | 'hold' | 'publish' | 'none';
  eventKey: string | null;
  eventState: string | null;
};

export type SyncReport = { runId: string; summary: RunSummary; posts: SyncPostReport[]; expired: number };

export type SyncOptions = {
  store: PersistenceStore;
  extractor: EventExtractor;
  resolver: VenueResolver;
  policy?: PublishingPolicy;
  now: string;
  /** Optional usage numbers for the run record (e.g. from AiExtractor.stats). */
  usage?: () => { requests: number; inputTokens: number; outputTokens: number };
};

export async function persistIngestion(posts: InstagramPost[], o: SyncOptions): Promise<SyncReport> {
  const { store, extractor, resolver, now } = o;
  const policy = o.policy ?? DEFAULT_POLICY;
  const zero: RunSummary = { posts_seen: 0, posts_new: 0, posts_changed: 0, eligible: 0, held: 0, rejected: 0, published: 0, api_requests: 0, input_tokens: 0, output_tokens: 0 };
  const summary = { ...zero };
  const runId = await store.startRun(extractor.info.name, policy.unattendedPublishingEnabled);
  const report: SyncPostReport[] = [];
  let expired = 0;
  try {
    await seedVenues(store);

    // 1. Source posts (idempotent by platform + post id; edits keep their history). Synthetic data never reaches storage.
    const real = posts.filter((p) => p.origin === 'instagram-business-discovery');
    for (const p of posts.filter((x) => x.origin !== 'instagram-business-discovery')) {
      await store.log(runId, { level: 'error', message: 'synthetic post skipped; only real posts are stored', details: { post: p.id } });
    }
    const rows = new Map<string, Awaited<ReturnType<PersistenceStore['upsertSourcePost']>>['row']>();
    for (const p of real) {
      const org = await store.upsertOrganizer(p.username);
      const r = await store.upsertSourcePost(org.id, { id: p.id, permalink: p.permalink, caption: p.caption, timestamp: p.timestamp }, contentHash(p.caption));
      rows.set(p.id, r.row);
      summary.posts_seen++;
      if (r.status === 'new') summary.posts_new++;
      if (r.status === 'changed') summary.posts_changed++;
    }

    // 2. Existing pipeline: extraction (cached), duplicate detection, venue resolution, publishing checks.
    const run = await ingest(real, extractor, { now });
    const lookup = await resolveVenuesForItems(run.items, resolver);
    const decisions = evaluateBatch(run.items, { now, extractor: run.extractor, policy, venueLookup: lookup });
    const itemByPost = new Map(run.items.map((i) => [i.postId, i]));

    // 3. Candidates and events.
    for (let i = 0; i < real.length; i++) {
      const post = real[i];
      const item = run.items[i];
      const decision = decisions[i];
      const sp = rows.get(post.id)!;
      const key = item.candidate ? eventKey(item.candidate) : null;
      const venueRowId = decision.venue ? await store.venueRowIdBySlug(decision.venue.id) : null;
      await store.saveCandidate(candidateRow({ item, decision, sourcePostRowId: sp.id, extractor: run.extractor.name, venueRowId, eventKey: key }));
      if (decision.decision === 'eligible') summary.eligible++;
      else if (decision.decision === 'hold') summary.held++;
      else summary.rejected++;
      if (item.reviewReasons.includes('ai_invalid_response')) await store.log(runId, { source_post_id: sp.id, level: 'warn', message: 'model reply unusable; post held', details: { notes: item.details?.notes ?? [] } });
      else if (decision.decision === 'hold') await store.log(runId, { source_post_id: sp.id, level: 'info', message: 'held', details: { blockers: decision.blockers } });

      let eventState: string | null = null;
      if (item.candidate && key) {
        const existing = await store.getEventByKey(key);
        if (existing) {
          // Same event again (a repost, an update, a cancellation): re-check it, keep every source.
          const before = await loadRecord(store, existing);
          const after = applyUpdate(before, item, decision, policy, now);
          const role: EventSourceRole = item.reviewReasons.includes('cancellation_signal') ? 'cancellation' : after.history.length > before.history.length && after.state === before.state ? 'update' : 'duplicate';
          const saved = after === before ? existing : await persistRecord(store, after, before.history.length);
          await store.addEventSource({ event_id: saved.id, source_post_id: sp.id, role });
          eventState = after.state;
        } else if (decision.action === 'publish') {
          const merged = decision.mergedSourcePostIds.map((id) => itemByPost.get(id)).filter((x): x is NonNullable<typeof x> => Boolean(x));
          const rec = createRecord(item, decision, now, merged);
          const res = publish(rec, policy, 'system', 'passed all publishing checks', now);
          if (res.ok) {
            const saved = await persistRecord(store, res.record, 0);
            await store.addEventSource({ event_id: saved.id, source_post_id: sp.id, role: 'primary' });
            for (const m of decision.mergedSourcePostIds) {
              const mrow = rows.get(m);
              if (mrow) await store.addEventSource({ event_id: saved.id, source_post_id: mrow.id, role: 'duplicate' });
            }
            summary.published++;
            eventState = 'published';
          }
        }
      }
      report.push({ postId: post.id, decision: decision.decision, action: decision.action, eventKey: key, eventState });
    }

    // 4. Time-based expiry of events whose last day has passed.
    for (const row of await store.listEvents(['published'])) {
      const before = await loadRecord(store, row);
      const [after] = expireStale([before], now);
      if (after.state !== before.state) {
        await persistRecord(store, after, before.history.length);
        expired++;
      }
    }

    const u = o.usage?.();
    summary.api_requests = u?.requests ?? 0;
    summary.input_tokens = u?.inputTokens ?? 0;
    summary.output_tokens = u?.outputTokens ?? 0;
    await store.finishRun(runId, summary, null);
    return { runId, summary, posts: report, expired };
  } catch (e) {
    await store.finishRun(runId, summary, (e instanceof Error ? e.message : String(e)).replace(/[A-Za-z0-9_\-]{32,}/g, '[redacted]').slice(0, 300));
    throw e;
  }
}

// ---- administrator exceptions (not the normal path) ----

/** Publishes a stored candidate by hand. Still refuses guessed titles, missing dates and unverified venues. */
export async function adminPublishCandidate(store: PersistenceStore, instagramPostId: string, reason: string, now: string): Promise<EventRow & { id: string }> {
  const sp = await store.getSourcePost(instagramPostId);
  const cand = sp ? await store.getCandidate(sp.id) : null;
  if (!sp || !cand?.snapshot || !cand.event_key || !cand.venue_id) throw new Error('candidate is missing a name, date or verified venue');
  const venue = await store.getVenueByRowId(cand.venue_id);
  if (!venue) throw new Error('candidate venue is not verified');
  const rec: EventRecord = {
    id: `ev:${cand.event_key}`,
    state: 'held',
    candidate: cand.snapshot as EventCandidate,
    location: { venueId: venue.id, latitude: venue.latitude, longitude: venue.longitude },
    sourcePostIds: [sp.source_post_id],
    sourceUrls: [sp.permalink],
    history: [{ at: now, from: null, to: 'held', actor: 'system', reason: 'stored candidate' }],
  };
  const res = publish(rec, DEFAULT_POLICY, 'admin', reason, now);
  if (!res.ok) throw new Error(res.error);
  const saved = await persistRecord(store, res.record, 0);
  await store.addEventSource({ event_id: saved.id, source_post_id: sp.id, role: 'primary' });
  return saved;
}

export async function adminUnpublishEvent(store: PersistenceStore, eventKeyValue: string, reason: string, now: string): Promise<void> {
  const row = await store.getEventByKey(eventKeyValue);
  if (!row) throw new Error('unknown event');
  const rec = await loadRecord(store, row);
  const res = unpublish(rec, 'admin', reason, now);
  if (!res.ok) throw new Error(res.error);
  await persistRecord(store, res.record, rec.history.length);
}

export const todayManila = (now: string) => manilaDate(now);
