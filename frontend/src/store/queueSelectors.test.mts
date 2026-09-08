import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FIRST_MOVE_CRITICAL_MS,
  FIRST_MOVE_WINDOW_MS,
  MISS_NOTICE_MS,
  QUEUE_COPY,
  firstMoveCall,
  formatCountdown,
  formatWait,
  lobbyGate,
  queueCallState,
  updatePausedReason,
  waitingPresence,
  type QueueSource,
} from './queueSelectors.ts';
import type { QueueState } from './types.ts';
import type { Challenge } from '../types/protocol.ts';
import type { ModeDefinition } from '../types/game.ts';

const NOW = 1_800_000_000_000;

const MODES = [
  { id: 'V5', name: 'Total War' },
  { id: 'V3', name: 'Infiltration' },
] as unknown as ModeDefinition[];

const idleQueue = (): QueueState => ({
  isSearching: false,
  modeId: null,
  setup: null,
  searchRange: 10000,
  queuedSinceUnixMs: null,
});

const searching = (waitedMs = 0): QueueState => ({
  isSearching: true,
  modeId: 'V5',
  setup: null,
  searchRange: 100,
  queuedSinceUnixMs: NOW - waitedMs,
});

const emptySource = (): QueueSource => ({
  queue: idleQueue(),
  miss: null,
  outgoingChallenge: null,
  connectionStatus: 'connected',
  modes: MODES,
  atOwnBoard: false,
  pushLive: false,
  canOfferAlerts: true,
  updating: false,
  nowMs: NOW,
});

const openChallenge = (overrides: Partial<Challenge> = {}): Challenge =>
  ({
    id: 'post-1',
    challenger: { userId: 'me', username: 'Me' },
    modeName: 'Total War',
    setup: {},
    present: true,
    createdAtUnixMs: NOW - 30_000,
    ...overrides,
  }) as unknown as Challenge;

/* ------------------------------------------------------------ precedence -- */

test('nothing to wait on produces no call', () => {
  assert.equal(queueCallState(emptySource()), null);
});

test('sitting at your own board hides the bar', () => {
  const call = queueCallState({ ...emptySource(), queue: searching(), atOwnBoard: true });
  assert.equal(call, null);
});

// Queueing while practising against a bot is an existing, supported flow, so
// the bar has to stay: atOwnBoard is about a *real* board.
test('a bot game does not hide the bar', () => {
  const call = queueCallState({ ...emptySource(), queue: searching(), atOwnBoard: false });
  assert.equal(call?.kind, 'searching_tethered');
});

test('alerts off means the tab has to stay open', () => {
  const call = queueCallState({ ...emptySource(), queue: searching(), pushLive: false });
  assert.equal(call?.kind, 'searching_tethered');
  assert.equal(call?.offerAlerts, true);
});

test('alerts on means you can walk away', () => {
  const call = queueCallState({ ...emptySource(), queue: searching(), pushLive: true });
  assert.equal(call?.kind, 'searching_untethered');
  assert.equal(call?.offerAlerts, false);
});

test('a snoozed or impossible offer is not made', () => {
  const call = queueCallState({
    ...emptySource(),
    queue: searching(),
    canOfferAlerts: false,
  });
  assert.equal(call?.offerAlerts, false);
});

test('a dropped socket pauses the search rather than ending it', () => {
  for (const status of ['disconnected', 'connecting', 'rejoining'] as const) {
    const call = queueCallState({
      ...emptySource(),
      queue: searching(),
      connectionStatus: status,
    });
    assert.equal(call?.kind, 'reconnecting', status);
  }
});

test('a cancelled-game notice shows briefly and then gives way', () => {
  const source = {
    ...emptySource(),
    queue: searching(),
    miss: { message: 'gone', atUnixMs: NOW - 1_000 },
  };
  assert.equal(queueCallState(source)?.kind, 'missed');
  assert.equal(
    queueCallState({ ...source, nowMs: NOW + MISS_NOTICE_MS })?.kind,
    'searching_tethered',
  );
});

// The regression test for "your wait is preserved": the notice reports the
// whole search, not the thirty seconds that were just wasted.
test('the wait shown after a cancelled game is the whole search', () => {
  const call = queueCallState({
    ...emptySource(),
    queue: searching(9 * 60_000),
    miss: { message: 'gone', atUnixMs: NOW - 500 },
  });
  assert.equal(call?.kind, 'missed');
  assert.ok(call!.waitedMs > FIRST_MOVE_WINDOW_MS);
  assert.equal(QUEUE_COPY.missed.detail(call!), 'Back to searching · 9m 00s in, and your place is intact');
});

