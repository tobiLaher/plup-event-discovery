// Date and time helpers for post text. Everything is Asia/Manila (fixed UTC+8, no DST).
// A post's publication date is only used to (a) resolve a missing year and (b) decide
// whether a date is in the past. It is never used as the event date.
import type { ReviewReason } from './types.ts';

const MANILA_OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const pad = (n: number) => String(n).padStart(2, '0');

/** `YYYY-MM-DD` of an instant, as seen in Manila. */
export function manilaDate(iso: string | number | Date): string {
  const ms = new Date(iso).getTime() + MANILA_OFFSET_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

export function dayNumber(date: string): number {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

function isRealDate(y: number, m: number, d: number) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

/** `YYYY-MM-DDTHH:mm:00+08:00`, or null if either part is missing. */
export function toStartsAt(date: string | null, time: string | null): string | null {
  return date && time ? `${date}T${time}:00+08:00` : null;
}

export type ParsedDates = {
  /** Sorted, unique `YYYY-MM-DD`. */
  dates: string[];
  flags: ReviewReason[];
};

type Hit = { start: number; end: number };

/**
 * Finds calendar dates in free text. Handles "August 10, 11 & 12, 2026", "Oct 3",
 * "10 August 2026", "2026-08-10" and unambiguous numeric dates. Ambiguous numeric dates
 * (03/04/2026) and weekday/relative words ("tonight", "bukas") are flagged, not guessed.
 */
export function parseDates(text: string, postedAtIso: string): ParsedDates {
  const flags = new Set<ReviewReason>();
  const found = new Set<string>();
  const hits: Hit[] = [];
  const posted = manilaDate(postedAtIso);
  const postedYear = Number(posted.slice(0, 4));
  const overlaps = (s: number, e: number) => hits.some((h) => s < h.end && e > h.start);

  const add = (day: number, month: number, year: number | null) => {
    let y = year;
    if (y === null) {
      y = postedYear;
      // Yearless dates more than two weeks before the post are assumed to mean next year.
      if (isRealDate(y, month, day) && dayNumber(`${y}-${pad(month)}-${pad(day)}`) < dayNumber(posted) - 14) y += 1;
      flags.add('year_inferred');
    }
    if (!isRealDate(y, month, day)) {
      flags.add('ambiguous_date');
      return;
    }
    found.add(`${y}-${pad(month)}-${pad(day)}`);
  };

  // "August 10, 11 & 12, 2026" / "Aug 10-12" / "October 3rd"
  const monthFirst = new RegExp(
    `\\b${MONTH_RE}\\.?\\s+(\\d{1,2}(?!\\d)(?:st|nd|rd|th)?(?:\\s*(?:,|&|and|/|-|–|to)\\s*\\d{1,2}(?!\\d)(?:st|nd|rd|th)?)*)(?:,?\\s*(20\\d{2}))?`,
    'gi',
  );
  for (const m of text.matchAll(monthFirst)) {
    const month = MONTHS[m[1].toLowerCase().replace('.', '')];
    const year = m[3] ? Number(m[3]) : null;
    const list = m[2];
    hits.push({ start: m.index, end: m.index + m[0].length });
    const range = list.match(/^(\d{1,2})(?:st|nd|rd|th)?\s*(?:-|–|to)\s*(\d{1,2})(?:st|nd|rd|th)?$/i);
    if (range && Number(range[2]) > Number(range[1]) && Number(range[2]) - Number(range[1]) <= 14) {
      for (let d = Number(range[1]); d <= Number(range[2]); d++) add(d, month, year);
    } else {
      for (const n of list.match(/\d{1,2}(?!\d)/g) ?? []) add(Number(n), month, year);
    }
  }

  // "10 August 2026"
  const dayFirst = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\b\\.?(?:,?\\s*(20\\d{2}))?`, 'gi');
  for (const m of text.matchAll(dayFirst)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    hits.push({ start: m.index, end: m.index + m[0].length });
    add(Number(m[1]), MONTHS[m[2].toLowerCase()], m[3] ? Number(m[3]) : null);
  }

  // 2026-08-10
  for (const m of text.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    hits.push({ start: m.index, end: m.index + m[0].length });
    add(Number(m[3]), Number(m[2]), Number(m[1]));
  }

  // 08/10/2026 — only when it can't be read two ways.
  for (const m of text.matchAll(/\b(\d{1,2})\/(\d{1,2})\/(20\d{2}|\d{2})\b/g)) {
    if (overlaps(m.index, m.index + m[0].length)) continue;
    hits.push({ start: m.index, end: m.index + m[0].length });
    const a = Number(m[1]);
    const b = Number(m[2]);
    const year = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    if (a === b) add(a, b, year);
    else if (a > 12 && b <= 12) add(a, b, year); // DD/MM
    else if (b > 12 && a <= 12) add(b, a, year); // MM/DD
    else flags.add('ambiguous_date');
  }

  if (/\b(tonight|tomorrow|bukas|mamaya|ngayong gabi|this (?:coming )?(?:mon|tue|wed|thu|fri|sat|sun)\w*|next (?:mon|tue|wed|thu|fri|sat|sun)\w*)\b/i.test(text)) {
    flags.add('relative_date');
  }

  const dates = [...found].sort();
  // Several dates are one multi-day event only if they sit within a week of each other.
  if (dates.length > 1 && dayNumber(dates[dates.length - 1]) - dayNumber(dates[0]) > 6) {
    flags.add('multiple_dates');
  }
  return { dates, flags: [...flags] };
}

export type ParsedTime = { startTime: string | null; flags: ReviewReason[] };

function to24h(h: number, min: number, meridiem: string | undefined): string | null {
  let hour = h;
  if (meridiem) {
    if (h < 1 || h > 12) return null;
    const pm = meridiem.toLowerCase().startsWith('p');
    hour = (h % 12) + (pm ? 12 : 0);
  }
  if (hour > 23 || min > 59) return null;
  return `${pad(hour)}:${pad(min)}`;
}

/**
 * Picks a start time. Cues like "show starts"/"program" win over "doors"/"gates".
 * A lone doors time or several unlabeled times is flagged instead of guessed.
 */
export function parseStartTime(text: string): ParsedTime {
  const re = /(?:(doors?(?:\s+open)?|gates?(?:\s+open)?|show(?:\s+(?:starts?|time))?|starts?|start\s+time|program|set|call\s*time)\s*(?:at|:|@|-)?\s*)?\b(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)\b|\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*[ap]\.?m)/gi;
  const times: { time: string; cue: 'start' | 'doors' | null }[] = [];
  for (const m of text.matchAll(re)) {
    const meridiem = m[4]?.replace(/\./g, '');
    const time = m[4] ? to24h(Number(m[2]), Number(m[3] ?? 0), meridiem) : to24h(Number(m[5]), Number(m[6]), undefined);
    if (!time) continue;
    const label = m[1]?.toLowerCase() ?? '';
    times.push({ time, cue: /door|gate/.test(label) ? 'doors' : label ? 'start' : null });
  }
  const starts = [...new Set(times.filter((t) => t.cue === 'start').map((t) => t.time))];
  if (starts.length === 1) return { startTime: starts[0], flags: [] };
  if (starts.length > 1) return { startTime: null, flags: ['ambiguous_start_time'] };
  const unlabeled = [...new Set(times.filter((t) => t.cue === null).map((t) => t.time))];
  if (unlabeled.length === 1) return { startTime: unlabeled[0], flags: [] };
  if (unlabeled.length > 1) return { startTime: null, flags: ['ambiguous_start_time'] };
  // Only a doors time: don't pretend it's the show start.
  return { startTime: null, flags: times.length ? ['missing_start_time', 'ambiguous_start_time'] : ['missing_start_time'] };
}
