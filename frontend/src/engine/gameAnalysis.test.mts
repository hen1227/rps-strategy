// The analysis session, against the engine the website ships.
//
// Run with `npm test`. The loader is what lets Node import the app's own
// modules; the worker shim runs `public/rpsfish/` as built, so a pass here is
// a pass for the path the browser takes.

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  allValidMoves,
  applyAnalysisMove,
  createAnalysisGame,
  type AnalysisGame,
} from './analysisGame';
import { createSeededRandom } from './bots/engine';
import {
  createGameAnalysis,
  firstDivergence,
  positionSignature,
  type AnalysisSnapshot,
  type GameLine,
} from './gameAnalysis';
import type { ReviewFn } from './rpsfish/client';
import type { SearchLimits } from './rpsfish/protocol';
import { startEngineWorker, type NodeEngineWorker } from '../../scripts/engineWorker.mts';
import { testMode } from '@/testing/modes';
import type { Move, SideColor } from '@/types/game';

const MODE = testMode('V5');

const PRESETS: Record<string, SearchLimits> = {
  test: { maxDepth: 6, maxNodes: 200_000, maxTimeMs: 1_000, throttleMs: 0, variations: 3 },
};

/** A line of play with the mover of each move, as a session is handed one. */
interface RandomGame extends Pick<GameLine, 'positions' | 'moves'> {
  positions: AnalysisGame[];
  moves: (Move & { player: SideColor })[];
}

/** A seeded game of legal moves, as a line of positions and the moves in it. */
const playRandomGame = (plies: number, seed: number): RandomGame => {
  const random = createSeededRandom(seed);
  let game = createAnalysisGame(MODE);
  const positions: AnalysisGame[] = [game];
  const moves: RandomGame['moves'] = [];
  for (let ply = 0; ply < plies && game.status === 'InProgress'; ply += 1) {
    const legal = allValidMoves(game);
    if (legal.length === 0) break;
    const choice = legal[Math.floor(random() * legal.length)];
    if (!choice) break;
    const result = applyAnalysisMove(game, choice.from, choice.to);
    if (!result) break;
    moves.push({ ...choice, player: result.mover });
    game = result.game;
    positions.push(game);
  }
  return { moves, positions };
};

/** Drive a session to completion over a line that arrives all at once. */
const analyzeWhole = async (review: ReviewFn, line: RandomGame, preset = 'test') => {
  let resolveDone: (snapshot: AnalysisSnapshot) => void = () => undefined;
  const done = new Promise<AnalysisSnapshot>((resolve) => {
    resolveDone = resolve;
  });
  const session = createGameAnalysis({
    preset,
    presets: PRESETS,
    review,
    onChange: (snapshot) => {
      if (snapshot.error) resolveDone(snapshot);
      else if (snapshot.status === 'done') resolveDone(snapshot);
    },
  });
  session.submit({ ...line, streaming: false });
  const snapshot = await done;
  session.stop();
  return snapshot;
};

describe('positionSignature', () => {
  it('separates positions and repeats for the same one', () => {
    const { positions } = playRandomGame(6, 7);
    const signatures = positions.map(positionSignature);
    assert.equal(new Set(signatures).size, signatures.length);
    const first = positions[0];
    assert.ok(first);
    assert.equal(positionSignature(first), signatures[0]);
  });

  it('distinguishes whose turn it is from the pieces alone', () => {
    const start = createAnalysisGame(MODE);
    const swapped = { ...start, currentTurn: 'Blue' as const };
    assert.notEqual(positionSignature(start), positionSignature(swapped));
  });
});

describe('firstDivergence', () => {
  it('is the shorter length when one line is a prefix of the other', () => {
    assert.equal(firstDivergence(['a', 'b'], ['a', 'b', 'c']), 2);
    assert.equal(firstDivergence(['a', 'b', 'c'], ['a', 'b']), 2);
  });

  it('is the first disagreement otherwise', () => {
    assert.equal(firstDivergence(['a', 'b', 'c'], ['a', 'x', 'c']), 1);
    assert.equal(firstDivergence([], ['a']), 0);
  });
});

