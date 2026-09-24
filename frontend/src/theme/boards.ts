import type { BoardSpec } from './spec';

// The squares themselves, as an axis of their own.
//
// Separate from the theme because "which board" and "light or dark app" are
// different questions, and because every one of these has to work under every
// theme: the marks the board draws on top — the selection, the last move, an
// annotation — are alpha washes chosen to read on a light square and a dark one
// alike, so a preset that is light-on-light or dark-on-dark breaks them. Each
// pair here keeps a clear step between its two squares for that reason.

export const BOARDS: readonly BoardSpec[] = [
  {
    id: 'forest',
    name: 'Forest',
    blurb: 'Sand and green. The original.',
    lightTile: '#d7c5a3',
    darkTile: '#337533',
    frame: '#171613',
    labelOnLight: '#8a6512',
    labelOnDark: '#d7c5a3',
    ink: '#171613',
    paper: '#ffffff',
  },
  {
    id: 'walnut',
    name: 'Walnut',
    blurb: "Classic cream and brown.",
    lightTile: '#e8d6b8',
    darkTile: '#9b6a43',
    frame: '#2b1f15',
    labelOnLight: '#7a5320',
    labelOnDark: '#e8d6b8',
    ink: '#241a11',
    paper: '#fff6e8',
  },
  {
    id: 'slate',
    name: 'Slate',
    blurb: "Cool grey squares.",
    lightTile: '#cdd2d8',
    darkTile: '#5d6b7a',
    frame: '#1b1f24',
    labelOnLight: '#54606e',
    labelOnDark: '#cdd2d8',
    ink: '#14181d',
    paper: '#ffffff',
  },
  {
    id: 'ice',
    name: 'Ice',
    blurb: 'Pale blues. The lightest board here.',
    lightTile: '#e3ecf4',
    darkTile: '#7aa0c4',
    frame: '#243746',
    labelOnLight: '#3f6688',
    labelOnDark: '#e3ecf4',
    ink: '#16242f',
    paper: '#ffffff',
  },
  {
    id: 'ink',
    name: 'Ink',
    blurb: "High-contrast white and black.",
    lightTile: '#efece4',
    darkTile: '#3c3b38',
    frame: '#0d0d0c',
    labelOnLight: '#55524a',
    labelOnDark: '#efece4',
    ink: '#0d0d0c',
    paper: '#ffffff',
  },
];

export const DEFAULT_BOARD_ID = 'forest';

/** The board with this id, or the default. An id from a later build is unknown here. */
export const boardById = (id: string | null | undefined): BoardSpec =>
  BOARDS.find((board) => board.id === id) ?? BOARDS[0]!;
