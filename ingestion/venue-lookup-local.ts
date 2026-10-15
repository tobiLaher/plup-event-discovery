// DEVELOPMENT ONLY. Looks up a few venue names on the public OpenStreetMap Nominatim API, one
// request at a time, at most 1 per 1.1 s, to see what real providers return. This is a manual
// check, not a production path: the resolver skips this provider when environment=production.
// Output goes to the git-ignored ingestion/local/venue-lookups.json.
// Usage: node ingestion/venue-lookup-local.ts "Venue One" "Venue Two" ...
import { mkdirSync, writeFileSync } from 'node:fs';
import { MemoryVenueStore } from './venue-registry.ts';
import { VenueResolver } from './venue-resolver.ts';
import { NominatimProvider, type PlaceCandidate, type VenueSearchProvider } from './venue-search.ts';

const names = process.argv.slice(2);
if (!names.length) throw new Error('give at least one venue name');

const nominatim = new NominatimProvider({ userAgent: 'PLUP-event-discovery-dev/0.1 (local development lookups, non-commercial)' });
const seen = new Map<string, PlaceCandidate[]>();
const recording: VenueSearchProvider = {
  id: nominatim.id, dataset: nominatim.dataset, productionSafe: nominatim.productionSafe, simulated: nominatim.simulated,
  async search(q) {
    const found = await nominatim.search(q);
    seen.set(q.name, found);
    return found;
  },
};

const resolver = new VenueResolver({ store: new MemoryVenueStore(), providers: [recording], environment: 'development' });
const out = [];
for (const name of names) {
  const res = await resolver.resolve(name);
  const candidates = seen.get(name) ?? [];
  out.push({ name, status: res.status, reasons: res.reasons, failedChecks: res.checks.filter((c) => !c.passed).map((c) => `${c.id}: ${c.detail}`), candidates });
  console.log(`${name}\n  -> ${res.status} [${res.reasons.join(', ') || 'ok'}]; provider returned ${candidates.length} candidate(s): ${candidates.map((c) => `"${c.name}"`).join(', ') || 'none'}`);
}
mkdirSync('ingestion/local', { recursive: true });
writeFileSync('ingestion/local/venue-lookups.json', JSON.stringify({ retrievedAt: new Date().toISOString(), provider: 'nominatim (OSM), public endpoint, dev only', results: out }, null, 2));
