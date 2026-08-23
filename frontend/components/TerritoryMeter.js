import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import TileMark from './TileMark';
import { colors, players, radius } from '../theme';

function TerritoryKey({ count, owner }) {
  return (
    <View style={styles.keyItem}>
      <View
        style={[
          styles.keySwatch,
          { backgroundColor: players[owner].territory },
        ]}
      >
        <TileMark compact owner={owner} variant="territory" />
      </View>
      <Text style={styles.keyLabel}>
        <Text style={styles.keyCount}>{count}</Text> {owner}
      </Text>
    </View>
  );
}

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
  const majorityThreshold = Math.floor(totalTiles / 2) + 1;
  const majorityOwner =
    counts.red >= majorityThreshold
      ? 'Red'
      : counts.blue >= majorityThreshold
        ? 'Blue'
        : null;
  const majorityColor = majorityOwner
    ? players[majorityOwner].territory
    : null;
  const accessibilityLabel = majorityOwner
    ? `${majorityOwner} has majority territory control. ${counts.red} red and ${counts.blue} blue.`
    : `${coveredTiles} of ${totalTiles} tiles covered. ${counts.red} red and ${counts.blue} blue.`;

  return (
    <View
      accessible
      accessibilityLabel={accessibilityLabel}
      style={styles.card}
    >
      <View style={styles.labels}>
        <Text style={styles.title}>TERRITORY</Text>
        <Text style={styles.count}>{coveredTiles}/{totalTiles} CLAIMED</Text>
      </View>
      {majorityOwner ? (
        <>
          <Text style={styles.majorityLabel}>
            {majorityOwner} has majority territory control
          </Text>
          <View
            style={[
              styles.track,
              styles.majorityTrack,
              { backgroundColor: majorityColor },
            ]}
          >
            <Text
              style={[
                styles.majorityCount,
                { color: players[majorityOwner].contrast },
              ]}
            >
              R {counts.red}
            </Text>
            <Text
              style={[
                styles.majorityCount,
                { color: players[majorityOwner].contrast },
              ]}
            >
              B {counts.blue}
            </Text>
          </View>
        </>
      ) : (
        <>
          <View style={styles.key}>
            <TerritoryKey count={counts.red} owner="Red" />
            <TerritoryKey count={counts.blue} owner="Blue" />
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
            <View style={styles.middleMarker} />
          </View>
        </>
      )}
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
  labels: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  title: { color: colors.textFaint, fontSize: 7, fontWeight: '900', letterSpacing: 1.1 },
  count: { color: colors.textMuted, fontSize: 7, fontWeight: '800', letterSpacing: 0.5 },
  key: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginBottom: 6,
  },
  keyItem: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  keySwatch: {
    width: 14,
    height: 14,
    overflow: 'hidden',
    borderRadius: 3,
  },
  keyLabel: { color: colors.textMuted, fontSize: 8, fontWeight: '700' },
  keyCount: { color: colors.text, fontWeight: '900' },
  track: {
    height: 5,
    overflow: 'hidden',
    borderRadius: 3,
    backgroundColor: colors.surfaceSunken,
  },
  redProgress: {
    position: 'absolute',
    left: 0,
    height: '100%',
    backgroundColor: players.Red.territory,
  },
  blueProgress: {
    position: 'absolute',
    right: 0,
    height: '100%',
    backgroundColor: players.Blue.territory,
  },
  middleMarker: {
    position: 'absolute',
    top: 0,
    left: '50%',
    width: 1,
    height: '100%',
    backgroundColor: colors.textStrong,
  },
  majorityLabel: {
    marginBottom: 6,
    color: colors.text,
    fontSize: 9,
    fontWeight: '800',
  },
  majorityTrack: {
    height: 16,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 5,
  },
  majorityCount: {
    fontSize: 7,
    fontWeight: '900',
  },
});
