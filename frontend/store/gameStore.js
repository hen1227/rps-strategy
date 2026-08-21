import { create } from 'zustand';

import {
  clearGameSessionId,
  getOrCreateProfileKey,
  getOrCreateUserId,
  readGameSessionId,
  saveGameSessionId,
} from './localIdentity';
import { createBotSlice, initialBotState } from './botSession';
import { WS_URL } from './serverConfig';
import { send } from './socketSend';
import { listTournaments } from './tournamentApi';

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
    playable: false,
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
    playable: true,
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
    playable: true,
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
const profileKey = getOrCreateProfileKey();
let shouldReconnect = true;
let reconnectTimer = null;

const persistGame = (gameState) => {
  const gameId = gameState?.gameId ?? null;
  if (gameId) saveGameSessionId(gameId);
  return gameId;
};

const clearPersistedGame = () => {
  clearGameSessionId();
  return null;
};

// An HTTP payload has no live match state, so both merges keep whatever the
// socket already told us about readiness and running games.
const carryLiveState = (next, existing) => ({
  ...next,
  matchStates: next.matchStates ?? existing?.matchStates ?? [],
});

const findTournament = (tournaments, tournamentId) =>
  tournaments.find((tournament) => tournament.tournamentId === tournamentId);

const mergeTournament = (tournaments, next) => {
  if (!next?.tournamentId) return tournaments;
  const existing = findTournament(tournaments, next.tournamentId);
  const merged = carryLiveState(next, existing);
  return existing
    ? tournaments.map((tournament) =>
        tournament.tournamentId === merged.tournamentId ? merged : tournament,
      )
    : [merged, ...tournaments];
};

const mergeTournamentList = (tournaments, incoming) =>
  incoming.map((next) => carryLiveState(next, findTournament(tournaments, next.tournamentId)));

