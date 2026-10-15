// Runs a local, git-ignored Instagram export through the pipeline and prints a compact summary
// (no full captions). Usage: node ingestion/analyze-local.ts [path] [--now <ISO>]
import { readFileSync } from 'node:fs';
import { ingest } from './pipeline.ts';
import { RulesExtractor } from './rules-extractor.ts';
import type { InstagramPost } from './types.ts';

const args = process.argv.slice(2);
const nowIdx = args.indexOf('--now');
const now = nowIdx >= 0 ? args[nowIdx + 1] : new Date().toISOString();
const file = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--now') ?? 'ingestion/local/real-posts.json';

const posts = JSON.parse(readFileSync(file, 'utf8')) as InstagramPost[];
const result = await ingest(posts, new RulesExtractor(), { now });
console.log(JSON.stringify({ file, now, summary: result.summary }, null, 2));
for (const i of result.items) {
  const c = i.candidate;
  console.log(
    [i.postId, i.classification, i.reviewStatus, i.reviewReasons.join(',') || '-', c ? `${c.name ?? '?'} | ${c.date ?? '?'} ${c.startTime ?? '?'} | ${c.venueName ?? '?'} | ${c.artists.join('/') || '-'} | ${c.ticketPrice?.rawText ?? '-'} | ${c.ticketUrl ?? '-'}` : ''].join('  '),
  );
}
