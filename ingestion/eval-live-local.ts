// LIVE evaluation of a real model on the 10 stored real posts. NOT a benchmark: 10 posts, all from
// one promoter, scored against a reference the same person (Claude Code) wrote. It checks that the
// pipeline works end to end with a real model and gives a first, rough read on field quality.
//
// SAFE BY DEFAULT: without --confirm-spend this only prints the plan and sends nothing; it does not
// even read your API key.
//
//   npm run ingest:eval-live                          # dry run (Gemini free tier)
//   npm run ingest:eval-live -- --confirm-spend       # makes the real calls
//   npm run ingest:eval-live -- --provider anthropic  # the paid Anthropic client (kept, unused by default)
//   npm run ingest:eval-live -- --model gemini-3.1-flash-lite
//
// Strategy: 2 posts per request (5 requests for 10 posts). If a reply is cut off at the output limit, the
// items it finished are kept and only the unfinished posts are re-sent one per request, once, inside the
// request cap. Hard limits: <= 10 posts, <= 8 requests total, throttled, worst-case cap, never any publishing.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { AiExtractor } from './ai-extractor.ts';
import { buildUserMessage, estimateTokens, SYSTEM_PROMPT } from './ai-prompt.ts';
import { AnthropicLlmClient, costUsd, HAIKU_5_5, HAIKU_5_5_PRICING } from './anthropic-client.ts';
import { EVAL_BATCH_SIZE, EVAL_MAX_COST_USD, EVAL_MAX_POSTS, EVAL_MAX_REQUESTS, EVAL_OUTPUT_PER_POST, EVAL_OUTPUT_PER_REQUEST } from './eval-limits.ts';
import { EVAL_NOW, formatScore, loadPosts, loadReference, scoreExtractor } from './eval-lib.ts';
import { DEFAULT_GEMINI_MODEL, GEMINI_FREE_TIER_MODELS, GEMINI_PAID_REFERENCE_PRICING, GeminiLlmClient } from './gemini-client.ts';
import { redact, type LlmClient, type LlmRequest } from './llm-client.ts';
import { resolveSecret } from './local-env.ts';
import { ingest } from './pipeline.ts';
import { evaluateBatch, summarize } from './publishing.ts';

const MAX_POSTS = EVAL_MAX_POSTS;
const BATCH = EVAL_BATCH_SIZE;
const MAX_REQUESTS = EVAL_MAX_REQUESTS;
const MAX_COST_USD = EVAL_MAX_COST_USD;
const OUTPUT_PER_POST = EVAL_OUTPUT_PER_POST;
const MAX_OUTPUT_PER_REQUEST = EVAL_OUTPUT_PER_REQUEST;

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const confirm = args.includes('--confirm-spend');
const provider = (flag('--provider') ?? 'gemini') as 'gemini' | 'anthropic';
if (provider !== 'gemini' && provider !== 'anthropic') throw new Error('--provider must be gemini or anthropic');

const gemini = provider === 'gemini';
const model = gemini ? (flag('--model') ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL) : HAIKU_5_5;
if (gemini && !(GEMINI_FREE_TIER_MODELS as readonly string[]).includes(model)) {
  console.error(`Model "${model}" is not on the free-tier allowlist: ${GEMINI_FREE_TIER_MODELS.join(', ')}. Nothing was sent.`);
  process.exit(2);
}
const secretName = gemini ? 'GEMINI_API_KEY' : 'ANTHROPIC_API_KEY';
const keyFile = gemini ? 'ingestion/local/gemini.env' : 'ingestion/local/anthropic.env';

const posts = loadPosts().slice(0, MAX_POSTS);
const ref = loadReference();
const batches = Math.ceil(posts.length / BATCH);
const inputEst = Array.from({ length: batches }, (_, i) =>
  estimateTokens(SYSTEM_PROMPT) + estimateTokens(buildUserMessage(posts.slice(i * BATCH, i * BATCH + BATCH)))).reduce((a, b) => a + b, 0);
const pricing = gemini ? GEMINI_PAID_REFERENCE_PRICING[model] : HAIKU_5_5_PRICING;
const worst = costUsd({ inputTokens: inputEst * 1.2 * (MAX_REQUESTS / batches), outputTokens: MAX_REQUESTS * MAX_OUTPUT_PER_REQUEST }, pricing);

