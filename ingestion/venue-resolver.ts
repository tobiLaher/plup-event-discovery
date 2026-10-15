// Resolves a venue name to a canonical, verified venue: registry first, then providers, then
// verification. Verified results are stored (so each venue is looked up once); failures are
// remembered for a while so the same unknown name isn't searched repeatedly.
import { normalizeVenueName } from './venue-names.ts';
import { SEED_VENUES, venueAnswersTo, type CanonicalVenue, type LookupAttempt, type VenueCheck, type VenueEvidence, type VenueStore } from './venue-registry.ts';
import type { PlaceCandidate, VenueSearchProvider } from './venue-search.ts';
import { DEFAULT_VERIFY_POLICY, verifyEvidence, type VerifyPolicy } from './venue-verify.ts';
import { distanceM, VENUE_AGREEMENT_M } from './venues.ts';
import type { IngestItem } from './types.ts';

export type VenueResolution = {
  status: 'verified' | 'held' | 'out_of_scope';
  venue: CanonicalVenue | null;
  reasons: string[];
  checks: VenueCheck[];
  /** registry = already verified and stored; lookup = providers were queried; recent_attempt = a recent failure was reused. */
  source: 'registry' | 'lookup' | 'recent_attempt' | 'none';
  providerCalls: number;
};

export type VenueLookup = (name: string | null) => VenueResolution;

export type ResolverOptions = {
  store: VenueStore;
  providers?: VenueSearchProvider[];
  /** In production, providers that are not productionSafe are never called. */
  environment?: 'development' | 'production';
  verifyPolicy?: VerifyPolicy;
  /** How long a failed lookup is remembered. */
  negativeTtlMs?: number;
  clock?: () => Date;
};

const held = (reasons: string[], source: VenueResolution['source'], checks: VenueCheck[] = [], providerCalls = 0): VenueResolution => ({
  status: 'held', venue: null, reasons, checks, source, providerCalls,
});

const slug = (s: string) => normalizeVenueName(s).replace(/ /g, '-');

export class VenueResolver {
  private readonly o: Required<Omit<ResolverOptions, 'providers'>> & { providers: VenueSearchProvider[] };

  constructor(opts: ResolverOptions) {
    this.o = {
      providers: [],
      environment: 'development',
      verifyPolicy: DEFAULT_VERIFY_POLICY,
      negativeTtlMs: 24 * 3_600_000,
      clock: () => new Date(),
      ...opts,
    };
  }

