// AI event extractor. It plugs into the existing pipeline as an EventExtractor and keeps every
// guard in our own code: strict schema validation, grounding against the caption, caching by
// post id + content hash, batching, and per-post failure isolation. It never reads a model
// confidence, and a bad reply for one post can never stop the rest of the batch.
import { groundResult } from './ai-grounding.ts';
import { AI_JSON_SCHEMA } from './ai-response-schema.ts';
import { buildUserMessage, estimateTokens, MAX_CAPTION_CHARS, PROMPT_VERSION, SYSTEM_PROMPT } from './ai-prompt.ts';
import { parseBatchResponse, type AiResult } from './ai-schema.ts';
import { createHash } from 'node:crypto';
import { EMPTY_FIELDS } from './extractor.ts';
import type { EventExtractor, ExtractionInput } from './extractor.ts';
import { LlmClientError, type LlmClient } from './llm-client.ts';
import { RulesExtractor } from './rules-extractor.ts';
import type { ExtractionDraft, ExtractorDetails, ExtractorInfo, InstagramPost } from './types.ts';

export interface ExtractionCache {
  get(key: string): Promise<AiResult | null>;
  set(key: string, value: AiResult): Promise<void>;
}

export class MemoryExtractionCache implements ExtractionCache {
  private m = new Map<string, AiResult>();
  async get(key: string) {
    return this.m.get(key) ?? null;
  }
  async set(key: string, value: AiResult) {
    this.m.set(key, value);
  }
  get size() {
    return this.m.size;
  }
}

export type AiExtractorStats = {
  llmCalls: number;
  cacheHits: number;
  postsSent: number;
  failedPosts: number;
  /** From the provider when it reports usage, otherwise a rough chars/4 estimate. */
  inputTokens: number;
  outputTokens: number;
  usageIsEstimated: boolean;
  /** Replies cut off at the output-token limit. */
  truncatedReplies: number;
  /** Extra single-post requests made after a truncated reply (only when splitOnTruncation is on). */
  fallbackRequests: number;
};

export type AiExtractorOptions = {
  client: LlmClient;
  cache?: ExtractionCache;
  /** Posts per request. Batching shares the instruction prompt across posts to save tokens. */
  batchSize?: number;
  /** Upper bound on caption characters per request. */
  maxBatchChars?: number;
  maxOutputTokensPerPost?: number;
  /** Hard cap on posts sent to the model in this extractor's lifetime. Extra posts are not sent. */
  maxPosts?: number;
  /** After a truncated reply, re-send the posts it did not finish one per request (once). Off by default. */
  splitOnTruncation?: boolean;
};

type Prepared = { result: AiResult | null; error: string | null; warnings: string[]; cacheHit: boolean };

/** Removes anything that looks like a credential before an error message is stored or printed. */
const safeMessage = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/[A-Za-z0-9_\-]{24,}/g, '[redacted]').slice(0, 160);

export const cacheKey = (p: InstagramPost) =>
  `${p.id}:${createHash('sha256').update(`${PROMPT_VERSION}\n${(p.caption ?? '').slice(0, MAX_CAPTION_CHARS)}`).digest('hex').slice(0, 20)}`;

export class AiExtractor implements EventExtractor {
  readonly info: ExtractorInfo;
  readonly stats: AiExtractorStats = { llmCalls: 0, cacheHits: 0, postsSent: 0, failedPosts: 0, inputTokens: 0, outputTokens: 0, usageIsEstimated: false, truncatedReplies: 0, fallbackRequests: 0 };
  private readonly o: Required<Omit<AiExtractorOptions, 'client'>> & { client: LlmClient };
  private readonly prepared = new Map<string, Prepared>();
  /** Set after a fatal client error; no further requests are made. */
  private halted: string | null = null;

  constructor(opts: AiExtractorOptions) {
    this.o = { cache: new MemoryExtractionCache(), batchSize: 5, maxBatchChars: 6000, maxOutputTokensPerPost: 400, maxPosts: Number.POSITIVE_INFINITY, splitOnTruncation: false, ...opts };
    this.info = { name: `ai:${opts.client.id}${opts.client.simulated ? ' (SIMULATED)' : ''}`, kind: 'ai', usesImages: false };
  }

