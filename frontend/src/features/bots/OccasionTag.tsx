import { Text, View } from 'react-native';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

import type { Occasion } from './seriesSummary';
import { colors, radius, space, themedSheet, type } from '@/theme';

// What a bot occasion was, as the first thing on its card: RANKED or CASUAL,
// then who picked the pairing.
//
// Stakes first, because it is the question people actually ask of a scoreline
// — did that count? — and a column of cards should answer it down their left
// edge without anybody reading a sentence. The two chips differ in weight
// rather than hue: this app keeps its green for buttons and its coral for
// what is happening now, so RANKED is the solid, inverted chip and CASUAL the
// outlined one, and they read apart on every theme.

export function StakesChip({ ranked }: { ranked: boolean }) {
  return (
    <View style={[styles.chip, ranked ? styles.chipRanked : styles.chipCasual]}>
      <Text style={[styles.chipText, ranked ? styles.chipTextRanked : styles.chipTextCasual]}>
        {ranked ? 'RANKED' : 'CASUAL'}
      </Text>
    </View>
  );
}

/** A 16-unit drawing of who picked the pairing. */
export function PairingIcon({ color, pairing, size }: { color: string; pairing: Occasion['pairing']; size: number }) {
  const stroke = { stroke: color, strokeWidth: 1.6, strokeLinecap: 'round' as const, fill: 'none' };
  let drawing;
  switch (pairing) {
    case 'round':
      // A clock: the hour struck and the server paired them.
      drawing = (
        <>
          <Circle cx={8} cy={8} r={6.2} {...stroke} />
          <Path d="M8 4.6V8l2.4 1.6" {...stroke} strokeLinejoin="round" />
        </>
      );
      break;
    case 'random':
      // A die: the server drew the opponent.
      drawing = (
        <>
          <Rect height={11.6} rx={2.6} width={11.6} x={2.2} y={2.2} {...stroke} />
          <Circle cx={5.5} cy={5.5} fill={color} r={1.15} />
          <Circle cx={8} cy={8} fill={color} r={1.15} />
          <Circle cx={10.5} cy={10.5} fill={color} r={1.15} />
        </>
      );
      break;
    case 'tournament':
    case 'arena':
      // A cup: one match of an event.
      drawing = (
        <Path
          d="M5 2.6h6v3.1a3 3 0 0 1-6 0zM5 3.7H3.3a1.9 1.9 0 0 0 2 2.7M11 3.7h1.7a1.9 1.9 0 0 1-2 2.7M8 8.7v2.7M5.6 13.4h4.8"
          {...stroke}
          strokeLinejoin="round"
        />
      );
      break;
    case 'single':
      // A board: one game on its own.
      drawing = (
        <>
          <Rect height={11} rx={1.8} width={11} x={2.5} y={2.5} {...stroke} />
          <Path d="M2.5 8h11M8 2.5v11" {...stroke} />
        </>
      );
      break;
    default:
      // Crosshairs: somebody named both engines.
      drawing = (
        <>
          <Circle cx={8} cy={8} r={4.6} {...stroke} />
          <Circle cx={8} cy={8} fill={color} r={1.3} />
          <Path d="M8 1.4v2.4M8 12.2v2.4M1.4 8h2.4M12.2 8h2.4" {...stroke} />
        </>
      );
  }
  return (
    // Inert, for the reason GitHubMark's is: on iOS an `Svg` claims every touch
    // inside its box, and these sit on cards whose rows are pressable.
    <View style={styles.inert}>
      <Svg height={size} viewBox="0 0 16 16" width={size}>
        {drawing}
      </Svg>
    </View>
  );
}

export interface OccasionTagProps {
  occasion: Occasion;
  /** Smaller, for a live board's header rather than a card in a list. */
  compact?: boolean;
  /** Overrides the title — a tournament's own name, say. */
  title?: string;
}

export default function OccasionTag({ compact = false, occasion, title }: OccasionTagProps) {
  const color = occasion.ranked ? colors.textStrong : colors.textMuted;
  return (
    <View
      accessibilityLabel={`${occasion.ranked ? 'Ranked' : 'Casual'}, ${title ?? occasion.title}`}
      accessible
      style={styles.row}
    >
      <StakesChip ranked={occasion.ranked} />
      <PairingIcon color={color} pairing={occasion.pairing} size={compact ? 12 : 14} />
      <Text
        numberOfLines={1}
        style={[styles.title, compact && styles.titleCompact, !occasion.ranked && styles.titleCasual]}
      >
        {title ?? occasion.title}
      </Text>
    </View>
  );
}

const styles = themedSheet(() => ({
  row: { flexDirection: 'row', alignItems: 'center', gap: space.snug, minWidth: 0, flexShrink: 1 },
  // The badge's own shape, so a stakes chip sits in a row of badges as one of
  // them.
  chip: {
    minHeight: 20,
    justifyContent: 'center',
    paddingHorizontal: 7,
    borderRadius: radius.small,
    borderWidth: 1,
  },
  chipRanked: { borderColor: colors.textStrong, backgroundColor: colors.textStrong },
  chipCasual: { borderColor: colors.borderLight, backgroundColor: 'transparent' },
  chipText: { ...type.label },
  chipTextRanked: { color: colors.textInverse },
  chipTextCasual: { color: colors.textMuted },
  title: { ...type.rowTitle, color: colors.textStrong, flexShrink: 1, minWidth: 0 },
  titleCompact: { fontSize: 11 },
  titleCasual: { color: colors.textSoft },
  inert: { pointerEvents: 'none' },
}));
