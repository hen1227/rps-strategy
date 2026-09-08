import { useEffect, useMemo, useState } from 'react';

import { useGameStore } from '@/store/gameStore';
import {
  liveBoardsOf,
  nextGameOfSeries,
  seriesOf,
  tournamentForGame,
  type TournamentBoard,
} from '@/store/spectateSelectors';
import type { LiveGameSeries, LiveGameSummary, Tournament } from '@/types/protocol';

/** What surrounds the game on screen: its tournament, or its bot series. */
export interface SpectateContext {
  /** The run this game is part of, or null when it is not part of one. */
  series: LiveGameSeries | null;
  /** The run's next board, once it is up. */
  nextSeriesGame: LiveGameSummary | null;
  tournament: Tournament | null;
  /** Every board of that tournament being played right now. */
  boards: TournamentBoard[];
}

const EMPTY: SpectateContext = {
  series: null,
  nextSeriesGame: null,
  tournament: null,
  boards: [],
};

/** The last context read, and the game it was read from. */
interface WatchedContext {
  gameId: string;
  series: LiveGameSeries | null;
  tournamentId: string | null;
}

const unchanged = (left: WatchedContext | null, right: WatchedContext) => {
  if (!left) return false;
  return (
    left.gameId === right.gameId &&
    left.tournamentId === right.tournamentId &&
    left.series?.seriesId === right.series?.seriesId &&
    left.series?.gameNumber === right.series?.gameNumber &&
    left.series?.firstWins === right.series?.firstWins &&
    left.series?.secondWins === right.series?.secondWins &&
    left.series?.draws === right.series?.draws
  );
};

const withTally = (series: LiveGameSeries, tally: LiveGameSeries): LiveGameSeries => ({
  ...series,
  firstWins: tally.firstWins,
  secondWins: tally.secondWins,
  draws: tally.draws,
});

/**
 * The context of the game being spectated.
 *
 * It is remembered against the game it was read from, because a finished game
 * leaves the live table and its tournament match stops being live — and that is
 * the exact moment somebody wants to be told what to watch next. The tournament
 * only needs its id kept, since the board itself stays on the wire; a series
 * needs its whole row, which disappears with the game it described.
 */
export const useSpectateContext = (): SpectateContext => {
  const isSpectating = useGameStore((state) => state.isSpectating);
  const liveGames = useGameStore((state) => state.liveGames);
  const tournaments = useGameStore((state) => state.tournaments);
  const gameId = useGameStore((state) => state.gameState?.gameId ?? null);

  const liveSeries = useMemo(() => seriesOf(liveGames, gameId), [liveGames, gameId]);
  const liveTournament = useMemo(
    () => tournamentForGame(tournaments, gameId),
    [tournaments, gameId],
  );

  const [watched, setWatched] = useState<WatchedContext | null>(null);
  useEffect(() => {
    if (!isSpectating || !gameId) {
      setWatched(null);
      return;
    }
    // Nothing to learn from a game that has already left the live table; the
    // previous reading is the one worth keeping.
    if (!liveSeries && !liveTournament) return;
    const next: WatchedContext = {
      gameId,
      series: liveSeries,
      tournamentId: liveTournament?.tournamentId ?? null,
    };
    setWatched((current) => (unchanged(current, next) ? current : next));
  }, [gameId, isSpectating, liveSeries, liveTournament]);

  return useMemo(() => {
    if (!isSpectating || !gameId) return EMPTY;
    const current = watched?.gameId === gameId ? watched : null;
    const series = liveSeries ?? current?.series ?? null;
    const tournament =
      liveTournament ??
      (tournaments ?? []).find(
        (candidate) => candidate.tournamentId === current?.tournamentId,
      ) ??
      null;
    const nextSeriesGame = nextGameOfSeries(liveGames, series?.seriesId, gameId);
    return {
      // A finished game leaves the live table before its own result reaches
      // the tally, so once the run's next board is up it holds the truer
      // count. Only the count is taken from it: the game number and the seats
      // still describe the board on screen.
      series: series && nextSeriesGame?.series ? withTally(series, nextSeriesGame.series) : series,
      nextSeriesGame,
      tournament,
      boards: liveBoardsOf(tournament),
    };
  }, [gameId, isSpectating, liveGames, liveSeries, liveTournament, tournaments, watched]);
};
