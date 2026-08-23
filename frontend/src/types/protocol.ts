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
  GameSetup,
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

/**
 * A game somebody is waiting to play.
 *
 * One type for all three things the lobby shows, because they differ only in
 * these fields: a private invitation has a `targetUsername`, a posted game has
 * neither that nor `queued`, and somebody in matchmaking has `queued`. What the
 * game *is* lives entirely in `setup`.
 */
export interface Challenge {
  id: string;
  challenger: PlayerProfile;
  /** Absent on an open challenge, which is addressed to nobody. */
  targetUsername?: string;
  modeName: string;
  setup: GameSetup;
  /**
   * The author is searching rather than advertising: they pressed play, or the
   * game they wrote out turned out to be the standard one. Such a row never
   * expires.
   */
  queued?: boolean;
  /**
   * False for a row whose author has closed the tab or wandered off. They are
   * still queued and taking the row still summons them — but the game will not
   * open the instant you click, so the board has to be able to say so.
   *
   * Always sent, never omitted: `false` is the value carrying the information.
   */
  present: boolean;
  createdAtUnixMs: number;
  /** Zero or absent for a row that does not expire. */
  expiresAtUnixMs?: number;
}

/**
 * A game that has been arranged but has not started, because at least one of
 * its two players has to be fetched first.
 *
 * Both halves of who-is-waiting-on-whom are stated rather than one being
 * inferred, because the two screens are entirely different — "take your seat,
 * twenty-three seconds" and "we have called them, twenty-three seconds" — and
 * a client should not have to work out which one it is showing.
 */
export interface PendingMatchView {
  id: string;
  opponent: PlayerProfile;
  opponentElo?: number;
  modeId: ModeID;
  modeName: string;
  setup: GameSetup;
  /** You are the one being waited on. */
  summoned: boolean;
  /** They are. */
  opponentSummoned: boolean;
  deadlineUnixMs: number;
}

/**
 * A search as a reconnecting client needs to be told about it.
 *
 * `queuedForMs` is a duration rather than an instant because the two ends do
 * not share a clock, and a wait that jumps when you reconnect is a wait nobody
 * trusts. The client anchors it to its own clock on receipt.
 */
export interface QueueSnapshot {
  modeId: ModeID;
  setup: GameSetup;
  timeControl: TimeControl;
  searchRange: number;
  queuedForMs: number;
}

/** Where a live game sits inside the bot series it is one game of. */
export interface LiveGameSeries {
  seriesId: string;
  gameNumber: number;
  totalGames: number;
  firstWins: number;
  secondWins: number;
  draws: number;
  /**
   * Which seat the run's first bot holds in this game. The seats swap every
   * game, so it is the only way to read the tally against the two names.
   */
  firstIsRed: boolean;
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
  /** Present only on a game being played as part of a bot series. */
  series?: LiveGameSeries;
}

export type ChatSenderRole = 'player' | 'spectator';

export interface ChatMessage {
  id: string;
  /**
   * The conversation this belongs to, which is what a client matches against.
   * `gameId` below is only the board it was typed at: every game of a bot
   * series shares one room, so the two are not the same thing there.
   *
   * Optional only for a server older than this field, which cannot have a
   * room that is not a game anyway; the store falls back to `gameId` there.
   */
  roomId?: string;
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
  /** The digest of this bot's icon, or absent when it has none. Feed it to `botIconUrl`. */
  iconSha256?: string;
  busy: boolean;
  allowPublicPlay: boolean;
  clientVersion?: string;
}

export type ModeCounts = Partial<Record<ModeID, number>>;

/** True when this challenge is offered to the room rather than to one person. */
export const isOpenChallenge = (challenge: Challenge): boolean =>
  !challenge.targetUsername?.trim();

/* ----------------------------------------------------------- game records -- */

/** One seat of a stored game, with the rating either side of it. */
export interface RecordedPlayer {
  userId: string;
  username: string;
  eloBefore: number;
  eloAfter: number;
}

/**
 * A finished game, as the server files it.
 *
 * The board is not here — that lives in the PGN archive, fetched by game id when
 * somebody opens the review. This is the row: who played, in which mode, who
 * won, how it ended, and what it did to both ratings.
 */
export interface GameRecord {
  gameId: string;
  modeId: ModeID;
  modeName: string;
  redPlayer: RecordedPlayer;
  bluePlayer: RecordedPlayer;
  /** Null on a draw, which is why it is not simply the winning seat's id. */
  winnerUserId: string | null;
  winnerColor: 'Red' | 'Blue' | 'Neutral' | string;
  outcome: 'red_win' | 'blue_win' | 'draw' | string;
  endReason: string;
  ranked: boolean;
  moveNumber: number;
  initialTimeMs: number;
  incrementMs: number;
  startedAtUnixMs: number;
  finishedAtUnixMs: number;
}

/* ------------------------------------------------------------ leaderboard -- */

/**
 * One row of the public ladder.
 *
 * Players and bots are separate boards rather than one mixed board, because a
 * bot's rating comes from a different competition: bot-versus-bot series are
 * ranked and bot-versus-human is not.
 */
