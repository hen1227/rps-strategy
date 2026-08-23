import { create } from 'zustand';

// How much chrome the shell has stacked along the bottom edge.
//
// `TournamentCallout` floats above every page and has to clear whatever is down
// there, which on a phone inside the shell is the tab bar and the live summary
// bar, and on every other page is nothing. Two screens used to hard-code a
// guess at this — 96 in the lobby, 88 on the board — and a guess goes stale the
// moment the chrome changes height. The shell measures it instead and publishes
// it here, and a page outside the shell simply never sets it.

interface BottomInsetState {
  /** Pixels of chrome along the bottom edge, or 0 when there is none. */
  bottomInset: number;
  setBottomInset: (inset: number) => void;
}

export const useBottomInset = create<BottomInsetState>((set) => ({
  bottomInset: 0,
  setBottomInset: (bottomInset) =>
    // Guarded because the shell reports this from a layout callback, which fires
    // on every resize whether the height changed or not.
    set((state) => (state.bottomInset === bottomInset ? state : { bottomInset })),
}));
