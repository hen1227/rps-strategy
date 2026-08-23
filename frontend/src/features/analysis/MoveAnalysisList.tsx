import { Pressable, StyleSheet, Text, View } from 'react-native';

import MoveQualityBadge from './MoveQualityBadge';
import type { GradableMove, ReviewMove } from '@/engine/gameReview';
import { formatMove, type NotatedMove } from '@/engine/pgn';
import { colors, radius } from '@/theme';

// A compact two-column score sheet. Both post-game review and a running bot
// battle feed it the same move shape, so grades and replay selection cannot
// drift between those screens.
/**
 * A move this list can show: gradable, and complete enough to write down.
 *
 * The score sheet prints move tokens, so it needs the attacker and the victim
 * as well as the squares.
 */
type ListedMove = GradableMove & NotatedMove;

export interface MoveAnalysisListProps<TMove extends ListedMove = ListedMove> {
  emptyText?: string;
  moves: ReviewMove<TMove>[];
  /** Called with the *position* index the move leads to, not the move index. */
  onSelect: (positionIndex: number) => void;
  selectedIndex: number;
  title?: string;
}

/** One numbered row of the score sheet: Red's move, then Blue's reply. */
interface MoveRow<TMove extends ListedMove> {
  number: number;
  red: ReviewMove<TMove> | undefined;
  blue: ReviewMove<TMove> | undefined;
}

export default function MoveAnalysisList<TMove extends ListedMove>({
  emptyText = 'This game has no moves yet.',
  moves,
  onSelect,
  selectedIndex,
  title = 'MOVES',
}: MoveAnalysisListProps<TMove>) {
  const rows: MoveRow<TMove>[] = [];
  for (let index = 0; index < moves.length; index += 2) {
    rows.push({ number: index / 2 + 1, red: moves[index], blue: moves[index + 1] });
  }

  return (
    <View style={styles.card}>
      <Text style={styles.eyebrow}>{title}</Text>
      {rows.length === 0 ? (
        <Text style={styles.empty}>{emptyText}</Text>
      ) : (
        <View style={styles.rows}>
          {rows.map((row) => (
            <View key={row.number} style={styles.row}>
              <Text style={styles.number}>{row.number}</Text>
              {[row.red, row.blue].map((move, column) =>
                move ? (
                  <Pressable
                    accessibilityLabel={`Move ${move.index + 1}, ${formatMove(move)}${
                      move.isBook
                        ? ', opening book'
                        : move.pending
                          ? ''
                          : `, ${move.grade.symbol}, ${move.grade.label}`
                    }`}
                    accessibilityRole="button"
                    accessibilityState={{ selected: selectedIndex === move.index + 1 }}
                    key={column}
                    onPress={() => onSelect(move.index + 1)}
                    style={({ pressed }) => [
                      styles.cell,
                      selectedIndex === move.index + 1 && styles.cellActive,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Text numberOfLines={1} style={styles.move}>
                      {formatMove(move)}
                    </Text>
                    {/*
                      A dealt opening move gets no grade badge. It is still
                      evaluated — the chart would have a hole in it otherwise —
                      but nobody chose it, so calling it good or bad would be a
                      claim about a player that is not true.
                    */}
                    {move.isBook ? (
                      <Text style={styles.bookMark}>book</Text>
                    ) : move.pending ? (
                      <View style={styles.pipPending} />
                    ) : (
                      <MoveQualityBadge
                        accessible={false}
                        compact
                        grade={move.grade}
                        showLabel={false}
                      />
                    )}
                  </Pressable>
                ) : (
                  <View key={column} style={styles.cell} />
                ),
              )}
            </View>
          ))}
        </View>
      )}
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
  empty: { color: colors.textFaint, fontSize: 9, marginTop: 9 },
  rows: { marginTop: 9, gap: 3 },
  row: { minHeight: 31, flexDirection: 'row', alignItems: 'center', gap: 4 },
  number: {
    width: 22,
    color: colors.textFaint,
    fontSize: 9,
    fontWeight: '900',
    textAlign: 'right',
    marginRight: 2,
  },
  cell: {
    minWidth: 0,
    flex: 1,
    minHeight: 29,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 7,
    borderRadius: radius.small,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  cellActive: { borderColor: colors.accent, backgroundColor: colors.accentSurface },
  move: { flex: 1, color: colors.textSoft, fontSize: 9, fontWeight: '800' },
  pipPending: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.borderLight },
  bookMark: { color: colors.textFaint, fontSize: 9, fontStyle: 'italic' },
  pressed: { opacity: 0.68 },
});
