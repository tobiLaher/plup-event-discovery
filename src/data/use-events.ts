import { useEffect, useState } from 'react';

import { DEV_SAMPLE_EVENTS } from '@/data/dev-sample-events';
import { MOCK_EVENTS, type MockEvent } from '@/data/mock-events';
import { supabase } from '@/lib/supabase';

type Row = {
  id: string;
  title: string;
  description: string | null;
  starts_at: string;
  genre: string | null;
  lineup: string[] | null;
  ticket_info: string | null;
  poster_url: string | null;
  source_url: string | null;
  venues: {
    name: string;
    address: string | null;
    city: string | null;
    latitude: number | null;
    longitude: number | null;
  } | null;
};

const DEMO_PREFIX = /^demo\s*[-–:]\s*/i;
const normalize = (t: string) => t.replace(DEMO_PREFIX, '').trim().toLowerCase();

function toEvent(row: Row): MockEvent | null {
  const v = row.venues;
  if (!v || v.latitude == null || v.longitude == null) return null;
  return {
    id: row.id,
    title: row.title.replace(DEMO_PREFIX, ''),
    venue: v.name.replace(DEMO_PREFIX, ''),
    area: [v.address, v.city].filter(Boolean).join(', '),
    startsAt: row.starts_at,
    genre: row.genre ?? undefined,
    latitude: v.latitude,
    longitude: v.longitude,
    lineup: row.lineup ?? undefined,
    description: row.description ?? undefined,
    ticketInfo: row.ticket_info ?? undefined,
    posterUrl: row.poster_url ?? undefined,
    sourceUrl: row.source_url ?? undefined,
    isDemo: DEMO_PREFIX.test(row.title) || DEMO_PREFIX.test(v.name),
  };
}

async function fetchPublished(): Promise<MockEvent[]> {
  if (!supabase) throw new Error('Supabase is not configured');
  const { data, error } = await supabase
    .from('events')
    .select(
      'id,title,description,starts_at,genre,lineup,ticket_info,poster_url,source_url,venues(name,address,city,latitude,longitude)',
    )
    .eq('status', 'published')
    .order('starts_at');
  if (error) throw error;
  return ((data ?? []) as unknown as Row[]).map(toEvent).filter((e): e is MockEvent => e !== null);
}

// Remote events win; a mock event is dropped when a remote one has the same title.
// Unreviewed real events are only ever added in development builds.
const LOCAL_ONLY: MockEvent[] = __DEV__ ? DEV_SAMPLE_EVENTS : [];

function merge(remote: MockEvent[]) {
  const seen = new Set(remote.map((e) => normalize(e.title)));
  return [...remote, ...MOCK_EVENTS.filter((e) => !seen.has(normalize(e.title))), ...LOCAL_ONLY];
}

type State = { events: MockEvent[]; loading: boolean; error: boolean };

// Shared so the map and detail screen use one fetch.
let cache: State = { events: [], loading: true, error: false };
let inflight: Promise<void> | null = null;
const listeners = new Set<(s: State) => void>();

function load(force = false) {
  if (inflight && !force) return;
  inflight = fetchPublished()
    .then((remote) => {
      cache = { events: merge(remote), loading: false, error: false };
    })
    .catch(() => {
      cache = { events: [...MOCK_EVENTS, ...LOCAL_ONLY], loading: false, error: true };
    })
    .finally(() => {
      listeners.forEach((l) => l(cache));
    });
}

export function useEvents() {
  const [state, setState] = useState(cache);
  useEffect(() => {
    listeners.add(setState);
    setState(cache);
    load();
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
}
