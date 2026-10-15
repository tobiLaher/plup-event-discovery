# PLUP Supabase foundation (Phase 4F)

`migrations/20261015000000_ingestion_foundation.sql` creates the tables, Row Level Security and the public view for event ingestion. **It has been written and statically checked but not yet run on a real Postgres.**

## What mobile users can see

Only `public.public_events`: upcoming events with status `published`, joined to their verified venue. Everything else (organizers, source posts, captions, candidates, evidence, history, logs, cache) is private: RLS is on with no policies, and all privileges are revoked from `anon`/`authenticated`. Only the server, using the service-role key, can read or write them.

## Tables

| Table | Purpose | Mobile access |
|---|---|---|
| `organizers` | Instagram accounts we ingest (`auth_user_id` reserved for future organizer logins) | none |
| `source_posts`, `source_post_revisions` | One row per Instagram post (unique per post id); edited captions are kept as revisions | none |
| `event_candidates` | Latest extraction + publishing decision per post, with the explainable checks | none |
| `venues`, `venue_evidence` | Verified venues only (Metro Manila bounding box enforced) and their evidence | venues of published events, limited columns |
| `venue_lookup_attempts`, `extraction_cache` | Lookup and model-reply caches | none |
| `events` | Events that were made public (and later unpublished or expired). Unique by `event_key`; no guessed titles; venue required | published rows, limited columns |
| `event_sources` | Every post that announced, repeated, updated or cancelled an event | none |
| `event_history` | Audit trail of status changes | none |
| `ingestion_runs`, `ingestion_logs` | Processing runs and logs | none |

Event **dates and start times are separate columns** (`event_date date`, `start_time time` nullable). `public_events` derives `starts_at` and `time_known`.

## Setup

Create a free Supabase project (no payment card needed) at https://supabase.com/dashboard, choose the closest region, and store the database password in a password manager. Never paste or commit keys.

## Next steps (not done yet)

1. Run the migration in the SQL Editor, then verify RLS with an anonymous request (should return only published events, and nothing from private tables).
2. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` on the server only (see `ingestion/.env.example`). `createServerSupabase()` refuses a publishable key, a key that also appears in an `EXPO_PUBLIC_*` variable, and browser/React Native runtimes.
3. Point the Expo app at `public_events` using the existing publishable key (the app is not changed yet; the current app query reads an `events` table with `starts_at`, which this schema replaces with the view).
