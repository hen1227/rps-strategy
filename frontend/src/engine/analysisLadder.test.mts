// The part of the analysis session that chooses its own depth.
//
// `gameAnalysis.test.mts` covers the walk against the real engine: that every
// position is graded, that a taken-back move keeps the grades it should, that a
// streamed game reaches the same report as one that arrives whole. None of that
// is about depth, and all of it is slow.
//
// This file is about depth and nothing else, so it drives the session with a
// stub engine and a clock it controls. That buys two things a real engine
// cannot give: exact knowledge of which budget each pass was asked for, and a
// budget that can be spent without waiting for it.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  allValidMoves,
  applyAnalysisMove,
  createAnalysisGame,
  type AnalysisGame,
} from './analysisGame';
import {
  analysisBudgetMs,
  analysisLadder,
  interactiveLimits,
} from './analysisBudget';
import { createGameAnalysis, type AnalysisSnapshot } from './gameAnalysis';
import { createSeededRandom } from './bots/engine';
import type { ReviewFn } from './rpsfish/client';
import type { ReviewEntry, SearchLimits } from './rpsfish/protocol';
import { testMode } from '@/testing/modes';
import { type Move, type SideColor } from '@/types/game';

const MODE = testMode('V5');

const rung = (maxDepth: number, maxTimeMs: number): SearchLimits => ({
  maxDepth,
  maxNodes: 1_000 * maxDepth,
  maxTimeMs,
  throttleMs: 0,
  variations: 3,
});

/** Three rungs whose time ceilings double, so the projection is easy to read. */
const LADDER = [rung(4, 1_000), rung(8, 2_000), rung(12, 4_000)];

interface Line {
  positions: AnalysisGame[];
  moves: (Move & { player: SideColor })[];
}

