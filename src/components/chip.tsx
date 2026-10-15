import { useEffect, useRef } from 'react';
import { Animated, StyleSheet } from 'react-native';

import { PressableScale, useReducedMotion } from '@/components/pressable-scale';

export const NIGHT = {
  charcoal: '#1F2028',
  card: '#262831',
  edge: '#34363F',
  cream: '#F6ECDD',
  creamDim: '#B9B0A6',
  pink: '#E8929C',
  coral: '#F28B7B',
};

type Props = { label: string; active: boolean; onPress: () => void; disabled?: boolean };

export function Chip({ label, active, onPress, disabled }: Props) {
  const progress = useRef(new Animated.Value(active ? 1 : 0)).current;
  const reduced = useReducedMotion();
  useEffect(() => {
    Animated.timing(progress, {
      toValue: active ? 1 : 0,
      duration: reduced ? 0 : 160,
      useNativeDriver: false,
    }).start();
  }, [active, progress, reduced]);
  const backgroundColor = progress.interpolate({ inputRange: [0, 1], outputRange: [NIGHT.card, NIGHT.pink] });
  const borderColor = progress.interpolate({ inputRange: [0, 1], outputRange: [NIGHT.edge, NIGHT.pink] });
  const color = progress.interpolate({ inputRange: [0, 1], outputRange: [NIGHT.creamDim, NIGHT.charcoal] });
  return (
    <PressableScale haptic="selection" onPress={onPress} disabled={disabled} style={disabled && styles.disabled}>
      <Animated.View style={[styles.chip, { backgroundColor, borderColor }]}>
        <Animated.Text style={[styles.text, { color }]}>{label}</Animated.Text>
      </Animated.View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  chip: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6, borderWidth: 1 },
  text: { fontSize: 12, fontWeight: '700' },
  disabled: { opacity: 0.4 },
});
