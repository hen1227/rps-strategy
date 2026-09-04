import { endReasonPhrase } from '@/features/game/resultLabels';
import type { BotSeries, BotSeriesGame, BotSeriesResult } from '@/store/api/bots';
import type { PlayerColor } from '@/types/game';
import { timeControlLabel } from '@/store/setupSelectors';
import type { BadgeTone } from '@/ui/tones';

// Reading a run.
//
// A `BotSeries` off the wire is stored the way a run is played: every result is
// written from the *first* bot's point of view, whichever seat it held that
// game, because the seats swap every game and a colour-relative tally would mean
// nothing by game two. That is right for storage and useless for drawing, where
// the questions are "who won this one", "who abandoned", and "which of these am
// I looking at".
//
// So this module is the one place that turns the stored shape into the drawn
// one. It is shared rather than duplicated because the same run is drawn in
// three places now — as a card on two pages, and as a strip over the board on
// the review and spectate screens — and a run that reads 4–2 in one of them and
// 2–4 in another would be worse than no strip at all.

/** Which side a finished game went to, named rather than numbered. */
export type SeriesSide = 'first' | 'second' | 'draw' | 'pending';

export interface SeriesGameView {
  game: BotSeriesGame;
  /** Playing order, 1-based, which is what the column is headed with. */
  number: number;
  side: SeriesSide;
  /**
   * The two cells of this game's column: a point to the winner, nothing to the
   * loser, half each for a draw.
   *
   * Scored per bot rather than as one letter, which is the whole reason this
   * is a table. A run of `W L W W` says nothing on its own — a reader has to
   * hold "W means the left one" in their head and apply it six times, and the
   * seats swap every game, so the instinct to read it off the board is wrong.
   * A row of ones under a name is not ambiguous about anybody.
   */
  firstPoints: string;
  secondPoints: string;
  /** The name of whoever walked away, when that is how the game ended. */
  abandonedBy: string | null;
  /** "Angel_v19_D8 won by resignation", for the column's accessible label. */
  label: string;
  /** Absent for a game that never started, which cannot be reviewed. */
  gameId: string | null;
  /**
   * Who sat where, which the stored row only says as a `swapped` flag.
   *
   * The swap is the reason a run is trustworthy — the same opening played from
   * both sides cancels the first move's worth — so a page listing the games has
   * to be able to say which way round each one was, and working that out from a
   * boolean at the call site is exactly the reading error the score table exists
   * to prevent.
   */
  redName: string;
  blueName: string;
}

export interface SeriesView {
  firstName: string;
  secondName: string;
  /** "5½" and "½" — the two row totals, in the order the rows are drawn. */
  firstTotal: string;
  secondTotal: string;
  games: SeriesGameView[];
  /** Every game that ended with somebody walking away, in playing order. */
  abandoned: SeriesGameView[];
  /** How many of the run's games have a result. */
  played: number;
  /**
   * How many games this run will play in total, or null once it will not play
   * any more.
   *
   * Null for a finished or abandoned run, and that is the point. A run stopped
   * after three games did not play three of six; it played three. The pairs it
   * never started were never written down — the server records a game when it
   * begins — so describing them would mean inventing them, and a row of empty
   * columns reads as games that were lost rather than games that never were.
   */
  planned: number | null;
}

const sideOf = (result: string): SeriesSide => {
  if (result === 'first_win') return 'first';
  if (result === 'second_win') return 'second';
  if (result === 'draw') return 'draw';
  return 'pending';
};

/** A point, no point, or half of one, from one bot's side of a game. */
const POINTS: Record<SeriesSide, [string, string]> = {
  first: ['1', '0'],
  second: ['0', '1'],
  draw: ['½', '½'],
  pending: ['·', '·'],
};

/** "5½", "½", "3" — halves written as halves rather than as .5. */
const formatPoints = (points: number) => {
  const whole = Math.floor(points);
  const half = points - whole >= 0.5;
  if (!half) return String(whole);
  return whole === 0 ? '½' : `${whole}½`;
};

/**
 * A run, ready to draw.
 *
 * The names fall back to the bot ids' absence rather than to an empty string:
 * an engine whose account was deleted leaves a run behind with no name on that
 * side, and "beat" reads better than "beat ".
 */
