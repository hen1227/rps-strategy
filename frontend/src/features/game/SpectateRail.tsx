import { useEffect, useRef, type ReactNode } from 'react';
import {
  Animated as NativeAnimated,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { useWideScreen } from '@/hooks/useBoardLayout';
import type { SpectateContext } from '@/hooks/useSpectateContext';
import {
  seriesProgressLabel,
  seriesScoreOf,
  type TournamentBoard,
} from '@/store/spectateSelectors';
import { colors, radius } from '@/theme';
import type { LiveGameSummary } from '@/types/protocol';

// The bar above a spectated board: everything else there is to watch from
// here. It is the one thing on the screen that does not change when the board
// does, which is what makes it somewhere to steer from.

export interface SpectateRailProps {
  blueName: string;
  context: SpectateContext;
  /** The board on screen. */
  currentGameId: string;
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
  pendingGameId,
  onWatch,
  redName,
}: SpectateRailProps) {
  const { boards, nextSeriesGame, series, tournament } = context;
  const isPending = Boolean(pendingGameId) && pendingGameId !== currentGameId;

  if (series) {
    return (
      <RailFrame>
        <SeriesRail
          blueName={blueName}
          disabled={disabled}
          isPending={isPending}
          nextGame={nextSeriesGame}
          onWatch={onWatch}
          redName={redName}
          series={series}
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
  disabled: boolean;
  isPending: boolean;
  nextGame: LiveGameSummary | null;
  onWatch: (gameId: string) => void;
  redName: string;
  series: NonNullable<SpectateContext['series']>;
}

function SeriesRail({
  blueName,
  disabled,
  isPending,
  nextGame,
  onWatch,
  redName,
  series,
}: SeriesRailProps) {
  const isWide = useWideScreen();
  const score = seriesScoreOf(series, redName, blueName);
  const played = series.firstWins + series.secondWins + series.draws;
  const canAdvance = Boolean(nextGame) && !disabled && !isPending;
  const isOver = !nextGame && series.gameNumber >= series.totalGames;

  // The score sits beside the run on a wide screen and under it on a narrow
  // one. Three things across one phone-width row leaves none of them legible.
  const scoreboard = (
    <View style={isWide ? styles.railScore : styles.railScoreStacked}>
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

  return (
    <View style={styles.railRow}>
      <View style={isWide ? styles.railCopy : styles.railCopyStacked}>
        <Text style={styles.eyebrow}>BOT SERIES</Text>
        <Text style={styles.railTitle} numberOfLines={1}>
          {seriesProgressLabel(series)}
        </Text>
        <SeriesMeter played={played} position={series.gameNumber} total={series.totalGames} />
        {!isWide && scoreboard}
      </View>
      {isWide && scoreboard}
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
  rail: {
    marginBottom: 7,
    paddingHorizontal: 11,
    paddingVertical: 9,
    borderRadius: radius.large,
    borderWidth: 1,
    borderColor: colors.borderSoft,
    backgroundColor: colors.surfaceSunken,
  },
  railRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  railColumn: { gap: 8 },
  // A fixed width so the meter reads as a meter rather than stretching into a
  // rule across the bar.
  railCopy: { gap: 3, width: 210, flexShrink: 1 },
  railCopyStacked: { gap: 3, flex: 1 },
  // Reads as a scoreboard: the run on the left, the score up against the
  // button that moves you along it.
  railScore: { flex: 1, alignItems: 'flex-end' },
  railScoreStacked: { marginTop: 1 },
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
  railTitle: { color: colors.textStrong, fontSize: 14, fontWeight: '900' },
  railCount: { color: colors.textMuted, fontSize: 11, fontWeight: '700' },

  meter: {
    height: 4,
    marginTop: 1,
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
    minHeight: 36,
    paddingHorizontal: 13,
    justifyContent: 'center',
    borderRadius: radius.medium,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceRaised,
  },
  advanceReady: { borderColor: colors.accentBorder, backgroundColor: colors.accentSurfaceRaised },
  advanceText: { color: colors.textFaint, fontSize: 11, fontWeight: '900', letterSpacing: 0.6 },
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
