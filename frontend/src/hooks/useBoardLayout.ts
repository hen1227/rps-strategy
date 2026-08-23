import { useEffect, useState } from 'react';
import { useWindowDimensions } from 'react-native';

import { WIDE_LAYOUT_WIDTH } from '@/theme';

// How big the board is, in one place.
//
// Four screens used to compute this themselves, with four hand-tuned copies of
// the same expression and four slightly different constants — 220 or 230 for
// the floor, 430 or 440 or 455 for the side-panel allowance. The differences
// were not decisions; they were the residue of copying. What actually differs
// between the screens is how much room their panels need, so that is the only
// thing a caller passes.

/**
 * The viewport, or nothing until the browser has one.
 *
 * Every page of this site is pre-rendered in Node at build time, where there is
 * no window at all. If the first render in the browser used the real dimensions
 * while the pre-rendered HTML used none, the two would disagree and React would
 * throw the whole pre-rendered page away as a hydration mismatch — so the first
 * client render deliberately matches the server, and the real size arrives one
 * render later.
 */
const useSettledDimensions = () => {
  const dimensions = useWindowDimensions();
  const [settled, setSettled] = useState(false);
  useEffect(() => setSettled(true), []);
  return settled ? dimensions : { height: 0, width: 0 };
};

/**
 * Wide enough for two columns.
 *
 * For pages with no board on them. They care only about width, which is why a
 * tall, narrow-ish desktop window still gets the two-column lobby.
 */
export const useWideScreen = () => useSettledDimensions().width >= WIDE_LAYOUT_WIDTH;

/**
 * Wide enough to put panels *beside a board*.
 *
 * Stricter than `useWideScreen`, and deliberately: a board is square, so a
 * portrait window has the width for two columns and nowhere to put the board.
 */
export const useWideLayout = () => {
  const { height, width } = useSettledDimensions();
  return width >= WIDE_LAYOUT_WIDTH && width > height;
};

/** No board is drawn larger than this, however much room there is. */
const MAX_BOARD = 620;

/** Room the board must leave for the chrome around it. */
export interface BoardLayoutOptions {
  /**
   * Horizontal space taken by side panels on a wide screen — the panel column
   * plus the gap and the eval bar. Screens with a wider column pass more.
   */
  sidePanel?: number;
  /** Vertical space taken by headers and player bars on a wide screen. */
  chrome?: number;
  /** Extra vertical space on a wide screen, for anything under the board. */
  below?: number;
  /**
   * Share of the viewport height the board may take on a narrow screen, where
   * everything stacks and the board competes with the panels below it.
   */
  narrowHeightShare?: number;
  /**
   * Fixed vertical space to leave on a narrow screen, instead of a share of the
   * height. The live board uses this: it has a player bar above and below and
   * its controls underneath, so what it can spare is a measurement rather than
   * a proportion.
   */
  narrowChrome?: number;
  /**
   * The smallest the board may be drawn. Per screen because it was measured per
   * screen: the live board can go smaller than the analysis board because it
   * has no move list to sit beside.
   */
  minimum?: number;
}

export interface BoardLayout {
  boardSize: number;
  isWide: boolean;
  width: number;
  height: number;
}

/**
 * The board's edge length for this viewport.
 *
 * Narrow screens stack, so the board is bounded by a share of the height and
 * the full width minus its margins. Wide screens put panels beside it, so it
 * is bounded by what those panels leave.
 */
export const useBoardLayout = ({
  sidePanel = 440,
  chrome = 112,
  below = 0,
  narrowHeightShare = 0.5,
  narrowChrome,
  minimum = 230,
}: BoardLayoutOptions = {}): BoardLayout => {
  const { height, width } = useSettledDimensions();
  const isWide = width >= WIDE_LAYOUT_WIDTH && width > height;

  const boardSize = Math.floor(
    Math.max(
      minimum,
      Math.min(
        MAX_BOARD,
        isWide ? width - sidePanel : width - 58,
        isWide
          ? height - chrome - below
          : narrowChrome === undefined
            ? height * narrowHeightShare
            : height - narrowChrome,
      ),
    ),
  );

  return { boardSize, isWide, width, height };
};
