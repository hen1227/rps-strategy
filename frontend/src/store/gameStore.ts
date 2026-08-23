import { create, type StateCreator } from 'zustand';

import { listTournaments } from './api/tournaments';
import {
  clearGameSessionId,
  getOrCreateProfileKey,
  getOrCreateUserId,
  readGameSessionId,
  saveGameSessionId,
} from './localIdentity';
import { createBotSlice, initialBotState } from './botSession';
import { createSessionSlice } from './accountSession';
import { chatRoomIdOf, withChatMessage } from './chatSelectors';
import { WS_URL } from './serverConfig';
import { isStandardSetup, standardSetup } from './setupSelectors';
import { send } from './socketSend';
import { CLAIM_WINDOW_MS } from './queueSelectors';
import type {
  ActiveGame,
  ConnectionStatus,
  GameStore,
  QueueClaim,
  QueueMiss,
  QueueState,
} from './types';
import { inferMoveBetweenGrids } from '@/engine/moveDiff';
import {
  samePosition,
  type GameSetup,
  type ModeDefinition,
  type ModeID,
  type Move,
  type PlayerColor,
  type Position,
  type TimeControl,
} from '@/types/game';
import type {
  Account,
  BotPresence,
  Challenge,
  ChatMessage,
  LiveGameSummary,
  ModeCounts,
  PendingMatchView,
  ServerMessage,
  Tournament,
  TournamentMatchResult,
} from '@/types/protocol';

