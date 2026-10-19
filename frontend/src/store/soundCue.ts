import { create } from 'zustand';

import type { GameSound } from '@/appearance/gameSound';

// A sound asked for by a board the store does not hold.
//
// Every game sound is worked out by comparing the store's game before and after
// a change — see `hooks/useGameSounds` — which is right for every board that is
// a game. A lesson is not one: its position lives in its own screen and never
// reaches the store, so there is nothing there to compare. It names the sound
// it wants here instead, and the same players play it, in the pack the player
// chose, primed the same way for a browser.

interface SoundCueState {
  /** The last sound asked for. `serial` makes asking twice two events. */
  cue: { sound: GameSound; serial: number } | null;
}

export const useSoundCue = create<SoundCueState>()(() => ({ cue: null }));

let serial = 0;

/** Play one game sound now. */
export const cueGameSound = (sound: GameSound) => {
  serial += 1;
  useSoundCue.setState({ cue: { sound, serial } });
};
