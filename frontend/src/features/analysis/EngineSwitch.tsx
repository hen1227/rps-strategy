import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, themedSheet } from '@/theme';

/**
 * Whether this screen asks RPSFish anything at all.
 *
 * It ships off. RPSFish is weaker than most of the bots people play here, so a
 * badge calling somebody's move a blunder is as likely to be the engine's
 * mistake as the player's — and a grade is read as a verdict whether or not it
 * has earned the word. So the default is the honest one: replay the game and
 * judge it yourself, and turn the engine on when you want a second opinion you
 * know the strength of.
 *
 * Distinct from `AnalysisEffortToggle`, which is the next question down — how
 * hard to think, asked only once the answer to this one is yes. The two sit
 * side by side, and the effort toggle is hidden while this is off, because a
 * depth readout for a search nobody is running is furniture for a thing that
 * is not there.
 *
 * The state lives in `store/enginePreference.ts` and is remembered per device:
 * somebody who wants the grades should ask once, not once per game.
 */
export interface EngineSwitchProps {
  enabled: boolean;
  /**
   * What the screen is while the engine is off, in two or three words —
   * `MANUAL REVIEW`, `YOUR BOARD`. Said out loud because an off switch that
   * only says "off" reads as something broken rather than as a mode.
   */
  offDetail: string;
  onToggle: () => void;
}

export default function EngineSwitch({ enabled, offDetail, onToggle }: EngineSwitchProps) {
  return (
    <View style={styles.row}>
      <Pressable
        accessibilityHint="Turn on RPSFish to evaluate positions and grade moves."
        accessibilityLabel="RPSFish engine"
        accessibilityRole="switch"
        accessibilityState={{ checked: enabled }}
        onPress={onToggle}
        style={({ pressed }) => [
          styles.button,
          enabled && styles.buttonActive,
          pressed && styles.pressed,
        ]}
      >
        <Text style={[styles.buttonText, enabled && styles.buttonTextActive]}>ENGINE</Text>
      </Pressable>
      {enabled ? null : (
        <Text numberOfLines={1} style={styles.status}>
          OFF · {offDetail}
        </Text>
      )}
    </View>
  );
}

const styles = themedSheet(() => ({
  // `minWidth: 0` so the status shortens instead of pushing whatever shares the
  // header with it off a phone — the same rule the effort toggle beside it
  // follows, and for the same reason.
  row: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0, flexShrink: 1 },
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
  buttonText: { color: colors.textMuted, fontSize: 7, fontWeight: '900' },
  buttonTextActive: { color: colors.accentSoft },
  status: { color: colors.textMuted, fontSize: 7, fontWeight: '900', flexShrink: 1, minWidth: 0 },
  pressed: { opacity: 0.68 },
}));
