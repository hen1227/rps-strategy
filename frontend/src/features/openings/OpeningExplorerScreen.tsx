// What people play, from any board you can reach.
//
// The opening book answers "what is good" and this answers "what happens".
// They are different claims and they live on different pages now, because the
// book page had grown to six screens of scroll and this was buried at the
// bottom of it.
//
// The board is the whole interface: play moves on it and every number on the
// page is about the position in front of you. That is only honest because the
// statistics behind it are keyed on the *board* rather than on the moves that
// reached it -- two move orders arriving at the same picture are one position
// with one set of numbers, which is what somebody standing on a board is
// asking. See `ExploreOpeningPosition` in the backend.
//
// A board's *reflection* is the same picture too, wherever a mode has one:
// nothing in Intransitive can tell a position from its image about the a1-i9
// diagonal, so games that played `e3-f3` and games that played `c5-c6` are
// games that reached one position, and they are counted as one. The server owns
// that fold and answers in the coordinates of the board you walked to; what
// arrives here is a move list where one row can have two spellings, drawn as
// one arrow and its dashed twin. See `game/symmetry.go`.
//
// Most of this is borrowed from the analysis screen: the same `Board`, the
// same selection and drag hooks, the same replay controls, the same
// `applyAnalysisMove`. The arrows are the analysis board's own, drawn by
// frequency instead of by engine rank -- see `AnalysisArrow.weight`.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from 'react-native';

import {
  applyAnalysisMove,
  createAnalysisGame,
  squareLabel,
  type AnalysisGame,
} from '@/engine/analysisGame';
import { formatBookMove, parseBookMove } from '@/engine/openingLine';
import {
  arrowWeights,
  formatShare,
  hasEnoughGames,
  type OpeningSegment,
  type OpeningStatsExplored,
  type OpeningStatsExploredMove,
} from '@/engine/openingStats';
import { failureMessage } from '@/errors';
import ReplayControls from '@/features/analysis/ReplayControls';
import Board, { type AnalysisArrow } from '@/features/board/Board';
import { usePieceDrag } from '@/features/board/pieceDrag';
import { useBoardLayout } from '@/hooks/useBoardLayout';
import { useBoardSelection } from '@/hooks/useBoardSelection';
import useReplayKeyboard from '@/hooks/useReplayKeyboard';
import { useSettledSearchParams } from '@/navigation/useSettledSearchParams';
import { ApiError } from '@/store/api/http';
import { exploreOpeningPosition } from '@/store/api/openings';
import { useGameStore } from '@/store/gameStore';
import { colors, contentWidth, radius, space } from '@/theme';
import type { ModeDefinition, ModeID } from '@/types/game';
import ScreenShell from '@/ui/ScreenShell';
import TabBar from '@/ui/TabBar';
import { Badge, Banner, GhostButton, OptionChips, Panel, ToggleChips } from '@/ui/primitives';

import { publishedOn, ui } from './openingsUi';
import { ShareRow } from './statsUi';

// The sources, in the order they are offered. This site's own three first,
// most interesting first, then what came from elsewhere.
//
// All four are checkboxes rather than a pick-one, because they partition every
// game exactly once: any set of them is a coherent survey and the server adds
// the counts up. That is a different claim from the mode tabs above them, which
// really are exclusive -- a game is Intransitive or it is not.
const SEGMENTS: readonly { value: OpeningSegment; label: string }[] = [
  { value: 'human', label: 'HUMAN GAMES' },
  { value: 'bot', label: "BOTS' GAMES" },
  { value: 'mixed', label: 'BOT VS HUMAN' },
  { value: 'meaf', label: 'MEAF.US' },
];

// Humans alone to begin with: bots outnumber them several to one and play
// whatever book they were handed, so an unqualified "most played" that included
// them would be a survey of bot configuration rather than of what people do.
const DEFAULT_SEGMENTS: OpeningSegment[] = ['human'];

