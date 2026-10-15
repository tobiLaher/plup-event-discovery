import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Animated,
  Pressable,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

type Props = Omit<PressableProps, 'style'> & {
  style?: StyleProp<ViewStyle>;
  /** Haptic fired once per press. Never blocks onPress if unavailable. */
  haptic?: 'selection' | 'light' | 'none';
  /** Style for the inner pressable (e.g. to center content). */
  pressableStyle?: StyleProp<ViewStyle>;
};

export function useReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    AccessibilityInfo.isReduceMotionEnabled().then(setReduced).catch(() => {});
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setReduced);
    return () => sub.remove();
  }, []);
  return reduced;
}

export function triggerHaptic(kind: 'selection' | 'light') {
  try {
    const p =
      kind === 'selection'
        ? Haptics.selectionAsync()
        : Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    p.catch(() => {});
  } catch {}
}

export function PressableScale({ style, pressableStyle, haptic = 'light', onPress, children, ...rest }: Props) {
  const scale = useRef(new Animated.Value(1)).current;
  const reduced = useReducedMotion();

  const animate = (to: number, fast: boolean) => {
    if (reduced) return;
    Animated.spring(scale, {
      toValue: to,
      speed: fast ? 60 : 30,
      bounciness: fast ? 0 : 6,
      useNativeDriver: true,
    }).start();
  };

  return (
    <Animated.View style={[style, { transform: [{ scale }] }]}>
      <Pressable
        {...rest}
        style={pressableStyle}
        onPressIn={(e) => {
          animate(0.97, true);
          rest.onPressIn?.(e);
        }}
        onPressOut={(e) => {
          animate(1, false);
          rest.onPressOut?.(e);
        }}
        onPress={(e) => {
          if (haptic !== 'none') triggerHaptic(haptic);
          onPress?.(e);
        }}>
        {children}
      </Pressable>
    </Animated.View>
  );
}
