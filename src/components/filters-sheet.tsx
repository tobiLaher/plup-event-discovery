import Slider from '@react-native-community/slider';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, LayoutAnimation, PanResponder, ScrollView, StyleSheet, Text, View } from 'react-native';

import { CalendarPicker } from '@/components/calendar-picker';
import { Chip, NIGHT } from '@/components/chip';
import { LocationSearchModal, type Place } from '@/components/location-search-modal';
import { PressableScale, triggerHaptic, useReducedMotion } from '@/components/pressable-scale';
import type { KnownPlace } from '@/data/places';
import type { LocationStatus } from '@/hooks/use-user-location';
import { formatYmd } from '@/utils/event-dates';
import {
  type Coords,
  type Filters,
  filterCenter,
  formatKm,
  MAX_DISTANCE_KM,
  NO_FILTERS,
  roundKm,
  sameFilters,
} from '@/utils/geo';

type Props = {
  applied: Filters;
  genres: string[];
  places: KnownPlace[];
  userLoc: Coords | null;
  locStatus: LocationStatus;
  requestLocation: () => Promise<Coords | null>;
  bottom: number;
  maxHeight: number;
  /**
   * Radius preview for the map. `km <= 0` or no center hides it. `final` is false while the
   * slider is being dragged (circle only) and true when a value is committed (camera may refit).
   */
  onPreview: (center: Coords | null, km: number, final: boolean) => void;
  onHeight: (h: number, compact: boolean) => void;
  onApply: (f: Filters) => void;
  /** Dismissed without applying: drafts are discarded. */
  onClose: () => void;
};

const OFFSCREEN = 600;

