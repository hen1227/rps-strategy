import { useEffect, useRef, type ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import MoveQualityBadge from './MoveQualityBadge';
import type { GradableMove, ReviewMove } from '@/engine/gameReview';
import { formatMove, type NotatedMove } from '@/engine/pgn';
import { colors, radius, themedSheet } from '@/theme';

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
  /**
   * Whether the moves are being graded at all.
   *
   * Off, this is a plain score sheet: the moves that were played, and which one
   * you are standing on. Not the same as every move being `pending`, which is
   * what an ungraded report looks like from here — a pending pip is a promise
   * that a grade is coming, and with the engine switched off none is.
   */
  graded?: boolean;
  moves: ReviewMove<TMove>[];
  /** Called with the *position* index the move leads to, not the move index. */
  onSelect: (positionIndex: number) => void;
  selectedIndex: number;
  title?: string;
  /**
   * Scroll the rows inside the card rather than growing it.
   *
   * For a caller that gives this a bounded height and wants the furniture
   * around the rows to stay put — the live board, where the score sheet sits in
   * a fixed column beside a game that keeps adding to it. Without it, a
   * forty-move game pushed the replay controls off the bottom of the panel and
   * moved them again after every move.
   *
   * The screens that read a finished game leave it off: a review is a page you
   * scroll, and a list that scrolled inside a page that also scrolls is two
   * scrollbars arguing.
   */
  scroll?: boolean;
  /**
   * Pinned under the rows, inside the card, on a bar of its own.
   *
   * Where the replay controls belong when the rows scroll: they are what the
   * list is steered with, so they have to be reachable without scrolling to
   * the end of it. The rows take the card's spare height and the bar sits
   * under them, at the foot of the card, whether the game is two moves old or
   * forty — so the controls are always in the same place.
   */
  footer?: ReactNode;
  /**
   * Drawn at the right-hand end of the title row, level with the eyebrow.
   *
   * For something that is about the position the list is standing on rather
   * than about the list — copying that board. It goes up here rather than in
   * the `footer` because the footer is the bar the list is *steered* with, and
   * because the title row already exists: a board with a score sheet beside it
   * is short of height on every screen that draws one, and this costs none.
   */
  titleAccessory?: ReactNode;
}

/** One numbered row of the score sheet: Red's move, then Blue's reply. */
interface MoveRow<TMove extends ListedMove> {
  number: number;
  red: ReviewMove<TMove> | undefined;
  blue: ReviewMove<TMove> | undefined;
}

export default function MoveAnalysisList<TMove extends ListedMove>({
  emptyText = 'This game has no moves yet.',
  footer,
  graded = true,
  moves,
  onSelect,
  selectedIndex,
  scroll = false,
  title = 'MOVES',
  titleAccessory,
}: MoveAnalysisListProps<TMove>) {
  const rows: MoveRow<TMove>[] = [];
  for (let index = 0; index < moves.length; index += 2) {
    rows.push({ number: index / 2 + 1, red: moves[index], blue: moves[index + 1] });
  }

  // Follow the game down the list, but only for somebody standing at the end of
  // it. A viewer who has scrolled up to look at move four is reading, and
  // yanking them back every time an engine moves would make the list unusable
  // for the one thing they are using it for.
  const scroller = useRef<ScrollView | null>(null);
  const atEnd = selectedIndex >= moves.length;
  useEffect(() => {
    if (!scroll || !atEnd) return;
    scroller.current?.scrollToEnd({ animated: true });
  }, [atEnd, moves.length, scroll]);

  const body =
    rows.length === 0 ? (
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
                      !graded
                        ? ''
                        : move.isBook
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
                    ) : !graded ? null : move.pending ? (
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
    );

  return (
    <View style={[styles.card, scroll && styles.cardBounded]}>
      <View style={styles.titleRow}>
        <Text style={styles.eyebrow}>{title}</Text>
        {titleAccessory}
      </View>
      {scroll ? (
        <ScrollView
          contentContainerStyle={styles.scrollerContent}
          ref={scroller}
          showsVerticalScrollIndicator={false}
          style={styles.scroller}
        >
          {body}
        </ScrollView>
      ) : (
        body
      )}
      {footer ? <View style={styles.footer}>{footer}</View> : null}
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
  // Fills whatever gave it a height, and shrinks to nothing taller than that.
  // `minHeight: 0` is what actually lets the rows scroll: a flex child measures
  // at its content height without it, so the card grows and the scroller inside
  // it never has less room than it needs.
  cardBounded: { flexGrow: 1, flexShrink: 1, minHeight: 0 },
  // Takes the room the card's furniture does not want, rather than only as much
  // as the rows need: the footer under it is then pinned to the foot of the
  // card instead of floating up under a short game's last move.
  scroller: { flexGrow: 1, flexShrink: 1, marginHorizontal: -3, paddingHorizontal: 3 },
  scrollerContent: { paddingBottom: 2 },
  // Full-bleed to the card's inner edge — hence the negative margins against
  // the card's padding — and a shade darker than it, so the rows visibly scroll
  // behind a bar rather than ending at some furniture that happens to be last.
  footer: {
    flexShrink: 0,
    marginTop: 9,
    marginHorizontal: -13,
    marginBottom: -13,
    paddingHorizontal: 13,
    paddingBottom: 9,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    borderBottomLeftRadius: radius.large - 1,
    borderBottomRightRadius: radius.large - 1,
    backgroundColor: colors.surfaceSunken,
  },
  // The accessory is pushed to the far end and the title keeps whatever is
  // left, so a long one wraps rather than shoving the button off the card.
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  eyebrow: {
    flexShrink: 1,
    color: colors.textFaint,
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 1.2,
  },
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
}));
