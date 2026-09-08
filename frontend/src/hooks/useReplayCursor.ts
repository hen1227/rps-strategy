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
  /**
   * Which line this is — a game id, a record id, anything comparable.
   *
   * Changing it puts a following viewer back at the end, because a different
   * game is not a position they chose to be standing in. Without it, stepping
   * from a game that had three moves to one already at move thirty left the
   * cursor on move three of a board it did not describe.
   *
   * Only read when `follow` is set; a review opens at the first move of
   * whatever it is given.
   */
  lineId?: unknown;
  /** Called after every move of the cursor, to drop a stale selection. */
  onChange?: () => void;
}

export const useReplayCursor = ({
  length,
  follow = false,
  keyboard = true,
  lineId,
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

  // Three jobs, all about the line underneath the cursor changing.
  //
  // Counted from zero rather than from the length this mounted with, so that
  // "the line has only just arrived" is true on the first run whether the game
  // was already in the store or turned up a render later.
  const previousLength = useRef(0);
  const previousLine = useRef(lineId);
  useEffect(() => {
    const previous = previousLength.current;
    const sameLine = previousLine.current === lineId;
    previousLength.current = length;
    previousLine.current = lineId;
    if (length === 0) return;
    // A line the viewer has never stood in: it has only just arrived, or it is
    // a different game than the one they were looking at. Either way, where the
    // cursor happens to be is not a place anybody chose.
    //
    // This is what somebody who presses WATCH on a game at move thirteen needs.
    // Without it the cursor stayed at zero and they were shown the opening
    // position of a game they had asked to see live, under a card telling them
    // the game had moved on. Only for a follower: a review opens at the first
    // move on purpose.
    if (follow && (previous === 0 || !sameLine)) {
      goTo(length - 1);
      return;
    }
    // A watched game pulls along a viewer who is already at the end of it.
    if (length > previous && follow && cursorRef.current >= length - 2) {
      goTo(length - 1);
      return;
    }
    // And any line that has shrunk past the cursor pulls it back inside.
    if (cursorRef.current > length - 1) goTo(length - 1);
  }, [follow, goTo, length, lineId]);

  useReplayKeyboard({
    enabled: keyboard,
    onFirst: goToFirst,
    onLast: goToLast,
    onNext: stepForward,
    onPrevious: stepBack,
  });

  return { cursor, lastIndex, atLiveEdge, goTo, stepBack, stepForward, goToFirst, goToLast };
};
