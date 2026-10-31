import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  IDLE_WATCH,
  clockReading,
  firstMoveReading,
  watchCountdown,
  type CountdownReading,
  type LowWatch,
} from './lowClock.ts';
import type { ActiveGame } from '@/store/types';

const LINE = 20_000;

const reading = (remainingMs: number, running = true, gameId = 'g'): CountdownReading => ({
  gameId,
  remainingMs,
  running,
});

/** Feed readings in order; report which ones buzzed. */
const watchThrough = (readings: CountdownReading[], start: LowWatch = IDLE_WATCH) => {
  let watch = start;
  return readings.map((next) => {
    const step = watchCountdown(watch, next, LINE);
    watch = step.watch;
    return step;
  });
};

describe('a clock running low', () => {
  it('buzzes once, at the crossing it was watched making', () => {
    const steps = watchThrough([reading(45_000), reading(21_000), reading(19_900), reading(12_000)]);
    assert.deepEqual(
      steps.map((step) => step.buzz),
      [false, false, true, false],
    );
  });

  it('says when to look again: the moment the line will be crossed', () => {
    const [step] = watchThrough([reading(45_000)]);
    assert.equal(step?.checkInMs, 25_000);
    // Not while it is the other side's clock running.
    assert.equal(watchThrough([reading(45_000, false)])[0]?.checkInMs, null);
  });

  it('does not buzz for a clock that was already low when first seen', () => {
    // A game with less than the line on it, or a rejoin in time trouble.
    const steps = watchThrough([reading(15_000), reading(9_000)]);
    assert.ok(steps.every((step) => !step.buzz));
  });

  it('does not buzz again for an increment bobbing it back over the line', () => {
    const steps = watchThrough([
      reading(30_000),
      reading(19_000),
      reading(23_000, false), // +5 s for the move, now the other side is thinking
      reading(19_500),
    ]);
    assert.deepEqual(
      steps.map((step) => step.buzz),
      [false, true, false, false],
    );
  });

  it('re-arms once an extension takes it well clear of the line', () => {
    const steps = watchThrough([reading(30_000), reading(19_000), reading(199_000), reading(19_000)]);
    assert.deepEqual(
      steps.map((step) => step.buzz),
      [false, true, false, true],
    );
  });

  it('does not buzz for a clock that has run out, or one that is not running', () => {
    assert.ok(watchThrough([reading(30_000), reading(0)]).every((step) => !step.buzz));
    assert.ok(watchThrough([reading(30_000), reading(19_000, false)]).every((step) => !step.buzz));
  });

  it('starts over for a new game', () => {
    const [, second] = watchThrough([reading(30_000, true, 'one'), reading(19_000, true, 'two')]);
    assert.equal(second?.buzz, false, 'the new game was never seen above the line');
  });
});

const game = (extra: Partial<ActiveGame>) =>
  ({
    gameId: 'g',
    status: 'InProgress',
    currentTurn: 'Red',
    clock: { activeColor: 'Red', redRemainingMs: 60_000, blueRemainingMs: 50_000, updatedAtUnixMs: 1_000 },
    ...extra,
  }) as unknown as ActiveGame;

describe('reading the clocks', () => {
  it('reads your own clock as the face does', () => {
    assert.deepEqual(clockReading(game({}), 'Red', 11_000), {
      gameId: 'g',
      remainingMs: 50_000,
      running: true,
    });
    // The other side's turn: your clock is stopped where it was.
    assert.deepEqual(clockReading(game({}), 'Blue', 11_000), {
      gameId: 'g',
      remainingMs: 50_000,
      running: false,
    });
  });

  it('has nothing to read for a spectator, a shared board or a finished game', () => {
    assert.equal(clockReading(game({}), 'Neutral', 0), null);
    assert.equal(clockReading(game({ local: {} } as Partial<ActiveGame>), null, 0), null);
    assert.equal(clockReading(game({ status: 'Finished' }), 'Red', 0), null);
  });

  it('reads the first-move window only while the board waits, and runs it for whoever must move', () => {
    const waiting = game({
      clock: { activeColor: 'Neutral', redRemainingMs: 60_000, blueRemainingMs: 60_000, updatedAtUnixMs: 0 },
    } as Partial<ActiveGame>);
    assert.deepEqual(firstMoveReading(waiting, 'Red', 31_000, 6_000), {
      gameId: 'g',
      remainingMs: 25_000,
      running: true,
    });
    assert.equal(firstMoveReading(waiting, 'Blue', 31_000, 6_000)?.running, false);
    // Clamped to the window when the clocks disagree.
    assert.equal(firstMoveReading(waiting, 'Red', 90_000, 0)?.remainingMs, 30_000);
    // Once somebody has moved, the clock is the thing to watch.
    assert.equal(firstMoveReading(game({}), 'Red', 31_000, 6_000), null);
    assert.equal(firstMoveReading(waiting, 'Red', null, 6_000), null);
  });
});
