// Geometry helpers shared by venue verification. The registry, providers and verification
// live in venue-registry.ts, venue-search.ts, venue-verify.ts and venue-resolver.ts.

/** Evidence within this distance is *consistent* with a venue. It is never proof of identity. */
export const VENUE_AGREEMENT_M = 300;
/** A parent complex (e.g. the whole convention centre) may sit further from a hall inside it. */
export const PARENT_AGREEMENT_M = 500;
/** Rough Metro Manila bounding box (south, north, west, east). */
export const METRO_MANILA_BBOX = { south: 14.35, north: 14.8, west: 120.9, east: 121.2 };

export type LatLon = { latitude: number; longitude: number };

export function distanceM(a: LatLon, b: LatLon) {
  const R = 6_371_000;
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function inMetroManila(p: LatLon) {
  const b = METRO_MANILA_BBOX;
  return p.latitude >= b.south && p.latitude <= b.north && p.longitude >= b.west && p.longitude <= b.east;
}
