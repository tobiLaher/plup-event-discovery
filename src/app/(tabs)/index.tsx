import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type Ref } from 'react';
import { Keyboard, Platform, Pressable, StyleSheet, Text, TextInput, useWindowDimensions, View } from 'react-native';
import MapView, { Circle, Marker, type Region } from 'react-native-maps';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Chip } from '@/components/chip';
import { FiltersSheet } from '@/components/filters-sheet';
import { PressableScale } from '@/components/pressable-scale';
import { BottomTabInset } from '@/constants/theme';
import { POBLACION_REGION, type MockEvent } from '@/data/mock-events';
import { useEvents } from '@/data/use-events';
import { useUserLocation } from '@/hooks/use-user-location';
import { METRO_MANILA_AREAS, type KnownPlace } from '@/data/places';
import { type Coords, activeFilterCount, type Filters, matchesFilters, NO_FILTERS, regionForCircle } from '@/utils/geo';
import { formatEventWhen, matchesCalendarDate, matchesDate, type DateFilter } from '@/utils/event-dates';

const CHARCOAL = '#1F2028';
const CARD = '#262831';
const CARD_EDGE = '#34363F';
const CREAM = '#F6ECDD';
const CREAM_DIM = '#B9B0A6';
const PINK = '#E8929C';
const CORAL = '#F28B7B';

// Muted charcoal / navy style (Google Maps on Android; iOS uses userInterfaceStyle="dark").
const DARK_MAP_STYLE = [
  { elementType: 'geometry', stylers: [{ color: '#1f2230' }] },
  { elementType: 'labels.text.fill', stylers: [{ color: '#8b8f9e' }] },
  { elementType: 'labels.text.stroke', stylers: [{ color: '#1f2230' }] },
  { featureType: 'poi', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit', stylers: [{ visibility: 'off' }] },
  { featureType: 'administrative', elementType: 'geometry', stylers: [{ color: '#2c3040' }] },
  { featureType: 'road', elementType: 'geometry', stylers: [{ color: '#3a3e4d' }] },
  { featureType: 'road.highway', elementType: 'geometry', stylers: [{ color: '#4a4e5e' }] },
  { featureType: 'water', elementType: 'geometry', stylers: [{ color: '#172033' }] },
  { featureType: 'landscape', elementType: 'geometry', stylers: [{ color: '#23263a' }] },
];

const DATE_FILTERS: { key: DateFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'tonight', label: 'Tonight' },
  { key: 'weekend', label: 'Weekend' },
];

type CircleHandle = { set: (c: { center: Coords; radius: number } | null) => void };

// Owns its own state so dragging the slider re-renders only the circle, not the whole screen.
function RadiusCircle({ handle }: { handle: Ref<CircleHandle> }) {
  const [c, setC] = useState<{ center: Coords; radius: number } | null>(null);
  useImperativeHandle(handle, () => ({ set: setC }), []);
  if (!c) return null;
  return (
    <Circle
      center={c.center}
      radius={c.radius}
      fillColor="rgba(232,146,156,0.16)"
      strokeColor="rgba(232,146,156,0.9)"
      strokeWidth={2}
    />
  );
}

function EventPin({ active }: { active: boolean }) {
  return (
    <View style={styles.pinWrap}>
      <View style={[styles.pinBubble, active && styles.pinBubbleActive]}>
        <Text style={styles.pinNote}>♪</Text>
      </View>
    </View>
  );
}