  async resolve(rawName: string | null, ctx: { city?: string } = {}): Promise<VenueResolution> {
    const key = normalizeVenueName(rawName);
    if (!key) return held(['no_name'], 'none');
    const { store, verifyPolicy } = this.o;
    const now = this.o.clock().toISOString();

    // 1. Registry: cached verified venues. Re-verify the stored evidence so bad data can't linger.
    const venues = await store.listVenues();
    const matches = venues.filter((v) => venueAnswersTo(v, rawName!));
    if (matches.length > 1) return held(['ambiguous_name'], 'registry');
    if (matches.length === 1) {
      const again = verifyEvidence(matches[0].name, matches[0].evidence, verifyPolicy);
      return again.status === 'verified'
        ? { status: 'verified', venue: matches[0], reasons: [], checks: again.checks, source: 'registry', providerCalls: 0 }
        : held(['stored_evidence_no_longer_valid', ...again.checks.filter((c) => !c.passed).map((c) => c.id)], 'registry', again.checks);
    }

    // 2. Recent failed lookup: don't ask the providers again yet.
    const prior = await store.getAttempt(key);
    if (prior && Date.parse(now) - Date.parse(prior.at) < this.o.negativeTtlMs) {
      return { ...held(['recent_failed_lookup', ...prior.reasons], 'recent_attempt'), status: prior.status };
    }

    // 3. Providers.
    const usable = this.o.providers.filter((p) => this.o.environment !== 'production' || p.productionSafe);
    if (!usable.length) return held(['no_usable_provider'], 'none');
    const evidence: VenueEvidence[] = [];
    const errors: string[] = [];
    let calls = 0;
    for (const p of usable) {
      calls++;
      try {
        const found = await p.search({ name: rawName!, city: ctx.city });
        for (const c of found) {
          // Only exact-name candidates count. A neighbouring place with another name is ignored.
          if (normalizeVenueName(c.name) !== key) continue;
          evidence.push(toEvidence(p, c, now));
        }
      } catch (e) {
        errors.push(`${p.id}: ${(e as Error).message}`);
      }
    }

    const verdict = verifyEvidence(rawName!, evidence, verifyPolicy);
    if (verdict.status !== 'verified') {
      const reasons = [...verdict.reasons, ...errors.map(() => 'provider_error')];
      // Provider outages are not remembered as failures; only real "not verified" answers are.
      if (!errors.length) await store.putAttempt({ key, at: now, status: verdict.status, reasons } satisfies LookupAttempt);
      return { status: verdict.status, venue: null, reasons, checks: verdict.checks, source: 'lookup', providerCalls: calls };
    }

    // 4. Verified: same provider place id = same physical venue (add an alias); otherwise a new record.
    const refs = evidence.filter((e) => e.placeId).map((e) => ({ provider: e.provider, placeId: e.placeId! }));
    const same = venues.find((v) => v.providerRefs.some((r) => refs.some((x) => x.provider === r.provider && x.placeId === r.placeId)));
    let venue: CanonicalVenue;
    if (same) {
      venue = {
        ...same,
        aliases: same.aliases.some((a) => normalizeVenueName(a) === key) || same.key === key ? same.aliases : [...same.aliases, rawName!],
        evidence: [...same.evidence, ...evidence.filter((e) => !same.evidence.some((x) => x.provider === e.provider && x.placeId === e.placeId))],
      };
    } else {
      let id = slug(rawName!);
      if (venues.some((v) => v.id === id)) id = `${id}-${refs[0]?.placeId.replace(/[^a-z0-9]+/gi, '') ?? venues.length}`;
      venue = {
        id,
        name: rawName!.trim(),
        key,
        aliases: [],
        kind: 'venue',
        parentId: null,
        address: { street: null, area: null, city: verdict.city },
        latitude: verdict.latitude,
        longitude: verdict.longitude,
        providerRefs: refs,
        evidence,
        verification: { status: 'verified', verifiedAt: now, checks: verdict.checks },
      };
    }
    await store.putVenue(venue);
    return { status: 'verified', venue, reasons: [], checks: verdict.checks, source: 'lookup', providerCalls: calls };
  }

  /** Other stored venues within the agreement radius. Informational only: they are never merged. */
  async nearby(v: CanonicalVenue): Promise<CanonicalVenue[]> {
    return (await this.o.store.listVenues()).filter((o) => o.id !== v.id && distanceM(o, v) <= VENUE_AGREEMENT_M);
  }
}

function toEvidence(p: VenueSearchProvider, c: PlaceCandidate, at: string): VenueEvidence {
  return {
    provider: p.id, dataset: p.dataset, supports: 'identity', placeId: c.placeId, name: c.name, city: c.city,
    address: c.address, latitude: c.latitude, longitude: c.longitude, retrievedAt: at, ...(p.simulated ? { simulated: true } : {}),
  };
}

/** Synchronous lookup over venues already in memory (the registry seed by default). */
export function lookupFromVenues(venues: CanonicalVenue[] = SEED_VENUES, policy: VerifyPolicy = DEFAULT_VERIFY_POLICY): VenueLookup {
  return (name) => {
    if (!normalizeVenueName(name)) return held(['no_name'], 'none');
    const m = venues.filter((v) => venueAnswersTo(v, name!));
    if (m.length > 1) return held(['ambiguous_name'], 'registry');
    if (m.length === 0) return held(['not_in_registry'], 'none');
    const again = verifyEvidence(m[0].name, m[0].evidence, policy);
    return again.status === 'verified'
      ? { status: 'verified', venue: m[0], reasons: [], checks: again.checks, source: 'registry', providerCalls: 0 }
      : held(['stored_evidence_no_longer_valid'], 'registry', again.checks);
  };
}

/** Resolves every venue named by the batch (using the cache first), then returns a sync lookup for publishing checks. */
export async function resolveVenuesForItems(items: IngestItem[], resolver: VenueResolver): Promise<VenueLookup> {
  const results = new Map<string, VenueResolution>();
  for (const it of items) {
    const name = it.candidate?.venueName ?? null;
    const key = normalizeVenueName(name);
    if (key && !results.has(key)) results.set(key, await resolver.resolve(name));
  }
  return (name) => {
    const key = normalizeVenueName(name);
    return (key && results.get(key)) || held(['not_resolved'], 'none');
  };
}
