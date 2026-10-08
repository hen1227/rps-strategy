import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SAME_OWNER_REASON,
  notEntered,
  rankedBlocker,
  rankedButton,
  rankedLine,
  rankedPress,
} from './rankedMatch.ts';
import type { ModeDefinition } from '../../types/game.ts';
import type { BotPresence, RankedMatchTerms } from '../../types/protocol.ts';

const MODES = [
  { id: 'V6', name: 'Intransitive' },
  { id: 'V5', name: 'Total War' },
] as unknown as ModeDefinition[];

const TERMS: RankedMatchTerms = {
  modes: ['V6'],
  clocks: [
    { initialTimeMs: 60_000, incrementMs: 1000 },
    { initialTimeMs: 180_000, incrementMs: 1000 },
  ],
  pairs: 1,
};

const engine = (botId: string, name: string, extra: Partial<BotPresence> = {}): BotPresence =>
  ({
    botId,
    userId: `${botId}-user`,
    name,
    elo: 1500,
    busy: false,
    allowPublicPlay: true,
    enterLadder: true,
    ...extra,
  }) as BotPresence;

const kestrel = engine('kestrel', 'Kestrel', { ownerUserId: 'ada' });
const wren = engine('wren', 'Wren', { ownerUserId: 'ada' });
const mocca = engine('mocca', 'Mocca', { ownerUserId: 'bea' });

const press = (first: BotPresence | null, second: BotPresence | null, extra = {}) =>
  rankedPress({ first, second, signedIn: true, ...extra });

test('one engine, anybody\'s, plays a random opponent', () => {
  assert.deepEqual(press(mocca, null), { kind: 'random', engine: mocca });
  // Either side: the empty one is the opponent wherever it is.
  assert.deepEqual(press(null, mocca), { kind: 'random', engine: mocca });
});

test('two engines play each other, whoever owns them', () => {
  assert.deepEqual(press(kestrel, mocca), { kind: 'chosen', first: kestrel, second: mocca });
  assert.deepEqual(rankedButton(press(kestrel, mocca)), {
    label: 'START RANKED ▶',
    action: 'Start a ranked match: Kestrel against Mocca',
  });
});

test('ranked says what it is missing rather than doing something else', () => {
  assert.deepEqual(press(wren, kestrel), { kind: 'none', reason: SAME_OWNER_REASON });
  assert.deepEqual(press(null, null), { kind: 'none', reason: 'PICK AN ENGINE' });
  assert.deepEqual(press(kestrel, null, { signedIn: false }), {
    kind: 'none',
    reason: 'SIGN IN TO PLAY RANKED',
  });
});

test("a host ranks any two engines at the host's own settings", () => {
  assert.equal(press(mocca, kestrel, { asHost: true }).kind, 'host');
  // One owner's two engines are never ranked, host or not.
  assert.equal(press(wren, kestrel, { asHost: true }).kind, 'none');
});

test('the blocker is what the server would refuse, said before the press', () => {
  const blocker = (made: ReturnType<typeof rankedPress>, extra = {}) =>
    rankedBlocker({ modeId: 'V6', modes: MODES, press: made, terms: TERMS, ...extra });

  assert.equal(blocker(press(kestrel, mocca)), null);
  assert.equal(blocker(press(kestrel, null)), null);
  assert.equal(blocker(press(kestrel, null), { modeId: 'V5' }), 'RANKED IS INTRANSITIVE ONLY');
  const withdrawn = engine('mocca', 'Mocca', { ownerUserId: 'bea', enterLadder: false });
  assert.equal(blocker(press(kestrel, withdrawn)), "MOCCA ISN'T IN THE RANKED LADDER");
  assert.equal(notEntered(press(kestrel, withdrawn)), withdrawn);
  assert.equal(blocker(press(kestrel, null), { available: 1 }), 'NO OTHER ENGINE IS FREE');
  assert.equal(blocker(press(kestrel, null), { terms: null }), 'RANKED IS UNAVAILABLE RIGHT NOW');
  // A pit ranked cannot use says why, in the same slot.
  assert.equal(blocker(press(wren, kestrel)), SAME_OWNER_REASON);
});

test('the bar says a ranked match in a few words', () => {
  assert.equal(rankedLine(press(kestrel, null), TERMS), '2 games vs a random opponent');
  assert.equal(rankedLine(press(kestrel, mocca), TERMS), '2 games');
  assert.equal(rankedLine(press(null, null), TERMS), '');
});