console.log(`Provider: ${provider} | model: ${model} | posts: ${posts.length} (max ${MAX_POSTS}) | requests: ${batches} of ${BATCH} posts (cap ${MAX_REQUESTS}, extra only for one-post fallbacks after a cut-off reply) | output limit ${MAX_OUTPUT_PER_REQUEST} tokens/request`);
if (gemini) {
  console.log(`Tier: FREE (no billing). Requests are throttled to one every 6 s (about ${Math.ceil((batches * 6) / 6) / 10} min for the base ${batches}); a 429 quota error stops the run. Do not enable billing.`);
  console.log(`Estimated input ~${inputEst} tokens. Billed cost on the free tier: $0. If the project were on the paid tier the worst case would be ~$${worst.toFixed(4)}.`);
  console.log('Note: on the free tier Google may use submitted content to improve its products. These are public captions; do not send private data.');
} else {
  console.log(`Estimated input ~${inputEst} tokens. Worst case ~$${worst.toFixed(4)} (hard cap $${MAX_COST_USD}). Paid API.`);
}

if (!confirm) {
  console.log('\nDRY RUN: nothing was sent and no API key was read. Add --confirm-spend to make the real calls.');
  process.exit(0);
}

const { key, source } = resolveSecret(secretName, process.env, existsSync(keyFile) ? readFileSync(keyFile, 'utf8') : null);
if (!key) {
  console.error(`\nNo ${secretName} found. Set it in this terminal session (see ingestion/README.md), then run again. Nothing was sent.`);
  process.exit(2);
}
console.log(`\n${secretName} found via: ${source} (value never printed). Making real calls...`);

const real = gemini
  ? new GeminiLlmClient({ apiKey: key, model, maxRequests: MAX_REQUESTS, maxOutputTokensPerRequest: MAX_OUTPUT_PER_REQUEST, maxEstimatedCostUsd: MAX_COST_USD })
  : new AnthropicLlmClient({ apiKey: key, maxRequests: MAX_REQUESTS, maxOutputTokensPerRequest: MAX_OUTPUT_PER_REQUEST, maxEstimatedCostUsd: MAX_COST_USD });
const replies: { request: number; text: string }[] = [];
const recording: LlmClient = {
  id: real.id,
  simulated: false,
  async complete(req: LlmRequest) {
    const res = await real.complete(req);
    replies.push({ request: replies.length + 1, text: res.text });
    return res;
  },
};

const extractor = new AiExtractor({ client: recording, batchSize: BATCH, maxPosts: MAX_POSTS, maxOutputTokensPerPost: OUTPUT_PER_POST, splitOnTruncation: true });
const run = await ingest(posts, extractor, { now: EVAL_NOW });
const decisions = evaluateBatch(run.items, { now: EVAL_NOW, extractor: run.extractor });
const scored = await scoreExtractor(extractor, posts, ref); // reuses the replies already received: no new calls

const referenceCost = costUsd({ inputTokens: real.totals.inputTokens, outputTokens: real.totals.outputTokens }, pricing);
console.log(`\nLIVE RESULT (${posts.length} posts, one promoter, NOT a benchmark)`);
console.log('  ' + formatScore(scored.score));
console.log(`  API usage: ${real.totals.requests} request(s), ${real.totals.inputTokens} input + ${real.totals.outputTokens} output tokens | truncated replies: ${extractor.stats.truncatedReplies}, one-post fallbacks: ${extractor.stats.fallbackRequests}`);
console.log(gemini ? `  billed: $0 on the free tier (paid-tier reference would be ~$${referenceCost.toFixed(5)})` : `  cost ~$${referenceCost.toFixed(5)}`);
const failed = scored.rows.filter((r) => r.got !== r.expected);
if (failed.length) console.log('  misclassified: ' + failed.map((r) => `${r.id} expected ${r.expected}, got ${r.got}`).join(' | '));
const bad = scored.rows.filter((r) => r.flags.includes('ai_invalid_response'));
if (bad.length) console.log(`  unusable model replies: ${bad.length} (${bad.map((r) => redact(r.notes.join(' '))).join(' | ').slice(0, 240)})`);
console.log('  publishing engine (unattended publishing OFF): ' + JSON.stringify(summarize(decisions)));

mkdirSync('ingestion/local', { recursive: true });
const file = `ingestion/local/live-eval-${provider}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(file, JSON.stringify({
  note: 'Real model run on 10 posts from one promoter; scored against a hand-written reference. Not a benchmark.',
  provider, model, at: new Date().toISOString(), apiUsage: real.totals, paidTierReferenceCostUsd: referenceCost, billedUsd: gemini ? 0 : referenceCost,
  score: scored.score, rows: scored.rows,
  decisions: decisions.map((d) => ({ postId: d.postId, decision: d.decision, action: d.action, blockers: d.blockers, warnings: d.warnings, summary: d.summary })),
  rawModelReplies: replies,
}, null, 2));
console.log(`  full results saved to ${file} (git-ignored)`);
