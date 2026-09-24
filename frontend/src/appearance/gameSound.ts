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
