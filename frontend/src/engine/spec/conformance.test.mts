// Replay the conformance corpus through this interpreter.
//
// The corpus is the contract between the two implementations of the rule
// language — this one and `backend/internal/game/spec`. Both suites replay the
// same file and have to reach the same positions, so a disagreement is a failing
// test in two languages rather than a player being told their legal move is
// illegal.
//
// This side is the recorder, so it passing proves only that the file matches the
// interpreter that wrote it. That is still worth having: it is what catches a
// change to the interpreter that nobody meant to make, and it is what fails when
// somebody edits the corpus by hand.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import corpus from '@/engine/spec/conformance/corpus.json' with { type: 'json' };
import {
  alphabetOf,
  createAnalysisGame,
  squareLabel,
  startingPositionFromGrid,
  type AnalysisGame,
} from '@/engine/analysisGame';
import { modeDefinitionFor, specAllMoves, specApplyMove } from '@/engine/spec/interpret';
import { validateSpec } from '@/engine/spec/validate';
import type { RuleSpec } from '@/engine/spec/types';
import type { Grid, Position } from '@/types/game';

const specs = corpus.specs as unknown as Record<string, RuleSpec>;

const territory = (grid: Grid) =>
  grid
    .map((row) =>
      row
        .map((tile) => (tile.ownerColor === 'Red' ? 'r' : tile.ownerColor === 'Blue' ? 'b' : '.'))
        .join(''),
    )
    .join('/');

const snapshot = (game: AnalysisGame) => ({
  rows: startingPositionFromGrid(game.grid, alphabetOf(game.mode)).rows.join('/'),
  territory: territory(game.grid),
  turn: game.currentTurn,
  moveNumber: game.moveNumber,
  status: game.status,
  winner: game.winner,
  endReason: game.endReason ?? null,
});

const moveName = (move: { from: Position; to: Position }) =>
  `${squareLabel(move.from)}-${squareLabel(move.to)}`;

/** `d7-c6` back into two coordinates. Files are letters, ranks are numbers. */
const parseMove = (text: string) => {
  const [from, to] = text.split('-');
  const square = (name: string | undefined): Position => {
    const file = name?.charCodeAt(0) ?? 0;
    return { x: file - 'a'.charCodeAt(0), y: Number(name?.slice(1)) - 1 };
  };
  return { from: square(from), to: square(to) };
};

test('every spec in the corpus is valid', () => {
  for (const [name, spec] of Object.entries(specs)) {
    const report = validateSpec(spec);
    assert.deepEqual(report.errors, [], `${name}: ${JSON.stringify(report.errors)}`);
  }
});

test('the corpus covers the endings, not just the openings', () => {
  const reasons = new Set(
    corpus.games
      .map((game) => game.checks.at(-1)?.after)
      .filter((after) => after && after.status !== 'InProgress')
      .map((after) => after?.endReason),
  );
  // A corpus of openings would pin the easy half of the language and none of the
  // half where a mode's own rules live.
  assert.ok(reasons.size >= 4, `only ${reasons.size} kinds of ending: ${[...reasons].join(', ')}`);
  assert.ok(reasons.has('repetition'), 'repetition is the one ending a lone position cannot show');
});

for (const game of corpus.games) {
  test(`${game.spec} seed ${game.seed} replays exactly`, () => {
    const spec = specs[game.spec];
    assert.ok(spec, `the corpus names a spec it does not carry: ${game.spec}`);
    const mode = modeDefinitionFor(spec, `corpus-${game.spec}`);
    let position = createAnalysisGame(mode);
    const checks = new Map(game.checks.map((check) => [check.ply, check]));

    const moves = game.moves ? game.moves.split(' ') : [];
    moves.forEach((text, ply) => {
      const check = checks.get(ply);
      if (check) {
        const legal = specAllMoves(spec, position).map(moveName).sort().join(' ');
        assert.equal(legal, check.legalMoves, `${game.spec} seed ${game.seed} ply ${ply}: legal moves`);
      }
      const { from, to } = parseMove(text);
      const played = specApplyMove(spec, position, from, to);
      assert.ok(played, `${game.spec} seed ${game.seed} ply ${ply}: ${text} was refused`);
      position = played.game;
      if (check) {
        assert.deepEqual(
          snapshot(position),
          check.after,
          `${game.spec} seed ${game.seed} ply ${ply}: position after ${text}`,
        );
      }
    });
  });
}
