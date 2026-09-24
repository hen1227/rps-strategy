// A board, copied off a screen and pasted back in.
//
// Two claims under test. The first is that the copy says which mode it is: a
// bare FEN cannot, because V5, V3 and V6 are all played on the same nine by
// nine board, so the smallest thing worth handing round is a record rather than
// a position. The second is that it says nothing else — a mode where ownership
// decides nothing does not get a field of ownership, and that field is not
// merely redundant there, it is wrong: a tile a piece has left keeps its
// colour, so by the second move it describes where the pieces used to be.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyAnalysisMove, createAnalysisGame, type AnalysisGame } from '@/engine/analysisGame';
import { reviewSourceFromPGN } from '@/engine/gameReview';
import {
  decodePosition,
  encodePosition,
  encodePositionPGN,
  parsePGN,
  startingRowsFrom,
} from '@/engine/pgn';
import { ALL_TEST_MODES, testMode } from '@/testing/modes';
import { modeHasFeature, type ModeDefinition } from '@/types/game';

/** The FEN a record carries, which is the whole of what a position record says. */
const fenOf = (pgn: string) => parsePGN(pgn).tag('FEN');

/** Play `count` legal moves from the opening, so the board is not a fresh one. */
const playedOut = (mode: ModeDefinition, count: number): AnalysisGame => {
  let game = createAnalysisGame(mode);
  for (let played = 0; played < count; played += 1) {
    const next = game.grid
      .flat()
      .filter((tile) => tile.occupantOwner === game.currentTurn)
      .flatMap((tile) =>
        [-1, 0, 1].flatMap((dy) =>
          [-1, 0, 1].map((dx) => ({
            from: { x: tile.x, y: tile.y },
            to: { x: tile.x + dx, y: tile.y + dy },
          })),
        ),
      )
      .map((move) => applyAnalysisMove(game, move.from, move.to))
      .find((applied) => applied !== null);
    assert.ok(next, `move ${played + 1} should have been playable`);
    game = next.game;
  }
  return game;
};

test('a mode with territory writes the field, and one without leaves it off', () => {
  for (const mode of ALL_TEST_MODES) {
    const fields = fenOf(encodePositionPGN(playedOut(mode, 3))).split(' ');
    assert.equal(
      fields.length,
      modeHasFeature(mode, 'territory') ? 3 : 2,
      `${mode.name} should write ${modeHasFeature(mode, 'territory') ? 'three' : 'two'} fields`,
    );
  }
});

test('the field left off is the one that had drifted from the pieces', () => {
  // The reason it is left off rather than merely allowed to be. Three moves
  // into Intransitive, the ownership the board is still carrying describes
  // where the pieces started rather than where they are, because a tile a piece
  // leaves keeps its colour and no rule in the mode ever reads it back.
  const game = playedOut(testMode('V6'), 3);
  const copied = fenOf(encodePositionPGN(game));
  assert.equal(copied.split(' ').length, 2, 'the copy leaves the field off');

  // Reading the copy back is what "ownership follows the pieces" means, so
  // writing *that* board out in full is the field the pieces imply. It differs
  // from the one the copy dropped, which is the whole of the claim: what was
  // dropped was stale, not redundant.
  const followed = decodePosition(copied);
  assert.notEqual(
    encodePosition(followed.grid, followed.currentTurn),
    encodePosition(game.grid, game.currentTurn),
    'this test would prove nothing if ownership had not drifted from the pieces',
  );
});

test('a copied position reads back as the same board, in the same mode', () => {
  for (const mode of ALL_TEST_MODES) {
    const game = playedOut(mode, 5);
    const source = reviewSourceFromPGN(encodePositionPGN(game), ALL_TEST_MODES.slice());
    const read = source.positions[0];
    assert.ok(read, `${mode.name} should decode to a position`);
    assert.equal(source.mode.id, mode.id, `${mode.name} should say which mode it is`);
    assert.equal(source.moves.length, 0, 'a position has no moves');
    assert.deepEqual(
      startingRowsFrom(read.grid),
      startingRowsFrom(game.grid),
      `${mode.name} should read back the same pieces`,
    );
    assert.equal(read.currentTurn, game.currentTurn, `${mode.name} should keep the side to move`);
  }
});

test('territory survives the round trip in the mode that decides games on it', () => {
  // Total War's own reason for the field: a tile claimed by a piece that has
  // since moved on is still that player's, and losing it would change who is
  // winning.
  const game = playedOut(testMode('V5'), 4);
  const { grid } = decodePosition(fenOf(encodePositionPGN(game)));
  assert.deepEqual(
    grid.map((row) => row.map((tile) => tile.ownerColor)),
    game.grid.map((row) => row.map((tile) => tile.ownerColor)),
  );
});

test('a position with no territory field lets ownership follow the pieces', () => {
  const game = playedOut(testMode('V6'), 3);
  const { grid } = decodePosition(fenOf(encodePositionPGN(game)));
  for (const row of grid) {
    for (const tile of row) {
      assert.equal(
        tile.ownerColor,
        tile.occupantOwner,
        `${tile.x},${tile.y} should be owned by whoever stands on it, and nobody otherwise`,
      );
    }
  }
});
