import type { ImageSourcePropType } from 'react-native';

import type { SideColor } from '@/types/game';

// Which artwork a piece is drawn from.
//
// Data only, and deliberately: this file is reached by every screen through the
// appearance store, so it holds the artwork and nothing that draws it.
//
// The `require`s below are static because Metro cannot resolve a dynamic path.
// That is the one hard constraint on this whole feature: a set has to be in the
// bundle, which is why the catalogue is curated rather than open — and why each
// set gets its own folder under `assets/pieces/`, named the same six ways, so
// that adding one is six lines that read identically to the six above them.

export interface PieceSet {
  id: string;
  name: string;
  blurb: string;
  /** Bundled artwork, per side, keyed by the artwork's own name. */
  raster: Record<SideColor, Record<string, ImageSourcePropType | undefined>>;
}

export const PIECE_SETS: readonly PieceSet[] = [
  {
    id: 'classic',
    name: 'Classic',
    blurb: "Original painted pieces.",
    raster: {
      Blue: {
        rock: require('../../assets/pieces/classic/blue_rock.png'),
        paper: require('../../assets/pieces/classic/blue_paper.png'),
        scissors: require('../../assets/pieces/classic/blue_scissors.png'),
      },
      Red: {
        rock: require('../../assets/pieces/classic/red_rock.png'),
        paper: require('../../assets/pieces/classic/red_paper.png'),
        scissors: require('../../assets/pieces/classic/red_scissors.png'),
      },
    },
  },
  {
    id: 'drawn',
    name: 'Drawn',
    blurb: 'Heavy outlines and flat colour.',
    raster: {
      Blue: {
        rock: require('../../assets/pieces/drawn/blue_rock.png'),
        paper: require('../../assets/pieces/drawn/blue_paper.png'),
        scissors: require('../../assets/pieces/drawn/blue_scissors.png'),
      },
      Red: {
        rock: require('../../assets/pieces/drawn/red_rock.png'),
        paper: require('../../assets/pieces/drawn/red_paper.png'),
        scissors: require('../../assets/pieces/drawn/red_scissors.png'),
      },
    },
  },
];

export const DEFAULT_PIECE_SET_ID = 'classic';

/** The set with this id, or the default. An id from a later build is unknown here. */
export const pieceSetById = (id: string | null | undefined): PieceSet =>
  PIECE_SETS.find((set) => set.id === id) ?? PIECE_SETS[0]!;
