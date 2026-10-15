# PLUP ingestion (Phase 1)

Converts Instagram posts into reviewable event candidates. Independent of the Expo UI; no network, no credentials, no Supabase.

- `npm run ingest:demo` prints structured JSON for the fixtures (`--now <ISO>`, `--real-only`, `--synthetic-only`).
- `npm run ingest:test` runs the tests (Node's built-in runner; Node 22.18+/24 runs `.ts` directly).

Flow: `InstagramPost` → `EventExtractor` (classify + extract) → `ingest()` (dedupe + validate) → `IngestItem`.

- `rules-extractor.ts` is deterministic text rules, **not AI**. A future multimodal AI extractor implements `EventExtractor` (the input carries `post.imageUrls` for poster analysis).
- `simulated-extractor.ts` returns canned drafts for tests only.
- Nothing auto-publishes: statuses are `needs_review`, `ready_for_approval` (still needs a human) or `excluded`.
- Dates/times are Asia/Manila. The post's publication date is never the event date; it only resolves a missing year (flagged `year_inferred`).
## Automatic publishing (Phase 4A: built and tested, switched OFF)

`ingest()` -> `evaluateBatch()` (publishing.ts) -> lifecycle (lifecycle.ts). No manual approval in the normal path.

- **Decisions:** `reject` (recap, unrelated, duplicate, past, synthetic), `hold` (a named blocker is unresolved; enrich or flag), `eligible` (all blockers pass).
- **Explainable, not a score:** each decision is a list of named checks (`date_known`, `name_reliable`, `venue_verified`, ...), each with a detail string. Blockers hold an event; warnings (no start time, no artists, no ticket info, non-AI extractor) are recorded but never block.
- **Verified venues only (venues.ts):** coordinates come from a registry where at least 2 independent sources agree within 300 m and the point is in Metro Manila. Matching is exact after normalization; unknown venues stay held until enrichment adds a verified entry. Nothing is geocoded by guesswork.
- **Names:** `nameQuality` is `explicit`, `derived` or `guessed`. Guessed names block publishing, so the rules extractor alone will not auto-publish; a better extractor (e.g. AI) is expected to supply derived/explicit names.
- **Master switch:** `DEFAULT_POLICY.unattendedPublishingEnabled = false`. Eligible events get `action: none` until it is turned on, after validation on more real data and confirmed production API access. An admin can still publish a single exception by hand (a verified location is always required).
- **Lifecycle:** `held -> published -> unpublished | expired`, `held -> rejected`, every change appended to `history`. `applyUpdate` re-checks an event when its source changes: cancellation wording or a now-ambiguous date unpublishes it automatically; a corrected valid change updates it in place. Posts for the same event are merged and every Instagram source URL is kept. `expireStale` removes finished events.
- **Admin (optional):** the lifecycle functions plus `summarize()` (counts and top blockers) are the surface for an exceptions/monitoring screen. Not built.
- `npm run ingest:evaluate` evaluates the local real posts (rules extractor, and a clearly labelled simulated replay of the hand-authored extraction).

## Venue discovery and verification (Phase 4B)

`venue-resolver.ts` turns a venue name into a verified `CanonicalVenue` (or holds it). Providers and storage sit behind interfaces; provider research and the production recommendation are in `VENUE-PROVIDERS.md`.

- **Names (`venue-names.ts`):** case, punctuation, diacritics, `&`/`and`, `centre`/`center`, `theatre`/`theater`, `S.M.`/`SM` and a leading "The" are ignored. Names are the same venue only when normalized keys are equal, or a provider place id says so (then the spelling becomes an alias). `PICC`, `PICC Plenary Hall` and `Plenary Hall` stay different. Nearby venues are reported by `nearby()` but never merged.
- **Providers (`venue-search.ts`):** `VenueSearchProvider` (`dataset`, `productionSafe`, `simulated`). Included: `NominatimProvider` (public OSM API, dev only, 1 req/1.1 s, required User-Agent, skipped when `environment: 'production'`) and `FixtureProvider` (test fixture, evidence flagged simulated).
- **Verification (`venue-verify.ts`):** a venue verifies only when (1) an evidence record's name matches exactly, (2) it is unambiguous, (3) it is inside Metro Manila (coordinates and city), (4) it has a city address, (5) every evidence record is within 300 m (500 m for a parent complex), and (6) at least 2 independent datasets agree. Two OSM-derived providers count as one dataset. Closeness alone never counts as identity. Simulated evidence never verifies anything unless a test sets `allowSimulated`.
- **Registry and cache (`venue-registry.ts`):** `VenueStore` interface (Supabase-ready) with an in-memory implementation. Verified venues are stored with evidence (provider, dataset, place id, retrievedAt) and `verifiedAt`; stored evidence is re-verified on every hit. Failed lookups are remembered for 24 h; provider outages are not. PICC Plenary Hall is the seeded record.
- **Publishing:** `evaluatePublishing` takes a `venueLookup`; `resolveVenuesForItems()` fills it from the resolver. Only a `verified` venue passes `venue_verified` / `in_metro_manila`; its coordinates are the only ones the lifecycle will publish.
- `npm run ingest:venue-lookup -- "Venue name"` runs real dev-only Nominatim lookups and writes `ingestion/local/venue-lookups.json`.

## AI extraction (Phase 4C: adapter built and tested with a scripted model; no live model yet)

`AiExtractor` (ai-extractor.ts) is an `EventExtractor` like the rules one, so `ingest()`, duplicate merging, venue resolution and `evaluateBatch()` are unchanged. It talks to a model only through `LlmClient` (llm-client.ts); no vendor or API is chosen or called, and there is no new dependency. Provider and cost planning: `LLM-PROVIDERS.md`.

- **Prompt (ai-prompt.ts):** captions go in as JSON string values and the system prompt marks them untrusted. Compact output schema with a verbatim `evidence` snippet per important field. `PROMPT_VERSION` is part of the cache key.
- **Strict schema (ai-schema.ts):** wrong types, bad enums, malformed dates/times and missing keys reject that post. Unknown extra fields and any `confidence`/`score` are ignored and logged; no model confidence is ever read.
- **Grounding (ai-grounding.ts):** deterministic code checks each claim against the caption. A title, artist, venue, area, ticket link or price the caption does not contain is dropped and listed in `details.ungroundedFields` (flag `ai_ungrounded_field`). Dates and times must be re-read identically by our own parser (Asia/Manila). Slogans cannot be official titles. A generated `displayLabel` may only use words from the caption, is stored as `nameQuality: 'derived'`, and the publishing check `name_is_official` warns about it. "Upcoming" with no supported date becomes `ambiguous`; past/future is decided by our dates, not the model; cancel/postpone wording raises `cancellation_signal` even if the model missed it; model-reported updates raise `event_update_signal`. Both block publishing.
- **Isolation:** each reply is grounded against its own post's caption only, so one caption cannot rewrite another post's result even if the model is fooled. A failed call, non-JSON reply or invalid item marks only the affected posts `ai_invalid_response` (held); `FallbackExtractor` can use the rules extractor for just those posts. Error text is scrubbed of credential-looking strings.
- **Cost controls:** cache by post id + caption hash (failures never cached), 5 posts per request, caption length cap, per-run token stats (`extractor.stats`).
- **Evidence kept:** `IngestItem.details` holds extractor name, evidence snippets, dropped fields and notes next to the source URL.
- `npm run ingest:eval-ai` scores the rules extractor against a hand-written reference of the local real posts (`ingestion/local/`, git-ignored) and runs the adapter with scripted replies. Those scripted results prove the plumbing, not model accuracy.

## Persistence (Phase 4F: built and tested against fakes; no database connected yet)

`persistence/` stores the pipeline's work behind a `PersistenceStore` interface with two implementations: `MemoryPersistence` (tests, dry runs) and `SupabasePersistence` (server-side, service-role key). The schema is `supabase/migrations/*.sql` (see `supabase/README.md`).

- **Flow (`persistIngestion`, sync.ts):** source posts (idempotent by post id; edits keep revisions) -> existing extraction/dedupe/venue resolution/publishing checks -> one candidate row per post (with the explainable checks) -> lifecycle: an existing event (same `event_key`) is re-checked and updated, unpublished on a cancellation, or expired after its last Manila day; a new one is created only when the policy allows publishing. By default nothing becomes public. The model-reply cache lives in the store, so reprocessing never pays for the model twice.
- **Idempotent by natural keys:** `(platform, handle)`, `(platform, source_post_id)`, `source_post_id` (candidates), `event_key` (events), `(event_id, source_post_id)` (sources). Re-running over the same posts adds nothing; a repost attaches as a `duplicate` source, an update as `update`, a cancellation as `cancellation`.
- **Provenance:** every post that touched an event is linked in `event_sources`; every lifecycle change is in `event_history` with actor and reason; edited captions are kept as revisions.
- **Dates:** `event_date` (Manila calendar date) and `start_time` (nullable Manila wall clock) are separate columns end to end. `public_events` derives `starts_at` and `time_known`.
- **Database-level safety:** an event needs a verified venue (FK to `venues`, which only accepts verified, Metro Manila venues), a reliable title (`explicit`/`derived`, never `guessed`), and a date; synthetic posts and simulated venue evidence cannot be stored. The memory store and the fake PostgREST enforce the same rules.
- **Public read:** `public_events` (view, `security_invoker`) and `public-events.ts` (`toAppEvent`, `PUBLIC_EVENTS_SELECT`) are what the map will consume. The Expo app is unchanged.
- **Admin exceptions:** `adminPublishCandidate` / `adminUnpublishEvent` for single corrections; they still refuse guessed titles, missing dates and unverified venues.
- **Key safety:** `createServerSupabase` needs `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` and refuses a publishable key, a key also present in an `EXPO_PUBLIC_*` variable, and browser/React Native runtimes. Template: `ingestion/.env.example`.
- **What is verified vs simulated:** the contract tests run every scenario against both the memory store and the Supabase store on a *fake* PostgREST; `schema-policy.test.ts` checks the SQL text (RLS on every table, private tables have no policies or grants, column grants, view definition, store columns exist in the schema). **The SQL has not been executed on a real Postgres and RLS has not been exercised at runtime.**
- `npm run ingest:persist-replay -- <saved live eval json>` replays real saved model replies into the in-memory store (offline).

## Gemini free-tier evaluation (Phase 4E: ready, not yet run)

The project now defaults to Google's Gemini API free tier. `GeminiLlmClient` (gemini-client.ts) is plain `fetch` against `POST /v1beta/models/{model}:generateContent`, server-side only, behind the same `LlmClient` interface, schema, grounding, cache and evaluation tools. The Anthropic client below is kept but unused unless you pass `--provider anthropic`.

- **Model:** default `gemini-3.5-flash-lite` (Google's recommended Flash-Lite for new projects). `gemini-2.5-flash-lite` is accepted but Google says it is limited to users who already used the 2.5 models, so a new key may get a 404; `gemini-3.1-flash-lite` is the other allowed model (`--model` or `GEMINI_MODEL`). Anything else is refused, so a paid model can't be picked by accident.
- **Key:** `GEMINI_API_KEY` from the environment (or the git-ignored `ingestion/local/gemini.env`). Sent only in the `x-goog-api-key` header, never in a URL; never printed, stored or put in errors. Never reaches the Expo app.
- **Free-tier discipline:** one request per 6 s, 2 posts per request, at most 10 posts and 8 requests (5 base plus up to 3 one-post fallbacks after a cut-off reply), 1,400 output tokens per request; a 429 quota error (or 503) stops the run. Google publishes the exact free-tier limits only in AI Studio, so they are not hard-coded. **Don't enable billing**: a key from a project without billing stays on the free tier (quota exhaustion = 429, not a charge). The client can't see your billing status.
- **Unverified until the first real call:** the request uses only documented basics (`systemInstruction`, `contents`, `generationConfig.maxOutputTokens`, `responseMimeType: application/json`) and leaves thinking at the model default. If the API returns a 400 naming a field, it is not billed; the error message identifies the field to adjust.
- **Privacy:** on the free tier Google may use submitted content to improve its products. We send only public captions.

**First live run (10 posts) and what it taught us:** 5 of 10 posts failed because the model, asked only for a JSON mime type, emitted structurally broken JSON for 3 of 5 items in one reply (a stray `,{"ticket":...}` object after `venue`). It was not truncated (738 of 1,500 allowed tokens) and our parser was right to reject it; every classification error and every missed field was a consequence of it. Fixes: (1) the request now carries a `responseSchema` (Gemini constrained decoding, generated from `ai-response-schema.ts`; turn off with `useResponseSchema: false` if the API rejects it), (2) per-item salvage so a broken item no longer discards its neighbours, (3) a grounding bug where a stale "tonight" post the model called upcoming stayed ambiguous, (4) hashtags are no longer accepted as official titles, (5) publishing now has a blocker `ai_output_clean`: a reply that was invalid or had any unsupported claim holds the event. `npm run ingest:eval-replay -- <saved json>` re-scores saved raw replies offline (no API call).

**Second live run: output truncation.** The schema fixed the broken JSON, but request 2 (5 posts, 1,500 output tokens) ended with finish reason MAX_TOKENS and all 5 posts were lost. Cause: the output limit was too small for the items, not a format error. The API billed ~1,250 output tokens for a reply whose text is only ~920 chars/4 tokens (pretty-printed JSON costs ~1.35x), i.e. 250-450 tokens per item. Fixes: batches of **2 posts** (5 requests for 10 posts) with **700 output tokens per post** (1,400 per request, limits in `eval-limits.ts`); the prompt asks for compact one-line JSON, evidence snippets of at most 60 characters and at most one short note (schema, evidence and grounding rules unchanged; `PROMPT_VERSION` is v2 so old cache entries are not reused); a truncated reply no longer discards the items that finished (they are recovered, then fully validated and grounded); with `splitOnTruncation` (on in the evaluation) the unfinished posts are re-sent one per request, once, inside the request cap of 8; a one-post request is never split or retried; truncated posts stay `ai_invalid_response` and are held. Expected cost of the next run: 5 requests (8 at most), roughly 4-5k input and 2-4k output tokens, $0 on the free tier.

`npm run ingest:eval-live` is a dry run by default (sends nothing, reads no key). `-- --confirm-spend` makes the real calls. Results: `ingestion/local/live-eval-gemini-<time>.json` (git-ignored).

## Anthropic (paid) client (Phase 4D, kept, unused by default)

`anthropic-client.ts` is a plain-`fetch` client for the Anthropic Messages API (`POST /v1/messages`, model `claude-haiku-5-5`, header `anthropic-version: 2023-06-01`), chosen over the SDK to avoid a new dependency in this Expo project. Server-side only.

- **Credentials:** read from `ANTHROPIC_API_KEY` in the process environment (or, if unset, `ingestion/local/anthropic.env`, git-ignored). The key is only ever sent as the `x-api-key` header; it is never printed, logged, stored in results or included in errors (`redact()`), and never reaches the Expo app.
- **Request:** one user message holding the JSON posts, no sampling parameters (this model family rejects non-default ones), `thinking: disabled` and `effort: low` so extraction doesn't pay for reasoning tokens. If the API ever rejects those two settings (a 400 naming them), change `disableThinking` / `effort` in `AnthropicClientOptions`; a 400 is not billed.
- **Cost safeguards:** at most 10 posts, 3 requests, 1,500 output tokens per request and a $0.05 worst-case cap (checked before each request); **no automatic retries**; a fatal error (bad key, no credit, 429, 529, offline, budget) stops all further requests in the run; per-run usage and spend are tracked from the API's reported `usage`.
- **Dry run by default:** `npm run ingest:eval-live` prints the plan and worst-case cost and sends nothing (it doesn't even read the key). `npm run ingest:eval-live -- --confirm-spend` makes the real calls (about $0.001-0.002 for 10 posts), scores them against the local reference with the same metrics as `ingest:eval-ai`, runs the publishing engine (unattended publishing stays off) and writes `ingestion/local/live-eval-<time>.json` including the raw replies. **10 posts from one promoter: a smoke test, not a benchmark.**
- **One-time key setup (PowerShell, this terminal only; nothing is saved to disk or history):**
  `$k = Read-Host "Anthropic API key" -AsSecureString; $env:ANTHROPIC_API_KEY = [System.Net.NetworkCredential]::new("", $k).Password`

Not done yet: running the live evaluation, benchmarking a live model beyond these 10 posts, persistence (Supabase), polling, a production search provider (Geoapify recommended) and a second independent dataset (Overture Maps Places extract), acronym/brand aliases (e.g. "Araneta Coliseum" vs "Smart Araneta Coliseum"), matching a cancellation post that has no extractable name/date/venue, and a real AI extractor.

- Fixtures: `REAL_DERIVED_POSTS` is one minimal excerpt of a real Business Discovery post; `SYNTHETIC_POSTS` are invented (`synthetic-` ids, `example.invalid` links).
