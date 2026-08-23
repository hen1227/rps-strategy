import { StyleSheet, Text, View } from 'react-native';

import ModePreview from './ModePreview';
import { describeSetup } from '@/store/setupSelectors';
import { colors, space, type } from '@/theme';
import type { GameSetup, ModeDefinition, TimeControl } from '@/types/game';

// A game, at a glance: the board it starts from with its terms listed under it.
//
// The board is doing two jobs, which is why it is a board and not a label. It
// shows the position the game actually begins in — the whole point of a custom
// game — and, because each mode tints and marks its own board, it also says
// which mode this is without spending a line of text on the name. The bullets
// under it are the rest of the terms, the departures from a normal game marked
// as such.

const PREVIEW_SIZE = 116;
const COMPACT_SIZE = 68;

export interface SetupPreviewProps {
  setup: GameSetup;
  /** The mode the setup names, for the tinting, goal ranks, and comparison. */
  mode: ModeDefinition | null | undefined;
  defaultTimeControl?: TimeControl | null;
  /** Smaller board and unlabelled icons, for a narrow rail. */
  compact?: boolean;
}

export default function SetupPreview({
  setup,
  mode,
  defaultTimeControl,
  compact,
}: SetupPreviewProps) {
  const bullets = describeSetup(setup, mode, defaultTimeControl);
  // The icons carry no meaning on their own, so the compact form still names
  // every term to a screen reader even though it has no room to print them.
  const spoken = bullets.map((bullet) => bullet.label).join(', ');

  return (
    <View
      accessibilityLabel={compact ? spoken : undefined}
      style={[styles.frame, compact && styles.frameCompact]}
    >
      <ModePreview mode={mode} position={setup.startingPosition} size={compact ? COMPACT_SIZE : PREVIEW_SIZE} />
      <View
        accessibilityElementsHidden={compact}
        style={[styles.bullets, compact && styles.bulletsCompact]}
      >
        {bullets.map((bullet) => (
          <View key={bullet.key} style={styles.bullet}>
            <Text style={[styles.icon, bullet.custom && styles.iconCustom]}>{bullet.icon}</Text>
            {compact ? null : (
              <Text
                numberOfLines={2}
                style={[styles.label, bullet.custom && styles.labelCustom]}
              >
                {bullet.label}
              </Text>
            )}
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { alignItems: 'stretch', gap: space.snug, width: PREVIEW_SIZE + 2 * space.small },
  frameCompact: { width: COMPACT_SIZE + 2 * space.small, gap: space.tight },

  // One bullet per line at full size: these are terms of a game, and a reader
  // scanning for the one that matters should not have to hunt across a wrap.
  bullets: { gap: space.hair, paddingHorizontal: space.hair },
  // No room for that in a rail, so the icons become a single row of marks and
  // the words move to the accessibility label.
  bulletsCompact: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: space.tight,
  },

  bullet: { flexDirection: 'row', alignItems: 'center', gap: space.tight },
  icon: { ...type.label, color: colors.textFaint, width: 10, textAlign: 'center' },
  iconCustom: { color: colors.accentSoft },
  label: { ...type.meta, flex: 1, fontSize: 9, lineHeight: 12, color: colors.textFaint },
  labelCustom: { color: colors.accentText, fontWeight: '700' },
});
