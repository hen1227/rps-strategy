import { Pressable, StyleSheet, Text, View } from 'react-native';

import { ANALYSIS_PRESET_LABELS, type AnalysisPreset } from '@/engine/gameAnalysis';
import { REVIEW_PRESETS } from '@/engine/rpsfish/client';
import { colors, radius } from '@/theme';

// The presets a review offers, in the order they are shown. Taken from the
// engine's own table rather than restated, so a new budget appears here the
// moment it exists.
const PRESET_KEYS = Object.keys(REVIEW_PRESETS) as AnalysisPreset[];

/**
 * The engine budget a screen is grading at.
 *
 * One control wherever a game is graded, so "Deep" means the same depth on
 * every screen that offers it. Changing it regrades from the start rather than
 * from here: a report whose moves were graded at different depths compares
 * numbers that were never comparable.
 */
export interface AnalysisPresetPickerProps {
  onChange: (preset: AnalysisPreset) => void;
  value: AnalysisPreset;
}

export default function AnalysisPresetPicker({ onChange, value }: AnalysisPresetPickerProps) {
  return (
    <View style={styles.row}>
      {PRESET_KEYS.map((key) => (
        <Pressable
          accessibilityLabel={`Analyse at ${ANALYSIS_PRESET_LABELS[key]} depth`}
          accessibilityRole="button"
          accessibilityState={{ selected: value === key }}
          key={key}
          onPress={() => onChange(key)}
          style={({ pressed }) => [
            styles.button,
            value === key && styles.buttonActive,
            pressed && styles.pressed,
          ]}
        >
          <Text style={[styles.text, value === key && styles.textActive]}>
            {ANALYSIS_PRESET_LABELS[key]}
          </Text>
        </Pressable>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  button: {
    minHeight: 30,
    justifyContent: 'center',
    paddingHorizontal: 9,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: colors.borderStrong,
    backgroundColor: colors.surface,
  },
  buttonActive: { borderColor: colors.accent, backgroundColor: colors.accentSurfaceRaised },
  text: { color: colors.textMuted, fontSize: 7, fontWeight: '900' },
  textActive: { color: colors.accentSoft },
  pressed: { opacity: 0.68 },
});
