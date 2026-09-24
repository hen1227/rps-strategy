import { StyleSheet, Pressable, Text, View } from 'react-native';

import { colors, radius, space, themedSheet, type } from '@/theme';

// One row of tabs.
//
// There used to be three hand-rolled copies of this — the admin screen's
// panels, the opening book's modes, and the explorer's — and they had drifted
// into three looks for the same control: two borders, two gaps, three ideas
// about what a selected tab does, one of them with no selected state at all.
// All three go through here now. What actually differs between callers is what
// a tab is *called*, so that is the only thing they pass.
//
// Not a router: a tab bar that navigated could only ever be used by pages that
// keep the choice in the URL, and the opening book keeps its in state. The
// caller does whatever it does in `onChange` — the admin screen replaces the
// URL, the two openings screens set state.

export interface TabOption<Value> {
  value: Value;
  label: string;
  /** The tiny line above the label — a mode's short code, or a count. */
  eyebrow?: string;
}

export interface TabBarProps<Value> {
  options: readonly TabOption<Value>[];
  value: Value;
  onChange: (value: Value) => void;
  /**
   * Stretch the tabs to share the width. For a small, fixed set where the row
   * reads as a segmented control; a long list wraps instead.
   */
  fill?: boolean;
  accessibilityLabel?: string;
}

export default function TabBar<Value extends string | number>({
  options,
  value,
  onChange,
  fill = false,
  accessibilityLabel,
}: TabBarProps<Value>) {
  return (
    <View
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="tablist"
      style={styles.bar}
    >
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Pressable
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            key={String(option.value)}
            onPress={() => onChange(option.value)}
            style={({ pressed }) => [
              styles.tab,
              fill && styles.tabFill,
              selected && styles.tabSelected,
              pressed && styles.pressed,
            ]}
          >
            {option.eyebrow ? (
              <Text style={[styles.eyebrow, selected && styles.eyebrowSelected]}>
                {option.eyebrow}
              </Text>
            ) : null}
            <Text style={[styles.label, selected && styles.labelSelected]}>{option.label}</Text>
            {/*
              The underline that marks the tab, drawn inside it rather than as a
              rule under the row: a wrapped row has more than one line, and a
              single rule beneath it would sit under the wrong one.
            */}
            <View style={[styles.marker, selected && styles.markerSelected]} />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = themedSheet(() => ({
  bar: { flexDirection: 'row', flexWrap: 'wrap', gap: space.small },
  tab: {
    paddingHorizontal: space.medium,
    paddingTop: space.small,
    paddingBottom: space.snug,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surface,
    // `minWidth: 0` is what lets a tab shrink under `fill` instead of holding
    // the row wider than the panel. See the note in ScreenShell's callers.
    minWidth: 0,
  },
  tabFill: { flexGrow: 1, flexBasis: 0, alignItems: 'center' },
  tabSelected: { borderColor: colors.accentBorder, backgroundColor: colors.accentSurfaceQuiet },
  pressed: { opacity: 0.7 },

  eyebrow: { ...type.eyebrow, color: colors.textFaint },
  eyebrowSelected: { color: colors.accentBright },
  label: { ...type.rowTitle, color: colors.textMuted, marginTop: space.hair },
  labelSelected: { color: colors.textStrong },

  marker: {
    height: 2,
    borderRadius: 1,
    marginTop: space.snug,
    backgroundColor: 'transparent',
  },
  markerSelected: { backgroundColor: colors.accentBright },
}));
