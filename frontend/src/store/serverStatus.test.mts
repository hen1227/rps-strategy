import assert from 'node:assert/strict';
import test from 'node:test';

import { useGameStore } from './gameStore.ts';
import type { ServerNotice, ServerUpdate } from '../types/protocol.ts';

// The store's own handling of the two things the server says about itself.
//
// Driven through `handleServerMessage` rather than through a socket, which is
// all these rules are: no network, no reconnection, just what a message does to
// the state a banner reads.

const drain = (over: Partial<ServerUpdate> = {}): ServerUpdate => ({
  updating: true,
  note: 'Back in a minute.',
  waitingOn: ['Alice vs Bob (Total War, move 12)'],
  gamesRemaining: 1,
  settled: false,
  ...over,
});

const announcement = (over: Partial<ServerNotice> = {}): ServerNotice => ({
  id: 'notice-1',
  text: 'Sorry — restarting now.',
  tone: 'warning',
  postedAtUnixMs: 1,
  expiresAtUnixMs: 2,
  ...over,
});

const reset = () =>
  useGameStore.setState({
    serverUpdate: null,
    serverNotice: null,
    standingNotice: null,
    dismissedNoticeId: null,
  });

test('a drain raises the banner and a cancellation takes it down', () => {
  reset();
  const { handleServerMessage } = useGameStore.getState();

  handleServerMessage({ type: 'server_update', update: drain() });
  assert.equal(useGameStore.getState().serverUpdate?.gamesRemaining, 1);

  // The cancellation arrives as the same message with `updating: false`, and
  // has to clear the banner rather than leave it asserting something untrue.
  handleServerMessage({
    type: 'server_update',
    update: { updating: false, waitingOn: [], gamesRemaining: 0, settled: false },
  });
  assert.equal(useGameStore.getState().serverUpdate, null);
});

test('a notice this browser dismissed does not come back on reconnection', () => {
  reset();
  const { handleServerMessage, dismissServerNotice } = useGameStore.getState();

  handleServerMessage({ type: 'server_notice', notice: announcement() });
  assert.equal(useGameStore.getState().serverNotice?.text, 'Sorry — restarting now.');

  dismissServerNotice();
  assert.equal(useGameStore.getState().serverNotice, null);

  // The server re-sends the standing notice on every `connection_ready`, and a
  // reconnection is exactly what follows the restart it was announcing. Without
  // the dismissed id, the banner somebody closed comes straight back.
  handleServerMessage({ type: 'server_notice', notice: announcement() });
  assert.equal(useGameStore.getState().serverNotice, null);

  // A *new* notice is new news, and does come back.
  handleServerMessage({
    type: 'server_notice',
    notice: announcement({ id: 'notice-2', text: 'Back up, sorry about that.' }),
  });
  assert.equal(useGameStore.getState().serverNotice?.text, 'Back up, sorry about that.');
});

test('an empty notice is how a cleared announcement arrives', () => {
  reset();
  const { handleServerMessage } = useGameStore.getState();

  handleServerMessage({ type: 'server_notice', notice: announcement() });
  handleServerMessage({
    type: 'server_notice',
    notice: { id: '', text: '', postedAtUnixMs: 0, expiresAtUnixMs: 0 },
  });
  assert.equal(useGameStore.getState().serverNotice, null);
});

// The bug this pair of fields exists for.
//
// A host posts a notice and then closes the banner exactly as any player would.
// If that also cleared the record of the notice, the admin screen could not tell
// them one was still up, and a "back in a minute" would sit in front of every
// visitor for the full fifteen. So dismissal is about this browser's banner and
// nothing else.
test('dismissing the banner does not take the notice down', () => {
  reset();
  const { handleServerMessage, dismissServerNotice } = useGameStore.getState();

  handleServerMessage({ type: 'server_notice', notice: announcement() });
  assert.equal(useGameStore.getState().standingNotice?.id, 'notice-1');

  dismissServerNotice();
  assert.equal(useGameStore.getState().serverNotice, null, 'the banner should close');
  assert.equal(
    useGameStore.getState().standingNotice?.id,
    'notice-1',
    'the notice is still up on the server',
  );

  // A re-broadcast of the dismissed notice keeps the banner down and the record
  // up: this is the reconnection case, which is when a host is most likely to
  // be looking at the admin screen.
  handleServerMessage({ type: 'server_notice', notice: announcement() });
  assert.equal(useGameStore.getState().serverNotice, null);
  assert.equal(useGameStore.getState().standingNotice?.id, 'notice-1');
});

test('taking the notice down clears the record as well as the banner', () => {
  reset();
  const { handleServerMessage, dismissServerNotice } = useGameStore.getState();

  handleServerMessage({ type: 'server_notice', notice: announcement() });
  dismissServerNotice();
  handleServerMessage({
    type: 'server_notice',
    notice: { id: '', text: '', postedAtUnixMs: 0, expiresAtUnixMs: 0 },
  });
  assert.equal(useGameStore.getState().standingNotice, null);
});

test('connecting reports a standing notice even if this browser closed it', () => {
  reset();
  const { handleServerMessage, dismissServerNotice } = useGameStore.getState();

  handleServerMessage({ type: 'server_notice', notice: announcement() });
  dismissServerNotice();
  // `connection_ready` carries the standing notice, and it is the message a
  // host's own reload goes through.
  handleServerMessage({ type: 'connection_ready', notice: announcement() });
  assert.equal(useGameStore.getState().serverNotice, null, 'the banner stays closed');
  assert.equal(useGameStore.getState().standingNotice?.id, 'notice-1');
});
