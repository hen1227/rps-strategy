import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import {
  Animated as NativeAnimated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import SeriesScoreTable from '@/features/bots/SeriesScoreTable';
import { watchedOutcome, withLiveGame, withWatchedResult } from '@/features/bots/seriesSummary';
import { useBotSeries } from '@/hooks/useBotSeries';
import { useWideScreen } from '@/hooks/useBoardLayout';
import { useGameStore } from '@/store/gameStore';
import { links } from '@/navigation/links';
import type { SpectateContext } from '@/hooks/useSpectateContext';
import {
  isGameLive,
  seriesProgressLabel,
  seriesScoreOf,
  type TournamentBoard,
} from '@/store/spectateSelectors';
import { colors, radius, space } from '@/theme';
import type { GameEndReason, GameStatus, PlayerColor } from '@/types/game';
import type { LiveGameSummary } from '@/types/protocol';

// The bar above a spectated board: everything else there is to watch from
// here. It is the one thing on the screen that does not change when the board
// does, which is what makes it somewhere to steer from.

export interface SpectateRailProps {
  blueName: string;
  context: SpectateContext;
  /** The board on screen. */
  currentGameId: string;
  /**
   * How the board on screen stands, and how it ended if it has.
   *
   * The score strip needs all three the moment a game finishes: the run files
   * its result a beat after the last position reaches the screen, so this is
   * what lets the column of the game just watched score itself immediately
   * rather than sitting on a dot until the next fetch. See `withWatchedResult`.
   */
  gameStatus: GameStatus;
  winner: PlayerColor;
  endReason?: GameEndReason | string | null;
  disabled: boolean;
  /** The board asked for, until it lands. */
  pendingGameId: string | null;
  onWatch: (gameId: string) => void;
  redName: string;
}

export default function SpectateRail({
  blueName,
  context,
  currentGameId,
  disabled,
  endReason = null,
  gameStatus,
  pendingGameId,
  onWatch,
  redName,
  winner,
}: SpectateRailProps) {
  const { boards, nextSeriesGame, series, tournament } = context;
  const isPending = Boolean(pendingGameId) && pendingGameId !== currentGameId;

  if (series) {
    return (
      <RailFrame>
        <SeriesRail
          blueName={blueName}
          currentGameId={currentGameId}
          disabled={disabled}
          endReason={endReason}
          gameStatus={gameStatus}
          isPending={isPending}
          nextGame={nextSeriesGame}
          onWatch={onWatch}
          redName={redName}
          series={series}
          winner={winner}
        />
      </RailFrame>
    );
  }
  if (tournament && boards.length > 0) {
    return (
      <RailFrame>
        <TournamentRail
          boards={boards}
          currentGameId={currentGameId}
          disabled={disabled}
          name={tournament.name}
          onWatch={onWatch}
          pendingGameId={isPending ? pendingGameId : null}
        />
      </RailFrame>
    );
  }
  return null;
}

/** The bar's own arrival, so it does not simply appear over the board. */
function RailFrame({ children }: { children: ReactNode }) {
  const entrance = useRef(new NativeAnimated.Value(0)).current;

  useEffect(() => {
    const animation = NativeAnimated.timing(entrance, {
      toValue: 1,
      duration: 260,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [entrance]);

  return (
    <NativeAnimated.View
      style={[
        styles.rail,
        {
          opacity: entrance,
          transform: [
            {
              translateY: entrance.interpolate({
                inputRange: [0, 1],
                outputRange: [-10, 0],
              }),
            },
          ],
        },
      ]}
    >
      {children}
    </NativeAnimated.View>
  );
}

interface SeriesRailProps {
  blueName: string;
  /** The board on screen, drawn as the current chip. */
  currentGameId: string;
  disabled: boolean;
  endReason: GameEndReason | string | null;
  gameStatus: GameStatus;
  isPending: boolean;
  nextGame: LiveGameSummary | null;
  onWatch: (gameId: string) => void;
  redName: string;
  series: NonNullable<SpectateContext['series']>;
  winner: PlayerColor;
}

function SeriesRail({
  blueName,
  currentGameId,
  disabled,
  endReason,
  gameStatus,
  isPending,
  nextGame,
  onWatch,
  redName,
  series,
  winner,
}: SeriesRailProps) {
  const isWide = useWideScreen();
  const router = useRouter();
  const liveGames = useGameStore((state) => state.liveGames);
  const liveGameIds = useMemo(() => liveGames.map((live) => live.gameId), [liveGames]);
  // Refetched on all three things that change what the strip should say: the
  // run moving on, the game on screen ending, and the next board coming up.
  //
  // The game number alone was not enough, which is the bug this fixes. It is
  // read off the *watched* game's row, and that row is frozen once the game
  // finishes — so watching game four end and game five start moved nothing:
  // the finished column kept its dot and the live mark had nowhere to go.
  //
  // Only the run itself is wanted here: a rail with no table is still a rail,
  // so there is nothing for this screen to do with the difference between
  // "still loading" and "no such run".
  const revision = `${series.gameNumber}:${gameStatus}:${nextGame?.gameId ?? ''}`;
  const fetched = useBotSeries(series.seriesId, revision).series;

  // What the watcher can see, over what the archive has filed. Both of these
  // cover the same gap from opposite ends — the server files a result after it
  // shows it, and records a new game after it starts it — so between a fetch
  // and the write it is racing, this is what keeps the strip agreeing with the
  // board. Both are no-ops once the fetch catches up.
  const watched = useMemo(
    () =>
      gameStatus === 'Finished'
        ? {
            gameId: currentGameId,
            outcome: watchedOutcome(winner, series.firstIsRed),
            endReason: endReason ?? undefined,
          }
        : null,
    [currentGameId, endReason, gameStatus, series.firstIsRed, winner],
  );
  const liveNow = useMemo(() => {
    const board = liveGames.find((live) => live.series?.seriesId === series.seriesId);
    if (!board?.series) return null;
    return {
      gameId: board.gameId,
      gameNumber: board.series.gameNumber,
      firstIsRed: board.series.firstIsRed,
    };
  }, [liveGames, series.seriesId]);
  const full = useMemo(
    () => (fetched ? withLiveGame(withWatchedResult(fetched, watched), liveNow) : null),
    [fetched, liveNow, watched],
  );

  // Picking a game off the table. A game still in play is another board to
  // watch, and swapping to it is what the NEXT GAME button beside this already
  // does; a finished one has no live board left to put anybody on, so it opens
  // its record instead.
  const watchSeriesGame = (gameId: string) => {
    if (gameId === currentGameId) return;
    if (isGameLive(liveGames, gameId)) {
      onWatch(gameId);
      return;
    }
    router.push(links.review(gameId));
  };
  const score = seriesScoreOf(series, redName, blueName);
  const played = series.firstWins + series.secondWins + series.draws;
  const canAdvance = Boolean(nextGame) && !disabled && !isPending;
  const isOver = !nextGame && series.gameNumber >= series.totalGames;

  // The score in words, for the moment before the run's games arrive. Once they
  // do the table below says the same thing with both names and both totals in
  // it, and saying it twice is what made this bar as tall as it was.
  const scoreboard = (
    <View style={isWide ? styles.scoreBlock : styles.scoreBlockStacked}>
      <Text style={styles.scoreLine} numberOfLines={1}>
        {score.firstName}{' '}
        <Text style={styles.scoreValue}>
          {score.firstWins} – {score.secondWins}
        </Text>{' '}
        {score.secondName}
      </Text>
      {score.draws > 0 && (
        <Text style={styles.scoreDraws}>
          {score.draws === 1 ? '1 draw' : `${score.draws} draws`}
        </Text>
      )}
    </View>
  );

  // Every game of the run, not only the one on screen and the one after it.
  // The bar says where you are; this says what has happened, which is the
  // question somebody arriving at game five actually has.
  //
  // A finished game opens in review rather than on this board, because there is
  // no live board to put you on — the engines have moved on. The game being
  // played is the current chip and is already where you are.
  const table = full ? (
    <SeriesScoreTable
      compact
      currentGameId={currentGameId}
      liveGameIds={liveGameIds}
      onSelect={watchSeriesGame}
      series={full}
    />
  ) : null;

  return (
    <View style={styles.seriesFrame}>
    <View style={styles.railRow}>
      <View style={isWide ? styles.railCopy : styles.railCopyStacked}>
        <Text style={styles.eyebrow}>BOT SERIES</Text>
        <Text style={styles.railTitle} numberOfLines={1}>
          {seriesProgressLabel(series)}
        </Text>
        <SeriesMeter played={played} position={series.gameNumber} total={series.totalGames} />
        {!isWide && !table && scoreboard}
      </View>
      {/*
        On a wide screen the table is the scoreboard, in the room the score line
        used to sit in: the bar was a strip of copy with an empty middle and the
        whole table stacked underneath, which is two blocks off the top of the
        screen to say one thing. A phone keeps them stacked — a fixed names
        column, the games and the button will not go across one phone width.
      */}
      {isWide ? (
        <View style={styles.railSlot}>
          {table ? <View style={styles.railTable}>{table}</View> : scoreboard}
        </View>
      ) : null}
      <Pressable
        accessibilityLabel="Watch the next game of this series"
        accessibilityRole="button"
        accessibilityState={{ disabled: !canAdvance }}
        disabled={!canAdvance}
        onPress={() => nextGame && onWatch(nextGame.gameId)}
        style={({ pressed }) => [
          styles.advance,
          canAdvance && styles.advanceReady,
          pressed && styles.pressed,
        ]}
      >
        <Text style={[styles.advanceText, canAdvance && styles.advanceTextReady]}>
          {isPending ? 'OPENING…' : isOver ? 'LAST GAME' : 'NEXT GAME ▶'}
        </Text>
      </Pressable>
    </View>

      {!isWide && table}
    </View>
  );
}

/** How far through the run this game is. */
function SeriesMeter({
  played,
  position,
  total,
}: {
  played: number;
  position: number;
  total: number;
}) {
  const finished = total > 0 ? Math.min(played / total, 1) : 0;
  const current = total > 0 ? Math.min(position / total, 1) : 0;
  return (
    <View style={styles.meter}>
      <View style={[styles.meterCurrent, { width: `${current * 100}%` }]} />
      <View style={[styles.meterPlayed, { width: `${finished * 100}%` }]} />
    </View>
  );
}

interface TournamentRailProps {
  boards: TournamentBoard[];
  currentGameId: string;
  disabled: boolean;
  name: string;
  onWatch: (gameId: string) => void;
  pendingGameId: string | null;
}

function TournamentRail({
  boards,
  currentGameId,
  disabled,
  name,
  onWatch,
  pendingGameId,
}: TournamentRailProps) {
  return (
    <View style={styles.railColumn}>
      <View style={styles.railHeader}>
        <Text style={styles.eyebrow}>{name.toUpperCase()}</Text>
        <Text style={styles.railCount}>
          {boards.length === 1 ? '1 board live' : `${boards.length} boards live`}
        </Text>
      </View>
      <ScrollView
        contentContainerStyle={styles.boardStrip}
        horizontal
        showsHorizontalScrollIndicator={false}
      >
        {boards.map((board) => {
          const isCurrent = board.gameId === currentGameId;
          const isOpening = board.gameId === pendingGameId;
          return (
            <Pressable
              accessibilityLabel={`Watch ${board.redName} versus ${board.blueName}`}
              accessibilityRole="button"
              accessibilityState={{ disabled: isCurrent || disabled, selected: isCurrent }}
              disabled={isCurrent || disabled}
              key={board.gameId}
              onPress={() => onWatch(board.gameId)}
              style={({ pressed }) => [
                styles.board,
                isCurrent && styles.boardCurrent,
                pressed && styles.pressed,
              ]}
            >
              <Text style={styles.boardRound}>
                {isCurrent ? '◉ WATCHING' : isOpening ? 'OPENING…' : `ROUND ${board.roundNumber}`}
              </Text>
              <Text style={styles.boardNames} numberOfLines={1}>
                {board.redName} vs {board.blueName}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  // The steering bar and the run's own games, stacked: one says where you are,
  // the other says what has happened.
  seriesFrame: { gap: space.snug },
  rail: {
    marginBottom: 6,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceSunken,
  },
  railRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  railColumn: { gap: 8 },
  // A fixed width so the meter reads as a meter rather than stretching into a
  // rule across the bar.
  railCopy: { gap: 2, width: 186, flexShrink: 1 },
  railCopyStacked: { gap: 2, flex: 1 },
  // Reads as a scoreboard: the run on the left, the score up against the
  // button that moves you along it. The score shrinks rather than pushing the
  // button off the bar, so a long run scrolls its games inside this instead.
  railSlot: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    flexShrink: 1,
    minWidth: 0,
  },
  // Allowed to shrink, so a fifty-game run scrolls its games inside the bar
  // rather than growing across the button that moves you along it.
  railTable: { flexShrink: 1, minWidth: 0 },
  scoreBlock: { alignItems: 'flex-end' },
  scoreBlockStacked: { marginTop: 1 },
  scoreLine: { color: colors.textMuted, fontSize: 11 },
  scoreValue: { color: colors.textStrong, fontWeight: '900' },
  scoreDraws: { color: colors.textFaint, fontSize: 10, marginTop: 1 },
  railHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between' },
  eyebrow: {
    color: colors.textFaint,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 1.1,
  },
  railTitle: { color: colors.textStrong, fontSize: 13, fontWeight: '900' },
  railCount: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },

  meter: {
    height: 3,
    marginTop: 2,
    borderRadius: 2,
    backgroundColor: colors.surfaceMuted,
    overflow: 'hidden',
  },
  // The played games fill solid; the game in progress reaches ahead of them.
  meterCurrent: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: colors.accentBorder,
  },
  meterPlayed: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    backgroundColor: colors.accentBright,
  },

  advance: {
    minHeight: 30,
    paddingHorizontal: 11,
    justifyContent: 'center',
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  advanceReady: { borderColor: colors.accentBorder, backgroundColor: colors.accentSurfaceRaised },
  advanceText: { color: colors.textFaint, fontSize: 10, fontWeight: '900', letterSpacing: 0.6 },
  advanceTextReady: { color: colors.accentTextStrong },

  boardStrip: { flexDirection: 'row', gap: 7, paddingRight: 2 },
  board: {
    minWidth: 132,
    paddingHorizontal: 10,
    paddingVertical: 7,
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
    gap: 2,
  },
  boardCurrent: { borderColor: colors.accentBright, backgroundColor: colors.accentSurface },
  boardRound: {
    color: colors.textFaint,
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.9,
  },
  boardNames: { color: colors.text, fontSize: 12, fontWeight: '800' },

  pressed: { opacity: 0.72 },
});
