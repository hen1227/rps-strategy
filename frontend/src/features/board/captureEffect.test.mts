import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ATTACKER_SETTLED_BY_MS,
  CAPTURE_EFFECT_DURATION,
  CHOREOGRAPHY,
  IMPACT_MS,
  LATEST_IMPACT_MS,
  SKIMMING_STEP_MS,
  decideCaptureEffect,
  effectOutlivesStep,
  impactAfter,
  keyframesFor,
  retime,
  type CaptureEffectInput,
  type Keyframes,
} from './captureEffect';
import type { Piece, PlayerColor, Tile } from '@/types/game';

interface Placement {
  color: PlayerColor;
  piece: Piece;
  x: number;
  y: number;
}

const position = (pieces: Placement[]): Tile[][] => {
  const grid = Array.from({ length: 3 }, (unusedRow, y) =>
    Array.from(
      { length: 3 },
      (unusedTile, x): Tile => ({
        occupant: 'Empty',
        occupantOwner: 'Neutral',
        ownerColor: 'Neutral',
        x,
        y,
      }),
    ),
  );
  pieces.forEach(({ color, piece, x, y }) => {
    grid[y]![x] = { ...grid[y]![x]!, occupant: piece, occupantOwner: color };
  });
  return grid;
};

/** Blue's `taker` on a1 takes Red's `victim` on b2, with a Red paper on c3. */
const exchange = (taker: Piece, victim: Piece) => ({
  before: position([
    { color: 'Blue', piece: taker, x: 0, y: 0 },
    { color: 'Red', piece: victim, x: 1, y: 1 },
    { color: 'Red', piece: 'Paper', x: 2, y: 2 },
  ]),
  after: position([
    { color: 'Blue', piece: taker, x: 1, y: 1 },
    { color: 'Red', piece: 'Paper', x: 2, y: 2 },
  ]),
});

/**
 * A live board carried from move 11 to move 12 as it was played: it stood at
 * the end of its line, and the line grew under it.
 */
const liveMove = (taker: Piece, victim: Piece, overrides: Partial<CaptureEffectInput> = {}) => ({
  ...exchange(taker, victim),
  step: { from: 11, to: 12 },
  lineEnd: 12,
  lineEndBefore: 11,
  sinceLastChange: 4000,
  reducedMotion: false,
  ...overrides,
});

/** Somebody stepping through a finished game of forty moves, onto move 12. */
const stepThroughRecord = (sinceLastChange: number, overrides: Partial<CaptureEffectInput> = {}) =>
  liveMove('Rock', 'Scissors', {
    lineEnd: 40,
    lineEndBefore: 40,
    sinceLastChange,
    ...overrides,
  });

describe('which capture effect plays', () => {
  it('plays the throw that won, for each of the three', () => {
    const played = (
      [
        ['Rock', 'Scissors'],
        ['Scissors', 'Paper'],
        ['Paper', 'Rock'],
      ] as const
    ).map(([taker, victim]) => {
      const decision = decideCaptureEffect(liveMove(taker, victim));
      return decision.play ? decision.matchup : decision.reason;
    });
    assert.deepEqual(played, ['rockTakesScissors', 'scissorsTakesPaper', 'paperTakesRock']);
  });

  it('says where the capture was and who made it', () => {
    const decision = decideCaptureEffect(liveMove('Paper', 'Rock'));
    assert.ok(decision.play);
    assert.deepEqual(decision.capture.from, { x: 0, y: 0 });
    assert.deepEqual(decision.capture.to, { x: 1, y: 1 });
    assert.deepEqual(decision.capture.attacker, { piece: 'Paper', color: 'Blue' });
    assert.deepEqual(decision.capture.victim, { piece: 'Rock', color: 'Red' });
    assert.equal(decision.live, true);
  });

  it('draws a mode’s own kinds by the artwork they borrow', () => {
    const { before, after } = exchange('Boulder', 'Shears');
    const looks = {
      Boulder: { symbol: 'B', art: 'rock' },
      Shears: { symbol: 'H', art: 'scissors' },
    };
    const decision = decideCaptureEffect({ ...liveMove('Rock', 'Scissors'), before, after, looks });
    assert.ok(decision.play);
    assert.equal(decision.matchup, 'rockTakesScissors');
  });

  it('is plain for kinds that are not drawn as a throw', () => {
    const { before, after } = exchange('Lizard', 'Spock');
    const decision = decideCaptureEffect({ ...liveMove('Rock', 'Scissors'), before, after });
    assert.deepEqual(decision, { play: false, reason: 'not-a-throw' });
  });

  it('is plain for a move that takes nothing', () => {
    const before = position([{ color: 'Blue', piece: 'Rock', x: 0, y: 0 }]);
    const after = position([{ color: 'Blue', piece: 'Rock', x: 1, y: 0 }]);
    const decision = decideCaptureEffect({ ...liveMove('Rock', 'Scissors'), before, after });
    assert.deepEqual(decision, { play: false, reason: 'no-capture' });
  });

  it('gives way to Reduce Motion', () => {
    const decision = decideCaptureEffect(liveMove('Rock', 'Scissors', { reducedMotion: true }));
    assert.deepEqual(decision, { play: false, reason: 'reduced-motion' });
  });
});

