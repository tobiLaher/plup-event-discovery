/// <reference types="node" />
// Run: npm run ingest:test
//
// TEST FIXTURES: every venue below is FICTIONAL and its coordinates are arbitrary points inside
// Metro Manila (or, for the out-of-scope case, near Baguio). The "providers" are in-memory
// fixtures whose answers are SIMULATED. None of this is externally verified data, and
// simulated evidence is only accepted here because the tests pass allowSimulated: true.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ingest } from './pipeline.ts';
import { DEFAULT_POLICY, evaluateBatch, evaluatePublishing, type PublishingPolicy } from './publishing.ts';
import { SimulatedExtractor } from './simulated-extractor.ts';
import type { ExtractedFields, InstagramPost } from './types.ts';
import { hasRoomQualifier, isMetroManilaCity, normalizeCity, normalizeVenueName } from './venue-names.ts';
import { MemoryVenueStore, SEED_VENUES } from './venue-registry.ts';
import { resolveVenuesForItems, lookupFromVenues, VenueResolver } from './venue-resolver.ts';
import { FixtureProvider, NominatimProvider, type PlaceCandidate } from './venue-search.ts';
import { DEFAULT_VERIFY_POLICY, verifyEvidence } from './venue-verify.ts';
import { distanceM } from './venues.ts';

const T0 = '2026-10-14T04:00:00Z';
const T0_ISO = new Date(T0).toISOString(); // timestamps are stored in full ISO form
const SIM = { ...DEFAULT_VERIFY_POLICY, allowSimulated: true };

const place = (placeId: string, name: string, city: string | null, latitude: number, longitude: number): PlaceCandidate => ({
  placeId, name, city, address: city ? `${name}, ${city}` : null, latitude, longitude,
});
const fixtureA = (table: Record<string, PlaceCandidate[]>) => new FixtureProvider('fixture-a', 'fixture-dataset-a', table);
const fixtureB = (table: Record<string, PlaceCandidate[]>) => new FixtureProvider('fixture-b', 'fixture-dataset-b', table);
const osmLike = (table: Record<string, PlaceCandidate[]>) => new FixtureProvider('fixture-osm-2', 'fixture-dataset-a', table); // same dataset as fixtureA
const resolver = (providers: FixtureProvider[], extra: Partial<ConstructorParameters<typeof VenueResolver>[0]> = {}, store = new MemoryVenueStore()) =>
  new VenueResolver({ store, providers, verifyPolicy: SIM, clock: () => new Date(T0), ...extra });

// ---- normalization

test('name variations normalize to one key; different rooms do not', () => {
  const same = ['The Test Hall', 'TEST HALL', 'test-hall!', 'Tést Hall', '  Test   Hall  '];
  assert.equal(new Set(same.map(normalizeVenueName)).size, 1);
  assert.equal(normalizeVenueName('Fil-Oil Flying V Centre'), normalizeVenueName('Fil Oil Flying V Center'));
  assert.equal(normalizeVenueName('S.M. Test Arena'), normalizeVenueName('SM Test Arena'));
  assert.equal(normalizeVenueName('Cafe & Stage'), normalizeVenueName('Cafe and Stage'));
  assert.equal(normalizeVenueName('Test Theatre'), normalizeVenueName('Test Theater'));
  // Similar names are NOT merged.
  assert.notEqual(normalizeVenueName('PICC Plenary Hall'), normalizeVenueName('PICC Forum'));
  assert.notEqual(normalizeVenueName('PICC Plenary Hall'), normalizeVenueName('Plenary Hall'));
  assert.notEqual(normalizeVenueName('PICC'), normalizeVenueName('PICC Plenary Hall'));
  assert.ok(hasRoomQualifier(normalizeVenueName('PICC Plenary Hall')));
  assert.equal(hasRoomQualifier(normalizeVenueName('Example Cafe')), false);
});

test('city names normalize and Metro Manila membership is exact', () => {
  assert.equal(normalizeCity('City of Manila'), 'manila');
  assert.equal(normalizeCity('Quezon City'), 'quezon');
  assert.equal(normalizeCity('Parañaque'), 'paranaque');
  assert.ok(isMetroManilaCity('Pasay City') && isMetroManilaCity('Makati'));
  assert.equal(isMetroManilaCity('Baguio'), false);
  assert.equal(isMetroManilaCity(null), false);
});

// ---- registry seed

