import { useCallback, useEffect, useRef, useState } from 'react';

import { useReplayKeyboard } from './useReplayKeyboard';

// Where along a line of positions the viewer is standing.
//
// The review and the bot battle both need this, and both need the same three
// awkward details that a plain `useState` does not give them:
//
//   1. The cursor is clamped to a line whose length changes underneath it. A
//      battle grows while it is being watched; a record shrinks when a
//      different game is loaded.
//   2. Stepping is driven from a ref as well as from state, so a keyboard
//      repeat or a timer that fires twice before React re-renders still moves
//      two steps rather than one.
//   3. A viewer sitting at the live edge should stay there as the line grows,
//      while a viewer who has stepped back should stay where they are.

export interface ReplayCursor {
  /** The position currently on screen, as an index into the line. */
  cursor: number;
  /** The last index of the line. */
  lastIndex: number;
  atLiveEdge: boolean;
  goTo: (index: number) => void;
  stepBack: () => void;
  stepForward: () => void;
  goToFirst: () => void;
  goToLast: () => void;
}

export interface ReplayCursorOptions {
  /** How many positions the line has. */
  length: number;
  /**
   * Follow the end of the line as it grows, for a game being watched. Only
   * applies while the viewer is already at the live edge.
   */
  follow?: boolean;
  /** Bind the arrow keys, Home and End. */
  keyboard?: boolean;
  /** Called after every move of the cursor, to drop a stale selection. */
  onChange?: () => void;
}

export const useReplayCursor = ({
  length,
  follow = false,
  keyboard = true,
  onChange,
}: ReplayCursorOptions): ReplayCursor => {
  const [cursor, setCursor] = useState(0);
  const cursorRef = useRef(0);
  const lastIndex = Math.max(0, length - 1);

  const goTo = useCallback(
    (index: number) => {
      const bounded = Math.max(0, Math.min(index, Math.max(0, length - 1)));
      cursorRef.current = bounded;
      setCursor(bounded);
      onChange?.();
    },
    [length, onChange],
  );

  // Stepping reads the ref rather than the rendered value, so two steps that
  // arrive in one frame are two steps.
  const stepBack = useCallback(() => goTo(cursorRef.current - 1), [goTo]);
  const stepForward = useCallback(() => goTo(cursorRef.current + 1), [goTo]);
  const goToFirst = useCallback(() => goTo(0), [goTo]);
  const goToLast = useCallback(() => goTo(length - 1), [goTo, length]);

  const atLiveEdge = cursor >= lastIndex;

  // Two different jobs, both about the line changing length. A watched game
  // pulls a viewer who is already at the end along with it; any line that
  // shrinks past the cursor pulls the cursor back into it.
  const previousLength = useRef(length);
  useEffect(() => {
    const grew = length > previousLength.current;
    previousLength.current = length;
    if (length === 0) return;
    if (grew && follow && cursorRef.current >= length - 2) {
      goTo(length - 1);
      return;
    }
    if (cursorRef.current > length - 1) goTo(length - 1);
  }, [follow, goTo, length]);

  useReplayKeyboard({
    enabled: keyboard,
    onFirst: goToFirst,
    onLast: goToLast,
    onNext: stepForward,
    onPrevious: stepBack,
  });

  return { cursor, lastIndex, atLiveEdge, goTo, stepBack, stepForward, goToFirst, goToLast };
};
