import type { Region } from 'react-native-maps';

import type { MockEvent } from '@/data/mock-events';

export type Coords = { latitude: number; longitude: number };

/** Applied/draft filters. Every field is optional; the neutral value means "no constraint". Add new filters here. */
export type Filters = {
  /** Chosen place; null means "around my current location" (only matters when a distance is set). */
  place: { label: string; coords: Coords } | null;
  /** Radius in km in 0.5 steps; 0 = any distance (no radius filter). */
  distanceKm: number;
  genre: string | null;
  /** Specific calendar date (YYYY-MM-DD, Manila); overrides the quick All/Tonight/Weekend chips. */
  date: string | null;
};

export const NO_FILTERS: Filters = { place: null, distanceKm: 0, genre: null, date: null };
export const MAX_DISTANCE_KM = 30;

export function roundKm(km: number) {
  return Math.round(km * 2) / 2;
}

export function formatKm(km: number) {
  return km <= 0 ? 'Any distance' : `${km} km`;
}

export function activeFilterCount(f: Filters) {
  return (f.place ? 1 : 0) + (f.genre ? 1 : 0) + (f.distanceKm > 0 ? 1 : 0) + (f.date ? 1 : 0);
}

export function sameFilters(a: Filters, b: Filters) {
  return (
    a.genre === b.genre &&
    a.date === b.date &&
    a.distanceKm === b.distanceKm &&
    a.place?.coords.latitude === b.place?.coords.latitude &&
    a.place?.coords.longitude === b.place?.coords.longitude
  );
}

export function haversineKm(a: Coords, b: Coords) {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/** Where distance is measured from: the chosen place, else the user's real position (may be null). */
export function filterCenter(f: Filters, user: Coords | null) {
  return f.place?.coords ?? user;
}

/** Genre, distance and calendar-date checks (quick date chips and text search live in the screen). */
export function matchesFilters(e: MockEvent, f: Filters, user: Coords | null) {
  if (f.genre && e.genre !== f.genre) return false;
  if (f.distanceKm > 0) {
    const center = filterCenter(f, user);
    // No center (e.g. location denied and no place chosen): don't enforce a radius.
    if (center) return haversineKm(center, e) <= f.distanceKm;
  }
  return true;
}

/**
 * Region that fits a circle inside the part of the screen not covered by `top` / `bottom` UI,
 * with the circle centered in that visible band.
 */
export function regionForCircle(
  center: Coords,
  radiusM: number,
  screen: { width: number; height: number },
  top: number,
  bottom: number,
): Region {
  const visibleH = Math.max(120, screen.height - top - bottom);
  const cos = Math.max(0.2, Math.cos((center.latitude * Math.PI) / 180));
  const spanM = radiusM * 2 * 1.25;
  const latFromH = (spanM / 111000) * (screen.height / visibleH);
  const latFromW = ((spanM / (111000 * cos)) * screen.height) / screen.width;
  const latitudeDelta = Math.min(1, Math.max(0.004, latFromH, latFromW));
  const longitudeDelta = (latitudeDelta * screen.width) / screen.height / cos;
  // Move the map center so the circle sits in the middle of the visible band.
  const bandCenterY = top + visibleH / 2;
  const shift = ((screen.height / 2 - bandCenterY) / screen.height) * latitudeDelta;
  return { latitude: center.latitude - shift, longitude: center.longitude, latitudeDelta, longitudeDelta };
}
