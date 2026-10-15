import * as Location from 'expo-location';
import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';

import type { Coords } from '@/utils/geo';

export type LocationStatus = 'idle' | 'loading' | 'denied' | 'unavailable' | 'timeout';

const TIMEOUT_MS = 12000;

async function readPosition(): Promise<Coords> {
  const pos = await Promise.race([
    Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), TIMEOUT_MS)),
  ]);
  return { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
}

function explainFirst() {
  return new Promise<boolean>((resolve) => {
    Alert.alert(
      'Find events near you',
      'We use your location once to show events around you and mark where you are on the map. It is never stored or tracked in the background.',
      [
        { text: 'Not now', style: 'cancel', onPress: () => resolve(false) },
        { text: 'Continue', onPress: () => resolve(true) },
      ],
      { cancelable: false },
    );
  });
}

/**
 * One-shot foreground location (no watcher, nothing stored). On first launch it explains why
 * location is needed before the system permission prompt appears.
 */
export function useUserLocation() {
  const [coords, setCoords] = useState<Coords | null>(null);
  const [status, setStatus] = useState<LocationStatus>('idle');

  const fetchOnce = useCallback(async (): Promise<Coords | null> => {
    setStatus('loading');
    try {
      const c = await readPosition();
      setCoords(c);
      setStatus('idle');
      return c;
    } catch (e) {
      setStatus(e instanceof Error && e.message === 'timeout' ? 'timeout' : 'unavailable');
      return null;
    }
  }, []);

  /** Ask (if needed) and read the position. Call from user actions. */
  const request = useCallback(async (): Promise<Coords | null> => {
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== 'granted') {
        setStatus('denied');
        return null;
      }
    } catch {
      setStatus('unavailable');
      return null;
    }
    return fetchOnce();
  }, [fetchOnce]);

  // First launch: explain, then ask. Already granted: just read. Denied: browse without a distance filter.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const perm = await Location.getForegroundPermissionsAsync();
        if (!alive) return;
        if (perm.status === 'granted') {
          await fetchOnce();
        } else if (perm.status === 'undetermined' && perm.canAskAgain) {
          if (await explainFirst()) await request();
          else setStatus('denied');
        } else {
          setStatus('denied');
        }
      } catch {
        setStatus('unavailable');
      }
    })();
    return () => {
      alive = false;
    };
  }, [fetchOnce, request]);

  return { coords, status, request };
}
