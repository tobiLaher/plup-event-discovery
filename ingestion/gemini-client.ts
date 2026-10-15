// LlmClient for Google's Gemini API (generateContent) on the FREE TIER, using plain fetch.
// SERVER-SIDE ONLY. The key comes from GEMINI_API_KEY in the environment, is sent only in the
// `x-goog-api-key` header (never in the URL, so it can't leak through logged URLs or fetch errors),
// and is never printed, stored or put in an error.
//
// Free-tier discipline (all enforced before a request is sent):
//   - only models on a free-tier allowlist can be selected, so a paid model can't be picked by accident
//   - a client-side throttle (default one request every 6 s, ~10/min) stays under typical free limits
//     (Google publishes the exact numbers only in AI Studio, so they are not hard-coded here)
//   - at most `maxRequests` per client, output tokens clamped, NO automatic retries
//   - a 429 (quota) or 503 stops the rest of the run instead of hammering the API
// Billing: a key from a Google project WITHOUT billing enabled is on the free tier; quota exhaustion
// then returns 429 and nothing is charged. This client cannot see your billing status; do not enable it.
import { estimateTokens } from './ai-prompt.ts';
import { LlmClientError, redact, type LlmClient, type LlmRequest, type LlmResponse } from './llm-client.ts';

/**
 * Converts our JSON Schema into Gemini's `responseSchema` (an OpenAPI-style subset): upper-case type names,
 * `nullable: true` instead of a "null" type, and no null inside enums.
 */
export function toGeminiSchema(node: any): any {
  const types: string[] = Array.isArray(node.type) ? node.type : [node.type];
  const out: any = { type: String(types.find((t) => t !== 'null')).toUpperCase() };
  if (types.includes('null')) out.nullable = true;
  if (node.enum) out.enum = node.enum.filter((v: unknown) => v !== null);
  if (node.properties) {
    out.properties = Object.fromEntries(Object.entries(node.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    out.propertyOrdering = Object.keys(node.properties);
    if (node.required) out.required = node.required;
  }
  if (node.items) out.items = toGeminiSchema(node.items);
  return out;
}

/**
 * Flash-Lite models that Google lists as free of charge on the Free tier (pricing page, 2026-10-14).
 * gemini-3.5-flash-lite is Google's recommended model for new projects. Google says gemini-2.5-flash-lite
 * is "limited to users who have actively used" 2.5 models before, so a brand-new key may get a 404 on it.
 */
export const GEMINI_FREE_TIER_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'gemini-2.5-flash-lite'] as const;
export const DEFAULT_GEMINI_MODEL = 'gemini-3.5-flash-lite';

/** USD per million tokens if the project were ever on the PAID tier. The free tier bills $0. For worst-case planning only. */
export const GEMINI_PAID_REFERENCE_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  'gemini-3.5-flash-lite': { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  'gemini-3.1-flash-lite': { inputPerMTok: 0.25, outputPerMTok: 1.5 },
  'gemini-2.5-flash-lite': { inputPerMTok: 0.1, outputPerMTok: 0.4 },
};

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export type GeminiClientOptions = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  maxRequests?: number;
  maxOutputTokensPerRequest?: number;
  /** Worst-case cost cap, computed with the PAID reference prices as a safety net even though the free tier bills $0. */
  maxEstimatedCostUsd?: number;
  /** Minimum gap between requests. */
  minIntervalMs?: number;
  timeoutMs?: number;
  /** Send the reply schema (constrained decoding). Turn off only if the API rejects it. Default true. */
  useResponseSchema?: boolean;
  sleep?: (ms: number) => Promise<void>;
  clock?: () => number;
};

export class GeminiLlmClient implements LlmClient {
  readonly simulated = false;
  readonly id: string;
  readonly totals = { requests: 0, inputTokens: 0, outputTokens: 0 };
  private readonly o: Required<Omit<GeminiClientOptions, 'apiKey'>>;
  private readonly apiKey: string;
  private worstCaseUsd = 0;
  private lastSentAt = Number.NEGATIVE_INFINITY;

