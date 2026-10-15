// Asia/Manila is a fixed UTC+8 (no DST). A "nightlife day" runs 6am → 6am so that
// events after midnight still count as part of the night they belong to.
const DAY = 86_400_000;
const MANILA_OFFSET = 8 * 3_600_000;
const NIGHT_CUTOFF = 6 * 3_600_000;

export type DateFilter = 'all' | 'tonight' | 'weekend';

export function nightIndex(ms: number) {
  return Math.floor((ms + MANILA_OFFSET - NIGHT_CUTOFF) / DAY);
}

// First day (Friday) of the current/upcoming weekend, as a nightlife-day index.
function weekendStart(todayIdx: number) {
  const weekday = (todayIdx + 4) % 7; // epoch day 0 was a Thursday; 0 = Sunday
  if (weekday >= 5) return todayIdx - (weekday - 5);
  if (weekday === 0) return todayIdx - 2;
  return todayIdx + (5 - weekday);
}

export function daysUntilWeekend(now = Date.now()) {
  const today = nightIndex(now);
  return weekendStart(today) - today;
}

/** ISO string for `dayOffset` nightlife-days from today at Manila `hour:minute`. */
export function manilaAt(dayOffset: number, hour: number, minute = 0, now = Date.now()) {
  const day = nightIndex(now) + dayOffset + (hour * 60 + minute < 360 ? 1 : 0);
  return new Date(day * DAY + hour * 3_600_000 + minute * 60_000 - MANILA_OFFSET).toISOString();
}

/** "Fri, Nov 20, 7:00 PM"; the time is omitted when the event's start time isn't known. */
export function formatEventWhen(e: { startsAt: string; timeUnknown?: boolean }, long = false) {
  return new Date(e.startsAt).toLocaleString('en-PH', {
    weekday: long ? 'long' : 'short',
    month: long ? 'long' : 'short',
    day: 'numeric',
    ...(e.timeUnknown ? {} : { hour: 'numeric', minute: '2-digit' }),
    timeZone: 'Asia/Manila',
  });
}

export function matchesDate(iso: string, filter: DateFilter, now = Date.now()) {
  if (filter === 'all') return true;
  const today = nightIndex(now);
  const day = nightIndex(new Date(iso).getTime());
  if (filter === 'tonight') return day === today;
  const start = weekendStart(today);
  return day >= start && day <= start + 2;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** Today's Manila nightlife date as YYYY-MM-DD. */
export function todayYmd(now = Date.now()) {
  const d = new Date(nightIndex(now) * DAY);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** True if the event belongs to this calendar night (events after midnight count for the previous night). */
export function matchesCalendarDate(iso: string, ymd: string) {
  const [y, m, d] = ymd.split('-').map(Number);
  return nightIndex(new Date(iso).getTime()) === Date.UTC(y, m - 1, d) / DAY;
}

export function formatYmd(ymd: string) {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-PH', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}
