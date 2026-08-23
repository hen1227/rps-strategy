import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '@/theme';

export interface ReplayControlsProps {
  /** Where the viewer is standing, counted in moves. */
  current: number;
  /** What the badge calls the position — `MOVE`, or `LIVE` at the live edge. */
  label?: string;
  onFirst: () => void;
  onLast: () => void;
  onNext: () => void;
  onPrevious: () => void;
  total: number;
}

export default function ReplayControls({
  current,
  label = 'MOVE',
  onFirst,
  onLast,
  onNext,
  onPrevious,
  total,
}: ReplayControlsProps) {
  const atFirst = current <= 0;
  const atLast = current >= total;
  const control = (
    accessibilityLabel: string,
    text: string,
    onPress: () => void,
    disabled = false,
    hint?: string,
  ): ReactNode => (
    <Pressable
      accessibilityHint={hint}
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        disabled && styles.disabled,
        pressed && !disabled && styles.pressed,
      ]}
    >
      <Text style={styles.buttonText}>{text}</Text>
    </Pressable>
  );

  return (
    <View style={styles.controls}>
      {control('Jump to the starting position', '⏮', onFirst, atFirst)}
      {control(
        'Previous position',
        '←',
        onPrevious,
        atFirst,
        'You can also press the left arrow key.',
      )}
      <View style={styles.badge}>
        <Text style={styles.label}>{label}</Text>
        <Text style={styles.value}>
          {current}/{total}
        </Text>
      </View>
      {control(
        'Next position',
        '→',
        onNext,
        atLast,
        'You can also press the right arrow key.',
      )}
      {control('Jump to the latest position', '⏭', onLast, atLast)}
    </View>
  );
}

const styles = StyleSheet.create({
  controls: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    marginTop: 8,
  },
  button: {
    width: 42,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  disabled: { opacity: 0.3 },
  pressed: { opacity: 0.68 },
  buttonText: { color: colors.textSoft, fontSize: 15, fontWeight: '900' },
  badge: {
    minWidth: 68,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    borderRadius: radius.medium,
    backgroundColor: colors.surfaceSunken,
  },
  label: { color: colors.textFaint, fontSize: 7, fontWeight: '900', letterSpacing: 1 },
  value: { color: colors.textStrong, fontSize: 11, fontWeight: '900', marginTop: 1 },
});
