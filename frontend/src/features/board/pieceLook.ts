// How one piece kind is drawn.
//
// Lives here rather than in the rules engine because drawing is the board's
// business: `PieceIcon` resolves `art` to a bundled image, and falls back to a
// disc carrying the symbol when there is nothing to draw. A kind with no look at
// all is the ordinary case for a built-in mode.

export interface PieceLook {
  symbol: string;
  /** A bundled artwork name. */
  art?: string;
}
