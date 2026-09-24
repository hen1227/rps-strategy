import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NO_PIT_PICK,
  canStartSeries,
  clearedPitPick,
  nextPitPick,
  pitBarView,
  sameBotOwner,
  seriesSettingsLine,
  swappedPitPick,
} from './pitSelection.ts';
import type { ModeDefinition, TimeControl } from '../../types/game.ts';
import type { BotPresence } from '../../types/protocol.ts';

const MODE = { id: 'V5', shortCode: 'V5', name: 'Total War', playable: true } as
  unknown as ModeDefinition;

const CLOCK: TimeControl = { initialTimeMs: 60_000, incrementMs: 1000 };

const engineBot = (
  botId: string,
  name: string,
  extra: Partial<BotPresence> = {},
): BotPresence =>
  ({
    botId,
    userId: `${botId}-user`,
    name,
    elo: 1500,
    busy: false,
    allowPublicPlay: true,
    ...extra,
  }) as BotPresence;

test('a press fills the first side, then the second', () => {
  const one = nextPitPick(NO_PIT_PICK, 'alt');
  assert.deepEqual(one, { first: 'alt', second: null });
  assert.deepEqual(nextPitPick(one, 'mocca'), { first: 'alt', second: 'mocca' });
});

test('pressing an engine that is already entered takes it out of its own side', () => {
  const both = { first: 'alt', second: 'mocca' };
  assert.deepEqual(nextPitPick(both, 'alt'), { first: null, second: 'mocca' });
  assert.deepEqual(nextPitPick(both, 'mocca'), { first: 'alt', second: null });
});

test('an empty first side is filled before an occupied second is disturbed', () => {
  assert.deepEqual(nextPitPick({ first: null, second: 'mocca' }, 'alt'), {
    first: 'alt',
    second: 'mocca',
  });
});

test('a third press keeps the two most recent, so the roster can be walked', () => {
  // The rule that lets somebody compare engine after engine against the one
  // they just chose, without emptying a slot between each pair.
  const both = { first: 'alt', second: 'mocca' };
  assert.deepEqual(nextPitPick(both, 'rpsfish'), { first: 'mocca', second: 'rpsfish' });
  // And again: the newcomer becomes the second, never the first.
  assert.deepEqual(nextPitPick(nextPitPick(both, 'rpsfish'), 'boulder'), {
    first: 'rpsfish',
    second: 'boulder',
  });
});

test('a side can be cleared and the two sides exchanged', () => {
  const both = { first: 'alt', second: 'mocca' };
  assert.deepEqual(clearedPitPick(both, 'first'), { first: null, second: 'mocca' });
  assert.deepEqual(clearedPitPick(both, 'second'), { first: 'alt', second: null });
  assert.deepEqual(swappedPitPick(both), { first: 'mocca', second: 'alt' });
  assert.deepEqual(swappedPitPick({ first: 'alt', second: null }), {
    first: null,
    second: 'alt',
  });
});

test('two engines one person registered make a casual run', () => {
  const mine = engineBot('alt', 'ALTFish', { ownerUserId: 'henry' });
  const also = engineBot('mocca', 'Mocca', { ownerUserId: 'henry' });
  const theirs = engineBot('rpsfish', 'RPSFish', { ownerUserId: 'someone-else' });
  assert.equal(sameBotOwner(mine, also), true);
  assert.equal(sameBotOwner(mine, theirs), false);
});

test('two engines with no owner on the roster are not one owner', () => {
  // The subtle one: absent `ownerUserId` compared as strings would read as one
  // person owning both, and mark a rated run casual.
  const anonymous = engineBot('alt', 'ALTFish');
  const other = engineBot('mocca', 'Mocca');
  assert.equal(sameBotOwner(anonymous, other), false);
  assert.equal(sameBotOwner(anonymous, null), false);
  assert.equal(sameBotOwner(null, null), false);
});

