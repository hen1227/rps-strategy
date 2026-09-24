import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countdownLabel,
  ladderConditionsLine,
  ladderRoundView,
  LADDER_ROUND_LIVE_MS,
} from './ladderRound.ts';
import type { LadderPool } from '../../store/api/ladderPool.ts';
import type { ModeDefinition } from '../../types/game.ts';

const MODES = [
  { id: 'V5', shortCode: 'V5', name: 'Total War', playable: true },
  { id: 'V3', shortCode: 'V3', name: 'Infiltration', playable: true },
] as unknown as ModeDefinition[];

const pool = (extra: Partial<LadderPool> = {}): LadderPool =>
  ({
    roundsRun: 4,
    lastRoundAtUnixMs: 0,
    intervalMs: 3_600_000,
    gamesPerRound: 2,
    schedule: [
      { modeId: 'V5', initialTimeMs: 180_000, incrementMs: 1_000, atUnixMs: 3_600_000, entered: 3 },
      { modeId: 'V3', initialTimeMs: 60_000, incrementMs: 1_000, atUnixMs: 7_200_000, entered: 0 },
    ],
    graceMs: 300_000,
    anchorBotId: 'anchor',
    yardstickBotIds: ['anchor', 'fish8'],
    ratingFloor: 1,
    ratingPointsPerDoubling: 20,
    ...extra,
  }) as LadderPool;

test('a countdown reads as a clock, and grows an hour field only when it has one', () => {
  assert.equal(countdownLabel(0), '0:00');
  assert.equal(countdownLabel(64_000), '1:04');
  assert.equal(countdownLabel(2_524_000), '42:04');
  assert.equal(countdownLabel(3_600_000), '1:00:00');
  assert.equal(countdownLabel(-5_000), '0:00');
});

test('a head still inside the grace is the round being counted down to', () => {
  // The server may seat a slot a few minutes late, so just after the hour the
  // head is a moment *just past* and is still the round about to run. The page's
  // field is computed for that round, so moving past it here would put the field
  // and the heading on different hours.
  const view = ladderRoundView(pool(), MODES, 3_600_001);
  assert.equal(view?.next?.atUnixMs, 3_600_000);
  assert.equal(view?.mode?.name, 'Total War');
  assert.equal(view?.countdown, '0:00');
  // And it says so rather than looking like a stopped clock.
  assert.equal(view?.phase, 'live');
});

test('past the grace the head has been skipped, and the next one is the answer', () => {
  // The other half, and the case a long-open tab with a stale payload is in:
  // counting down to a round that has already run would sit at zero for ever.
  const view = ladderRoundView(pool(), MODES, 3_600_000 + 300_001);
  assert.equal(view?.next?.atUnixMs, 7_200_000);
  assert.equal(view?.mode?.name, 'Infiltration');
});

test('a server too old to publish the grace still counts down to a future round', () => {
  const old = { ...pool(), graceMs: undefined } as unknown as LadderPool;
  assert.equal(ladderRoundView(old, MODES, 3_600_001)?.next?.atUnixMs, 7_200_000);
});

test('the view resolves the mode and labels the clock', () => {
  const view = ladderRoundView(pool(), MODES, 0);
  assert.equal(view?.mode?.name, 'Total War');
  assert.equal(view?.clock, '3+1');
  assert.equal(view?.countdown, '1:00:00');
});

test('a round seated within the window reads as under way', () => {
  const recent = pool({ lastRoundAtUnixMs: 1_000_000 });
  assert.equal(ladderRoundView(recent, MODES, 1_060_000)?.phase, 'live');
  assert.equal(
    ladderRoundView(recent, MODES, 1_000_000 + LADDER_ROUND_LIVE_MS + 1)?.phase,
    'waiting',
  );
});

test('a round within ten minutes reads as soon', () => {
  assert.equal(ladderRoundView(pool(), MODES, 3_600_000 - 60_000)?.phase, 'soon');
  assert.equal(ladderRoundView(pool(), MODES, 0)?.phase, 'waiting');
});

test('a board with no reference engine says the scale is relative', () => {
  // Not "unrated" — the board is published either way. What changes is whether
  // 1 means chance or the weakest engine here.
  assert.equal(ladderRoundView(pool(), MODES, 0)?.relativeScale, false);
  assert.equal(
    ladderRoundView(pool({ anchorBotId: '' }), MODES, 0)?.relativeScale,
    true,
  );
});

test('no pool and an exhausted schedule both draw nothing', () => {
  assert.equal(ladderRoundView(null, MODES, 0), null);
  assert.equal(ladderRoundView(pool(), MODES, 9_000_000), null);
});

test('the conditions read as the mode and the clock, and fall back to the id', () => {
  // Shared by the rail and the page, so the two cannot describe one round
  // differently. An unknown mode id is drawn rather than dropped: a client older
  // than a new mode should still say what the round is.
  const view = ladderRoundView(pool(), MODES, 0);
  assert.equal(view && ladderConditionsLine(view), 'Total War · 3+1');
  const unknown = ladderRoundView(pool(), [], 0);
  assert.equal(unknown && ladderConditionsLine(unknown), 'V5 · 3+1');
});

test('the view carries the server own count of the field', () => {
  // The rail no longer lists the lineup, and the page reads the named field from
  // its own route — but this number is still what the schedule itself says, and
  // is the one figure available before that route answers.
  assert.equal(ladderRoundView(pool(), MODES, 0)?.entered, 3);
});
