import { StyleSheet, Text, View } from 'react-native';

import { quietMoveClock, type QuietUrgency } from './quietMoveClock';
import { colors, radius, space, themedSheet, type } from '@/theme';
import type { AnalysisGame } from '@/engine/analysisGame';

// How close this position is to the draw neither side asked for.
//
// The rule that bounds every game here is a hundred moves with nothing taken,
// and nothing on the screen used to say so: the board says where the pieces
// are and the clock says how long there is to move them, but neither says that
// the shuffle going on has a deadline. A player met the rule when it fired.
//
// Deliberately absent for most of a game — see `QUIET_MOVES_BEFORE_SHOWING`.
// A meter that is on screen from the first move is furniture, and furniture is
// not read; one that appears when the pieces stop meeting is a thing that
// happened.
//
// One component for every board that has this rule, which is all of them: the
// game screen, the analysis board, a bot battle and the review. It takes the
// position rather than a game so the board being *looked at* is the one it
// describes — a viewer stepped back through a live game is reading the rule as
// it stood then.

/**
 * What each stage of the countdown is drawn in.
 *
 * Built per call rather than held as a constant: read once at import, it would
 * keep the colours of whatever theme was showing when this file first loaded.
 */
const tones = (): Record<QuietUrgency, { fill: string; label: string; border?: string }> => ({
  counting: { fill: colors.textFaint, label: colors.textMuted },
  closing: { fill: colors.gold, label: colors.goldSoft },
  imminent: { fill: colors.danger, label: colors.dangerText, border: colors.dangerBorder },
});

export interface QuietMoveMeterProps {
  /**
   * The position on the board, or null where there is none. Null renders
   * nothing, as does a game with no shuffle in it and one that is over, so a
   * host can render this unconditionally.
   */
  game: Pick<AnalysisGame, 'quietPlies' | 'status'> | null | undefined;
}

export default function QuietMoveMeter({ game }: QuietMoveMeterProps) {
  const clock = quietMoveClock(game);
  if (!clock) return null;

  const tone = tones()[clock.urgency];
  const moveWord = clock.movesLeft === 1 ? 'MOVE' : 'MOVES';
  // Counting up is the fact; counting down is the warning. The swap happens
  // where the number a player can act on stops being "how long has this been
  // going on" and starts being "how long have I got".
  const readout =
    clock.urgency === 'imminent'
      ? `DRAW IN ${clock.movesLeft} ${moveWord}`
      : `${clock.movesPlayed}/${clock.limit} MOVES`;

  return (
    <View
      accessible
      accessibilityLabel={
        `${clock.movesPlayed} of ${clock.limit} moves with no capture. ` +
        `${clock.movesLeft} more without one and the game is a draw.`
      }
      style={[styles.card, tone.border ? { borderColor: tone.border } : null]}
    >
      <View style={styles.labels}>
        <Text style={styles.title}>NO CAPTURE</Text>
        <Text style={[styles.readout, { color: tone.label }]}>{readout}</Text>
      </View>
      <View style={styles.track}>
        <View
          style={[
            styles.fill,
            { backgroundColor: tone.fill, width: `${clock.progress * 100}%` },
          ]}
        />
      </View>
    </View>
  );
}

const styles = themedSheet(() => ({
  card: {
    width: '100%',
    paddingHorizontal: space.small + space.hair,
    paddingVertical: space.snug,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  labels: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: space.small,
    marginBottom: space.snug,
  },
  title: { ...type.eyebrow, color: colors.textFaint },
  readout: { ...type.label },
  track: {
    height: 5,
    overflow: 'hidden',
    borderRadius: 3,
    backgroundColor: colors.surfaceSunken,
  },
  fill: { height: '100%', borderRadius: 3 },
}));
