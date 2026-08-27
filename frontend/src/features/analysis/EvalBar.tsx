import { StyleSheet, Text, View } from 'react-native';

import { board, evalBar, players, radius } from '@/theme';

/** A score as a player reads it: `+1.20`, `−0.35`, or `M4` for a forced win. */
export const formatScore = (score: number | null | undefined) => {
  if (score === undefined || score === null) return '—';
  if (Math.abs(score) >= 29_000) {
    return `${score >= 0 ? '' : '\u2212'}M${Math.max(1, 30_000 - Math.abs(score))}`;
  }
  const value = score / 100;
  return `${value >= 0 ? '+' : '\u2212'}${Math.abs(value).toFixed(2)}`;
};

/**
 * The same score, trimmed to what fits inside the bar.
 *
 * The badge is a plate roughly 27pt across on a 31pt bar, which is five glyphs
 * at this size and no more — so `+12.34` wrapped onto a second line the bar
 * then clipped, and the score read as `+12.3` with a sliver of something under
 * it. Hundredths are what gives: nobody reads the second decimal of a position
 * that is already twelve points won, and the bar beside the number is saying
 * the same thing less precisely anyway.
 */
const badgeScore = (score: number) => {
  if (Math.abs(score) >= 29_000) return formatScore(score);
  const value = Math.abs(score) / 100;
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${score >= 0 ? '+' : '\u2212'}${value.toFixed(digits)}`;
};

/**
 * The vertical evaluation bar beside a board: Red fills from the bottom.
 *
 * `tanh` rather than a linear scale because the bar has to stay readable in
 * both a level position and a decided one, and a linear bar spends its whole
 * range on advantages nobody needs to see the size of.
 */
export interface EvalBarProps {
  /** Matched to the board it stands beside. */
  height: number;
  /** The evaluation from Red's point of view. */
  redScore: number | null | undefined;
}

export default function EvalBar({ height, redScore }: EvalBarProps) {
  const score = redScore ?? 0;
  const redShare = Math.max(2, Math.min(98, 50 + 48 * Math.tanh(score / 900)));
  const blueShare = 100 - redShare;

  return (
    <View
      accessibilityLabel={`Evaluation ${formatScore(score)} for Red`}
      style={[styles.evalBar, { height }]}
    >
      <View style={[styles.blueEval, { height: `${blueShare}%` }]}>
        <Text style={styles.blueEvalSide}>B</Text>
      </View>
      <View style={[styles.redEval, { height: `${redShare}%` }]}>
        <Text style={styles.redEvalSide}>R</Text>
      </View>
      <View style={[styles.evalDivider, { top: `${blueShare}%` }]} />
      <View style={[styles.evalBadge, score < 0 && styles.evalBadgeOnBlue]}>
        <Text numberOfLines={1} style={[styles.evalValue, score < 0 && styles.evalValueOnBlue]}>
          {badgeScore(score)}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  evalBar: {
    position: 'relative',
    width: 31,
    overflow: 'hidden',
    borderRadius: radius.small,
    borderWidth: 2,
    borderColor: board.frame,
    backgroundColor: board.frame,
  },
  blueEval: {
    width: '100%',
    alignItems: 'center',
    paddingTop: 5,
    backgroundColor: players.Blue.strong,
  },
  redEval: {
    width: '100%',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 5,
    backgroundColor: players.Red.strong,
  },
  blueEvalSide: { color: players.Blue.contrast, fontSize: 8, fontWeight: '900' },
  redEvalSide: { color: players.Red.contrast, fontSize: 8, fontWeight: '900' },
  evalDivider: {
    position: 'absolute',
    left: 0,
    width: '100%',
    height: 2,
    backgroundColor: evalBar.divider,
  },
  evalBadge: {
    position: 'absolute',
    right: 0,
    bottom: 19,
    left: 0,
    alignItems: 'center',
    paddingVertical: 3,
    borderRadius: 4,
    backgroundColor: evalBar.badgeOnRed,
  },
  evalBadgeOnBlue: { top: 19, bottom: 'auto', backgroundColor: evalBar.badgeOnBlue },
  evalValue: {
    color: evalBar.badgeOnRedText,
    fontSize: 7,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  evalValueOnBlue: { color: evalBar.badgeOnBlueText },
});
