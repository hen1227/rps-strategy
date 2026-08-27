// What the board is told to paint, for a position whose distances are obvious.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { gridFromRows, type PositionLike } from '@/engine/analysisGame';
import { buildReachOverlay } from './reachOverlay';
import { DEFAULT_REACH_SETTINGS, type ReachSettings } from './settings';
import type { OverlayCell } from '@/features/board/overlay';
import { reach } from '@/theme';
import { testMode } from '@/testing/modes';
import { BOARD_SIZE, type SideColor } from '@/types/game';

const V3 = testMode('V3');
const V5 = testMode('V5');

const EMPTY_ROWS = Array.from({ length: BOARD_SIZE }, () => '.'.repeat(BOARD_SIZE));

const rowsWith = (...places: [x: number, y: number, symbol: string][]) => {
  const rows = [...EMPTY_ROWS];
  for (const [x, y, symbol] of places) {
    rows[y] = rows[y].slice(0, x) + symbol + rows[y].slice(x + 1);
  }
  return rows;
};

const position = (
  places: [x: number, y: number, symbol: string][],
  currentTurn: SideColor = 'Red',
): PositionLike => ({
  grid: gridFromRows(rowsWith(...places)),
  currentTurn,
  mode: V3,
  moveNumber: 0,
});

const settings = (overrides: Partial<ReachSettings> = {}): ReachSettings => ({
  ...DEFAULT_REACH_SETTINGS,
  enabled: true,
  // A lone rock has no run to draw over the bands unless a test asks for one.
  showPath: false,
  showDanger: false,
  ...overrides,
});

/** One rock in the middle, nothing else, so every distance is Chebyshev. */
const LONE_ROCK: [x: number, y: number, symbol: string][] = [[4, 4, 'r']];

const cellAt = (
  result: ReturnType<typeof buildReachOverlay>,
  x: number,
  y: number,
): OverlayCell | null => result.overlay?.cells[y][x] ?? null;

/** What a square's corner says, as one string: `'R3'`, or `'R3 P4 S5'`. */
const noteAt = (
  result: ReturnType<typeof buildReachOverlay>,
  x: number,
  y: number,
): string | undefined =>
  cellAt(result, x, y)?.labels?.map((entry) => entry.text).join(' ');

