import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ANDROID_HAPTIC_SINCE,
  ANDROID_MIN_API,
  BUZZ_FALLBACK,
  BUZZ_PATTERNS,
  HAPTIC_RECIPES,
  MIN_TICK_GAP_MS,
  androidHapticFor,
  burstOffsets,
  countUpSchedule,
  type HapticEvent,
} from './recipes.ts';

const EVENTS = Object.keys(HAPTIC_RECIPES) as HapticEvent[];

describe('the recipe table', () => {
  it('ends every Android chain in a constant every supported phone has', () => {
    // expo-haptics throws for a constant the phone's Android lacks, so a chain
    // whose last resort is too new is a rejected promise on an older phone.
    for (const event of EVENTS) {
      const chain = HAPTIC_RECIPES[event].android;
      assert.ok(chain.length > 0, `${event} has an Android recipe`);
      const last = chain[chain.length - 1]!;
      assert.ok(
        ANDROID_HAPTIC_SINCE[last] <= ANDROID_MIN_API,
        `${event} falls back to ${last}, which needs API ${ANDROID_HAPTIC_SINCE[last]}`,
      );
    }
  });

  it('lists each chain newest first, so the first one that fits is the best one', () => {
    for (const event of EVENTS) {
      const levels = HAPTIC_RECIPES[event].android.map((constant) => ANDROID_HAPTIC_SINCE[constant]);
      assert.deepEqual(levels, [...levels].sort((a, b) => b - a), event);
    }
  });

  it('picks the constant the phone can play', () => {
    assert.equal(androidHapticFor('pickUp', 30), 'gesture-start');
    assert.equal(androidHapticFor('pickUp', 29), 'virtual-key');
    assert.equal(androidHapticFor('refused', 30), 'reject');
    assert.equal(androidHapticFor('refused', 29), 'context-click');
    assert.equal(androidHapticFor('step', 34), 'segment-tick');
    assert.equal(androidHapticFor('step', 33), 'context-click');
    assert.equal(androidHapticFor('theirMove', 24), 'keyboard-tap');
  });

  // What Android 15 plays for each constant, read off `dumpsys vibrator_manager`
  // on an emulator: the system picks the feel, so the ladder has to be checked
  // against what it plays rather than against the constants' names.
  const PLAYS: Record<string, number> = {
    // TICK, or the toggles' tick primitive: a detent.
    'context-click': 1,
    'segment-tick': 1,
    'toggle-on': 1,
    'toggle-off': 1,
    // CLICK, and REJECT's DOUBLE_CLICK beside it.
    'virtual-key': 2,
    'keyboard-tap': 2,
    'gesture-start': 2,
    confirm: 2,
    reject: 2,
    // HEAVY_CLICK.
    'long-press': 3,
  };
  const weight = (event: HapticEvent) => PLAYS[androidHapticFor(event, 35)]!;

  it('keeps the Android ladder: detents under moves under captures', () => {
    for (const event of EVENTS) assert.ok(weight(event), `${event} plays something known`);
    for (const detent of ['hover', 'step', 'choose'] as const) {
      assert.ok(weight(detent) < weight('commit'), `${detent} is lighter than a move`);
    }
    for (const everyMove of ['pickUp', 'commit', 'theirMove'] as const) {
      assert.ok(weight(everyMove) < weight('captureCommit'), `${everyMove} is lighter than a capture`);
    }
    assert.ok(weight('stop') > weight('step'), 'the end of the game is firmer than a step');
    assert.equal(weight('loss'), weight('captured'));
  });

  it('feels a capture the same whichever side made it', () => {
    assert.deepEqual(HAPTIC_RECIPES.captureCommit, HAPTIC_RECIPES.captured);
  });

  it('gives each buzz an Android pattern and a tap to fall back to', () => {
    for (const moment of ['gameStart', 'lowClock'] as const) {
      const pattern = BUZZ_PATTERNS[moment];
      // Wait first, then alternate buzz and gap: an even count ends on a buzz.
      assert.equal(pattern[0], 0);
      assert.equal(pattern.length % 2, 0);
      assert.ok(HAPTIC_RECIPES[BUZZ_FALLBACK[moment]]);
    }
  });
});

describe('a number counting up', () => {
  it('ticks once per unit when there is room', () => {
    const steps = countUpSchedule(0, 12);
    assert.deepEqual(
      steps.map((step) => step.value),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    );
  });

  it('takes bigger steps for a big number and still lands on it', () => {
    const steps = countUpSchedule(0, 81, { maxSpanMs: 700 });
    assert.ok(steps.length <= 24);
    assert.equal(steps.at(-1)?.value, 81);
    const values = steps.map((step) => step.value);
    assert.deepEqual(values, [...new Set(values)], 'no step repeats a value');
  });

  it('counts down as readily as up', () => {
    const steps = countUpSchedule(1500, 1488);
    assert.equal(steps.length, 12);
    assert.equal(steps[0]?.value, 1499);
    assert.equal(steps.at(-1)?.value, 1488);
  });

  it('has nothing to say when nothing changed', () => {
    assert.deepEqual(countUpSchedule(1500, 1500), []);
    // A rating that moved by less than half a point reads the same both ways.
    assert.deepEqual(countUpSchedule(1500.2, 1499.8), []);
  });

  it('keeps every tap far enough apart to be felt, and inside its time', () => {
    for (const [from, to, maxSpanMs] of [
      [0, 3, 600],
      [0, 40, 600],
      [0, 81, 700],
      [1612, 1571, 600],
      [0, 200, 100],
    ] as const) {
      const steps = countUpSchedule(from, to, { maxSpanMs });
      let previous = 0;
      for (const step of steps) {
        assert.ok(step.atMs - previous >= MIN_TICK_GAP_MS - 1, `${from}→${to} at ${step.atMs}`);
        previous = step.atMs;
      }
      assert.ok(previous <= maxSpanMs, `${from}→${to} ends at ${previous}`);
      assert.equal(steps.at(-1)?.value, to);
    }
  });

  it('is over almost at once for a small change', () => {
    assert.ok((countUpSchedule(0, 1)[0]?.atMs ?? Infinity) <= 70);
  });
});

describe('a jump across many moves', () => {
  it('taps from the press to the landing', () => {
    const offsets = burstOffsets(40, 220);
    assert.equal(offsets[0], 0);
    assert.equal(offsets.at(-1), 220);
    assert.ok(offsets.length <= 7);
  });

  it('taps no more often than can be felt', () => {
    const offsets = burstOffsets(5, 72);
    for (let index = 1; index < offsets.length; index += 1) {
      assert.ok(offsets[index]! - offsets[index - 1]! >= MIN_TICK_GAP_MS);
    }
  });

  it('taps once for one move, and not at all for none', () => {
    assert.deepEqual(burstOffsets(1, 72), [0]);
    assert.deepEqual(burstOffsets(0, 72), []);
  });
});