test('the seeded PICC Plenary Hall record still verifies from its own evidence, with no lookups', async () => {
  const picc = SEED_VENUES[0];
  assert.equal(verifyEvidence(picc.name, picc.evidence).status, 'verified');
  const p = fixtureA({});
  const r = resolver([p], {}, new MemoryVenueStore(SEED_VENUES));
  const res = await r.resolve('Philippine International Convention Center Plenary Hall');
  assert.equal(res.status, 'verified');
  assert.equal(res.venue?.id, 'picc-plenary-hall');
  assert.equal(res.source, 'registry');
  assert.equal(p.calls, 0);
});

// ---- verification

test('a new venue verifies when two independent datasets name it and agree; evidence and time are preserved', async () => {
  const a = fixtureA({ 'Test Hall': [place('a1', 'Test Hall', 'Makati', 14.56, 121.0)] });
  const b = fixtureB({ 'Test Hall': [place('b1', 'Test Hall', 'Makati City', 14.5601, 121.0001)] });
  const res = await resolver([a, b]).resolve('Test Hall');
  assert.equal(res.status, 'verified');
  assert.equal(res.venue?.evidence.length, 2);
  assert.ok(res.venue?.evidence.every((e) => e.simulated === true && e.retrievedAt === T0_ISO));
  assert.equal(res.venue?.verification.verifiedAt, T0_ISO);
  assert.deepEqual(res.venue?.providerRefs.map((x) => x.placeId).sort(), ['a1', 'b1']);
  assert.ok(res.checks.every((c) => c.passed));
});

test('simulated evidence never verifies anything under the default (real) policy', async () => {
  const a = fixtureA({ 'Test Hall': [place('a1', 'Test Hall', 'Makati', 14.56, 121.0)] });
  const b = fixtureB({ 'Test Hall': [place('b1', 'Test Hall', 'Makati', 14.56, 121.0)] });
  const res = await resolver([a, b], { verifyPolicy: DEFAULT_VERIFY_POLICY }).resolve('Test Hall');
  assert.equal(res.status, 'held');
  assert.ok(res.reasons.includes('simulated_evidence_only'));
});

test('one dataset is not enough, even from two providers built on the same data', async () => {
  const a = fixtureA({ 'Test Hall': [place('a1', 'Test Hall', 'Makati', 14.56, 121.0)] });
  const a2 = osmLike({ 'Test Hall': [place('a2', 'Test Hall', 'Makati', 14.56, 121.0)] });
  const res = await resolver([a, a2]).resolve('Test Hall');
  assert.equal(res.status, 'held');
  assert.ok(res.reasons.includes('single_dataset'));
  assert.equal((await new MemoryVenueStore().listVenues()).length, 0);
});

test('a place with a different name is not identity evidence, even at the same coordinates', async () => {
  const a = fixtureA({ 'Test Hall': [place('a1', 'Test Hall', 'Makati', 14.56, 121.0)] });
  const b = fixtureB({ 'Test Hall': [place('b9', 'Next Door Cafe', 'Makati', 14.56, 121.0)] }); // same spot, other venue
  const res = await resolver([a, b]).resolve('Test Hall');
  assert.equal(res.status, 'held');
  assert.ok(res.reasons.includes('single_dataset')); // the neighbour's record was ignored
});

test('conflicting coordinates between datasets are held', async () => {
  const a = fixtureA({ 'Test Hall': [place('a1', 'Test Hall', 'Makati', 14.56, 121.0)] });
  const b = fixtureB({ 'Test Hall': [place('b1', 'Test Hall', 'Makati', 14.58, 121.02)] }); // ~3 km away
  const res = await resolver([a, b]).resolve('Test Hall');
  assert.equal(res.status, 'held');
  assert.ok(distanceM({ latitude: 14.56, longitude: 121.0 }, { latitude: 14.58, longitude: 121.02 }) > 300);
  assert.ok(res.reasons.some((r) => r === 'conflicting_coordinates' || r === 'ambiguous_name'));
});

test('an ambiguous name (same name, different cities) is held, never guessed', async () => {
  const a = fixtureA({ 'Music Hall': [place('a1', 'Music Hall', 'Makati', 14.56, 121.0), place('a2', 'Music Hall', 'Quezon City', 14.65, 121.04)] });
  const b = fixtureB({ 'Music Hall': [place('b1', 'Music Hall', 'Makati', 14.56, 121.0)] });
  const res = await resolver([a, b]).resolve('Music Hall');
  assert.equal(res.status, 'held');
  assert.deepEqual(res.reasons, ['ambiguous_name']);
  assert.equal(res.venue, null);
});

