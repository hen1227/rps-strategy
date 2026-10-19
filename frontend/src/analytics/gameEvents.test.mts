import assert from 'node:assert/strict';
import test from 'node:test';

import { createGameObserver, type ObservedBoard, type ObservedGame } from './gameEvents.ts';

const board = (patch: Partial<ObservedBoard> = {}): ObservedBoard => ({
  gameId: 'game-1',
  status: 'InProgress',
  moveNumber: 0,
  winner: 'Neutral',
  mode: { id: 'V6' },
  timeControl: { initialTimeMs: 300_000, incrementMs: 3_000 },
  redPlayer: { userId: 'me' },
  bluePlayer: { userId: 'them' },
  ...patch,
});

const store = (gameState: ObservedBoard | null, patch: Partial<ObservedGame> = {}): ObservedGame => ({
  gameState,
  playerColor: 'Red',
  isSpectating: false,
  engineBots: [],
  ...patch,
});

test('an online game is counted when it starts and when it ends', () => {
  const observe = createGameObserver();
  const started = observe(store(board()), store(null));
  assert.deepEqual(started, [
    {
      name: 'game_start',
      params: { mode: 'V6', kind: 'online', opponent: 'human', time_control: '300+3' },
    },
  ]);

  assert.deepEqual(observe(store(board({ moveNumber: 1 })), store(board())), []);

  const ended = observe(
    store(board({ status: 'Finished', winner: 'Blue', endReason: 'timeout', moveNumber: 30 })),
    store(board({ moveNumber: 29 })),
  );
  assert.deepEqual(ended, [
    {
      name: 'game_end',
      params: {
        mode: 'V6',
        kind: 'online',
        opponent: 'human',
        result: 'loss',
        end_reason: 'timeout',
        moves: 30,
      },
    },
  ]);
});

// A reload restores the board mid-game. That is not a new game, and a game
// that was already over when it was opened did not end now.
test('a restored game is not a start, and an already-finished one is not an end', () => {
  const observe = createGameObserver();
  assert.deepEqual(observe(store(board({ moveNumber: 12 })), store(null)), []);
  assert.deepEqual(observe(store(board({ gameId: 'old', status: 'Finished' })), store(null)), []);
});

test('watching somebody else is neither', () => {
  const observe = createGameObserver();
  const watching = { isSpectating: true, playerColor: null };
  assert.deepEqual(observe(store(board(), watching), store(null, watching)), []);
  assert.deepEqual(
    observe(store(board({ status: 'Finished' }), watching), store(board(), watching)),
    [],
  );
});

test('an engine on the other side is a bot, by its account or by the roster', () => {
  const byAccount = createGameObserver()(
    store(board({ bluePlayer: { userId: 'bot-abc' } })),
    store(null),
  );
  assert.equal(byAccount[0]?.params.opponent, 'bot');

  const byRoster = createGameObserver()(
    store(board(), { engineBots: [{ userId: 'them' }] }),
    store(null),
  );
  assert.equal(byRoster[0]?.params.opponent, 'bot');
});

test('practice and pass-and-play games are told apart by their IDs', () => {
  const practice = createGameObserver()(store(board({ gameId: 'bot-pebble-V6-1' })), store(null));
  assert.equal(practice[0]?.params.kind, 'practice');
  assert.equal(practice[0]?.params.opponent, 'bot');

  const observe = createGameObserver();
  const local = board({ gameId: 'local-V6-1' });
  assert.equal(observe(store(local), store(null))[0]?.params.kind, 'local');
  const decided = observe(
    store({ ...local, status: 'Finished', winner: 'Red', endReason: 'annihilation' }),
    store(local),
  );
  assert.equal(decided[0]?.name, 'game_end');
  assert.equal(decided[0]?.name === 'game_end' && decided[0].params.result, 'decided');
});

// Pass-and-play can be undone after it ends and finished again. That is one game.
test('a game is reported once, whatever the store does to it afterwards', () => {
  const observe = createGameObserver();
  const local = board({ gameId: 'local-V6-2', moveNumber: 9 });
  const finished = { ...local, status: 'Finished' as const, winner: 'Red' as const };
  assert.equal(observe(store(finished), store(local)).length, 1);
  assert.equal(observe(store(local), store(finished)).length, 0);
  assert.equal(observe(store(finished), store(local)).length, 0);
});
