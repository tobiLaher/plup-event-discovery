// Concrete LlmClient for the Anthropic Messages API (POST /v1/messages), written with plain fetch so
// no dependency is added. SERVER-SIDE ONLY: the key comes from the environment and must never be
// bundled into the Expo app, printed, logged or committed.
//
// Spending safeguards (all enforced before a request is sent):
//   - at most `maxRequests` requests per client instance, and NO automatic retries
//   - output tokens clamped to `maxOutputTokensPerRequest`
//   - the worst-case cost of all requests so far (input estimate + full output allowance) must stay
//     under `maxEstimatedCostUsd`
//   - after a fatal error (bad key, no credit, rate limit, overload, offline) the extractor stops sending
import { LlmClientError, redact, type LlmClient, type LlmRequest, type LlmResponse } from './llm-client.ts';
import { estimateTokens } from './ai-prompt.ts';

export const HAIKU_5_5 = 'claude-haiku-5-5';
/** USD per million tokens for prompts up to 100k tokens (Anthropic pricing page, 2026-10-14). Re-check before relying on it. */
export const HAIKU_5_5_PRICING = { inputPerMTok: 0.1, outputPerMTok: 0.5 };

export type Pricing = { inputPerMTok: number; outputPerMTok: number };
export const costUsd = (u: { inputTokens: number; outputTokens: number }, p: Pricing = HAIKU_5_5_PRICING) =>
  (u.inputTokens * p.inputPerMTok + u.outputTokens * p.outputPerMTok) / 1_000_000;

export { redact };

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export type AnthropicClientOptions = {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  maxRequests?: number;
  maxOutputTokensPerRequest?: number;
  maxEstimatedCostUsd?: number;
  pricing?: Pricing;
  /** Extraction needs no extended reasoning; thinking tokens would be billed as output. */
  disableThinking?: boolean;
  effort?: 'low' | 'medium' | 'high';
  timeoutMs?: number;
};

export class AnthropicLlmClient implements LlmClient {
  readonly simulated = false;
  readonly id: string;
  /** Totals of what the API reported. */
  readonly totals = { requests: 0, inputTokens: 0, outputTokens: 0 };
  private readonly o: Required<Omit<AnthropicClientOptions, 'apiKey'>>;
  private readonly apiKey: string;
  private worstCaseUsd = 0;

  constructor(opts: AnthropicClientOptions) {
    if (!opts.apiKey || !/^[\x21-\x7e]{20,}$/.test(opts.apiKey)) throw new LlmClientError('auth', 'a valid API key is required (set ANTHROPIC_API_KEY on the server)', { fatalForRun: true });
    this.apiKey = opts.apiKey;
    this.o = {
      model: HAIKU_5_5,
      baseUrl: 'https://api.anthropic.com',
      fetchImpl: ((url, init) => fetch(url, init)) as FetchLike,
      maxRequests: 3,
      maxOutputTokensPerRequest: 1500,
      maxEstimatedCostUsd: 0.05,
      pricing: HAIKU_5_5_PRICING,
      disableThinking: true,
      effort: 'low',
      timeoutMs: 60_000,
      ...opts,
    };
    this.id = this.o.model;
  }

  /** What has been spent so far according to the usage the API reported. */
  get spentUsd() {
    return costUsd({ inputTokens: this.totals.inputTokens, outputTokens: this.totals.outputTokens }, this.o.pricing);
  }

  async complete(req: LlmRequest): Promise<LlmResponse> {
    const maxTokens = Math.min(req.maxOutputTokens, this.o.maxOutputTokensPerRequest);
    const worst = costUsd({ inputTokens: estimateTokens(req.system + req.user) * 1.2, outputTokens: maxTokens }, this.o.pricing);
    if (this.totals.requests >= this.o.maxRequests) throw new LlmClientError('budget', `request limit reached (${this.o.maxRequests})`, { fatalForRun: true });
    if (this.worstCaseUsd + worst > this.o.maxEstimatedCostUsd) {
      throw new LlmClientError('budget', `worst-case cost would exceed $${this.o.maxEstimatedCostUsd.toFixed(2)}`, { fatalForRun: true });
    }
    this.worstCaseUsd += worst;
    this.totals.requests++;

    const body = {
      model: this.o.model,
      max_tokens: maxTokens,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
      // No temperature/top_p: non-default sampling values are rejected by this model family.
      ...(this.o.disableThinking ? { thinking: { type: 'disabled' } } : {}),
      output_config: { effort: this.o.effort },
    };

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.o.timeoutMs);
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.o.fetchImpl(`${this.o.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
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

    const content = data?.content;
    if (!Array.isArray(content) || typeof data?.usage?.input_tokens !== 'number' || typeof data?.usage?.output_tokens !== 'number') {
      throw new LlmClientError('bad_response', 'unexpected success response shape');
    }
    // Usage is recorded even if the content turns out to be unusable: it was billed.
    const usage = { inputTokens: data.usage.input_tokens as number, outputTokens: data.usage.output_tokens as number };
    this.totals.inputTokens += usage.inputTokens;
    this.totals.outputTokens += usage.outputTokens;
    if (data.stop_reason === 'refusal') throw new LlmClientError('refusal', 'model declined the request');
    const text = content.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text as string).join('');
    if (data.stop_reason === 'max_tokens') throw new LlmClientError('truncated', `reply cut off at ${maxTokens} output tokens`, { partialText: text });
    return { text, usage };
  }

  private apiError(status: number, data: any, retryAfter: string | null): LlmClientError {
    const type = typeof data?.error?.type === 'string' ? data.error.type : 'unknown_error';
    const msg = redact(typeof data?.error?.message === 'string' ? data.error.message : 'no error details').slice(0, 200);
    const retryAfterSec = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) : null;
    const opts = { status, retryAfterSec };
    if (status === 401 || status === 403) return new LlmClientError('auth', `${type}: ${msg}`, { ...opts, fatalForRun: true });
    if (status === 429) return new LlmClientError('rate_limit', `${type}: ${msg}`, { ...opts, fatalForRun: true });
    if (status === 529) return new LlmClientError('overloaded', `${type}: ${msg}`, { ...opts, fatalForRun: true });
    if (status === 404) return new LlmClientError('not_found', `${type}: ${msg} (check the model id)`, { ...opts, fatalForRun: true });
    if (status === 413) return new LlmClientError('too_large', `${type}: ${msg}`, opts);
    if (status === 400 && /credit balance|billing/i.test(msg)) return new LlmClientError('billing', msg, { ...opts, fatalForRun: true });
    if (status === 400) return new LlmClientError('bad_request', `${type}: ${msg}`, opts);
    if (status === 402) return new LlmClientError('billing', msg, { ...opts, fatalForRun: true });
    return new LlmClientError('server', `${type}: ${msg}`, opts);
  }
}
