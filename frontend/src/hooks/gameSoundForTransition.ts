import { captureSoundFor, type GameSound } from '@/appearance/gameSound';
import { captureBetweenGrids } from '@/engine/captureMatchup';
import type { ActiveGame } from '@/store/types';
import type { PlayerColor } from '@/types/game';

// Which sound a change of game state calls for.
//
// Its own file, apart from the players in `useGameSounds`, so that it can be
// tested: that file needs expo-audio, which does not load outside an app.
//
// A capture is named for the throw that won it — rock takes scissors, scissors
// takes paper, paper takes rock. Which piece fell is read off the two boards by
// `captureBetweenGrids`, the same reading the board's capture effect makes, and
// `captureSoundFor` names the clip from it, as a lesson does. One reading is what
// keeps the clip and the picture in step. The search this replaced found the
// square that emptied, which is the taker's, and named the clip from the taker:
// every capture played the clip of the matchup after it in the cycle.

const captureSoundForTransition = (
  previous: ActiveGame,
  next: ActiveGame,
): GameSound | null => {
  const capture = captureBetweenGrids(previous.grid, next.grid);
  return capture ? captureSoundFor(capture.victim.piece) : null;
};

export const getGameSoundForTransition = (
  previous: ActiveGame | null | undefined,
  next: ActiveGame | null | undefined,
  playerColor: PlayerColor | null,
): GameSound | null => {
  if (!next) return null;

  // A game we have not seen before is either one that is just beginning or one
  // being rejoined, and those want different things said. An untouched board is
  // the only reliable way to tell them apart from here.
  if (!previous || previous.gameId !== next.gameId) {
    return next.moveNumber === 0 ? 'start' : 'notify';
  }

  if (next.moveNumber <= previous.moveNumber) {
    const didTimeOut = previous.status === 'InProgress' && next.status === 'Finished';
    return didTimeOut ? 'end' : null;
  }

  // Every ending sounds the same now. Reaching the goal used to be told apart
  // from the other endings, which is worth restoring if a second ending clip
  // ever exists: the test was `endReason === 'infiltration' || 'corner'`.
  if (next.status === 'Finished') return 'end';

  const captureSound = captureSoundForTransition(previous, next);
  if (captureSound) return captureSound;

  // Every move at a shared board was made by the hand on this device, so there
  // is no opponent's move to tell apart. Without this the whole game would play
  // in the opponent's voice, `playerColor` being nobody's there.
  if (next.local) return 'moveSelf';
  return previous.currentTurn === playerColor ? 'moveSelf' : 'moveOpponent';
};