export interface LeaderboardEntry {
  /** Position on the whole board, so page two starts at 51 rather than at 1. */
  rank: number;
  userId: string;
  kind: AccountKind | string;
  username: string;
  discord: string;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  gamesPlayed: number;
  /** Set when the row's numbers describe one mode rather than the account. */
  modeId?: ModeID;
  /** A bot's icon digest. Never set on the human board. See `botIconUrl`. */
  iconSha256?: string;
}

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
  // Deliberately no `startingPosition`. Ranked matchmaking pairs on mode and
  // time control; pairing on an arbitrary board would mean waiting for someone
  // who happened to draw the same one. A custom position goes out as a
  // challenge instead.
  | { type: 'join_queue'; modeId: ModeID; timeControl?: TimeControl }
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
      /** Omitted to offer the game to the whole lobby instead of one player. */
      username?: string;
      /** The whole game being offered. Anything left out the server fills in. */
      setup: GameSetup;
    }
  | { type: 'cancel_challenge'; challengeId: string }
  | { type: 'accept_challenge'; challengeId: string }
  | { type: 'decline_challenge'; challengeId: string }
  // No `startingPosition` here either: the server's bot challenge does not
  // take one.
  | { type: 'challenge_bot'; botId: string; modeId: ModeID; timeControl?: TimeControl }
  | { type: 'bot_session_start'; modeId: ModeID }
  | { type: 'bot_session_end' }
  | { type: 'tournament_ready'; tournamentId: string; matchId: number }
  | { type: 'tournament_withdraw'; tournamentId: string; matchId: number }
  /**
   * Whether a person is actually behind this tab: visible, and touched
   * recently. Only the browser can see either half, so the server takes our
   * word for it — and overrules us in the one direction it knows better, by
   * treating a closed socket as away.
   */
  | { type: 'queue_presence'; present: boolean }
  | { type: 'claim_match'; pendingMatchId: string }
  | { type: 'decline_match'; pendingMatchId: string };

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
  /** Everyone connected to the lobby, however they are spending their time. */
  onlineCount?: number;
  liveGames?: LiveGameSummary[];
  tournaments?: Tournament[];
  /** This player's own invitations. */
  challenges?: Challenge[];
  /** The public board of challenges nobody has claimed yet. */
  openChallenges?: Challenge[];
  /** People per mode who are waiting *and* at the keyboard right now. */
  modeReadyCounts?: ModeCounts;
  /**
   * This client's own search, so a reconnecting player is told whether their
   * place was held rather than inferring it from silence. Absent means not
   * queued, which is why the handler must clear the queue when it is missing.
   */
  queue?: QueueSnapshot;
  /** A seat being held for this player right now. */
  pendingMatch?: PendingMatchView;
  /**
   * Whether this server can call anybody back. False turns off the whole offer
   * to wait with the tab closed, rather than leaving a button that quietly
   * cannot work.
   */
  pushEnabled?: boolean;
}

export type ServerMessage =
  | ConnectionReadyMessage
  | { type: 'authentication_failed'; message?: string }
  | {
      type: 'mode_player_counts';
      modePlayerCounts?: ModeCounts;
      modeQueueCounts?: ModeCounts;
      modeReadyCounts?: ModeCounts;
      botPlayerCount?: number;
      onlineCount?: number;
    }
  | { type: 'live_games'; liveGames?: LiveGameSummary[] }
  | { type: 'open_challenges'; openChallenges?: Challenge[] }
  | { type: 'tournaments'; tournaments?: Tournament[] }
  | { type: 'engine_bots'; engineBots?: BotPresence[] }
  | { type: 'bot_unavailable'; message?: string }
  | { type: 'bot_fault'; message?: string; botName?: string }
  | { type: 'tournament_rejected'; message?: string }
  | {
      type: 'queue_update';
      modeId?: ModeID;
      setup?: GameSetup;
      searchRange?: number;
      queuedForMs?: number;
    }
  | { type: 'queue_left'; message?: string }
  | { type: 'match_pending'; pendingMatch?: PendingMatchView }
  | { type: 'match_missed'; message?: string }
  | { type: 'match_unavailable'; message?: string }
  | { type: 'challenge_received'; challenge?: Challenge }
  | { type: 'challenge_sent'; challenge?: Challenge }
  | { type: 'challenge_removed'; challenge?: Challenge }
  | { type: 'challenge_declined'; challenge?: Challenge; message?: string }
  | { type: 'challenge_cancelled'; challenge?: Challenge; message?: string }
  | { type: 'challenge_unavailable'; challenge?: Challenge; message?: string }
  | { type: 'challenge_rejected'; message?: string }
  | {
      type: 'match_found';
      color?: PlayerColor;
      gameState?: GameState;
      chatMessages?: ChatMessage[];
      chatRoomId?: string;
    }
  | {
      type: 'game_rejoined';
      color?: PlayerColor;
      gameState?: GameState;
      reconnectDeadlineUnixMs?: number;
      chatMessages?: ChatMessage[];
      chatRoomId?: string;
    }
  | {
      type: 'spectator_joined';
      gameState?: GameState;
      chatMessages?: ChatMessage[];
      chatRoomId?: string;
    }
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