describe('when a capture effect plays', () => {
  it('plays on a live move however fast the game is going', () => {
    // A watched bot battle moves every 250ms; every capture in it is still a
    // capture happening now.
    const decision = decideCaptureEffect(liveMove('Rock', 'Scissors', { sinceLastChange: 250 }));
    assert.equal(decision.play, true);
  });

  it('plays on a step forward through a record taken on its own', () => {
    const decision = decideCaptureEffect(stepThroughRecord(1500));
    assert.ok(decision.play);
    assert.equal(decision.live, false);
  });

  it('is plain while somebody skims through a record', () => {
    assert.deepEqual(decideCaptureEffect(stepThroughRecord(SKIMMING_STEP_MS - 1)), {
      play: false,
      reason: 'skimming',
    });
    assert.equal(decideCaptureEffect(stepThroughRecord(SKIMMING_STEP_MS)).play, true);
  });

  it('counts a step onto the last move as a step, not as the game moving', () => {
    // A viewer who had stepped back and steps forward again lands where a live
    // move would, but the line did not grow under them.
    const decision = decideCaptureEffect(
      liveMove('Rock', 'Scissors', { lineEndBefore: 12, sinceLastChange: 100 }),
    );
    assert.deepEqual(decision, { play: false, reason: 'skimming' });
  });

  it('is plain on a step back over a capture', () => {
    const { before, after } = exchange('Rock', 'Scissors');
    const decision = decideCaptureEffect(
      stepThroughRecord(1500, { before: after, after: before, step: { from: 12, to: 11 } }),
    );
    assert.deepEqual(decision, { play: false, reason: 'no-capture' });
  });

  it('is plain on a jump of several moves', () => {
    const decision = decideCaptureEffect(stepThroughRecord(1500, { step: { from: 9, to: 12 } }));
    assert.deepEqual(decision, { play: false, reason: 'no-capture' });
  });

  it('follows the same rule on a board with no line behind it', () => {
    // The analysis board: a move played there is a step taken on its own, and
    // redo held down is skimming.
    const lineless = { step: null, lineEnd: null, lineEndBefore: null };
    assert.equal(decideCaptureEffect(stepThroughRecord(1500, lineless)).play, true);
    assert.deepEqual(decideCaptureEffect(stepThroughRecord(60, lineless)), {
      play: false,
      reason: 'skimming',
    });
  });
});

describe('an effect already playing when the board moves on', () => {
  const square = { x: 1, y: 1 };
  const { after: settled } = exchange('Rock', 'Scissors');
  const reply = (pieces: Placement[]) => ({
    before: settled,
    after: position(pieces),
    step: { from: 12, to: 13 },
  });

  it('finishes when the next move is somewhere else', () => {
    const elsewhere = reply([
      { color: 'Blue', piece: 'Rock', x: 1, y: 1 },
      { color: 'Red', piece: 'Paper', x: 2, y: 1 },
    ]);
    assert.equal(effectOutlivesStep(square, elsewhere), true);
  });

  it('ends when the next move lands on its square', () => {
    const retaken = reply([{ color: 'Red', piece: 'Paper', x: 1, y: 1 }]);
    assert.equal(effectOutlivesStep(square, retaken), false);
  });

  it('ends when the board steps back', () => {
    const { before } = exchange('Rock', 'Scissors');
    assert.equal(
      effectOutlivesStep(square, { before: settled, after: before, step: { from: 12, to: 11 } }),
      false,
    );
  });
});

