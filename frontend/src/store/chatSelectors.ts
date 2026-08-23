// Which conversation a message belongs to.
//
// Not the same question as which game it was typed at. Every game of a bot
// series shares one room, so a spectator who follows a run to its next board
// and one who stays on the board that just finished are in the same chat and
// have to hear each other. Matching an arriving message against the game on
// screen would keep each of them talking to nobody.

import type { ChatMessage } from '@/types/protocol';

/** How many messages a client keeps, matching the server's own ceiling. */
export const CHAT_HISTORY_LIMIT = 100;

/**
 * The room a join message puts this client in.
 *
 * `chatRoomId` is what the server names it. The game id is the fallback for a
 * server older than that field, which cannot have a room spanning more than
 * one game anyway.
 */
export const chatRoomIdOf = (
  chatRoomId: string | null | undefined,
  gameId: string | null | undefined,
): string | null => chatRoomId ?? gameId ?? null;

/**
 * Whether this room covers more than the game on screen, which today means a
 * bot series. Read from the room's own name rather than from the live table,
 * so it is still true of a run whose current board has left it.
 */
export const roomSpansSeries = (
  roomId: string | null | undefined,
  gameId: string | null | undefined,
): boolean => Boolean(roomId) && Boolean(gameId) && roomId !== gameId;

/** Whether an arriving message is for the conversation on screen. */
export const belongsToChatRoom = (
  message: ChatMessage,
  roomId: string | null | undefined,
): boolean => Boolean(roomId) && (message.roomId ?? message.gameId) === roomId;

/**
 * The transcript with a message added, or the same list when there is nothing
 * to add: a message for another room, or one already here. Callers compare by
 * reference, so returning the original is how they know to publish nothing.
 */
export const withChatMessage = (
  messages: ChatMessage[],
  roomId: string | null | undefined,
  message: ChatMessage,
): ChatMessage[] => {
  if (!belongsToChatRoom(message, roomId)) return messages;
  if (messages.some((candidate) => candidate.id === message.id)) return messages;
  return [...messages, message].slice(-CHAT_HISTORY_LIMIT);
};
