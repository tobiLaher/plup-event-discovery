// Venue search providers. The pipeline only talks to this interface, so a hosted geocoder
// (see VENUE-PROVIDERS.md) or an offline dataset can be added without touching verification.
import { normalizeVenueName } from './venue-names.ts';
import { METRO_MANILA_BBOX } from './venues.ts';

export type PlaceCandidate = {
  placeId: string;
  name: string;
  city: string | null;
  address: string | null;
  latitude: number;
  longitude: number;
};

export type SearchQuery = { name: string; city?: string };

export interface VenueSearchProvider {
  readonly id: string;
  /** Underlying data origin, used to count independent evidence. */
  readonly dataset: string;
  /** False for endpoints whose terms forbid unattended production use (e.g. the public Nominatim). */
  readonly productionSafe: boolean;
  /** True for test fixtures. Their evidence is flagged and never verifies real venues. */
  readonly simulated: boolean;
  search(q: SearchQuery): Promise<PlaceCandidate[]>;
}

/** TEST FIXTURE provider: answers from a table. Everything it returns is simulated. */
export class FixtureProvider implements VenueSearchProvider {
  readonly productionSafe = true;
  readonly simulated = true;
  calls = 0;
  readonly id: string;
  readonly dataset: string;
  private readonly table: Map<string, PlaceCandidate[]>;

  constructor(id: string, dataset: string, table: Record<string, PlaceCandidate[]>) {
    this.id = id;
    this.dataset = dataset;
    this.table = new Map(Object.entries(table).map(([k, v]) => [normalizeVenueName(k), v]));
  }
  async search(q: SearchQuery) {
    this.calls++;
    return this.table.get(normalizeVenueName(q.name)) ?? [];
  }
}

type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

type NominatimItem = {
  osm_type?: string;
  osm_id?: number;
  name?: string;
  lat: string;
  lon: string;
  display_name?: string;
  address?: Record<string, string>;
};

/**
 * Development adapter for the public OpenStreetMap Nominatim API. Its policy allows 1 request/s
 * for light, user-driven use and discourages background/bulk use, so it is `productionSafe: false`
 * and the resolver skips it in production. A real User-Agent identifying the app is required.
 */
export class NominatimProvider implements VenueSearchProvider {
  readonly id = 'nominatim';
  readonly dataset = 'osm';
  readonly productionSafe = false;
  readonly simulated = false;
  private last = 0;
  private readonly baseUrl: string;
  private readonly userAgent: string;
  private readonly fetchImpl: FetchLike;
  private readonly minIntervalMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly clock: () => number;

  constructor(opts: { userAgent: string; baseUrl?: string; fetchImpl?: FetchLike; minIntervalMs?: number; sleep?: (ms: number) => Promise<void>; clock?: () => number }) {
    if (!opts.userAgent || opts.userAgent.length < 10) throw new Error('Nominatim requires a User-Agent that identifies the app');
    this.userAgent = opts.userAgent;
    this.baseUrl = opts.baseUrl ?? 'https://nominatim.openstreetmap.org';
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.minIntervalMs = opts.minIntervalMs ?? 1100;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.clock = opts.clock ?? Date.now;
  }

  async search(q: SearchQuery): Promise<PlaceCandidate[]> {
    const wait = this.last + this.minIntervalMs - this.clock();
    if (wait > 0) await this.sleep(wait);
    this.last = this.clock();
    const b = METRO_MANILA_BBOX;
    const params = new URLSearchParams({
      q: q.city ? `${q.name}, ${q.city}` : q.name,
      format: 'jsonv2',
      addressdetails: '1',
      limit: '5',
      countrycodes: 'ph',
      viewbox: `${b.west},${b.north},${b.east},${b.south}`,
      bounded: '1',
    });
    const res = await this.fetchImpl(`${this.baseUrl}/search?${params}`, { headers: { 'User-Agent': this.userAgent, Accept: 'application/json' } });
    if (!res.ok) throw new Error(`nominatim HTTP ${res.status}`);
    const items = (await res.json()) as NominatimItem[];
    return items.map((i) => {
      const a = i.address ?? {};
      const city = a.city ?? a.town ?? a.municipality ?? a.county ?? a.state_district ?? null;
      return {
        placeId: `${i.osm_type ?? 'osm'}/${i.osm_id ?? i.lat + ',' + i.lon}`,
        name: i.name ?? '',
        city,
        address: i.display_name ?? null,
        latitude: Number(i.lat),
        longitude: Number(i.lon),
      };
    });
  }
}