describe('buildReachOverlay', () => {
  it('draws nothing when it is switched off or has no goal row to aim at', () => {
    assert.equal(buildReachOverlay(position(LONE_ROCK), settings({ enabled: false })).overlay, null);
    assert.equal(
      buildReachOverlay({ ...position(LONE_ROCK), mode: V5 }, settings()).overlay,
      null,
    );
    assert.equal(buildReachOverlay(null, settings()).overlay, null);
  });

  it('numbers each square with the moves it takes to stand on it', () => {
    const result = buildReachOverlay(position(LONE_ROCK), settings({ maxMoves: 0 }));

    // The letter is the piece, not the side: this is a rock, so `R`.
    assert.equal(noteAt(result, 4, 4), 'R0');
    assert.equal(noteAt(result, 5, 3), 'R1');
    assert.equal(noteAt(result, 7, 4), 'R3');
    assert.equal(noteAt(result, 0, 0), 'R4');
    assert.equal(noteAt(result, 8, 8), 'R4');
  });

  it('rings the frontier and fades what lies past it', () => {
    const result = buildReachOverlay(
      position(LONE_ROCK),
      settings({ maxMoves: 2, showFrontier: true, dimBeyond: true }),
    );

    assert.equal(cellAt(result, 4, 2)?.ring, reach.frontierRing, 'exactly two away');
    assert.equal(cellAt(result, 4, 3)?.ring, undefined, 'one away is inside the frontier');
    assert.equal(cellAt(result, 4, 2)?.dim, false);
    assert.equal(cellAt(result, 4, 1)?.dim, true, 'three away, still drawn but pushed back');
  });

  it('drops what lies past the frontier when it is not asked to fade it', () => {
    const result = buildReachOverlay(
      position(LONE_ROCK),
      settings({ maxMoves: 2, dimBeyond: false }),
    );

    assert.ok(cellAt(result, 4, 2), 'two away is drawn');
    assert.equal(cellAt(result, 4, 1), null, 'three away is not there at all');
  });

  it('leaves the numbers off when asked', () => {
    const result = buildReachOverlay(
      position(LONE_ROCK),
      settings({ maxMoves: 0, showNumbers: false }),
    );

    assert.equal(cellAt(result, 4, 4)?.labels, undefined);
    assert.ok(cellAt(result, 4, 4)?.fill, 'the wash stays');
  });

  it('measures a piece that is not on the board', () => {
    const result = buildReachOverlay(
      position([]),
      settings({ maxMoves: 0, ghost: { at: { x: 2, y: 6 }, piece: 'Rock', owner: 'Red' } }),
    );

    assert.deepEqual(result.focus?.from, { x: 2, y: 6 });
    assert.equal(result.focus?.piece, 'Rock');
    assert.equal(cellAt(result, 2, 6)?.ring, reach.ghostRing, 'and says it is only a guess');
    assert.equal(noteAt(result, 2, 3), 'R3');
    assert.equal(result.focusReading?.blockedDistance, 6, 'six ranks from Red’s goal');
  });

  it('gives a contested square to whoever is quicker, and marks a dead heat', () => {
    // A red rock on a1 and a blue rock on i1: the middle file is a tie.
    const result = buildReachOverlay(
      position([[0, 0, 'r'], [8, 0, 'R']]),
      settings({ view: 'contest', maxMoves: 0 }),
    );

    assert.equal(cellAt(result, 1, 0)?.describe, 'Red first in 1, with a Rock');
    assert.equal(cellAt(result, 7, 0)?.describe, 'Blue first in 1, with a Rock');
    assert.equal(cellAt(result, 4, 0)?.describe, 'contested in 4');
    assert.equal(cellAt(result, 4, 0)?.fill, reach.contestedTie);
    // One line per side, Red's first, each in that side's colour.
    assert.equal(noteAt(result, 4, 0), 'R4 R4');
    assert.notEqual(
      cellAt(result, 4, 0)?.labels?.[0]?.color,
      cellAt(result, 4, 0)?.labels?.[1]?.color,
      'which is which is carried by the colour, since both read R4',
    );
  });

  it('draws the run it found, step by step', () => {
    const result = buildReachOverlay(
      position([[4, 4, 'r']]),
      settings({ view: 'run', maxMoves: 0 }),
    );

    const run = result.focusReading?.safeRun;
    assert.ok(run);
    assert.equal(run.moves, 4);
    for (const [step, square] of run.path.entries()) {
      const cell = cellAt(result, square.x, square.y);
      assert.equal(cell?.fill, reach.path, `step ${step} is on the path`);
      assert.equal(cell?.labels?.[0]?.text, String(step), 'a run step is a bare number');
      assert.equal(cell?.dim, false, 'a square of the run is never faded out');
    }
  });

  it('washes the squares a predator owns, and rings the one that cuts the run', () => {
    // The blue paper on e3 sits directly in front of the red rock on e5.
    const result = buildReachOverlay(
      position([[4, 4, 'r'], [4, 2, 'P']]),
      settings({ view: 'threat', maxMoves: 0, showDanger: true }),
    );

    assert.equal(cellAt(result, 4, 3)?.fill, reach.danger, 'e4 is the paper’s in one');
    assert.ok(result.focusReading?.cutOff, 'and the quick route dies on it');
    const cut = result.focusReading?.cutOff?.at;
    assert.ok(cut);
    assert.equal(cellAt(result, cut.x, cut.y)?.ring, reach.dangerRing);
  });

  it('puts the hunter’s number under the runner’s in the threat view', () => {
    // The comparison the whole tool is for, on one square: this rock is on e4
    // after one move, and the paper that takes rocks is also one move away.
    const result = buildReachOverlay(
      position([[4, 4, 'r'], [4, 2, 'P']]),
      settings({ view: 'threat', maxMoves: 0 }),
    );

    assert.equal(noteAt(result, 4, 3), 'R1 P1');
    assert.equal(noteAt(result, 4, 4), 'R0 P2', 'and where it stands now');
    assert.equal(
      cellAt(result, 4, 3)?.labels?.[1]?.color,
      reach.hunterOnDark,
      'the hunter’s line is in the hunter’s colour, toned for this square',
    );
  });

  it('follows the tapped square, and stops following once it is pinned elsewhere', () => {
    const board = position([[4, 4, 'r'], [1, 7, 'r']]);

    const tapped = buildReachOverlay(board, settings({ focus: { x: 1, y: 7 } }));
    assert.deepEqual(tapped.focus?.from, { x: 1, y: 7 });

    const empty = buildReachOverlay(board, settings({ focus: { x: 0, y: 0 } }));
    assert.ok(empty.focus, 'an empty square falls back rather than blanking the tool');
    assert.equal(empty.focus?.owner, 'Red');
  });

  it('reads the turn off the position unless a tempo is forced', () => {
    const places: [x: number, y: number, symbol: string][] = [[4, 4, 'r'], [2, 4, 'R']];

    const following = buildReachOverlay(position(places, 'Blue'), settings());
    assert.equal(following.analysis?.verdict.toMove, 'Blue');
    assert.equal(following.analysis?.verdict.winner, 'Blue');

    const forced = buildReachOverlay(position(places, 'Blue'), settings({ tempo: 'Red' }));
    assert.equal(forced.analysis?.verdict.toMove, 'Red');
    assert.equal(forced.analysis?.verdict.winner, 'Red');
  });

  it('keeps one piece’s danger and cut-off off the contest map', () => {
    // A contest map answers "who owns this square". The focused rock's own
    // survival is a different question and must not be drawn over the answer.
    const places: [x: number, y: number, symbol: string][] = [[4, 4, 'r'], [4, 2, 'P']];
    const loud = settings({ maxMoves: 0, showDanger: true, showPath: true });

    const onPiece = buildReachOverlay(position(places), loud);
    assert.equal(cellAt(onPiece, 4, 3)?.fill, reach.danger, 'the piece view says it plainly');

    const onContest = buildReachOverlay(position(places), { ...loud, view: 'contest' });
    assert.notEqual(cellAt(onContest, 4, 3)?.fill, reach.danger);
    assert.equal(cellAt(onContest, 4, 3)?.ring, undefined, 'and no cut-off ring either');
  });

  it('counts only the kinds it was asked about', () => {
    // A red rock on the far rank and a red scissors in the near corner. Only
    // one of them is anywhere near b2.
    const places: [x: number, y: number, symbol: string][] = [[4, 8, 'r'], [0, 0, 's']];

    const everything = buildReachOverlay(
      position(places),
      settings({ view: 'side', maxMoves: 0, kind: 'all' }),
    );
    const rocksOnly = buildReachOverlay(
      position(places),
      settings({ view: 'side', maxMoves: 0, kind: 'Rock' }),
    );

    // Rock, Paper, Scissors order, whichever is nearer: a square that always
    // lists its kinds in the same order is one you can read across a board.
    assert.equal(noteAt(everything, 1, 1), 'R7 S1', 'both kinds, each with its own number');
    assert.equal(noteAt(rocksOnly, 1, 1), 'R7', 'without the scissors, only the rock');
  });
});
