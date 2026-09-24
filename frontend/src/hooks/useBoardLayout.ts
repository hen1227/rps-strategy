import { useWindowDimensions } from 'react-native';

import { useSettled } from '@/hooks/useSettled';
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
 * A build has no window, so the first client render reports no size either and
 * the real one arrives a render later. See `useSettled` for why.
 */
const useSettledDimensions = () => {
  const dimensions = useWindowDimensions();
  return useSettled() ? dimensions : { height: 0, width: 0 };
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
  /**
   * Vertical space taken by headers and player bars on a wide screen.
   *
   * The estimate, and only that: it is what paints the first frame, before
   * anything has been measured. Prefer `maxHeight` on any screen that can
   * measure the room it actually has.
   */
  chrome?: number;
  /**
   * Extra vertical space on a wide screen, for anything under the board.
   *
   * Part of the same subtraction as `chrome`, so `maxHeight` supersedes it too.
   */
  below?: number;
  /**
   * The tallest the board may be drawn on a wide screen, measured rather than
   * counted from the window.
   *
   * `height - chrome - below` is the same figure arrived at by subtraction, and
   * the subtraction is the fragile half: it asks a screen to know the height of
   * every header, rail, banner and safe area standing over its board, and
   * getting one of them wrong does not shrink the board. It pushes the foot of
   * the layout past the bottom of the window — and a wide layout, which has
   * nowhere to scroll to, simply loses whatever was down there. That is how a
   * two-line deploy banner took the clock and the chat's composer off the watch
   * screen.
   *
   * A caller that can measure the container its board competes inside should
   * pass that measurement instead, less whatever else is in the container. Then
   * everything above the board is accounted for by not being in the number.
   */
  maxHeight?: number;
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
  /** Size a scrollable narrow board by width, without reserving viewport height. */
  narrowFit?: 'viewport' | 'width';
  /**
   * Horizontal space taken by the page's padding and by anything drawn *beside*
   * the board on a narrow screen.
   *
   * The default is the analysis screen's, which is where this number started
   * life: its board shares a row with the eval bar, so it owes that bar's width
   * and the gap on top of the page padding. Every other screen inherited the
   * allowance along with the expression, and the ones with nothing beside the
   * board — the live game — were paying about 38px for a bar they do not draw.
   * On a phone the board is bounded by width and nothing else, so that was 38px
   * straight off the board's edge and about 4px off every tile.
   */
  narrowMargin?: number;
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
 * Narrow screens stack and use the width minus margins. By default they also
 * reserve room within the viewport height; scrollable views can opt out with
 * `narrowFit: 'width'`. Wide screens leave room for the panels beside the board,
 * either measured (`maxHeight`) or counted (`chrome`).
 */
export const useBoardLayout = ({
  sidePanel = 440,
  chrome = 112,
  below = 0,
  maxHeight,
  narrowHeightShare = 0.5,
  narrowChrome,
  narrowFit = 'viewport',
  narrowMargin = 58,
  minimum = 230,
}: BoardLayoutOptions = {}): BoardLayout => {
  const { height, width } = useSettledDimensions();
  const isWide = width >= WIDE_LAYOUT_WIDTH && width > height;

  const boardSize = Math.floor(
    Math.max(
      minimum,
      Math.min(
        MAX_BOARD,
        isWide ? width - sidePanel : width - narrowMargin,
        isWide
          ? maxHeight ?? height - chrome - below
          : narrowFit === 'width'
            ? MAX_BOARD
            : narrowChrome === undefined
              ? height * narrowHeightShare
              : height - narrowChrome,
      ),
    ),
  );

  return { boardSize, isWide, width, height };
};