// The server republishes the lobby counts every couple of seconds whether or
// not they moved, so they are compared before they are stored: a fresh object
// re-renders every screen watching them, which is wasted work in the lobby and
// noise for anyone in the middle of a game.
const sameCounts = (current, next) => {
  const keys = Object.keys(next);
  if (keys.length !== Object.keys(current).length) return false;
  return keys.every((key) => current[key] === next[key]);
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
  ...createBotSlice(set, get),
  socket: null,
  accountId,
  profileKey,
  account: null,
  gameSessionId: readGameSessionId(),
  connectionStatus: 'disconnected',
  error: null,
  modes: BASE_MODES,
  modePlayerCounts: {},
  // Players waiting in matchmaking right now, per mode. The bot board watches
  // this so someone practising against a bot still hears the door knock.
  modeQueueCounts: {},
  // Everyone on the site currently playing a bot instead of a person.
  botPlayerCount: 0,
  liveGames: [],
  tournaments: [],
  incomingChallenges: [],
  outgoingChallenge: null,
  acceptingChallengeId: null,
  challengeNotice: null,
  queue: initialQueue,
  playerColor: null,
  isSpectating: false,
  spectatedGameId: null,
  gameState: null,
  lastMove: null,
  selectedTile: null,
  validMoves: [],
  opponentReconnectDeadline: null,
  chatMessages: [],
  chatVisible: true,
  showSpectatorMessages: true,

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
    const socket = new WebSocket(WS_URL);
    set({ socket, connectionStatus: 'connecting', error: null });

    socket.onopen = () => {
      if (get().socket !== socket) return;
      set({ error: null });
      send(socket, {
        type: 'authenticate',
        userId: get().accountId,
        profileKey: get().profileKey,
      });
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
        incomingChallenges: [],
        outgoingChallenge: null,
        acceptingChallengeId: null,
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
    set({
      socket: null,
      connectionStatus: 'disconnected',
      queue: initialQueue,
      incomingChallenges: [],
      outgoingChallenge: null,
      acceptingChallengeId: null,
    });
  },

  handleServerMessage: (message) => {
    switch (message.type) {
      case 'connection_ready':
        set((state) => {
          const modes = message.modes?.length ? message.modes : state.modes;
          const gameSessionId = state.gameSessionId ?? readGameSessionId();
          const spectatedGameId = gameSessionId ? null : state.spectatedGameId;
          if (gameSessionId) {
            send(state.socket, { type: 'rejoin_game', gameId: gameSessionId });
          } else if (spectatedGameId) {
            send(state.socket, { type: 'spectate_game', gameId: spectatedGameId });
          }
          return {
            connectionStatus: gameSessionId || spectatedGameId ? 'rejoining' : 'connected',
            account: message.account ?? state.account,
            gameSessionId,
            spectatedGameId,
            modes,
            modePlayerCounts: message.modePlayerCounts ?? state.modePlayerCounts,
            modeQueueCounts: message.modeQueueCounts ?? state.modeQueueCounts,
            botPlayerCount: message.botPlayerCount ?? 0,
            liveGames: message.liveGames ?? [],
            tournaments: message.tournaments ?? [],
            incomingChallenges: message.challenges ?? [],
            outgoingChallenge: null,
            acceptingChallengeId: null,
          };
        });
        // The server forgets a bot session when the socket drops, so a
        // reconnected bot player announces themselves again.
        get().announceBotPresence();
        break;
      case 'authentication_failed':
        shouldReconnect = false;
        set({
          connectionStatus: 'disconnected',
          error: message.message ?? 'This device could not authenticate the local account.',
        });
        break;
      case 'mode_player_counts': {
        const modePlayerCounts = message.modePlayerCounts ?? {};
        const modeQueueCounts = message.modeQueueCounts ?? {};
        const botPlayerCount = message.botPlayerCount ?? 0;
        const state = get();
        if (
          state.botPlayerCount === botPlayerCount &&
          sameCounts(state.modePlayerCounts, modePlayerCounts) &&
          sameCounts(state.modeQueueCounts, modeQueueCounts)
        ) {
          break;
        }
        set({ modePlayerCounts, modeQueueCounts, botPlayerCount });
        break;
      }
      case 'live_games':
        set({ liveGames: message.liveGames ?? [] });
        break;
      case 'tournaments':
        set({ tournaments: message.tournaments ?? [] });
        break;
      case 'tournament_rejected':
        set({ error: message.message ?? 'That tournament match is not available.' });
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
      case 'challenge_received':
        if (message.challenge) {
          set((state) => ({
            incomingChallenges: state.incomingChallenges.some(
              (challenge) => challenge.id === message.challenge.id,
            )
              ? state.incomingChallenges
              : [...state.incomingChallenges, message.challenge],
            challengeNotice: null,
          }));
        }
        break;
      case 'challenge_sent':
        set({
          outgoingChallenge: message.challenge ?? null,
          acceptingChallengeId: null,
          challengeNotice: null,
          error: null,
        });
        break;
      case 'challenge_removed':
        set((state) => ({
          incomingChallenges: state.incomingChallenges.filter(
            (challenge) => challenge.id !== message.challenge?.id,
          ),
          acceptingChallengeId:
            state.acceptingChallengeId === message.challenge?.id
              ? null
              : state.acceptingChallengeId,
        }));
        break;
      case 'challenge_declined':
      case 'challenge_cancelled':
        set((state) => ({
          incomingChallenges: state.incomingChallenges.filter(
            (challenge) => challenge.id !== message.challenge?.id,
          ),
          outgoingChallenge:
            state.outgoingChallenge?.id === message.challenge?.id
              ? null
              : state.outgoingChallenge,
          acceptingChallengeId:
            state.acceptingChallengeId === message.challenge?.id
              ? null
              : state.acceptingChallengeId,
          challengeNotice: message.message ?? null,
        }));
        break;
      case 'challenge_unavailable':
        set((state) => {
          const challengeId = message.challenge?.id ?? state.acceptingChallengeId;
          return {
            incomingChallenges: challengeId
              ? state.incomingChallenges.filter((challenge) => challenge.id !== challengeId)
              : state.incomingChallenges,
            outgoingChallenge:
              challengeId && state.outgoingChallenge?.id === challengeId
                ? null
                : state.outgoingChallenge,
            acceptingChallengeId: null,
            challengeNotice: message.message ?? 'That challenge is no longer available.',
          };
        });
        break;
      case 'challenge_rejected':
        set({
          acceptingChallengeId: null,
          error: message.message ?? 'The challenge could not be completed.',
        });
        break;
      case 'match_found': {
        const gameSessionId = persistGame(message.gameState);
        // A found opponent takes the board: the bot game is local and
        // unrated, so it is dropped rather than queued behind the match.
        get().endBotSession();
        set({
          ...initialBotState,
          playerColor: message.color,
          isSpectating: false,
          spectatedGameId: null,
          gameState: message.gameState,
          lastMove: null,
          gameSessionId,
          connectionStatus: 'connected',
          queue: initialQueue,
          incomingChallenges: [],
          outgoingChallenge: null,
          acceptingChallengeId: null,
          challengeNotice: null,
          selectedTile: null,
          validMoves: [],
          opponentReconnectDeadline: null,
          chatMessages: [],
          error: null,
        });
        break;
      }
      case 'game_rejoined': {
        const gameSessionId = persistGame(message.gameState);
        set({
          playerColor: message.color,
          isSpectating: false,
          spectatedGameId: null,
          gameState: message.gameState,
          lastMove: null,
          gameSessionId,
          connectionStatus: 'connected',
          queue: initialQueue,
          selectedTile: null,
          validMoves: [],
          opponentReconnectDeadline: message.reconnectDeadlineUnixMs || null,
          chatMessages: message.chatMessages ?? [],
          error: null,
        });
        break;
      }
      case 'spectator_joined':
        clearPersistedGame();
        set({
          playerColor: 'Neutral',
          isSpectating: true,
          spectatedGameId: message.gameState?.gameId ?? null,
          gameState: message.gameState,
          lastMove: null,
          gameSessionId: null,
          connectionStatus: 'connected',
          queue: initialQueue,
          selectedTile: null,
          validMoves: [],
          opponentReconnectDeadline: null,
          chatMessages: message.chatMessages ?? [],
          error: null,
        });
        break;
      case 'game_unavailable':
        set({
          playerColor: null,
          isSpectating: false,
          spectatedGameId: null,
          gameState: null,
          lastMove: null,
          gameSessionId: clearPersistedGame(),
          connectionStatus: 'connected',
          selectedTile: null,
          validMoves: [],
          opponentReconnectDeadline: null,
          chatMessages: [],
          error: null,
        });
        break;
      case 'spectate_unavailable':
        set({
          playerColor: null,
          isSpectating: false,
          spectatedGameId: null,
          gameState: null,
          lastMove: null,
          selectedTile: null,
          validMoves: [],
          opponentReconnectDeadline: null,
          chatMessages: [],
          connectionStatus: 'connected',
          error: message.message ?? 'That game is no longer available to spectate.',
        });
        break;
      case 'game_state': {
        const current = get();
        if (!current.gameState || current.gameState.gameId !== message.gameState?.gameId) {
          break;
        }
        const isFinished = message.gameState?.status === 'Finished';
        const isSpectating = current.isSpectating;
        set((state) => ({
          gameState: message.gameState,
          // The result does not end the session: the chat room stays open
          // until we leave it, and rejoining is how a reconnect gets back in.
          gameSessionId: isSpectating ? null : persistGame(message.gameState),
          spectatedGameId: isSpectating && isFinished ? null : state.spectatedGameId,
          lastMove: inferLastMove(state.gameState, message.gameState) ?? state.lastMove,
          selectedTile: null,
          validMoves: [],
          opponentReconnectDeadline: isFinished ? null : state.opponentReconnectDeadline,
          error: null,
        }));
        break;
      }
      case 'chat_message':
        set((state) => {
          const chatMessage = message.chatMessage;
          if (!chatMessage || chatMessage.gameId !== state.gameState?.gameId) return {};
          if (state.chatMessages.some((candidate) => candidate.id === chatMessage.id)) return {};
          return { chatMessages: [...state.chatMessages, chatMessage].slice(-100) };
        });
        break;
      case 'spectator_left':
        if (get().isSpectating) {
          set({
            playerColor: null,
            isSpectating: false,
            spectatedGameId: null,
            gameState: null,
            lastMove: null,
            selectedTile: null,
            validMoves: [],
            chatMessages: [],
          });
        }
        break;
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
      case 'chat_rejected':
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

  challengePlayer: (username, requestedModeId) => {
    const { socket, modes } = get();
    const modeId = requestedModeId ?? modes[0]?.id;
    const trimmedUsername = username?.trim();
    if (!trimmedUsername) {
      set({ error: 'Enter the username you want to challenge.' });
      return false;
    }
    if (!modeId) {
      set({ error: 'No game modes are available.' });
      return false;
    }
    if (!send(socket, { type: 'send_challenge', username: trimmedUsername, modeId })) {
      set({ error: 'Connect to the server before sending a challenge.' });
      return false;
    }
    set({ error: null, challengeNotice: null });
    return true;
  },

  acceptChallenge: (challengeId) => {
    if (!challengeId || !send(get().socket, { type: 'accept_challenge', challengeId })) {
      set({ error: 'Connect to the server before accepting a challenge.' });
      return;
    }
    set({ acceptingChallengeId: challengeId, error: null, challengeNotice: null });
  },

  declineChallenge: (challengeId) => {
    if (!challengeId || !send(get().socket, { type: 'decline_challenge', challengeId })) {
      set({ error: 'Connect to the server before declining a challenge.' });
      return;
    }
    set((state) => ({
      incomingChallenges: state.incomingChallenges.filter(
        (challenge) => challenge.id !== challengeId,
      ),
      acceptingChallengeId:
        state.acceptingChallengeId === challengeId ? null : state.acceptingChallengeId,
    }));
  },

  cancelChallenge: (challengeId) => {
    if (!challengeId || !send(get().socket, { type: 'cancel_challenge', challengeId })) {
      set({ error: 'Connect to the server before cancelling the challenge.' });
    }
  },

  spectateGame: (gameId) => {
    if (!gameId || !send(get().socket, { type: 'spectate_game', gameId })) {
      set({ error: 'Connect to the server before spectating a game.' });
      return;
    }
    set({ spectatedGameId: gameId, error: null });
  },

  // The tournament board also loads over HTTP so it is on screen before the
  // socket finishes authenticating.
  loadTournaments: async () => {
    try {
      const tournaments = await listTournaments();
      if (!Array.isArray(tournaments)) return;
      set((state) => ({ tournaments: mergeTournamentList(state.tournaments, tournaments) }));
    } catch {
      // The socket delivers the same board once it connects.
    }
  },

  // Applies a tournament returned by an HTTP mutation right away; the server
  // broadcast that follows keeps every other client in step.
  applyTournamentUpdate: (tournament) =>
    set((state) => ({ tournaments: mergeTournament(state.tournaments, tournament) })),

  // Readying up is the only tournament play action: the server starts the game
  // once both players are present, or returns a player to a running board.
  readyForTournamentMatch: (tournamentId, matchId) => {
    if (!send(get().socket, { type: 'tournament_ready', tournamentId, matchId })) {
      set({ error: 'Connect to the server before starting your tournament match.' });
      return;
    }
    set({ error: null });
  },

  withdrawFromTournamentMatch: (tournamentId, matchId) => {
    if (!send(get().socket, { type: 'tournament_withdraw', tournamentId, matchId })) {
      set({ error: 'Connect to the server before leaving the match queue.' });
    }
  },

  selectTile: (position) => {
    const { gameState, playerColor, selectedTile, validMoves, socket } = get();
    if (!gameState || gameState.status !== 'InProgress') {
      return;
    }
    // A bot game has no server session behind it: the rules, the legal moves,
    // and the opponent all run here.
    if (gameState.bot) {
      get().botSelectTile(position);
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
    if (gameState.bot) {
      get().botMovePiece(from, to);
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
    if (get().gameState?.bot) {
      get().offerBotDraw();
      return;
    }
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

  offerTimeExtension: () => {
    if (!send(get().socket, { type: 'offer_time' })) {
      set({ error: 'Reconnect to the server before asking for more time.' });
    }
  },

  acceptTimeExtension: () => {
    if (!send(get().socket, { type: 'accept_time' })) {
      set({ error: 'Reconnect to the server before granting more time.' });
    }
  },

  declineTimeExtension: () => {
    if (!send(get().socket, { type: 'decline_time' })) {
      set({ error: 'Reconnect to the server before declining the extra time.' });
    }
  },

  resignGame: () => {
    if (get().gameState?.bot) {
      get().resignBotGame();
      return;
    }
    if (!send(get().socket, { type: 'resign_game' })) {
      set({ error: 'Reconnect to the server before resigning.' });
    }
  },

  sendChat: (text) => {
    const trimmed = text.trim();
    if (!trimmed) return false;
    if (!send(get().socket, { type: 'send_chat', text: trimmed })) {
      set({ error: 'Reconnect to the server before chatting.' });
      return false;
    }
    return true;
  },

  toggleChat: () => set((state) => ({ chatVisible: !state.chatVisible })),
  toggleSpectatorMessages: () =>
    set((state) => ({ showSpectatorMessages: !state.showSpectatorMessages })),

  clearGame: () => {
    // A bot game exists only in this tab, so leaving it just tells the lobby
    // this player is available again.
    if (get().gameState?.bot) {
      get().endBotSession();
      return;
    }
    // Leaving the screen is what closes a finished game's chat room, so the
    // server hears about it whether we were playing or watching.
    send(get().socket, { type: 'leave_game' });
    clearPersistedGame();
    set({
      playerColor: null,
      isSpectating: false,
      spectatedGameId: null,
      gameState: null,
      lastMove: null,
      gameSessionId: null,
      selectedTile: null,
      validMoves: [],
      opponentReconnectDeadline: null,
      chatMessages: [],
      error: null,
    });
  },

  applyAccountUpdate: (account) => {
    set({ account, error: null });
    shouldReconnect = true;
    const socket = get().socket;
    if (socket) socket.close();
    else get().connect();
  },

  clearError: () => set({ error: null }),
}));

const samePosition = (first, second) => first.x === second.x && first.y === second.y;
