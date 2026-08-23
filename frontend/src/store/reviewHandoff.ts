import { create } from 'zustand';

import type { PlayerColor } from '@/types/game';

// A record handed to the review screen by the screen the player came from.
//
// Most reviews are opened by game id and fetch the record from the archive,
// which is why `/review?gameId=…` is a real, shareable address. Two are not: a
// bot game never reached the server, and a pasted record was never on it. Both
// have the text and nothing else.
//
// A PGN is far too long for a URL, so it travels here instead. Deliberately not
// persisted: a handed-over record belongs to the navigation that carried it, and
// a stale one surviving a page reload would show the wrong game.

export interface ReviewHandoff {
  pgn: string;
  /** Which side the person reviewing was playing, when that is known. */
  playerColor: PlayerColor | null;
}

interface ReviewHandoffStore {
  handoff: ReviewHandoff | null;
  /** Hand a record over, to be picked up by the review screen. */
  hand: (handoff: ReviewHandoff) => void;
  /** Take the record, clearing it so a later visit does not see it again. */
  take: () => ReviewHandoff | null;
}

export const useReviewHandoff = create<ReviewHandoffStore>()((set, get) => ({
  handoff: null,
  hand: (handoff) => set({ handoff }),
  take: () => {
    const { handoff } = get();
    if (handoff) set({ handoff: null });
    return handoff;
  },
}));
