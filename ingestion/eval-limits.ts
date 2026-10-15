// Limits for the live evaluation, in one place so tests can pin them down.
// Observed on the first Gemini runs: pretty-printed items cost about 250-450 output tokens each (the API
// bills ~1.35x what chars/4 suggests), and 5 posts at 300 tokens each (1,500 total) was cut off.
// 700 per post also covers a deliberately extreme item (every evidence string at its 60-character limit).
export const EVAL_MAX_POSTS = 10;
export const EVAL_BATCH_SIZE = 2;
export const EVAL_BASE_REQUESTS = Math.ceil(EVAL_MAX_POSTS / EVAL_BATCH_SIZE);
/** Extra one-post requests allowed after a cut-off reply. */
export const EVAL_FALLBACK_REQUESTS = 3;
export const EVAL_MAX_REQUESTS = EVAL_BASE_REQUESTS + EVAL_FALLBACK_REQUESTS;
export const EVAL_OUTPUT_PER_POST = 700;
export const EVAL_OUTPUT_PER_REQUEST = EVAL_OUTPUT_PER_POST * EVAL_BATCH_SIZE;
export const EVAL_MAX_COST_USD = 0.05;
/** Gemini client throttle: one request every 6 s is about 10 per minute. */
export const EVAL_MIN_INTERVAL_MS = 6000;
