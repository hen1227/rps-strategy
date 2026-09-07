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
import { createLocalSlice, initialLocalState } from './localSession';
import { createSessionSlice } from './accountSession';
import { createReachSlice } from './reachTool';
import { chatRoomIdOf, chatRoomScopeOf, withChatMessage } from './chatSelectors';
import { grantedTimeExtension, type TimeExtension } from './clockSelectors';
import { activePushTransport, pushEnabledFor } from './push';
import { WS_URL } from './serverConfig';
import {
  isStandardSetup,
  preferredColorOf,
  standardSetup,
  type SeatChoice,
} from './setupSelectors';
import { send } from './socketSend';
import { updatePausedReason } from './queueSelectors';
import type {
  ActiveGame,
  CancelledGame,
  ConnectionStatus,
  GameStore,
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
  BotBench,
  BotDrain,
  BotPresence,
  Challenge,
  ChatMessage,
  ChatRoomScope,
  LiveGameSummary,
  ModeCounts,
  Restriction,
  ServerMessage,
  ServerNotice,
  ServerUpdate,
  Tournament,
  TournamentMatchResult,
} from '@/types/protocol';

// This fallback is visible only before the server catalog arrives. The backend
// registry remains authoritative and replaces it on connection.
const BASE_MODES: ModeDefinition[] = [
  {
    id: 'V6',
    shortCode: 'V6',
    name: 'Intransitive',
    description: 'Reach their corner.',
    objective: "Move any piece onto the corner the opponent's army started in.",
    displayOrder: 1,
    playable: true,
    features: ['stalemate_loses'],
    startingPosition: {
      rows: [
        '.........',
        '...RP....',
        '..RPS....',
        '.RPS.....',
        '.PS...sp.',
        '.....spr.',
        '....spr..',
        '....pr...',
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
  /**
   * Bumped every time the server turns a move down.
   *
   * A count rather than a flag because the interesting thing is that it
   * happened *again* — two rejections in a row set the same `error` string, so
   * a listener watching that would hear the first and miss the second.
   */
  rejectedMoveCount: number;
  modes: ModeDefinition[];
  engineBots: BotPresence[];
  /**
   * The scheduled window in which no engine takes a game, running or coming.
   *
   * Held from the server rather than worked out here, even though this client
   * also knows when the tournament is: the server is what actually refuses the
   * games, and a page that decided for itself would eventually be the page that
   * says the ladder is open while every challenge to it bounces.
   */
  botBench: BotBench | null;
  botFault: { message?: string; botName?: string } | null;
  /**
   * What this account may not do right now, and empty for almost everybody.
   *
   * Held so a screen can explain a refusal *before* one happens — a muted
   * player should see a chat box that says why rather than one that swallows
   * their message. The server sends it on connect and again the moment a
   * moderator acts, so nothing here has to poll or expire it: an entry that has
   * lapsed is replaced by the next message, and `activeRestriction` below is
   * what checks the deadline in the meantime.
   */
  restrictions: Restriction[];
  /**
   * The last graceful shutdown one of this account's own bots reported.
   *
   * A signal rather than a copy of the state: the owner's page fetches the
   * authoritative list from `/api/bots/mine`, and this is what tells it there
   * is something new to fetch. Holding the drain here too would give the same
   * fact two homes that can disagree.
   */
  lastBotDrain: { botId?: string; botName?: string; drain?: BotDrain } | null;
  /**
   * The graceful restart this server is under, or null when it is not under one.
   *
   * Held in full rather than as a signal — unlike `lastBotDrain` above, there is
   * no HTTP resource to go and fetch, and the banner needs the whole of it: the
   * sentence, the count, and whether the last game has finished.
   */
  serverUpdate: ServerUpdate | null;
  /** The standing announcement, if one is up and this browser has not closed it. */
  serverNotice: ServerNotice | null;
  /**
   * The standing announcement as the *server* holds it, whether or not this
   * browser has closed the banner.
   *
   * Two fields for one notice, which needs justifying. `serverNotice` answers
   * "should the banner be up", and dismissing empties it — that is its whole
   * job. This one answers "is there a notice up on the server", and nothing
   * this browser does to its own banner may change the answer.
   *
   * The distinction exists because the host reads their own announcement with
   * both hats on. An administrator posts a notice, reads it, closes the banner
   * like anybody else — and at that point the only copy of the fact was gone,
   * so the admin screen could not tell them a notice was still standing and
   * they would leave it up until it expired. Which is precisely the failure
   * mode announcements.go calls out: "a stale banner nobody remembers posting".
   *
   * Not expiry-aware: the server stops broadcasting an expired notice but
   * nothing arrives to say it lapsed, so a reader has to check
   * `expiresAtUnixMs` against the clock. `standingNotice` in
   * `noticeSelectors.ts` is that check.
   */
  standingNotice: ServerNotice | null;
  /**
   * The id of the notice this browser dismissed. Kept so a reconnection — which
   * re-sends the standing notice on `connection_ready` — does not put a banner
   * back that somebody has already read and closed. A *new* notice has a new id
   * and comes back as it should.
   */
  dismissedNoticeId: string | null;
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
  /**
   * When a board nobody has moved on gives up waiting, or null once the game
   * has begun.
   *
   * Held beside the game rather than inside it because it is not part of the
   * position: it is a promise about the next thirty seconds, and it stops
   * meaning anything the moment somebody plays.
   */
  firstMoveDeadline: number | null;
  /** Why the last hold came to nothing. Shown briefly, then forgotten. */
  queueMiss: QueueMiss | null;
  /**
   * The board that was taken away, and why — see CancelledGame.
   *
   * Held until another board replaces it rather than shown briefly and
   * forgotten, unlike `queueMiss` beside it: this is the only account anybody
   * gets of a game that was never filed, and the person reading it may have
   * been away from the screen when it went.
   */
  cancelledGame: CancelledGame | null;
  /** People per mode who are waiting *and* at the keyboard right now. */
  modeReadyCounts: ModeCounts;
  /**
   * Whether this server can call *this* device back once it is closed. Already
   * narrowed to this build's transport, because a phone reading a browser's
   * answer would be offered a button this deployment could never honour.
   */
  pushEnabled: boolean;
  playerColor: PlayerColor | null;
  isSpectating: boolean;
  spectatedGameId: string | null;
  gameState: ActiveGame | null;
  /**
   * The game on the board so far, as PGN, for the move list and the replay
   * controls beside it.
   *
   * A board snapshot is a position and nothing else, so until the server began
   * sending this there was no history on the wire at all: a spectator who
   * arrived at move twenty, and a player who refreshed, had no moves to list
   * and nothing to step back through. It is replayed by the same
   * `reviewSourceFromPGN` a finished game's review uses — see `useGameHistory`.
   *
   * Null for a game the server never sent one for. A bot game and a local game
   * are two of those, and they write their own from the moves this browser
   * kept: `botGamePGN` and `localGamePGN`.
   */
  livePGN: string | null;
  lastMove: Move | null;
  /**
   * The bonus both clocks just gained, for the player bars to celebrate.
   *
   * Deliberately never cleared — not on a timer, and not when a game ends.
   * The bars play on this *changing* to a later instant, so one left standing
   * is inert: it cannot fire again, and the next extension is a new instant
   * whether or not the last one was ever on screen.
   */
  timeExtension: TimeExtension | null;
  selectedTile: Position | null;
  validMoves: Position[];
  opponentReconnectDeadline: number | null;
  chatMessages: ChatMessage[];
  /**
   * The conversation `chatMessages` belongs to. Not always the game on screen:
   * every game of a bot series shares one room, and every match of a bots-only
   * tournament shares one, so following a run to its next board — or an event
   * to another of its boards — stays in the chat the last one was in.
   */
  chatRoomId: string | null;
  /**
   * What that conversation covers, which is what a screen showing it calls it.
   * `game` for nearly all of them; `series` for a run and `tournament` for a
   * bots-only event, both of which carry across more than one board.
   */
  chatRoomScope: ChatRoomScope;
  /**
   * How many people are in that conversation. Not the same figure as the live
   * table's spectator count and it outlives it: a finished game leaves the
   * lobby, taking its row and that count with it, while the room it left
   * behind still has people talking in it.
   */
  chatOccupancy: number;
  chatVisible: boolean;
  showSpectatorMessages: boolean;
}

export interface LobbyActions {
  connect: () => void;
  disconnect: () => void;
  handleServerMessage: (message: ServerMessage) => void;
  joinQueue: (modeId?: ModeID | null) => void;
  leaveQueue: () => void;
  /**
   * Call off a game nobody has moved in yet, freeing the opponent at once
   * rather than making them wait out a countdown that is already decided.
   */
  abortGame: () => void;
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
  /**
   * Play a connected engine. `seat` is the side the challenger wants; 'random'
   * lets the server seat them, which it does as Red — the first move, the same
   * courtesy any other challenge carries.
   */
  challengeBot: (botId: string, modeId: ModeID, seat?: SeatChoice) => void;
  dismissBotFault: () => void;
  dismissServerNotice: () => void;
  spectateGame: (gameId: string) => void;
  /** The other half of `spectateGame`: put the watched board down. */
  stopSpectating: () => void;
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
  rejectedMoveCount: 0,
  modes: BASE_MODES,
  // Engines connected from someone's machine. Deliberately *not* named after
  // botPlayerCount below, which counts people practising against a browser
  // bot and means very nearly the opposite thing.
  engineBots: [],
  botBench: null,
  botFault: null,
  restrictions: [],
  lastBotDrain: null,
  serverUpdate: null,
  serverNotice: null,
  standingNotice: null,
  dismissedNoticeId: null,
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
  firstMoveDeadline: null,
  queueMiss: null,
  cancelledGame: null,
  playerColor: null,
  isSpectating: false,
  spectatedGameId: null,
  gameState: null,
  livePGN: null,
  lastMove: null,
  timeExtension: null,
  selectedTile: null,
  validMoves: [],
  opponentReconnectDeadline: null,
  chatMessages: [],
  chatRoomId: null,
  chatRoomScope: 'game',
  chatOccupancy: 0,
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
          // The server's answer wins: a board may have opened while this
          // browser was closed, so the id it names is one localStorage cannot
          // know. Falling back to the stored one covers an ordinary reload.
          const gameSessionId =
            message.gameId ?? state.gameSessionId ?? readGameSessionId();
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
          const lostQueue = state.queue.isSearching && !message.queue && !message.gameId;
          return {
            queue,
            queueMiss: null,
            pushEnabled: pushEnabledFor(
              activePushTransport(),
              message.pushTransports,
              message.pushEnabled ?? false,
            ),
            modeReadyCounts: message.modeReadyCounts ?? state.modeReadyCounts,
            // Both re-established on every reconnection rather than remembered,
            // because the interesting case is the one where they changed while
            // this browser was away: a deploy that started, or one that finished
            // and left the banner asserting something no longer true. An older
            // server sends neither field, and the fallbacks leave both alone.
            serverUpdate: message.update
              ? (message.update.updating ? message.update : null)
              : state.serverUpdate,
            serverNotice:
              message.notice && message.notice.id !== state.dismissedNoticeId
                ? message.notice
                : null,
            // Regardless of dismissal: this is what the server is holding, not
            // what this browser is showing.
            standingNotice: message.notice?.text ? message.notice : null,
            challengeNotice: lostQueue
              ? 'Your search ended while you were offline. Press play to start again.'
              : state.challengeNotice,
            connectionStatus: gameSessionId || spectatedGameId ? 'rejoining' : 'connected',
            account: message.account ?? state.account,
            // Who the server just said we are. On a browser where somebody has
            // signed in, that is their account rather than this browser's.
            accountId: message.account?.userId ?? state.accountId,
            engineBots: message.engineBots ?? [],
            botBench: message.botBench ?? null,
            restrictions: message.restrictions ?? [],
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
      case 'account_updated':
        // Only ever this client's own row, resent because something on it
        // changed without the client asking — a title the last game earned, or
        // one the host granted. Guarded rather than defaulted to null, so an
        // envelope with no account cannot blank the one already loaded.
        //
        // Deliberately not applyAccountUpdate, which reconnects the socket:
        // this message *came* from the server, so the profile it hands out is
        // already current and a reconnect would only drop the game in progress.
        if (message.account) set({ account: message.account });
        break;
      case 'restrictions':
        // Only ever about the receiver. Replaced wholesale rather than merged:
        // the server sends the complete set in force, so an absent kind means
        // lifted, and merging would leave a lifted mute on screen for ever.
        set({ restrictions: message.restrictions ?? [] });
        break;
      case 'moderator_notice':
        // Its own message type rather than an error, because it is not this
        // client's mistake — but it goes in the same banner, which is the one
        // place on every screen that says what just happened to you.
        set({ error: message.message ?? 'A moderator acted on this game.' });
        break;
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
        // The bench travels with the roster it explains, so the two cannot be
        // briefly out of step — a bot marked `benched` with no bench to point
        // at would be an engine that is unavailable for no stated reason.
        // Kept when absent, because an older server sends no such field and
        // dropping it would be inventing an answer on its behalf.
        set((state) => ({
          engineBots: message.engineBots ?? [],
          botBench: message.botBench ?? state.botBench,
        }));
        break;
      case 'bot_unavailable':
        set({ error: message.message ?? 'That bot is not available right now.' });
        break;
      case 'bot_drain_update':
        // Only the owner of a bot receives this. It arrives when a drain
        // starts, when it is called off, and when it settles — that last one
        // being the moment the page has to stop saying "shutting down".
        set({
          lastBotDrain: {
            botId: message.botId,
            botName: message.botName,
            drain: message.drain,
          },
        });
        break;
      case 'server_update':
        // Sent when a drain starts, when it is called off, and again when the
        // last game ends. `updating: false` is the cancellation, and takes the
        // banner down rather than leaving it to time out.
        set({ serverUpdate: message.update?.updating ? message.update : null });
        break;
      case 'server_notice':
        set((state) => {
          const notice = message.notice;
          // Empty text is how a cleared notice arrives — one message shape for
          // posting and for taking down.
          if (!notice?.text) return { serverNotice: null, standingNotice: null };
          // A notice this browser has already closed still counts as standing.
          if (notice.id === state.dismissedNoticeId) return { standingNotice: notice };
          return { serverNotice: notice, standingNotice: notice };
        });
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
          queueMiss: null,
          challengeNotice: message.message ?? null,
        });
        break;
      case 'game_cancelled': {
        // Nothing was played, so nothing is kept: the board goes, the stored
        // session id goes, and no result is ever shown. Whether the search
        // resumes is the server's call — a queue_update follows for whoever it
        // put back — so this only has to explain the gap.
        //
        // The explanation is kept twice over, because the people who need it
        // are on different screens. `queueMiss` and `challengeNotice` reach
        // somebody who was sent back to the lobby; `cancelledGame` reaches
        // whoever is still looking at the board that has just gone, which is
        // every spectator and any player who was on the game screen. Only the
        // last of those survives long enough to be read by somebody who was
        // away from the keyboard.
        const stoppedGameId = message.gameId ?? get().gameState?.gameId ?? '';
        set({
          playerColor: null,
          isSpectating: false,
          spectatedGameId: null,
          gameState: null,
          livePGN: null,
          lastMove: null,
          gameSessionId: clearPersistedGame(),
          firstMoveDeadline: null,
          connectionStatus: 'connected',
          selectedTile: null,
          validMoves: [],
          opponentReconnectDeadline: null,
          chatMessages: [],
          chatRoomId: null,
          chatRoomScope: 'game',
          chatOccupancy: 0,
          queueMiss: { message: message.message ?? '', atUnixMs: Date.now() },
          challengeNotice: message.message ?? null,
          cancelledGame: stoppedGameId
            ? {
                gameId: stoppedGameId,
                message: message.message ?? '',
                atUnixMs: Date.now(),
              }
            : null,
          error: null,
        });
        break;
      }
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
        // A found opponent takes the board: a bot game and a pass-and-play
        // game are both local and unrated, so either is dropped rather than
        // queued behind the match.
        get().endBotSession();
        get().endLocalSession();
        set({
          ...initialBotState,
          ...initialLocalState,
          playerColor: message.color,
          isSpectating: false,
          spectatedGameId: null,
          gameState: message.gameState,
          livePGN: message.pgn ?? null,
          lastMove: null,
          gameSessionId,
          firstMoveDeadline: message.firstMoveDeadlineUnixMs || null,
          connectionStatus: 'connected',
          cancelledGame: null,
          queue: initialQueue,
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
          chatRoomScope: chatRoomScopeOf(
            message.chatRoomScope,
            message.chatRoomId,
            message.gameState?.gameId,
          ),
          chatOccupancy: message.chatOccupancy ?? 0,
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
          livePGN: message.pgn ?? null,
          lastMove: null,
          gameSessionId,
          firstMoveDeadline: message.firstMoveDeadlineUnixMs || null,
          connectionStatus: 'connected',
          cancelledGame: null,
          queue: initialQueue,
          selectedTile: null,
          validMoves: [],
          opponentReconnectDeadline: message.reconnectDeadlineUnixMs || null,
          chatMessages: message.chatMessages ?? [],
          chatRoomId: chatRoomIdOf(message.chatRoomId, message.gameState?.gameId),
          chatRoomScope: chatRoomScopeOf(
            message.chatRoomScope,
            message.chatRoomId,
            message.gameState?.gameId,
          ),
          chatOccupancy: message.chatOccupancy ?? 0,
          error: null,
        });
        break;
      }
      case 'spectator_joined':
        clearPersistedGame();
        set({
          firstMoveDeadline: null,
          playerColor: 'Neutral',
          isSpectating: true,
          spectatedGameId: message.gameState?.gameId ?? null,
          gameState: message.gameState,
          livePGN: message.pgn ?? null,
          lastMove: null,
          gameSessionId: null,
          connectionStatus: 'connected',
          cancelledGame: null,
          queue: initialQueue,
          selectedTile: null,
          validMoves: [],
          opponentReconnectDeadline: null,
          chatMessages: message.chatMessages ?? [],
          chatRoomId: chatRoomIdOf(message.chatRoomId, message.gameState?.gameId),
          chatRoomScope: chatRoomScopeOf(
            message.chatRoomScope,
            message.chatRoomId,
            message.gameState?.gameId,
          ),
          chatOccupancy: message.chatOccupancy ?? 0,
          error: null,
        });
        break;
      case 'game_unavailable':
        set({
          firstMoveDeadline: null,
          playerColor: null,
          isSpectating: false,
          spectatedGameId: null,
          gameState: null,
          livePGN: null,
          lastMove: null,
          gameSessionId: clearPersistedGame(),
          connectionStatus: 'connected',
          selectedTile: null,
          validMoves: [],
          opponentReconnectDeadline: null,
          chatMessages: [],
          chatRoomId: null,
          chatRoomScope: 'game',
          chatOccupancy: 0,
          error: null,
        });
        break;
      case 'spectate_unavailable':
        set({
          playerColor: null,
          isSpectating: false,
          spectatedGameId: null,
          gameState: null,
          livePGN: null,
          lastMove: null,
          selectedTile: null,
          validMoves: [],
          opponentReconnectDeadline: null,
          chatMessages: [],
          chatRoomId: null,
          chatRoomScope: 'game',
          chatOccupancy: 0,
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
        // A running clock is the board's own way of saying the game has begun,
        // so the deadline is read off the position rather than tracked
        // separately and left to go stale.
        const awaitingFirstMove =
          message.gameState?.status === 'InProgress' &&
          message.gameState.clock.activeColor === 'Neutral';
        // Nothing in a snapshot says a bonus just landed, so it is read out of
        // the pair. Both players and every spectator get the same pair, so the
        // flourish plays on all of their boards at once.
        const bonusMs = grantedTimeExtension(current.gameState, message.gameState);
        set((state) => ({
          gameState: message.gameState,
          // Kept rather than cleared when a message arrives without one. A
          // server that no longer holds the record — a game whose session has
          // been retired — sends no history, and dropping the one we have would
          // empty the move list at the moment somebody wants to read it.
          livePGN: message.pgn ?? state.livePGN,
          timeExtension: bonusMs === null ? state.timeExtension : { at: Date.now(), bonusMs },
          firstMoveDeadline: awaitingFirstMove ? state.firstMoveDeadline : null,
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
      case 'chat_presence':
        set((state) => {
          // Matched on the room for the same reason a message is: a series
          // changeover moves the board without moving the conversation.
          const room = chatRoomIdOf(state.chatRoomId, state.gameState?.gameId);
          if (!room || (message.chatRoomId ?? room) !== room) return {};
          const chatOccupancy = message.chatOccupancy ?? 0;
          return chatOccupancy === state.chatOccupancy ? {} : { chatOccupancy };
        });
        break;
      case 'spectator_left':
        if (get().isSpectating) {
          set({
            playerColor: null,
            isSpectating: false,
            spectatedGameId: null,
            gameState: null,
            livePGN: null,
            lastMove: null,
            selectedTile: null,
            validMoves: [],
            chatMessages: [],
            chatRoomId: null,
            chatRoomScope: 'game',
            chatOccupancy: 0,
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
        // Counted as well as shown, so the board can say it out loud. A
        // rejected chat line deliberately does not: only a refused *move* is
        // what the illegal-move sound means.
        set((state) => ({
          error: message.message ?? 'Something went wrong.',
          rejectedMoveCount: state.rejectedMoveCount + 1,
        }));
        break;
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
    const { socket, modes, defaultTimeControl, queue, serverUpdate } = get();
    const modeId = requestedModeId ?? modes[0]?.id;
    const mode = modes.find((candidate) => candidate.id === modeId);
    if (!modeId) {
      set({ error: 'No game modes are available.' });
      return;
    }
    // Answered here rather than sent and corrected. The server refuses a seek
    // for the whole of a drain — matchmaking stops pairing, so one posted now
    // could never fill — and its refusal comes back as a plain `error`, which
    // sets the banner and leaves the optimistic search below standing. That was
    // a wait counting up for the length of a deploy against a queue the server
    // had never put anybody in.
    if (serverUpdate) {
      set({ error: updatePausedReason(serverUpdate.note) });
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
    const { socket } = get();
    // Cleared locally whatever the socket did, and remembered if it could not
    // carry the message. Pressing cancel and being told you are out, while the
    // server goes on holding your place, is the one outcome this must not have.
    if (!send(socket, { type: 'leave_queue' })) {
      leaveQueueOnReconnect = true;
    }
    set({ queue: initialQueue, queueMiss: null });
  },

  abortGame: () => {
    // Nothing is set optimistically. The server decides whether this game is
    // still abortable — a move may have landed while the press was in flight —
    // and answers with either game_cancelled or a refusal.
    if (!send(get().socket, { type: 'abort_game' })) {
      set({ error: 'Reconnect to the server before calling the game off.' });
    }
  },

  reportPresence: (present) => {
    const { socket, queue } = get();
    // Nothing is waiting on us, so nothing needs to know where we are. An idle
    // browsing session should generate no presence traffic at all.
    if (!queue.isSearching) return;
    send(socket, { type: 'queue_presence', present });
  },

  challengePlayer: (username, setup) => {
    const { socket, serverUpdate } = get();
    // The same refusal the queue gets, and for the same reason: a challenge is
    // a seek, and postSeek turns every one of them away while a drain is on.
    if (serverUpdate) {
      set({ error: updatePausedReason(serverUpdate.note) });
      return false;
    }
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
    const { socket, modes, defaultTimeControl, serverUpdate } = get();
    if (!setup?.modeId) {
      set({ error: 'No game modes are available.' });
      return false;
    }
    if (serverUpdate) {
      set({ error: updatePausedReason(serverUpdate.note) });
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

  challengeBot: (botId, modeId, seat = 'random') => {
    const preferredColor = preferredColorOf(seat);
    if (!botId || !send(get().socket, { type: 'challenge_bot', botId, modeId, preferredColor })) {
      set({ error: 'Connect to the server before challenging a bot.' });
      return;
    }
    set({ error: null });
  },

  dismissBotFault: () => set({ botFault: null }),

  // Remembered by id, so the banner stays down across the reconnection that
  // follows it rather than reappearing the moment the socket comes back.
  //
  // `standingNotice` is deliberately untouched: closing the banner is a
  // statement about this browser, not about the server, and the admin screen
  // reads the latter. See the field's own note.
  dismissServerNotice: () =>
    set((state) => ({
      serverNotice: null,
      dismissedNoticeId: state.serverNotice?.id ?? state.dismissedNoticeId,
    })),

  spectateGame: (gameId) => {
    if (!gameId || !send(get().socket, { type: 'spectate_game', gameId })) {
      set({ error: 'Connect to the server before spectating a game.' });
      return;
    }
    set({ spectatedGameId: gameId, error: null });
  },

  // Watching is a thing you are doing, not a thing you did, so somebody who
  // walks away from the watch screen has to be taken out of the game they were
  // watching — see the rule in `SessionBridge` that calls this. Left standing,
  // it is wrong twice over: the server goes on counting a viewer who left in
  // the game's audience and delivering it their chat, and every WATCH button on
  // the lobby stays disabled, because the store still holds a board. That is
  // the bug this exists to fix; it used to take a page refresh to clear.
  //
  // A pending request counts. `spectatedGameId` is set the moment the board is
  // asked for, and somebody who turns back before the answer arrives has still
  // stopped watching.
  //
  // `leave_game` rather than `stop_spectating`, because a watched game that has
  // *finished* leaves the viewer sitting in its chat room rather than in its
  // spectator set, and only the one message covers both — it is what the back
  // button on the board sends for the same reason. The server ignores it from a
  // client that is in neither.
  stopSpectating: () => {
    const { isSpectating, spectatedGameId } = get();
    if (!isSpectating && !spectatedGameId) return;
    send(get().socket, { type: 'leave_game' });
    set({
      playerColor: null,
      isSpectating: false,
      spectatedGameId: null,
      gameState: null,
      livePGN: null,
      lastMove: null,
      selectedTile: null,
      validMoves: [],
      opponentReconnectDeadline: null,
      chatMessages: [],
      chatRoomId: null,
      chatRoomScope: 'game',
      chatOccupancy: 0,
      error: null,
    });
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
    // A local game has no server session and no opponent either — both sides
    // are this keyboard, so the colour check below would refuse half the moves.
    if (gameState.local) {
      get().localSelectTile(position);
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
    if (!gameState || gameState.status !== 'InProgress') return;
    // Checked before the turn guard rather than after it: nobody owns a colour
    // at a local board, so `playerColor` is null there and the guard below
    // would reject every move.
    if (gameState.local) {
      get().localMovePiece(from, to);
      return;
    }
    if (gameState.currentTurn !== playerColor) return;
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
    // Both players are in the room, so there is nobody to send the offer to:
    // the agreement already happened and this records it.
    if (get().gameState?.local) {
      get().drawLocalGame();
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
    if (get().gameState?.local) {
      get().resignLocalGame();
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
    // A local game was never announced to anybody, so leaving it says nothing
    // at all.
    if (get().gameState?.local) {
      get().endLocalSession();
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
      // Walking away from the board is having read why it went. Left standing,
      // the notice would still be the first thing on this screen the next time
      // somebody arrived at it with no game on.
      cancelledGame: null,
      gameState: null,
      livePGN: null,
      lastMove: null,
      gameSessionId: null,
      selectedTile: null,
      validMoves: [],
      opponentReconnectDeadline: null,
      chatMessages: [],
      chatRoomId: null,
      chatRoomScope: 'game',
      chatOccupancy: 0,
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
  ...createLocalSlice(...args),
  ...createSessionSlice(...args),
  ...createReachSlice(...args),
}));
