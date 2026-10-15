// Ingestion types. This module is deliberately independent of the Expo app UI.
// Node runs these files directly (type stripping), so use `import type` and no enums.

/** A post as returned by Instagram Business Discovery (official Graph API). */
export type InstagramPost = {
  /** Stable source id. Business Discovery doesn't return one, so fixtures may use the permalink shortcode. */
  id: string;
  /** The account that published the post, without "@". */
  username: string;
  caption: string | null;
  /** ISO 8601 publication time. This is NOT the event date. */
  timestamp: string;
  permalink: string;
  /** Where the record came from, so synthetic data is never mistaken for real data. */
  origin: 'instagram-business-discovery' | 'synthetic';
  /** Reserved for future poster-image analysis. Business Discovery does not return these today. */
  imageUrls?: string[];
};

export type PostClassification =
  | 'upcoming_event'
  | 'past_event_recap'
  | 'unrelated'
  | 'ambiguous';

export type EventCategory = 'concert' | 'nightlife' | 'festival' | 'other';

export type TicketPrice = {
  minPhp: number | null;
  maxPhp: number | null;
  isFree: boolean | null;
  /** The exact text the figures came from. */
  rawText: string | null;
};

/** Why a candidate needs a human. Stable codes so a review UI can group them. */
export type ReviewReason =
  | 'duplicate_source_post'
  | 'possible_duplicate_event'
  | 'ambiguous_classification'
  | 'missing_name'
  | 'name_unverified'
  | 'cancellation_signal'
  | 'event_update_signal'
  | 'ai_invalid_response'
  | 'ai_ungrounded_field'
  | 'missing_date'
  | 'ambiguous_date'
  | 'year_inferred'
  | 'relative_date'
  | 'multiple_dates'
  | 'missing_start_time'
  | 'ambiguous_start_time'
  | 'missing_venue'
  | 'missing_location_area'
  | 'unverified_extractor';

/**
 * `ready_for_approval` still means a human must verify it. Nothing here auto-publishes.
 * `excluded` = not an upcoming event (recap, unrelated, duplicate).
 */
export type ReviewStatus = 'needs_review' | 'ready_for_approval' | 'excluded';

export type NameQuality = 'explicit' | 'derived' | 'guessed';

export type ExtractedFields = {
  name: string | null;
  /** explicit = labelled in the post; derived = built from stated facts (e.g. artist + city); guessed = first-line heuristic. */
  nameQuality: NameQuality | null;
  category: EventCategory | null;
  /** First event day, `YYYY-MM-DD`, Asia/Manila. */
  date: string | null;
  /** Last day for multi-day events, `YYYY-MM-DD`; equals `date` for one-day events. */
  endDate: string | null;
  /** 24h `HH:mm`, Asia/Manila. */
  startTime: string | null;
  venueName: string | null;
  /** Address or area exactly as the post states it. Never inferred from the venue name. */
  venueArea: string | null;
  artists: string[];
  /** Optional: not every event has a genre. */
  genre: string | null;
  ticketPrice: TicketPrice | null;
  /** Ticket link exactly as written in the post (e.g. `tickets.example.com/slug`); no scheme is added. */
  ticketUrl: string | null;
};

/** How an extraction was produced and what supports it. Kept with the candidate for audit. */
export type ExtractorDetails = {
  extractor: string;
  cacheHit: boolean;
  /** Verbatim caption snippets that support each important field. */
  evidence: Record<string, string>;
  /** Fields the extractor produced that the caption did not support; they were dropped. */
  ungroundedFields: string[];
  notes: string[];
  schemaWarnings: string[];
};

/** What an extractor returns for one post, before validation. */
export type ExtractionDraft = {
  classification: PostClassification;
  /** Short human-readable reasons for the classification. */
  classificationNotes: string[];
  fields: ExtractedFields;
  /** Problems the extractor itself noticed while reading dates/times. */
  flags: ReviewReason[];
  details?: ExtractorDetails;
};

export type ExtractorInfo = {
  name: string;
  /** `rules` = deterministic text rules, NOT AI. `simulated` = canned output for tests. */
  kind: 'rules' | 'simulated' | 'ai';
  usesImages: boolean;
};

export type EventCandidate = ExtractedFields & {
  /** `YYYY-MM-DDTHH:mm:00+08:00`, only when both date and start time are known. */
  startsAt: string | null;
  sourceUrl: string;
  sourcePostId: string;
  sourceUsername: string;
  sourceOrigin: InstagramPost['origin'];
  /** Publication time of the source post, kept separate from the event date. */
  sourcePostedAt: string;
};

export type IngestItem = {
  postId: string;
  classification: PostClassification;
  classificationNotes: string[];
  reviewStatus: ReviewStatus;
  reviewReasons: ReviewReason[];
  details?: ExtractorDetails;
  /** Present only for upcoming events and ambiguous posts worth a human look. */
  candidate: EventCandidate | null;
};

export type IngestResult = {
  extractor: ExtractorInfo;
  /** `now` used for past/upcoming decisions (ISO), for reproducible runs. */
  now: string;
  items: IngestItem[];
  summary: {
    total: number;
    upcoming: number;
    pastRecap: number;
    unrelated: number;
    ambiguous: number;
    duplicates: number;
    readyForApproval: number;
    needsReview: number;
  };
};