export const seriesView = (series: BotSeries): SeriesView => {
  const firstName = series.firstBotName || 'First bot';
  const secondName = series.secondBotName || 'Second bot';
  const games = (series.games ?? []).map((game): SeriesGameView => {
    const side = sideOf(game.result);
    // Whoever did not win is whoever walked away. A game can only end in
    // abandonment against somebody, so a draw by abandonment is not a state the
    // server can produce and is not one this has to describe.
    const abandonedBy =
      game.endReason === 'abandonment'
        ? side === 'first'
          ? secondName
          : side === 'second'
            ? firstName
            : null
        : null;
    const winner = side === 'first' ? firstName : side === 'second' ? secondName : null;
    const reason = endReasonPhrase(game.endReason);
    const label = abandonedBy
      ? `Game ${game.gameNumber}: ${abandonedBy} abandoned`
      : side === 'pending'
        ? `Game ${game.gameNumber}: not played yet`
        : winner
          ? `Game ${game.gameNumber}: ${winner} won${reason ? ` by ${reason}` : ''}`
          : `Game ${game.gameNumber}: drawn${reason ? ` by ${reason}` : ''}`;
    const [firstPoints, secondPoints] = POINTS[side];
    return {
      game,
      number: game.gameNumber,
      side,
      firstPoints,
      secondPoints,
      abandonedBy,
      label,
      gameId: game.gameId || null,
      redName: game.swapped ? secondName : firstName,
      blueName: game.swapped ? firstName : secondName,
    };
  });

  const running = String(series.status).toLowerCase() === 'running';
  return {
    firstName,
    secondName,
    // The stored tally rather than a count of the rows above: the two are the
    // same number written by the same transaction, and the tally is the one the
    // rest of the site reads.
    firstTotal: formatPoints(series.firstWins + series.draws / 2),
    secondTotal: formatPoints(series.secondWins + series.draws / 2),
    games,
    abandoned: games.filter((entry) => entry.abandonedBy !== null),
    played: games.filter((entry) => entry.side !== 'pending').length,
    planned: running ? series.pairs * 2 : null,
  };
};

/**
 * A result read off the board, in the form a run stores results in.
 *
 * A run's results are always written from the first bot's point of view,
 * whichever seat it held — see the note at the top of this file — and a board
 * only knows who won as a colour. `firstIsRed` is the fact that joins them, and
 * it rides along on the live row of every series game for exactly this reason.
 *
 * Here rather than at the one call site because getting it backwards is
 * invisible: the strip would simply award the point to the wrong engine, and it
 * would look right half the time, because the seats swap every game.
 */
export const watchedOutcome = (
  winner: PlayerColor,
  firstIsRed: boolean,
): BotSeriesResult => {
  if (winner !== 'Red' && winner !== 'Blue') return 'draw';
  const firstWon = firstIsRed === (winner === 'Red');
  return firstWon ? 'first_win' : 'second_win';
};

/**
 * A run with a result the watcher has just seen happen, filled in.
 *
 * The server files a series result *after* it broadcasts the game's final
 * position, so the strip over a spectated board is asked to redraw at the one
 * moment the archive does not agree with the screen: the column of the game
 * that just ended still reads `pending`, and the two totals are a point short.
 * Refetching does not reliably fix it — the fetch is racing a database write
 * and usually wins.
 *
 * Nobody watching needs the archive for this. They saw who won. So the result
 * is written in here, in the stored shape, by the one module that knows what
 * that shape means: reading `swapped` at a call site to work out whose point it
 * was is the exact mistake the score table was built to prevent.
 *
 * Nothing already scored is touched, and the totals move with the column, so
 * this cannot disagree with itself. The refetch behind it is what it defers to.
 */
export const withWatchedResult = (
  series: BotSeries,
  watched: { gameId: string; outcome: BotSeriesResult; endReason?: string } | null,
): BotSeries => {
  if (!watched?.gameId) return series;
  const games = series.games ?? [];
  const index = games.findIndex((game) => game.gameId === watched.gameId);
  if (index < 0) return series;
  const played = games[index];
  if (sideOf(String(played.result)) !== 'pending') return series;
  const scored = [...games];
  scored[index] = {
    ...played,
    result: watched.outcome,
    endReason: watched.endReason ?? played.endReason,
  };
  return {
    ...series,
    games: scored,
    firstWins: series.firstWins + (watched.outcome === 'first_win' ? 1 : 0),
    secondWins: series.secondWins + (watched.outcome === 'second_win' ? 1 : 0),
    draws: series.draws + (watched.outcome === 'draw' ? 1 : 0),
  };
};