test('a posted game is shown when nothing else is', () => {
  const call = queueCallState({ ...emptySource(), outgoingChallenge: openChallenge() });
  assert.equal(call?.kind, 'posted');
  assert.equal(call?.challengeId, 'post-1');
  assert.equal(call?.waitedMs, 30_000);
});

test('a game posted to one person says so', () => {
  const call = queueCallState({
    ...emptySource(),
    outgoingChallenge: openChallenge({ targetUsername: 'Ada' }),
  });
  assert.equal(QUEUE_COPY.posted.title(call!), 'Waiting for Ada to answer');
  assert.equal(QUEUE_COPY.posted.detail(call!), '30s in · only they can see it');
});

test('a search outranks a posted game rather than throwing', () => {
  const call = queueCallState({
    ...emptySource(),
    queue: searching(),
    outgoingChallenge: openChallenge(),
  });
  assert.equal(call?.kind, 'searching_tethered');
});

/* ------------------------------------------------------------ formatters -- */

test('elapsed time reads naturally either side of a minute', () => {
  assert.equal(formatWait(0), '0s');
  assert.equal(formatWait(9_000), '9s');
  assert.equal(formatWait(59_999), '59s');
  assert.equal(formatWait(60_000), '1m 00s');
  assert.equal(formatWait(754_000), '12m 34s');
  assert.equal(formatWait(-5), '0s');
});

test('a countdown rounds up and clamps', () => {
  assert.equal(formatCountdown(29_100), '30s');
  assert.equal(formatCountdown(1), '1s');
  assert.equal(formatCountdown(0), '0s');
  assert.equal(formatCountdown(-500), '0s');
});

// Catches a future kind added without copy to go with it.
test('every call kind has usable copy', () => {
  const call = queueCallState({ ...emptySource(), queue: searching() })!;
  for (const [kind, copy] of Object.entries(QUEUE_COPY)) {
    assert.ok(copy.title({ ...call, kind } as typeof call).length > 0, kind);
    assert.ok(copy.detail({ ...call, kind } as typeof call).length > 0, kind);
    // A native line is optional, but one that exists has to say something.
    assert.ok((copy.nativeDetail?.({ ...call, kind } as typeof call) ?? 'x').length > 0, kind);
    assert.equal(copy.action, copy.action.toUpperCase(), kind);
  }
});

// A search cannot end while the server is draining: pairing has stopped for the
// duration. A card counting up as though a game might arrive is the state
// somebody sits in for the whole of a deploy and then loses without ever being
// told why, so the wait says what it is waiting on.
test('a drain says the search is paused rather than counting up', () => {
  const call = queueCallState({ ...emptySource(), queue: searching(45_000), updating: true });
  assert.equal(call?.kind, 'paused_for_update');
  assert.equal(call?.offerAlerts, false);
});

// A posted game is the same wait: nobody can take it while the board is not
// pairing. It keeps its id, because cancelling it is still what the button does.
test('a drain pauses a posted game too, without losing the seek', () => {
  const call = queueCallState({
    ...emptySource(),
    outgoingChallenge: openChallenge(),
    updating: true,
  });
  assert.equal(call?.kind, 'paused_for_update');
  assert.equal(call?.challengeId, 'post-1');
});

// Losing the socket still outranks it. Both are stopped waits, and the one the
// player can do something about — reconnecting — is the more immediate fact.
test('a dead socket outranks a drain', () => {
  const call = queueCallState({
    ...emptySource(),
    queue: searching(),
    connectionStatus: 'disconnected',
    updating: true,
  });
  assert.equal(call?.kind, 'reconnecting');
});

/* ------------------------------------------------------------------ gate -- */

const gateSource = (overrides: Partial<Parameters<typeof lobbyGate>[0]> = {}) => ({
  connectionStatus: 'connected' as const,
  atOwnBoard: false,
  outgoingChallenge: null,
  queue: idleQueue(),
  signedIn: true,
  updating: false,
  ...overrides,
});

// The regression test for the five blanket busy flags: being queued must not
// stop you taking somebody's game, or the app is read-only while you wait.
test('being queued does not put you at a board', () => {
  const gate = lobbyGate(gateSource({ queue: searching() }));
  assert.equal(gate.atBoard, false);
  assert.equal(gate.seekTaken, true);
});

