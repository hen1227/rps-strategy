import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLAIM_CRITICAL_MS,
  CLAIM_WINDOW_MS,
  MISS_NOTICE_MS,
  QUEUE_COPY,
  formatCountdown,
  formatWait,
  lobbyGate,
  queueCallState,
  waitingPresence,
  type QueueSource,
} from './queueSelectors.ts';
import type { QueueClaim, QueueState } from './types.ts';
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
  claim: null,
  miss: null,
  outgoingChallenge: null,
  connectionStatus: 'connected',
  modes: MODES,
  atOwnBoard: false,
  pushLive: false,
  canOfferAlerts: true,
  nowMs: NOW,
});

const claim = (
  role: 'summoned' | 'present',
  remainingMs = CLAIM_WINDOW_MS,
): QueueClaim =>
  ({
    pendingId: 'hold-1',
    role,
    deadlineUnixMs: NOW + remainingMs,
    opponent: { userId: 'ada', username: 'Ada' },
    opponentElo: 1300,
    modeId: 'V5',
    modeName: 'Total War',
    setup: {},
    claiming: false,
  }) as unknown as QueueClaim;

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

test('being summoned outranks searching', () => {
  const call = queueCallState({
    ...emptySource(),
    queue: searching(),
    claim: claim('summoned'),
  });
  assert.equal(call?.kind, 'claiming');
  assert.equal(call?.opponentName, 'Ada');
});

test('being the one who waits reads differently from being summoned', () => {
  const call = queueCallState({
    ...emptySource(),
    queue: searching(),
    claim: claim('present'),
  });
  assert.equal(call?.kind, 'holding');
});

// A message that arrived late, or a tab that woke up throttled, must not leave
// a dead countdown on screen with a button that cannot work.
test('a claim whose deadline has passed is ignored', () => {
  const call = queueCallState({
    ...emptySource(),
    queue: searching(),
    claim: claim('summoned', -1),
  });
  assert.equal(call?.kind, 'searching_tethered');
});

test('a claim outranks reconnecting, so the card does not vanish', () => {
  const call = queueCallState({
    ...emptySource(),
    queue: searching(),
    claim: claim('summoned'),
    connectionStatus: 'disconnected',
  });
  assert.equal(call?.kind, 'claiming');
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

test('a no-show notice shows briefly and then gives way', () => {
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
test('the wait shown after a no-show is the whole search', () => {
  const call = queueCallState({
    ...emptySource(),
    queue: searching(9 * 60_000),
    miss: { message: 'gone', atUnixMs: NOW - 500 },
  });
  assert.equal(call?.kind, 'missed');
  assert.ok(call!.waitedMs > CLAIM_WINDOW_MS);
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

test('the countdown goes urgent at ten seconds and never negative', () => {
  const atTen = queueCallState({
    ...emptySource(),
    claim: claim('summoned', CLAIM_CRITICAL_MS),
  });
  assert.equal(atTen?.critical, true);

  const early = queueCallState({
    ...emptySource(),
    claim: claim('summoned', CLAIM_CRITICAL_MS + 1),
  });
  assert.equal(early?.critical, false);
  assert.equal(early?.progress > 0, true);
});

// Catches a future kind added without copy to go with it.
test('every call kind has usable copy', () => {
  const call = queueCallState({
    ...emptySource(),
    claim: claim('summoned'),
  })!;
  for (const [kind, copy] of Object.entries(QUEUE_COPY)) {
    assert.ok(copy.title({ ...call, kind } as typeof call).length > 0, kind);
    assert.ok(copy.detail({ ...call, kind } as typeof call).length > 0, kind);
    assert.equal(copy.action, copy.action.toUpperCase(), kind);
  }
});

/* ------------------------------------------------------------------ gate -- */

const gateSource = (overrides: Partial<Parameters<typeof lobbyGate>[0]> = {}) => ({
  connectionStatus: 'connected' as const,
  atOwnBoard: false,
  outgoingChallenge: null,
  claim: null,
  queue: idleQueue(),
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

test('an outgoing challenge or a held seat is already a seek', () => {
  assert.equal(lobbyGate(gateSource({ outgoingChallenge: openChallenge() })).seekTaken, true);
  assert.equal(lobbyGate(gateSource({ claim: claim('summoned') })).seekTaken, true);
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

// The two clocks disagree by up to one server sweep. In that gap the bar must
// not claim the search is running again, because the server still has the seat
// held and the seek off the board — so a presence report, or a cancel, would
// land somewhere the player did not mean it to.
test('a lapsed hold reads as a no-show, not as a fresh search', () => {
  const call = queueCallState({
    ...emptySource(),
    queue: searching(120_000),
    claim: claim('present', -100),
  });
  assert.equal(call?.kind, 'missed');
  assert.equal(call?.opponentName, 'Ada');
  assert.equal(QUEUE_COPY.missed.title(call!), 'Ada never turned up');
});

// The other side of it: a summons that lapsed is the player's own fault and
// their seek is gone, so there is nothing to report but the search they are
// no longer in. The server's queue_left settles it a moment later.
test('a lapsed summons does not pretend a hold is still live', () => {
  const call = queueCallState({
    ...emptySource(),
    queue: searching(120_000),
    claim: claim('summoned', -100),
  });
  assert.notEqual(call?.kind, 'claiming');
});

// The two clocks can disagree. A bar promising thirty-four seconds of a
// thirty-second hold runs out early and looks broken doing it.
test('the countdown never promises more than the window', () => {
  const call = queueCallState({
    ...emptySource(),
    claim: claim('summoned', CLAIM_WINDOW_MS + 5_000),
  });
  assert.equal(call?.remainingMs, CLAIM_WINDOW_MS);
  assert.equal(call?.progress, 1);
});
