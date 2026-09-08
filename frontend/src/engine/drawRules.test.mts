// What ends a game that neither side is winning, in the browser's copy of the
// rules: two hundred plies — a hundred moves each — with nothing taken, and —
// since the switch in `./modeRules` is off — not a repeated position.
//
// Both are engine-level rather than per-mode, so both are checked across all
// three modes at once: the bug they guard against is one mode being adjudicated
// under another's answer, which is what happened while Intransitive was the one
// mode without a repetition draw.
//
// The server's own tests are `TestRepeatingAPositionIsPlayInEveryMode` and
// `TestAHundredMovesWithNoCaptureIsADraw` in `backend/internal/game`. These
// exist because the review, the analysis board and every bot game adjudicate
// here instead, and a disagreement between the two shows up as a replay that
// ends on a different move from the game it is replaying.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { applyAnalysisMove, createAnalysisGame } from './analysisGame';
import { QUIET_PLY_LIMIT } from './modeRules';
import { ALL_TEST_MODES, testMode } from '@/testing/modes';
import type { AnalysisGame } from './analysisGame';
import type { Position } from '@/types/game';

/** Play a move, insisting it was legal. */
const play = (game: AnalysisGame, from: Position, to: Position): AnalysisGame => {
  const applied = applyAnalysisMove(game, from, to);
  assert.ok(applied, `expected ${from.x},${from.y}-${to.x},${to.y} to be legal`);
  return applied.game;
};

/**
 * One piece per side that can step onto an empty square and back, as the four
 * moves that do it.
 *
 * Read off the board rather than written down: the three modes open from three
 * different layouts and neither rule under test is about any of them.
 */
const shuffle = (game: AnalysisGame): [Position, Position][] => {
  const stepFor = (owner: 'Red' | 'Blue'): [Position, Position] => {
    for (const row of game.grid) {
      for (const tile of row) {
        if (tile.occupantOwner !== owner) continue;
        for (const [dx, dy] of [
          [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1],
        ]) {
          const to = { x: tile.x + dx, y: tile.y + dy };
          const step = game.grid[to.y]?.[to.x];
          if (step && step.occupant === 'Empty') return [{ x: tile.x, y: tile.y }, to];
        }
      }
    }
    throw new Error(`no piece of ${owner}'s can step onto an empty square`);
  };
  // Blue opens, so Blue's step is first and the return leg follows in the same
  // order — the four together put the board back where they found it.
  const [blueFrom, blueTo] = stepFor('Blue');
  const [redFrom, redTo] = stepFor('Red');
  return [
    [blueFrom, blueTo],
    [redFrom, redTo],
    [blueTo, blueFrom],
    [redTo, redFrom],
  ];
};

describe('repeating a position', () => {
  for (const mode of ALL_TEST_MODES) {
    it(`is play in ${mode.name}`, () => {
      let game = createAnalysisGame(mode);
      const cycle = shuffle(game);
      // Four laps, so the position reaches a fourth occurrence and not merely a
      // third: a rule that fired one lap late would pass a test that stopped at
      // three. Total War needs the extra lap anyway — its first one claims the
      // tiles it walks over, so the board the second starts from is not the one
      // the first did.
      for (let lap = 0; lap < 4; lap += 1) {
        for (const [index, [from, to]] of cycle.entries()) {
          assert.equal(
            game.status,
            'InProgress',
            `ended on lap ${lap} move ${index} as ${game.endReason}`,
          );
          game = play(game, from, to);
        }
      }
      assert.equal(game.status, 'InProgress');
      assert.equal(game.endReason, null);
    });
  }
});

/**
 * Two pieces with room to walk, and nothing else on the board.
 *
 * Each side walks a loop — Blue an eight, Red a seven — rather than shuffling on
 * two squares, so the board only comes back to a position it has been in twice
 * before after 4 x lcm(8, 7) = 224 plies. That is past the limit, which means
 * this test says the same thing about the two-hundredth quiet ply whether or
 * not the repetition draw in `./modeRules` is switched on. On a two-square
 * shuffle a third occurrence would land on ply eight and this test would be
 * about the wrong rule.
 *
 * The two loops sit in the middle of the board, clear of Infiltration's home
 * ranks and Intransitive's corners, so no mode's win condition fires on one,
 * and five files apart, so the pieces never come near each other.
 */
const WALKING_ROOM = [
  '.........',
  '.........',
  '.........',
  '.R....r..',
  '.........',
  '.........',
  '.........',
  '.........',
  '.........',
];

/** Blue's eight-square loop and Red's seven, as the squares each steps through. */
const BLUE_LOOP: Position[] = [
  { x: 1, y: 3 }, { x: 2, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 4 },
  { x: 3, y: 5 }, { x: 2, y: 5 }, { x: 1, y: 5 }, { x: 1, y: 4 },
];
const RED_LOOP: Position[] = [
  { x: 6, y: 3 }, { x: 7, y: 3 }, { x: 8, y: 3 }, { x: 8, y: 4 },
  { x: 8, y: 5 }, { x: 7, y: 5 }, { x: 6, y: 4 },
];

describe(`${QUIET_PLY_LIMIT} plies with no capture`, () => {
  for (const mode of ALL_TEST_MODES) {
    it(`is a draw in ${mode.name}`, () => {
      let game = createAnalysisGame(
        testMode(mode.id, { startingPosition: { rows: [...WALKING_ROOM] } }),
      );
      // Blue opens, so an even ply is Blue's step and an odd one Red's, each
      // moving on one square of its own loop.
      for (let ply = 0; ply < QUIET_PLY_LIMIT; ply += 1) {
        assert.equal(game.status, 'InProgress', `ended after ${ply} quiet plies`);
        assert.equal(game.quietPlies, ply);
        const loop = ply % 2 === 0 ? BLUE_LOOP : RED_LOOP;
        const step = Math.floor(ply / 2) % loop.length;
        const applied = applyAnalysisMove(game, loop[step]!, loop[(step + 1) % loop.length]!);
        assert.ok(applied, `ply ${ply} of the walk was refused`);
        assert.equal(applied.captured, false, 'the walk must take nothing');
        game = applied.game;
      }
      assert.equal(game.quietPlies, QUIET_PLY_LIMIT);
      assert.equal(game.status, 'Finished');
      assert.equal(game.endReason, 'no_capture');
      assert.equal(game.winner, 'Neutral');
    });
  }
});