test('a run needs two different engines, a mode, and nothing in flight', () => {
  const alt = engineBot('alt', 'ALTFish');
  const mocca = engineBot('mocca', 'Mocca');
  const ready = { busy: false, first: alt, mode: MODE, second: mocca };
  assert.equal(canStartSeries(ready), true);
  assert.equal(canStartSeries({ ...ready, busy: true }), false);
  assert.equal(canStartSeries({ ...ready, second: null }), false);
  assert.equal(canStartSeries({ ...ready, first: null }), false);
  assert.equal(canStartSeries({ ...ready, second: alt }), false);
  assert.equal(canStartSeries({ ...ready, mode: null }), false);
});

test('the run reads the same whoever asks for the line', () => {
  assert.equal(
    seriesSettingsLine({ clock: CLOCK, mode: MODE, pairs: '2' }),
    'Total War · 2 pairs, colours swapped · 1+1',
  );
  assert.equal(
    seriesSettingsLine({ casual: true, clock: CLOCK, mode: MODE, pairs: '3' }),
    'Total War · 3 pairs, colours swapped · 1+1 · casual',
  );
});

test('the bar stays away until an engine is entered', () => {
  const view = pitBarView({
    available: 4,
    clock: CLOCK,
    first: null,
    mode: MODE,
    pairs: '2',
    second: null,
  });
  assert.equal(view.visible, false);
});

test('one engine entered asks for the other, on the side that is empty', () => {
  const alt = engineBot('alt', 'ALTFish');
  const second = pitBarView({
    available: 4,
    clock: CLOCK,
    first: alt,
    mode: MODE,
    pairs: '2',
    second: null,
  });
  assert.equal(second.visible, true);
  assert.equal(second.empty, 'second');
  assert.equal(second.hint, 'PICK A SECOND ENGINE');

  // Which side matters: the first engine opens game one of every pair, so the
  // `?` does not migrate to the right.
  const first = pitBarView({
    available: 4,
    clock: CLOCK,
    first: null,
    mode: MODE,
    pairs: '2',
    second: alt,
  });
  assert.equal(first.empty, 'first');
  assert.equal(first.hint, 'PICK A FIRST ENGINE');
});

test('with nothing left to press the bar stops asking for a press', () => {
  const alt = engineBot('alt', 'ALTFish');
  const view = pitBarView({
    available: 1,
    clock: CLOCK,
    first: alt,
    mode: MODE,
    pairs: '2',
    second: null,
  });
  assert.equal(view.visible, true);
  assert.equal(view.hint, 'NO OTHER ENGINE IS FREE');
});

test('both entered, the bar describes the run and names the fight', () => {
  const view = pitBarView({
    available: 4,
    clock: CLOCK,
    first: engineBot('alt', 'ALTFish', { ownerUserId: 'henry' }),
    mode: MODE,
    pairs: '2',
    second: engineBot('mocca', 'Mocca', { ownerUserId: 'someone-else' }),
  });
  assert.equal(view.hint, null);
  assert.equal(view.settings, 'Total War · 2 pairs, colours swapped · 1+1');
  assert.equal(view.label, 'START SERIES ▶');
  assert.equal(view.action, 'Start a 2-pair Total War series: ALTFish against Mocca');
});

test('one owner both sides says casual on the button as well as the line', () => {
  const view = pitBarView({
    available: 4,
    clock: CLOCK,
    first: engineBot('alt', 'ALTFish', { ownerUserId: 'henry' }),
    mode: MODE,
    pairs: '2',
    second: engineBot('mocca', 'Mocca', { ownerUserId: 'henry' }),
  });
  assert.equal(view.label, 'START CASUAL SERIES ▶');
  assert.equal(view.settings, 'Total War · 2 pairs, colours swapped · 1+1 · casual');
  assert.equal(view.action, 'Start a 2-pair casual Total War series: ALTFish against Mocca');
});