  /** Looks up the cache, then sends everything uncached in as few requests as the limits allow. */
  async prepare(posts: InstagramPost[], _now: string): Promise<void> {
    const queue: InstagramPost[] = [];
    for (const p of posts) {
      if (!(p.caption ?? '').trim()) continue;
      const key = cacheKey(p);
      if (this.prepared.has(key)) continue;
      const hit = await this.o.cache.get(key);
      if (hit) {
        this.stats.cacheHits++;
        this.prepared.set(key, { result: { ...hit, id: p.id }, error: null, warnings: [], cacheHit: true });
      } else if (!queue.some((q) => cacheKey(q) === key)) queue.push(p);
    }
    // Spending cap: posts beyond maxPosts are never sent.
    const room = Math.max(0, this.o.maxPosts - this.stats.postsSent);
    for (const p of queue.slice(room)) {
      this.prepared.set(cacheKey(p), { result: null, error: `budget_exceeded: max ${this.o.maxPosts} posts per run`, warnings: [], cacheHit: false });
      this.stats.failedPosts++;
    }
    queue.length = Math.min(queue.length, room);
    let chunk: InstagramPost[] = [];
    let chars = 0;
    for (const p of queue) {
      const len = Math.min((p.caption ?? '').length, MAX_CAPTION_CHARS);
      if (chunk.length && (chunk.length >= this.o.batchSize || chars + len > this.o.maxBatchChars)) {
        await this.callChunk(chunk);
        chunk = [];
        chars = 0;
      }
      chunk.push(p);
      chars += len;
    }
    if (chunk.length) await this.callChunk(chunk);
  }

  private failPosts(posts: InstagramPost[], error: string) {
    for (const p of posts) this.prepared.set(cacheKey(p), { result: null, error, warnings: [], cacheHit: false });
    this.stats.failedPosts += posts.length;
  }

  /** Validates a reply (complete or cut off) and stores every item that passes. Returns the posts it could not use. */
  private async absorb(chunk: InstagramPost[], text: string, extraWarning: string | null): Promise<{ unusable: InstagramPost[]; reason: string | null }> {
    const parsed = parseBatchResponse(text);
    if (!parsed.ok) return { unusable: chunk, reason: `invalid_response: ${parsed.error}` };
    const unusable: InstagramPost[] = [];
    let reason: string | null = null;
    for (const p of chunk) {
      const item = parsed.items.get(p.id);
      if (item?.ok) {
        const warnings = [...(extraWarning ? [extraWarning] : []), ...parsed.warnings, ...item.warnings];
        this.prepared.set(cacheKey(p), { result: item.value, error: null, warnings, cacheHit: false });
        await this.o.cache.set(cacheKey(p), item.value);
      } else {
        unusable.push(p);
        reason = item ? `invalid_response: ${item.error}` : 'invalid_response: post missing from reply';
      }
    }
    return { unusable, reason };
  }

