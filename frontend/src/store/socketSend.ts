import type { ClientMessage } from '@/types/protocol';

// The one place that knows how to put a message on the wire. Both the lobby
// store and the bot session use it, so a closed socket is handled the same
// way everywhere.
export const send = (socket: WebSocket | null | undefined, payload: ClientMessage) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(payload));
  return true;
};
