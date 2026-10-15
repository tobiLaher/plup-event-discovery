// Test fixtures. EVERYTHING here is fictional: accounts ("demo_" names), venues, artists, prices, dates and
// links (example.invalid) are invented, and ids are prefixed "synthetic-". They must never be shown as real
// events. Real Instagram data is never committed; it lives in the git-ignored ingestion/local/ folder.
import type { InstagramPost } from './types.ts';

/** Fixed "now" so fixture results are reproducible: 2026-10-14 12:00 Asia/Manila. */
export const FIXTURE_NOW = '2026-10-14T04:00:00Z';

/** A fictional multi-day tour recap, written to look like a typical "thank you" post with the show facts at the end. */
export const RECAP_FIXTURE_POSTS: InstagramPost[] = [
  {
    id: 'synthetic-recap-demo-tour',
    username: 'demo_promoter',
    caption: [
      'Until next time, Manila. We miss you already!',
      '',
      'See you all again when they come back?',
      '',
      'DEMO BAND 10 Year Anniversary Tour in Manila',
      'August 10, 11 & 12, 2026',
      'Example Plenary Hall',
      '',
      'Full album on our page',
    ].join('\n'),
    timestamp: '2026-09-14T10:34:01+0000',
    permalink: 'https://example.invalid/synthetic/recap-demo-tour',
    origin: 'synthetic',
  },
];

const synthetic = (id: string, caption: string, timestamp: string, username = 'demo_promoter'): InstagramPost => ({
  id: `synthetic-${id}`,
  username,
  caption,
  timestamp,
  permalink: `https://example.invalid/synthetic/${id}`,
  origin: 'synthetic',
});

const NEON = [
  'NEON HARBOR SESSIONS',
  'October 31, 2026 | Doors 7PM, show starts 8PM',
  '📍 Demo Rooftop Bar, Poblacion, Makati',
  'Lineup: DJ Placeholder, Sample Selecta',
  'House music all night. Tickets ₱500 early bird, ₱800 at the door.',
].join('\n');

export const SYNTHETIC_POSTS: InstagramPost[] = [
  // Upcoming, complete.
  synthetic('upcoming-complete', NEON, '2026-10-10T02:00:00Z'),
  // Upcoming, no year in the caption (inferred from the post date) and a free event.
  synthetic('upcoming-no-year', [
    'SAMPLE INDIE NIGHT',
    'Nov 14 · Doors 7PM, show starts 8PM',
    '📍 Example Cafe & Stage, Kapitolyo, Pasig',
    'Lineup: The Sample Strings & Mock Waves',
    'Free entry. Join us!',
  ].join('\n'), '2026-10-12T05:00:00Z'),
  // Past-event recap.
  synthetic('recap', 'Thank you for last night, Demo Arena! What a night. Photos from October 3 are up. See you again soon!', '2026-10-05T01:00:00Z'),
  // Unrelated.
  synthetic('unrelated', 'We are hiring a part-time photographer. DM us your portfolio.', '2026-10-09T03:00:00Z'),
  // Duplicate post id (same id as the first fixture).
  { ...synthetic('upcoming-complete', NEON, '2026-10-10T02:00:00Z') },
  // Same event announced again by a different account/post.
  synthetic('upcoming-repost', NEON, '2026-10-11T02:00:00Z', 'demo_venue_account'),
  // Incomplete: announcement with no date.
  synthetic('incomplete', 'BIG concert announcement coming soon! Save the date, December 2026. Stay tuned!', '2026-10-13T02:00:00Z'),
  // Ambiguous numeric date.
  synthetic('ambiguous-date', 'TECHNO NIGHT at Demo Warehouse, BGC. 03/04/2027. Tickets on sale now!', '2026-10-13T06:00:00Z'),
  // Several dates far apart (tour stops).
  synthetic('multiple-dates', 'Fictional Tour Live: Nov 20 Manila, Dec 18 Cebu. Tickets on sale now!', '2026-10-13T08:00:00Z'),
  // Relative date only.
  synthetic('relative', 'Tonight! DJ set at Demo Rooftop Bar, doors 9PM. See you there!', '2026-10-14T01:00:00Z'),
  // Only a doors time and no area.
  synthetic('doors-only', 'MOCK WAVES live in Manila, Nov 7, 2026 at Placeholder Waterfront. Gates open 4PM. Tickets available now.', '2026-10-12T09:00:00Z'),
];
