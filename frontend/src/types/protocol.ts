// The WebSocket protocol, both directions.
//
// The Go end (`backend/internal/server/protocol.go`) sends one wide envelope
// with almost every field optional, because a single struct has to serialise
// every message. Nothing forces us to model it that way. Here each message is
// its own type, discriminated by `type`, so `switch (message.type)` narrows to
// exactly the fields that message actually carries — and a handler that reads
// a field the server never sends for that type does not compile.
//
// The union is closed on purpose. A server message this client has no case for
// is a protocol change, and the compiler pointing at the unhandled `type` is
// how we find out.

import type {
  GameState,
  ModeDefinition,
  ModeID,
  PlayerColor,
  PlayerProfile,
  Position,
  StartingPosition,
  TimeControl,
} from './game';

/* ---------------------------------------------------------------- shared -- */

/** A private, unranked invitation addressed to a display name. */
export interface Challenge {
  id: string;
  challenger: PlayerProfile;
  targetUsername: string;
  modeId: ModeID;
  modeName: string;
  timeControl: TimeControl;
  startingPosition?: StartingPosition;
  createdAtUnixMs: number;
  expiresAtUnixMs: number;
}

/** The public lobby row for a game in progress. */
export interface LiveGameSummary {
  gameId: string;
  modeId: ModeID;
  modeName: string;
  redPlayer: PlayerProfile;
  bluePlayer: PlayerProfile;
  redElo: number;
  blueElo: number;
  spectatorCount: number;
  startedAtUnixMs: number;
}

export type ChatSenderRole = 'player' | 'spectator';

export interface ChatMessage {
  id: string;
  gameId: string;
  senderUserId: string;
  senderName: string;
  senderRole: ChatSenderRole | string;
  senderColor?: PlayerColor;
  text: string;
  sentAtUnixMs: number;
}

export interface ModeRating {
  modeId: ModeID;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  gamesPlayed: number;
  updatedAtUnixMs: number;
}

export type AccountKind = 'human' | 'bot';

export interface Account {
  userId: string;
  kind: AccountKind | string;
  username: string;
  registered: boolean;
  isAdmin: boolean;
  disabled: boolean;
  discord: string;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  gamesPlayed: number;
  modeRatings: Partial<Record<ModeID, ModeRating>>;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
}

export interface RatingUpdate {
  recorded: boolean;
  ranked: boolean;
  modeId: ModeID;
  redEloBefore: number;
  redEloAfter: number;
  blueEloBefore: number;
  blueEloAfter: number;
}

/** An engine connected from somebody's machine. */
export interface BotPresence {
  botId: string;
  userId: string;
  name: string;
  ownerUsername?: string;
  description?: string;
  engineName?: string;
  engineAuthor?: string;
  modes?: ModeID[];
  elo: number;
  modeRatings?: Partial<Record<ModeID, number>>;
  busy: boolean;
  allowPublicPlay: boolean;
  clientVersion?: string;
}

export type ModeCounts = Partial<Record<ModeID, number>>;

/* ------------------------------------------------------------ tournaments -- */

export type TournamentStatus = 'registration' | 'in_progress' | 'completed';

export type TournamentMatchResult = 'pending' | 'player1_win' | 'player2_win' | 'draw';

export interface TournamentPlayer {
  playerId: number;
  userId: string;
  ign: string;
  discord: string;
  agreedToUnfilteredChat: boolean;
  signupOrder: number;
  joinedAtUnixMs: number;
}

export interface TournamentStanding {
  rank: number;
  playerId: number;
  ign: string;
  discord: string;
  played: number;
  wins: number;
  losses: number;
  draws: number;
  points: number;
  signupOrder: number;
}

export interface TournamentMatch {
  matchId: number;
  roundNumber: number;
  matchOrder: number;
  player1: TournamentPlayer;
  player2: TournamentPlayer;
  result: TournamentMatchResult;
  winnerPlayerId?: number;
  gameId?: string;
  updatedAtUnixMs: number;
}

/** Which tournament matches are live, and who has pressed ready. */
export interface TournamentMatchState {
  matchId: number;
  gameId?: string;
  live: boolean;
  readyUserIds?: string[];
}

export interface Tournament {
  tournamentId: string;
  name: string;
  modeId: ModeID;
  modeName: string;
  status: TournamentStatus;
  players: TournamentPlayer[];
  standings: TournamentStanding[];
  matches: TournamentMatch[];
  createdAtUnixMs: number;
  startedAtUnixMs?: number;
  completedAtUnixMs?: number;
  /** Present on the socket snapshot; absent from a bare REST payload. */
  matchStates?: TournamentMatchState[];
}

/* -------------------------------------------------------- client messages -- */

