// Prints structured JSON for the fixtures. Usage: node ingestion/cli.ts [--now <ISO>] [--recap-only|--synthetic-only]
// Makes no network calls and reads no credentials.
import { FIXTURE_NOW, RECAP_FIXTURE_POSTS, SYNTHETIC_POSTS } from './fixtures.ts';
import { ingest } from './pipeline.ts';
import { RulesExtractor } from './rules-extractor.ts';

const args = process.argv.slice(2);
const nowIdx = args.indexOf('--now');
const now = nowIdx >= 0 ? args[nowIdx + 1] : FIXTURE_NOW;
const posts = args.includes('--recap-only')
  ? RECAP_FIXTURE_POSTS
  : args.includes('--synthetic-only')
    ? SYNTHETIC_POSTS
    : [...RECAP_FIXTURE_POSTS, ...SYNTHETIC_POSTS];

const result = await ingest(posts, new RulesExtractor(), { now });
console.log(JSON.stringify(result, null, 2));
