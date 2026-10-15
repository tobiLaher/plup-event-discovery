import * as Location from 'expo-location';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { NIGHT } from '@/components/chip';
import { PressableScale } from '@/components/pressable-scale';
import { type KnownPlace, suggestPlaces } from '@/data/places';
import type { Coords } from '@/utils/geo';

export type Place = { label: string; coords: Coords };

type Props = {
  visible: boolean;
  onClose: () => void;
  /** Local suggestion pool: known areas plus event venues. */
  places: KnownPlace[];
  onSelect: (place: Place) => void;
  /** Resolves true if the user's real position is now available. */
  onUseMyLocation: () => Promise<boolean>;
};

async function labelFor(c: Coords, fallback: string) {
  try {
    const [a] = await Location.reverseGeocodeAsync(c);
    const parts = [a?.name, a?.district ?? a?.subregion, a?.city].filter(
      (p, i, arr): p is string => Boolean(p) && arr.indexOf(p) === i,
    );
    return parts.length ? parts.slice(0, 3).join(', ') : fallback;
  } catch {
    return fallback;
  }
}

export function LocationSearchModal({ visible, onClose, places, onSelect, onUseMyLocation }: Props) {
  const insets = useSafeAreaInsets();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Place[]>([]);
  const [message, setMessage] = useState<string | null>(null);

  // Local, instant suggestions (no network). Remote geocoding happens only on submit.
  const suggestions = useMemo(() => suggestPlaces(text, places), [text, places]);
  const items = results.length ? results : suggestions;

  useEffect(() => {
    if (visible) {
      setText('');
      setResults([]);
      setMessage(null);
      setBusy(false);
    }
  }, [visible]);

  // Geocode only on submit (never per keystroke), using the free on-device geocoder.
  const submit = async () => {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true);
    setMessage(null);
    setResults([]);
    try {
      let found = await Location.geocodeAsync(`${q}, Philippines`);
      if (!found.length) found = await Location.geocodeAsync(q);
      if (!found.length) {
        setMessage(`No match for "${q}". Try a neighborhood, landmark or city name.`);
        return;
      }
      const places = await Promise.all(
        found.slice(0, 5).map(async (f) => {
          const coords = { latitude: f.latitude, longitude: f.longitude };
          return { label: await labelFor(coords, q), coords };
        }),
      );
      if (places.length === 1) onSelect(places[0]);
      else setResults(places);
    } catch {
      setMessage("Couldn't search right now. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  };

  const useMine = async () => {
    setBusy(true);
    setMessage(null);
    const ok = await onUseMyLocation();
    setBusy(false);
    if (!ok) setMessage('Your location is unavailable. Allow location access in Settings, or search for a place.');
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={[styles.container, { paddingBottom: Platform.OS === 'ios' ? 0 : insets.bottom }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.header}>
          <Text style={styles.title}>Choose a location</Text>
          <PressableScale haptic="none" onPress={onClose} hitSlop={10}>
            <Text style={styles.cancel}>Cancel</Text>
          </PressableScale>
        </View>

        <View style={styles.inputRow}>
          <TextInput
            autoFocus
            value={text}
            onChangeText={(t) => {
              setText(t);
              setResults([]);
              setMessage(null);
            }}
            placeholder="City, neighborhood or place"
            placeholderTextColor={NIGHT.creamDim}
            style={styles.input}
            returnKeyType="search"
            onSubmitEditing={submit}
            autoCorrect={false}
          />
          {busy && <ActivityIndicator color={NIGHT.pink} />}
          {text.length > 0 && !busy && (
            <PressableScale haptic="none" onPress={() => { setText(''); setResults([]); setMessage(null); }} hitSlop={10}>
              <Text style={styles.clear}>✕</Text>
            </PressableScale>
          )}
          <PressableScale haptic="light" onPress={submit} style={styles.go}>
            <Text style={styles.goText}>Search</Text>
          </PressableScale>
        </View>

        <PressableScale style={styles.mine} onPress={useMine}>
          <Text style={styles.mineText}>◎  Use my current location</Text>
        </PressableScale>

        {message && <Text style={styles.message}>{message}</Text>}

        <FlatList
          data={items}
          ListHeaderComponent={
            text.trim() && !results.length ? (
              <Text style={styles.listHint}>
                {suggestions.length ? 'Suggestions' : 'No local suggestions'} — tap Search to look up “{text.trim()}” anywhere.
              </Text>
            ) : null
          }
          keyExtractor={(r, i) => `${r.label}-${i}`}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <PressableScale style={styles.result} onPress={() => onSelect(item)}>
              <Text style={styles.resultText} numberOfLines={2}>
                {item.label}
              </Text>
            </PressableScale>
          )}
        />
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: NIGHT.charcoal, paddingHorizontal: 18, paddingTop: 18, gap: 12 },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  title: { color: NIGHT.cream, fontSize: 20, fontWeight: '800' },
  cancel: { color: NIGHT.pink, fontSize: 15, fontWeight: '700' },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: NIGHT.card,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: NIGHT.edge,
    paddingHorizontal: 14,
  },
  input: { flex: 1, color: NIGHT.cream, fontSize: 16, paddingVertical: 12 },
  mine: { alignSelf: 'flex-start', backgroundColor: NIGHT.card, borderRadius: 999, borderWidth: 1, borderColor: NIGHT.edge, paddingHorizontal: 14, paddingVertical: 8 },
  mineText: { color: NIGHT.cream, fontSize: 13, fontWeight: '700' },
  message: { color: NIGHT.coral, fontSize: 13, fontWeight: '600' },
  clear: { color: NIGHT.creamDim, fontSize: 15, paddingHorizontal: 4 },
  go: { backgroundColor: NIGHT.pink, borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  goText: { color: NIGHT.charcoal, fontSize: 13, fontWeight: '800' },
  listHint: { color: NIGHT.creamDim, fontSize: 12, marginBottom: 8 },
  list: { gap: 8, paddingBottom: 24 },
  result: { backgroundColor: NIGHT.card, borderRadius: 16, borderWidth: 1, borderColor: NIGHT.edge, padding: 14 },
  resultText: { color: NIGHT.cream, fontSize: 15, fontWeight: '600' },
});