  constructor(opts: GeminiClientOptions) {
    // AI Studio keys start with "AIza"; accept any plausible token so a format change doesn't block use.
    if (!opts.apiKey || !/^[\x21-\x7e]{20,}$/.test(opts.apiKey)) throw new LlmClientError('auth', 'a valid API key is required (set GEMINI_API_KEY on the server)', { fatalForRun: true });
    const model = opts.model ?? DEFAULT_GEMINI_MODEL;
    if (!(GEMINI_FREE_TIER_MODELS as readonly string[]).includes(model)) {
      throw new LlmClientError('bad_request', `model "${model}" is not on the free-tier allowlist (${GEMINI_FREE_TIER_MODELS.join(', ')})`, { fatalForRun: true });
    }
    this.apiKey = opts.apiKey;
    this.o = {
      model,
      baseUrl: 'https://generativelanguage.googleapis.com',
      fetchImpl: ((url, init) => fetch(url, init)) as FetchLike,
      maxRequests: 3,
      maxOutputTokensPerRequest: 1500,
      maxEstimatedCostUsd: 0.05,
      minIntervalMs: 6000,
      timeoutMs: 60_000,
      useResponseSchema: true,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      clock: Date.now,
      ...opts,
    };
    this.id = this.o.model;
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const maxTokens = Math.min(req.maxOutputTokens, this.o.maxOutputTokensPerRequest);
    const price = GEMINI_PAID_REFERENCE_PRICING[this.o.model];
    const worst = ((estimateTokens(req.system + req.user) * 1.2) * price.inputPerMTok + maxTokens * price.outputPerMTok) / 1_000_000;
    if (this.totals.requests >= this.o.maxRequests) throw new LlmClientError('budget', `request limit reached (${this.o.maxRequests})`, { fatalForRun: true });
    if (this.worstCaseUsd + worst > this.o.maxEstimatedCostUsd) {
      throw new LlmClientError('budget', `worst-case cost (paid-tier reference) would exceed $${this.o.maxEstimatedCostUsd.toFixed(2)}`, { fatalForRun: true });
    }
    const wait = this.lastSentAt + this.o.minIntervalMs - this.o.clock();
    if (wait > 0) await this.o.sleep(wait);
    this.lastSentAt = this.o.clock();
    this.worstCaseUsd += worst;
    this.totals.requests++;

    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: [{ role: 'user', parts: [{ text: req.user }] }],
      // No thinkingConfig: Flash-Lite models default to minimal/no thinking, and thinking tokens would count toward this limit.
      // responseSchema makes Gemini generate structurally valid JSON; with only a mime type it can still emit broken JSON.
      generationConfig: {
        maxOutputTokens: maxTokens,
        responseMimeType: 'application/json',
        ...(this.o.useResponseSchema && req.jsonSchema ? { responseSchema: toGeminiSchema(req.jsonSchema) } : {}),
      },
    };

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.o.fetchImpl(`${this.o.baseUrl}/v1beta/models/${this.o.model}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': this.apiKey, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
    } catch (e) {
      throw new LlmClientError('network', ctl.signal.aborted ? `request timed out after ${this.o.timeoutMs} ms` : redact(e instanceof Error ? e.message : 'network error'), { fatalForRun: true });
    } finally {
      clearTimeout(timer);
    }

    let data: any = null;
    try {
      data = await res.json();
    } catch {
      /* non-JSON body handled below */
    }
    if (!res.ok) throw this.apiError(res.status, data, res.headers.get('retry-after'));

    const usageMeta = data?.usageMetadata;
    if (typeof usageMeta?.promptTokenCount !== 'number') {
      // A blocked prompt can come back as 200 with no candidates and no usage.
      const block = data?.promptFeedback?.blockReason;
      if (block) throw new LlmClientError('refusal', `prompt blocked: ${String(block).slice(0, 40)}`);
      throw new LlmClientError('bad_response', 'unexpected success response shape');
    }
    // Thinking tokens, if any, are billed and limited as output tokens.
    const usage = { inputTokens: usageMeta.promptTokenCount as number, outputTokens: ((usageMeta.candidatesTokenCount ?? 0) + (usageMeta.thoughtsTokenCount ?? 0)) as number };
    this.totals.inputTokens += usage.inputTokens;
    this.totals.outputTokens += usage.outputTokens;

    const cand = data?.candidates?.[0];
    if (!cand) throw new LlmClientError('refusal', `no candidate returned${data?.promptFeedback?.blockReason ? ` (${String(data.promptFeedback.blockReason).slice(0, 40)})` : ''}`);
    const finish = cand.finishReason as string | undefined;
    if (finish === 'MAX_TOKENS') {
      const partial = Array.isArray(cand.content?.parts) ? cand.content.parts.filter((p: any) => typeof p?.text === 'string' && !p.thought).map((p: any) => p.text as string).join('') : '';
      throw new LlmClientError('truncated', `reply cut off at ${maxTokens} output tokens`, { partialText: partial });
    }
    if (finish && finish !== 'STOP') throw new LlmClientError('refusal', `finish reason ${String(finish).slice(0, 40)}`);
    const parts = cand.content?.parts;
    if (!Array.isArray(parts)) throw new LlmClientError('bad_response', 'reply has no content parts');
    // Parts flagged as thoughts are not part of the answer.
    const text = parts.filter((p: any) => typeof p?.text === 'string' && !p.thought).map((p: any) => p.text as string).join('');
    return { text, usage };
  }

  private apiError(status: number, data: any, retryAfter: string | null): LlmClientError {
    const g = data?.error;
    const gstatus = typeof g?.status === 'string' ? g.status : 'UNKNOWN';
    const msg = redact(typeof g?.message === 'string' ? g.message : 'no error details').slice(0, 200);
    // Google reports the suggested wait as RetryInfo.retryDelay, e.g. "30s".
    const info = Array.isArray(g?.details) ? g.details.find((d: any) => typeof d?.retryDelay === 'string') : null;
    const delay = info ? Number.parseFloat(info.retryDelay) : retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : NaN;
    const opts = { status, retryAfterSec: Number.isFinite(delay) ? Math.ceil(delay) : null };
    const text = `${gstatus}: ${msg}`;
    if (status === 429) return new LlmClientError('rate_limit', `${text} (free-tier quota; wait or lower usage, do not enable billing)`, { ...opts, fatalForRun: true });
    if (status === 503) return new LlmClientError('overloaded', text, { ...opts, fatalForRun: true });
    if (status === 401 || status === 403 || (status === 400 && /api key|leaked/i.test(msg))) return new LlmClientError('auth', text, { ...opts, fatalForRun: true });
    if (status === 404) return new LlmClientError('not_found', `${text} (model unavailable for this key; try gemini-3.1-flash-lite)`, { ...opts, fatalForRun: true });
    if (status === 402) return new LlmClientError('billing', text, { ...opts, fatalForRun: true });
    if (status === 413) return new LlmClientError('too_large', text, opts);
    if (status === 400) return new LlmClientError('bad_request', /schema/i.test(msg) ? `${text} (the reply schema was rejected; set useResponseSchema: false)` : text, opts);
    return new LlmClientError('server', text, opts);
  }
}
