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

/**
 * How much of the site one conversation covers.
 *
 * `game` is one board and the room that outlives it, which is nearly every
 * chat here. `series` is every game of a bot-versus-bot run, played one after
 * another. `tournament` is every match of a bots-only event, played at the
 * same time as each other — nobody in that event is a player, so the whole
 * crowd watching it is one room.
 */
export type ChatRoomScope = 'game' | 'series' | 'tournament';

export interface ChatMessage {
  id: string;
  /**
   * The conversation this belongs to, which is what a client matches against.
   * `gameId` below is only the board it was typed at: every game of a bot
   * series shares one room, and so does every match of a bots-only event, so
   * the two are not the same thing there.
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
  /** Whether `elo` is a measurement. Absent from a server older than the field. */
  ratingState?: RatingState;
  /** The share of the measurement that survived the shrinkage, 0 to 1. */
  ratingConfidence?: number;
}

/**
 * How much a published rating is worth reading.
 *
 * Decided on the server — see `RatingState` in
 * backend/internal/persistence/rating_scale.go — because the thresholds belong
 * beside the fit that produces them, and a client that disagreed with the board
 * about whether a number was a guess would be worse than either answer.
 *
 * The floor of this scale, 1, is a real measurement: "plays no better than
 * chance". It used to double as the value shown for anything unmeasured, which
 * is what this exists to undo.
 */
export type RatingState = 'unrated' | 'provisional' | 'rated';

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
export type TitleID =
  | 'GM'
  | 'IM'
  | 'FM'
  | 'CM'
  | 'TC'
  | 'ARC'
  | 'BM'
  | 'STK'
  | 'BSL'
  | 'D'
  | 'VET'
  | 'DEV'
  | 'MOD'
  | 'CON'
  | 'PIO'
  | 'FND'
  | 'WGG'
  | 'PIZ'
  // The engine pool.
  | 'RC'
  | 'CUP'
  | (string & {});

/** Where a title comes from, which is all a screen needs to explain one. */
export type TitleKind = 'rating' | 'achievement' | 'granted';

/**
 * Who a title is for. People and engines collect from catalogues that share
 * nothing, so a screen listing what there is to chase has to say which it is
 * showing.
 *
 * Optional, because a server older than the split does not send it — and
 * everything it serves is a player title, which is what an absent pool should
 * be read as.
 */
export type TitlePool = 'player' | 'bot';

/** One entry of the catalogue: everything there is to know about a title. */
export interface Title {
  id: TitleID;
  name: string;
  kind: TitleKind;
  pool?: TitlePool;
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
  /**
   * The look this player chose, as the JSON object the client sent: theme,
   * board, piece set, sound pack. Absent for an account that has never chosen.
   *
   * A string rather than a parsed object because the server stores it opaquely
   * and must: the catalogue of presets lives here, in the client, and a server
   * that validated ids against its own copy would reject every look added by a
   * build newer than itself. Read it through `appearanceFromAccount`.
   */
  appearance?: string;
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
  /**
   * The account this engine is registered to.
   *
   * Here for one question: whether two engines belong to the same person. A
   * series between two of one owner's bots is casual and does not move the
   * ladder, and the form that starts one says so before it is pressed.
   *
   * Absent rather than empty when the server does not know, so compare it only
   * after checking it is set — two engines with no owner on record are not a
   * pair.
   */
  ownerUserId?: string;
  description?: string;
  engineName?: string;
  engineAuthor?: string;
  /**
   * Which build of itself the engine declared on connect, absent for one that
   * declares none — which is most engines. Not the rpsbot.py version: that is
   * the script this site publishes, this is the program its owner wrote.
   */
  engineVersion?: string;
  modes?: ModeID[];
  elo: number;
  modeRatings?: Partial<Record<ModeID, number>>;
  /** Which of those numbers are measurements. A mode missing from it is unrated. */
  modeRatingStates?: Partial<Record<ModeID, RatingState>>;
  /**
   * The tag this engine wears, absent for most of them. Nobody chose it: an
   * engine has no account page, so the server picks the best of what it
   * currently deserves. See the bot pool in `TitleID`.
   */
  title?: TitleID;
  /** The digest of this bot's icon, or absent when it has none. Feed it to `botIconUrl`. */
  iconSha256?: string;
  /**
   * No room for another game: every slot this engine has is taken.
   *
   * Not the same as "playing", which is why `activeGames` is beside it. A bot
   * whose owner allowed it three games at once is playing and free at the same
   * time, and the button and the badge need different halves of that.
   */
  busy: boolean;
  /** Games it is in right now, across all of its slots. */
  activeGames?: number;
  /** Games it will take at once — 1 for almost every bot, at most 5. */
  slots?: number;
  allowPublicPlay: boolean;
  enterLadder: boolean;
  /**
   * The tournament holding this engine, absent for the great majority of them.
   *
   * An engine entered in a running event is kept for its own scheduled matches
   * and is not available for a challenge or a series, even while idle — see
   * backend/internal/server/bot_reserve.go. Published rather than only
   * enforced so the lobby can say "in reserve" instead of describing a
   * perfectly healthy engine as busy.
   */
  reservedFor?: string;
  clientVersion?: string;
  /**
   * An engine on its way out: playing what it already owes and taking nothing
   * new. Published rather than merely enforced, so the lobby can say so instead
   * of offering a button that refuses.
   */
  draining?: boolean;
  /**
   * The same unavailability for a completely different reason: a scheduled
   * window in which no engine takes a game — see `BotBench`.
   *
   * A separate field from `draining` because the two need different words. An
   * engine that is draining is going away, and its owner asked for that; a
   * benched one is coming back this evening and nobody touched it. Every offer
   * path treats them alike; only the lobby tells them apart.
   */
  benched?: boolean;
}

