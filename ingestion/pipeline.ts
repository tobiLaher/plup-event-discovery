// Turns Instagram posts into reviewable event candidates. Nothing here publishes anything:
// the best possible outcome is `ready_for_approval`, which still requires a human.
import type { EventExtractor } from './extractor.ts';
import { toStartsAt } from './manila-date.ts';
import type {
  EventCandidate,
  ExtractionDraft,
  IngestItem,
  IngestResult,
  InstagramPost,
  ReviewReason,
} from './types.ts';

const norm = (s: string | null) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Identity of an event across posts; null until name, date and venue are all known. */
export function eventKey(c: Pick<EventCandidate, 'name' | 'date' | 'venueName'>): string | null {
  return c.name && c.date && c.venueName ? `${norm(c.name)}|${c.date}|${norm(c.venueName)}` : null;
}

function toCandidate(post: InstagramPost, draft: ExtractionDraft): EventCandidate {
  const f = draft.fields;
  return {
    ...f,
    startsAt: toStartsAt(f.date, f.startTime),
    sourceUrl: post.permalink,
    sourcePostId: post.id,
    sourceUsername: post.username,
    sourceOrigin: post.origin,
    sourcePostedAt: post.timestamp,
  };
}

/** Reasons a human must look at an upcoming/ambiguous candidate. */
function validate(draft: ExtractionDraft, extractorKind: string): ReviewReason[] {
  const f = draft.fields;
  const reasons = new Set<ReviewReason>(draft.flags);
  if (draft.classification === 'ambiguous') reasons.add('ambiguous_classification');
  if (!f.name) reasons.add('missing_name');
  if (!f.date && !reasons.has('multiple_dates') && !reasons.has('relative_date')) reasons.add('missing_date');
  if (!f.date && (reasons.has('multiple_dates') || reasons.has('relative_date'))) reasons.add('ambiguous_date');
  if (!f.startTime && !reasons.has('ambiguous_start_time')) reasons.add('missing_start_time');
  if (!f.venueName) reasons.add('missing_venue');
  if (f.venueName && !f.venueArea) reasons.add('missing_location_area');
  // Dates inferred from a missing year, or any relative wording, are never trusted blindly.
  if (extractorKind !== 'ai') reasons.add('unverified_extractor');
  return [...reasons];
}

export async function ingest(
  posts: InstagramPost[],
  extractor: EventExtractor,
  options: { now?: string } = {},
): Promise<IngestResult> {
  const now = options.now ?? new Date().toISOString();
  const seen = new Set<string>();
  const items: IngestItem[] = [];
  await extractor.prepare?.(posts, now);

  for (const post of posts) {
    if (seen.has(post.id)) {
      items.push({
        postId: post.id,
        classification: 'unrelated',
        classificationNotes: ['skipped: source post id already ingested in this batch'],
        reviewStatus: 'excluded',
        reviewReasons: ['duplicate_source_post'],
        candidate: null,
      });
      continue;
    }
    seen.add(post.id);

    const draft = await extractor.extract({ post, now });
    if (draft.classification === 'past_event_recap' || draft.classification === 'unrelated') {
      items.push({
        postId: post.id,
        classification: draft.classification,
        classificationNotes: draft.classificationNotes,
        details: draft.details,
        reviewStatus: 'excluded',
        reviewReasons: [],
        candidate: null,
      });
      continue;
    }

    const reasons = validate(draft, extractor.info.kind);
    // `unverified_extractor` is informational for rules/simulated output: it alone doesn't block approval review.
    const blocking = reasons.filter((r) => r !== 'unverified_extractor');
    items.push({
      postId: post.id,
      classification: draft.classification,
      classificationNotes: draft.classificationNotes,
      details: draft.details,
      reviewStatus: blocking.length ? 'needs_review' : 'ready_for_approval',
      reviewReasons: reasons,
      candidate: toCandidate(post, draft),
    });
  }

  // Same event announced by different posts (name + date + venue match) → both need a look.
  const byKey = new Map<string, IngestItem[]>();
  for (const item of items) {
    const c = item.candidate;
    if (!c || item.classification !== 'upcoming_event' || !c.name || !c.date || !c.venueName) continue;
    const key = eventKey(c)!;
    byKey.set(key, [...(byKey.get(key) ?? []), item]);
  }
  for (const group of byKey.values()) {
    if (group.length < 2) continue;
    for (const item of group) {
      item.reviewReasons.push('possible_duplicate_event');
      item.reviewStatus = 'needs_review';
    }
  }

  const count = (pred: (i: IngestItem) => boolean) => items.filter(pred).length;
  return {
    extractor: extractor.info,
    now,
    items,
    summary: {
      total: items.length,
      upcoming: count((i) => i.classification === 'upcoming_event'),
      pastRecap: count((i) => i.classification === 'past_event_recap'),
      unrelated: count((i) => i.classification === 'unrelated' && !i.reviewReasons.includes('duplicate_source_post')),
      ambiguous: count((i) => i.classification === 'ambiguous'),
      duplicates: count((i) => i.reviewReasons.includes('duplicate_source_post') || i.reviewReasons.includes('possible_duplicate_event')),
      readyForApproval: count((i) => i.reviewStatus === 'ready_for_approval'),
      needsReview: count((i) => i.reviewStatus === 'needs_review'),
    },
  };
}
