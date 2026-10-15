// DEMO DATA: every event, venue and artist below is fictional.
// Dates are generated relative to today (Asia/Manila) so the date filters always have examples.
import { daysUntilWeekend, manilaAt } from '@/utils/event-dates';

const WE = daysUntilWeekend(); // days until this weekend's Friday

export type MockEvent = {
  id: string;
  title: string;
  venue: string;
  area: string;
  startsAt: string; // ISO 8601
  /** Broad kind of event (e.g. nightlife, concert); separate from music genre. */
  category?: string;
  /** Optional: not every event type has a music genre. */
  genre?: string;
  latitude: number;
  longitude: number;
  // Optional: screens must handle these being absent.
  lineup?: string[];
  description?: string;
  ticketInfo?: string;
  artwork?: [string, string]; // poster gradient-ish colors
  posterUrl?: string;
  sourceUrl?: string;
  /** Fictional demo content. Undefined is treated as a real listing. */
  isDemo?: boolean;
  /** Real listings only. `pending_review` = sourced from Instagram, not yet verified by a person. */
  reviewStatus?: 'pending_review';
  /** The date is known but the start time was not announced; `startsAt` then holds a placeholder time. */
  timeUnknown?: boolean;
  /** Link to the ticket page, exactly as announced. */
  ticketUrl?: string;
  /** Short attribution for sourceUrl, e.g. "Instagram @handle". */
  sourceLabel?: string;
};

export const POBLACION_REGION = {
  latitude: 14.5645,
  longitude: 121.0302,
  latitudeDelta: 0.12,
  longitudeDelta: 0.12,
};

export const MOCK_EVENTS: MockEvent[] = [
  { id: '1', title: 'Neon Sunset Sessions', venue: 'Demo Rooftop Bar', area: 'Poblacion, Makati', startsAt: manilaAt(0, 21), category: 'nightlife', genre: 'House', latitude: 14.5648, longitude: 121.0305, lineup: ['DJ Placeholder', 'Sample Selecta', 'Mock Mira'], description: 'A made-up rooftop night of sunset-to-late house music. Fictional event for app demo purposes only.', ticketInfo: 'Demo: ₱500 early bird · ₱800 door', artwork: ['#F28B7B', '#3A2E5C'], isDemo: true },
  { id: '2', title: 'Kalye Beats Night', venue: 'Sample Social Club', area: 'Poblacion, Makati', startsAt: manilaAt(0, 1), category: 'nightlife', genre: 'Hip-Hop', latitude: 14.5632, longitude: 121.0287, lineup: ['MC Example', 'DJ Faux'], description: 'Fictional hip-hop night with demo DJs and cyphers.', ticketInfo: 'Demo: ₱600 cover includes 1 drink', artwork: ['#E8929C', '#25304F'], isDemo: true },
  { id: '3', title: 'Acoustic Tuesdays', venue: 'Example Cafe & Stage', area: 'Kapitolyo, Pasig', startsAt: manilaAt(WE + 4, 20), category: 'concert', genre: 'Acoustic / Indie', latitude: 14.5723, longitude: 121.0618, lineup: ['The Sample Strings'], ticketInfo: 'Demo: Free entry', isDemo: true },
  { id: '4', title: 'Bayside Indie Fest', venue: 'Placeholder Waterfront', area: 'Pasay', startsAt: manilaAt(WE + 2, 16), category: 'concert', genre: 'Indie Rock', latitude: 14.5352, longitude: 120.9822, lineup: ['Mock Waves', 'Fake Lanterns', 'Demo Dunes', 'Sample Static'], description: 'An imaginary all-afternoon waterfront festival. Not a real event.', ticketInfo: 'Demo: ₱1,500 GA · ₱3,000 VIP', artwork: ['#FFB88C', '#2A3550'], isDemo: true },
  { id: '5', title: 'Techno Warehouse Demo', venue: 'Fictional Warehouse', area: 'Bonifacio Global City', startsAt: manilaAt(WE, 23), category: 'nightlife', genre: 'Techno', latitude: 14.5507, longitude: 121.0459, lineup: ['Test Tone', 'Loop Ghost'], description: 'Fictional techno night in a pretend warehouse.', isDemo: true },
  { id: '6', title: 'Jazz & Jeepneys', venue: 'Mock Jazz Lounge', area: 'Malate, Manila', startsAt: manilaAt(WE + 1, 19, 30), category: 'concert', genre: 'Jazz', latitude: 14.5712, longitude: 120.9935, lineup: ['Demo Quartet'], ticketInfo: 'Demo: ₱400 table reservation', artwork: ['#C98B9B', '#1F2A44'], isDemo: true },
  { id: '7', title: 'Metro Pop Live', venue: 'Demo Arena', area: 'Araneta City, Quezon City', startsAt: manilaAt(WE + 8, 19), category: 'concert', genre: 'Pop', latitude: 14.6205, longitude: 121.0535, lineup: ['Pop Placeholder', 'Sample Star'], description: 'A pretend arena pop concert used for app demo only.', ticketInfo: 'Demo: ₱1,200 – ₱4,500', artwork: ['#F28B7B', '#4A2E55'], isDemo: true },
  { id: '8', title: 'Reggae Garden Party', venue: 'Sample Garden Bar', area: 'Maginhawa, Quezon City', startsAt: manilaAt(WE + 9, 18), category: 'nightlife', genre: 'Reggae', latitude: 14.6372, longitude: 121.0558, isDemo: true },
];