/**
 * A run with the game being played right now given a column, when the archive
 * does not have one for it yet.
 *
 * The other half of the same timing problem. A run records its next game after
 * that game has already started and been announced, so between those two
 * moments the strip has a live board it cannot draw: the finished column has
 * its point, and the live mark is nowhere, because the game wearing it has no
 * column to wear it on.
 *
 * Taken from the lobby's live row rather than worked out, which is what keeps
 * this from becoming a second implementation of how a run seats its engines:
 * the row says which seat the first bot is in, and that is the same fact
 * `swapped` records. Only the pair number is arithmetic, and nothing drawn
 * reads it.
 */
export const withLiveGame = (
  series: BotSeries,
  live: { gameId: string; gameNumber: number; firstIsRed: boolean } | null,
): BotSeries => {
  if (!live?.gameId || live.gameNumber <= 0) return series;
  const games = series.games ?? [];
  if (games.some((game) => game.gameId === live.gameId)) return series;
  const row: BotSeriesGame = {
    gameNumber: live.gameNumber,
    pairNumber: Math.ceil(live.gameNumber / 2),
    swapped: !live.firstIsRed,
    gameId: live.gameId,
    result: 'pending',
  };
  return {
    ...series,
    // Sorted, because a column's place in the strip is its playing order, and a
    // row appended to the end would be in the right place only by luck.
    games: [...games, row].sort((left, right) => left.gameNumber - right.gameNumber),
  };
};

/**
 * Whether there is anything behind this game yet.
 *
 * A column with no result is one of two things and they are not the same: a
 * board two engines are on this second, or the game a stopped run was in the
 * middle of. The first is worth watching; the second cannot be opened at all —
 * no archived record exists, so sending anybody to its review lands them on
 * "this game cannot be reviewed". Only the live list can tell them apart, which
 * is why it is an argument.
 *
 * Written once because two surfaces answer it: the score table decides whether
 * a column is pressable, and the run's own page decides whether a row offers a
 * link. Those two disagreeing would mean a page offering an address that the
 * table beside it knows is empty.
 */
export const seriesGameIsOpen = (entry: SeriesGameView, live: boolean): boolean =>
  Boolean(entry.gameId) && (entry.side !== 'pending' || live);

/**
 * Whether a game is one of this run's, and so shares everything a run shares.
 *
 * Asked about the *live* game by the review screen, which is a different
 * question from "is this the game on screen". Every game of a series shares one
 * chat room — that is the point of the room outliving its board — so somebody
 * who steps back to game two while game five is being played has not left the
 * conversation, and hiding the chat there would tell them they had.
 */
export const seriesContains = (
  series: BotSeries | null | undefined,
  gameId: string | null | undefined,
): boolean =>
  Boolean(gameId) && (series?.games ?? []).some((game) => game.gameId === gameId);

/**
 * How a run's state reads, and in what colour.
 *
 * Here rather than in the card that first needed it, because three surfaces now
 * badge the same word — the card in the feed, the run's own page, and anything
 * that lists runs next — and a run that is LIVE green in one place and grey in
 * the next is two runs to a reader.
 */
export const seriesStatusTone = (series: BotSeries): BadgeTone => {
  const tones: Record<string, BadgeTone> = { running: 'live', completed: 'accent' };
  return tones[String(series.status).toLowerCase()] ?? 'neutral';
};

/** "3 pairs · casual · 1+1 · started by ada" — a run's provenance. */
export const seriesMetaLine = (series: BotSeries) => {
  // A run still going says what it set out to play; one that stopped early says
  // what it played. Advertising four pairs on a card showing one game is the
  // same invention as drawing seven empty columns beside it.
  const played = (series.games ?? []).filter((game) => game.result !== 'pending').length;
  const parts =
    String(series.status).toLowerCase() === 'running'
      ? [`${series.pairs} pair${series.pairs === 1 ? '' : 's'}`]
      : [`${played} game${played === 1 ? '' : 's'}`];
  // Before the settings, because it is not one: it says whether the run counted
  // for anything, which is the first thing somebody reading a scoreline wants
  // and the reason a lopsided one may have moved nothing on the ladder.
  if (series.casual) parts.push('casual');
  if (series.openingPlies > 0) parts.push(`${series.openingPlies} opening plies`);
  // The clock in the notation the rest of the app writes it in, rather than a
  // minute count. A run can be played at 0.1+1, and rounding that to minutes
  // rounds it away entirely — which drops the one number that decides what its
  // result is worth. A row with no clock on it stays quiet.
  if (series.initialTimeMs > 0) parts.push(timeControlLabel(series));
  if (series.requestedByName) parts.push(`started by ${series.requestedByName}`);
  return parts.join(' · ');
};
