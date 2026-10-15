// RULES extractor (rules-v0). Deterministic text rules over the caption. This is NOT AI and
// is not reliable on free-form Filipino/English captions or poster-only information.
// Its job is to produce reviewable candidates; every output still needs human verification.
import { EMPTY_FIELDS } from './extractor.ts';
import type { EventExtractor, ExtractionInput } from './extractor.ts';
import { dayNumber, manilaDate, parseDates, parseStartTime } from './manila-date.ts';
import type {
  EventCategory,
  ExtractedFields,
  ExtractionDraft,
  ExtractorInfo,
  PostClassification,
  ReviewReason,
  TicketPrice,
} from './types.ts';

const RECAP_RE = /\b(thank(?:s| you) (?:for|to|so much)|until next time|see you (?:again|next)|relive|re-?cap|last night|what a (?:night|show|weekend)|our favou?rite moments|photos? from|full album|highlights?|that was|was amazing|miss na namin|salamat|(?:a|\d+) (?:day|week|month)s? ago)\b/i;
const ANNOUNCE_RE = /\b(tickets?\b.*\b(?:on sale|available|now|via|at)|get your tickets|on sale|live in manila|join us|doors? open|gates? open|line-?up|presented by|coming to|save the date|happening|don'?t miss|see you (?:on|at)|early bird|rsvp|free entry|free admission|coming back|see you tonight)\b|🎫/iu;
const EVENT_RE = /\b(concert|live|gig|tour|fest(?:ival)?|party|dj|set|nights?|show|rave|album launch|afterparty|open mic|day \d)\b/i;

export const CANCEL_RE = /\b(cancel(?:l?ed|l?ation)|postponed|re-?scheduled|called off|no longer pushing through|hindi (?:na )?matutuloy)\b/i;

const GENRES: [RegExp, string][] = [
  [/\bhip[- ]?hop\b/i, 'Hip-Hop'],
  [/\b(?:deep|tech|progressive)?\s?house music\b|\b(?:deep|tech|progressive) house\b/i, 'House'],
  [/\btechno\b/i, 'Techno'],
  [/\bedm\b/i, 'EDM'],
  [/\bopm\b/i, 'OPM'],
  [/\bindie\b/i, 'Indie'],
  [/\bjazz\b/i, 'Jazz'],
  [/\b(?:r&b|rnb)\b/i, 'R&B'],
  [/\bk-?pop\b/i, 'K-Pop'],
  [/\bpop(?!-up)\b/i, 'Pop'],
  [/\brock\b/i, 'Rock'],
  [/\breggae\b/i, 'Reggae'],
  [/\bacoustic\b/i, 'Acoustic'],
  [/\bmetal\b/i, 'Metal'],
  [/\bpunk\b/i, 'Punk'],
  [/\bdisco\b/i, 'Disco'],
];

const PICTOGRAPHS = /[\p{Extended_Pictographic}️‍]/gu;
const clean = (s: string) => s.replace(PICTOGRAPHS, '').replace(/#\w+/g, '').replace(/\s+/g, ' ').trim().replace(/[.,;:!\s]+$/, '');

function category(text: string): EventCategory | null {
  if (/\bfest(?:ival)?\b/i.test(text)) return 'festival';
  if (/\b(concert|tour|gig|live in|live at|album launch)\b/i.test(text)) return 'concert';
  if (/\b(party|dj set|dj|club|rave|afterparty)\b/i.test(text)) return 'nightlife';
  return null;
}

function genre(text: string): string | null {
  for (const [re, label] of GENRES) if (re.test(text)) return label;
  return null;
}

/** Venue from a 📍 line, a "Venue:/Where:/Location:" label, or "live at/@ <Capitalized Name>". */
function venue(text: string): { name: string | null; area: string | null } {
  const lines = text.split(/\r?\n/);
  let raw: string | null = null;
  for (const line of lines) {
    const pin = line.match(/📍\s*(.+)/u) ?? line.match(/^\s*(?:venue|where|location)\s*[:\-–]\s*(.+)/i);
    if (pin) {
      raw = pin[1];
      break;
    }
  }
  raw ??= text.match(/(?:\blive at|\bhappening at|\bvenue is|@)\s+((?:[A-Z][\w&'.-]*(?:\s+|$)){1,6})/)?.[1] ?? null;
  if (!raw) return { name: null, area: null };
  const [head, ...rest] = clean(raw).split(/\s*(?:,|\||\s-\s)\s*/);
  const name = head || null;
  const tail = rest.join(', ');
  // The area is whatever the post spells out after the venue name; never inferred from the name.
  const area = tail || null;
  return { name, area };
}

function artists(text: string): string[] {
  const labeled = text.match(/^\s*(?:line-?up|artists?|featuring|guests?|special guests?|performers?)\s*[:\-–]\s*(.+)$/im)?.[1]
    ?? text.match(/\b(?:featuring|feat\.?|ft\.)\s+([^\n.!]+)/i)?.[1];
  if (!labeled) return [];
  return clean(labeled)
    .split(/\s*(?:,|&|\+|\/|•|·|\bx\b|\band\b)\s*/i)
    .map((a) => a.trim())
    .filter((a) => a.length > 0 && a.length <= 60)
    .slice(0, 20);
}

/** Name from an explicit label, else the first line. The fallback is a guess and is reported as such. */
function eventName(text: string): { name: string | null; guessed: boolean } {
  const labeled = text.match(/^\s*(?:event|title)\s*[:\-–]\s*(.+)$/im)?.[1];
  const first = labeled ?? text.split(/\r?\n/).find((l) => clean(l).length > 0) ?? '';
  const name = clean(first);
  const ok = name.length >= 3 && name.length <= 90;
  return { name: ok ? name : null, guessed: ok && !labeled };
}

/** A ticket link as written: a 🎫 line, or "tickets at/via <domain>". No scheme is added. */
function ticketUrl(text: string): string | null {
  const dom = '((?:https?:\\/\\/)?[a-z0-9-]+(?:\\.[a-z0-9-]+)*\\.(?:com|ph|net|co|io|ly|me)(?:\\/[^\\s,;]*)?)';
  const pin = text.match(new RegExp(`🎫\\s*(?:tickets?\\s*(?:at|via|on|here:?)\\s*)?${dom}`, 'iu'));
  const via = text.match(new RegExp(`\\btickets?\\s*(?:at|via|on|here:?)\\s*${dom}`, 'i'));
  const raw = pin?.[1] ?? via?.[1];
  return raw ? raw.replace(/[.!)]+$/, '') : null;
}

function ticketPrice(text: string): TicketPrice | null {
  if (/\bfree (?:entry|admission|entrance)\b|\bwalang bayad\b/i.test(text)) {
    return { minPhp: 0, maxPhp: 0, isFree: true, rawText: text.match(/free (?:entry|admission|entrance)|walang bayad/i)![0] };
  }
  const num = (s: string) => Number(s.replace(/,/g, ''));
  const re = /(?:₱|php\s?|p(?=\d))\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\s*(?:-|–|to)\s*(?:₱|php\s?|p)?\s?(\d{1,3}(?:,\d{3})+|\d+))?/gi;
  const matches = [...text.matchAll(re)];
  if (!matches.length) return null;
  // Every peso amount in the caption (early bird, door, VIP...) widens the min–max range.
  const amounts = matches.flatMap((m) => [num(m[1]), ...(m[2] ? [num(m[2])] : [])]);
  return { minPhp: Math.min(...amounts), maxPhp: Math.max(...amounts), isFree: null, rawText: matches.map((m) => m[0].trim()).join('; ') };
}

export class RulesExtractor implements EventExtractor {
  readonly info: ExtractorInfo = { name: 'rules-v0 (deterministic text rules, not AI)', kind: 'rules', usesImages: false };

  async extract({ post, now }: ExtractionInput): Promise<ExtractionDraft> {
    const text = post.caption?.trim() ?? '';
    const notes: string[] = [];
    if (!text) {
      return { classification: 'unrelated', classificationNotes: ['empty caption (image-only posts need poster analysis)'], fields: { ...EMPTY_FIELDS }, flags: [] };
    }

    const today = manilaDate(now);
    const { dates, flags: dateFlags } = parseDates(text, post.timestamp);
    const recap = RECAP_RE.test(text);
    const announce = ANNOUNCE_RE.test(text);
    // A parseable date plus a 📍 venue line is event-like even without keywords ("X is coming back").
    const eventish = EVENT_RE.test(text) || (dates.length > 0 && /📍/u.test(text));
    const hasFuture = dates.some((d) => d >= today);
    const allPast = dates.length > 0 && !hasFuture;
    // "Tonight" / "bukas" are only meaningful on the day of posting; on an old post they mean a past date.
    const staleRelative =
      dates.length === 0 && dateFlags.includes('relative_date') && dayNumber(today) - dayNumber(manilaDate(post.timestamp)) >= 2;

    let classification: PostClassification;
    if (!eventish && !announce) {
      classification = 'unrelated';
      notes.push('no event or announcement wording');
    } else if (allPast) {
      classification = 'past_event_recap';
      notes.push(`all dates (${dates.join(', ')}) are before ${today}${recap ? '; recap wording' : ''}`);
    } else if (staleRelative) {
      classification = 'past_event_recap';
      notes.push('relative date ("tonight"/"tomorrow") on a post older than 2 days');
    } else if (recap && !announce && !hasFuture) {
      classification = 'past_event_recap';
      notes.push('recap wording and no upcoming date');
    } else if (hasFuture && recap && !announce) {
      classification = 'ambiguous';
      notes.push('recap wording but a future date is mentioned');
    } else if (hasFuture) {
      classification = 'upcoming_event';
      notes.push(`date(s) on or after ${today}`);
    } else {
      classification = 'ambiguous';
      notes.push(dateFlags.includes('relative_date') ? 'only relative dates ("tonight", "bukas")' : 'event wording but no parseable date');
    }

    const flags: ReviewReason[] = [...dateFlags];
    const time = parseStartTime(text);
    flags.push(...time.flags);

    const multiple = dateFlags.includes('multiple_dates');
    const v = venue(text);
    const nm = eventName(text);
    if (nm.guessed) flags.push('name_unverified');
    if (CANCEL_RE.test(text)) flags.push('cancellation_signal');
    const fields: ExtractedFields = {
      name: nm.name,
      nameQuality: nm.name ? (nm.guessed ? 'guessed' : 'explicit') : null,
      category: category(text),
      date: !multiple && dates.length ? dates[0] : null,
      endDate: !multiple && dates.length ? dates[dates.length - 1] : null,
      startTime: time.startTime,
      venueName: v.name,
      venueArea: v.area,
      artists: artists(text),
      genre: genre(text),
      ticketPrice: ticketPrice(text),
      ticketUrl: ticketUrl(text),
    };
    return { classification, classificationNotes: notes, fields, flags: [...new Set(flags)] };
  }
}
