// Shared scoring for the local evaluations. Compares an extractor's drafts with the hand-written
// reference in ingestion/local/reference-analysis.json (git-ignored; written by Claude Code at
// development time, not by any runtime model).
import { readFileSync } from 'node:fs';
import type { EventExtractor } from './extractor.ts';
import type { ExtractionDraft, InstagramPost } from './types.ts';
import { normalizeVenueName } from './venue-names.ts';

export const EVAL_NOW = '2026-10-14T04:00:00Z';
export type Ref = Record<string, any>;

export const loadPosts = () => JSON.parse(readFileSync('ingestion/local/real-posts.json', 'utf8')) as InstagramPost[];
export const loadReference = () => (JSON.parse(readFileSync('ingestion/local/reference-analysis.json', 'utf8')) as { posts: Record<string, Ref> }).posts;

export type Score = {
  posts: number;
  classification: number;
  /** Announcements where the extractor did not present a non-official name as official (reference: none has one). */
  titleNotFalselyOfficial: number;
  generatedLabels: number;
  artists: number;
  date: number;
  venue: number;
  ticketUrl: number;
  announcements: number;
  /** Claims the model made that the caption did not support (dropped by grounding). */
  unsupportedClaims: number;
};

export type PostRow = {
  id: string;
  expected: string;
  got: string;
  name: string | null;
  nameQuality: string | null;
  artists: string[];
  date: string | null;
  venue: string | null;
  ticketUrl: string | null;
  ungrounded: string[];
  flags: string[];
  notes: string[];
};

const norm = (a: string[]) => [...a].map((x) => x.toLowerCase()).sort().join('|');

export async function scoreExtractor(extractor: EventExtractor, posts: InstagramPost[], ref: Record<string, Ref>, now = EVAL_NOW) {
  await extractor.prepare?.(posts, now);
  const s: Score = { posts: posts.length, classification: 0, titleNotFalselyOfficial: 0, generatedLabels: 0, artists: 0, date: 0, venue: 0, ticketUrl: 0, announcements: 0, unsupportedClaims: 0 };
  const rows: PostRow[] = [];
  const drafts = new Map<string, ExtractionDraft>();
  for (const p of posts) {
    const r = ref[p.id];
    const d = await extractor.extract({ post: p, now });
    drafts.set(p.id, d);
    if (d.classification === r.classification) s.classification++;
    s.unsupportedClaims += d.details?.ungroundedFields.length ?? 0;
    const f = d.fields;
    if (r.fieldsEvaluated) {
      s.announcements++;
      const official = f.nameQuality === 'explicit' ? f.name : null;
      if (official === r.officialTitle) s.titleNotFalselyOfficial++;
      if (f.name && f.nameQuality === 'derived') s.generatedLabels++;
      if (norm(f.artists) === norm(r.artists)) s.artists++;
      if (f.date === r.date && f.endDate === r.endDate) s.date++;
      if (normalizeVenueName(f.venueName) === normalizeVenueName(r.venueName)) s.venue++;
      if (f.ticketUrl === r.ticketUrl) s.ticketUrl++;
    }
    rows.push({
      id: p.id, expected: r.classification, got: d.classification, name: f.name, nameQuality: f.nameQuality, artists: f.artists,
      date: f.date, venue: f.venueName, ticketUrl: f.ticketUrl, ungrounded: d.details?.ungroundedFields ?? [], flags: d.flags, notes: d.classificationNotes,
    });
  }
  return { score: s, rows, drafts };
}

export const formatScore = (s: Score) =>
  `classification ${s.classification}/${s.posts} | not-falsely-official title ${s.titleNotFalselyOfficial}/${s.announcements} | generated labels ${s.generatedLabels}/${s.announcements} | artists ${s.artists}/${s.announcements} | date ${s.date}/${s.announcements} | venue ${s.venue}/${s.announcements} | ticket link ${s.ticketUrl}/${s.announcements} | unsupported claims dropped ${s.unsupportedClaims}`;
