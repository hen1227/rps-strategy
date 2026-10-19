import type { Piece } from '@/types/game';

/**
 * Which sound a transition calls for.
 *
 * Its own file so that `soundPacks.ts` and `hooks/useGameSounds.tsx` can both
 * name these without one importing the other: the hook builds the players from
 * a pack, and the pack is chosen by a store the hook reads.
 */
export type GameSound =
  | 'end'
  | 'illegal'
  | 'moveOpponent'
  | 'moveSelf'
  | 'notify'
  | 'paperTakesRock'
  | 'rockTakesScissors'
  | 'scissorsTakesPaper'
  | 'start';

// A capture is named for the piece that made it, not the piece that fell,
// because `canCapture` is a strict cycle — rock takes scissors, scissors takes
// paper, paper takes rock, in every mode — so the piece removed from the board
// names its taker exactly. The lookup is still keyed by the victim, which is
// what a comparison of two boards can actually see.
const CAPTURE_SOUND_BY_VICTIM: Partial<Record<Piece, GameSound>> = {
  Paper: 'scissorsTakesPaper',
  Rock: 'paperTakesRock',
  Scissors: 'rockTakesScissors',
};

/** The sound of `victim` being taken, or null for a kind with no clip of its own. */
export const captureSoundFor = (victim: Piece): GameSound | null =>
  CAPTURE_SOUND_BY_VICTIM[victim] ?? null;
