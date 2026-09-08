// What may be painted on a square, and nothing about why.
//
// The board draws marks it owns — the goal rank, a selection, the last move —
// from its own rules. This is the other kind: a decoration some analysis worked
// out, handed over already finished. `Board` reads the cells and paints them;
// it never learns what the numbers mean.
//
// Keeping the contract this dumb is what lets one overlay serve the reach maps
// in `features/reach/` today and whatever wants a wash next, on the live board
// and on a lobby thumbnail, without either side importing the other.


/** One line of a square's corner note. Two or three characters; there is no room for more. */
export interface OverlayLabel {
  text: string;
  color?: string;
}

/** One square's decoration. Every field is optional; `null` means leave it alone. */
export interface OverlayCell {
  /** A wash over the tile, drawn under the pieces and under the board's own marks. */
  fill?: string;
  /** An outline inside the tile — a frontier, or a square on a path. */
  ring?: string;
  /**
   * Up to three lines stacked in the corner.
   *
   * A list rather than one string because a square can be several things at
   * once — a rock's distance and a paper's, each in its own colour — and
   * because three short lines read where one long one wraps.
   */
  labels?: OverlayLabel[];
  /** Pushed back rather than hidden: still there, plainly not part of the answer. */
  dim?: boolean;
  /** Appended to the square's accessibility label, so the overlay is readable aloud. */
  describe?: string;
}

/**
 * A decoration for every square, indexed `[y][x]` in *board* coordinates.
 *
 * Board coordinates, not drawn ones: `Board` flips the grid once for a Blue
 * viewer and the tiles keep their true `x`/`y`, so an overlay built here needs
 * to know nothing about which way round the board is being looked at.
 */
export interface BoardOverlay {
  cells: (OverlayCell | null)[][];
  /** One line describing the whole overlay, for the board's accessibility label. */
  legend?: string;
}

export const emptyOverlayCells = (
  columns: number,
  rows: number,
): (OverlayCell | null)[][] =>
  Array.from({ length: rows }, () => new Array<OverlayCell | null>(columns).fill(null));

export const overlayCellAt = (
  overlay: BoardOverlay | null | undefined,
  x: number,
  y: number,
): OverlayCell | null => overlay?.cells[y]?.[x] ?? null;