export function FiltersSheet({
  applied,
  genres,
  places,
  userLoc,
  locStatus,
  requestLocation,
  bottom,
  maxHeight,
  onPreview,
  onHeight,
  onApply,
  onClose,
}: Props) {
  const reduced = useReducedMotion();
  const [draft, setDraft] = useState<Filters>(applied);
  const [liveKm, setLiveKm] = useState(applied.distanceKm); // label while dragging
  const [searchOpen, setSearchOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [compact, setCompact] = useState(false); // while dragging the slider, show more map
  const compactRef = useRef(false);
  compactRef.current = compact;
  const translateY = useRef(new Animated.Value(OFFSCREEN)).current;

  const center = filterCenter(draft, userLoc);
  const dirty = !sameFilters(draft, applied);

  useEffect(() => {
    Animated.timing(translateY, { toValue: 0, duration: reduced ? 0 : 240, useNativeDriver: true }).start();
  }, [translateY, reduced]);

  const animateOut = (then: () => void) => {
    Animated.timing(translateY, { toValue: OFFSCREEN, duration: reduced ? 0 : 200, useNativeDriver: true }).start(then);
  };

  // Committed changes (open, place or distance change) refit the camera; not every drag tick.
  useEffect(() => {
    onPreview(center, draft.distanceKm, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center?.latitude, center?.longitude, draft.distanceKm]);

  // Live circle while dragging: throttled (~30 fps) leading + trailing, no state, no camera.
  const dragTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<number | null>(null);
  const centerRef = useRef(center);
  centerRef.current = center;
  const pushDrag = (km: number) => {
    pending.current = km;
    if (dragTimer.current) return;
    onPreview(centerRef.current, km, false);
    dragTimer.current = setTimeout(() => {
      dragTimer.current = null;
      if (pending.current !== null) onPreview(centerRef.current, pending.current, false);
    }, 33);
  };
  useEffect(
    () => () => {
      if (dragTimer.current) clearTimeout(dragTimer.current);
    },
    [],
  );

  // Swipe down on the handle area to dismiss.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderMove: (_, g) => translateY.setValue(Math.max(0, g.dy)),
        onPanResponderRelease: (_, g) => {
          if (g.dy > 90 || g.vy > 0.9) {
            Animated.timing(translateY, { toValue: OFFSCREEN, duration: 180, useNativeDriver: true }).start(() =>
              closeRef.current(),
            );
          } else {
            Animated.spring(translateY, { toValue: 0, useNativeDriver: true, bounciness: 0 }).start();
          }
        },
      }),
    [translateY],
  );

  const setCompactAnimated = (v: boolean) => {
    if (!reduced) LayoutAnimation.configureNext(LayoutAnimation.create(160, 'easeInEaseOut', 'opacity'));
    setCompact(v);
  };

  // Picking a place only moves the map focus; it never silently turns on a radius.
  const pickPlace = (place: Place) => {
    triggerHaptic('selection');
    setDraft((d) => ({ ...d, place: { label: place.label, coords: place.coords } }));
    setSearchOpen(false);
  };

  const useMyLocation = async () => {
    const c = userLoc ?? (await requestLocation());
    if (c) {
      triggerHaptic('selection');
      setDraft((d) => ({ ...d, place: null }));
      setSearchOpen(false);
    }
    return Boolean(c);
  };

  const noCenter = !center;

  return (
    <Animated.View
      onLayout={(e) => onHeight(e.nativeEvent.layout.height, compactRef.current)}
      style={[styles.sheet, { bottom, maxHeight, transform: [{ translateY }] }]}>
      <View {...pan.panHandlers} style={styles.grabber}>
        <View style={styles.handle} />
        <View style={styles.titleRow}>
          <Text style={styles.title}>Filters</Text>
          {dirty && <Text style={styles.draftTag}>Draft · tap Show Events to apply</Text>}
        </View>
      </View>

      {!compact && (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}>
          <Text style={styles.label}>LOCATION</Text>
          <PressableScale style={styles.locRow} onPress={() => setSearchOpen(true)}>
            <Text style={styles.locText} numberOfLines={1}>
              {draft.place ? `📍 ${draft.place.label}` : userLoc ? '◎ My current location' : 'Search a city, area or place'}
            </Text>
            <Text style={styles.locAction}>Change</Text>
          </PressableScale>
          {draft.place && (
            <View style={styles.row}>
              <Chip label="Use my current location" active={false} onPress={useMyLocation} />
            </View>
          )}

          <Text style={styles.label}>DATE</Text>
          <View style={styles.row}>
            <Chip label="Any date" active={draft.date === null} onPress={() => setDraft((d) => ({ ...d, date: null }))} />
            <Chip
              label={draft.date ? `📅 ${formatYmd(draft.date)}` : '📅 Pick a date'}
              active={draft.date !== null}
              onPress={() => setCalendarOpen(true)}
            />
          </View>

          <Text style={styles.label}>MUSIC GENRE</Text>
          <View style={styles.row}>
            <Chip label="All genres" active={draft.genre === null} onPress={() => setDraft((d) => ({ ...d, genre: null }))} />
            {genres.map((g) => (
              <Chip
                key={g}
                label={g}
                active={draft.genre === g}
                onPress={() => setDraft((d) => ({ ...d, genre: d.genre === g ? null : g }))}
              />
            ))}
          </View>
        </ScrollView>
      )}

      {/* Pinned below the scroll area so the slider never moves under the finger. */}
      <View style={styles.distance}>
        <View style={styles.distanceHeader}>
          <Text style={styles.label}>DISTANCE</Text>
          <Text style={styles.distanceValue}>{formatKm(roundKm(liveKm))}</Text>
        </View>
        <Slider
          style={styles.slider}
          minimumValue={0}
          maximumValue={MAX_DISTANCE_KM}
          step={0}
          value={draft.distanceKm}
          disabled={noCenter}
          minimumTrackTintColor={NIGHT.pink}
          maximumTrackTintColor={NIGHT.edge}
          thumbTintColor={NIGHT.cream}
          onSlidingStart={() => setCompactAnimated(true)}
          onValueChange={(v) => {
            // Continuous: the circle follows the raw value; only the label rounds to 0.5 km.
            setLiveKm(v);
            pushDrag(v);
          }}
          onSlidingComplete={(v) => {
            const km = roundKm(v);
            triggerHaptic('light');
            setLiveKm(km);
            setDraft((d) => ({ ...d, distanceKm: km }));
            setCompactAnimated(false);
          }}
        />
        <View style={styles.minMax}>
          <Text style={styles.hint}>Any</Text>
          <Text style={styles.hint}>{MAX_DISTANCE_KM} km</Text>
        </View>
        {noCenter && (
          <Text style={styles.notice}>
            {locStatus === 'loading'
              ? 'Finding your location…'
              : 'Choose a location above to filter by distance.'}
          </Text>
        )}
      </View>

      <View style={styles.actions}>
        <PressableScale
          style={styles.reset}
          onPress={() => {
            setDraft(NO_FILTERS);
            setLiveKm(0);
          }}>
          <Text style={styles.resetText}>Reset</Text>
        </PressableScale>
        <PressableScale style={styles.show} onPress={() => animateOut(() => onApply(draft))}>
          <Text style={styles.showText}>Show Events</Text>
        </PressableScale>
      </View>

      <LocationSearchModal
        visible={searchOpen}
        places={places}
        onClose={() => setSearchOpen(false)}
        onSelect={pickPlace}
        onUseMyLocation={useMyLocation}
      />
      <CalendarPicker
        visible={calendarOpen}
        value={draft.date}
        onClose={() => setCalendarOpen(false)}
        onSelect={(date) => {
          setDraft((d) => ({ ...d, date }));
          setCalendarOpen(false);
        }}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute',
    left: 8,
    right: 8,
    backgroundColor: NIGHT.card,
    borderRadius: 28,
    borderWidth: 1,
    borderColor: NIGHT.edge,
    paddingBottom: 14,
    overflow: 'hidden',
  },
  grabber: { paddingTop: 8, paddingHorizontal: 18, paddingBottom: 6, gap: 6 },
  handle: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: NIGHT.edge },
  titleRow: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  title: { color: NIGHT.cream, fontSize: 20, fontWeight: '800' },
  draftTag: { color: NIGHT.coral, fontSize: 11, fontWeight: '700' },
  scroll: { flexShrink: 1 },
  content: { paddingHorizontal: 18, paddingBottom: 8, gap: 10 },
  label: { color: NIGHT.creamDim, fontSize: 11, fontWeight: '800', letterSpacing: 1.4, marginTop: 6 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  locRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    backgroundColor: NIGHT.charcoal,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: NIGHT.edge,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  locText: { flex: 1, color: NIGHT.cream, fontSize: 14, fontWeight: '600' },
  locAction: { color: NIGHT.pink, fontSize: 13, fontWeight: '700' },
  distance: { paddingHorizontal: 18, paddingTop: 6 },
  distanceHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  distanceValue: { color: NIGHT.cream, fontSize: 20, fontWeight: '800' },
  slider: { width: '100%', height: 36 },
  minMax: { flexDirection: 'row', justifyContent: 'space-between' },
  hint: { color: NIGHT.creamDim, fontSize: 12 },
  notice: { color: NIGHT.coral, fontSize: 12, fontWeight: '600', marginTop: 6 },
  actions: { flexDirection: 'row', gap: 10, paddingHorizontal: 18, paddingTop: 10 },
  reset: { borderRadius: 999, borderWidth: 1, borderColor: NIGHT.edge, paddingHorizontal: 20, paddingVertical: 12 },
  resetText: { color: NIGHT.cream, fontSize: 15, fontWeight: '700' },
  show: { flex: 1, borderRadius: 999, backgroundColor: NIGHT.pink, paddingVertical: 12, alignItems: 'center' },
  showText: { color: NIGHT.charcoal, fontSize: 15, fontWeight: '800' },
});
