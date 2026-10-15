// Local evaluation against a hand-written reference (ingestion/local/*, git-ignored). Prints:
//  A. rules extractor vs reference  (REAL measurement of the deterministic extractor)
//  B. AI adapter PLUMBING test      (scripted replies derived from the reference; proves our
//                                    validation/grounding keeps correct facts and drops lies.
//                                    This is NOT the accuracy of any real language model.)
//  C. AI adapter vs hallucinated replies (all fabricated facts must be dropped)
//  D. token and cost projection from the real caption sizes (estimates)
// Usage: node ingestion/eval-ai-local.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { AiExtractor } from './ai-extractor.ts';
import { ScriptedLlmClient, sentPosts } from './ai-mock.ts';
import { RulesExtractor } from './rules-extractor.ts';
import type { EventExtractor } from './extractor.ts';
import type { InstagramPost } from './types.ts';
import { formatScore, scoreExtractor } from './eval-lib.ts';

const NOW = '2026-10-14T04:00:00Z';
const posts = JSON.parse(readFileSync('ingestion/local/real-posts.json', 'utf8')) as InstagramPost[];
type Ref = Record<string, any>;
const ref = (JSON.parse(readFileSync('ingestion/local/reference-analysis.json', 'utf8')) as { posts: Record<string, Ref> }).posts;

const NO_TICKET = { url: null, minPhp: null, maxPhp: null, isFree: null, evidence: null };
const emptyEvent = () => ({
  officialTitle: null, displayLabel: null, artists: [], category: null,
  date: { value: null, endValue: null, evidence: null }, startTime: { value: null, evidence: null },
  venue: { name: null, areaClue: null, evidence: null }, ticket: NO_TICKET,
});

/** Scripted replies in the model's schema, built from the reference. `lie` swaps in fabricated facts. */
function scripted(lie: boolean) {
  return new ScriptedLlmClient((req) =>
    JSON.stringify(sentPosts(req).map((p) => {
      const r = ref[p.id];
      const cls = r.modelWouldSay ?? r.classification;
      if (!r.fieldsEvaluated) return { id: p.id, classification: cls, update: 'none', event: null, notes: [] };
      const e = emptyEvent();
      e.displayLabel = r.displayLabel;
      e.artists = r.artists.map((n: string, i: number) => ({ name: lie ? 'Totally Invented Band' : n, evidence: r.artistEvidence[i] }));
      e.category = r.category;
      e.date = { value: lie ? '2027-03-03' : r.date, endValue: null, evidence: r.dateEvidence };
      e.venue = { name: lie ? 'Imaginary Dome' : r.venueName, areaClue: lie ? 'Atlantis' : r.areaClue, evidence: null };
      e.ticket = { ...NO_TICKET, url: lie ? 'scam.example/pay' : r.ticketUrl, evidence: r.ticketEvidence };
      return { id: p.id, classification: cls, update: 'none', event: e, notes: [] };
    })), lie ? 'scripted-hallucinating-model' : 'scripted-faithful-model');
}

const score = (e: EventExtractor) => scoreExtractor(e, posts, ref);
const fmt = (x: any) => formatScore(x);
const rules = await score(new RulesExtractor());
console.log('A. RULES extractor vs reference (real measurement; rules were tuned on these same posts, so this is optimistic)');
console.log('   ' + fmt(rules.score));

const faithful = scripted(false);
const aiExtractor = new AiExtractor({ client: faithful });
const plumbing = await score(aiExtractor);
console.log('\nB. AI adapter with SCRIPTED faithful replies (plumbing test only; NOT model accuracy)');
console.log('   ' + fmt(plumbing.score));

const liar = scripted(true);
const hallucinated = await score(new AiExtractor({ client: liar }));
console.log('\nC. AI adapter with SCRIPTED hallucinated replies (fabricated artist/date/venue/area/ticket link)');
console.log('   ' + fmt(hallucinated.score));
console.log(`   fabricated facts reaching output: artists ${hallucinated.rows.filter((r) => r.artists.includes('Totally Invented Band')).length}, venue ${hallucinated.rows.filter((r) => r.venue === 'Imaginary Dome').length}, date ${hallucinated.rows.filter((r) => r.date === '2027-03-03').length}, ticket ${hallucinated.rows.filter((r) => r.ticketUrl === 'scam.example/pay').length} (must all be 0)`);

const st = aiExtractor.stats;
const perThousand = (n: number) => Math.round((n / posts.length) * 1000);
const inTok = perThousand(st.inputTokens);
const outTok = perThousand(st.outputTokens);
console.log(`\nD. Token estimate from the real captions (chars/4, ${st.llmCalls} request(s) of up to 5 posts; output is the scripted reply, so treat output as a floor)`);
console.log(`   per 1,000 captions: ~${(inTok / 1e6).toFixed(2)}M input tokens, ~${(outTok / 1e6).toFixed(2)}M output tokens`);

writeFileSync('ingestion/local/ai-eval-results.json', JSON.stringify({ at: NOW, rules, plumbing, hallucinated, stats: st, note: 'B and C use scripted replies, not a real model' }, null, 2));
