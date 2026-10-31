import { Text, View, type StyleProp, type TextStyle } from 'react-native';

import CapturedPieces, { type CaptureTray } from '@/features/board/CapturedPieces';
import { colors, players, radius, themedSheet } from '@/theme';
import type { SideColor } from '@/types/game';

// What a finished game came to, counted out on its card.
//
// The count that decided the game, for its mode: in Total War the squares each
// side owns, everywhere else the pieces each side took. Drawn the way FINAL is,
// the reader's side then the other's with a dot between, and counted out by
// `useFinishCount` — so it is laid out at its final size from the first frame,
// with what has not been counted yet drawn invisibly. Nothing on the card moves
// while it counts.

export type FinishTallyData =
  | { kind: 'squares'; sides: [SideColor, SideColor]; counts: Record<SideColor, number> }
  | { kind: 'taken'; sides: [SideColor, SideColor]; trays: Record<SideColor, CaptureTray> };

/** How many steps the tally counts through: pieces taken, or the larger territory. */
export const tallyTotal = (tally: FinishTallyData | null): number => {
  if (!tally) return 0;
  if (tally.kind === 'squares') return Math.max(tally.counts.Red, tally.counts.Blue);
  return tally.trays.Red.count + tally.trays.Blue.count;
};

/**
 * A number in a slot sized for the one it is counting to.
 *
 * The final value is drawn invisibly underneath to hold the width, and the
 * count is laid over it, right-aligned, so a rating going from 998 to 1004 does
 * not widen its block halfway through.
 */
export function CountingText({
  final,
  style,
  value,
}: {
  final: string;
  style: StyleProp<TextStyle>;
  value: string;
}) {
  return (
    <View importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      <Text style={[style, styles.holder]}>{final}</Text>
      <Text style={[style, styles.counter]}>{value}</Text>
    </View>
  );
}

function Squares({ color, count, final }: { color: SideColor; count: number; final: number }) {
  return (
    <View style={styles.squares}>
      <View style={[styles.swatch, { backgroundColor: players[color].territory }]} />
      <CountingText final={String(final)} style={styles.count} value={String(count)} />
    </View>
  );
}

export default function FinishTally({ shown, tally }: { shown: number; tally: FinishTallyData }) {
  const [first, second] = tally.sides;

  if (tally.kind === 'squares') {
    const { counts } = tally;
    return (
      <View
        accessible
        accessibilityLabel={`Squares owned: ${first} ${counts[first]}, ${second} ${counts[second]}`}
        style={styles.row}
      >
        <Text style={styles.label}>SQUARES</Text>
        <Squares color={first} count={Math.min(shown, counts[first])} final={counts[first]} />
        <Text style={styles.dot}>·</Text>
        <Squares color={second} count={Math.min(shown, counts[second])} final={counts[second]} />
      </View>
    );
  }

  // Each tray is what one side took, so it holds the other side's pieces.
  const firstTook = tally.trays[first];
  const secondTook = tally.trays[second];
  return (
    <View
      accessible
      accessibilityLabel={`Pieces taken: ${first} ${firstTook.count}, ${second} ${secondTook.count}`}
      style={styles.row}
    >
      <Text style={styles.label}>TAKEN</Text>
      {firstTook.count > 0 ? (
        <CapturedPieces
          color={second}
          revealed={Math.min(shown, firstTook.count)}
          tally={firstTook.tally}
        />
      ) : (
        <Text style={styles.count}>0</Text>
      )}
      <Text style={styles.dot}>·</Text>
      {secondTook.count > 0 ? (
        <CapturedPieces
          color={first}
          revealed={Math.max(0, shown - firstTook.count)}
          tally={secondTook.tally}
        />
      ) : (
        <Text style={styles.count}>0</Text>
      )}
    </View>
  );
}

const styles = themedSheet(() => ({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 8,
    marginTop: 10,
  },
  label: { color: colors.textFaint, fontSize: 7, fontWeight: '900', letterSpacing: 1.1 },
  dot: { color: colors.textFaint, fontSize: 11, fontWeight: '900' },
  squares: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  swatch: { width: 14, height: 14, borderRadius: radius.small },
  count: {
    color: colors.textSoft,
    fontSize: 13,
    fontWeight: '900',
    fontVariant: ['tabular-nums'],
  },
  holder: { opacity: 0 },
  counter: { position: 'absolute', top: 0, right: 0 },
}));
