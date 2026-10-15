// Canonical venue records, their evidence, and the storage interface behind them.
// Only verified venues are stored as venues. Failed lookups are remembered separately so the
// same unknown name isn't searched again and again. Supabase can implement VenueStore later.
import { normalizeVenueName } from './venue-names.ts';

/**
 * One piece of supporting information about a venue.
 *  identity: a place record whose name matches the venue name exactly (after normalization)
 *  location: coordinates only (e.g. a Plus Code); says where, not what
 *  parent:   the larger complex containing the venue
 */
export type VenueEvidence = {
  provider: string;
  /** Underlying data origin. Providers built on the same dataset (e.g. OSM) count as ONE. */
  dataset: string;
  supports: 'identity' | 'location' | 'parent';
  placeId: string | null;
  name: string | null;
  city: string | null;
  address: string | null;
  latitude: number;
  longitude: number;
  retrievedAt: string;
  url?: string;
  /** True for test fixtures. Never accepted as verification unless explicitly allowed. */
  simulated?: boolean;
};

export type VenueCheckId =
  | 'identity_match' | 'unambiguous' | 'independent_datasets' | 'coordinates_consistent'
  | 'address_present' | 'metro_manila' | 'real_evidence';

export type VenueCheck = { id: VenueCheckId; passed: boolean; detail: string };

export type CanonicalVenue = {
  id: string;
  name: string;
  /** Normalized comparison key of `name`. */
  key: string;
  /** Other spellings seen in posts. Added only when a provider id or an exact key says it is the same venue. */
  aliases: string[];
  kind: 'venue' | 'room' | 'complex';
  parentId: string | null;
  address: { street: string | null; area: string | null; city: string };
  latitude: number;
  longitude: number;
  providerRefs: { provider: string; placeId: string }[];
  evidence: VenueEvidence[];
  verification: { status: 'verified'; verifiedAt: string; checks: VenueCheck[] };
};

export type LookupAttempt = {
  key: string;
  at: string;
  status: 'held' | 'out_of_scope';
  reasons: string[];
};

export interface VenueStore {
  listVenues(): Promise<CanonicalVenue[]>;
  putVenue(v: CanonicalVenue): Promise<void>;
  getAttempt(key: string): Promise<LookupAttempt | null>;
  putAttempt(a: LookupAttempt): Promise<void>;
}

export class MemoryVenueStore implements VenueStore {
  private venues = new Map<string, CanonicalVenue>();
  private attempts = new Map<string, LookupAttempt>();

  constructor(seed: CanonicalVenue[] = []) {
    for (const v of seed) this.venues.set(v.id, v);
  }
  async listVenues() {
    return [...this.venues.values()];
  }
  async putVenue(v: CanonicalVenue) {
    this.venues.set(v.id, v);
  }
  async getAttempt(key: string) {
    return this.attempts.get(key) ?? null;
  }
  async putAttempt(a: LookupAttempt) {
    this.attempts.set(a.key, a);
  }
}

/** Does this record answer to the given raw name? Exact normalized match on name or alias only. */
export function venueAnswersTo(v: CanonicalVenue, rawName: string): boolean {
  const k = normalizeVenueName(rawName);
  return k !== '' && (v.key === k || v.aliases.some((a) => normalizeVenueName(a) === k));
}

/**
 * PICC Plenary Hall: our first verified venue. Evidence: a named place record (Waze), a
 * coordinate-only Plus Code (HX4M+587), and the PICC complex point from Wikipedia as a parent.
 */
export const SEED_VENUES: CanonicalVenue[] = [
  {
    id: 'picc-plenary-hall',
    name: 'PICC Plenary Hall',
    key: normalizeVenueName('PICC Plenary Hall'),
    aliases: ['Philippine International Convention Center Plenary Hall'],
    kind: 'room',
    parentId: null,
    address: { street: 'Vicente Sotto Street', area: null, city: 'Pasay' },
    latitude: 14.5554,
    longitude: 120.9833,
    providerRefs: [{ provider: 'waze', placeId: 'ChIJaVWwctnLlzMRcjSCv-quWaA' }],
    evidence: [
      {
        provider: 'waze', dataset: 'waze', supports: 'identity', placeId: 'ChIJaVWwctnLlzMRcjSCv-quWaA',
        name: 'PICC Plenary Hall', city: 'Pasay', address: 'Vicente Sotto Street, Pasay', latitude: 14.5554064, longitude: 120.9832962,
        retrievedAt: '2026-10-14T00:00:00Z', url: 'https://www.waze.com/live-map/directions/ph/ncr/pasay-city/picc-plenary-hall',
      },
      {
        provider: 'google-plus-code', dataset: 'google-plus-codes', supports: 'location', placeId: 'HX4M+587',
        name: null, city: null, address: null, latitude: 14.55544, longitude: 120.98331, retrievedAt: '2026-10-14T00:00:00Z',
      },
      {
        provider: 'wikipedia', dataset: 'wikipedia', supports: 'parent', placeId: null,
        name: 'Philippine International Convention Center', city: 'Pasay', address: null, latitude: 14.5543, longitude: 120.9826,
        retrievedAt: '2026-10-14T00:00:00Z', url: 'https://en.wikipedia.org/wiki/Philippine_International_Convention_Center',
      },
    ],
    verification: { status: 'verified', verifiedAt: '2026-10-14T00:00:00Z', checks: [] },
  },
];
