// Automatic-publishing eligibility. Every decision is a list of named, deterministic checks, so
// "why wasn't this published?" always has an answer. There is no opaque confidence score.
//
//   reject   -> never publish (recap, unrelated, duplicate, past, synthetic)
//   hold     -> keep unpublished; a blocker names what enrichment or a person must resolve
//   eligible -> every blocker passed. It is only PUBLISHED when policy.unattendedPublishingEnabled
//               is true; that switch is off by default until validated on more real data.
import { dayNumber, manilaDate } from './manila-date.ts';
import { eventKey } from './pipeline.ts';
import type { EventCandidate, ExtractorInfo, IngestItem, ReviewReason } from './types.ts';
import type { CanonicalVenue } from './venue-registry.ts';
import { lookupFromVenues, type VenueLookup } from './venue-resolver.ts';

export type PublishingPolicy = {
  /** Master switch. Off until validated on more real data and production API access is confirmed. */
  unattendedPublishingEnabled: boolean;
  /** Events further out than this are held (usually a mis-read date). */
  maxHorizonDays: number;
  minVenueSources: number;
};

export const DEFAULT_POLICY: PublishingPolicy = {
  unattendedPublishingEnabled: false,
  maxHorizonDays: 548,
  minVenueSources: 2,
};

export type CheckId =
  | 'classification' | 'ai_output_clean' | 'real_source' | 'source_provenance' | 'not_duplicate' | 'no_cancellation'
  | 'date_known' | 'date_explicit_year' | 'date_not_past' | 'date_within_horizon'
  | 'name_reliable' | 'venue_named' | 'venue_verified' | 'in_metro_manila'
  | 'start_time_known' | 'artists_known' | 'ticket_info_known' | 'extractor_is_ai' | 'name_is_official';

export type Check = {
  id: CheckId;
  /** blocker: failing keeps the event unpublished. warning: noted, never blocks. */
  severity: 'blocker' | 'warning';
  passed: boolean;
  detail: string;
};

export type PublishingDecision = {
  postId: string;
  decision: 'reject' | 'hold' | 'eligible';
  /** What the system does now. `none` = eligible but unattended publishing is disabled. */
  action: 'reject' | 'hold' | 'publish' | 'none';
  checks: Check[];
  blockers: CheckId[];
  warnings: CheckId[];
  venue: CanonicalVenue | null;
  /** Other posts for the same event, merged into this one so every source is preserved. */
  mergedSourcePostIds: string[];
  summary: string;
};

export type EvaluateOptions = {
  now: string;
  extractor: ExtractorInfo;
  policy?: PublishingPolicy;
  /** Resolves a venue name to a verified venue. Defaults to the registry seed (PICC Plenary Hall). */
  venueLookup?: VenueLookup;
};

const DEFAULT_LOOKUP = lookupFromVenues();

const has = (item: IngestItem, r: ReviewReason) => item.reviewReasons.includes(r);

function finish(
  item: IngestItem,
  checks: Check[],
  venue: CanonicalVenue | null,
  policy: PublishingPolicy,
  rejectWhy: string | null,
): PublishingDecision {
  const failed = checks.filter((c) => !c.passed);
  const blockers = failed.filter((c) => c.severity === 'blocker').map((c) => c.id);
  const warnings = failed.filter((c) => c.severity === 'warning').map((c) => c.id);
  const decision: PublishingDecision['decision'] = rejectWhy ? 'reject' : blockers.length ? 'hold' : 'eligible';
  const action: PublishingDecision['action'] =
    decision === 'reject' ? 'reject' : decision === 'hold' ? 'hold' : policy.unattendedPublishingEnabled ? 'publish' : 'none';
  const summary =
    decision === 'reject'
      ? `rejected: ${rejectWhy}`
      : decision === 'hold'
        ? `held: ${blockers.join(', ')}`
        : policy.unattendedPublishingEnabled
          ? 'eligible: will publish'
          : 'eligible, but unattended publishing is disabled';
  return { postId: item.postId, decision, action, checks, blockers, warnings, venue, mergedSourcePostIds: [], summary };
}