describe('capture choreography', () => {
  const recipes = Object.entries(CHOREOGRAPHY);
  const tracks = (name: string, recipe: (typeof CHOREOGRAPHY)[keyof typeof CHOREOGRAPHY]) => {
    const found: [string, Keyframes][] = [];
    const collect = (prefix: string, motion: object) => {
      for (const [key, value] of Object.entries(motion)) {
        if (Array.isArray(value)) found.push([`${name}.${prefix}${key}`, value as Keyframes]);
      }
    };
    if (recipe.attackerScale) found.push([`${name}.attackerScale`, recipe.attackerScale]);
    collect('victim.', recipe.victim);
    collect('accent.', recipe.accent);
    return found;
  };
  const valueAt = (frames: Keyframes, ms: number) => {
    const first = frames[0]!;
    if (ms <= first[0]) return first[1];
    for (let index = 1; index < frames.length; index += 1) {
      const [end, to] = frames[index]!;
      const [start, from] = frames[index - 1]!;
      if (ms <= end) return from + ((to - from) * (ms - start)) / (end - start || 1);
    }
    return frames[frames.length - 1]![1];
  };

  it('stays inside the effect’s three hundred milliseconds', () => {
    assert.ok(CAPTURE_EFFECT_DURATION <= 300);
    for (const [name, recipe] of recipes) {
      for (const [track, frames] of tracks(name, recipe)) {
        // Two points at least: a native interpolation is a line between them.
        assert.ok(frames.length >= 2, `${track} needs two keyframes`);
        frames.forEach(([ms], index) => {
          assert.ok(ms >= 0 && ms <= CAPTURE_EFFECT_DURATION, `${track} runs past the effect`);
          if (index > 0) assert.ok(ms > frames[index - 1]![0], `${track} goes back in time`);
        });
      }
    }
  });

  it('starts with the piece that fell whole and where it stood', () => {
    for (const [name, { victim }] of recipes) {
      assert.equal(valueAt(victim.opacity, 0), 1, `${name} hides its victim at once`);
      if ('travel' in victim) assert.equal(valueAt(victim.travel, 0), 0, `${name} moves it`);
      if ('scale' in victim) assert.equal(valueAt(victim.scale, 0), 1, `${name} resizes it`);
    }
  });

  it('leaves nothing behind when it ends', () => {
    for (const [name, { victim, accent }] of recipes) {
      const end = CAPTURE_EFFECT_DURATION;
      assert.equal(valueAt(victim.opacity, end), 0, `${name} leaves its victim`);
      assert.equal(valueAt(accent.opacity, end), 0, `${name} leaves its mark`);
    }
  });

  it('hands the taker back at its own size before the move animation ends', () => {
    // The board's move animation is 230ms; after it the settled board draws the
    // piece at its ordinary size, so a taker still resized then would jump.
    const MOVE_ANIMATION_DURATION = 230;
    for (const [name, { attackerScale }] of recipes) {
      if (!attackerScale) continue;
      assert.equal(valueAt(attackerScale, 0), 1, `${name} resizes the taker before it sets off`);
      const last = attackerScale[attackerScale.length - 1]!;
      assert.equal(last[1], 1, `${name} leaves the taker resized`);
      assert.ok(last[0] <= ATTACKER_SETTLED_BY_MS, `${name} is still resizing the taker`);
      for (const impact of [0, IMPACT_MS, LATEST_IMPACT_MS]) {
        assert.ok(
          retime(last[0], impact) < MOVE_ANIMATION_DURATION,
          `${name} is still resizing the taker when the move ends, meeting at ${impact}ms`,
        );
      }
    }
  });

  it('strikes with its sound, as the move begins', () => {
    // Every capture clip hits on its first sample. The piece that fell starts
    // coming apart within a few frames of that, or the two read as separate.
    for (const [name, { victim }] of recipes) {
      const motion = 'travel' in victim ? victim.travel : victim.scale;
      const moving = motion.find(([, value], index) => index > 0 && value !== motion[0]![1]);
      assert.ok(moving, `${name} never moves its victim`);
      assert.ok(motion[0]![0] <= 50, `${name} starts after its sound has struck`);
    }
  });
});

describe('when the taker meets its victim', () => {
  const MOVE = 230;

  it('meets a step away at about 40ms, and a diagonal step away at about 60ms', () => {
    const orthogonal = impactAfter(1, MOVE);
    const diagonal = impactAfter(Math.SQRT2, MOVE);
    assert.ok(Math.abs(orthogonal - 42) <= 2, `orthogonal: ${orthogonal}`);
    assert.ok(Math.abs(diagonal - 62) <= 2, `diagonal: ${diagonal}`);
  });

  it('has already met a piece dropped on its victim', () => {
    assert.equal(impactAfter(0.3, MOVE), 0);
    assert.equal(impactAfter(0, MOVE), 0);
  });

  it('never meets later than the latest the recipes allow', () => {
    assert.equal(impactAfter(6, MOVE), LATEST_IMPACT_MS);
  });

  it('moves a recipe to the meeting and keeps its start and end', () => {
    for (const impact of [0, 25, IMPACT_MS, LATEST_IMPACT_MS]) {
      assert.equal(retime(0, impact), 0);
      assert.equal(retime(IMPACT_MS, impact), impact);
      assert.equal(retime(CAPTURE_EFFECT_DURATION, impact), CAPTURE_EFFECT_DURATION);
      let previous = -1;
      for (let ms = 0; ms <= CAPTURE_EFFECT_DURATION; ms += 5) {
        assert.ok(retime(ms, impact) >= previous, `retime goes back in time at ${ms}ms`);
        previous = retime(ms, impact);
      }
    }
  });

  it('keeps every recipe interpolable however early the meeting is', () => {
    for (const recipe of Object.values(CHOREOGRAPHY)) {
      const all = [
        recipe.attackerScale,
        ...Object.values(recipe.victim),
        ...Object.values(recipe.accent),
      ].filter((value): value is Keyframes => Array.isArray(value));
      for (const frames of all) {
        const { times } = keyframesFor(frames, 0);
        times.forEach((time, index) => {
          if (index > 0) assert.ok(time > times[index - 1]!, 'two keyframes at one time');
        });
      }
    }
  });
});
