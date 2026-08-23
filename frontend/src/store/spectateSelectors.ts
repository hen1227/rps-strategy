// What else there is to watch, from the game somebody is watching now.
//
// A spectated game is rarely on its own. It is one board of a tournament round
// playing out beside others, or one game of a bot series that will start
// another as soon as this one ends. The rail on the game screen and the live
// table in the lobby ask the same questions of that context, so the answers are
// derived here rather than in either screen.

import type { PlayerProfile } from '@/types/game';
import type { LiveGameSeries, LiveGameSummary, Tournament } from '@/types/protocol';
import { liveMatchesOf, matchStateFor } from './tournamentSelectors';

/** A display name, or the fallback for an unnamed guest. */
export const playerName = (profile: PlayerProfile | null | undefined, fallback: string) => {
  const username = profile?.username?.trim();
  return username && username.toLowerCase() !== 'guest' ? username : fallback;
};

/* ----------------------------------------------------------- tournaments -- */

/** One live board of a tournament, as something to switch to. */
export interface TournamentBoard {
  gameId: string;
  matchId: number;
  roundNumber: number;
  redName: string;
  blueName: string;
}

/**
 * Every game of a tournament being played right now, in schedule order.
 *
 * A match seats its first player as Red, which is what lets a board be named
 * from the schedule alone rather than from the live game it is running in.
 */
export const liveBoardsOf = (
  tournament: Tournament | null | undefined,
): TournamentBoard[] =>
  liveMatchesOf(tournament)
    .map((match) => ({
      gameId: matchStateFor(tournament, match.matchId).gameId ?? '',
      matchId: match.matchId,
      roundNumber: match.roundNumber,
      redName: match.player1?.ign ?? 'Red player',
      blueName: match.player2?.ign ?? 'Blue player',
    }))
    .filter((board) => Boolean(board.gameId));

/** The tournament a live game is a match of, if it is one. */
export const tournamentForGame = (
  tournaments: Tournament[] | null | undefined,
  gameId: string | null | undefined,
): Tournament | null => {
  if (!gameId) return null;
  return (
    (tournaments ?? []).find((tournament) =>
      liveBoardsOf(tournament).some((board) => board.gameId === gameId),
    ) ?? null
  );
};

/* ---------------------------------------------------------------- series -- */

export const seriesOf = (
  liveGames: LiveGameSummary[] | null | undefined,
  gameId: string | null | undefined,
): LiveGameSeries | null => {
  if (!gameId) return null;
  return (liveGames ?? []).find((live) => live.gameId === gameId)?.series ?? null;
};

/**
 * The live game of a run, when it is not the one already on screen.
 *
 * A series plays one game at a time, so this is empty for the whole of a game
 * and fills the moment the next board goes up — which is exactly when somebody
 * watching wants to be moved on.
 */
export const nextGameOfSeries = (
  liveGames: LiveGameSummary[] | null | undefined,
  seriesId: string | null | undefined,
  currentGameId: string | null | undefined,
): LiveGameSummary | null => {
  if (!seriesId) return null;
  return (
    (liveGames ?? []).find(
      (live) => live.series?.seriesId === seriesId && live.gameId !== currentGameId,
    ) ?? null
  );
};

/** A run's tally, named and ordered the way the run itself counts it. */
export interface SeriesScore {
  firstName: string;
  secondName: string;
  firstWins: number;
  secondWins: number;
  draws: number;
}

/**
 * The tally read against the two names in front of it. The seats swap every
 * game, so the colours are no guide to which side of the score is which; that
 * is what `firstIsRed` is for.
 */
export const seriesScoreOf = (
  series: LiveGameSeries,
  redName: string,
  blueName: string,
): SeriesScore => ({
  firstName: series.firstIsRed ? redName : blueName,
  secondName: series.firstIsRed ? blueName : redName,
  firstWins: series.firstWins,
  secondWins: series.secondWins,
  draws: series.draws,
});

export const seriesProgressLabel = (series: LiveGameSeries) =>
  `Game ${series.gameNumber} of ${series.totalGames}`;

/** The tally as one line: "Alpha 2 – 1 Beta · 1 draw". */
export const seriesScoreLabel = (score: SeriesScore) => {
  const drawn =
    score.draws === 0 ? '' : ` · ${score.draws === 1 ? '1 draw' : `${score.draws} draws`}`;
  return `${score.firstName} ${score.firstWins} – ${score.secondWins} ${score.secondName}${drawn}`;
};
