// What the PLUP map will consume later: the public.public_events view, and a mapper from its rows to the
// app's event model. The Expo app is not changed yet; when it is, it should query this view with the
// anonymous (publishable) key instead of the `events` table.
import type { MockEvent } from '../../src/data/mock-events.ts';
import type { PublicEventRow } from './types.ts';

/** Query for a supabase-js client: `client.from(PUBLIC_EVENTS_VIEW).select(PUBLIC_EVENTS_SELECT)`. */
export const PUBLIC_EVENTS_VIEW = 'public_events';
export const PUBLIC_EVENTS_SELECT =
  'id,title,title_is_generated,description,category,genre,lineup,event_date,end_date,start_time,time_known,starts_at,ticket_url,ticket_price_min,ticket_price_max,ticket_is_free,ticket_info,source_url,source_label,venue_id,venue_name,venue_address,venue_area,venue_city,latitude,longitude';

const withScheme = (u: string) => (/^https?:\/\//i.test(u) ? u : `https://${u}`);

function ticketText(r: PublicEventRow): string | undefined {
  if (r.ticket_is_free) return 'Free entry';
  const { ticket_price_min: lo, ticket_price_max: hi } = r;
  if (lo === null && hi === null) return r.ticket_info ?? undefined; // unknown price stays unknown
  const fmt = (n: number) => `₱${n.toLocaleString('en-PH')}`;
  return lo !== null && hi !== null && lo !== hi ? `${fmt(lo)} – ${fmt(hi)}` : fmt((lo ?? hi)!);
}

/**
 * Maps a public view row to the app's MockEvent. The date and time stay honest: `timeUnknown` is set when no
 * start time was announced, and a generated (not official) title is not presented as verified.
 */
export function toAppEvent(r: PublicEventRow): MockEvent {
  return {
    id: r.id,
    title: r.title,
    venue: r.venue_name,
    area: r.venue_area ?? r.venue_city,
    startsAt: r.starts_at,
    timeUnknown: !r.time_known,
    category: r.category ?? undefined,
    genre: r.genre ?? undefined,
    latitude: r.latitude,
    longitude: r.longitude,
    lineup: r.lineup.length ? r.lineup : undefined,
    description: r.description ?? undefined,
    ticketInfo: ticketText(r),
    ticketUrl: r.ticket_url ? withScheme(r.ticket_url) : undefined,
    sourceUrl: r.source_url,
    sourceLabel: r.source_label ?? undefined,
    isDemo: false,
  };
}