test('a real game and a dead socket both count as being at a board', () => {
  assert.equal(lobbyGate(gateSource({ atOwnBoard: true })).atBoard, true);
  assert.equal(lobbyGate(gateSource({ connectionStatus: 'disconnected' })).atBoard, true);
});

test('an outgoing challenge is already a seek', () => {
  assert.equal(lobbyGate(gateSource({ outgoingChallenge: openChallenge() })).seekTaken, true);
});

// Ranked play needs an account, and that is the *only* thing being signed out
// changes here. A guest can still take a casual game off the board and still
// press play, so folding this into `atBoard` would make the lobby read-only for
// exactly the people most likely to be trying it for the first time.
test('being signed out asks for an account without closing the lobby', () => {
  const guest = lobbyGate(gateSource({ signedIn: false }));
  assert.equal(guest.needsAccount, true);
  assert.equal(guest.atBoard, false);
  assert.equal(guest.seekTaken, false);
});

test('being signed in asks for nothing', () => {
  assert.equal(lobbyGate(gateSource()).needsAccount, false);
});

// A drain is not a fact about this player: their socket is up and the board
// they are already at is unaffected. What has stopped is pairing, so the reason
// is its own flag rather than a fourth thing folded into `atBoard`.
test('a drain pauses new games without putting anybody at a board', () => {
  const paused = lobbyGate(gateSource({ updating: true }));
  assert.equal(paused.paused, true);
  assert.equal(paused.atBoard, false);
  assert.equal(paused.seekTaken, false);
});

test('the four reasons are independent of one another', () => {
  const busyGuest = lobbyGate(
    gateSource({ signedIn: false, atOwnBoard: true, queue: searching() }),
  );
  assert.deepEqual(busyGuest, {
    atBoard: true,
    paused: false,
    seekTaken: true,
    needsAccount: true,
  });
});

// The note is the half of this sentence that says how long it is for, and the
// fallback is what stops "paused" reading as broken when there is no note.
test('the paused reason carries the administrator sentence, or stands without one', () => {
  assert.ok(updatePausedReason('Back in two minutes.').startsWith('Back in two minutes.'));
  assert.ok(updatePausedReason('   ').includes('The server is restarting.'));
  assert.ok(updatePausedReason().includes('New games are paused'));
});

/* ---------------------------------------------------------------- board -- */

test('the board separates people who are here from people who are away', () => {
  const rows = [
    openChallenge({ id: 'a', present: true }),
    openChallenge({ id: 'b', present: false }),
    openChallenge({ id: 'c', present: false }),
  ];
  assert.deepEqual(waitingPresence(rows), { total: 3, here: 1, away: 2 });
});

/* ----------------------------------------------------------- first move -- */

test('a board with no deadline says nothing', () => {
  assert.equal(firstMoveCall(null, true, 'Ada', NOW), null);
  assert.equal(firstMoveCall(0, true, 'Ada', NOW), null);
});

test('the player to move is told the clock is waiting on them', () => {
  const call = firstMoveCall(NOW + 22_000, true, 'Ada', NOW)!;
  assert.equal(call.yours, true);
  assert.match(call.title, /Your move/);
  assert.match(call.detail, /^22s to play it/);
});

test('the other player is told who is being waited for', () => {
  const call = firstMoveCall(NOW + 22_000, false, 'Ada', NOW)!;
  assert.equal(call.yours, false);
  assert.equal(call.title, 'Waiting for Ada to open');
  assert.match(call.detail, /called off/);
});

test('an unnamed opponent still reads as a sentence', () => {
  assert.equal(
    firstMoveCall(NOW + 5_000, false, '   ', NOW)!.title,
    'Waiting for your opponent to open',
  );
});

test('the first-move countdown goes urgent at ten seconds and never negative', () => {
  assert.equal(firstMoveCall(NOW + FIRST_MOVE_CRITICAL_MS, true, null, NOW)!.critical, true);
  assert.equal(firstMoveCall(NOW + FIRST_MOVE_CRITICAL_MS + 1, true, null, NOW)!.critical, false);
  assert.equal(firstMoveCall(NOW - 5_000, true, null, NOW)!.remainingMs, 0);
});

// The two clocks can disagree. A bar promising thirty-four seconds of a
// thirty-second wait runs out early and looks broken doing it.
test('the first-move countdown never promises more than the window', () => {
  const call = firstMoveCall(NOW + FIRST_MOVE_WINDOW_MS + 5_000, true, null, NOW)!;
  assert.equal(call.remainingMs, FIRST_MOVE_WINDOW_MS);
});
