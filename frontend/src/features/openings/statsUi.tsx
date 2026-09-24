// The row every statistics list on these screens is made of.
//
// One row answers both questions at once: how often was this played, and did
// it work. The bar's length is the share and the colours inside it are the
// result mix, so a reader gets the frequency and the scoreline without a
// second chart or a tooltip.

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatShare, hasEnoughGames, openingScoreline } from '@/engine/openingStats';
import { colors, players, radius, space, themedSheet } from '@/theme';

import { ui } from './openingsUi';

/** The counts a row can draw, from either statistics shape. */
export interface ShareRowFigures {
  games: number;
  redWins: number;
  blueWins: number;
  draws: number;
}

export interface ShareRowProps {
  figures: ShareRowFigures;
  /** What the bar is a share of, 0 to 1. */
  share: number;
  label: string;
  /** A second line under the label — the line's moves, or a date. */
  detail?: string;
  onPress?: () => void;
  /**
   * The denominator behind `share`. Below a handful of games a percentage is a
   * count wearing a percent sign, so the row shows the count alone.
   */
  total: number;
  /** Drawn heavier: the most played move at this board. */
  leading?: boolean;
}

export function ShareRow({
  figures,
  share,
  label,
  detail,
  onPress,
  total,
  leading,
}: ShareRowProps) {
  const scoreline = openingScoreline(figures);
  const body = (
    <>
      <View style={styles.heading}>
        <View style={styles.headingCopy}>
          <Text style={[styles.label, leading && styles.labelLeading]}>{label}</Text>
          {detail ? <Text style={styles.detail}>{detail}</Text> : null}
        </View>
        <View style={styles.facts}>
          {hasEnoughGames(total) ? (
            <Text style={styles.share}>{formatShare(share)}</Text>
          ) : null}
          <Text style={styles.games}>
            {figures.games} game{figures.games === 1 ? '' : 's'}
          </Text>
        </View>
      </View>
      <View style={styles.track}>
        <View style={[styles.fill, { width: `${Math.min(100, Math.max(1, share * 100))}%` }]}>
          {scoreline ? (
            <>
              <View
                style={[
                  styles.segment,
                  styles.blueSegment,
                  { flex: Math.max(0.001, scoreline.blueShare) },
                ]}
              />
              <View
                style={[
                  styles.segment,
                  styles.drawSegment,
                  { flex: Math.max(0.001, scoreline.drawShare) },
                ]}
              />
              <View style={[styles.segment, { flex: Math.max(0.001, scoreline.redShare) }]} />
            </>
          ) : null}
        </View>
      </View>
      {scoreline ? (
        <Text style={styles.results}>
          {figures.blueWins} · {figures.draws} · {figures.redWins}
        </Text>
      ) : null}
    </>
  );

  if (!onPress) return <View style={styles.row}>{body}</View>;
  return (
    <Pressable
      accessibilityLabel={`${label}, ${figures.games} games`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed && ui.pressed]}
    >
      {body}
    </Pressable>
  );
}

const styles = themedSheet(() => ({
  row: { gap: 3 },
  heading: { alignItems: 'baseline', flexDirection: 'row', gap: space.small },
  // `minWidth: 0` is what lets a long line wrap rather than push the counts off
  // the row: a flex item will not shrink below its longest word without it.
  headingCopy: { flex: 1, minWidth: 0 },
  label: {
    color: colors.text,
    fontSize: 13,
    fontVariant: ['tabular-nums'],
  },
  labelLeading: { fontWeight: '800' },
  detail: { color: colors.textFaint, fontSize: 10, fontVariant: ['tabular-nums'] },
  facts: { alignItems: 'baseline', flexDirection: 'row', gap: 6 },
  share: { color: colors.accentBright, fontSize: 13, fontWeight: '800' },
  games: { color: colors.textFaint, fontSize: 11 },
  track: {
    backgroundColor: colors.surface,
    borderRadius: radius.small,
    height: 10,
    overflow: 'hidden',
  },
  fill: { borderRadius: radius.small, flexDirection: 'row', height: '100%' },
  segment: { backgroundColor: players.Red.strong, height: '100%' },
  drawSegment: { backgroundColor: colors.textFaint },
  blueSegment: { backgroundColor: players.Blue.strong },
  results: { color: colors.textFaint, fontSize: 10, fontVariant: ['tabular-nums'] },
}));

export default ShareRow;
