// The seam for future multimodal AI. A real AI extractor would implement this interface,
// optionally reading `input.post.imageUrls` (poster analysis) alongside the caption.
import type { ExtractionDraft, ExtractorInfo, InstagramPost } from './types.ts';

export type ExtractionInput = {
  post: InstagramPost;
  /** Current instant (ISO). Injected so runs and tests are reproducible. */
  now: string;
};

export interface EventExtractor {
  readonly info: ExtractorInfo;
  /** Optional: called once with the whole batch before extract(), so an AI extractor can batch its requests. */
  prepare?(posts: InstagramPost[], now: string): Promise<void>;
  extract(input: ExtractionInput): Promise<ExtractionDraft>;
}

export const EMPTY_FIELDS: ExtractionDraft['fields'] = {
  name: null,
  nameQuality: null,
  category: null,
  date: null,
  endDate: null,
  startTime: null,
  venueName: null,
  venueArea: null,
  artists: [],
  genre: null,
  ticketPrice: null,
  ticketUrl: null,
};