export function evaluatePublishing(item: IngestItem, opts: EvaluateOptions): PublishingDecision {
  const policy = opts.policy ?? DEFAULT_POLICY;
  const lookupVenue = opts.venueLookup ?? DEFAULT_LOOKUP;
  const today = manilaDate(opts.now);
  const c: EventCandidate | null = item.candidate;
  const checks: Check[] = [];
  const add = (id: CheckId, severity: Check['severity'], passed: boolean, detail: string) =>
    checks.push({ id, severity, passed, detail });

  add('classification', 'blocker', item.classification === 'upcoming_event', `classified as ${item.classification}`);
  // A reply that was unusable, or had claims the caption did not support, is evidence the model was unreliable
  // for this post; hold it instead of publishing on whatever happened to survive.
  const aiProblem = has(item, 'ai_invalid_response') || has(item, 'ai_ungrounded_field');
  add('ai_output_clean', 'blocker', !aiProblem, aiProblem ? 'model reply was invalid or contained unsupported claims' : 'no AI extraction problems');
  add('not_duplicate', 'blocker', !has(item, 'duplicate_source_post'), has(item, 'duplicate_source_post') ? 'source post already ingested' : 'unique source post');

  // Posts that can never become events are rejected outright; there is nothing to enrich.
  if (!c) {
    const why = has(item, 'duplicate_source_post') ? 'duplicate source post' : `${item.classification} post`;
    return finish(item, checks, null, policy, why);
  }

  add('real_source', 'blocker', c.sourceOrigin !== 'synthetic', c.sourceOrigin === 'synthetic' ? 'synthetic test data is never published' : `origin ${c.sourceOrigin}`);
  add('source_provenance', 'blocker', Boolean(c.sourceUrl && c.sourcePostId), c.sourceUrl ? 'original Instagram link kept' : 'missing source link');
  const changing = has(item, 'cancellation_signal') || has(item, 'event_update_signal');
  add('no_cancellation', 'blocker', !changing, changing ? 'post mentions a cancellation, postponement, reschedule or update' : 'no cancellation or update wording');

  const dateProblem = has(item, 'ambiguous_date') || has(item, 'multiple_dates') || has(item, 'relative_date');
  add('date_known', 'blocker', Boolean(c.date) && !dateProblem, !c.date ? 'no date' : dateProblem ? 'date is ambiguous, relative or has several values' : c.date);
  add('date_explicit_year', 'blocker', !has(item, 'year_inferred'), has(item, 'year_inferred') ? 'year was inferred from the post date' : 'year stated in the post');
  const past = Boolean(c.date) && (c.endDate ?? c.date)! < today;
  add('date_not_past', 'blocker', !past, past ? `ended before ${today}` : 'not in the past');
  const days = c.date ? dayNumber(c.date) - dayNumber(today) : null;
  add('date_within_horizon', 'blocker', days === null || days <= policy.maxHorizonDays, days === null ? 'no date' : `${days} days away (limit ${policy.maxHorizonDays})`);

  add('name_reliable', 'blocker', c.nameQuality === 'explicit' || c.nameQuality === 'derived', `name is ${c.nameQuality ?? 'missing'}`);
  add('venue_named', 'blocker', Boolean(c.venueName), c.venueName ?? 'no venue');

  const res = lookupVenue(c.venueName);
  const venue = res.status === 'verified' ? res.venue : null;
  const failedChecks = res.checks.filter((k) => !k.passed).map((k) => k.detail);
  add(
    'venue_verified',
    'blocker',
    res.status === 'verified',
    res.status === 'verified'
      ? `verified from ${res.venue!.evidence.length} evidence record(s); ${res.source}`
      : `${res.status}: ${[...res.reasons, ...failedChecks].join('; ') || 'not resolved'}`,
  );
  add('in_metro_manila', 'blocker', res.status === 'verified', res.status === 'verified' ? 'verified venue is inside Metro Manila' : res.status === 'out_of_scope' ? 'outside Metro Manila' : 'no verified location');

  add('start_time_known', 'warning', Boolean(c.startTime), c.startTime ?? 'start time not announced');
  add('artists_known', 'warning', c.artists.length > 0, c.artists.length ? c.artists.join(', ') : 'no artists extracted');
  add('ticket_info_known', 'warning', Boolean(c.ticketPrice || c.ticketUrl), c.ticketUrl ?? (c.ticketPrice ? 'price stated' : 'no ticket info'));
  add('name_is_official', 'warning', c.nameQuality === 'explicit', c.nameQuality === 'explicit' ? 'official title found in the post' : `name is ${c.nameQuality ?? 'missing'}, not an official title`);
  add('extractor_is_ai', 'warning', opts.extractor.kind === 'ai', `extractor kind: ${opts.extractor.kind}`);

  let rejectWhy: string | null = null;
  if (item.classification === 'past_event_recap' || item.classification === 'unrelated') rejectWhy = `${item.classification} post`;
  else if (c.sourceOrigin === 'synthetic') rejectWhy = 'synthetic test data';
  else if (past) rejectWhy = 'event already over';
  return finish(item, checks, venue, policy, rejectWhy);
}

/**
 * Evaluates a batch and merges posts that announce the same event: the earliest post stays
 * primary, later ones are rejected as duplicates and listed in `mergedSourcePostIds` so
 * every original Instagram source is preserved.
 */
export function evaluateBatch(items: IngestItem[], opts: EvaluateOptions): PublishingDecision[] {
  const decisions = items.map((i) => evaluatePublishing(i, opts));
  const groups = new Map<string, number[]>();
  items.forEach((it, idx) => {
    const key = it.candidate && eventKey(it.candidate);
    if (key && decisions[idx].decision !== 'reject') groups.set(key, [...(groups.get(key) ?? []), idx]);
  });
  for (const idxs of groups.values()) {
    if (idxs.length < 2) continue;
    idxs.sort((a, b) => items[a].candidate!.sourcePostedAt.localeCompare(items[b].candidate!.sourcePostedAt));
    const [primary, ...rest] = idxs;
    for (const i of rest) {
      decisions[primary].mergedSourcePostIds.push(items[i].postId);
      decisions[i] = {
        ...decisions[i],
        decision: 'reject',
        action: 'reject',
        summary: `rejected: duplicate of ${items[primary].postId} (source kept on the primary)`,
        checks: [...decisions[i].checks, { id: 'not_duplicate', severity: 'blocker', passed: false, detail: `same event as ${items[primary].postId}` }],
      };
    }
  }
  return decisions;
}

/** Counts for monitoring: events per decision and which blockers hold the most back. */
export function summarize(decisions: PublishingDecision[]) {
  const byDecision = { eligible: 0, hold: 0, reject: 0 };
  const blockerCounts: Record<string, number> = {};
  for (const d of decisions) {
    byDecision[d.decision]++;
    if (d.decision === 'hold') for (const b of d.blockers) blockerCounts[b] = (blockerCounts[b] ?? 0) + 1;
  }
  return { total: decisions.length, ...byDecision, topBlockers: Object.entries(blockerCounts).sort((a, b) => b[1] - a[1]) };
}
