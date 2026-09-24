import { StyleSheet, Text, View } from 'react-native';

import type { PlayerAccuracy } from '@/engine/gameReview';
import { colors, players, radius, themedSheet } from '@/theme';
import { SIDE_COLORS, type PlayerColor, type SideColor } from '@/types/game';

/**
 * One side-by-side accuracy readout, for anything RPSFish has graded.
 *
 * A colour reads `—` until every one of its moves has a grade, because the mean
 * of the first ten moves of a game is not that player's accuracy and labelling
 * it as one would be a lie a watched game tells for its whole length.
 * `pendingDetail` is what to say while that is true.
 */
export interface AccuracyCardProps {
  accuracy: Partial<Record<SideColor, PlayerAccuracy | null>> | null | undefined;
  /** What to say for a side whose moves are not all graded yet. */
  pendingDetail?: string;
  /** Who is playing each side, when their names are known. */
  players?: Partial<Record<SideColor, { name?: string }>> | null;
  title?: string;
  /** The side the person reading this is playing, marked "(you)". */
  viewerColor?: PlayerColor | null;
}

export default function AccuracyCard({
  accuracy,
  pendingDetail = 'Still reviewing…',
  players: profiles,
  title = 'ACCURACY vs RPSFISH',
  viewerColor,
}: AccuracyCardProps) {
  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>{title}</Text>
      <View style={styles.row}>
        {SIDE_COLORS.map((color) => {
          const report = accuracy?.[color] ?? null;
          return (
            <View key={color} style={styles.side}>
              <View style={styles.name}>
                <View style={[styles.colorDot, color === 'Red' ? styles.redDot : styles.blueDot]} />
                <Text numberOfLines={1} style={styles.player}>
                  {profiles?.[color]?.name || color}
                  {viewerColor === color ? ' (you)' : ''}
                </Text>
              </View>
              <Text style={[styles.value, !report && styles.pending]}>
                {report?.accuracy === null || report?.accuracy === undefined
                  ? '–'
                  : `${report.accuracy.toFixed(1)}%`}
              </Text>
              {report ? (
                <Text style={styles.detail}>
                  {report.grades.best + report.grades.great + report.grades.excellent} strong ·{' '}
                  {report.grades.mistake + report.grades.blunder} bad · {report.moveCount} moves
                </Text>
              ) : (
                <Text style={styles.detail}>{pendingDetail}</Text>
              )}
            </View>
          );
        })}
      </View>
    </View>
  );
}

const styles = themedSheet(() => ({
  card: {
    padding: 13,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  eyebrow: { color: colors.textFaint, fontSize: 8, fontWeight: '900', letterSpacing: 1.2 },
  row: { flexDirection: 'row', gap: 12, marginTop: 10 },
  side: { flex: 1, minWidth: 0 },
  name: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  colorDot: { width: 7, height: 7, borderRadius: 4 },
  redDot: { backgroundColor: players.Red.strong },
  blueDot: { backgroundColor: players.Blue.strong },
  player: { flex: 1, color: colors.textSoft, fontSize: 10, fontWeight: '800' },
  value: { color: colors.textStrong, fontSize: 22, fontWeight: '900', marginTop: 3 },
  pending: { color: colors.textFaint },
  detail: { color: colors.textFaint, fontSize: 8, marginTop: 2 },
}));
