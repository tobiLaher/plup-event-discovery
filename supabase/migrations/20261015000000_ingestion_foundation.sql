-- PLUP ingestion foundation (Phase 4E).
--
-- STATUS: written and statically checked (ingestion/persistence/schema-policy.test.ts) but NOT yet run
-- against a real Postgres. Review it, then run it once in a new Supabase project (SQL Editor).
--
-- Privacy model
--   * Mobile users (roles anon / authenticated) can read ONLY published events, through the
--     public.public_events view, plus the venues of those events.
--   * Everything else (organizers, source posts, candidates, evidence, logs, history) is private:
--     RLS is on with NO policies, and all privileges are revoked from anon/authenticated. Only the server
--     (service_role key, never shipped in the Expo app) can touch them.
--   * Supabase auto-grants new public tables to anon/authenticated, so every private table below revokes
--     explicitly. If RLS were ever switched off by mistake, the revoked privileges still block access.
--
-- Time model: event_date is a Manila calendar date; start_time is a nullable Manila wall-clock time
-- (null = not announced). They are never merged in storage; public.public_events derives starts_at.

begin;

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

-- ---------------------------------------------------------------------------------------------
-- Organizers (the Instagram accounts we ingest). auth_user_id is reserved for future organizer logins.
create table public.organizers (
  id            uuid primary key default gen_random_uuid(),
  platform      text not null default 'instagram' check (platform in ('instagram')),
  handle        text not null check (handle = lower(handle) and handle !~ '[@\s]'),
  display_name  text,
  auth_user_id  uuid references auth.users (id) on delete set null,
  status        text not null default 'active' check (status in ('active', 'paused', 'blocked')),
  created_at    timestamptz not null default now(),
  unique (platform, handle)
);