/**
 * A scheduled stretch of time in which every engine is off the board.
 *
 * Not a shutdown and not a fault: the bots stay connected and idle, take no new
 * games, and are back in the pool when it ends. The occasion is an event
 * elsewhere that a practice ladder would spoil — see the official tournament.
 *
 * Sent whether or not one is running. When none is, it describes the *next*
 * one, which is what lets a page warn people that the ladder closes at half
 * past rather than only explain it once it has. So `active` is the field to
 * branch on; the times mean something either way, and are both absent when
 * nothing at all is scheduled.
 */
export interface BotBench {
  active: boolean;
  /** Why, in words that finish "the engines are off because of…". */
  reason?: string;
  fromUnixMs?: number;
  untilUnixMs?: number;
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

/**
 * A graceful restart in progress: the server is playing out the games already on
 * the board, refusing new ones, and will stop as soon as the last one ends.
 *
 * The same idea as {@link BotDrain} one scale up, and told to everybody rather
 * than to one owner — which is the point. Without it, a deploy looks from the
 * outside like the site quietly refusing to start games, and then dropping every
 * socket at once.
 */
export interface ServerUpdate {
  /**
   * False is the ordinary state of the world, and is sent as readily as true:
   * a client that receives `updating: false` takes the banner down rather than
   * waiting to be told separately.
   */
  updating: boolean;
  /** The sentence the administrator wrote, shown as-is. */
  note?: string;
  /** Every game still being played, already phrased for a person. */
  waitingOn: string[];
  /** `waitingOn.length`, so a count can be shown without holding the list. */
  gamesRemaining: number;
  /**
   * The list emptied and the process is on its way out. Distinct from an empty
   * `waitingOn`, which is also true for the instant between the last game
   * ending and the server noticing.
   */
  settled: boolean;
  startedAtUnixMs?: number;
  /** When the server stops waiting and restarts regardless. */
  deadlineUnixMs?: number;
}

/**
 * Something an administrator wants everybody to read.
 *
 * Held on the server with a lifetime rather than only broadcast, so the person
 * who reloads ten seconds after it went out — the person a "sorry, restarting
 * now" was written for — is still told. A notice with no `text` means take the
 * banner down.
 */
export interface ServerNotice {
  /**
   * Changes with every posting, so a banner somebody dismissed does not come
   * back on the next reconnection.
   */
  id: string;
  text: string;
  /** 'notice' reads as information; 'warning' as something to act on. */
  tone?: 'notice' | 'warning';
  postedAtUnixMs: number;
  expiresAtUnixMs: number;
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
  /**
   * Whether `elo` is worth reading. An `unrated` row has no meaningful number —
   * it is the absence of a rating, not a low one — and the board is ordered with
   * those rows last.
   *
   * Absent from a server older than the field, which readers should treat as
   * `rated`: an old server has no way to say otherwise, and hiding every number
   * on it would be worse than the ambiguity this replaces.
   */
  ratingState?: RatingState;
  ratingConfidence?: number;
  wins: number;
  losses: number;
  draws: number;
  gamesPlayed: number;
  /** Set when the row's numbers describe one mode rather than the account. */
  modeId?: ModeID;
  /** A bot's icon digest. Never set on the human board. See `botIconUrl`. */
  iconSha256?: string;
  /**
   * Who entered this engine, and what the engine calls itself. Bot rows only —
   * a person has neither — and absent from a server older than the fields, so
   * every reader has to cope with them missing.
   */
  ownerUsername?: string;
  engineName?: string;
  /**
   * When this engine took the top of this row's mode. Set only on the row that
   * is currently holding it, so a row carrying it is the row in front.
   *
   * A timestamp rather than a count of days, because only this side knows what
   * today is where the reader is sitting.
   *
   * Absent from a server older than the field.
   */
  leadingSinceUnixMs?: number;
  /**
   * Whether this engine has held the top of its mode at some point, which is
   * true of the current leader too.
   *
   * Reigns are only recorded from the day the ledger shipped, so `false` means
   * "not since then" rather than "never" — which is why nothing reading it
   * should phrase the absence as a claim about an engine's whole history.
   *
   * Absent from a server older than the field.
   */
  heldTopSeat?: boolean;
}

/* ------------------------------------------------------------ tournaments -- */

/**
 * Where an event is in its life.
 *
 * `draft` and `cancelled` are derived on the server rather than stored — see
 * the note at the top of backend/internal/persistence/tournament_admin.go —
 * but from a client's side they are simply two more statuses.
 *
 * A draft only ever reaches an administrator: the public list and the socket
 * broadcast both filter them out, so a client that is not the host will never
 * see this value.
 */
export type TournamentStatus =
  | 'draft'
  | 'registration'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

/** How a tournament decides who plays whom. */
export type TournamentFormat =
  | 'round_robin'
  | 'double_round_robin'
  | 'single_elimination'
  | 'swiss';

/** Who may enter. `bots` is what makes an event a bot tournament. */
export type TournamentField = 'open' | 'humans' | 'bots';

/** The order the pairing engine reads the field in. */
export type TournamentSeeding = 'signup' | 'rating';

/** A round somebody sat out, which is not a match and has no board. */
export interface TournamentBye {
  roundNumber: number;
  playerId: number;
  player: TournamentPlayer;
  /** Why they sat out, in the words the bracket shows. */
  reason?: string;
}

export type TournamentMatchResult = 'pending' | 'player1_win' | 'player2_win' | 'draw';

export interface TournamentPlayer {
  playerId: number;
  userId: string;
  ign: string;
  discord: string;
  agreedToUnfilteredChat: boolean;
  signupOrder: number;
  /** Their seeding position, set when the event starts and absent before. */
  seed?: number;
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
  /**
   * Rounds sat out. Each is scored as a win, so this is what explains a win
   * count larger than the games played.
   */
  byes?: number;
  points: number;
  /**
   * The round a knockout entrant went out in, absent for somebody still in it.
   * Only ever set in an elimination bracket, where the ranking is built on it
   * rather than on points.
   */
  eliminatedInRound?: number;
  seed?: number;
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
  /**
   * How far through a multi-game pairing this match is, and the running score.
   *
   * All absent on a one-game match until it is played, at which point `result`
   * says the same thing more simply — so a single-game event can ignore them.
   */
  gamesPlayed?: number;
  player1Points?: number;
  player2Points?: number;
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
  description?: string;
  modeId: ModeID;
  modeName: string;
  status: TournamentStatus;
  format: TournamentFormat;
  field: TournamentField;
  seeding: TournamentSeeding;
  /** The cap on the field; zero is uncapped. */
  maxPlayers: number;
  /** What the host asked for. `rounds` below is the answer to use. */
  swissRounds?: number;
  /**
   * How many games one pairing plays. One unless the host said otherwise.
   *
   * More than one is about fairness rather than length: the colours swap every
   * game, so an even number cancels the advantage of opening — which decides
   * close pairings between engines.
   */
  gamesPerMatch: number;
  /**
   * Which series this belongs to. `nightly` is one the recurring schedule made —
   * and is kept off the tournaments board and out of the Tournament Champion
   * the stored spelling of what is now the weekend arena, kept because the
   * archive is full of it. It has its own page and its own crown. See
   * `isWeekendArena`.
   */
  kind?: 'manual' | 'nightly';
  /** The weekend arena's serial, and absent on a one-off. */
  nightlyNumber?: number;
  /**
   * How many rounds the event will play in total, which an elimination bracket
   * or a Swiss needs published because its later rounds do not exist yet.
   */
  rounds: number;
  initialTimeMs?: number;
  incrementMs?: number;
  /** When the host intends to begin. Advisory: nothing starts on it. */
  startsAtUnixMs?: number;
  players: TournamentPlayer[];
  standings: TournamentStanding[];
  matches: TournamentMatch[];
  byes?: TournamentBye[];
  createdAtUnixMs: number;
  publishedAtUnixMs?: number;
  startedAtUnixMs?: number;
  completedAtUnixMs?: number;
  cancelledAtUnixMs?: number;
  /**
   * When it was taken off the public board, absent for an event that is on it.
   *
   * Hiding is a listing decision only: a hidden event is still readable at its
   * own address, still on its entrants' profile pages, and still counted in the
   * totals. Only an administrator ever sees this set, because the public list
   * and the socket broadcast both omit hidden events entirely.
   */
  hiddenAtUnixMs?: number;
  /** Present on the socket snapshot; absent from a bare REST payload. */
  matchStates?: TournamentMatchState[];
}

/* --------------------------------------------------------- moderation -- */

/** What a sanction stops. See backend/internal/persistence/moderation.go. */
export type RestrictionKind = 'mute' | 'ranked' | 'tournament';

/**
 * A sanction, as the person under it is told about it.
 *
 * Deliberately not the whole record: who issued it is an internal note. What
 * is here is what a screen needs to explain a refusal before the player runs
 * into one — a disabled chat box that says why beats one that silently
 * swallows a message.
 */
export interface Restriction {
  kind: RestrictionKind;
  reason?: string;
  /** When it lapses, absent for one that stands until it is lifted. */
  expiresAtUnixMs?: number;
}

/**
 * One entry of a player's own block list.
 *
 * Not a sanction and not related to one. A `Restriction` is the host acting on
 * an account and applies to everybody; this is one person's own preference,
 * invisible to the rest of the site and reversible by them alone. See
 * backend/internal/persistence/blocks.go.
 */
export interface BlockedAccount {
  userId: string;
  username: string;
  title?: TitleID;
  kind: AccountKind;
  blockedAtUnixMs: number;
}

/** Why somebody is being reported. Published by the server so this list and the
 * server's cannot drift — see `/api/reports/categories`. */
export type ReportCategoryID =
  | 'harassment'
  | 'hate'
  | 'sexual'
  | 'spam'
  | 'cheating'
  | 'name'
  | 'other';

export interface ReportCategory {
  id: ReportCategoryID;
  label: string;
}

/** What the report form needs to draw itself, straight from the server. */
export interface ReportPolicy {
  categories: ReportCategory[];
  maxDetails: number;
  /** Who to contact when the report queue is not the right place. */
  contactName: string;
}

/** Where a filed report has got to. Only the admin queue sees this. */
export type ReportStatus = 'open' | 'actioned' | 'dismissed';

/** One filed report, as the admin queue shows it. */
export interface Report {
  reportId: string;
  reporterUserId: string;
  reporterName: string;
  targetUserId?: string;
  targetName: string;
  category: ReportCategoryID;
  details?: string;
  gameId?: string;
  /** The chat lines the reporter attached, copied at the time they filed. */
  context?: string;
  status: ReportStatus;
  createdAtUnixMs: number;
  resolvedAtUnixMs?: number;
  resolvedByUserId?: string;
  resolutionNote?: string;
  /** Whether the reported account is already disabled, so the queue does not
   * offer to act on somebody who has already been dealt with. */
  targetIsDisabled?: boolean;
  /** How many other open reports name the same account. A third report about
   * one person is a different decision from a first. */
  targetOpenReports?: number;
}

export interface ReportPage {
  reports: Report[];
  total: number;
  /** Unread across every filter, for the badge on the tab. */
  open: number;
}

/* --------------------------------------------------------- feedback board -- */

/** Which of the two things a board item is. */
export type FeedbackKind = 'bug' | 'suggestion';

/**
 * The host's answer, and the only field on an item a player cannot write.
 *
 * Five states shared by both kinds. What differs is the *wording*: `accepted`
 * reads "Known issue" on a bug and "Planned" on a suggestion, which is why an
 * item carries its own `statusLabel` from the server rather than the client
 * keeping a table of its own. See backend/internal/persistence/feedback.go.
 */
export type FeedbackStatus = 'open' | 'accepted' | 'done' | 'declined' | 'duplicate';

/** How the board is ordered. */
export type FeedbackSort = 'top' | 'new';

/** One post on the board. */
export interface FeedbackItem {
  itemId: string;
  kind: FeedbackKind;
  title: string;
  body?: string;
  /** Empty for a post whose author has deleted their account. */
  authorUserId?: string;
  authorName: string;
  /** Posted by the host, as of when it was written rather than as of now. */
  fromHost?: boolean;
  status: FeedbackStatus;
  /** The status in this item's own words. Resolved by the server — see above. */
  statusLabel: string;
  /** The host's sentence beside the status. */
  statusNote?: string;
  /** Somewhere else to look: an issue, a thread, a video of the bug. */
  linkUrl?: string;
  /** The game it happened in, when the report came from a board. */
  gameId?: string;
  appVersion?: string;
  platform?: string;
  /** The item this one was folded into, set with the `duplicate` status. */
  duplicateOf?: string;
  pinned?: boolean;
  /** Off the public board. Only ever true on the host's copy. */
  hidden?: boolean;
  votes: number;
  /** Whether the account asking is in the tally. */
  youVoted?: boolean;
  comments: number;
  /** The replies. Present only on a single item, never on the list. */
  thread?: FeedbackComment[];
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
}

export interface FeedbackComment {
  commentId: string;
  itemId: string;
  authorUserId?: string;
  authorName: string;
  fromHost?: boolean;
  body: string;
  hidden?: boolean;
  createdAtUnixMs: number;
}

export interface FeedbackPage {
  items: FeedbackItem[];
  /** How many match the filter, for paging. */
  total: number;
  /** Live items of each kind, which do not move with the filter. */
  openBugs: number;
  openSuggestions: number;
}

/** What the compose form needs to draw itself, straight from the server. */
export interface FeedbackPolicy {
  kinds: { id: FeedbackKind; label: string }[];
  /** One label per kind, for the host's status picker and the filter chips. */
  statuses: {
    id: FeedbackStatus;
    bugLabel: string;
    suggestionLabel: string;
    settled?: boolean;
  }[];
  maxTitle: number;
  maxBody: number;
  maxComment: number;
  /**
   * Whether this visitor may post, and what to say when not.
   *
   * From the server because the client cannot work it out: signed out,
   * unverified and muted are three different sentences, and only one side
   * knows which applies.
   */
  mayPost: boolean;
  postRefusal: string;
  /** Who to contact when the board is not the right place. */
  contactName: string;
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
  /** The scheduled bot bench, running or coming. See `BotBench`. */
  botBench?: BotBench;
  modePlayerCounts?: ModeCounts;
  modeQueueCounts?: ModeCounts;
  botPlayerCount?: number;
  /** Everyone connected to the lobby, however they are spending their time. */
  onlineCount?: number;
  liveGames?: LiveGameSummary[];
  tournaments?: Tournament[];
  /**
   * What this account may not do, absent when nothing is in force — which is
   * the case for almost everybody. See `Restriction`.
   */
  restrictions?: Restriction[];
  /**
   * Who this connection is hiding, as account ids.
   *
   * Sent with the handshake so the client has it before the first message
   * arrives rather than after it has already painted one. Ids rather than
   * names, because a name goes stale the moment somebody renames themselves
   * and a chat line carries the id. See `blocked_players` for the update.
   */
  blockedUserIds?: string[];
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
  /**
   * Whether this server is on its way out for a new build. Always present, and
   * `updating: false` most of the time — a client that reloads mid-deploy has to
   * be told, and one that reloads afterwards has to be told that too.
   */
  update?: ServerUpdate;
  /** The standing announcement, if one is up. Absent means there is none. */
  notice?: ServerNotice;
}

/**
 * The game so far, written as PGN, on every message that hands over a live
 * board.
 *
 * `gameState` is a position and nothing else — the wire has never carried the
 * moves that made it — so this is the only history a client gets. It matters
 * most to the two people who saw none of the game: somebody who started
 * watching at move twenty, and a player who refreshed. Replayed through
 * `reviewSourceFromPGN`, the same path a finished game's review takes, so a
 * live move list and that game's review cannot disagree.
 *
 * `Result` is `*` while the game is still going. Absent on a message about a
 * game the server no longer holds the record for, which is why every reader of
 * it keeps what it already had rather than clearing on a missing field.
 */
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
  /**
   * This account's sanctions changed. Only ever about the receiver, and sent
   * the moment a moderator acts rather than left to be discovered by trying
   * something and being refused.
   */
  | { type: 'restrictions'; restrictions?: Restriction[] }
  // The block list changed — from this tab or from another one. Whole list
  // rather than a delta, for the same reason `restrictions` is: two tabs
  // applying deltas out of order disagree, and the list is a dozen ids.
  | { type: 'blocked_players'; blockedUserIds?: string[] }
  /**
   * A moderator did something to the game this client is in. Carried on its
   * own type rather than as an error, because it is not this client's mistake.
   */
  | { type: 'moderator_notice'; message?: string }
  | { type: 'live_games'; liveGames?: LiveGameSummary[] }
  | { type: 'open_challenges'; openChallenges?: Challenge[] }
  | { type: 'tournaments'; tournaments?: Tournament[] }
  | { type: 'engine_bots'; engineBots?: BotPresence[]; botBench?: BotBench }
  | { type: 'bot_unavailable'; message?: string }
  | { type: 'bot_fault'; message?: string; botName?: string }
  | {
      type: 'bot_drain_update';
      botId?: string;
      botName?: string;
      drain?: BotDrain;
    }
  /**
   * The server is being replaced. Sent when a drain starts, when it is called
   * off, and again when the last game ends — that last one being the moment the
   * banner should say "restarting now" rather than "an update is coming".
   */
  | { type: 'server_update'; update?: ServerUpdate }
  /** An administrator said something to everybody. Empty text takes it down. */
  | { type: 'server_notice'; notice?: ServerNotice }
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
      pgn?: string;
      chatMessages?: ChatMessage[];
      chatRoomId?: string;
      chatRoomScope?: ChatRoomScope;
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
      pgn?: string;
      reconnectDeadlineUnixMs?: number;
      chatMessages?: ChatMessage[];
      chatRoomId?: string;
      chatRoomScope?: ChatRoomScope;
      chatOccupancy?: number;
      firstMoveDeadlineUnixMs?: number;
    }
  | {
      type: 'spectator_joined';
      gameState?: GameState;
      pgn?: string;
      chatMessages?: ChatMessage[];
      chatRoomId?: string;
      chatRoomScope?: ChatRoomScope;
      chatOccupancy?: number;
    }
  | { type: 'spectator_left' }
  | { type: 'spectate_unavailable'; message?: string }
  | { type: 'game_state'; gameState?: GameState; pgn?: string; ratingUpdate?: RatingUpdate }
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
  | {
      type: 'chat_presence';
      chatRoomId?: string;
      chatRoomScope?: ChatRoomScope;
      chatOccupancy?: number;
    }
  | { type: 'chat_rejected'; message?: string }
  | { type: 'opponent_disconnected'; reconnectDeadlineUnixMs?: number }
  | { type: 'opponent_reconnected' }
  | { type: 'error'; message?: string };

export type ServerMessageType = ServerMessage['type'];

/** Narrow an incoming envelope to one variant of the union. */
export type ServerMessageOf<T extends ServerMessageType> = Extract<ServerMessage, { type: T }>;