test('two registry records answering to the same name are ambiguous', async () => {
  const [picc] = SEED_VENUES;
  const twin = { ...picc, id: 'picc-plenary-hall-2', latitude: 14.6, longitude: 121.05 };
  const res = await resolver([], {}, new MemoryVenueStore([picc, twin])).resolve('PICC Plenary Hall');
  assert.equal(res.status, 'held');
  assert.deepEqual(res.reasons, ['ambiguous_name']);
});

test('a missing address (no city) is held', async () => {
  const a = fixtureA({ 'Test Hall': [place('a1', 'Test Hall', null, 14.56, 121.0)] });
  const b = fixtureB({ 'Test Hall': [place('b1', 'Test Hall', null, 14.56, 121.0)] });
  const res = await resolver([a, b]).resolve('Test Hall');
  assert.equal(res.status, 'held');
  assert.deepEqual(res.reasons, ['missing_address']);
});

test('venues outside Metro Manila are out of scope and nothing is stored', async () => {
  const a = fixtureA({ 'Far Hall': [place('a1', 'Far Hall', 'Baguio', 16.41, 120.6)] });
  const b = fixtureB({ 'Far Hall': [place('b1', 'Far Hall', 'Baguio', 16.41, 120.6)] });
  const store = new MemoryVenueStore();
  const res = await resolver([a, b], {}, store).resolve('Far Hall');
  assert.equal(res.status, 'out_of_scope');
  assert.equal(res.venue, null);
  assert.equal((await store.listVenues()).length, 0);
  // Right city name but coordinates outside the area is also out of scope.
  const c = fixtureA({ 'Odd Hall': [place('c1', 'Odd Hall', 'Makati', 16.41, 120.6)] });
  const d = fixtureB({ 'Odd Hall': [place('d1', 'Odd Hall', 'Makati', 16.41, 120.6)] });
  assert.equal((await resolver([c, d]).resolve('Odd Hall')).status, 'out_of_scope');
});

// ---- identity: aliases and nearby venues

test('alternate names for one physical venue merge only through a shared provider place id', async () => {
  const a = fixtureA({
    'Test Arena': [place('a1', 'Test Arena', 'Pasay', 14.54, 120.98)],
    'Old Arena Name': [place('a1', 'Old Arena Name', 'Pasay', 14.54, 120.98)], // same place id, former name
  });
  const b = fixtureB({
    'Test Arena': [place('b1', 'Test Arena', 'Pasay', 14.54, 120.98)],
    'Old Arena Name': [place('b1', 'Old Arena Name', 'Pasay', 14.54, 120.98)],
  });
  const store = new MemoryVenueStore();
  const r = resolver([a, b], {}, store);
  const first = await r.resolve('Test Arena');
  const second = await r.resolve('Old Arena Name');
  assert.equal(second.status, 'verified');
  assert.equal(second.venue?.id, first.venue?.id);
  assert.equal((await store.listVenues()).length, 1);
  assert.ok(second.venue?.aliases.includes('Old Arena Name'));
  // Spelling variants hit the cached record without any provider call.
  const calls = a.calls + b.calls;
  const third = await r.resolve('the OLD arena name!');
  assert.equal(third.venue?.id, first.venue?.id);
  assert.equal(a.calls + b.calls, calls);
});

test('two nearby but distinct venues stay separate records', async () => {
  const a = fixtureA({
    'Test Forum': [place('a1', 'Test Forum', 'Pasay', 14.5554, 120.9833)],
    'Test Plenary': [place('a2', 'Test Plenary', 'Pasay', 14.5556, 120.9834)], // ~25 m away
  });
  const b = fixtureB({
    'Test Forum': [place('b1', 'Test Forum', 'Pasay', 14.5554, 120.9833)],
    'Test Plenary': [place('b2', 'Test Plenary', 'Pasay', 14.5556, 120.9834)],
  });
  const store = new MemoryVenueStore();
  const r = resolver([a, b], {}, store);
  const forum = await r.resolve('Test Forum');
  const plenary = await r.resolve('Test Plenary');
  assert.equal(forum.status, 'verified');
  assert.equal(plenary.status, 'verified');
  assert.notEqual(forum.venue?.id, plenary.venue?.id);
  assert.equal((await store.listVenues()).length, 2);
  assert.ok(distanceM(forum.venue!, plenary.venue!) < 300);
  assert.deepEqual((await r.nearby(forum.venue!)).map((v) => v.id), [plenary.venue!.id]); // reported, never merged
  assert.deepEqual(plenary.venue?.aliases, []);
});

