// The two shipped modes, played twice: once through the hand-written rules in
// `analysisGame.ts`, and once through the interpreter reading the same modes
// written as specs.
//
// This is the test that decides whether the rule language is real. A format that
// cannot express the games this project already ships would be a format that
// quietly failed on somebody's first invention instead — and a disagreement here
// is the interpreter being wrong about a game whose right answers are already
// written down, which is much cheaper to find than one about a game nobody has
// played yet.
//
// The games are seeded, so a failure names a seed and a ply and can be replayed
// exactly.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  allValidMoves,
  alphabetOf,
  applyAnalysisMove,
  createAnalysisGame,
  createAnalysisGameFrom,
  gridFromRows,
  moveLabel,
  squareLabel,
  startingPositionFromGrid,
  validMovesFor,
  type AnalysisGame,
} from '@/engine/analysisGame';
import { createSeededRandom } from '@/engine/bots/engine';
import { INFILTRATION_SPEC, TOTAL_WAR_SPEC } from '@/engine/spec/builtin';
import { modeDefinitionFor, specAllMoves, specApplyMove, specMovesFor } from '@/engine/spec/interpret';
import type { RuleSpec } from '@/engine/spec/types';
import type { Grid, Move, SideColor } from '@/types/game';

/** A move as one comparable string, so a mismatch reads as squares. */
const moveKey = ({ from, to }: Move) => `${squareLabel(from)}-${squareLabel(to)}`;
const sortedKeys = (moves: Move[]) => moves.map(moveKey).sort();

/** Every visible fact about a position, as one string. */
const describe = (game: AnalysisGame) =>
  [
    startingPositionFromGrid(game.grid, alphabetOf(game.mode)).rows.join('/'),
    game.grid.flat().map((tile) => tile.ownerColor.charAt(0)).join(''),
    game.currentTurn,
    game.status,
    game.winner,
    game.endReason ?? '-',
    String(game.moveNumber),
  ].join(' | ');

const territoryOf = (grid: Grid) =>
  grid.flat().map((tile) => tile.ownerColor).join(',');

interface Divergence {
  seed: number;
  ply: number;
  detail: string;
}

/**
 * Play one seeded game through both implementations, comparing at every ply.
 *
 * Returns the first divergence rather than throwing, so the caller can report
 * the seed and the move that produced it.
 */
const playBoth = (spec: RuleSpec, modeId: string, seed: number): Divergence | null => {
  const nativeMode = createAnalysisGame(modeDefinitionFor(spec, modeId)).mode;
  // The native path is driven by the mode id it already knows; the spec path by
  // the spec. Same starting position either way, so any difference after this is
  // a difference in the rules.
  let native = createAnalysisGame({ ...nativeMode, spec: undefined });
  let specGame = createAnalysisGame(modeDefinitionFor(spec, modeId));
  const random = createSeededRandom(seed);

  // A random Total War walk almost never finishes, so the cap is about how far
  // the two have to agree rather than about reaching an ending. The endings get
  // their own tests below, from positions built to reach them.
  for (let ply = 0; ply < 200; ply += 1) {
    const nativeState = describe(native);
    const specState = describe(specGame);
    if (nativeState !== specState) {
      return { seed, ply, detail: `position differs\n  native: ${nativeState}\n  spec:   ${specState}` };
    }
    if (territoryOf(native.grid) !== territoryOf(specGame.grid)) {
      return { seed, ply, detail: 'territory differs' };
    }
    if (native.status !== 'InProgress') return null;

    const nativeMoves = allValidMoves(native);
    const specMoves = specAllMoves(spec, specGame).map(({ from, to }) => ({ from, to }));
    const nativeKeys = sortedKeys(nativeMoves);
    const specKeys = sortedKeys(specMoves);
    if (nativeKeys.join(' ') !== specKeys.join(' ')) {
      const onlyNative = nativeKeys.filter((key) => !specKeys.includes(key));
      const onlySpec = specKeys.filter((key) => !nativeKeys.includes(key));
      return {
        seed,
        ply,
        detail:
          `legal moves differ\n  only native: ${onlyNative.join(' ') || '(none)'}` +
          `\n  only spec:   ${onlySpec.join(' ') || '(none)'}`,
      };
    }

    // Per-square generation has to agree too, because that is what the board
    // actually calls when somebody taps a piece.
    const probe = nativeMoves[Math.floor(random() * nativeMoves.length)];
    if (!probe) return null;
    const nativeFrom = sortedKeys(
      validMovesFor(native, probe.from).map((to) => ({ from: probe.from, to })),
    );
    const specFrom = sortedKeys(
      specMovesFor(spec, specGame, probe.from).map((to) => ({ from: probe.from, to })),
    );
    if (nativeFrom.join(' ') !== specFrom.join(' ')) {
      return {
        seed,
        ply,
        detail: `moves from ${squareLabel(probe.from)} differ\n  native: ${nativeFrom.join(' ')}\n  spec:   ${specFrom.join(' ')}`,
      };
    }

    const playedNative = applyAnalysisMove(native, probe.from, probe.to);
    const playedSpec = specApplyMove(spec, specGame, probe.from, probe.to);
    if (!playedNative || !playedSpec) {
      return {
        seed,
        ply,
        detail: `${moveLabel(probe)} was legal but ${playedNative ? 'the spec' : 'the native rules'} refused it`,
      };
    }
    if (playedNative.captured !== playedSpec.captured) {
      return { seed, ply, detail: `${moveLabel(probe)} disagrees about whether it captured` };
    }
    native = playedNative.game;
    specGame = playedSpec.game;
  }
  return null;
};

