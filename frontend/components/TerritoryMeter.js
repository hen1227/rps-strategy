import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { colors, players, radius } from '../theme';

export default function TerritoryMeter({ grid }) {
  const counts = useMemo(
    () =>
      grid.flat().reduce(
        (result, tile) => {
          if (tile.ownerColor === 'Red') result.red += 1;
          if (tile.ownerColor === 'Blue') result.blue += 1;
          return result;
        },
        { red: 0, blue: 0 },
      ),
    [grid],
  );
  const totalTiles = grid.reduce((total, row) => total + row.length, 0);
  const totalTilesDivisor = totalTiles || 1;
  const coveredTiles = counts.red + counts.blue;

  return (
    <View
      accessibilityLabel={`${coveredTiles} of ${totalTiles} tiles covered. ${counts.red} red and ${counts.blue} blue.`}
      style={styles.card}
    >
      <View style={styles.labels}>
        <Text style={styles.title}>TERRITORY</Text>
        <Text style={styles.count}>
          {coveredTiles}/{totalTiles} covered · {counts.red} red · {counts.blue} blue
        </Text>
      </View>
      <View style={styles.track}>
        <View
          style={[
            styles.redProgress,
            { width: `${(counts.red / totalTilesDivisor) * 100}%` },
          ]}
        />
        <View
          style={[
            styles.blueProgress,
            { width: `${(counts.blue / totalTilesDivisor) * 100}%` },
          ]}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    width: '100%',
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  labels: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 5 },
  title: { color: colors.textFaint, fontSize: 7, fontWeight: '900', letterSpacing: 1.1 },
  count: { color: colors.textMuted, fontSize: 8, fontWeight: '700' },
  track: {
    height: 5,
    flexDirection: 'row',
    overflow: 'hidden',
    borderRadius: 3,
    backgroundColor: colors.surfaceSunken,
  },
  redProgress: { height: '100%', backgroundColor: players.Red.territory },
  blueProgress: { height: '100%', backgroundColor: players.Blue.territory },
});