const playRandomGame = (plies: number, seed: number): Line => {
  const random = createSeededRandom(seed);
  let game = createAnalysisGame(MODE);
  const positions: AnalysisGame[] = [game];
  const moves: Line['moves'] = [];
  for (let ply = 0; ply < plies && game.status === 'InProgress'; ply += 1) {
    const legal = allValidMoves(game);
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

/** The depth a stub entry was graded at, recoverable from the entry itself. */
const depthOf = (entry: ReviewEntry) => entry.analysis.depth;

interface StubOptions {
  /** How much clock one position costs at a given budget. */
  costPerPosition?: (limits: SearchLimits) => number;
  /** Real milliseconds one position takes, for the abort tests. */
  delayPerPosition?: number;
}

interface Stub {
  review: ReviewFn;
  /** Every pass asked for, in order: the depth and where it started. */
  calls: { analyzeFrom: number; maxDepth: number }[];
  now: () => number;
}

/**
 * An engine that grades instantly, stamps each entry with the depth it was
 * asked for, and charges a clock the test can read.
 */
const stubEngine = ({
  costPerPosition = (limits) => limits.maxTimeMs,
  delayPerPosition = 0,
}: StubOptions = {}): Stub => {
  const calls: Stub['calls'] = [];
  let clock = 0;
  const review: ReviewFn = async (body, options = {}, onEntry) => {
    const analyzeFrom = body.analyzeFrom ?? 0;
    const maxDepth = options.maxDepth ?? 0;
    calls.push({ analyzeFrom, maxDepth });
    const entries: ReviewEntry[] = [];
    for (let index = analyzeFrom; index < body.positions.length; index += 1) {
      // A yield per position, so an abort raised while the pass is in flight
      // lands between two entries rather than never.
      await new Promise((resolve) => setTimeout(resolve, delayPerPosition));
      if (options.signal?.aborted) {
        const failure = new Error('aborted');
        failure.name = 'AbortError';
        throw failure;
      }
      clock += costPerPosition({ ...rung(maxDepth, options.maxTimeMs ?? 0) });
      const entry: ReviewEntry = {
        index,
        analysis: {
          confidence: 100,
          depth: maxDepth,
          elapsedMs: 1,
          lines: [],
          nodes: 1,
          nodesPerSecond: 1,
          redScore: 0,
          score: 0,
          selectiveDepth: maxDepth,
          stopReason: 'depth',
        },
        baselineScore: 0,
        played: body.moves[index] ?? null,
        playedScore: 0,
        playedVariation: null,
      };
      entries.push(entry);
      onEntry?.(entry, body.positions.length);
    }
    return entries;
  };
  return { calls, now: () => clock, review };
};

/** Every snapshot the session published, in order. */
const record = (options: Parameters<typeof createGameAnalysis>[0]) => {
  const snapshots: AnalysisSnapshot[] = [];
  const session = createGameAnalysis({
    ...options,
    onChange: (snapshot) => snapshots.push(snapshot),
  });
  return { session, snapshots };
};

/**
 * Wait until the session has finished climbing, or give up.
 *
 * `deeperToCome` is part of the condition and not an afterthought: a walk that
 * has published a complete report is not necessarily finished, because it may
 * be waiting out its settle delay before starting a deeper pass. Watching only
 * for a quiet moment would catch it in that gap and call it done.
 */
const quiet = async (snapshots: AnalysisSnapshot[]) => {
  let seen = -1;
  for (let spin = 0; spin < 400; spin += 1) {
    const count = snapshots.length;
    const latest = snapshots[count - 1];
    if (
      count === seen &&
      latest &&
      latest.status !== 'running' &&
      latest.status !== 'deepening' &&
      !latest.deeperToCome
    ) {
      return latest;
    }
    seen = count;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('the session never settled');
};

describe('a walk that chooses its own depth', () => {
  it('climbs every rung it can afford and regrades the whole line each time', async () => {
    const engine = stubEngine();
    const line = playRandomGame(8, 1);
    const { session, snapshots } = record({
      budgetMs: 10_000_000,
      ladder: LADDER,
      now: engine.now,
      review: engine.review,
      settleMs: 0,
    });
    session.submit({ ...line, streaming: false });
    const settled = await quiet(snapshots);
    session.stop();

    assert.equal(settled.status, 'done');
    assert.equal(settled.pass, 2, 'the walk should have reached the top rung');
    assert.equal(settled.limits.maxDepth, 12);
    assert.equal(settled.deeperToCome, false);
    assert.equal(settled.entries.length, line.positions.length);
    settled.entries.forEach((entry) => assert.equal(depthOf(entry), 12));

    // One pass per rung, and every pass after the first regrades from the top
    // of the line rather than extending what the shallower pass left.
    assert.deepEqual(
      engine.calls.map((call) => call.maxDepth),
      [4, 8, 12],
    );
    assert.deepEqual(
      engine.calls.map((call) => call.analyzeFrom),
      [0, 0, 0],
    );
  });

  it('never puts two depths in one report', async () => {
    const engine = stubEngine();
    const line = playRandomGame(8, 2);
    const { session, snapshots } = record({
      budgetMs: 10_000_000,
      ladder: LADDER,
      now: engine.now,
      review: engine.review,
      settleMs: 0,
    });
    session.submit({ ...line, streaming: false });
    await quiet(snapshots);
    session.stop();

    // The reason a deeper pass accumulates out of sight: accuracy is an average
    // over every move of a report, so one move graded at a different depth from
    // the rest makes that average a comparison of two searches. Rule 2 of
    // docs/review.md, at the scale of the whole report.
    assert.ok(snapshots.length > 3, 'the test needs the intermediate publishes');
    snapshots.forEach((snapshot, index) => {
      const depths = new Set(snapshot.entries.map(depthOf));
      assert.ok(
        depths.size <= 1,
        `snapshot ${index} mixed depths ${[...depths].join(' and ')}`,
      );
      // And every published report was graded at the budget it says it was.
      if (snapshot.entries.length > 0) {
        assert.equal([...depths][0], snapshot.limits.maxDepth, `snapshot ${index} depth`);
      }
    });
  });

  it('reports a deeper pass while it runs without disturbing the report', async () => {
    const engine = stubEngine({ delayPerPosition: 1 });
    const line = playRandomGame(6, 3);
    const { session, snapshots } = record({
      budgetMs: 10_000_000,
      ladder: LADDER,
      now: engine.now,
      review: engine.review,
      settleMs: 0,
    });
    session.submit({ ...line, streaming: false });
    await quiet(snapshots);
    session.stop();

    const deepening = snapshots.filter((snapshot) => snapshot.status === 'deepening');
    assert.ok(deepening.length > 0, 'a deeper pass should have been announced');
    deepening.forEach((snapshot) => {
      assert.ok(snapshot.refining, 'a deepening snapshot should say what it is doing');
      assert.ok(snapshot.refining.limits.maxDepth > snapshot.limits.maxDepth);
      // The whole line is regraded, and the report on screen is still complete
      // and still readable while that happens.
      assert.equal(snapshot.refining.total, line.positions.length);
      assert.equal(snapshot.entries.length, line.positions.length);
    });
  });

  it('stops climbing when the clock says the next pass will not fit', async () => {
    const engine = stubEngine();
    const line = playRandomGame(8, 4);
    // The stub charges a position the whole time ceiling of the budget it was
    // graded at, so the arithmetic the session does is exact. Call the line N
    // positions long: the first pass costs 1000N and projects 2000N for the
    // second rung, so climbing to it needs 3000N. The second pass then costs
    // 2000N and projects 4000N for the third, so climbing again needs 7000N. A
    // budget of 4000N therefore affords the second rung and not the third.
    const { session, snapshots } = record({
      budgetMs: 4_000 * line.positions.length,
      ladder: LADDER,
      now: engine.now,
      review: engine.review,
      settleMs: 0,
    });
    session.submit({ ...line, streaming: false });
    const settled = await quiet(snapshots);
    session.stop();

    assert.equal(settled.pass, 1);
    assert.equal(settled.limits.maxDepth, 8);
    assert.equal(settled.deeperToCome, false, 'the walk should admit it is finished');
    settled.entries.forEach((entry) => assert.equal(depthOf(entry), 8));
    assert.deepEqual(
      engine.calls.map((call) => call.maxDepth),
      [4, 8],
    );
  });

  it('grades once when there is only one rung', async () => {
    const engine = stubEngine();
    const line = playRandomGame(8, 5);
    const { session, snapshots } = record({
      budgetMs: 10_000_000,
      ladder: [rung(9, 2_000)],
      now: engine.now,
      review: engine.review,
      settleMs: 0,
    });
    session.submit({ ...line, streaming: false });
    const settled = await quiet(snapshots);
    session.stop();

    assert.equal(settled.pass, 0);
    assert.equal(settled.deeperToCome, false);
    assert.equal(engine.calls.length, 1);
  });

  it('leaves the report alone when a deeper pass is abandoned', async () => {
    const engine = stubEngine({ delayPerPosition: 4 });
    const line = playRandomGame(10, 6);
    const { session, snapshots } = record({
      budgetMs: 10_000_000,
      ladder: LADDER,
      now: engine.now,
      review: engine.review,
      settleMs: 0,
    });
    session.submit({ ...line, streaming: false });

    // Wait for the first deeper pass to be under way, then take a move back.
    let deepening: AnalysisSnapshot | undefined;
    for (let spin = 0; spin < 200 && !deepening; spin += 1) {
      deepening = snapshots.find((snapshot) => snapshot.status === 'deepening');
      if (!deepening) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(deepening, 'no deeper pass to interrupt');
    const shallowDepth = deepening.limits.maxDepth;

    const keep = line.positions.length - 2;
    session.submit({
      moves: line.moves.slice(0, keep - 1),
      positions: line.positions.slice(0, keep),
      streaming: false,
    });
    const settled = await quiet(snapshots);
    session.stop();

    // The abandoned pass may not leave a partial report behind, and the grades
    // that survived the take-back must still be the ones they were.
    assert.equal(settled.entries.length, keep);
    const depths = new Set(settled.entries.map(depthOf));
    assert.equal(depths.size, 1, 'the report kept two depths');
    assert.ok([...depths][0] >= shallowDepth);
  });

  it('starts deepening once a game it was watching ends', async () => {
    const engine = stubEngine();
    const line = playRandomGame(8, 8);
    const { session, snapshots } = record({
      budgetMs: 10_000_000,
      ladder: LADDER,
      now: engine.now,
      review: engine.review,
      // Longer than the gap between the instalments below, so the settle delay
      // never elapses while the game is still arriving.
      settleMs: 100,
    });

    // Watched to the end, a move at a time, and graded at the floor throughout.
    for (let end = 2; end <= line.positions.length; end += 1) {
      session.submit({
        moves: line.moves.slice(0, end - 1),
        positions: line.positions.slice(0, end),
        streaming: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
    const watched = snapshots[snapshots.length - 1];
    assert.equal(watched?.pass, 0);

    // The last move lands and the game is over. Nothing about the line changed,
    // only whether more of it is coming — and that alone has to be enough to
    // let the walk start improving what it has.
    session.submit({ ...line, streaming: false });
    const settled = await quiet(snapshots);
    session.stop();

    assert.equal(settled.status, 'done');
    assert.ok(settled.pass > 0, 'a finished game should have been regraded deeper');
    settled.entries.forEach((entry) => assert.equal(depthOf(entry), settled.limits.maxDepth));
  });

  it('does not spend the budget deepening a game that is still arriving', async () => {
    const engine = stubEngine();
    const line = playRandomGame(8, 7);
    const { session, snapshots } = record({
      budgetMs: 10_000_000,
      ladder: LADDER,
      now: engine.now,
      review: engine.review,
      // Long enough that it cannot elapse between two instalments below.
      settleMs: 5_000,
    });

    for (let end = 2; end < line.positions.length; end += 1) {
      session.submit({
        moves: line.moves.slice(0, end - 1),
        positions: line.positions.slice(0, end),
        streaming: true,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const latest = snapshots[snapshots.length - 1];
    session.stop();

    assert.ok(latest);
    assert.equal(latest.pass, 0, 'a game still arriving should not be regraded');
    assert.equal(latest.refining, null);
    // Every pass extended the report rather than restarting it.
    assert.ok(engine.calls.every((call) => call.maxDepth === 4));
    assert.ok(engine.calls.some((call) => call.analyzeFrom > 0));
  });
});

describe('the ladder a device is given', () => {
  it('climbs further on a machine that can take it', () => {
    const low = analysisLadder({ tier: 'low' });
    const high = analysisLadder({ tier: 'high' });
    assert.ok(high.length > low.length);
    // Weakest first, always: the first pass exists to put grades on screen.
    [low, high].forEach((ladder) => {
      ladder.forEach((limits, index) => {
        const previous = ladder[index - 1];
        if (previous) assert.ok(limits.maxDepth > previous.maxDepth);
      });
    });
    assert.ok(analysisBudgetMs({ tier: 'high' }) > analysisBudgetMs({ tier: 'low' }));
  });

  it('grades a live game against a search the players cannot outrun', () => {
    // A bot's move is chosen by a search of its own. The floor for grading one
    // has to be at least as strong, whatever the device — see docs/review.md.
    const review = analysisLadder({ tier: 'low' });
    const live = analysisLadder({ tier: 'low', live: true });
    const floor = live[0];
    const shallowest = review[0];
    assert.ok(floor && shallowest);
    assert.ok(floor.maxDepth > shallowest.maxDepth);
  });

  it('offers one shallow pass and no deepening for a quick review', () => {
    const quick = analysisLadder({ effort: 'quick', tier: 'high' });
    assert.equal(quick.length, 1);
    assert.equal(analysisBudgetMs({ effort: 'quick', tier: 'high' }), 0);
    assert.ok(quick[0]!.maxDepth < analysisLadder({ tier: 'high' }).at(-1)!.maxDepth);
    // And the interactive search is capped in time rather than in depth, since
    // iterative deepening streams what it has either way.
    assert.ok(
      interactiveLimits({ effort: 'quick' }).maxTimeMs <
        interactiveLimits({ effort: 'full' }).maxTimeMs,
    );
  });
});
