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
  SideColor,
  StartingPosition,
  TimeControl,
} from './game';

/* ---------------------------------------------------------------- shared -- */

/**
 * Which kinds of device this server can actually reach.
 *
 * Sent both on the socket at connect and from `GET /api/push/key`, because a
 * client needs it before it decides whether to offer anything: a browser reads
 * `webPush` and a phone reads `apns`.
 */
export interface PushTransportSupport {
  webPush: boolean;
  apns: boolean;
}

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

/** The compact current board published with a live lobby row. */
export interface LiveGamePosition {
  /** Nine rows of RPSrps. piece symbols, from Blue's side to Red's. */
  rows: string[];
  /** Nine rows of r/b/. territory owners in the same order. */
  owners: string[];
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
  /** Compact current position used by the lobby's live board. */
  position?: LiveGamePosition;
  /** Absent on a live row sent by a server from before board previews. */
  currentTurn?: PlayerColor;
  /** Completed half-moves. The board labels the next one as moveNumber + 1. */
  moveNumber?: number;
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
  /**
   * The tag the sender was wearing, recorded on the message rather than looked
   * up when it is drawn — so a transcript still reads the way the room read at
   * the time.
   */
  senderTitle?: TitleID;
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

/* ---------------------------------------------------------------- titles -- */

/**
 * A title's id *and* the letters it displays as: `GM`, `BSL`, `DEV`.
 *
 * One string rather than a slug plus an abbreviation, matching the Go end. Open
 * rather than a closed union because the catalogue lives on the server and a
 * client compiled today must not break when a title is added tomorrow — the
 * literals are the ones that exist now, spelled out so fixtures can be checked.
 */
export type TitleID = 'GM' | 'IM' | 'FM' | 'CM' | (string & {});

/** Where a title comes from, which is all a screen needs to explain one. */
export type TitleKind = 'rating' | 'achievement' | 'granted';

/** One entry of the catalogue: everything there is to know about a title. */
export interface Title {
  id: TitleID;
  name: string;
  kind: TitleKind;
  /** How it is earned, in the words shown to the player. */
  requirement: string;
}

/** A title an account holds, flattened with its catalogue entry. */
export interface TitleAward extends Title {
  /** `earned` by the rules, or `granted` by the host. */
  source: 'earned' | 'granted';
  awardedAtUnixMs: number;
}

export interface Account {
  userId: string;
  kind: AccountKind | string;
  username: string;
  registered: boolean;
  isAdmin: boolean;
  disabled: boolean;
  discord: string;
  /**
   * Whether Discord vouched for the handle above, rather than the player having
   * typed it. Optional so an older server, which does not send it, reads as a
   * self-declared handle — which is exactly what it would be.
   */
  discordVerified?: boolean;
  /** The title worn in front of the name, absent when none is. */
  title?: TitleID;
  /**
   * Everything this account has collected, best first. Absent rather than empty
   * for the great majority of accounts, which hold none.
   */
  titles?: TitleAward[];
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
  /**
   * An engine on its way out: playing what it already owes and taking nothing
   * new. Published rather than merely enforced, so the lobby can say so instead
   * of offering a button that refuses.
   */
  draining?: boolean;
}

/**
 * A graceful shutdown in progress: the bot is playing out what it already owes
 * and taking nothing new.
 *
 * Connection state, not a stored setting — it lasts exactly as long as the
 * bot's socket does, so restarting the client is all it takes to put the bot
 * back in play. That is also why a bot nobody is running has none.
 */
export interface BotDrain {
  draining: boolean;
  /** True stops the client at the end; false leaves it connected and idle. */
  exitWhenDone: boolean;
  /** What asked — "the website", "the engine", "the client". */
  source?: string;
  /**
   * Everything it still owes, already phrased for a person. Empty means the
   * drain has settled, which is the difference between "shutting down" and
   * "nothing left — safe to stop".
   */
  waitingOn: string[];
  requestedAtUnixMs?: number;
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
  /** The title worn in front of the name, absent on most rows. */
  title?: TitleID;
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
  // take one. `preferredColor` is a plain field rather than a `setup`, because
  // this message names its mode and its clock the same one-at-a-time way.
  // Omitted, the challenger is seated Red.
  | {
      type: 'challenge_bot';
      botId: string;
      modeId: ModeID;
      preferredColor?: SideColor;
      timeControl?: TimeControl;
    }
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
  /**
   * Call off a game nobody has moved in yet. Refused once it has begun, when
   * the only way out is a resignation and the rating that comes with it.
   */
  | { type: 'abort_game' };

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
  /**
   * A live game this account is already seated in.
   *
   * The board may have opened while the browser was closed, in which case it
   * has never heard of the game and cannot ask to rejoin one by id. Being told
   * the id here is what makes a notification worth opening.
   */
  gameId?: string;
  /**
   * Whether this server can call anybody back at all. False turns off the whole
   * offer to wait with the tab closed, rather than leaving a button that quietly
   * cannot work.
   */
  pushEnabled?: boolean;
  /**
   * By which means, so a client can answer the same question about the device it
   * is actually running on. A server holding VAPID keys and no Apple key can
   * call a laptop back and not a phone, and the phone has to be told that
   * rather than shown the laptop's answer. Absent from a server that predates
   * iOS.
   */
  pushTransports?: PushTransportSupport;
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
  /**
   * This account's own row, resent because something on it changed without the
   * client asking — a title earned by the game that just finished, or one the
   * host granted. Only ever about the receiver.
   */
  | { type: 'account_updated'; account?: Account }
  | { type: 'live_games'; liveGames?: LiveGameSummary[] }
  | { type: 'open_challenges'; openChallenges?: Challenge[] }
  | { type: 'tournaments'; tournaments?: Tournament[] }
  | { type: 'engine_bots'; engineBots?: BotPresence[] }
  | { type: 'bot_unavailable'; message?: string }
  | { type: 'bot_fault'; message?: string; botName?: string }
  | {
      type: 'bot_drain_update';
      botId?: string;
      botName?: string;
      drain?: BotDrain;
    }
  | { type: 'tournament_rejected'; message?: string }
  | {
      type: 'queue_update';
      modeId?: ModeID;
      setup?: GameSetup;
      searchRange?: number;
      queuedForMs?: number;
    }
  | { type: 'queue_left'; message?: string }
  /** A game that was opened, never played, and is now gone. Nothing was rated. */
  | { type: 'game_cancelled'; gameId?: string; message?: string }
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
      chatOccupancy?: number;
      /**
       * When a board nobody has moved on gives up waiting. Zero or absent for a
       * game that is already being played, which is how a client tells the two
       * apart: a board with a deadline on it is one where nothing is ticking
       * and nothing is rated yet.
       */
      firstMoveDeadlineUnixMs?: number;
    }
  | {
      type: 'game_rejoined';
      color?: PlayerColor;
      gameState?: GameState;
      reconnectDeadlineUnixMs?: number;
      chatMessages?: ChatMessage[];
      chatRoomId?: string;
      chatOccupancy?: number;
      firstMoveDeadlineUnixMs?: number;
    }
  | {
      type: 'spectator_joined';
      gameState?: GameState;
      chatMessages?: ChatMessage[];
      chatRoomId?: string;
      chatOccupancy?: number;
    }
  | { type: 'spectator_left' }
  | { type: 'spectate_unavailable'; message?: string }
  | { type: 'game_state'; gameState?: GameState; ratingUpdate?: RatingUpdate }
  | { type: 'game_unavailable'; message?: string; gameId?: string }
  | { type: 'valid_moves'; from?: Position; validMoves?: Position[] }
  | { type: 'move_rejected'; message?: string }
  | { type: 'action_rejected'; message?: string }
  | { type: 'chat_message'; chatMessage?: ChatMessage }
  /**
   * How many people are in a conversation, sent whenever somebody joins or
   * leaves it. Counted from the room rather than from the game's spectator
   * list, which is how the figure survives the result: a finished game leaves
   * the live table, and its room does not.
   */
  | { type: 'chat_presence'; chatRoomId?: string; chatOccupancy?: number }
  | { type: 'chat_rejected'; message?: string }
  | { type: 'opponent_disconnected'; reconnectDeadlineUnixMs?: number }
  | { type: 'opponent_reconnected' }
  | { type: 'error'; message?: string };

export type ServerMessageType = ServerMessage['type'];

/** Narrow an incoming envelope to one variant of the union. */
export type ServerMessageOf<T extends ServerMessageType> = Extract<ServerMessage, { type: T }>;
