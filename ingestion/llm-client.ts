// The only thing the AI extractor knows about a language model. A concrete client (any vendor,
// or a local model) implements this in a few lines of fetch; no vendor SDK or API is chosen here.
export type LlmRequest = {
  system: string;
  /** The untrusted data, already serialized as JSON by the prompt builder. */
  user: string;
  maxOutputTokens: number;
  /** Optional JSON Schema of the expected reply. Clients that support constrained decoding use it; others ignore it. */
  jsonSchema?: Record<string, unknown>;
};

export type LlmResponse = {
  text: string;
  usage?: { inputTokens: number; outputTokens: number };
};

export interface LlmClient {
  readonly id: string;
  /** True for test doubles. Their output must never be reported as live model accuracy. */
  readonly simulated: boolean;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export type LlmErrorKind =
  | 'auth' | 'billing' | 'not_found' | 'rate_limit' | 'overloaded' | 'bad_request' | 'too_large'
  | 'server' | 'network' | 'truncated' | 'refusal' | 'bad_response' | 'budget';

/**
 * A model-call failure with no secrets in it. `fatalForRun` means "stop sending requests for the
 * rest of this run" (bad credentials, no credit, rate limited, overloaded, offline, budget hit),
 * so one broken setting can't turn into a stream of failing or billable calls.
 */
export class LlmClientError extends Error {
  readonly kind: LlmErrorKind;
  readonly status: number | null;
  readonly retryAfterSec: number | null;
  readonly fatalForRun: boolean;
  /** For `truncated`: the text received before the cut, so complete items can still be recovered. Not enumerable, never in the message. */
  readonly partialText!: string | null;

  constructor(kind: LlmErrorKind, message: string, opts: { status?: number; retryAfterSec?: number | null; fatalForRun?: boolean; partialText?: string | null } = {}) {
    super(`[${kind}${opts.status ? ` ${opts.status}` : ''}] ${message}`);
    this.name = 'LlmClientError';
    this.kind = kind;
    this.status = opts.status ?? null;
    this.retryAfterSec = opts.retryAfterSec ?? null;
    this.fatalForRun = opts.fatalForRun ?? false;
    Object.defineProperty(this, 'partialText', { value: opts.partialText ?? null, enumerable: false });
  }
}

/** Removes anything credential-shaped from text before it can reach an error, log or file. */
export const redact = (s: string) =>
  s.replace(/sk-ant-[A-Za-z0-9_\-]+/g, '[redacted-key]').replace(/AIza[A-Za-z0-9_\-]{20,}/g, '[redacted-key]').replace(/[A-Za-z0-9_\-]{32,}/g, '[redacted]');
