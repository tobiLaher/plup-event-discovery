import { router, useLocalSearchParams } from 'expo-router';
import { Linking, ScrollView, Share, StyleSheet, Text, View } from 'react-native';
import { PressableScale } from '@/components/pressable-scale';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useEvents } from '@/data/use-events';
import { formatEventWhen } from '@/utils/event-dates';

const CHARCOAL = '#1F2028';
const CARD = '#262831';
const CARD_EDGE = '#34363F';
const CREAM = '#F6ECDD';
const CREAM_DIM = '#B9B0A6';
const PINK = '#E8929C';
const CORAL = '#F28B7B';

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {children}
    </View>
  );
}

export default function EventDetailsScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const { events, loading } = useEvents();
  const event = events.find((e) => e.id === id);

  const goBack = () => (router.canGoBack() ? router.back() : router.replace('/'));

  const back = (
    <PressableScale
      onPress={goBack}
      hitSlop={10}
      style={[styles.back, { top: insets.top + 8 }]}>
      <Text style={styles.backText}>‹ Back</Text>
    </PressableScale>
  );

  if (!event && loading) {
    return <View style={[styles.container, styles.center]}>{back}</View>;
  }

  if (!event) {
    return (
      <View style={[styles.container, styles.center]}>
        <Text style={styles.title}>Event not found</Text>
        <Text style={styles.muted}>This demo event doesn’t exist.</Text>
        {back}
      </View>
    );
  }

  const [c1, c2] = event.artwork ?? [PINK, '#2A3550'];

  const onShare = () => {
    const when = formatEventWhen(event, true);
    Share.share({
      message: `${event.title}
${when}
${event.venue}, ${event.area}${event.isDemo !== false ? '\n\n(Demo event — fictional)' : event.reviewStatus === 'pending_review' ? '\n\n(Unverified listing — details may change)' : ''}${event.isDemo === false && event.sourceUrl ? `\n${event.sourceUrl}` : ''}`,
    }).catch(() => {});
  };

  return (
    <View style={styles.container}>
      <View style={[styles.topBar, { paddingTop: insets.top + 8 }]}>
        <PressableScale onPress={goBack} hitSlop={10} style={styles.pill}>
          <Text style={styles.pillText}>‹ Back</Text>
        </PressableScale>
        <PressableScale onPress={onShare} hitSlop={10} style={[styles.pill, styles.sharePill]}>
          <Text style={styles.sharePillText}>Share ↗</Text>
        </PressableScale>
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}>
        <View style={styles.hero}>
          {/* Artwork slot: swap this View for an <Image> when real posters exist */}
          <View style={[styles.artwork, { backgroundColor: c2 }]}>
            <View style={[styles.blob, styles.blobA, { backgroundColor: c1 }]} />
            <View style={[styles.blob, styles.blobB, { backgroundColor: c1 }]} />
            <Text style={styles.artNote}>♪</Text>
          </View>
          <View style={styles.heroText}>
            {event.genre && (
              <View style={styles.genrePill}>
                <Text style={styles.genreText}>{event.genre}</Text>
              </View>
            )}
            <Text style={styles.heroTitle}>{event.title}</Text>
          </View>
        </View>

        <View style={styles.body}>
          <View style={styles.infoCard}>
            <Text style={styles.when}>{formatEventWhen(event, true)}</Text>
            <Text style={styles.venue}>{event.venue}</Text>
            <Text style={styles.muted}>{event.area}</Text>
            <View style={styles.divider} />
            <Text style={styles.sectionLabel}>TICKETS</Text>
            <Text style={styles.paragraph}>
              {event.ticketInfo ?? 'Ticket info not available yet.'}
            </Text>
            {event.ticketUrl && (
              <Text style={styles.link} onPress={() => Linking.openURL(event.ticketUrl!).catch(() => {})}>
                {event.ticketUrl.replace(/^https?:\/\//, '')} ↗
              </Text>
            )}
          </View>

          {event.reviewStatus === 'pending_review' && (
            <View style={styles.demoBanner}>
              <View style={styles.demoDot} />
              <Text style={styles.demoText}>Unverified · pending review · start time unknown</Text>
            </View>
          )}

          {event.isDemo !== false && (
            <View style={styles.demoBanner}>
              <View style={styles.demoDot} />
              <Text style={styles.demoText}>Demo data · this event is fictional</Text>
            </View>
          )}

          <Section label="LINEUP">
            {event.lineup?.length ? (
              event.lineup.map((a) => (
                <Text key={a} style={styles.lineupItem}>
                  {a}
                </Text>
              ))
            ) : (
              <Text style={styles.muted}>Lineup to be announced.</Text>
            )}
          </Section>

          <Section label="ABOUT">
            <Text style={styles.paragraph}>
              {event.description ?? 'No description available yet.'}
            </Text>
          </Section>

          {event.sourceUrl && event.isDemo === false && (
            <Section label="SOURCE">
              <Text style={styles.link} onPress={() => Linking.openURL(event.sourceUrl!).catch(() => {})}>
                {event.sourceLabel ?? 'Original post'} ↗
              </Text>
            </Section>
          )}
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: CHARCOAL },
  center: { alignItems: 'center', justifyContent: 'center', gap: 6 },
  back: {
    position: 'absolute',
    left: 16,
    backgroundColor: 'rgba(31,32,40,0.85)',
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  backText: { color: CREAM, fontSize: 15, fontWeight: '700' },

  topBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 8,
  },
  pill: {
    backgroundColor: CARD,
    borderRadius: 999,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  pillText: { color: CREAM, fontSize: 15, fontWeight: '700' },
  sharePill: { backgroundColor: PINK },
  sharePillText: { color: CHARCOAL, fontSize: 15, fontWeight: '800' },

  hero: { flexDirection: 'row', gap: 16, paddingHorizontal: 20, paddingTop: 8, alignItems: 'center' },
  artwork: {
    width: 120,
    height: 120,
    borderRadius: 28,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  artNote: { color: CREAM, fontSize: 44, fontWeight: '800', opacity: 0.9 },
  heroText: { flex: 1, gap: 10, alignItems: 'flex-start' },
  heroTitle: { color: CREAM, fontSize: 28, fontWeight: '900', letterSpacing: -0.8, lineHeight: 32 },
  divider: { height: 1, backgroundColor: CARD_EDGE, marginVertical: 12 },
  blob: { position: 'absolute', borderRadius: 999, opacity: 0.35 },
  blobA: { width: 110, height: 110, top: -30, right: -30 },
  blobB: { width: 70, height: 70, bottom: -20, left: -20, opacity: 0.2 },

  body: { padding: 20, gap: 18 },
  demoBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    alignSelf: 'flex-start',
    backgroundColor: CARD,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  demoDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: CORAL },
  demoText: { color: CREAM_DIM, fontSize: 12, fontWeight: '600' },

  infoCard: {
    backgroundColor: CARD,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: CARD_EDGE,
    padding: 20,
    gap: 3,
  },
  when: { color: CREAM, fontSize: 17, fontWeight: '800' },
  venue: { color: CORAL, fontSize: 15, fontWeight: '700', marginTop: 6 },
  genrePill: {
    alignSelf: 'flex-start',
    backgroundColor: PINK,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
    marginTop: 12,
  },
  genreText: { color: CHARCOAL, fontSize: 12, fontWeight: '800' },

  section: { gap: 8 },
  sectionLabel: { color: CREAM_DIM, fontSize: 12, fontWeight: '800', letterSpacing: 1.5 },
  lineupItem: { color: CREAM, fontSize: 18, fontWeight: '700' },
  paragraph: { color: CREAM, fontSize: 15, lineHeight: 22 },
  muted: { color: CREAM_DIM, fontSize: 14 },
  link: { color: PINK, fontSize: 15, fontWeight: '700', marginTop: 8 },
  title: { color: CREAM, fontSize: 24, fontWeight: '800' },
});
