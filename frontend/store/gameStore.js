import { create } from 'zustand';

import {
  clearGameSessionId,
  getOrCreateUserId,
  readGameSessionId,
  saveGameSessionId,
} from './localIdentity';

const DEFAULT_WS_URL = process.env.EXPO_PUBLIC_WS_URL ?? 'ws://localhost:8080/ws';

// This fallback is visible only before the server catalog arrives. The backend
// registry remains authoritative and replaces it on connection.
const BASE_MODES = [
  {
    id: 'V1',
    shortCode: 'V1',
    name: 'Annihilation',
    description: 'Leave no survivors.',
    objective: 'Capture every opposing piece.',
    displayOrder: 1,
    features: [],
    startingPosition: {
      rows: [
        '.........',
        '.........',
        '.........',
        '.R.....s.',
        '.P.....p.',
        '.S.....r.',
        '.........',
        '.........',
        '.........',
      ],
    },
  },
  {
    id: 'V5',
    shortCode: 'V5',
    name: 'Total War',
    description: 'Pieces and territory.',
    objective: 'Annihilate the enemy or control most territory when the board is filled.',
    displayOrder: 2,
    features: ['territory'],
    startingPosition: {
      rows: [
        '...SSS...',
        '...PPP...',
        '...RRR...',
        '.........',
        '.........',
        '.........',
        '...rrr...',
        '...ppp...',
        '...sss...',
      ],
    },
  },
  {
    id: 'V3',
    shortCode: 'V3',
    name: 'Infiltration',
    description: 'Reach their boundary.',
    objective: "Move any piece onto the opponent's home boundary.",
    displayOrder: 3,
    features: [],
    startingPosition: {
      rows: [
        '...SSS...',
        '...PPP...',
        '...RRR...',
        '.........',
        '.........',
        '.........',
        '...rrr...',
        '...ppp...',
        '...sss...',
      ],
    },
  },
];

const initialQueue = {
  isSearching: false,
  modeId: null,
  searchRange: 10000,
  queuedForMs: 0,
};

const accountId = getOrCreateUserId();
let shouldReconnect = true;
let reconnectTimer = null;