/** Enough of a mode to label a tab, before the server catalog arrives. */
const FALLBACK_MODES: { id: ModeID; name: string; shortCode: string }[] = [
  { id: 'V6', name: 'Intransitive', shortCode: 'V6' },
  { id: 'V5', name: 'Total War', shortCode: 'V5' },
  { id: 'V3', name: 'Infiltration', shortCode: 'V3' },
];

/**
 * The tallest the continuation list gets before it scrolls itself.
 *
 * A busy first move has thirty-five continuations and the tail is a game each,
 * so left to grow the list is taller than the board it describes. It gets its
 * own scroller rather than a "show more" button: the list is a thing you read
 * *against* the board, and a control that pushes the board off the top to show
 * you row thirty has answered the wrong question.
 *
 * A number rather than a flex, because a flexed child of a ScrollView grows to
 * its content instead of scrolling -- which is the whole failure this replaces.
 * Shorter when stacked, where the list is under the board and the screen is
 * usually a phone.
 */
const MOVES_MAX_HEIGHT = { narrow: 320, wide: 440 };

/**
 * How many continuations get an arrow.
 *
 * The board draws up to five and the table lists them all. Five arrows on a
 * nine by nine is already close to unreadable, and the tail of a frequency
 * list is a single game each.
 *
 * Continuations, not arrows: a move with a reflected twin spends one of the
 * five and draws two, because the two are one move and dropping one of them
 * would claim only half of it is on offer.
 */
const ARROWS = 5;

/** Every way one continuation can be spelled on the board in front of you. */
const spellingsOf = (move: OpeningStatsExploredMove): string[] => [
  move.move,
  ...(move.twins ?? []),
];

/**
 * How to describe a mode's fold to somebody reading the counts.
 *
 * Worth a sentence on the page rather than a footnote in the code. "12 games
 * reached this position" is a different claim once reflections are counted
 * together, and a reader who works out for themselves that two of those games
 * played what looks like a different opening should find the answer here rather
 * than conclude the numbers are wrong.
 *
 * The diagonal is named by its two ends, taken from the mode's own board, so a
 * mode that is not nine by nine does not get told about a1–i9.
 */
const foldDescription = (mode: ModeDefinition | null): string | null => {
  const rows = mode?.startingPosition?.rows;
  if (!mode?.symmetries?.length || !rows?.length) return null;
  const width = rows[0].length;
  const height = rows.length;
  if (mode.symmetries.includes('diagonal')) {
    const corner = squareLabel({ x: width - 1, y: height - 1 });
    return `reflected about the ${squareLabel({ x: 0, y: 0 })}–${corner} diagonal`;
  }
  if (mode.symmetries.includes('mirror-files')) return 'mirrored left to right';
  return null;
};

/**
 * The narrowest the reading column may be before the board gives up the row.
 *
 * The board is sized from this page's own measured column, not from the
 * window. `useBoardLayout` measures the viewport, which is right for the
 * analysis screen and wrong here: this page sits between the shell's sidebar
 * and its live rail, so the window is far wider than the space the board
 * actually has -- and a board sized from it squeezed the figures column to
 * ninety points, which wrapped "18 games" to one letter per line.
 */
const PANEL_MINIMUM = 340;

/** The tallest the board is worth drawing, whatever room there is. */
const BOARD_MAXIMUM = 620;

