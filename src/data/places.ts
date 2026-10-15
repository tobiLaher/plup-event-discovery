import type { Coords } from '@/utils/geo';

export type KnownPlace = { label: string; coords: Coords; kind: 'area' | 'venue' };

// Local suggestions for Metro Manila only. This is NOT a worldwide autocomplete;
// anything else is resolved by the device geocoder when the user submits.
const AREA = (label: string, latitude: number, longitude: number): KnownPlace => ({
  label,
  coords: { latitude, longitude },
  kind: 'area',
});

export const METRO_MANILA_AREAS: KnownPlace[] = [
  AREA('Poblacion, Makati', 14.5645, 121.0302),
  AREA('Makati CBD (Ayala)', 14.5547, 121.0244),
  AREA('Bonifacio Global City (BGC), Taguig', 14.5507, 121.0459),
  AREA('Ortigas Center, Pasig', 14.5864, 121.0614),
  AREA('Kapitolyo, Pasig', 14.5723, 121.0618),
  AREA('Malate, Manila', 14.5667, 120.9937),
  AREA('Ermita, Manila', 14.5833, 120.9833),
  AREA('Intramuros, Manila', 14.5895, 120.9747),
  AREA('Binondo, Manila', 14.6001, 120.9743),
  AREA('Quezon City', 14.676, 121.0437),
  AREA('Maginhawa, Quezon City', 14.6535, 121.064),
  AREA('Araneta City (Cubao), Quezon City', 14.6205, 121.0535),
  AREA('Eastwood City, Quezon City', 14.6093, 121.0788),
  AREA('Mandaluyong', 14.5794, 121.0359),
  AREA('San Juan', 14.6019, 121.0355),
  AREA('Pasay', 14.5378, 121.0014),
  AREA('SM Mall of Asia, Pasay', 14.5352, 120.9822),
  AREA('Parañaque', 14.4793, 121.0198),
  AREA('Alabang, Muntinlupa', 14.4195, 121.039),
  AREA('Manila', 14.5995, 120.9842),
  AREA('Makati', 14.5547, 121.0244),
  AREA('Taguig', 14.5176, 121.0509),
  AREA('Pasig', 14.5764, 121.0851),
];

const fold = (t: string) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Case/accent-insensitive local match; prefix and word-start matches rank first. */
export function suggestPlaces(query: string, places: KnownPlace[], limit = 6): KnownPlace[] {
  const q = fold(query.trim());
  if (!q) return [];
  const scored: { p: KnownPlace; score: number }[] = [];
  for (const p of places) {
    const l = fold(p.label);
    const i = l.indexOf(q);
    if (i < 0) continue;
    const score = i === 0 ? 0 : /[\s,(]/.test(l[i - 1]) ? 1 : 2;
    scored.push({ p, score: score * 2 + (p.kind === 'venue' ? 1 : 0) });
  }
  scored.sort((a, b) => a.score - b.score || a.p.label.length - b.p.label.length);
  const seen = new Set<string>();
  return scored
    .map((s) => s.p)
    .filter((p) => (seen.has(p.label) ? false : (seen.add(p.label), true)))
    .slice(0, limit);
}
