import { useState, type ReactNode } from 'react';
import { Pressable, Text, View, type LayoutChangeEvent } from 'react-native';

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

/** The narrowest a chip may be and still fit its name and two lines of blurb. */
const CHIP_MIN = 116;

/**
 * How wide each chip is in a row of this width: the fewest rows the options
 * fit in, then as few columns as still fill those rows, sharing the width out
 * evenly.
 *
 * A fixed 116 left a third of a phone's panel empty to the right of two chips,
 * and a fifth of an iPad's beside five — a row of choices that stops short of
 * the panel it is in reads as unfinished. Balanced rather than packed: five
 * themes that fit four to a row are three and two, not four and a stray, and
 * the wider chips keep their blurbs whole. Zero until measured, which is the
 * fixed width, so the first frame is never wider than the page.
 */
const chipWidthFor = (rowWidth: number, count: number): number => {
  if (rowWidth <= 0 || count === 0) return CHIP_MIN;
  const fit = Math.max(
    1,
    Math.min(count, Math.floor((rowWidth + space.small) / (CHIP_MIN + space.small))),
  );
  const columns = Math.ceil(count / Math.ceil(count / fit));
  return Math.floor((rowWidth - space.small * (columns - 1)) / columns);
};

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
  const [rowWidth, setRowWidth] = useState(0);
  const measure = (event: LayoutChangeEvent) => {
    const measured = Math.round(event.nativeEvent.layout.width);
    setRowWidth((current) => (current === measured ? current : measured));
  };
  const width = chipWidthFor(rowWidth, options.length);

  return (
    <View
      accessibilityRole="radiogroup"
      accessibilityLabel={label}
      onLayout={measure}
      style={styles.row}
    >
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
              { width },
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
  // The strongest ink for the edge: the swatch inside already carries every
  // colour the preset has, so the choice is marked by the one it does not.
  chipSelected: { borderColor: colors.textStrong, backgroundColor: colors.surfaceRaised },
  pressed: { opacity: 0.7 },
  art: { alignItems: 'center', justifyContent: 'center', minHeight: 52 },
  name: { ...type.rowTitle, color: colors.textSoft },
  nameSelected: { color: colors.textStrong },
  blurb: { ...type.meta, color: colors.textFaint },
}));
