import assert from 'node:assert/strict';
import test from 'node:test';

import { createBotSlice, type BotSlice } from './botSession.ts';
import type { ActiveGame } from './types.ts';
import { testMode } from '../testing/modes.ts';
import type { Move, Position, SideColor } from '../types/game.ts';
import type { Account } from '../types/protocol.ts';

// The slice is driven directly rather than through `useGameStore`, the same way
// `localSession.test.mts` does it: a `StateCreator` is a function of `set` and
// `get`, so a plain object is a whole store. No socket, so `send` is a no-op,
// and no Worker, so a bot whose turn it is fails its search and says so — which
// is fine here, because what is under test is who sits where.

interface Harness {
  account: Account | null;
  accountId: string;
  gameState: ActiveGame | null;
  socket: WebSocket | null;
  playerColor: SideColor | null;
  isSpectating: boolean;
  spectatedGameId: string | null;
  lastMove: Move | null;
  selectedTile: Position | null;
  validMoves: Position[];
  opponentReconnectDeadline: number | null;
  chatMessages: unknown[];
  chatRoomId: string | null;
  error: string | null;
}

type Store = BotSlice & Harness;
type Setter = (patch: Partial<Store> | ((current: Store) => Partial<Store>)) => void;
type Getter = () => Store;

const openStore = () => {
  let state = {} as Store;
  const set: Setter = (patch) => {
    state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
  };
  const get: Getter = () => state;
  const create = createBotSlice as unknown as (
    set: Setter,
    get: Getter,
    api: unknown,
  ) => BotSlice;

  state = {
    ...create(set, get, {}),
    account: null,
    accountId: 'player',
    gameState: null,
    socket: null,
    playerColor: null,
    isSpectating: false,
    spectatedGameId: null,
    lastMove: null,
    selectedTile: null,
    validMoves: [],
    opponentReconnectDeadline: null,
    chatMessages: [],
    chatRoomId: null,
    error: null,
  };
  return get;
};

/** Who is on which side, read back off the snapshot the screen renders. */
const seats = (get: Getter) => {
  const session = get().botSession;
  const game = get().gameState;
  assert.ok(session && game, 'expected a bot game to be open');
  return {
    bot: session.botColor,
    choice: session.colorChoice,
    player: session.playerColor,
    // The published game must agree with the session, or the board draws one
    // seating and the player bar another.
    playerIsNamed: (game[session.playerColor === 'Red' ? 'redPlayer' : 'bluePlayer'] ?? null)
      ?.userId,
    botIsNamed: (game[session.botColor === 'Red' ? 'redPlayer' : 'bluePlayer'] ?? null)?.userId,
  };
};

for (const wanted of ['Red', 'Blue'] as const) {
  test(`a player who chooses ${wanted} gets it, and the bot takes the other side`, () => {
    const get = openStore();
    get().startBotGame({ mode: testMode('V5'), playerColor: wanted, profileId: 'pebble' });

    const seating = seats(get);
    assert.equal(seating.player, wanted);
    assert.notEqual(seating.bot, wanted);
    assert.equal(get().playerColor, wanted);
    assert.equal(seating.playerIsNamed, 'player');
    assert.equal(seating.botIsNamed, 'bot:pebble');
  });
}

test('asking for either side still deals one', () => {
  const get = openStore();
  get().startBotGame({ mode: testMode('V5'), profileId: 'pebble' });

  const seating = seats(get);
  assert.ok(seating.player === 'Red' || seating.player === 'Blue');
  assert.notEqual(seating.bot, seating.player);
  assert.equal(seating.choice, 'random');
});

// The point of recording the choice rather than only the seat: a rematch has to
// tell "I asked for Red" apart from "I was dealt Red".
test('a rematch keeps the side the player chose', () => {
  const get = openStore();
  get().startBotGame({ mode: testMode('V5'), playerColor: 'Blue', profileId: 'pebble' });

  for (let rematch = 0; rematch < 3; rematch += 1) {
    get().restartBotGame();
    assert.equal(seats(get).player, 'Blue', `rematch ${rematch + 1} moved the player`);
  }
});

test('a rematch alternates the side when the player did not choose one', () => {
  const get = openStore();
  get().startBotGame({ mode: testMode('V5'), profileId: 'pebble' });

  let previous = seats(get).player;
  for (let rematch = 0; rematch < 3; rematch += 1) {
    get().restartBotGame();
    const seating = seats(get);
    assert.notEqual(seating.player, previous, `rematch ${rematch + 1} repeated a side`);
    // And it is still an unchosen side, so the next rematch alternates too.
    assert.equal(seating.choice, 'random');
    previous = seating.player;
  }
});

test('a rematch opens a fresh board against the same bot', () => {
  const get = openStore();
  const mode = testMode('V5');
  get().startBotGame({ mode, playerColor: 'Red', profileId: 'pebble' });
  get().botSelectTile({ x: 3, y: 6 });
  get().botSelectTile({ x: 3, y: 5 });
  assert.equal(get().botMoves.length, 1, 'test setup: expected the opening move to land');

  get().restartBotGame();
  assert.equal(get().botHistory.length, 0);
  assert.equal(get().botMoves.length, 0);
  assert.equal(get().botSession?.profileId, 'pebble');
  assert.equal(get().botGame?.mode.id, mode.id);
});
