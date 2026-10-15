// TEST DOUBLE. A scripted "language model" for tests and plumbing checks. It performs no
// understanding at all: it returns whatever text the script gives it. Anything produced through
// it demonstrates our validation and grounding code, never the accuracy of a real model.
import type { LlmClient, LlmRequest, LlmResponse } from './llm-client.ts';

export class ScriptedLlmClient implements LlmClient {
  readonly id: string;
  readonly simulated = true;
  readonly requests: LlmRequest[] = [];
  private readonly respond: (req: LlmRequest, call: number) => string | Promise<string>;

  constructor(respond: (req: LlmRequest, call: number) => string | Promise<string>, id = 'scripted-test-model') {
    this.respond = respond;
    this.id = id;
  }
  get calls() {
    return this.requests.length;
  }
  async complete(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(req);
    return { text: await this.respond(req, this.requests.length) };
  }
}

/** The posts the extractor sent, decoded from the JSON user message. */
export const sentPosts = (req: LlmRequest) => JSON.parse(req.user) as { id: string; postedOn: string; caption: string }[];
