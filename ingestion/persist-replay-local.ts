// OFFLINE demo: replays the raw model replies saved by a live evaluation through the persistence service
// using the IN-MEMORY store. No network, no database, no API key, nothing published (unattended
// publishing OFF). It shows what would be stored for the 10 real posts. Usage:
//   node ingestion/persist-replay-local.ts ingestion/local/live-eval-gemini-<time>.json
import { readFileSync } from 'node:fs';
import { AiExtractor } from './ai-extractor.ts';
import { ScriptedLlmClient } from './ai-mock.ts';
import { EVAL_NOW, loadPosts } from './eval-lib.ts';
import { MemoryPersistence } from './persistence/memory-store.ts';
import { persistIngestion } from './persistence/sync.ts';
import { VenueResolver } from './venue-resolver.ts';

const file = process.argv[2];
if (!file) throw new Error('give the saved live-eval JSON file');
const saved = JSON.parse(readFileSync(file, 'utf8')) as { model: string; rawModelReplies: { text: string }[] };
const posts = loadPosts().slice(0, 10);

let n = 0;
const client = new ScriptedLlmClient(() => saved.rawModelReplies[n++]?.text ?? '', `replay-of-${saved.model}`);
const store = new MemoryPersistence(() => new Date(EVAL_NOW));
const extractor = new AiExtractor({ client, cache: store, batchSize: 2 });
const report = await persistIngestion(posts, { store, extractor, resolver: new VenueResolver({ store, providers: [] }), now: EVAL_NOW });

console.log(`REPLAY of ${saved.rawModelReplies.length} saved ${saved.model} replies into the in-memory store (not a database, not a model run)`);
console.log('summary:', JSON.stringify(report.summary));
console.log('stored: organizers', store.organizers.size, '| source posts', store.sourcePosts.size, '| candidates', store.candidates.size, '| public events', store.events.size, '| run logs', store.logs.length);
for (const p of report.posts) console.log(`  ${p.postId}  ${p.decision.padEnd(8)} action=${p.action.padEnd(6)} event=${p.eventKey ?? '-'}`);
console.log('visible to the public map:', (await store.listPublicEvents('2026-10-14')).length, 'events (publishing is OFF)');