for (const [modeId, spec] of [
  ['V5', TOTAL_WAR_SPEC],
  ['V3', INFILTRATION_SPEC],
] as const) {
  test(`${spec.name} plays identically as a spec and as hand-written rules`, () => {
    const divergences: Divergence[] = [];
    for (let seed = 1; seed <= 40; seed += 1) {
      const divergence = playBoth(spec, modeId, seed);
      if (divergence) divergences.push(divergence);
    }
    assert.deepEqual(
      divergences.map((entry) => `seed ${entry.seed} ply ${entry.ply}: ${entry.detail}`),
      [],
    );
  });
}

/* ------------------------------------------------------------------ endings -- */

// Every way the shipped modes can end, from a position built to reach it.
//
// A random walk is the wrong instrument for this: Total War almost never
// finishes from the opening inside a few hundred random plies, so "no game
// diverged" would be saying nothing about the endings — which are exactly the
// part most likely to drift, because they are where a mode's own rules live.

/** A board from rows, with territory following whoever stands on a square. */
const boardFrom = (rows: string[], territory?: string[]): Grid => {
  const grid = gridFromRows(rows);
  if (!territory) return grid;
  territory.forEach((row, y) => {
    Array.from(row).forEach((symbol, x) => {
      const tile = grid[y]?.[x];
      if (!tile) return;
      tile.ownerColor = symbol === 'r' ? 'Red' : symbol === 'b' ? 'Blue' : 'Neutral';
    });
  });
  return grid;
};

const bothFrom = (spec: RuleSpec, modeId: string, grid: Grid, turn: SideColor) => {
  const mode = modeDefinitionFor(spec, modeId);
  return {
    native: createAnalysisGameFrom({ ...mode, spec: undefined }, grid, turn),
    spec: createAnalysisGameFrom(mode, grid, turn),
  };
};

const playPair = (
  spec: RuleSpec,
  pair: { native: AnalysisGame; spec: AnalysisGame },
  moves: Move[],
) => {
  let { native, spec: specGame } = pair;
  for (const move of moves) {
    const playedNative = applyAnalysisMove(native, move.from, move.to);
    const playedSpec = specApplyMove(spec, specGame, move.from, move.to);
    assert.ok(playedNative, `native refused ${moveLabel(move)}`);
    assert.ok(playedSpec, `the spec refused ${moveLabel(move)}`);
    native = playedNative.game;
    specGame = playedSpec.game;
    assert.equal(describe(specGame), describe(native), `after ${moveLabel(move)}`);
  }
  return { native, spec: specGame };
};

const at = (file: number, rank: number) => ({ x: file, y: rank });

