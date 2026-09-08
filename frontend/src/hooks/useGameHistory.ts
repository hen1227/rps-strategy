import { useMemo } from 'react';

import type { AnalysisGame } from '@/engine/analysisGame';
import {
  reviewSourceFromPGN,
  summarizeReview,
  type RecordedMove,
  type ReviewMove,
} from '@/engine/gameReview';
import { useGameStore } from '@/store/gameStore';
import type { ActiveGame } from '@/store/types';

// The game on the board, as a line of positions somebody can step through.
//
// A board is a position and nothing else. That was all a live game ever had
// here: the socket sends whole snapshots and never the moves between them, so
// the two people who had seen least of the game — a spectator who arrived at
// move twenty, and a player who refreshed — were also the two with no way to
// look back at it. The server carries the record now (`ServerMessage.PGN`), and
// this is the one place it is read.
//
// Deliberately the review's own replay rather than a lighter one written for a
// live board. `reviewSourceFromPGN` runs the rules to produce every position,
// which is what makes a move list beside a live game and the review of that
// same game afterwards agree by construction. The alternative — a second
// replay, kept simple because it is "only for a list" — is how the same game
// comes to read two different ways on two screens.

/** A game's history as the move list and the replay controls need it. */
export interface GameHistory {
  /**
   * Every position from the start of the game to the last move played, so
   * `positions[n]` is the board after `n` moves and the length is one more than
   * the move count.
   */
  positions: AnalysisGame[];
  /**
   * The moves between them, notatable and listable.
   *
   * All ungraded: nothing here evaluates anything, and the list draws a plain
   * pip where a review would put a grade. Folded through `summarizeReview`
   * with no entries rather than mapped by hand, so a live list and a review's
   * list are the same shape from the same code.
   */
  moves: ReviewMove<RecordedMove>[];
  /** Opening moves that were dealt rather than chosen, from the BookPlies tag. */
  bookPlies: number;
  /**
   * Whether there is a history to show.
   *
   * False for a game whose record never arrived, and for one this client cannot
   * replay. Both mean the same thing to a screen: draw the board, and no panel.
   */
  available: boolean;
}

const EMPTY: GameHistory = { positions: [], moves: [], bookPlies: 0, available: false };

export const useGameHistory = (gameState: ActiveGame | null): GameHistory => {
  const modes = useGameStore((state) => state.modes);
  const livePGN = useGameStore((state) => state.livePGN);
  const botGamePGN = useGameStore((state) => state.botGamePGN);
  const localGamePGN = useGameStore((state) => state.localGamePGN);
  // The move counts of the two games this browser plays by itself. They are
  // what says such a game has moved on: the encoders are stable functions, so
  // nothing else here would notice a move being played.
  const botHistoryLength = useGameStore((state) => state.botHistory.length);
  const localHistoryLength = useGameStore((state) => state.localHistory.length);

  const gameId = gameState?.gameId ?? null;
  const isBot = Boolean(gameState?.bot);
  const isLocal = Boolean(gameState?.local);

  // Three games, one record. A bot game and a pass-and-play game never reach
  // the server, so they write their own from the moves this browser kept —
  // which the review screen has always read them back from, in this same
  // format.
  const pgn = useMemo(() => {
    if (!gameId) return null;
    if (isBot) return botGamePGN();
    if (isLocal) return localGamePGN();
    return livePGN;
  }, [
    botGamePGN,
    botHistoryLength,
    gameId,
    isBot,
    isLocal,
    livePGN,
    localGamePGN,
    localHistoryLength,
  ]);

  return useMemo(() => {
    if (!pgn) return EMPTY;
    try {
      const source = reviewSourceFromPGN(pgn, modes);
      return {
        positions: source.positions,
        moves: summarizeReview({ source, entries: [], bookPlies: source.bookPlies }).moves,
        bookPlies: source.bookPlies,
        available: source.positions.length > 0,
      };
    } catch {
      // A record this client cannot replay has no list in it either. The board
      // underneath is the thing somebody came to look at, so the panel is
      // simply not drawn — an error message over a live game would be a worse
      // answer than a game with no move list.
      //
      // Reached in one ordinary case as well as the unusual ones: the mode
      // catalogue arrives over its own connection, and until it does there is
      // no mode to replay against. The next render with modes in it succeeds.
      return EMPTY;
    }
  }, [modes, pgn]);
};

export default useGameHistory;
