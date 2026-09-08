// Is this the same position as one we have seen before?
//
// One answer, in its own module, because two of them would be two answers to
// the same question — and because the hand-written rules and the spec
// interpreter both need it, and neither should have to import the other to get
// it.
//
// Nothing draws on a repeated position at the moment (see `./modeRules`), so
// the threefold rule this was written for is switched off rather than gone. The
// key is still built for every position reached, and still has to be the same
// key the server would build, for the day it is switched back on. That import would be a cycle: `interpret.ts` already reads
// `analysisGame.ts` for the shape of a game.
//
// What counts is exactly what decides legal play: what stands where, whose it
// is, who owns the ground, and the side to move. Clocks, move numbers, draw
// offers and player names deliberately do not — the same rule
// `positionForRepetition` follows in `backend/internal/game/game.go`.

import type { Grid, PlayerColor } from '@/types/game';

export const positionKey = (grid: Grid, currentTurn: PlayerColor): string =>
  JSON.stringify([
    currentTurn,
    grid.map((row) => row.map((tile) => [tile.occupant, tile.occupantOwner, tile.ownerColor])),
  ]);
