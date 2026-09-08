// The reach tool's settings, for every screen that hosts it.
//
// A slice of the one store rather than screen state, for the reason the tool
// exists at all: the game screen and the analysis board are two views of the
// same question, and a board you had set to "threat, three moves, friends move
// aside" should still be set that way when you carry the position across. It
// holds no game state — only what the viewer has asked to be shown.

import type { StateCreator } from 'zustand';

import type { GameStore } from './types';
import { DEFAULT_REACH_SETTINGS, type GhostPiece, type ReachSettings } from '@/features/reach/settings';
import type { Position } from '@/types/game';

export interface ReachState {
  reach: ReachSettings;
}

export interface ReachActions {
  /** Change any subset of the settings. */
  setReachSettings: (patch: Partial<ReachSettings>) => void;
  /** Show or hide the whole overlay. */
  toggleReach: () => void;
  /**
   * Point the single-piece views at a square.
   *
   * Ignored while pinned, which is how a board stops following taps once you
   * have found the piece you actually wanted to study.
   */
  setReachFocus: (position: Position | null) => void;
  setReachGhost: (ghost: GhostPiece | null) => void;
  resetReachSettings: () => void;
}

export type ReachSlice = ReachState & ReachActions;

export const initialReachState: ReachState = { reach: DEFAULT_REACH_SETTINGS };

export const createReachSlice: StateCreator<GameStore, [], [], ReachSlice> = (set, get) => ({
  ...initialReachState,

  setReachSettings: (patch) => set({ reach: { ...get().reach, ...patch } }),

  toggleReach: () => set({ reach: { ...get().reach, enabled: !get().reach.enabled } }),

  setReachFocus: (position) => {
    const settings = get().reach;
    if (!settings.enabled || settings.pinned) return;
    set({ reach: { ...settings, focus: position } });
  },

  setReachGhost: (ghost) =>
    set({ reach: { ...get().reach, ghost, placingGhost: false } }),

  resetReachSettings: () =>
    // Keep it on screen: resetting the knobs is not the same as putting the
    // tool away, and having it vanish would mean two presses to get it back.
    set({ reach: { ...DEFAULT_REACH_SETTINGS, enabled: get().reach.enabled } }),
});