describe('createGameAnalysis against RPSFish', () => {
  let engine: NodeEngineWorker | undefined;
  let review: ReviewFn;

  before(async () => {
    engine = await startEngineWorker();
    const started = engine;
    review = (payload, options, onEntry) =>
      started.review({ ...payload, options }, (entry) => onEntry?.(entry));
  });

  it('grades every position of a finished game', async () => {
    const line = playRandomGame(14, 20_260_822);
    const { entries, status } = await analyzeWhole(review, line);
    assert.equal(status, 'done');
    assert.equal(entries.length, line.positions.length);
    entries.forEach((entry, index) => assert.equal(entry.index, index));
    // Every position but the last was followed by a move, so every one of
    // those has a played move to compare against the best.
    for (let index = 0; index < line.moves.length; index += 1) {
      const entry = entries[index];
      assert.ok(entry, `position ${index} was never graded`);
      assert.equal(typeof entry.baselineScore, 'number');
      assert.equal(typeof entry.playedScore, 'number');
    }
  });

  it('reaches the same report whether the game arrives whole or a move at a time', async () => {
    const line = playRandomGame(14, 4_242);
    const whole = await analyzeWhole(review, line);

    // The shape a watched game actually arrives in: N positions and N-1 moves,
    // because the position the game currently sits at has no move out of it
    // yet. Grading that position before its move exists is what used to leave
    // one move of every instalment permanently ungraded.
    const snapshots: AnalysisSnapshot[] = [];
    const session = createGameAnalysis({
      preset: 'test',
      presets: PRESETS,
      review,
      onChange: (snapshot) => snapshots.push(snapshot),
    });
    const idle = async (): Promise<AnalysisSnapshot> => {
      for (let spin = 0; spin < 400; spin += 1) {
        const latest = snapshots[snapshots.length - 1];
        if (latest && latest.status !== 'running') return latest;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('the session never settled');
    };
    for (let end = 1; end <= line.positions.length; end += 2) {
      const upTo = Math.min(line.positions.length, end + 1);
      session.submit({
        moves: line.moves.slice(0, upTo - 1),
        positions: line.positions.slice(0, upTo),
        streaming: upTo < line.positions.length,
      });
      await idle();
    }
    const streamed = await idle();
    session.stop();

    assert.equal(streamed.status, 'done');
    // Every move must have come out of a search of the position it was played
    // from, whichever instalment that position arrived in.
    for (let index = 0; index < line.moves.length; index += 1) {
      assert.equal(
        typeof streamed.entries[index]?.playedScore,
        'number',
        `move ${index} was never graded`,
      );
    }
    assert.equal(streamed.entries.length, whole.entries.length);
    streamed.entries.forEach((entry, index) => {
      const reference = whole.entries[index];
      assert.ok(reference, `the whole-game walk is missing entry ${index}`);
      assert.equal(entry.index, reference.index);
      assert.equal(entry.baselineScore, reference.baselineScore, `baseline at ${index}`);
      assert.equal(entry.playedScore, reference.playedScore, `played at ${index}`);
      assert.deepEqual(
        entry.analysis.lines.map((candidate) => candidate.score),
        reference.analysis.lines.map((candidate) => candidate.score),
        `lines at ${index}`,
      );
    });
  });

  it('keeps the grades a taken-back move does not invalidate', async () => {
    const line = playRandomGame(10, 99);
    const snapshots: AnalysisSnapshot[] = [];
    const session = createGameAnalysis({
      preset: 'test',
      presets: PRESETS,
      review,
      onChange: (snapshot) => snapshots.push(snapshot),
    });
    const idle = async (): Promise<AnalysisSnapshot> => {
      for (let spin = 0; spin < 400; spin += 1) {
        const latest = snapshots[snapshots.length - 1];
        if (latest && latest.status !== 'running') return latest;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('the session never settled');
    };

    session.submit({ ...line, streaming: false });
    const full = await idle();
    assert.equal(full.entries.length, line.positions.length);

    // Take the last three moves back and play a different one: the grades for
    // the shared opening must survive, and the new move must be graded.
    const keep = line.positions.length - 3;
    const base = line.positions[keep - 1];
    const played = line.moves[keep - 1];
    assert.ok(base && played, 'the random game was too short to branch');
    const legal = allValidMoves(base).filter(
      (move) =>
        move.from.x !== played.from.x ||
        move.from.y !== played.from.y ||
        move.to.x !== played.to.x ||
        move.to.y !== played.to.y,
    );
    const alternative = legal[0];
    assert.ok(alternative, 'the position had only one legal move');
    const replacement = applyAnalysisMove(base, alternative.from, alternative.to);
    assert.ok(replacement, 'the alternative move should have been legal');
    session.submit({
      moves: [...line.moves.slice(0, keep - 1), { ...alternative, player: replacement.mover }],
      positions: [...line.positions.slice(0, keep), replacement.game],
      streaming: false,
    });
    const branched = await idle();
    session.stop();

    assert.equal(branched.entries.length, keep + 1);
    for (let index = 0; index < keep - 1; index += 1) {
      assert.equal(branched.entries[index], full.entries[index], `entry ${index} was regraded`);
    }
    assert.equal(typeof branched.entries[keep - 1]?.playedScore, 'number');
  });

  after(() => {
    engine = undefined;
  });
});