const withIdentity = (url, userId) => {
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}userId=${encodeURIComponent(userId)}`;
};

const persistGame = (gameState) => {
  const gameId = gameState?.gameId ?? null;
  if (gameId) saveGameSessionId(gameId);
  return gameId;
};

const clearPersistedGame = () => {
  clearGameSessionId();
  return null;
};

const send = (socket, payload) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return false;
  }
  socket.send(JSON.stringify(payload));
  return true;
};

const inferLastMove = (previousGame, nextGame) => {
  if (
    !previousGame?.grid ||
    !nextGame?.grid ||
    previousGame.gameId !== nextGame.gameId ||
    nextGame.moveNumber !== previousGame.moveNumber + 1
  ) {
    return null;
  }

  let from = null;
  let to = null;
  for (let y = 0; y < nextGame.grid.length; y += 1) {
    for (let x = 0; x < nextGame.grid[y].length; x += 1) {
      const before = previousGame.grid[y]?.[x];
      const after = nextGame.grid[y][x];
      if (!before || !after) continue;

      if (before.occupant !== 'Empty' && after.occupant === 'Empty') {
        from = { x, y };
      }
      if (
        after.occupant !== 'Empty' &&
        (before.occupant !== after.occupant ||
          before.occupantOwner !== after.occupantOwner)
      ) {
        to = { x, y };
      }
    }
  }

  return from && to ? { from, to } : null;
};

export const useGameStore = create((set, get) => ({
  socket: null,
  accountId,
  gameSessionId: readGameSessionId(),
  connectionStatus: 'disconnected',
  error: null,
  modes: BASE_MODES,
  modePlayerCounts: {},
  queue: initialQueue,
  playerColor: null,
  gameState: null,
  lastMove: null,
  selectedTile: null,
  validMoves: [],
  opponentReconnectDeadline: null,

  connect: () => {
    const existing = get().socket;
    if (
      existing &&
      (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    shouldReconnect = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const socket = new WebSocket(withIdentity(DEFAULT_WS_URL, get().accountId));
    set({ socket, connectionStatus: 'connecting', error: null });

    socket.onopen = () => {
      if (get().socket === socket) set({ error: null });
    };
    socket.onerror = () => {
      if (get().socket === socket) set({ error: 'Could not reach the game server.' });
    };
    socket.onclose = () => {
      if (get().socket !== socket) return;
      set({
        socket: null,
        connectionStatus: 'disconnected',
        queue: initialQueue,
      });
      if (shouldReconnect && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          get().connect();
        }, 1000);
      }
    };
    socket.onmessage = (event) => {
      if (get().socket !== socket) return;
      try {
        get().handleServerMessage(JSON.parse(event.data));
      } catch {
        set({ error: 'The server sent an unreadable message.' });
      }
    };
  },

  disconnect: () => {
    shouldReconnect = false;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    get().socket?.close();
    set({ socket: null, connectionStatus: 'disconnected', queue: initialQueue });
  },

  handleServerMessage: (message) => {
    switch (message.type) {
      case 'connection_ready':
        set((state) => {
          const modes = message.modes?.length ? message.modes : state.modes;
          const gameSessionId = state.gameSessionId ?? readGameSessionId();
          if (gameSessionId) {
            send(state.socket, { type: 'rejoin_game', gameId: gameSessionId });
          }
          return {
            connectionStatus: gameSessionId ? 'rejoining' : 'connected',
            gameSessionId,
            modes,
            modePlayerCounts: message.modePlayerCounts ?? state.modePlayerCounts,
          };
        });
        break;
      case 'mode_player_counts':
        set({ modePlayerCounts: message.modePlayerCounts ?? {} });
        break;
      case 'queue_update':
        set((state) => ({
          queue: {
            isSearching: true,
            modeId: message.modeId ?? state.queue.modeId,
            searchRange: message.searchRange ?? 10000,
            queuedForMs: message.queuedForMs ?? 0,
          },
        }));
        break;
      case 'queue_left':
        set({ queue: initialQueue });
        break;
      case 'match_found': {
        const gameSessionId = persistGame(message.gameState);
        set({
          playerColor: message.color,
          gameState: message.gameState,
          lastMove: null,
          gameSessionId,
          connectionStatus: 'connected',
          queue: initialQueue,
          selectedTile: null,
          validMoves: [],
          opponentReconnectDeadline: null,
          error: null,
        });
        break;
      }
      case 'game_rejoined': {
        const isFinished = message.gameState?.status === 'Finished';
        const gameSessionId = isFinished
          ? clearPersistedGame()
          : persistGame(message.gameState);
        set({
          playerColor: message.color,
          gameState: message.gameState,
          lastMove: null,
          gameSessionId,
          connectionStatus: 'connected',
          queue: initialQueue,
          selectedTile: null,
          validMoves: [],
          opponentReconnectDeadline: message.reconnectDeadlineUnixMs || null,
          error: null,
        });
        break;
      }
      case 'game_unavailable':
        set({
          playerColor: null,
          gameState: null,
          lastMove: null,
          gameSessionId: clearPersistedGame(),
          connectionStatus: 'connected',
          selectedTile: null,
          validMoves: [],
          opponentReconnectDeadline: null,
          error: null,
        });
        break;
      case 'game_state': {
        const isFinished = message.gameState?.status === 'Finished';
        set((state) => ({
          gameState: message.gameState,
          gameSessionId: isFinished ? clearPersistedGame() : persistGame(message.gameState),
          lastMove: inferLastMove(state.gameState, message.gameState) ?? state.lastMove,
          selectedTile: null,
          validMoves: [],
          opponentReconnectDeadline: isFinished ? null : state.opponentReconnectDeadline,
          error: null,
        }));
        break;
      }
      case 'opponent_disconnected':
        set({ opponentReconnectDeadline: message.reconnectDeadlineUnixMs || null });
        break;
      case 'opponent_reconnected':
        set({ opponentReconnectDeadline: null });
        break;
      case 'valid_moves':
        set((state) => {
          if (!state.selectedTile || !message.from || !samePosition(state.selectedTile, message.from)) {
            return {};
          }
          const validMoves = message.validMoves ?? [];
          return validMoves.length > 0
            ? { validMoves }
            : { selectedTile: null, validMoves: [] };
        });
        break;
      case 'move_rejected':
      case 'action_rejected':
      case 'error':
        set({ error: message.message ?? 'Something went wrong.' });
        break;
      default:
        break;
    }
  },

  joinQueue: (requestedModeId) => {
    const { socket, modes } = get();
    const modeId = requestedModeId ?? modes[0]?.id;
    if (!modeId) {
      set({ error: 'No game modes are available.' });
      return;
    }
    if (!send(socket, { type: 'join_queue', modeId })) {
      set({ error: 'Connect to the server before finding a match.' });
      return;
    }
    set({
      queue: { ...initialQueue, modeId, isSearching: true },
      error: null,
    });
  },

  leaveQueue: () => {
    send(get().socket, { type: 'leave_queue' });
    set({ queue: initialQueue });
  },

  selectTile: (position) => {
    const { gameState, playerColor, selectedTile, validMoves, socket } = get();
    if (!gameState || gameState.status !== 'InProgress') {
      return;
    }

    if (selectedTile && validMoves.some((move) => samePosition(move, position))) {
      if (send(socket, { type: 'make_move', from: selectedTile, to: position })) {
        set({ selectedTile: null, validMoves: [], error: null });
      }
      return;
    }

    if (selectedTile && samePosition(selectedTile, position)) {
      set({ selectedTile: null, validMoves: [], error: null });
      return;
    }

    const tile = gameState.grid[position.y]?.[position.x];
    if (gameState.currentTurn !== playerColor || tile?.occupantOwner !== playerColor) {
      set({ selectedTile: null, validMoves: [] });
      return;
    }

    set({ selectedTile: position, validMoves: [], error: null });
    if (!send(socket, { type: 'request_moves', from: position })) {
      set({ selectedTile: null, error: 'Could not request legal moves from the server.' });
    }
  },

  movePiece: (from, to) => {
    const { gameState, playerColor, socket } = get();
    if (!gameState || gameState.status !== 'InProgress' || gameState.currentTurn !== playerColor) {
      return;
    }

    const source = gameState.grid[from.y]?.[from.x];
    const destinationExists = Boolean(gameState.grid[to.y]?.[to.x]);
    if (source?.occupantOwner !== playerColor || !destinationExists) {
      return;
    }

    if (send(socket, { type: 'make_move', from, to })) {
      set({ selectedTile: null, validMoves: [], error: null });
    }
  },

  offerDraw: () => {
    if (!send(get().socket, { type: 'offer_draw' })) {
      set({ error: 'Reconnect to the server before offering a draw.' });
    }
  },

  acceptDraw: () => {
    if (!send(get().socket, { type: 'accept_draw' })) {
      set({ error: 'Reconnect to the server before accepting the draw.' });
    }
  },

  declineDraw: () => {
    if (!send(get().socket, { type: 'decline_draw' })) {
      set({ error: 'Reconnect to the server before declining the draw.' });
    }
  },

  resignGame: () => {
    if (!send(get().socket, { type: 'resign_game' })) {
      set({ error: 'Reconnect to the server before resigning.' });
    }
  },

  clearGame: () => {
    clearPersistedGame();
    set({
      playerColor: null,
      gameState: null,
      lastMove: null,
      gameSessionId: null,
      selectedTile: null,
      validMoves: [],
      opponentReconnectDeadline: null,
      error: null,
    });
  },

  clearError: () => set({ error: null }),
}));

const samePosition = (first, second) => first.x === second.x && first.y === second.y;
