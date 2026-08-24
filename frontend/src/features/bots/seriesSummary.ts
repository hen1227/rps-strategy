import { endReasonPhrase } from '@/features/game/resultLabels';
import type { BotSeries, BotSeriesGame } from '@/store/api/bots';

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

/** "3 pairs · 3 opening plies · 1 min · started by ada" — a run's provenance. */
export const seriesMetaLine = (series: BotSeries) => {
  // A run still going says what it set out to play; one that stopped early says
  // what it played. Advertising four pairs on a card showing one game is the
  // same invention as drawing seven empty columns beside it.
  const played = (series.games ?? []).filter((game) => game.result !== 'pending').length;
  const parts =
    String(series.status).toLowerCase() === 'running'
      ? [`${series.pairs} pair${series.pairs === 1 ? '' : 's'}`]
      : [`${played} game${played === 1 ? '' : 's'}`];
  if (series.openingPlies > 0) parts.push(`${series.openingPlies} opening plies`);
  const minutes = Math.round(series.initialTimeMs / 60000);
  if (minutes > 0) parts.push(`${minutes} min`);
  if (series.requestedByName) parts.push(`started by ${series.requestedByName}`);
  return parts.join(' · ');
};
