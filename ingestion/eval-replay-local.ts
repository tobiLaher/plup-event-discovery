// OFFLINE replay: feeds the raw replies saved by a past live evaluation back through the CURRENT parser,
// grounding and publishing checks. No network, no API key, no cost. It shows what code changes do to
// the same real model output; it is NOT a new model run. Usage:
//   node ingestion/eval-replay-local.ts ingestion/local/live-eval-<provider>-<time>.json
import { readFileSync } from 'node:fs';
import { AiExtractor } from './ai-extractor.ts';
import { ScriptedLlmClient } from './ai-mock.ts';
import { EVAL_NOW, formatScore, loadPosts, loadReference, scoreExtractor } from './eval-lib.ts';
import { ingest } from './pipeline.ts';
import { evaluateBatch, summarize } from './publishing.ts';

const file = process.argv[2];
if (!file) throw new Error('give the saved live-eval JSON file');
const saved = JSON.parse(readFileSync(file, 'utf8')) as { provider: string; model: string; score: unknown; rawModelReplies: { text: string }[] };
const posts = loadPosts().slice(0, 10);
const ref = loadReference();

let n = 0;
const client = new ScriptedLlmClient(() => saved.rawModelReplies[n++]?.text ?? '', `replay-of-${saved.model}`);
const ex = new AiExtractor({ client, batchSize: 5, maxPosts: 10 });
const run = await ingest(posts, ex, { now: EVAL_NOW });
const decisions = evaluateBatch(run.items, { now: EVAL_NOW, extractor: run.extractor });
const scored = await scoreExtractor(ex, posts, ref);

console.log(`REPLAY of saved ${saved.provider}/${saved.model} replies (${saved.rawModelReplies.length}) through the current code. Not a new model run.`);
console.log('  before (as saved): ' + JSON.stringify(saved.score));
console.log('  now:               ' + formatScore(scored.score));
const wrong = scored.rows.filter((r) => r.got !== r.expected);
console.log('  still misclassified: ' + (wrong.length ? wrong.map((r) => `${r.id} expected ${r.expected}, got ${r.got}`).join(' | ') : 'none'));
console.log('  failed items: ' + scored.rows.filter((r) => r.flags.includes('ai_invalid_response')).length);
console.log('  publishing (unattended OFF): ' + JSON.stringify(summarize(decisions)));
