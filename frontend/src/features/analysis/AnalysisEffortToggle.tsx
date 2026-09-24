import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { RefinePass } from '@/engine/gameAnalysis';
import { colors, radius, themedSheet } from '@/theme';

/**
 * The one thing left to say about how hard a review is thinking.
 *
 * This replaced a row of depth chips — Quick, Standard, Deep — and the change
 * is not cosmetic. A depth is not something a reviewer can choose well: the
 * right answer depends on the machine they are holding and the length of the
 * game in front of them, and picking wrong meant either waiting for depth they
 * did not need or reading grades that a deeper search would have overturned.
 * So the walk now chooses, and keeps choosing: it grades shallow, shows the
 * result, and regrades deeper for as long as the device and the clock allow.
 *
 * What is left is the one preference a reviewer really does hold, which is that
 * sometimes they want the number now and do not care that it might move. That
 * is QUICK: one shallow pass, no deepening.
 *
 * The rest of the control is the thing it configures, not a setting — the depth
 * the grades on screen were actually measured at, and whether a deeper pass is
 * on its way to replace them.
 */
export interface AnalysisEffortToggleProps {
  /** The depth every grade in the report was measured at. */
  depth: number;
  /** Whether the walk still means to try a deeper pass. */
  deeperToCome: boolean;
  onToggleQuick: () => void;
  quick: boolean;
  /** A deeper pass in flight, and how far through the line it is. */
  refining: RefinePass | null;
}

export default function AnalysisEffortToggle({
  depth,
  deeperToCome,
  onToggleQuick,
  quick,
  refining,
}: AnalysisEffortToggleProps) {
  const status = refining
    ? `DEPTH ${depth} · DEEPENING TO ${refining.limits.maxDepth} · ${refining.done}/${refining.total}`
    : quick
      ? `DEPTH ${depth} · QUICK`
      : deeperToCome
        ? `DEPTH ${depth} · DEEPENING SOON`
        : `DEPTH ${depth} · AS DEEP AS THIS DEVICE GOES`;

  return (
    <View style={styles.row}>
      <Pressable
        accessibilityHint="Quick review uses a shallow search. Turn it off for deeper analysis."
        accessibilityLabel="Quick review"
        accessibilityRole="switch"
        accessibilityState={{ checked: quick }}
        onPress={onToggleQuick}
        style={({ pressed }) => [
          styles.button,
          quick && styles.buttonActive,
          pressed && styles.pressed,
        ]}
      >
        <Text style={[styles.buttonText, quick && styles.buttonTextActive]}>QUICK</Text>
      </Pressable>
      <Text numberOfLines={1} style={styles.status}>
        {status}
      </Text>
    </View>
  );
}

const styles = themedSheet(() => ({
  // `minWidth: 0` is what lets the status line shorten instead of pushing the
  // matchup beside it off a phone's header.
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
