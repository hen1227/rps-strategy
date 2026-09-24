import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { colors, radius, space, themedSheet, type } from '@/theme';

// A row of choices that show themselves.
//
// `OptionChips` in `ui/primitives` is the text version, and it is the right one
// nearly everywhere: a clock or a game mode is a word. A look is not. A row
// reading "Forest · Midnight · Charcoal · Parchment · Contrast" tells a player
// nothing they can act on, so every chip here carries a drawing of what it does
// — the actual surfaces, the actual squares, the actual piece — and the name
// underneath it as a label rather than as the choice itself.

export interface Swatch<Value extends string> {
  value: Value;
  label: string;
  /** One line under the name, for what the picture cannot say. */
  blurb?: string;
  /** The drawing. Sized by the caller; this component only frames it. */
  preview: ReactNode;
}

export interface SwatchChipsProps<Value extends string> {
  options: readonly Swatch<Value>[];
  value: Value;
  onChange: (value: Value) => void;
  /** Read aloud in place of the row. */
  label: string;
}

export default function SwatchChips<Value extends string>({
  options,
  value,
  onChange,
  label,
}: SwatchChipsProps<Value>) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.row}>
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            accessibilityLabel={option.label}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            key={option.value}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              styles.chip,
              selected && styles.chipSelected,
              pressed && styles.pressed,
            ]}
          >
            <View style={styles.art}>{option.preview}</View>
            <Text numberOfLines={1} style={[styles.name, selected && styles.nameSelected]}>
              {option.label}
            </Text>
            {option.blurb ? (
              <Text numberOfLines={2} style={styles.blurb}>
                {option.blurb}
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = themedSheet(() => ({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: space.small },
  chip: {
    width: 116,
    padding: space.small,
    gap: space.tight,
    borderRadius: radius.large,
    borderWidth: 2,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSunken,
  },
  // Two points of border rather than one, and the accent rather than a tint:
  // this row is read at a glance from across a settings page, and a one-pixel
  // edge on a card that is itself full of colour does not survive that.
  chipSelected: { borderColor: colors.accent, backgroundColor: colors.accentSurfaceQuiet },
  pressed: { opacity: 0.7 },
  art: { alignItems: 'center', justifyContent: 'center', minHeight: 52 },
  name: { ...type.rowTitle, color: colors.textSoft },
  nameSelected: { color: colors.accentTextStrong },
  blurb: { ...type.meta, color: colors.textFaint },
}));
