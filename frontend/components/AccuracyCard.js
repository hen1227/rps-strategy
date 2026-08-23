import { StyleSheet, Text, View } from 'react-native';

import { colors, players, radius } from '../theme';

/**
 * One side-by-side accuracy readout, for anything RPSFish has graded.
 *
 * A colour reads `—` until every one of its moves has a grade, because the mean
 * of the first ten moves of a game is not that player's accuracy and labelling
 * it as one would be a lie a watched game tells for its whole length.
 * `pendingDetail` is what to say while that is true.
 */
export default function AccuracyCard({
  accuracy,
  pendingDetail = 'Still reviewing…',
  players: profiles,
  title = 'ACCURACY vs RPSFISH',
  viewerColor,
}) {
  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>{title}</Text>
      <View style={styles.row}>
        {['Red', 'Blue'].map((color) => {
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
                {report ? `${report.accuracy.toFixed(1)}%` : '—'}
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

const styles = StyleSheet.create({
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
});
