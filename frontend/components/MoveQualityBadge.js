import { Image, StyleSheet, Text, View } from 'react-native';

import { colors, moveQuality } from '../theme';

const BADGE_SHAPE = require('../assets/review/move-quality-badge.png');
const BORDER_DIRECTIONS = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/**
 * A review mark with exact, live notation over the generated badge shape.
 * Keeping the punctuation as text makes `!?`, `?!`, and `??` crisp at the
 * smallest history-row size and lets assistive technology read the verdict.
 */
export default function MoveQualityBadge({
  accessible = true,
  compact = false,
  grade,
  showLabel = true,
  size,
}) {
  if (!grade) return null;

  const baseIconSize = compact ? 21 : 28;
  const iconSize = size ?? baseIconSize;
  const scale = iconSize / baseIconSize;
  const borderWidth = Math.max(0.8, (compact ? 1 : 1.25) * scale);
  const symbolSize = Math.max(
    6,
    (grade.symbol.length > 1 ? 8 : compact ? 9 : 12) * scale,
  );

  return (
    <View
      accessibilityLabel={`${grade.label} move, ${grade.symbol}`}
      accessible={accessible}
      style={styles.badge}
    >
      <View style={{ width: iconSize, height: iconSize }}>
        {BORDER_DIRECTIONS.map(([horizontal, vertical]) => (
          <Image
            key={`${horizontal}:${vertical}`}
            resizeMode="contain"
            source={BADGE_SHAPE}
            style={[
              styles.shape,
              {
                transform: [
                  { translateX: horizontal * borderWidth },
                  { translateY: vertical * borderWidth },
                ],
              },
            ]}
            tintColor={colors.textStrong}
          />
        ))}
        <Image
          resizeMode="contain"
          source={BADGE_SHAPE}
          style={styles.shape}
          tintColor={moveQuality[grade.key]}
        />
        <Text
          allowFontScaling={false}
          style={[
            styles.symbol,
            { fontSize: symbolSize, lineHeight: iconSize },
          ]}
        >
          {grade.symbol}
        </Text>
      </View>
      {showLabel ? <Text style={styles.label}>{grade.label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  badge: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  shape: { position: 'absolute', width: '100%', height: '100%' },
  symbol: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    color: colors.textStrong,
    fontWeight: '900',
    textAlign: 'center',
  },
  label: { color: colors.textStrong, fontSize: 9, fontWeight: '900' },
});