  /**
   * One request. A cut-off (truncated) reply is not thrown away: items that finished before the cut are
   * used. If `splitOnTruncation` is on, the rest are re-sent ONE post per request, once; those requests
   * count against the client's request cap, and a single-post request is never split or retried again.
   */
  private async callChunk(chunk: InstagramPost[], isFallback = false): Promise<void> {
    const user = buildUserMessage(chunk);
    if (this.halted) return this.failPosts(chunk, `skipped_after_fatal_error: ${this.halted}`);
    this.stats.llmCalls++;
    if (isFallback) this.stats.fallbackRequests++;
    else this.stats.postsSent += chunk.length;
    let text: string;
    try {
      const res = await this.o.client.complete({ system: SYSTEM_PROMPT, user, maxOutputTokens: this.o.maxOutputTokensPerPost * chunk.length, jsonSchema: AI_JSON_SCHEMA });
      text = res.text;
      this.stats.inputTokens += res.usage?.inputTokens ?? estimateTokens(SYSTEM_PROMPT + user);
      this.stats.outputTokens += res.usage?.outputTokens ?? estimateTokens(text);
      if (!res.usage) this.stats.usageIsEstimated = true;
    } catch (e) {
      if (!(e instanceof LlmClientError)) return this.failPosts(chunk, `llm_call_failed: ${safeMessage(e)}`);
      if (e.fatalForRun) this.halted = safeMessage(e);
      if (e.kind !== 'truncated') return this.failPosts(chunk, `llm_call_failed: ${safeMessage(e)}`);
      text = e.partialText ?? '';
      // The API already billed this reply; usage was counted by the client. Recover what is complete.
      this.stats.truncatedReplies++;
      const { unusable } = await this.absorb(chunk, text, 'recovered from a truncated reply');
      if (!unusable.length) return;
      if (this.o.splitOnTruncation && chunk.length > 1 && !isFallback) {
        for (const p of unusable) await this.callChunk([p], true);
        return;
      }
      return this.failPosts(unusable, `llm_call_failed: ${safeMessage(e)}`);
    }
    const { unusable, reason } = await this.absorb(chunk, text, null);
    if (unusable.length) this.failPosts(unusable, reason ?? 'invalid_response');
  }

  async extract({ post, now }: ExtractionInput): Promise<ExtractionDraft> {
    const caption = post.caption ?? '';
    if (!caption.trim()) {
      return { classification: 'unrelated', classificationNotes: ['empty caption (image-only post)'], fields: { ...EMPTY_FIELDS, artists: [] }, flags: [], details: this.details([], [], ['empty caption, no model call'], [], false) };
    }
    const key = cacheKey(post);
    if (!this.prepared.has(key)) await this.prepare([post], now);
    const entry = this.prepared.get(key)!;
    if (entry.error || !entry.result) {
      return {
        classification: 'ambiguous',
        classificationNotes: [`AI extraction unavailable: ${entry.error}`],
        fields: { ...EMPTY_FIELDS, artists: [] },
        flags: ['ai_invalid_response'],
        details: this.details([], [], [entry.error ?? 'unknown failure'], [], false),
      };
    }
    const g = groundResult(entry.result, caption, post.timestamp, now);
    return {
      classification: g.classification,
      classificationNotes: g.notes,
      fields: g.fields,
      flags: g.flags,
      details: { extractor: this.info.name, cacheHit: entry.cacheHit, evidence: g.evidence, ungroundedFields: g.ungrounded, notes: g.notes, schemaWarnings: entry.warnings },
    };
  }

  private details(ungrounded: string[], _e: string[], notes: string[], warnings: string[], cacheHit: boolean): ExtractorDetails {
    return { extractor: this.info.name, cacheHit, evidence: {}, ungroundedFields: ungrounded, notes, schemaWarnings: warnings };
  }
}

/** AI first; if the AI reply for a post is unusable, fall back to the deterministic rules for that post only. */
export class FallbackExtractor implements EventExtractor {
  readonly info: ExtractorInfo;
  private readonly primary: AiExtractor;
  private readonly fallback: EventExtractor;

  constructor(primary: AiExtractor, fallback: EventExtractor = new RulesExtractor()) {
    this.primary = primary;
    this.fallback = fallback;
    this.info = { name: `${primary.info.name} + rules fallback`, kind: 'ai', usesImages: false };
  }
  prepare(posts: InstagramPost[], now: string) {
    return this.primary.prepare(posts, now);
  }
  async extract(input: ExtractionInput): Promise<ExtractionDraft> {
    const ai = await this.primary.extract(input);
    if (!ai.flags.includes('ai_invalid_response')) return ai;
    const rules = await this.fallback.extract(input);
    return {
      ...rules,
      flags: [...new Set([...rules.flags, 'ai_invalid_response' as const])],
      details: { extractor: `rules-fallback (${this.fallback.info.name})`, cacheHit: false, evidence: {}, ungroundedFields: [], notes: ai.details?.notes ?? [], schemaWarnings: [] },
    };
  }
}
