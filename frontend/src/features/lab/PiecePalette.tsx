import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import PieceIcon from '@/features/board/PieceIcon';
import { modeLooks } from '@/features/board/modeArt';
import { colors, radius, space, type } from '@/theme';
import type { RuleSpec } from '@/engine/spec/types';
import type { Piece, SideColor } from '@/types/game';

// The brushes, taken from the mode rather than from a list.
//
// Every other piece palette in this app is a constant — rock, paper, scissors,
// six swatches, done. That is exactly the thing this page exists to stop being
// true: the mode on the workbench may have a Lizard on it, drawn with a picture
// somebody uploaded four seconds ago, and a palette that could not offer it
// would be a palette that confines an author to the game somebody thought of
// first.
//
// So it is built from `spec.pieces`, with the same `modeLooks` every board in
// the app draws through — which means an uploaded picture appears here at the
// same moment it appears on the board, and a kind with no picture is a disc with
// its letter on it in both places.

/** One brush: a kind and a side, or the eraser. */
export interface PaletteBrush {
  /** The symbol written into a layout row. `.` for the eraser. */
  symbol: string;
  kindId: string | null;
  color: SideColor | null;
  label: string;
}

/**
 * The brushes for a mode, in the order an author reaches for them: each kind's
 * Red form, then each kind's Blue form, then the eraser.
 *
 * Red first because Red moves first, and because a layout is written from rank 1
 * upward — which is Blue's home. Somebody drawing an opening starts at the
 * bottom of the picture and the top of the list, and those should be the same
 * side as often as possible.
 */
export const brushesFor = (spec: RuleSpec): PaletteBrush[] => {
  const kinds = spec.pieces ?? [];
  const sides: { color: SideColor; upper: boolean }[] = [
    { color: 'Red', upper: false },
    { color: 'Blue', upper: true },
  ];
  const brushes = sides.flatMap(({ color, upper }) =>
    kinds.map((kind) => ({
      symbol: upper ? kind.symbol.toUpperCase() : kind.symbol.toLowerCase(),
      kindId: kind.id,
      color,
      label: `${color} ${kind.name || kind.id}`,
    })),
  );
  return [...brushes, { symbol: '.', kindId: null, color: null, label: 'Erase' }];
};

export interface PiecePaletteProps {
  spec: RuleSpec;
  /** The symbol being painted with. */
  brush: string;
  onPick: (symbol: string) => void;
  /** How many of each symbol are on the board now, keyed by symbol. */
  counts?: Record<string, number>;
  onAddKind?: () => void;
}

function PiecePalette({ spec, brush, onPick, counts, onAddKind }: PiecePaletteProps) {
  const looks = modeLooks({ spec });
  const brushes = brushesFor(spec);

  return (
    <View style={styles.palette}>
      {brushes.map((option) => {
        const chosen = option.symbol === brush;
        const count = counts?.[option.symbol] ?? 0;
        return (
          <Pressable
            accessibilityLabel={
              option.kindId ? `Place ${option.label}, ${count} on the board` : 'Erase pieces'
            }
            accessibilityRole="radio"
            accessibilityState={{ checked: chosen }}
            key={option.symbol}
            onPress={() => onPick(option.symbol)}
            style={({ pressed }) => [
              styles.brush,
              chosen && styles.brushOn,
              pressed && styles.pressed,
            ]}
          >
            {option.kindId ? (
              <PieceIcon
                color={option.color ?? undefined}
                look={looks?.[option.kindId]}
                piece={option.kindId as Piece}
                size={24}
              />
            ) : (
              <Text style={styles.eraser}>×</Text>
            )}
            {/* The count is the reason this is not just a swatch: "how many
                Lizards are on the board" is the question an author asks while
                placing them, and it is one they would otherwise answer by
                counting squares. */}
            <Text style={[styles.count, chosen && styles.countOn]}>
              {option.kindId ? count : 'ERASE'}
            </Text>
          </Pressable>
        );
      })}

      {onAddKind ? (
        <Pressable
          accessibilityLabel="Add a new kind of piece"
          accessibilityRole="button"
          onPress={onAddKind}
          style={({ pressed }) => [styles.brush, styles.add, pressed && styles.pressed]}
        >
          <Text style={styles.plus}>+</Text>
          <Text style={styles.count}>NEW</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export default memo(PiecePalette);

const styles = StyleSheet.create({
  palette: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.tight,
    justifyContent: 'center',
  },
  brush: {
    alignItems: 'center',
    backgroundColor: colors.surfaceSunken,
    borderColor: colors.borderStrong,
    borderRadius: radius.small,
    borderWidth: 1,
    height: 46,
    justifyContent: 'center',
    minWidth: 44,
    paddingHorizontal: space.tight,
  },
  brushOn: { backgroundColor: colors.accentSurfaceStrong, borderColor: colors.accent },
  add: { borderStyle: 'dashed' },
  eraser: { color: colors.textMuted, fontSize: 22, lineHeight: 24 },
  plus: { color: colors.textMuted, fontSize: 20, lineHeight: 24 },
  count: { ...type.eyebrow, color: colors.textFaint, letterSpacing: 0 },
  countOn: { color: colors.accentSoft },
  pressed: { opacity: 0.7 },
});
