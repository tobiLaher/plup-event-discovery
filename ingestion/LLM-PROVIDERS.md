# LLM options for caption extraction (researched 2026-10-14)

Nothing was signed up for, purchased or activated. Prices are USD per million tokens (MTok) from the vendors' own pages where marked; **re-check live pricing before committing**. We have **not benchmarked any real model** on our captions yet.

## Sizing (measured from our 10 real captions, then padded)

Real captions here are short (~100 tokens). Planning figures per 1,000 captions: **~0.25 M input tokens** (caption + metadata + the shared instruction prompt, amortized by sending 5 posts per request) and **~0.20 M output tokens** (compact JSON with evidence). Measured by chars/4 with a scripted reply, so output is an assumption; verify with a real provider's `usage`.

## Cost per 1,000 captions

| Model | Input / Output per MTok | Per 1,000 captions | With 50% batch discount | Source |
|---|---|---|---|---|
| Claude Haiku 5.5 (prompts up to 100k) | $0.10 / $0.50 | **~$0.13** | ~$0.06 | [Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing) |
| Gemini 2.5 Flash-Lite | $0.10 / $0.40 | **~$0.11** | ~$0.05 | [Google AI pricing](https://ai.google.dev/gemini-api/docs/pricing) |
| Gemini 3.1 Flash-Lite | $0.25 / $1.50 | ~$0.36 | ~$0.18 | same |
| GPT-5.4 nano | $0.20 / $1.25 | ~$0.30 | ~$0.15 | secondary sources only (openai.com blocked us); unverified |
| Claude Sonnet 5.5 (quality tier) | $2 / $10 | ~$2.50 | ~$1.25 | Anthropic pricing |

Running cost example: 300 promoter accounts x ~30 posts/month = 9,000 captions/month, only new posts are sent (cached by post id + content hash). Haiku 5.5 is roughly **$1 per month**; even 100,000 captions/month is about $13. Extraction cost is not the constraint; reliability is.

## Comparison for our use

| | Claude Haiku 5.5 | Gemini 2.5 Flash-Lite | GPT-5.4 nano |
|---|---|---|---|
| Structured JSON | Tool-use / structured outputs | `responseSchema` + JSON mime type | Strict JSON-schema mode |
| Reliability for extraction | Untested by us | Untested by us | Untested by us |
| TypeScript integration | Plain `fetch` adapter (~30 lines) or official SDK | same | same |
| Image/poster understanding later | Vision input | Vision input (cheap) | Vision input |
| Free tier | None found | Yes, but free-tier data may be used to improve products; paid tier data is not | None found |

All three can be reached by a small `LlmClient` adapter, so there is no lock-in and no new dependency is needed now. Our own schema validation and grounding (ai-schema.ts, ai-grounding.ts) run on every reply regardless of vendor, so provider-side "strict JSON" is a convenience, not something we rely on.

## Update 2026-10-14: Gemini free tier for development

The default evaluation provider is now **Gemini on the free tier** (no billing). Notes from Google's own docs: Gemini 2.5 Flash-Lite is now limited to users who used the 2.5 models before, and Google recommends **Gemini 3.5 Flash-Lite** for new projects (free of charge on the Free tier per the pricing page). Google does not publish free-tier rate-limit numbers in the docs (they appear in AI Studio), and free-tier content may be used to improve Google's products. The Anthropic client remains available behind the same interface.

## Recommendation (original analysis)

1. **Default: Claude Haiku 5.5**, called in batches of 5 (and the vendor's batch API for non-urgent backfills). Cheapest tier with first-party structured output and strong instruction following, at about $0.13 per 1,000 captions.
2. **Cheapest alternative / A/B: Gemini 2.5 Flash-Lite**. Use the paid tier, not the free tier, for production data.
3. Before relying on either, evaluate ~100 real captions per model (roughly a cent or two each) against a hand-written reference using the `ingest:eval-live` tooling, and only then consider enabling unattended publishing.

## Poster / image understanding later

Roughly 1,000-1,500 input tokens per image, i.e. about +$0.10-0.15 per 1,000 posters at the prices above. The extractor interface already has `usesImages` and `post.imageUrls`. **Open question:** our Business Discovery calls only requested caption, timestamp, permalink, id and media type. Whether `media_url` is returned for third-party accounts, and for which media types, has not been tested.

## Privacy and terms notes

Captions are public posts, but send them only to a paid tier whose terms say API data isn't used for training. Keep API keys in server-side environment variables only (never in the Expo app or Git).
