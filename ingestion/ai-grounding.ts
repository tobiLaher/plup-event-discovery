// Grounding: every fact the model claims must be supported by the caption itself, checked by
// deterministic code. A claim the caption does not support is dropped and reported, so a
// hallucinated artist, venue, date or ticket link can never reach the publishing checks. The
// model's own confidence is not an input anywhere.
import type { AiEvent, AiResult } from './ai-schema.ts';
import { dayNumber, manilaDate, parseDates, parseStartTime } from './manila-date.ts';
import { CANCEL_RE } from './rules-extractor.ts';
import { EMPTY_FIELDS } from './extractor.ts';
import type { ExtractedFields, PostClassification, ReviewReason } from './types.ts';

/** Accent-, case- and punctuation-insensitive form used to look for a snippet in the caption. */
const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const appears = (snippet: string | null | undefined, captionFolded: string): boolean => {
  const f = snippet ? fold(snippet) : '';
  return f.length >= 2 && ` ${captionFolded} `.includes(` ${f} `);
};

/** Words a generated label may use even if the caption does not contain them. */
const LABEL_FILLER = new Set(['in', 'at', 'live', 'the', 'and', 'concert', 'show', 'tour', 'night']);

/** Promotional lines are not titles: exclamations, questions, calls to action, or very long sentences. */
export function looksLikeSlogan(title: string): boolean {
  return /[!?]\s*$/.test(title.trim()) || title.trim().split(/\s+/).length > 10 || /\b(last chance|coming back|tickets? (?:on sale|now|available)|don'?t miss|join us|get your)\b/i.test(title);
}

/** A one-word title that the caption only uses as a hashtag (e.g. #DemoTour2026) is a tag, not a title. */
export function isHashtagTitle(title: string, caption: string): boolean {
  const t = title.trim().replace(/^#/, '');
  if (/\s/.test(t)) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return title.trim().startsWith('#') || new RegExp(`#${escaped}(?![A-Za-z0-9_])`, 'i').test(caption);
}

export type Grounded = {
  classification: PostClassification;
  fields: ExtractedFields;
  flags: ReviewReason[];
  evidence: Record<string, string>;
  ungrounded: string[];
  notes: string[];
};

export function groundResult(r: AiResult, caption: string, postedAt: string, now: string): Grounded {
  const flags = new Set<ReviewReason>();
  const evidence: Record<string, string> = {};
  const ungrounded: string[] = [];
  const notes = [...r.notes];
  const cap = fold(caption);
  const today = manilaDate(now);
  const fields: ExtractedFields = { ...EMPTY_FIELDS, artists: [] };

  // Updates and cancellations: the model can raise a flag, but a cancel-like caption raises it
  // even if the model missed it. Raising a flag only holds an event, so it is the safe direction.
  if (r.update === 'cancelled' || r.update === 'postponed' || r.update === 'rescheduled') flags.add('cancellation_signal');
  if (r.update === 'updated') flags.add('event_update_signal');
  if (CANCEL_RE.test(caption)) flags.add('cancellation_signal');

  const ev: AiEvent | null = r.classification === 'unrelated' ? null : r.event;
  if (ev) {
    // Title: official only if it is in the caption and does not read like a slogan.
    if (ev.officialTitle) {
      if (!appears(ev.officialTitle, cap)) ungrounded.push('officialTitle');
      else if (isHashtagTitle(ev.officialTitle, caption)) {
        ungrounded.push('officialTitle:hashtag');
        notes.push('title was only a hashtag in the caption, not an official title');
      } else if (looksLikeSlogan(ev.officialTitle)) {
        ungrounded.push('officialTitle:slogan');
        notes.push('title looked like a promotional slogan and was not used as an official title');
      } else {
        fields.name = ev.officialTitle;
        fields.nameQuality = 'explicit';
        evidence.title = ev.officialTitle;
      }
    }
    // Generated label: allowed only when built from words the caption contains.
    if (!fields.name && ev.displayLabel) {
      const words = fold(ev.displayLabel).split(' ').filter(Boolean);
      if (words.length && words.every((w) => LABEL_FILLER.has(w) || ` ${cap} `.includes(` ${w} `))) {
        fields.name = ev.displayLabel;
        fields.nameQuality = 'derived';
        notes.push(`display label "${ev.displayLabel}" was generated, not an official title`);
      } else ungrounded.push('displayLabel');
    }

    const seen = new Set<string>();
    for (const a of ev.artists) {
      const k = fold(a.name);
      if (!appears(a.name, cap)) ungrounded.push(`artist:${a.name}`);
      else if (!seen.has(k)) {
        seen.add(k);
        fields.artists.push(a.name);
        if (a.evidence && appears(a.evidence, cap)) evidence[`artist:${a.name}`] = a.evidence;
      }
    }
    fields.category = ev.category;

    // Date: our deterministic parser must read the same date from the quoted evidence (or caption).
    if (ev.date.value) {
      const src = ev.date.evidence && appears(ev.date.evidence, cap) ? ev.date.evidence : caption;
      const parsed = parseDates(src, postedAt);
      if (parsed.dates.includes(ev.date.value)) {
        for (const f of parsed.flags) flags.add(f);
        const multi = parsed.flags.includes('multiple_dates');
        fields.date = multi ? null : ev.date.value;
        const end = ev.date.endValue && parsed.dates.includes(ev.date.endValue) ? ev.date.endValue : ev.date.value;
        fields.endDate = multi ? null : end < ev.date.value ? ev.date.value : end;
        if (src !== caption) evidence.date = src;
      } else ungrounded.push('date');
    }
    // Start time: same idea with the time parser.
    if (ev.startTime.value) {
      const src = ev.startTime.evidence && appears(ev.startTime.evidence, cap) ? ev.startTime.evidence : caption;
      const t = parseStartTime(src);
      if (t.startTime === ev.startTime.value) {
        fields.startTime = t.startTime;
        if (src !== caption) evidence.startTime = src;
      } else ungrounded.push('startTime');
    }
    // Venue and area clue must be words from the caption.
    if (ev.venue.name) {
      if (appears(ev.venue.name, cap)) {
        fields.venueName = ev.venue.name;
        if (ev.venue.evidence && appears(ev.venue.evidence, cap)) evidence.venue = ev.venue.evidence;
      } else ungrounded.push('venue');
    }
    if (ev.venue.areaClue) {
      if (appears(ev.venue.areaClue, cap)) fields.venueArea = ev.venue.areaClue;
      else ungrounded.push('areaClue');
    }
    // Ticket link: the exact string must be in the caption. Prices: the digits must be too.
    if (ev.ticket.url) {
      const u = ev.ticket.url.replace(/^https?:\/\//i, '').replace(/[.,!)]+$/, '').toLowerCase();
      if (caption.toLowerCase().replace(/https?:\/\//g, '').includes(u)) fields.ticketUrl = u;
      else ungrounded.push('ticketUrl');
    }
    const digits = caption.replace(/(\d),(?=\d{3})/g, '$1');
    const priceOk = (n: number | null) => n === null || new RegExp(`(?<![\\d.])${n}(?![\\d])`).test(digits);
    if (ev.ticket.isFree === true) {
      if (/\bfree\b|\bwalang bayad\b/i.test(caption)) fields.ticketPrice = { minPhp: 0, maxPhp: 0, isFree: true, rawText: 'free' };
      else ungrounded.push('ticketFree');
    } else if (ev.ticket.minPhp !== null || ev.ticket.maxPhp !== null) {
      if (priceOk(ev.ticket.minPhp) && priceOk(ev.ticket.maxPhp)) {
        const lo = ev.ticket.minPhp ?? ev.ticket.maxPhp!;
        const hi = ev.ticket.maxPhp ?? ev.ticket.minPhp!;
        fields.ticketPrice = { minPhp: Math.min(lo, hi), maxPhp: Math.max(lo, hi), isFree: null, rawText: ev.ticket.evidence };
      } else ungrounded.push('ticketPrice');
    }
  }
  if (ungrounded.length) flags.add('ai_ungrounded_field');

  // Classification: the model proposes; dates (read by our parser) decide upcoming vs past.
  let classification: PostClassification = r.classification;
  const hasDate = Boolean(fields.date);
  const dateFlagged = flags.has('multiple_dates') || flags.has('ambiguous_date');
  if (classification === 'upcoming_event') {
    if (!hasDate && !dateFlagged) {
      classification = 'ambiguous';
      notes.push('model said upcoming but no date in the caption supports it');
    } else if (hasDate && (fields.endDate ?? fields.date!) < today) {
      classification = 'past_event_recap';
      notes.push(`date ended before ${today}`);
    }
  } else if (classification === 'past_event_recap' && hasDate && (fields.endDate ?? fields.date!) >= today) {
    classification = 'ambiguous';
    notes.push('model said recap but the caption has a future date');
  }
  // "Tonight"/"tomorrow" on an old post refers to a day that has passed. This also covers a model that
  // called such a post "upcoming" and was downgraded to ambiguous above.
  if (classification === 'ambiguous' && !hasDate && !dateFlagged) {
    const rel = parseDates(caption, postedAt).flags.includes('relative_date');
    if (rel && dayNumber(today) - dayNumber(manilaDate(postedAt)) >= 2) {
      classification = 'past_event_recap';
      notes.push('relative date on a post older than 2 days');
    }
  }
  return { classification, fields, flags: [...flags], evidence, ungrounded, notes };
}