// ---- cache

test('a verified venue is looked up once; a failed lookup is not repeated until the TTL expires', async () => {
  const a = fixtureA({ 'Test Hall': [place('a1', 'Test Hall', 'Makati', 14.56, 121.0)] });
  const b = fixtureB({ 'Test Hall': [place('b1', 'Test Hall', 'Makati', 14.56, 121.0)] });
  const r = resolver([a, b]);
  await r.resolve('Test Hall');
  await r.resolve('Test Hall');
  await r.resolve('test hall');
  assert.equal(a.calls, 1);
  assert.equal(b.calls, 1);

  let now = Date.parse(T0);
  const c = fixtureA({});
  const d = fixtureB({});
  const r2 = new VenueResolver({ store: new MemoryVenueStore(), providers: [c, d], verifyPolicy: SIM, clock: () => new Date(now), negativeTtlMs: 3_600_000 });
  assert.deepEqual((await r2.resolve('Nowhere Hall')).reasons, ['not_found']);
  const again = await r2.resolve('Nowhere Hall');
  assert.equal(again.source, 'recent_attempt');
  assert.equal(c.calls, 1);
  now += 2 * 3_600_000;
  await r2.resolve('Nowhere Hall');
  assert.equal(c.calls, 2);
});

test('a provider outage is not cached as a failed lookup', async () => {
  const broken = { ...fixtureA({}), id: 'broken', dataset: 'x', productionSafe: true, simulated: true, search: async () => { throw new Error('HTTP 503'); } };
  const store = new MemoryVenueStore();
  const res = await new VenueResolver({ store, providers: [broken], verifyPolicy: SIM, clock: () => new Date(T0) }).resolve('Test Hall');
  assert.ok(res.reasons.includes('provider_error'));
  assert.equal(await store.getAttempt(normalizeVenueName('Test Hall')), null);
});

// ---- providers

test('providers that are not production-safe are skipped in production and used in development', async () => {
  const dev = new FixtureProvider('dev-only', 'fixture-dataset-a', { 'Test Hall': [place('a1', 'Test Hall', 'Makati', 14.56, 121.0)] });
  Object.defineProperty(dev, 'productionSafe', { value: false });
  const prod = await resolver([dev], { environment: 'production' }).resolve('Test Hall');
  assert.deepEqual(prod.reasons, ['no_usable_provider']);
  assert.equal(dev.calls, 0);
  await resolver([dev], { environment: 'development' }).resolve('Test Hall');
  assert.equal(dev.calls, 1);
});

test('Nominatim adapter: identifies the app, limits the area, maps the response and throttles to 1 request/s', async () => {
  const seen: { url: string; ua: string }[] = [];
  let t = 10_000;
  const slept: number[] = [];
  // CANNED response in Nominatim's documented jsonv2 shape. Simulated, not a real lookup.
  const canned = [{ osm_type: 'way', osm_id: 1, name: 'Test Hall', lat: '14.56', lon: '121.0', display_name: 'Test Hall, Makati', address: { city: 'City of Manila' } }];
  const p = new NominatimProvider({
    userAgent: 'PLUP-dev-tests/0.1 (contact: dev@example.invalid)',
    fetchImpl: async (url, init) => { seen.push({ url, ua: init.headers['User-Agent'] }); return { ok: true, status: 200, json: async () => canned }; },
    clock: () => t,
    sleep: async (ms) => { slept.push(ms); t += ms; },
  });
  const out = await p.search({ name: 'Test Hall' });
  await p.search({ name: 'Test Hall' });
  assert.equal(p.productionSafe, false);
  assert.match(seen[0].url, /countrycodes=ph/);
  assert.match(seen[0].url, /bounded=1/);
  assert.match(seen[0].ua, /^PLUP-dev-tests/);
  assert.deepEqual(out, [{ placeId: 'way/1', name: 'Test Hall', city: 'City of Manila', address: 'Test Hall, Makati', latitude: 14.56, longitude: 121.0 }]);
  assert.equal(slept.length, 1);
  assert.ok(slept[0] >= 1000);
  assert.throws(() => new NominatimProvider({ userAgent: 'x' }), /User-Agent/);
});