// This fallback is visible only before the server catalog arrives. The backend
// registry remains authoritative and replaces it on connection.
const BASE_MODES: ModeDefinition[] = [
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

const initialQueue: QueueState = {
  isSearching: false,
  modeId: null,
  setup: null,
  searchRange: 10000,
  queuedSinceUnixMs: null,
};

/**
 * Re-anchor a wait only when the server disagrees with us by more than this.
 *
 * The server pushes a fresh duration every couple of seconds. Trusting each one
 * exactly would make the on-screen number stutter backwards by a few hundred
 * milliseconds every time, so the local anchor stands until it is properly
 * wrong — which is what happens after a reconnection, and is the case that
 * matters.
 */
const QUEUE_ANCHOR_DRIFT_MS = 1500;

const anchorWait = (
  existing: number | null,
  queuedForMs: number | undefined,
  nowMs: number,
): number => {
  const reported = nowMs - (queuedForMs ?? 0);
  if (existing === null) return reported;
  return Math.abs(existing - reported) > QUEUE_ANCHOR_DRIFT_MS ? reported : existing;
};

/** A hold, as the store keeps it: server durations turned into local instants. */
const claimFrom = (
  pending: PendingMatchView,
  nowMs: number,
  wasClaiming: boolean,
): QueueClaim => ({
  pendingId: pending.id,
  role: pending.summoned ? 'summoned' : 'present',
  deadlineUnixMs: pending.deadlineUnixMs || nowMs + CLAIM_WINDOW_MS,
  opponent: pending.opponent,
  opponentElo: pending.opponentElo ?? null,
  modeId: pending.modeId,
  modeName: pending.modeName,
  setup: pending.setup,
  claiming: wasClaiming,
});

// This browser's own identity, as distinct from the store's `accountId`,
// which is whoever the server says we are right now. The two differ on a
// browser where somebody has signed in to an account claimed elsewhere.
const localUserId = getOrCreateUserId();
const profileKey = getOrCreateProfileKey();
let shouldReconnect = true;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempts = 0;
/**
 * Set when the player pressed cancel on a socket that could not carry it.
 *
 * Leaving the queue has to be honest: the screen says you are out, so you must
 * actually be out. Without this the click would be swallowed and the server
 * would go on holding a place the player believes they gave up.
 */
let leaveQueueOnReconnect = false;

/**
 * How long to wait before trying the socket again.
 *
 * A fixed one-second retry hammered a server that was down, which mattered
 * little when a dropped socket only cost you a spinner. It matters now: the
 * queue depends on getting back, and getting back is also how a held seat is
 * claimed. Backing off with jitter is kinder to the server; the visibility
 * listener in useQueuePresence is what keeps a returning player from ever
 * sitting out the long end of it.
 */
const reconnectDelay = () => {
  const delay = Math.min(15_000, 500 * 2 ** reconnectAttempts);
  reconnectAttempts += 1;
  return delay + Math.random() * 250;
};

const persistGame = (gameState: ActiveGame | null | undefined) => {
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
const carryLiveState = (next: Tournament, existing: Tournament | undefined): Tournament => ({
  ...next,
  matchStates: next.matchStates ?? existing?.matchStates ?? [],
});

const findTournament = (tournaments: Tournament[], tournamentId: string) =>
  tournaments.find((tournament) => tournament.tournamentId === tournamentId);

const mergeTournament = (tournaments: Tournament[], next: Tournament | null | undefined) => {
  if (!next?.tournamentId) return tournaments;
  const existing = findTournament(tournaments, next.tournamentId);
  const merged = carryLiveState(next, existing);
  return existing
    ? tournaments.map((tournament) =>
        tournament.tournamentId === merged.tournamentId ? merged : tournament,
      )
    : [merged, ...tournaments];
};

const mergeTournamentList = (tournaments: Tournament[], incoming: Tournament[]) =>
  incoming.map((next) => carryLiveState(next, findTournament(tournaments, next.tournamentId)));

// The server republishes the lobby counts every couple of seconds whether or
// not they moved, so they are compared before they are stored: a fresh object
// re-renders every screen watching them, which is wasted work in the lobby and
// noise for anyone in the middle of a game.
const sameCounts = (current: ModeCounts, next: ModeCounts) => {
  const keys = Object.keys(next);
  if (keys.length !== Object.keys(current).length) return false;
  return keys.every((key) => current[key] === next[key]);
};

/**
 * The move an incoming snapshot represents, when it is the very next one.
 *
 * A snapshot from a different game, or one that skipped a move, cannot be
 * explained by a single move — so nothing is highlighted rather than something
 * wrong being highlighted.
 */
const inferLastMove = (
  previousGame: ActiveGame | null | undefined,
  nextGame: ActiveGame | null | undefined,
): Move | null => {
  if (
    !previousGame ||
    !nextGame ||
    previousGame.gameId !== nextGame.gameId ||
    nextGame.moveNumber !== previousGame.moveNumber + 1
  ) {
    return null;
  }
  return inferMoveBetweenGrids(previousGame.grid, nextGame.grid);
};

/** Everything the lobby, the socket, and a live game contribute to the store. */
export interface LobbyState {
  socket: WebSocket | null;
  /** Who the server says we are, which on a signed-in browser is their account. */
  accountId: string;
  profileKey: string;
  account: Account | null;
  gameSessionId: string | null;
  connectionStatus: ConnectionStatus;
  error: string | null;
  modes: ModeDefinition[];
  engineBots: BotPresence[];
  botFault: { message?: string; botName?: string } | null;
  modePlayerCounts: ModeCounts;
  modeQueueCounts: ModeCounts;
  botPlayerCount: number;
  /** Everyone connected to the lobby, whatever they are doing. */
  onlineCount: number;
  liveGames: LiveGameSummary[];
  tournaments: Tournament[];
  incomingChallenges: Challenge[];
  /**
   * The public board: challenges nobody has claimed. Kept apart from
   * `incomingChallenges` because "somebody challenged me" and "somebody is
   * looking for a game" are different news.
   */
  openChallenges: Challenge[];
  outgoingChallenge: Challenge | null;
  acceptingChallengeId: string | null;
  challengeNotice: string | null;
  /** The clock a game gets when nobody chose one, as the server defines it. */
  defaultTimeControl: TimeControl | null;
  queue: QueueState;
  /** A game arranged but not started, because somebody has to answer for it. */
  claim: QueueClaim | null;
  /** Why the last hold came to nothing. Shown briefly, then forgotten. */
  queueMiss: QueueMiss | null;
  /** People per mode who are waiting *and* at the keyboard right now. */
  modeReadyCounts: ModeCounts;
  /** Whether this server can call anybody back when their tab is closed. */
  pushEnabled: boolean;
  playerColor: PlayerColor | null;
  isSpectating: boolean;
  spectatedGameId: string | null;
  gameState: ActiveGame | null;
  lastMove: Move | null;
  selectedTile: Position | null;
  validMoves: Position[];
  opponentReconnectDeadline: number | null;
  chatMessages: ChatMessage[];
  /**
   * The conversation `chatMessages` belongs to. Not always the game on screen:
   * every game of a bot series shares one room, so following a run to its next
   * board stays in the same chat as the board left behind.
   */
  chatRoomId: string | null;
  chatVisible: boolean;
  showSpectatorMessages: boolean;
}

export interface LobbyActions {
  connect: () => void;
  disconnect: () => void;
  handleServerMessage: (message: ServerMessage) => void;
  joinQueue: (modeId?: ModeID | null) => void;
  leaveQueue: () => void;
  /** Take a seat that is being held. */
  claimMatch: () => void;
  /** Give up a seat now, so the other player is freed at once. */
  declineMatch: () => void;
  /** Tell the server whether a person is actually behind this tab. */
  reportPresence: (present: boolean) => void;
  challengePlayer: (username: string, setup: GameSetup) => boolean;
  /**
   * Offer a game to the whole lobby. Separate from `challengePlayer` on
   * purpose: there, an empty username is a mistake worth catching, and here it
   * is the entire point, so one function cannot guard both.
   *
   * A setup that turns out to be the standard game is sent as a plain search
   * instead, because that is what it is. The server reaches the same conclusion
   * on its own; doing it here as well is what keeps the screen from claiming to
   * have posted something for the length of a round trip.
   */
  postOpenChallenge: (setup: GameSetup) => boolean;
  acceptChallenge: (challengeId: string) => void;
  declineChallenge: (challengeId: string) => void;
  cancelChallenge: (challengeId: string) => void;
  challengeBot: (botId: string, modeId: ModeID) => void;
  dismissBotFault: () => void;
  spectateGame: (gameId: string) => void;
  loadTournaments: () => Promise<void>;
  applyTournamentUpdate: (tournament: Tournament) => void;
  readyForTournamentMatch: (tournamentId: string, matchId: number) => void;
  withdrawFromTournamentMatch: (tournamentId: string, matchId: number) => void;
  selectTile: (position: Position) => void;
  movePiece: (from: Position, to: Position) => void;
  offerDraw: () => void;
  acceptDraw: () => void;
  declineDraw: () => void;
  offerTimeExtension: () => void;
  acceptTimeExtension: () => void;
  declineTimeExtension: () => void;
  resignGame: () => void;
  sendChat: (text: string) => boolean;
  toggleChat: () => void;
  toggleSpectatorMessages: () => void;
  clearGame: () => void;
  applyAccountUpdate: (account: Account | null) => void;
  clearError: () => void;
}

export type LobbySlice = LobbyState & LobbyActions;

const createLobbySlice: StateCreator<GameStore, [], [], LobbySlice> = (set, get) => ({
  socket: null,
  accountId: localUserId,
  profileKey,
  account: null,
  gameSessionId: readGameSessionId(),
  connectionStatus: 'disconnected',
  error: null,
  modes: BASE_MODES,
  // Engines connected from someone's machine. Deliberately *not* named after
  // botPlayerCount below, which counts people practising against a browser
  // bot and means very nearly the opposite thing.
  engineBots: [],
  botFault: null,
  modePlayerCounts: {},
  // Players waiting in matchmaking right now, per mode. The bot board watches
  // this so someone practising against a bot still hears the door knock.
  modeQueueCounts: {},
  modeReadyCounts: {},
  pushEnabled: false,
  // Everyone on the site currently playing a bot instead of a person.
  botPlayerCount: 0,
  onlineCount: 0,
  liveGames: [],
  tournaments: [],
  incomingChallenges: [],
  openChallenges: [],
  outgoingChallenge: null,
  acceptingChallengeId: null,
  challengeNotice: null,
  defaultTimeControl: null,
  queue: initialQueue,
  claim: null,
  queueMiss: null,
  playerColor: null,
  isSpectating: false,
  spectatedGameId: null,
  gameState: null,
  lastMove: null,
  selectedTile: null,
  validMoves: [],
  opponentReconnectDeadline: null,
  chatMessages: [],
  chatRoomId: null,
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
        userId: localUserId,
        profileKey: get().profileKey,
        // A signed-in player is their account here rather than whatever this
        // browser is called. The server prefers the token when it is set.
        sessionToken: get().sessionToken ?? '',
      });
    };
    socket.onerror = () => {
      if (get().socket === socket) set({ error: 'Could not reach the game server.' });
    };
    socket.onclose = () => {
      if (get().socket !== socket) return;
      // The queue and this player's own challenge deliberately survive. The
      // server holds a place for somebody it can call back, so wiping it here
      // would show a cancelled search for a search that is still running — and
      // a one-second blip would look exactly like being dropped. What does get
      // cleared is everybody *else's* live state, where stale is worse than
      // empty.
      set({
        socket: null,
        connectionStatus: 'disconnected',
        incomingChallenges: [],
        openChallenges: [],
        acceptingChallengeId: null,
      });
      if (shouldReconnect && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          get().connect();
        }, reconnectDelay());
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
      claim: null,
      queueMiss: null,
      incomingChallenges: [],
      openChallenges: [],
      outgoingChallenge: null,
      acceptingChallengeId: null,
    });
  },

  handleServerMessage: (message) => {
    switch (message.type) {
      case 'connection_ready':
        reconnectAttempts = 0;
        set((state) => {
          const modes = message.modes?.length ? message.modes : state.modes;
          const gameSessionId = state.gameSessionId ?? readGameSessionId();
          const spectatedGameId = gameSessionId ? null : state.spectatedGameId;
          if (gameSessionId) {
            send(state.socket, { type: 'rejoin_game', gameId: gameSessionId });
          } else if (spectatedGameId) {
            send(state.socket, { type: 'spectate_game', gameId: spectatedGameId });
          }
          // A cancel that could not be sent is honoured now rather than lost.
          if (leaveQueueOnReconnect) {
            leaveQueueOnReconnect = false;
            send(state.socket, { type: 'leave_queue' });
          }
          const now = Date.now();
          // The third thing a reconnecting client re-establishes, beside its
          // game and whatever it was watching. It is *told* rather than asked
          // to guess: re-sending join_queue would mint a new seek and throw
          // away the wait already served.
          const queue: QueueState = message.queue
            ? {
                isSearching: true,
                modeId: message.queue.modeId,
                setup: message.queue.setup,
                searchRange: message.queue.searchRange || 10000,
                queuedSinceUnixMs: anchorWait(
                  state.queue.queuedSinceUnixMs,
                  message.queue.queuedForMs,
                  now,
                ),
              }
            : initialQueue;
          // Somebody who came back to find their search gone deserves a reason,
          // not an inexplicably empty lobby.
          const lostQueue = state.queue.isSearching && !message.queue && !message.pendingMatch;
          return {
            queue,
            claim: message.pendingMatch
              ? claimFrom(message.pendingMatch, now, false)
              : null,
            queueMiss: null,
            pushEnabled: message.pushEnabled ?? false,
            modeReadyCounts: message.modeReadyCounts ?? state.modeReadyCounts,
            challengeNotice: lostQueue
              ? 'Your search ended while you were offline. Press play to start again.'
              : state.challengeNotice,
            connectionStatus: gameSessionId || spectatedGameId ? 'rejoining' : 'connected',
            account: message.account ?? state.account,
            // Who the server just said we are. On a browser where somebody has
            // signed in, that is their account rather than this browser's.
            accountId: message.account?.userId ?? state.accountId,
            engineBots: message.engineBots ?? [],
            gameSessionId,
            spectatedGameId,
            modes,
            defaultTimeControl: message.defaultTimeControl ?? state.defaultTimeControl,
            modePlayerCounts: message.modePlayerCounts ?? state.modePlayerCounts,
            modeQueueCounts: message.modeQueueCounts ?? state.modeQueueCounts,
            botPlayerCount: message.botPlayerCount ?? 0,
            onlineCount: message.onlineCount ?? 0,
            liveGames: message.liveGames ?? [],
            tournaments: message.tournaments ?? [],
            incomingChallenges: message.challenges ?? [],
            openChallenges: message.openChallenges ?? [],
            // Your own row is on the board the server just sent, so a
            // reconnection can recover it rather than losing the game you
            // posted and leaving the bar with nothing to cancel.
            outgoingChallenge:
              (message.openChallenges ?? []).find(
                (challenge) =>
                  !challenge.queued &&
                  challenge.challenger.userId ===
                    (message.account?.userId ?? state.accountId),
              ) ?? null,
            acceptingChallengeId: null,
          };
        });
        // The server forgets a bot session when the socket drops, so a
        // reconnected bot player announces themselves again.
        get().announceBotPresence();
        break;
      case 'authentication_failed':
        // A session the server no longer accepts is the one failure the client
        // can resolve by itself: drop it, and the reconnect that follows this
        // socket closing comes back as this browser's anonymous identity.
        if (get().sessionToken) {
          get().clearSession();
          set({ error: message.message ?? 'Your session has expired. Sign in again.' });
          break;
        }
        shouldReconnect = false;
        set({
          connectionStatus: 'disconnected',
          error: message.message ?? 'This device could not authenticate the local account.',
        });
        break;
      case 'mode_player_counts': {
        const modePlayerCounts = message.modePlayerCounts ?? {};
        const modeQueueCounts = message.modeQueueCounts ?? {};
        const modeReadyCounts = message.modeReadyCounts ?? {};
        const botPlayerCount = message.botPlayerCount ?? 0;
        const onlineCount = message.onlineCount ?? 0;
        const state = get();
        if (
          state.botPlayerCount === botPlayerCount &&
          state.onlineCount === onlineCount &&
          sameCounts(state.modePlayerCounts, modePlayerCounts) &&
          sameCounts(state.modeQueueCounts, modeQueueCounts) &&
          sameCounts(state.modeReadyCounts, modeReadyCounts)
        ) {
          break;
        }
        set({
          modePlayerCounts,
          modeQueueCounts,
          modeReadyCounts,
          botPlayerCount,
          onlineCount,
        });
        break;
      }
      case 'live_games':
        set({ liveGames: message.liveGames ?? [] });
        break;
      case 'open_challenges':
        // The whole board every time rather than a delta, so a client that
        // missed a message cannot keep offering a game that is gone.
        set({ openChallenges: message.openChallenges ?? [] });
        break;
      case 'tournaments':
        set({ tournaments: message.tournaments ?? [] });
        break;
      case 'engine_bots':
        set({ engineBots: message.engineBots ?? [] });
        break;
      case 'bot_unavailable':
        set({ error: message.message ?? 'That bot is not available right now.' });
        break;
      case 'bot_fault':
        // Only the owner of a bot receives this, and it is the only place the
        // real reason an engine broke is visible to them.
        set({ botFault: { message: message.message, botName: message.botName } });
        break;
      case 'tournament_rejected':
        set({ error: message.message ?? 'That tournament match is not available.' });
        break;
      case 'queue_update':
        set((state) => ({
          queue: {
            isSearching: true,
            modeId: message.modeId ?? state.queue.modeId,
            setup: message.setup ?? state.queue.setup,
            searchRange: message.searchRange ?? 10000,
            queuedSinceUnixMs: anchorWait(
              state.queue.queuedSinceUnixMs,
              message.queuedForMs,
              Date.now(),
            ),
          },
          // The server answers a posted game that turned out to be the standard
          // one with a queue update, so arriving here clears the outgoing
          // challenge the screen was expecting.
          outgoingChallenge: null,
        }));
        break;
      case 'queue_left':
        set({
          queue: initialQueue,
          claim: null,
          queueMiss: null,
          challengeNotice: message.message ?? null,
        });
        break;
      case 'match_pending': {
        const pending = message.pendingMatch;
        if (!pending) break;
        set((state) => ({
          // A hold that is already ours keeps its `claiming` flag, so the
          // button does not flicker back to idle while the claim is in flight.
          claim: claimFrom(
            pending,
            Date.now(),
            state.claim?.pendingId === pending.id && state.claim.claiming,
          ),
          queueMiss: null,
        }));
        break;
      }
      case 'match_missed':
        // The seek is back on the board and the server will send a fresh
        // queue_update for it; all this has to do is explain the gap.
        set({
          claim: null,
          queueMiss: { message: message.message ?? '', atUnixMs: Date.now() },
        });
        break;
      case 'match_unavailable':
        set({ claim: null, error: message.message ?? 'That match is no longer waiting.' });
        break;
      case 'challenge_received': {
        const received = message.challenge;
        if (received) {
          set((state) => ({
            incomingChallenges: state.incomingChallenges.some(
              (challenge) => challenge.id === received.id,
            )
              ? state.incomingChallenges
              : [...state.incomingChallenges, received],
            challengeNotice: null,
          }));
        }
        break;
      }
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
          claim: null,
          queueMiss: null,
          incomingChallenges: [],
          outgoingChallenge: null,
          acceptingChallengeId: null,
          challengeNotice: null,
          selectedTile: null,
          validMoves: [],
          opponentReconnectDeadline: null,
          chatMessages: message.chatMessages ?? [],
          chatRoomId: chatRoomIdOf(message.chatRoomId, message.gameState?.gameId),
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
          chatRoomId: chatRoomIdOf(message.chatRoomId, message.gameState?.gameId),
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
          chatRoomId: chatRoomIdOf(message.chatRoomId, message.gameState?.gameId),
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
          chatRoomId: null,
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
          chatRoomId: null,
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
          if (!chatMessage) return {};
          // Matched on the room rather than the board on screen, so a message
          // from the next game of a series lands in this conversation.
          const room = chatRoomIdOf(state.chatRoomId, state.gameState?.gameId);
          const chatMessages = withChatMessage(state.chatMessages, room, chatMessage);
          return chatMessages === state.chatMessages ? {} : { chatMessages };
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
            chatRoomId: null,
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
    const { socket, modes, defaultTimeControl, queue } = get();
    const modeId = requestedModeId ?? modes[0]?.id;
    const mode = modes.find((candidate) => candidate.id === modeId);
    if (!modeId) {
      set({ error: 'No game modes are available.' });
      return;
    }
    // Switching modes is leaving one queue and joining another. The server
    // allows one seek per person, so saying so explicitly is what makes the
    // other mode's PLAY button work while a search is already running — which
    // it now must, because searching no longer takes the page over.
    if (queue.isSearching && queue.modeId !== modeId) {
      send(socket, { type: 'leave_queue' });
    }
    if (!send(socket, { type: 'join_queue', modeId })) {
      set({ error: 'Connect to the server before finding a match.' });
      return;
    }
    set({
      queue: {
        ...initialQueue,
        modeId,
        setup: mode ? standardSetup(mode, defaultTimeControl) : null,
        isSearching: true,
        queuedSinceUnixMs: Date.now(),
      },
      queueMiss: null,
      error: null,
    });
  },

  leaveQueue: () => {
    const { socket, claim } = get();
    if (claim) {
      send(socket, { type: 'decline_match', pendingMatchId: claim.pendingId });
    }
    // Cleared locally whatever the socket did, and remembered if it could not
    // carry the message. Pressing cancel and being told you are out, while the
    // server goes on holding your place, is the one outcome this must not have.
    if (!send(socket, { type: 'leave_queue' })) {
      leaveQueueOnReconnect = true;
    }
    set({ queue: initialQueue, claim: null, queueMiss: null });
  },

  claimMatch: () => {
    const { socket, claim } = get();
    if (!claim) return;
    if (!send(socket, { type: 'claim_match', pendingMatchId: claim.pendingId })) {
      set({ error: 'Connect to the server before taking your seat.' });
      return;
    }
    set({ claim: { ...claim, claiming: true }, error: null });
  },

  declineMatch: () => {
    const { socket, claim } = get();
    if (!claim) return;
    send(socket, { type: 'decline_match', pendingMatchId: claim.pendingId });
    // The seat is given up but the search is not: declining one game is not
    // leaving the queue, and the server puts the seek straight back.
    set({ claim: null });
  },

  reportPresence: (present) => {
    const { socket, queue, claim } = get();
    // Nothing is waiting on us, so nothing needs to know where we are. An idle
    // browsing session should generate no presence traffic at all.
    if (!queue.isSearching && !claim) return;
    send(socket, { type: 'queue_presence', present });
  },

  challengePlayer: (username, setup) => {
    const { socket } = get();
    const trimmedUsername = username?.trim();
    if (!trimmedUsername) {
      set({ error: 'Enter the username you want to challenge.' });
      return false;
    }
    if (!setup?.modeId) {
      set({ error: 'No game modes are available.' });
      return false;
    }
    if (
      !send(socket, { type: 'send_challenge', username: trimmedUsername, setup })
    ) {
      set({ error: 'Connect to the server before sending a challenge.' });
      return false;
    }
    set({ error: null, challengeNotice: null });
    return true;
  },

  postOpenChallenge: (setup) => {
    const { socket, modes, defaultTimeControl } = get();
    if (!setup?.modeId) {
      set({ error: 'No game modes are available.' });
      return false;
    }
    const mode = modes.find((candidate) => candidate.id === setup.modeId);
    // Nothing was changed, so there is nothing to advertise that matchmaking
    // was not already offering. This is the same conclusion the server draws.
    if (isStandardSetup(setup, mode, defaultTimeControl)) {
      get().joinQueue(setup.modeId);
      return true;
    }
    // No username: the server reads that as an offer to the room.
    if (!send(socket, { type: 'send_challenge', setup })) {
      set({ error: 'Connect to the server before posting a challenge.' });
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

  challengeBot: (botId, modeId) => {
    if (!botId || !send(get().socket, { type: 'challenge_bot', botId, modeId })) {
      set({ error: 'Connect to the server before challenging a bot.' });
      return;
    }
    set({ error: null });
  },

  dismissBotFault: () => set({ botFault: null }),

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
      chatRoomId: null,
      error: null,
    });
  },

  applyAccountUpdate: (account) => {
    set({ account, accountId: account?.userId ?? localUserId, error: null });
    shouldReconnect = true;
    const socket = get().socket;
    if (socket) socket.close();
    else get().connect();
  },

  clearError: () => set({ error: null }),
});

export const useGameStore = create<GameStore>()((...args) => ({
  ...createLobbySlice(...args),
  ...createBotSlice(...args),
  ...createSessionSlice(...args),
}));