export default function ExploreMapScreen() {
  const insets = useSafeAreaInsets();
  const [selectedRaw, setSelected] = useState<MockEvent | null>(null);
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const circleRef = useRef<CircleHandle>(null);
  const sheetHs = useRef({ full: 380, compact: 190 });
  const fitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [headerH, setHeaderH] = useState(120);
  const [notice, setNotice] = useState<string | null>(null);
  const { height: winH, width: winW } = useWindowDimensions();
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const { coords: userLoc, status: locStatus, request: requestLocation } = useUserLocation();
  const mapRef = useRef<MapView>(null);
  const currentRegion = useRef<Region>(POBLACION_REGION);
  const savedRegion = useRef<Region | null>(null);
  const wentToDetails = useRef(false);
  const previewSaved = useRef<Region | null>(null);
  const autoCentered = useRef(false);
  const userMoved = useRef(false);
  const [cardH, setCardH] = useState(0);
  const { events: allEvents, loading, error } = useEvents();
  // Genres come from the data; events without a genre simply don't appear under a genre.
  const genres = Array.from(new Set(allEvents.map((e) => e.genre).filter((g): g is string => Boolean(g))));
  const suggestionPlaces = useMemo<KnownPlace[]>(
    () => [
      ...METRO_MANILA_AREAS,
      ...allEvents.map((e) => ({
        label: `${e.venue} · ${e.area}`,
        coords: { latitude: e.latitude, longitude: e.longitude },
        kind: 'venue' as const,
      })),
    ],
    [allEvents],
  );
  const events = allEvents.filter(
    (e) => (filters.date ? matchesCalendarDate(e.startsAt, filters.date) : matchesDate(e.startsAt, dateFilter)) && matchesFilters(e, filters, userLoc) &&
      (!q || [e.title, e.venue, e.area, ...(e.lineup ?? [])].some((t) => t.toLowerCase().includes(q))),
  );
  // Dismiss the preview card if its event was filtered out.
  const selected = selectedRaw && events.some((e) => e.id === selectedRaw.id) ? selectedRaw : null;
  const lastMarkerPress = useRef(0);

  // Custom marker views are snapshotted; re-track briefly whenever the selection changes.
  const [tracking, setTracking] = useState(true);
  useEffect(() => {
    setTracking(true);
    const t = setTimeout(() => setTracking(false), 400);
    return () => clearTimeout(t);
  }, [selected, userLoc]);

  // Restore the pre-focus camera when the preview goes away (dismissed, filtered out, or back from details).
  const selectedId = selected?.id ?? null;
  useEffect(() => {
    if (selectedId === null && savedRegion.current) {
      mapRef.current?.animateToRegion(savedRegion.current, 500);
      savedRegion.current = null;
    }
  }, [selectedId]);

  useFocusEffect(
    useCallback(() => {
      if (wentToDetails.current) {
        wentToDetails.current = false;
        setSelected(null);
      }
    }, []),
  );

  const focusEvent = (event: MockEvent) => {
    if (!savedRegion.current) savedRegion.current = currentRegion.current;
    const delta = Math.min(currentRegion.current.latitudeDelta, 0.012);
    mapRef.current?.animateToRegion(
      {
        // shift down slightly so the pin sits above the preview card
        latitude: event.latitude - delta * 0.18,
        longitude: event.longitude,
        latitudeDelta: delta,
        longitudeDelta: delta,
      },
      500,
    );
  };

  const flash = (msg: string) => {
    setNotice(msg);
    setTimeout(() => setNotice(null), 3500);
  };

  const bottomOffset = BottomTabInset + 16;
  const fitCircle = (center: Coords, radius: number, sheetHeight: number | null) => {
    const top = insets.top + 8 + headerH + 8;
    const bottom = sheetHeight === null ? BottomTabInset + 8 : bottomOffset + sheetHeight + 8;
    mapRef.current?.animateToRegion(regionForCircle(center, radius, { width: winW, height: winH }, top, bottom), 500);
  };

  const recenter = async () => {
    // Always use a real GPS fix; never assume the map center is the user's location.
    const c = await requestLocation();
    if (!c) {
      flash("Couldn't get your location. Check Location access in Settings.");
      return;
    }
    savedRegion.current = null; // deliberate move: don't snap back later
    mapRef.current?.animateToRegion({ ...c, latitudeDelta: 0.03, longitudeDelta: 0.03 }, 600);
  };

  // First fix: center once on the user (never again, and never over a manual map move).
  useEffect(() => {
    if (!userLoc || autoCentered.current) return;
    autoCentered.current = true;
    if (!userMoved.current) {
      mapRef.current?.animateToRegion({ ...userLoc, latitudeDelta: 0.08, longitudeDelta: 0.08 }, 600);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userLoc]);

  // Tell people once if location is unavailable; events stay browsable without a distance filter.
  useEffect(() => {
    if (locStatus === 'denied') flash('Location is off. Showing all events — search a place in Filters.');
    else if (locStatus === 'timeout') flash("Location timed out. Tap ◎ to try again.");
    else if (locStatus === 'unavailable') flash('Location is unavailable right now.');
  }, [locStatus]);

  const openFilters = () => {
    Keyboard.dismiss();
    setSelected(null);
    setFiltersOpen(true);
  };

  const closeFilters = () => {
    setFiltersOpen(false);
    circleRef.current?.set(null);
    // Dismissed without applying: put the camera back where it was.
    if (previewSaved.current) mapRef.current?.animateToRegion(previewSaved.current, 400);
    previewSaved.current = null;
  };

  const applyFilters = (f: Filters) => {
    setFilters(f);
    setFiltersOpen(false);
    circleRef.current?.set(null);
    previewSaved.current = null;
    savedRegion.current = null;
    setSelected(null);
    const center = f.place?.coords ?? userLoc;
    if (center && f.distanceKm > 0) fitCircle(center, f.distanceKm * 1000, null);
    // A chosen place without a radius only moves the map; it never filters by distance.
    else if (f.place) {
      mapRef.current?.animateToRegion({ ...f.place.coords, latitudeDelta: 0.06, longitudeDelta: 0.06 }, 600);
    }
  };

  // Radius preview: the circle updates continuously; the camera only refits on committed values
  // (or if a drag outgrows the visible map), debounced.
  const handlePreview = useCallback(
    (center: Coords | null, km: number, final: boolean) => {
      if (!center || km <= 0) {
        circleRef.current?.set(null);
        return;
      }
      circleRef.current?.set({ center, radius: km * 1000 });
      const visibleMeters = currentRegion.current.latitudeDelta * 111000 * 0.55;
      if (!final && visibleMeters >= km * 2000 * 1.05) return;
      if (fitTimer.current) clearTimeout(fitTimer.current);
      fitTimer.current = setTimeout(
        () => {
          if (!previewSaved.current) previewSaved.current = currentRegion.current;
          fitCircle(center, km * 1000, final ? sheetHs.current.full : sheetHs.current.compact);
        },
        final ? 0 : 250,
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [insets.top, headerH, winW, winH],
  );

  const markers = useMemo(
    () =>
      events.map((event) => (
        <Marker
          key={event.id}
          coordinate={{ latitude: event.latitude, longitude: event.longitude }}
          anchor={{ x: 0.5, y: 0.5 }}
          tracksViewChanges={tracking}
          zIndex={selectedId === event.id ? 2 : 1}
          onPress={() => {
            lastMarkerPress.current = Date.now();
            Keyboard.dismiss();
            setSelected(event);
            focusEvent(event);
          }}>
          <EventPin active={selectedId === event.id} />
        </Marker>
      )),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [events, selectedId, tracking],
  );

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        initialRegion={POBLACION_REGION}
        userInterfaceStyle="dark"
        customMapStyle={DARK_MAP_STYLE}
        showsPointsOfInterests={false}
        toolbarEnabled={false}
        onRegionChangeComplete={(region, details) => {
          currentRegion.current = region;
          // The user took over the camera: don't snap back to the saved view later.
          if (details?.isGesture) {
            savedRegion.current = null;
            userMoved.current = true;
          }
        }}
        onPress={() => {
          // Apple Maps can also deliver the map press right after a marker press;
          // ignore it so the card isn't closed the moment it opens.
          if (Date.now() - lastMarkerPress.current < 400) return;
          if (filtersOpen) closeFilters();
          Keyboard.dismiss();
          setSelected(null);
        }}>
        {markers}
        <RadiusCircle handle={circleRef} />
        {userLoc && (
          <Marker coordinate={userLoc} anchor={{ x: 0.5, y: 0.5 }} tracksViewChanges={tracking} zIndex={0}>
            <View style={styles.meDotOuter}>
              <View style={styles.meDot} />
            </View>
          </Marker>
        )}
      </MapView>

      <View
        style={[styles.header, { top: insets.top + 8 }]}
        pointerEvents="box-none"
        onLayout={(e) => setHeaderH(e.nativeEvent.layout.height)}>
        <View style={styles.panel}>
          <View style={styles.titleRow}>
            <Text style={styles.heading}>What's happening? ✦</Text>
            <PressableScale
              hitSlop={10}
              pressableStyle={styles.searchInner}
              style={[styles.searchBtn, (searchOpen || q) && styles.chipActive]}
              onPress={() => {
                if (searchOpen) Keyboard.dismiss();
                setSearchOpen((o) => !o);
              }}>
              <Text style={[styles.searchIcon, (searchOpen || q) && styles.chipTextActive]}>⌕</Text>
            </PressableScale>
          </View>
          {searchOpen && (
            <View style={styles.searchRow}>
              <TextInput
                autoFocus
                value={query}
                onChangeText={setQuery}
                placeholder="Search events, artists, venues..."
                placeholderTextColor={CREAM_DIM}
                style={styles.searchInput}
                returnKeyType="search"
                onSubmitEditing={() => Keyboard.dismiss()}
                autoCorrect={false}
              />
              {query.length > 0 && (
                <Pressable hitSlop={10} onPress={() => setQuery('')}>
                  <Text style={styles.clear}>✕</Text>
                </Pressable>
              )}
            </View>
          )}
          <View style={styles.chipRow}>
            {DATE_FILTERS.map((f) => (
              <Chip
                key={f.key}
                label={f.label}
                active={!filters.date && dateFilter === f.key}
                onPress={() => {
                  setDateFilter(f.key);
                  if (filters.date) setFilters((cur) => ({ ...cur, date: null }));
                }}
              />
            ))}
            <Chip
              label={activeFilterCount(filters) ? `Filters · ${activeFilterCount(filters)}` : 'Filters'}
              active={activeFilterCount(filters) > 0 || filtersOpen}
              onPress={() => (filtersOpen ? closeFilters() : openFilters())}
            />
          </View>
          {(loading || error) && (
            <Text style={styles.statusText}>
              {loading ? 'Loading events…' : 'Offline · showing demo events only'}
            </Text>
          )}
        </View>
      </View>

      {events.length === 0 && !loading && !filtersOpen && (
        <View style={styles.empty} pointerEvents="none">
          <Text style={styles.emptyTitle}>No events match 🌙</Text>
          <Text style={styles.emptyText}>Try clearing a filter or searching something else.</Text>
        </View>
      )}

      {!filtersOpen && (
        <View
          pointerEvents="box-none"
          style={[styles.recenterWrap, { bottom: BottomTabInset + 16 + (selected ? cardH + 12 : 0) }]}>
          {notice && (
            <View style={styles.noticePill} pointerEvents="none">
              <Text style={styles.noticeText}>{notice}</Text>
            </View>
          )}
          <PressableScale haptic="light" onPress={recenter} style={styles.recenter} pressableStyle={styles.searchInner}>
            <Text style={styles.recenterIcon}>{locStatus === 'loading' ? '…' : '◎'}</Text>
          </PressableScale>
        </View>
      )}

      {filtersOpen && (
        <FiltersSheet
          applied={filters}
          genres={genres}
          places={suggestionPlaces}
          userLoc={userLoc}
          locStatus={locStatus}
          requestLocation={requestLocation}
          bottom={bottomOffset}
          maxHeight={winH - insets.top - 80 - BottomTabInset}
          onPreview={handlePreview}
          onHeight={(h, compact) => {
            sheetHs.current[compact ? 'compact' : 'full'] = h;
          }}
          onApply={applyFilters}
          onClose={closeFilters}
        />
      )}

      {selected && !filtersOpen && (
        <PressableScale
          style={styles.card}
          onLayout={(e) => setCardH(e.nativeEvent.layout.height)}
          onPress={() => {
            wentToDetails.current = true;
            router.push({ pathname: '/event/[id]', params: { id: selected.id } });
          }}>
          <View style={styles.cardHeader}>
            {selected.genre ? (
              <View style={styles.genrePill}>
                <Text style={styles.genreText}>♪ {selected.genre}</Text>
              </View>
            ) : (
              <View />
            )}
            <View style={styles.demoTagPill}>
              <Text style={styles.demoTag}>{selected.reviewStatus === 'pending_review' ? 'UNVERIFIED' : selected.isDemo === false ? 'LISTED' : 'DEMO'}</Text>
            </View>
          </View>
          <Text style={styles.title}>{selected.title}</Text>
          <Text style={styles.venue}>{selected.venue}</Text>
          <Text style={styles.area}>{selected.area}</Text>
          <Text style={styles.when}>{formatEventWhen(selected)}</Text>
          <Text style={styles.more}>View details ›</Text>
        </PressableScale>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: CHARCOAL },
  header: { position: 'absolute', left: 12, right: 12 },
  panel: {
    backgroundColor: 'rgba(31,32,40,0.94)',
    borderRadius: 24,
    borderWidth: 1,
    borderColor: CARD_EDGE,
    paddingTop: 12,
    paddingBottom: 10,
    gap: 10,
  },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 16 },
  searchBtn: { marginLeft: 'auto', width: 30, height: 30, borderRadius: 15, backgroundColor: CARD, borderWidth: 1, borderColor: CARD_EDGE, alignItems: 'center', justifyContent: 'center' },
  searchInner: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  searchIcon: { color: CREAM, fontSize: 18, fontWeight: '700', marginTop: -2 },
  searchRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: CARD, borderRadius: 14, borderWidth: 1, borderColor: CARD_EDGE, marginHorizontal: 12, paddingHorizontal: 12 },
  searchInput: { flex: 1, color: CREAM, fontSize: 14, paddingVertical: 9 },
  statusText: { color: CREAM_DIM, fontSize: 11, fontWeight: '600', paddingHorizontal: 16 },
  meDotOuter: { width: 22, height: 22, borderRadius: 11, backgroundColor: 'rgba(110,168,254,0.28)', alignItems: 'center', justifyContent: 'center' },
  meDot: { width: 12, height: 12, borderRadius: 6, backgroundColor: '#6EA8FE', borderWidth: 2, borderColor: CREAM },
  recenterWrap: { position: 'absolute', right: 16, left: 16, alignItems: 'flex-end', gap: 8 },
  recenter: { width: 40, height: 40, borderRadius: 20, backgroundColor: CARD, borderWidth: 1, borderColor: CARD_EDGE },
  noticePill: { backgroundColor: CARD, borderRadius: 14, borderWidth: 1, borderColor: CARD_EDGE, paddingHorizontal: 12, paddingVertical: 8 },
  noticeText: { color: CREAM, fontSize: 12, fontWeight: '600' },
  recenterIcon: { color: CREAM, fontSize: 20, marginTop: -1 },
  clear: { color: CREAM_DIM, fontSize: 14, paddingLeft: 8 },
  chipScroll: { flexGrow: 0 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12, gap: 8 },
  chip: {
    backgroundColor: CARD,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: CARD_EDGE,
  },
  chipActive: { backgroundColor: PINK, borderColor: PINK },
  chipText: { color: CREAM_DIM, fontSize: 12, fontWeight: '700' },
  chipTextActive: { color: CHARCOAL },
  empty: {
    position: 'absolute',
    alignSelf: 'center',
    top: '45%',
    backgroundColor: CARD,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: CARD_EDGE,
    paddingHorizontal: 22,
    paddingVertical: 16,
    alignItems: 'center',
    gap: 2,
  },
  emptyTitle: { color: CREAM, fontSize: 16, fontWeight: '800' },
  emptyText: { color: CREAM_DIM, fontSize: 13 },
  heading: { color: CREAM, fontSize: 18, fontWeight: '800', letterSpacing: -0.3 },
  demoBadge: {
    borderWidth: 1,
    borderColor: CORAL,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  demoBadgeText: { color: CORAL, fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },

  pinWrap: { padding: 3 },
  pinBubble: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: PINK,
    borderWidth: 2,
    borderColor: CREAM,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pinBubbleActive: { backgroundColor: CORAL, transform: [{ scale: 1.25 }] },
  pinNote: { color: CHARCOAL, fontSize: 14, fontWeight: '800' },

  card: {
    position: 'absolute',
    left: 16,
    right: 16,
    bottom: BottomTabInset + 16,
    backgroundColor: CARD,
    borderRadius: 28,
    padding: 22,
    borderWidth: 1,
    borderColor: CARD_EDGE,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOpacity: 0.35,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 8 },
      },
      default: { elevation: 10 },
    }),
  },
  cardHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  genrePill: {
    backgroundColor: PINK,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 5,
  },
  genreText: { color: CHARCOAL, fontSize: 12, fontWeight: '800', letterSpacing: 0.3 },
  demoTagPill: {
    borderWidth: 1,
    borderColor: CREAM_DIM,
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  demoTag: { color: CREAM_DIM, fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  title: {
    color: CREAM,
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: -0.6,
    marginTop: 14,
  },
  venue: { color: CORAL, fontSize: 15, fontWeight: '700', marginTop: 4 },
  area: { color: CREAM_DIM, fontSize: 13, marginTop: 1 },
  when: { color: CREAM, fontSize: 14, fontWeight: '600', marginTop: 12 },
  more: { color: PINK, fontSize: 13, fontWeight: '700', marginTop: 10 },
});
