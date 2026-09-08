import assert from 'node:assert/strict';
import test from 'node:test';

import {
  customizationCount,
  describeSetup,
  hasCustomPosition,
  isStandardSetup,
  ruleSummary,
  setupSummary,
  standardSetup,
  timeControlLabel,
  withMode,
} from './setupSelectors.ts';
import type { GameSetup, ModeDefinition, StartingPosition } from '../types/game.ts';

const rows = (rank: string): StartingPosition => ({
  rows: [rank, ...Array.from({ length: 8 }, () => '.........')],
});

const TOTAL_WAR = {
  id: 'V5',
  name: 'Total War',
  startingPosition: rows('...SSS...'),
} as unknown as ModeDefinition;

const INFILTRATION = {
  id: 'V3',
  name: 'Infiltration',
  startingPosition: rows('..SS.SS..'),
} as unknown as ModeDefinition;

const DEFAULT_CLOCK = { initialTimeMs: 300_000, incrementMs: 3_000 };

test('the standard setup is the one nobody had to configure', () => {
  const setup = standardSetup(TOTAL_WAR, DEFAULT_CLOCK);
  assert.equal(isStandardSetup(setup, TOTAL_WAR, DEFAULT_CLOCK), true);
  assert.equal(customizationCount(setup, TOTAL_WAR, DEFAULT_CLOCK), 0);
  assert.equal(hasCustomPosition(setup, TOTAL_WAR), false);
});

test('every knob takes a setup out of the standard game', () => {
  const base = standardSetup(TOTAL_WAR, DEFAULT_CLOCK);
  const edits: Record<string, GameSetup> = {
    clock: { ...base, timeControl: { initialTimeMs: 60_000, incrementMs: 0 } },
    board: { ...base, startingPosition: rows('....R....') },
    casual: { ...base, casual: true },
    seat: { ...base, preferredColor: 'Red' },
    'rule off': { ...base, rules: { noDrawOffers: true } },
  };
  for (const [name, setup] of Object.entries(edits)) {
    assert.equal(
      isStandardSetup(setup, TOTAL_WAR, DEFAULT_CLOCK),
      false,
      `${name} should not read as the standard game`,
    );
    assert.equal(customizationCount(setup, TOTAL_WAR, DEFAULT_CLOCK), 1, `${name} count`);
  }
});

// The same question the server answers, so a screen and the server never
// disagree about whether pressing the button posts a game or joins a queue.
test('a mode it does not name is never the standard game for that mode', () => {
  const setup = standardSetup(TOTAL_WAR, DEFAULT_CLOCK);
  assert.equal(isStandardSetup(setup, INFILTRATION, DEFAULT_CLOCK), false);
  assert.equal(isStandardSetup(setup, null, DEFAULT_CLOCK), false);
});

test('changing mode carries a board you drew but not one you inherited', () => {
  const standard = standardSetup(TOTAL_WAR, DEFAULT_CLOCK);
  const moved = withMode(standard, INFILTRATION, TOTAL_WAR);
  assert.deepEqual(moved.startingPosition, INFILTRATION.startingPosition);
  assert.equal(isStandardSetup(moved, INFILTRATION, DEFAULT_CLOCK), true);

  const drawn = { ...standard, startingPosition: rows('....R....') };
  const movedDrawn = withMode(drawn, INFILTRATION, TOTAL_WAR);
  assert.deepEqual(movedDrawn.startingPosition, drawn.startingPosition);
  assert.equal(hasCustomPosition(movedDrawn, INFILTRATION), true);
});

test('the bullets lead with the two facts every game has', () => {
  const bullets = describeSetup(standardSetup(TOTAL_WAR, DEFAULT_CLOCK), TOTAL_WAR, DEFAULT_CLOCK);
  assert.deepEqual(
    bullets.map((bullet) => bullet.key),
    ['clock', 'rated'],
  );
  // Neither is a departure from anything, so neither is marked as one.
  assert.deepEqual(
    bullets.map((bullet) => bullet.custom),
    [false, false],
  );
});

test('the bullets list every departure, and mark them as departures', () => {
  const setup: GameSetup = {
    ...standardSetup(TOTAL_WAR, DEFAULT_CLOCK),
    timeControl: { initialTimeMs: 60_000, incrementMs: 0 },
    startingPosition: rows('....R....'),
    casual: true,
    preferredColor: 'Blue',
    rules: { noRepetitionDraw: true, noDrawOffers: true, noTimeExtensions: true },
  };
  const bullets = describeSetup(setup, TOTAL_WAR, DEFAULT_CLOCK);
  assert.deepEqual(bullets.map((bullet) => bullet.key), [
    'clock',
    'casual',
    'position',
    'seat',
    'noRepetitionDraw',
    'noDrawOffers',
    'noTimeExtensions',
  ]);
  assert.equal(bullets.every((bullet) => bullet.custom), true);
  assert.equal(customizationCount(setup, TOTAL_WAR, DEFAULT_CLOCK), 7);
  assert.match(setupSummary(setup, TOTAL_WAR, DEFAULT_CLOCK), /Custom position/);
});

// The lobby row and the game screen describe the same game, so both read the
// rule labels from one place.
test('the rule summary is the rule bullets and nothing else', () => {
  assert.equal(ruleSummary(undefined), '');
  assert.equal(ruleSummary({}), '');
  assert.equal(ruleSummary({ noDrawOffers: true }), 'No draw offers');
});

test('a clock under a minute is written in seconds rather than rounded to zero', () => {
  assert.equal(timeControlLabel({ initialTimeMs: 300_000, incrementMs: 3_000 }), '5+3');
  assert.equal(timeControlLabel({ initialTimeMs: 60_000, incrementMs: 0 }), '1+0');
  assert.equal(timeControlLabel({ initialTimeMs: 30_000, incrementMs: 1_000 }), '30s+1');
});
