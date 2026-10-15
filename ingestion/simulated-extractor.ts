// SIMULATED adapter. It returns pre-written drafts and performs no analysis at all.
// It exists to prove the pipeline accepts any EventExtractor (e.g. a future AI one)
// and must never be mistaken for real extraction.
import type { EventExtractor, ExtractionInput } from './extractor.ts';
import { EMPTY_FIELDS } from './extractor.ts';
import type { ExtractionDraft, ExtractorInfo } from './types.ts';

export class SimulatedExtractor implements EventExtractor {
  readonly info: ExtractorInfo = { name: 'simulated-canned-drafts', kind: 'simulated', usesImages: false };
  private readonly drafts: Record<string, Partial<ExtractionDraft>>;

  constructor(drafts: Record<string, Partial<ExtractionDraft>>) {
    this.drafts = drafts;
  }

  async extract({ post }: ExtractionInput): Promise<ExtractionDraft> {
    const d = this.drafts[post.id];
    return {
      classification: d?.classification ?? 'unrelated',
      classificationNotes: d?.classificationNotes ?? ['simulated: no canned draft for this post'],
      fields: { ...EMPTY_FIELDS, ...d?.fields },
      flags: d?.flags ?? [],
    };
  }
}