export default function OpeningExplorerScreen() {
  const { params, settled } = useSettledSearchParams<{ mode?: string; line?: string }>();
  const catalogue = useGameStore((state) => state.modes);

  const [modeId, setModeId] = useState<ModeID>((params.mode as ModeID | undefined) ?? 'V6');
  const [segments, setSegments] = useState<OpeningSegment[]>(DEFAULT_SEGMENTS);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<OpeningStatsExplored | null>(null);
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(false);

  const tabs = catalogue?.length
    ? catalogue.map((mode) => ({
        id: mode.id,
        name: mode.name,
        shortCode: mode.shortCode ?? mode.id,
      }))
    : FALLBACK_MODES;
  const mode: ModeDefinition | null =
    catalogue?.find((candidate) => candidate.id === modeId) ?? null;

  // The board is the state; the line is read back off it. Keeping one array of
  // positions rather than a game plus a history is what makes stepping
  // backwards free -- the earlier boards are still here.
  const [boards, setBoards] = useState<AnalysisGame[]>([]);
  const [line, setLine] = useState<string[]>([]);
  const [cursor, setCursor] = useState(0);

  // Rebuild from the opening position whenever the mode changes, including the
  // first time the catalogue arrives with a starting position in it.
  useEffect(() => {
    if (!mode) return;
    setBoards([createAnalysisGame(mode)]);
    setLine([]);
    setCursor(0);
  }, [mode?.id, mode?.startingPosition]);

  // The link, applied once the query string is readable.
  useEffect(() => {
    if (params.mode) setModeId(params.mode as ModeID);
  }, [params.mode]);

  const game = boards[cursor] ?? null;
  const walked = useMemo(() => line.slice(0, cursor), [line.join(' '), cursor]);

  const performMove = useCallback(
    (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const standing = boards[cursor];
      if (!standing) return;
      const result = applyAnalysisMove(standing, from, to);
      if (!result) return;
      // A move played from part-way back replaces everything after it, which
      // is what makes walking into a variation feel like a variation rather
      // than an edit that has to be undone first.
      setBoards((current) => [...current.slice(0, cursor + 1), result.game]);
      setLine((current) => [...current.slice(0, cursor), formatBookMove({ from, to })]);
      setCursor((current) => current + 1);
    },
    [boards, cursor],
  );

  const selection = useBoardSelection({ game, onMove: performMove });
  const { clearSelection, selectedTile, validMoves } = selection;
  // The board sits inside this page's scroller, and on iOS the enclosing
  // scroll view claims a touch as soon as the finger moves -- which cancels
  // the drag and snaps the piece back. See `pieceDrag.ts`.
  const draggingPiece = usePieceDrag((state) => state.dragging);
  // Only for the height cap; the width comes from the measurement below.
  const { height } = useBoardLayout();
  const [columnWidth, setColumnWidth] = useState(0);
  const measureColumn = (event: LayoutChangeEvent) =>
    setColumnWidth(event.nativeEvent.layout.width);
  // Side by side only when there is room for a *full-size* board and a
  // readable column, not merely for two columns. This page is the board, so a
  // 350pt board beside a 340pt panel is the wrong trade -- stacking gives the
  // board its full width and puts the reading under it, which is also the
  // order that works on a phone.
  const isWide = columnWidth >= BOARD_MAXIMUM + PANEL_MINIMUM + space.medium;
  const boardSize = Math.floor(
    Math.max(
      240,
      Math.min(
        BOARD_MAXIMUM,
        height - 220,
        isWide ? columnWidth - PANEL_MINIMUM - space.medium : columnWidth,
      ),
    ),
  );

  useEffect(() => {
    clearSelection();
  }, [cursor, clearSelection]);

  // The numbers for the board in front of you. Refetched on every step,
  // because a position is the unit of the whole page.
  useEffect(() => {
    if (!settled) return;
    // Nothing ticked is a question with no subject. Answered here rather than
    // by the server, which would have to refuse it: there is nothing wrong
    // with the request, there is just nothing being asked.
    if (segments.length === 0) {
      setStats(null);
      setMissing(false);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    exploreOpeningPosition(modeId, { segments, line: walked })
      .then((result) => {
        if (cancelled) return;
        setStats(result);
        setMissing(false);
        setError(null);
      })
      .catch((failure) => {
        if (cancelled) return;
        if (failure instanceof ApiError && failure.status === 404) {
          setMissing(true);
          setStats(null);
        } else setError(failureMessage(failure));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [modeId, segments.join(','), settled, walked.join(' ')]);

  // The most played continuations, drawn on the board. Weighted by share of
  // *this* board rather than of the mode, so the thickest arrow is always the
  // one most people played from where you are standing.
  //
  // One arrow per *spelling*, all carrying the rank of the continuation they
  // belong to. A move with a reflected twin is two arrows in one colour, the
  // second dashed: they are two ways to play one move and they are the same
  // number of games, so drawing them in two colours at two thicknesses would
  // be the page contradicting its own move list.
  const arrows: AnalysisArrow[] = useMemo(() => {
    const moves = stats?.moves?.slice(0, ARROWS) ?? [];
    const weights = arrowWeights(moves);
    return moves.flatMap((candidate, rank) =>
      spellingsOf(candidate).flatMap((notation, spelling) => {
        const parsed = parseBookMove(notation);
        return parsed
          ? [{ ...parsed, weight: weights[rank], rank, dashed: spelling > 0 }]
          : [];
      }),
    );
  }, [stats?.moves]);

  const chooseMode = (next: ModeID) => {
    setModeId(next);
    setError(null);
  };

  const jump = useCallback(
    (ply: number) => setCursor(Math.max(0, Math.min(line.length, ply))),
    [line.length],
  );

  // Left and right step the line, the same as the buttons under the board. The
  // hook is the one the analysis and review screens already use, so the arrows
  // mean here what they mean there, and it declines them when the viewer is
  // typing into something.
  //
  // Horizontal only, unlike those two. This page is long -- a board, then a
  // list that can run to forty rows -- so Up, Down, Home and End are how
  // somebody reads it, and a hook that swallowed them would answer "scroll
  // down" with "jump to the end of the line".
  useReplayKeyboard({
    horizontalOnly: true,
    onFirst: () => jump(0),
    onLast: () => jump(line.length),
    onNext: () => setCursor((current) => Math.min(line.length, current + 1)),
    onPrevious: () => setCursor((current) => Math.max(0, current - 1)),
  });

  const reachedHere = stats?.games ?? 0;
  const movesMaxHeight = isWide ? MOVES_MAX_HEIGHT.wide : MOVES_MAX_HEIGHT.narrow;
  const folded = foldDescription(mode);
  const hasTwins = Boolean(stats?.moves?.some((move) => (move.twins?.length ?? 0) > 0));

  const boardPanel = game ? (
    <View style={styles.boardColumn}>
      <Board
        analysisArrows={arrows}
        boardSize={boardSize}
        canMove
        grid={game.grid}
        lastMove={cursor > 0 ? parseBookMove(line[cursor - 1]) : null}
        modeId={modeId}
        movableColor={game.currentTurn}
        onPieceDrop={performMove}
        onTilePress={selection.selectTile}
        playerColor="Blue"
        selectedTile={selectedTile}
        validMoves={validMoves}
      />
      <ReplayControls
        current={cursor}
        label="MOVE"
        onFirst={() => jump(0)}
        onLast={() => jump(line.length)}
        onNext={() => jump(cursor + 1)}
        onPrevious={() => jump(cursor - 1)}
        total={line.length}
      />
      {walked.length > 0 ? (
        <View style={styles.trail}>
          {walked.map((notation, index) => (
            <GhostButton
              compact
              key={`${index}-${notation}`}
              label={notation}
              onPress={() => jump(index + 1)}
            />
          ))}
        </View>
      ) : null}
    </View>
  ) : null;

  return (
    <ScreenShell scroll={false} width={contentWidth.page}>
      <ScrollView
        contentContainerStyle={styles.page}
        scrollEnabled={!draggingPiece}
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <Text style={styles.brand}>OPENING EXPLORER</Text>
          <Text style={styles.headerSubtitle}>
            Play moves on the board. Every number is about the position in front of you, counted
            from the games people have actually finished.
          </Text>
        </View>

        <TabBar
          accessibilityLabel="Game mode"
          onChange={chooseMode}
          options={tabs.map((candidate) => ({
            value: candidate.id,
            label: candidate.name,
            eyebrow: candidate.shortCode,
          }))}
          value={modeId}
        />
        <ToggleChips
          label="COUNT GAMES FROM"
          onChange={setSegments}
          options={SEGMENTS}
          values={segments}
        />

        <Banner message={error} onDismiss={() => setError(null)} tone="error" />

        <View onLayout={measureColumn} style={[styles.layout, isWide && styles.layoutWide]}>
          {boardPanel}

          <View style={[styles.panelColumn, isWide && styles.panelColumnWide]}>
            <Panel style={styles.figures}>
              <View style={styles.figuresHeading}>
                <Text style={ui.eyebrow}>
                  {walked.length === 0
                    ? 'THE STARTING POSITION'
                    : `${walked.length} MOVE${walked.length === 1 ? '' : 'S'} IN`}
                </Text>
                {stats?.computedAtUnixMs ? (
                  <Badge label={`COMPILED ${publishedOn(stats.computedAtUnixMs)}`} />
                ) : null}
              </View>

              {segments.length === 0 ? (
                <Text style={styles.copy}>
                  No sources are selected. Tick at least one above to count some games — the
                  numbers here are only ever about the games you have asked for.
                </Text>
              ) : missing ? (
                <Text style={styles.copy}>
                  These statistics have not been compiled yet. The server recompiles them from the
                  game archive once a day.
                </Text>
              ) : !stats ? (
                <View style={styles.loadingRow}>
                  <ActivityIndicator color={colors.accent} />
                </View>
              ) : (
                <>
                  <Text style={styles.reached}>
                    {reachedHere.toLocaleString()} game{reachedHere === 1 ? '' : 's'}
                  </Text>
                  <Text style={styles.reachedLabel}>
                    {walked.length === 0
                      ? 'counted in this mode'
                      : `reached this position — ${
                          hasEnoughGames(stats.plies > 0 ? stats.games : 0) || stats.share > 0
                            ? formatShare(stats.share)
                            : '0%'
                        } of them`}
                  </Text>
                  {/* A board can be reached several ways, and the count above
                      includes all of them. Saying so is what stops the number
                      looking wrong to somebody who counted the move list. */}
                  {walked.length > 0 && reachedHere > 0 ? (
                    <Text style={styles.note}>
                      By any move order{folded ? ' or reflection' : ''} — {stats.ply === walked.length
                        ? `${stats.ply} move${stats.ply === 1 ? '' : 's'} is the shortest route anybody took`
                        : `the shortest route anybody took is ${stats.ply} move${
                            stats.ply === 1 ? '' : 's'
                          }`}
                      .
                    </Text>
                  ) : null}
                  {/* A standing fact about every count on the page, so it is
                      said whether or not this particular board has games on
                      it. Without it a reader who spots two games opening what
                      looks like a different move concludes the arithmetic is
                      wrong rather than that the two moves are one. */}
                  {folded ? (
                    <Text style={styles.note}>
                      A position and the same position {folded} are counted as one: nothing in{' '}
                      {mode?.name ?? 'this mode'} can tell them apart.
                    </Text>
                  ) : null}
                  {stats.skipped > 0 ? (
                    <Text style={styles.note}>
                      {stats.skipped.toLocaleString()} archived game
                      {stats.skipped === 1 ? ' is' : 's are'} not counted.
                    </Text>
                  ) : null}
                </>
              )}
            </Panel>

            <Panel style={styles.moves}>
              {/* The count belongs in the heading now that the list scrolls:
                  a box with a scrollbar says "there is more" and nothing else,
                  and "35 moves" is the part worth knowing before you drag. */}
              <Text style={ui.eyebrow}>
                {loading
                  ? 'READING…'
                  : `WHAT ${game?.currentTurn?.toUpperCase() ?? ''} PLAYED${
                      stats && stats.moves.length > 0 ? ` · ${stats.moves.length} MOVES` : ''
                    }`}
              </Text>
              {!stats || stats.moves.length === 0 ? (
                <Text style={styles.copy}>
                  {missing
                    ? 'Nothing to show until the first compile.'
                    : reachedHere === 0
                      ? 'No game has reached this position. Step back to a board people have played.'
                      : 'Every game that reached here stopped here.'}
                </Text>
              ) : (
                <ScrollView
                  contentContainerStyle={styles.moveRows}
                  nestedScrollEnabled
                  style={[styles.moveScroll, { maxHeight: movesMaxHeight }]}
                >
                  {stats.moves.map((candidate, index) => {
                    const parsed = parseBookMove(candidate.move);
                    // A row is a *continuation*, not a spelling of one. Its
                    // twin is named on the second line rather than given a row
                    // of its own: both are legal, both are drawn, and both are
                    // these same games -- so a second row would be the same
                    // count printed twice under two names.
                    const twins = candidate.twins ?? [];
                    const detail = parsed
                      ? `${squareLabel(parsed.from)} → ${squareLabel(parsed.to)}${
                          twins.length > 0 ? ` · or ${twins.join(', ')}, reflected` : ''
                        }`
                      : undefined;
                    return (
                      <ShareRow
                        detail={detail}
                        figures={candidate}
                        key={candidate.move}
                        label={candidate.move}
                        leading={index === 0}
                        onPress={() =>
                          parsed ? performMove(parsed.from, parsed.to) : undefined
                        }
                        share={candidate.share}
                        total={reachedHere}
                      />
                    );
                  })}
                </ScrollView>
              )}
              {arrows.length > 0 ? (
                <Text style={styles.note}>
                  The thickest arrow on the board is the most played move from here.
                  {hasTwins
                    ? ' A dashed arrow is the same move reflected — one continuation you can play two ways.'
                    : ''}
                </Text>
              ) : null}
            </Panel>
          </View>
        </View>
      </ScrollView>
    </ScreenShell>
  );
}

const styles = StyleSheet.create({
  // The page's own top and bottom room, inside the scroller rather than around
  // it — see `contentFlush` in `ScreenShell`. Content still starts and ends
  // clear of the chrome, but it now scrolls the whole way to both edges.
  page: { gap: space.medium, paddingBottom: space.xlarge, paddingTop: space.large },
  header: { gap: 4 },
  brand: { color: colors.accentBright, fontSize: 12, fontWeight: '900', letterSpacing: 1.6 },
  headerSubtitle: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  layout: { flexDirection: 'column', gap: space.medium },
  layoutWide: { alignItems: 'flex-start', flexDirection: 'row' },
  boardColumn: { flexGrow: 0, flexShrink: 0, gap: space.small },
  panelColumn: {
    flexGrow: 1,
    flexShrink: 1,
    gap: space.medium,
    minWidth: 0,
  },
  // A basis rather than a bare `flex: 1`: with `minWidth: 0` and no basis the
  // column will shrink under its own longest word, which is how it ended up
  // ninety points wide with one letter per line.
  //
  // Only when the layout is a row, because a basis is along the *main axis* and
  // the main axis is what changes here. Stacked, `flexBasis: 340` stopped being
  // a minimum width and became a fixed 340pt *height* — so a panel column with
  // a thousand points of content was laid out at 340, and the moves list ran
  // three hundred points past the bottom of the page with no way to scroll to
  // it. It looked like the list was too long; it was the column being too
  // short.
  panelColumnWide: { flexBasis: PANEL_MINIMUM },
  figures: { gap: 2 },
  figuresHeading: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: space.small,
    justifyContent: 'space-between',
  },
  reached: { color: colors.text, fontSize: 32, fontWeight: '800', lineHeight: 36 },
  reachedLabel: {
    color: colors.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  note: { color: colors.textFaint, fontSize: 11, lineHeight: 16, marginTop: 6 },
  copy: { color: colors.textMuted, fontSize: 13, lineHeight: 19 },
  moves: { gap: space.small },
  // `flexGrow: 0` matters: React Native Web's ScrollView will otherwise stretch
  // to its content inside this column and scroll nothing, which is the bug this
  // container exists to fix.
  moveScroll: { flexGrow: 0, flexShrink: 1 },
  moveRows: { gap: space.small },
  loadingRow: { alignItems: 'center', paddingVertical: space.medium },
  trail: {
    backgroundColor: colors.surfaceRaised,
    borderRadius: radius.small,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 4,
    padding: 6,
  },
});