-- ---------------------------------------------------------------------------------------------
-- Venues: ONLY verified venues live here (see the check), so an event can never point at an unverified
-- place. Coordinates are constrained to the Metro Manila bounding box.
create table public.venues (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  name          text not null,
  name_key      text not null,
  aliases       text[] not null default '{}',
  kind          text not null default 'venue' check (kind in ('venue', 'room', 'complex')),
  parent_id     uuid references public.venues (id),
  address       text,
  area          text,
  city          text not null,
  latitude      double precision not null check (latitude between 14.35 and 14.80),
  longitude     double precision not null check (longitude between 120.90 and 121.20),
  provider_refs jsonb not null default '[]'::jsonb,
  verification  jsonb not null check (verification ->> 'status' = 'verified'),
  verified_at   timestamptz not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index venues_name_key_idx on public.venues (name_key);

-- Evidence behind a venue. Simulated (test) evidence can never be stored.
create table public.venue_evidence (
  id           uuid primary key default gen_random_uuid(),
  venue_id     uuid not null references public.venues (id) on delete cascade,
  provider     text not null,
  dataset      text not null,
  supports     text not null check (supports in ('identity', 'location', 'parent')),
  place_id     text not null default '',
  name         text,
  city         text,
  address      text,
  latitude     double precision not null,
  longitude    double precision not null,
  retrieved_at timestamptz not null,
  url          text,
  simulated    boolean not null default false check (simulated = false),
  unique (venue_id, provider, place_id)
);

-- Negative cache for venue lookups that did not verify.
create table public.venue_lookup_attempts (
  name_key text primary key,
  at       timestamptz not null,
  status   text not null check (status in ('held', 'out_of_scope')),
  reasons  text[] not null default '{}'
);

-- ---------------------------------------------------------------------------------------------
-- Source posts: one row per Instagram post, unique per (platform, post id) so re-ingesting is idempotent.
-- Synthetic test data can never be stored (origin check). Edits are kept in source_post_revisions.
create table public.source_posts (
  id             uuid primary key default gen_random_uuid(),
  organizer_id   uuid not null references public.organizers (id),
  platform       text not null default 'instagram' check (platform in ('instagram')),
  source_post_id text not null,
  permalink      text not null,
  caption        text,
  content_hash   text not null,
  media_type     text,
  posted_at      timestamptz not null,
  origin         text not null default 'instagram-business-discovery' check (origin = 'instagram-business-discovery'),
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  unique (platform, source_post_id)
);
create index source_posts_organizer_idx on public.source_posts (organizer_id, posted_at desc);

create table public.source_post_revisions (
  id             uuid primary key default gen_random_uuid(),
  source_post_id uuid not null references public.source_posts (id) on delete cascade,
  content_hash   text not null,
  caption        text,
  seen_at        timestamptz not null default now(),
  unique (source_post_id, content_hash)
);

-- Cache of validated model replies so reprocessing a post never pays for the model twice.
create table public.extraction_cache (
  cache_key      text primary key,
  prompt_version text not null,
  result         jsonb not null,
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------------------------
-- Event candidates: the latest extraction + publishing decision for a source post (one per post).
create table public.event_candidates (
  id              uuid primary key default gen_random_uuid(),
  source_post_id  uuid not null unique references public.source_posts (id) on delete cascade,
  extractor       text not null,
  classification  text not null check (classification in ('upcoming_event', 'past_event_recap', 'unrelated', 'ambiguous')),
  decision        text not null check (decision in ('reject', 'hold', 'eligible')),
  action          text not null check (action in ('reject', 'hold', 'publish', 'none')),
  review_reasons  text[] not null default '{}',
  blockers        text[] not null default '{}',
  warnings        text[] not null default '{}',
  checks          jsonb not null default '[]'::jsonb,
  details         jsonb not null default '{}'::jsonb,
  name            text,
  name_quality    text check (name_quality in ('explicit', 'derived', 'guessed')),
  category        text check (category in ('concert', 'nightlife', 'festival', 'other')),
  event_date      date,
  end_date        date,
  start_time      time,
  venue_name      text,
  venue_area      text,
  artists         text[] not null default '{}',
  genre           text,
  ticket_price_min numeric check (ticket_price_min >= 0),
  ticket_price_max numeric check (ticket_price_max >= 0),
  ticket_is_free  boolean,
  ticket_url      text,
  event_key       text,
  venue_id        uuid references public.venues (id),
  snapshot        jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (end_date is null or event_date is null or end_date >= event_date)
);
create index event_candidates_decision_idx on public.event_candidates (decision);
create index event_candidates_event_key_idx on public.event_candidates (event_key);

-- ---------------------------------------------------------------------------------------------
-- Published events: rows exist only for events that were actually made public (and later possibly
-- unpublished/expired). event_key is the natural identity, so the same event is never inserted twice.
-- title_quality excludes 'guessed': a guessed name can never be public.
create table public.events (
  id               uuid primary key default gen_random_uuid(),
  event_key        text not null unique,
  title            text not null,
  title_quality    text not null check (title_quality in ('explicit', 'derived')),
  description      text,
  category         text check (category in ('concert', 'nightlife', 'festival', 'other')),
  genre            text,
  lineup           text[] not null default '{}',
  event_date       date not null,
  end_date         date,
  start_time       time,
  venue_id         uuid not null references public.venues (id),
  ticket_url       text,
  ticket_price_min numeric check (ticket_price_min >= 0),
  ticket_price_max numeric check (ticket_price_max >= 0),
  ticket_is_free   boolean,
  ticket_info      text,
  source_url       text not null,
  source_label     text,
  status           text not null default 'published' check (status in ('published', 'unpublished', 'expired')),
  published_at     timestamptz,
  unpublished_at   timestamptz,
  unpublish_reason text,
  candidate_snapshot jsonb not null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (end_date is null or end_date >= event_date)
);
create index events_status_date_idx on public.events (status, event_date);
create index events_venue_idx on public.events (venue_id);

-- Every post that announced, repeated, updated or cancelled an event. The original links are never dropped.
create table public.event_sources (
  id             uuid primary key default gen_random_uuid(),
  event_id       uuid not null references public.events (id) on delete cascade,
  source_post_id uuid not null references public.source_posts (id),
  role           text not null check (role in ('primary', 'duplicate', 'update', 'cancellation')),
  added_at       timestamptz not null default now(),
  unique (event_id, source_post_id)
);

-- Audit trail of lifecycle transitions and in-place updates.
create table public.event_history (
  id        bigint generated always as identity primary key,
  event_id  uuid not null references public.events (id) on delete cascade,
  from_state text,
  to_state   text not null,
  actor      text not null check (actor in ('system', 'admin')),
  reason     text not null,
  at         timestamptz not null default now()
);
create index event_history_event_idx on public.event_history (event_id, at);

-- Processing runs and logs (private).
create table public.ingestion_runs (
  id                     uuid primary key default gen_random_uuid(),
  started_at             timestamptz not null default now(),
  finished_at            timestamptz,
  status                 text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  extractor              text not null,
  unattended_publishing  boolean not null default false,
  posts_seen             int not null default 0,
  posts_new              int not null default 0,
  posts_changed          int not null default 0,
  eligible               int not null default 0,
  held                   int not null default 0,
  rejected               int not null default 0,
  published              int not null default 0,
  api_requests           int not null default 0,
  input_tokens           int not null default 0,
  output_tokens          int not null default 0,
  error                  text
);

create table public.ingestion_logs (
  id             bigint generated always as identity primary key,
  run_id         uuid not null references public.ingestion_runs (id) on delete cascade,
  source_post_id uuid references public.source_posts (id) on delete set null,
  level          text not null check (level in ('info', 'warn', 'error')),
  message        text not null,
  details        jsonb not null default '{}'::jsonb,
  at             timestamptz not null default now()
);
create index ingestion_logs_run_idx on public.ingestion_logs (run_id, at);

create trigger venues_touch before update on public.venues for each row execute function public.touch_updated_at();
create trigger event_candidates_touch before update on public.event_candidates for each row execute function public.touch_updated_at();
create trigger events_touch before update on public.events for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------------------------
-- Row Level Security.
alter table public.organizers            enable row level security;
alter table public.venues                enable row level security;
alter table public.venue_evidence        enable row level security;
alter table public.venue_lookup_attempts enable row level security;
alter table public.source_posts          enable row level security;
alter table public.source_post_revisions enable row level security;
alter table public.extraction_cache      enable row level security;
alter table public.event_candidates      enable row level security;
alter table public.events                enable row level security;
alter table public.event_sources         enable row level security;
alter table public.event_history         enable row level security;
alter table public.ingestion_runs        enable row level security;
alter table public.ingestion_logs        enable row level security;

-- PRIVATE tables: no policies at all (deny by default) and no privileges for the mobile roles.
revoke all on table public.organizers            from anon, authenticated;
revoke all on table public.venue_evidence        from anon, authenticated;
revoke all on table public.venue_lookup_attempts from anon, authenticated;
revoke all on table public.source_posts          from anon, authenticated;
revoke all on table public.source_post_revisions from anon, authenticated;
revoke all on table public.extraction_cache      from anon, authenticated;
revoke all on table public.event_candidates      from anon, authenticated;
revoke all on table public.event_sources         from anon, authenticated;
revoke all on table public.event_history         from anon, authenticated;
revoke all on table public.ingestion_runs        from anon, authenticated;
revoke all on table public.ingestion_logs        from anon, authenticated;
revoke all on sequence public.event_history_id_seq from anon, authenticated;
revoke all on sequence public.ingestion_logs_id_seq from anon, authenticated;

-- PUBLIC-READABLE tables: read-only, only published events and the venues of published events,
-- and only the columns the app needs (no event_key, candidate_snapshot, unpublish_reason, ...).
revoke all on table public.events from anon, authenticated;
revoke all on table public.venues from anon, authenticated;

grant select (id, title, title_quality, description, category, genre, lineup, event_date, end_date, start_time,
              venue_id, ticket_url, ticket_price_min, ticket_price_max, ticket_is_free, ticket_info,
              source_url, source_label, status)
  on public.events to anon, authenticated;
grant select (id, name, address, area, city, latitude, longitude)
  on public.venues to anon, authenticated;

create policy events_read_published on public.events
  for select to anon, authenticated
  using (status = 'published');

create policy venues_read_of_published_events on public.venues
  for select to anon, authenticated
  using (exists (select 1 from public.events e where e.venue_id = venues.id and e.status = 'published'));

-- No insert/update/delete policies exist for anon/authenticated on any table: writes are server-only.

-- ---------------------------------------------------------------------------------------------
-- Public query for the map: upcoming, published events with their verified venue. security_invoker makes
-- the view run with the caller's rights, so the policies above apply to it.
create view public.public_events with (security_invoker = true) as
select
  e.id,
  e.title,
  (e.title_quality = 'derived')                                         as title_is_generated,
  e.description,
  e.category,
  e.genre,
  e.lineup,
  e.event_date,
  e.end_date,
  e.start_time,
  (e.start_time is not null)                                            as time_known,
  ((e.event_date + coalesce(e.start_time, time '12:00'))::timestamp at time zone 'Asia/Manila') as starts_at,
  e.ticket_url,
  e.ticket_price_min,
  e.ticket_price_max,
  e.ticket_is_free,
  e.ticket_info,
  e.source_url,
  e.source_label,
  v.id                                                                  as venue_id,
  v.name                                                                as venue_name,
  v.address                                                             as venue_address,
  v.area                                                                as venue_area,
  v.city                                                                as venue_city,
  v.latitude,
  v.longitude
from public.events e
join public.venues v on v.id = e.venue_id
where e.status = 'published'
  and coalesce(e.end_date, e.event_date) >= (now() at time zone 'Asia/Manila')::date;

revoke all on public.public_events from anon, authenticated;
grant select on public.public_events to anon, authenticated;

commit;