// ---- publishing integration

const GOOD: ExtractedFields = {
  name: 'Demo Show', nameQuality: 'derived', category: 'concert', date: '2026-11-20', endDate: '2026-11-20', startTime: '20:00',
  venueName: 'Test Hall', venueArea: null, artists: ['Demo Band'], genre: null, ticketPrice: null, ticketUrl: 'tickets.example.com/demo',
};
const post = (id: string): InstagramPost => ({ id, username: 'demo', caption: 'unused', timestamp: '2026-09-10T00:00:00Z', permalink: `https://example.invalid/${id}`, origin: 'instagram-business-discovery' });
const ON: PublishingPolicy = { ...DEFAULT_POLICY, unattendedPublishingEnabled: true };

async function decideFor(venueName: string, providers: FixtureProvider[], policy = DEFAULT_POLICY) {
  const extractor = new SimulatedExtractor({ e: { classification: 'upcoming_event', fields: { ...GOOD, venueName } } });
  const run = await ingest([post('e')], extractor, { now: T0 });
  const lookup = await resolveVenuesForItems(run.items, resolver(providers));
  return evaluateBatch(run.items, { now: T0, extractor: extractor.info, policy, venueLookup: lookup })[0];
}

test('a venue that resolves automatically makes an otherwise valid event eligible (still not published while disabled)', async () => {
  const a = fixtureA({ 'Test Hall': [place('a1', 'Test Hall', 'Makati', 14.56, 121.0)] });
  const b = fixtureB({ 'Test Hall': [place('b1', 'Test Hall', 'Makati', 14.56, 121.0)] });
  const d = await decideFor('Test Hall', [a, b]);
  assert.equal(d.decision, 'eligible');
  assert.equal(d.action, 'none');
  assert.equal(d.venue?.name, 'Test Hall');
  assert.equal((await decideFor('Test Hall', [a, b], ON)).action, 'publish');
});

test('unknown, ambiguous, conflicting and out-of-scope venues keep the event held', async () => {
  const none = await decideFor('Unknown Hall', [fixtureA({}), fixtureB({})]);
  assert.equal(none.decision, 'hold');
  assert.ok(none.blockers.includes('venue_verified'));

  const ambA = fixtureA({ 'Test Hall': [place('a1', 'Test Hall', 'Makati', 14.56, 121.0), place('a2', 'Test Hall', 'Pasig', 14.58, 121.06)] });
  const ambB = fixtureB({ 'Test Hall': [place('b1', 'Test Hall', 'Makati', 14.56, 121.0)] });
  assert.equal((await decideFor('Test Hall', [ambA, ambB], ON)).action, 'hold');

  const farA = fixtureA({ 'Test Hall': [place('a1', 'Test Hall', 'Baguio', 16.41, 120.6)] });
  const farB = fixtureB({ 'Test Hall': [place('b1', 'Test Hall', 'Baguio', 16.41, 120.6)] });
  const far = await decideFor('Test Hall', [farA, farB], ON);
  assert.equal(far.action, 'hold');
  assert.match(far.checks.find((c) => c.id === 'in_metro_manila')!.detail, /outside Metro Manila/);
});

test('an event is never published on simulated or single-source coordinates, even with the switch on', async () => {
  const onlyA = fixtureA({ 'Test Hall': [place('a1', 'Test Hall', 'Makati', 14.56, 121.0)] });
  const d = await decideFor('Test Hall', [onlyA], ON);
  assert.equal(d.action, 'hold');
  assert.equal(d.venue, null);
});

test('default lookup still resolves the seeded PICC Plenary Hall without any provider', () => {
  const res = lookupFromVenues()('PICC Plenary Hall');
  assert.equal(res.status, 'verified');
  assert.equal(res.venue?.id, 'picc-plenary-hall');
  assert.equal(lookupFromVenues()('PICC').status, 'held'); // the complex is a different place from the hall
  const d = evaluatePublishing(
    { postId: 'x', classification: 'upcoming_event', classificationNotes: [], reviewStatus: 'needs_review', reviewReasons: [], candidate: null },
    { now: T0, extractor: { name: 't', kind: 'simulated', usesImages: false } },
  );
  assert.equal(d.decision, 'reject');
});
