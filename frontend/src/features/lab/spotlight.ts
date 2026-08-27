// Where the agent is pointing, as something the board can draw.
//
// `Board` already takes an overlay and paints it — a wash, a ring, a corner
// note, per square, in board coordinates so it survives a flipped view. So the
// agent pointing at a square needs no new board machinery at all: it needs this,
// which turns "d4, e4, and every Lizard" into cells.
//
// Deliberately plain views all the way down. The board's overlay layer is
// `View`s, and it must stay that way — an `<Svg>` laid over the board swallows
// every touch on Fabric, which would make the agent pointing at a square the
// thing that stopped anybody tapping it.

import { emptyOverlayCells, type BoardOverlay } from '@/features/board/overlay';
import { colors } from '@/theme';
import type { Grid } from '@/types/game';
import type { LabSpotlight } from '@/store/labSession';

/**
 * The overlay for a spotlight, or nothing when it points at no squares.
 *
 * A spotlight naming only a rule (`win[1]`) has nothing to say about the board,
 * and answering with an all-null overlay would be a legend on an empty
 * decoration — the inspector rings that row instead.
 */
export const spotlightOverlay = (
  spotlight: LabSpotlight | null,
  grid: Grid,
): BoardOverlay | null => {
  if (!spotlight) return null;
  const height = grid.length;
  const width = grid[0]?.length ?? 0;
  if (height === 0 || width === 0) return null;

  const cells = emptyOverlayCells(width, height);
  let marked = 0;

  const mark = (x: number, y: number) => {
    if (y < 0 || y >= height || x < 0 || x >= width) return;
    if (cells[y]![x]) return;
    cells[y]![x] = {
      ring: colors.accentBright,
      fill: colors.accentSurface,
      describe: spotlight.note || 'the agent is pointing here',
    };
    marked += 1;
  };

  for (const square of spotlight.squares) mark(square.x, square.y);

  if (spotlight.piece) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (grid[y]?.[x]?.occupant === spotlight.piece) mark(x, y);
      }
    }
  }

  if (marked === 0) return null;
  return { cells, legend: spotlight.note || 'The agent is pointing at part of the board.' };
};