export type ClientMessage =
  | { type: 'authenticate'; userId: string; profileKey: string; sessionToken: string }
  | {
      type: 'join_queue';
      modeId: ModeID;
      timeControl?: TimeControl;
      startingPosition?: StartingPosition;
    }
  | { type: 'leave_queue' }
  | { type: 'rejoin_game'; gameId: string }
  | { type: 'spectate_game'; gameId: string }
  | { type: 'stop_spectating' }
  | { type: 'leave_game' }
  | { type: 'request_moves'; from: Position }
  | { type: 'make_move'; from: Position; to: Position }
  | { type: 'send_chat'; text: string }
  | { type: 'offer_draw' }
  | { type: 'accept_draw' }
  | { type: 'decline_draw' }
  | { type: 'offer_time' }
  | { type: 'accept_time' }
  | { type: 'decline_time' }
  | { type: 'resign_game' }
  | {
      type: 'send_challenge';
      username: string;
      modeId: ModeID;
      timeControl?: TimeControl;
      startingPosition?: StartingPosition;
    }
  | { type: 'cancel_challenge'; challengeId: string }
  | { type: 'accept_challenge'; challengeId: string }
  | { type: 'decline_challenge'; challengeId: string }
  | {
      type: 'challenge_bot';
      botId: string;
      modeId: ModeID;
      timeControl?: TimeControl;
      startingPosition?: StartingPosition;
    }
  | { type: 'bot_session_start'; modeId: ModeID }
  | { type: 'bot_session_end' }
  | { type: 'tournament_ready'; tournamentId: string; matchId: number }
  | { type: 'tournament_withdraw'; tournamentId: string; matchId: number };

export type ClientMessageType = ClientMessage['type'];

/* -------------------------------------------------------- server messages -- */

/** Everything the lobby is told the moment it authenticates. */
export interface ConnectionReadyMessage {
  type: 'connection_ready';
  account?: Account;
  modes?: ModeDefinition[];
  defaultTimeControl?: TimeControl;
  engineBots?: BotPresence[];
  modePlayerCounts?: ModeCounts;
  modeQueueCounts?: ModeCounts;
  botPlayerCount?: number;
  liveGames?: LiveGameSummary[];
  tournaments?: Tournament[];
  challenges?: Challenge[];
}

export type ServerMessage =
  | ConnectionReadyMessage
  | { type: 'authentication_failed'; message?: string }
  | {
      type: 'mode_player_counts';
      modePlayerCounts?: ModeCounts;
      modeQueueCounts?: ModeCounts;
      botPlayerCount?: number;
    }
  | { type: 'live_games'; liveGames?: LiveGameSummary[] }
  | { type: 'tournaments'; tournaments?: Tournament[] }
  | { type: 'engine_bots'; engineBots?: BotPresence[] }
  | { type: 'bot_unavailable'; message?: string }
  | { type: 'bot_fault'; message?: string; botName?: string }
  | { type: 'tournament_rejected'; message?: string }
  | { type: 'queue_update'; modeId?: ModeID; searchRange?: number; queuedForMs?: number }
  | { type: 'queue_left' }
  | { type: 'challenge_received'; challenge?: Challenge }
  | { type: 'challenge_sent'; challenge?: Challenge }
  | { type: 'challenge_removed'; challenge?: Challenge }
  | { type: 'challenge_declined'; challenge?: Challenge; message?: string }
  | { type: 'challenge_cancelled'; challenge?: Challenge; message?: string }
  | { type: 'challenge_unavailable'; challenge?: Challenge; message?: string }
  | { type: 'challenge_rejected'; message?: string }
  | { type: 'match_found'; color?: PlayerColor; gameState?: GameState }
  | {
      type: 'game_rejoined';
      color?: PlayerColor;
      gameState?: GameState;
      reconnectDeadlineUnixMs?: number;
      chatMessages?: ChatMessage[];
    }
  | { type: 'spectator_joined'; gameState?: GameState; chatMessages?: ChatMessage[] }
  | { type: 'spectator_left' }
  | { type: 'spectate_unavailable'; message?: string }
  | { type: 'game_state'; gameState?: GameState; ratingUpdate?: RatingUpdate }
  | { type: 'game_unavailable'; message?: string; gameId?: string }
  | { type: 'valid_moves'; from?: Position; validMoves?: Position[] }
  | { type: 'move_rejected'; message?: string }
  | { type: 'action_rejected'; message?: string }
  | { type: 'chat_message'; chatMessage?: ChatMessage }
  | { type: 'chat_rejected'; message?: string }
  | { type: 'opponent_disconnected'; reconnectDeadlineUnixMs?: number }
  | { type: 'opponent_reconnected' }
  | { type: 'error'; message?: string };

export type ServerMessageType = ServerMessage['type'];

/** Narrow an incoming envelope to one variant of the union. */
export type ServerMessageOf<T extends ServerMessageType> = Extract<ServerMessage, { type: T }>;
