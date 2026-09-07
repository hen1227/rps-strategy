import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  belongsToChatRoom,
  chatRoomIdOf,
  chatRoomScopeOf,
  withChatMessage,
} from './chatSelectors';
import type { ChatMessage } from '@/types/protocol';

const said = (id: string, roomId: string | undefined, gameId: string): ChatMessage => ({
  id,
  roomId,
  gameId,
  senderUserId: 'watcher',
  senderName: 'Watcher',
  senderRole: 'spectator',
  text: id,
  sentAtUnixMs: 0,
});

describe('chatRoomIdOf', () => {
  it('prefers the room the server named', () => {
    assert.equal(chatRoomIdOf('series-1', 'game-2'), 'series-1');
  });

  it('falls back to the game for a server that does not name rooms', () => {
    assert.equal(chatRoomIdOf(undefined, 'game-2'), 'game-2');
    assert.equal(chatRoomIdOf(undefined, undefined), null);
  });
});

describe('chatRoomScopeOf', () => {
  it('takes the server at its word', () => {
    assert.equal(chatRoomScopeOf('tournament', 'engine-cup', 'game-2'), 'tournament');
    // Said even when the room is this one game, which is what the server sends
    // for an ordinary board.
    assert.equal(chatRoomScopeOf('game', 'game-2', 'game-2'), 'game');
  });

  it('reads a room bigger than the game as a series when the server does not say', () => {
    // The only thing that spanned more than one game before events did.
    assert.equal(chatRoomScopeOf(undefined, 'series-1', 'game-2'), 'series');
  });

  it('falls back to the game itself', () => {
    assert.equal(chatRoomScopeOf(undefined, 'game-2', 'game-2'), 'game');
    assert.equal(chatRoomScopeOf(undefined, null, null), 'game');
  });
});

describe('belongsToChatRoom', () => {
  it('accepts a message from another game of the same room', () => {
    // The board that just finished, talking to the board now being played.
    assert.equal(belongsToChatRoom(said('a', 'series-1', 'game-1'), 'series-1'), true);
    // And one match of a bots-only event talking to another, played at the
    // same time rather than after it.
    assert.equal(belongsToChatRoom(said('b', 'engine-cup', 'game-7'), 'engine-cup'), true);
  });

  it('rejects a message from an unrelated game', () => {
    assert.equal(belongsToChatRoom(said('a', 'game-9', 'game-9'), 'series-1'), false);
  });

  it('rejects everything when there is no room on screen', () => {
    assert.equal(belongsToChatRoom(said('a', 'series-1', 'game-1'), null), false);
  });

  it('matches on the game when the server did not name a room', () => {
    assert.equal(belongsToChatRoom(said('a', undefined, 'game-2'), 'game-2'), true);
    assert.equal(belongsToChatRoom(said('a', undefined, 'game-1'), 'game-2'), false);
  });
});

describe('withChatMessage', () => {
  it('adds a message for this room', () => {
    const before = [said('first', 'series-1', 'game-1')];
    const after = withChatMessage(before, 'series-1', said('second', 'series-1', 'game-2'));
    assert.deepEqual(
      after.map((message) => message.id),
      ['first', 'second'],
    );
  });

  it('returns the same list for a message that changes nothing', () => {
    const before = [said('first', 'series-1', 'game-1')];
    // Already here: the sender's own message arrives back over the socket.
    assert.equal(withChatMessage(before, 'series-1', said('first', 'series-1', 'game-1')), before);
    // Somebody else's room.
    assert.equal(withChatMessage(before, 'series-1', said('other', 'game-9', 'game-9')), before);
  });

  it('keeps the newest hundred', () => {
    const before = Array.from({ length: 100 }, (_, index) =>
      said(`old-${index}`, 'series-1', 'game-1'),
    );
    const after = withChatMessage(before, 'series-1', said('new', 'series-1', 'game-2'));
    assert.equal(after.length, 100);
    assert.equal(after[0]?.id, 'old-1');
    assert.equal(after[99]?.id, 'new');
  });
});
