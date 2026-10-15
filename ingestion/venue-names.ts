// Venue name normalization. It makes spelling, case, punctuation and common abbreviations
// irrelevant, and nothing else: two names are the same venue only when their normalized keys
// are equal (or a provider id / registered alias says so). Similar-looking names are never
// merged, because "PICC Plenary Hall" and "PICC Forum" are different rooms.

const ABBREVIATIONS: Record<string, string> = {
  centre: 'center', ctr: 'center', cntr: 'center',
  bldg: 'building', blvd: 'boulevard', ave: 'avenue',
  intl: 'international', natl: 'national', theatre: 'theater',
};

/** Canonical comparison key, e.g. "S.M. Mall of Asia Arena!" -> "sm mall of asia arena". */
export function normalizeVenueName(raw: string | null | undefined): string {
  if (!raw) return '';
  const folded = raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\b([a-z])\.(?=[a-z]\b|[a-z]\.)/g, '$1') // "s.m." -> "sm"
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  const tokens = folded.split(' ').filter(Boolean).map((t) => ABBREVIATIONS[t] ?? t);
  if (tokens[0] === 'the' && tokens.length > 1) tokens.shift();
  return tokens.join(' ');
}

/** Words that mark a specific room or building inside a larger venue. */
const ROOM_WORDS = new Set(['hall', 'ballroom', 'theater', 'room', 'studio', 'arena', 'auditorium', 'stage', 'lounge', 'forum', 'annex', 'tower', 'wing', 'level', 'floor']);

export function hasRoomQualifier(key: string): boolean {
  return key.split(' ').some((t) => ROOM_WORDS.has(t));
}

/** Normalizes city names from providers, e.g. "City of Manila" / "Quezon City" -> "manila" / "quezon". */
export function normalizeCity(raw: string | null | undefined): string {
  if (!raw) return '';
  return normalizeVenueName(raw).replace(/^city of /, '').replace(/ city$/, '').trim();
}

/** Cities and municipalities of Metro Manila (normalized). */
export const METRO_MANILA_CITIES = new Set([
  'manila', 'quezon', 'makati', 'pasay', 'pasig', 'taguig', 'mandaluyong', 'san juan',
  'paranaque', 'las pinas', 'muntinlupa', 'marikina', 'caloocan', 'malabon', 'navotas', 'valenzuela', 'pateros',
]);

export const isMetroManilaCity = (city: string | null | undefined) => METRO_MANILA_CITIES.has(normalizeCity(city));
