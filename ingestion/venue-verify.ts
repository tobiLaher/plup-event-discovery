// Automatic venue verification. A venue is verified only when independent evidence agrees on
// WHAT it is (the name) and WHERE it is, it is unambiguous, has a city address, and is in
// Metro Manila. Coordinates being close together is a consistency check, never proof that two
// records are the same venue: identity must come from the name or a provider id.
import { distanceM, inMetroManila, PARENT_AGREEMENT_M, VENUE_AGREEMENT_M } from './venues.ts';
import { isMetroManilaCity, normalizeCity, normalizeVenueName } from './venue-names.ts';
import type { VenueCheck, VenueEvidence } from './venue-registry.ts';

export type VerifyPolicy = {
  /** Distinct underlying datasets required. */
  minDatasets: number;
  agreementM: number;
  parentM: number;
  /** Test fixtures only. Real runs leave this false so simulated evidence never verifies anything. */
  allowSimulated: boolean;
};

export const DEFAULT_VERIFY_POLICY: VerifyPolicy = { minDatasets: 2, agreementM: VENUE_AGREEMENT_M, parentM: PARENT_AGREEMENT_M, allowSimulated: false };

export type HeldReason =
  | 'identity_unconfirmed' | 'ambiguous_name' | 'single_dataset' | 'conflicting_coordinates'
  | 'missing_address' | 'simulated_evidence_only' | 'not_found';

export type Verdict =
  | { status: 'verified'; latitude: number; longitude: number; city: string; address: string | null; checks: VenueCheck[]; identity: VenueEvidence[] }
  | { status: 'held'; reasons: HeldReason[]; checks: VenueCheck[] }
  | { status: 'out_of_scope'; reasons: ['outside_metro_manila']; checks: VenueCheck[] };

export function verifyEvidence(queryName: string, all: VenueEvidence[], policy: VerifyPolicy = DEFAULT_VERIFY_POLICY): Verdict {
  const checks: VenueCheck[] = [];
  const add = (id: VenueCheck['id'], passed: boolean, detail: string) => checks.push({ id, passed, detail });
  const key = normalizeVenueName(queryName);

  const usable = all.filter((e) => policy.allowSimulated || !e.simulated);
  add('real_evidence', usable.length > 0 || all.length === 0, all.length && !usable.length ? 'only simulated test evidence' : `${usable.length} evidence record(s)`);
  if (!usable.length) return { status: 'held', reasons: [all.length ? 'simulated_evidence_only' : 'not_found'], checks };

  // Identity: the name must match exactly. A near-by place with another name is not evidence.
  const identity = usable.filter((e) => e.supports === 'identity' && normalizeVenueName(e.name) === key);
  add('identity_match', identity.length > 0, identity.length ? `${identity.length} record(s) named "${identity[0].name}"` : 'no record with this exact name');
  if (!identity.length) return { status: 'held', reasons: ['identity_unconfirmed'], checks };

  // Ambiguity: the same name resolving to places far apart (or in different cities) is not one venue.
  const anchor = identity[0];
  const apart = identity.filter((e) => distanceM(anchor, e) > policy.agreementM);
  const cities = new Set(identity.map((e) => normalizeCity(e.city)).filter(Boolean));
  const ambiguous = apart.length > 0 && (cities.size > 1 || apart.some((e) => e.dataset === anchor.dataset));
  add('unambiguous', !ambiguous, ambiguous ? `name matches places ${Math.round(distanceM(anchor, apart[0]))} m apart` : 'single place');
  if (ambiguous) return { status: 'held', reasons: ['ambiguous_name'], checks };

  // Scope: Metro Manila only, for now.
  const city = identity.map((e) => e.city).find(Boolean) ?? null;
  const inScope = inMetroManila(anchor) && (city === null || isMetroManilaCity(city));
  add('metro_manila', inScope, inScope ? `${city ?? 'coordinates'} inside Metro Manila` : `${city ?? 'coordinates'} outside Metro Manila`);
  if (!inScope) return { status: 'out_of_scope', reasons: ['outside_metro_manila'], checks };

  // Address: a venue needs a city, not just a point.
  add('address_present', Boolean(city), city ? `city ${city}` : 'no city/address on any identity record');
  if (!city) return { status: 'held', reasons: ['missing_address'], checks };

  // Consistency: every piece of evidence must sit near the venue (parent complexes get more slack).
  const off = usable.find((e) => distanceM(anchor, e) > (e.supports === 'parent' ? policy.parentM : policy.agreementM));
  add('coordinates_consistent', !off, off ? `${off.provider} is ${Math.round(distanceM(anchor, off))} m away` : 'all evidence within range');
  if (off) return { status: 'held', reasons: ['conflicting_coordinates'], checks };

  // Independence: distinct underlying datasets, so two copies of OSM don't count twice.
  const datasets = new Set(usable.map((e) => e.dataset));
  add('independent_datasets', datasets.size >= policy.minDatasets, `${datasets.size} dataset(s): ${[...datasets].join(', ')} (need ${policy.minDatasets})`);
  if (datasets.size < policy.minDatasets) return { status: 'held', reasons: ['single_dataset'], checks };

  return {
    status: 'verified',
    latitude: round5(identity.reduce((s, e) => s + e.latitude, 0) / identity.length),
    longitude: round5(identity.reduce((s, e) => s + e.longitude, 0) / identity.length),
    city,
    address: identity.map((e) => e.address).find(Boolean) ?? null,
    checks,
    identity,
  };
}

const round5 = (n: number) => Math.round(n * 1e5) / 1e5;