test('Total War: taking the last enemy piece is an annihilation win, both ways', () => {
  const rows = Array.from({ length: 9 }, () => '.........');
  rows[4] = '...S.....'; // a Blue scissors on d5
  rows[5] = '...r.....'; // Red's rock below it — rock takes scissors
  const ending = playPair(
    TOTAL_WAR_SPEC,
    bothFrom(TOTAL_WAR_SPEC, 'V5', boardFrom(rows), 'Red'),
    [{ from: at(3, 5), to: at(3, 4) }],
  );
  assert.equal(ending.native.endReason, 'annihilation');
  assert.equal(ending.native.winner, 'Red');
  // And the winner is still to move in the final position, which is what every
  // archived record's FinalFEN says.
  assert.equal(ending.native.currentTurn, 'Red');
});

test('Total War: filling the last neutral square counts territory, both ways', () => {
  const rows = Array.from({ length: 9 }, () => '.........');
  rows[0] = 'S........';
  rows[8] = 'r........';
  // Every square owned but b8, which Red is about to step onto from a9. Red
  // holds more of the board, so the count hands Red the game.
  const territory: string[] = Array.from({ length: 9 }, (_unused, y) =>
    y < 4 ? 'bbbbbbbbb' : 'rrrrrrrrr',
  );
  territory[7] = 'r.rrrrrrr';
  const ending = playPair(
    TOTAL_WAR_SPEC,
    bothFrom(TOTAL_WAR_SPEC, 'V5', boardFrom(rows, territory), 'Red'),
    [{ from: at(0, 8), to: at(1, 7) }],
  );
  assert.equal(ending.native.endReason, 'territory');
  assert.equal(ending.native.winner, 'Red');
});

test('Infiltration: reaching the far rank wins, both ways', () => {
  const rows = Array.from({ length: 9 }, () => '.........');
  rows[1] = '...r.....'; // Red one step from Blue's home rank
  rows[7] = '...S.....'; // and a Blue piece, so nobody is stalemated first
  const ending = playPair(
    INFILTRATION_SPEC,
    bothFrom(INFILTRATION_SPEC, 'V3', boardFrom(rows), 'Red'),
    [{ from: at(3, 1), to: at(3, 0) }],
  );
  assert.equal(ending.native.endReason, 'infiltration');
  assert.equal(ending.native.winner, 'Red');
});

test('Infiltration: losing every piece is a stalemate draw, not a loss, both ways', () => {
  // The rule Infiltration gets by *not* having an annihilation condition. Red
  // takes Blue's last piece and it is Blue to move with nothing to move.
  const rows = Array.from({ length: 9 }, () => '.........');
  rows[4] = '...S.....';
  rows[5] = '...r.....';
  const ending = playPair(
    INFILTRATION_SPEC,
    bothFrom(INFILTRATION_SPEC, 'V3', boardFrom(rows), 'Red'),
    [{ from: at(3, 5), to: at(3, 4) }],
  );
  assert.equal(ending.native.endReason, 'stalemate');
  assert.equal(ending.native.winner, 'Neutral');
});

test('the third repetition of a position is a draw, both ways', () => {
  const rows = Array.from({ length: 9 }, () => '.........');
  rows[0] = 'S........';
  rows[8] = 'r........';
  const shuffle: Move[] = [];
  for (let round = 0; round < 3; round += 1) {
    shuffle.push({ from: at(0, 8), to: at(1, 8) });
    shuffle.push({ from: at(0, 0), to: at(1, 0) });
    shuffle.push({ from: at(1, 8), to: at(0, 8) });
    shuffle.push({ from: at(1, 0), to: at(0, 0) });
  }
  // Played until one side stops: the pair diverging at any ply fails inside
  // playPair, and the ending is compared after.
  let pair = bothFrom(INFILTRATION_SPEC, 'V3', boardFrom(rows), 'Red');
  for (const move of shuffle) {
    if (pair.native.status !== 'InProgress') break;
    pair = playPair(INFILTRATION_SPEC, pair, [move]);
  }
  assert.equal(pair.native.endReason, 'repetition');
  assert.equal(pair.native.winner, 'Neutral');
});
