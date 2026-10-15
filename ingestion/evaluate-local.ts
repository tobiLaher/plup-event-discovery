// Evaluates the local, git-ignored real posts for automatic publishing. Read-only: no network,
// no credentials, nothing is published. Usage: node ingestion/evaluate-local.ts [--now <ISO>]
//
// Two runs are shown:
//  1. rules-v0 extractor on the raw posts (real, deterministic)
//  2. SIMULATED adapter replaying the hand-authored extraction in ai-assisted-candidates.json
//     (made by Claude Code at development time; it is not a runtime AI integration)
import { existsSync, readFileSync } from 'node:fs';
import { SimulatedExtractor } from './simulated-extractor.ts';
import { ingest } from './pipeline.ts';
import { evaluateBatch, summarize } from './publishing.ts';
import { RulesExtractor } from './rules-extractor.ts';
import type { EventExtractor } from './extractor.ts';
import type { ExtractionDraft, InstagramPost } from './types.ts';

const args = process.argv.slice(2);
const nowIdx = args.indexOf('--now');
const now = nowIdx >= 0 ? args[nowIdx + 1] : new Date().toISOString();
const posts = JSON.parse(readFileSync('ingestion/local/real-posts.json', 'utf8')) as InstagramPost[];

async function report(label: string, extractor: EventExtractor) {
  const run = await ingest(posts, extractor, { now });
  const decisions = evaluateBatch(run.items, { now, extractor: run.extractor });
  console.log(`\n=== ${label} (${run.extractor.kind}) ===`);
  console.log(JSON.stringify({ policy: 'unattendedPublishingEnabled=false', ...summarize(decisions) }));
  for (const d of decisions) console.log(`${d.postId}  ${d.decision.padEnd(8)} action=${d.action.padEnd(6)} ${d.summary}${d.mergedSourcePostIds.length ? ` (merged: ${d.mergedSourcePostIds.join(',')})` : ''}`);
}

await report('rules extractor on real posts', new RulesExtractor());

const file = 'ingestion/local/ai-assisted-candidates.json';
if (existsSync(file)) {
  const { candidates } = JSON.parse(readFileSync(file, 'utf8'));
  const drafts: Record<string, Partial<ExtractionDraft>> = {};
  for (const c of candidates) {
    const flags = c.dateNote ? (['year_inferred'] as const) : [];
    for (const s of c.sources) {
      drafts[s.postId] = {
        classification: 'upcoming_event',
        classificationNotes: ['simulated: replayed from hand-authored candidates'],
        flags: [...flags],
        fields: {
          name: c.name, nameQuality: 'derived', category: c.category, date: c.date, endDate: c.endDate, startTime: c.startTime,
          venueName: c.venueName, venueArea: c.venueArea, artists: c.artists, genre: c.genre, ticketPrice: c.ticketPrice, ticketUrl: c.ticketUrl,
        },
      };
    }
  }
  await report('SIMULATED AI-assisted replay (hand-authored, not runtime AI)', new SimulatedExtractor(drafts));
}
