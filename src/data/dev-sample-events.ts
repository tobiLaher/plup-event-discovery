// DEVELOPMENT ONLY. A FICTIONAL example of an unverified, Instagram-sourced listing, used to exercise the
// "pending review" UI (unknown start time, source link, ticket link). Every name, venue, coordinate and
// link below is invented; nothing here refers to a real event or organizer. It is merged in only when
// __DEV__ is true (Expo Go / dev builds), never in production.
import type { MockEvent } from '@/data/mock-events';

export const DEV_SAMPLE_EVENTS: MockEvent[] = [
  {
    id: 'dev-sample-unverified-listing',
    title: 'Example Band in Manila (sample unverified listing)',
    venue: 'Example Plenary Hall',
    area: 'Pasay',
    // Date known, start time not announced: noon Manila is a placeholder (kept after the 6am nightlife-day cutoff).
    startsAt: '2026-11-20T12:00:00+08:00',
    timeUnknown: true,
    category: 'concert',
    // Arbitrary point inside the default map view; not a real venue.
    latitude: 14.5555,
    longitude: 121.008,
    lineup: ['Example Band'],
    description: 'Fictional sample used to preview how unverified listings look. Start time and ticket price are not announced.',
    ticketUrl: 'https://tickets.example.invalid/sample',
    sourceUrl: 'https://example.invalid/sample-post',
    sourceLabel: 'Sample source (fictional)',
    isDemo: false,
    reviewStatus: 'pending_review',
  },
];
