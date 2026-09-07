package server

import (
	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// ClientMessage describes every command accepted over the WebSocket transport.
type ClientMessage struct {
	Type             string                 `json:"type"`
	UserID           string                 `json:"userId,omitempty"`
	ProfileKey       string                 `json:"profileKey,omitempty"`
	SessionToken     string                 `json:"sessionToken,omitempty"`
	GameID           string                 `json:"gameId,omitempty"`
	ChallengeID      string                 `json:"challengeId,omitempty"`
	TournamentID     string                 `json:"tournamentId,omitempty"`
	MatchID          int64                  `json:"matchId,omitempty"`
	Username         string                 `json:"username,omitempty"`
	Text             string                 `json:"text,omitempty"`
	ModeID           game.ModeID            `json:"modeId,omitempty"`
	TimeControl      *game.TimeControl      `json:"timeControl,omitempty"`
	StartingPosition *game.StartingPosition `json:"startingPosition,omitempty"`
	// Setup is how a client asks for a particular game: the mode, the clock,
	// the board, the rule flags, the seat. Everything it leaves out is filled
	// in from the mode, so the zero setup asks for a normal rated match and
	// `join_queue` needs to send nothing but a mode.
	//
	// The three fields above are the older, one-thing-at-a-time spelling of the
	// same request. They are still read when Setup is absent, because a
	// connected engine bot speaks them.
	Setup *game.GameSetup `json:"setup,omitempty"`
	From  game.Position   `json:"from,omitempty"`
	To    game.Position   `json:"to,omitempty"`
	// PreferredColor is the seat `challenge_bot` asks for, in the same
	// one-thing-at-a-time spelling that message already uses for its mode and
	// its clock. Empty means no preference, and an engine challenge with no
	// preference seats its challenger Red — the courtesy every other challenge
	// here carries. Seeks send the same wish inside Setup instead, because
	// pairing has to compare two of them.
	PreferredColor game.PlayerColor `json:"preferredColor,omitempty"`

	// Engine-bot fields. `authenticate_bot` carries a bot's whole
	// registration: the durable token that identifies it, plus the name and
	// settings its config file asserts on every connect.
	Token            string `json:"token,omitempty"`
	ClientVersion    string `json:"clientVersion,omitempty"`
	Name             string `json:"name,omitempty"`
	Description      string `json:"description,omitempty"`
	PublicPlay       bool   `json:"publicPlay,omitempty"`
	EnterTournaments bool   `json:"enterTournaments,omitempty"`
	BotID            string `json:"botId,omitempty"`
	// MaxGames is how many games at once the machine running this engine says
	// it can afford, and SessionID and Slot are how its connections recognise
	// each other. One process opens one socket per slot, each with its own
	// engine subprocess, because a socket that plays one game at a time is the
	// whole reason the client and the exchange bookkeeping are as small as they
	// are — see registerBot.
	//
	// Absent on every client before 1.4, which means one slot, no session, and
	// the displacing behaviour those clients have always had.
	MaxGames  int    `json:"maxGames,omitempty"`
	SessionID string `json:"sessionId,omitempty"`
	Slot      int    `json:"slot,omitempty"`
	// Icon is a base64 PNG, and a pointer because all three states mean
	// something different. Absent is a client that predates icons: it must
	// leave the stored one alone, or upgrading the server would erase the
	// picture of every bot still running an older script. Empty is a current
	// client saying its config file names no icon, which takes one down. Set is
	// the picture to show.
	Icon *string `json:"icon,omitempty"`
	// Seq matches a reply to the question it answers, so a late answer can be
	// discarded rather than applied to the position that followed it.
	Seq    int64    `json:"seq,omitempty"`
	Lines  []string `json:"lines,omitempty"`
	Reason string   `json:"reason,omitempty"`
	// Exit distinguishes the two things `bot_drain` can ask for: true stops the
	// client once the last commitment is settled, false leaves it connected and
	// idle. Absent means false, which is the safe default for a message a
	// third-party client might send by accident — a pause is recoverable and a
	// shutdown is not.
	Exit bool `json:"exit,omitempty"`

	// Present is the client's own answer to "is a person holding this tab":
	// visible, and touched recently. Only the browser can see either half, so
	// the server takes its word — and overrules it in the one direction it
	// knows better, by treating a closed socket as away.
	Present bool `json:"present,omitempty"`
}

// QueueSnapshot is a search as a reconnecting client needs to be told about it.
//
// It travels in connection_ready so that a client is *told* whether it is still
// queued rather than inferring it from silence. QueuedForMs is a duration
// rather than an instant because the two ends do not share a clock, and a wait
// that jumps when you reconnect is a wait nobody trusts.
type QueueSnapshot struct {
	ModeID      game.ModeID      `json:"modeId"`
	Setup       game.GameSetup   `json:"setup"`
	TimeControl game.TimeControl `json:"timeControl"`
	SearchRange int              `json:"searchRange"`
	QueuedForMs int64            `json:"queuedForMs"`
}

// requestedSetup is the game this message asks for.
//
// Setup is the whole request when a client sends one. The three older fields are
// read otherwise, so a client that knows only how to name a mode and a clock
// still asks for a coherent game: whatever it leaves out is filled in from the
// mode, and leaving out everything asks for a normal rated match.
func (message ClientMessage) requestedSetup() game.GameSetup {
	if message.Setup != nil {
		setup := *message.Setup
		if setup.ModeID == "" {
			setup.ModeID = message.ModeID
		}
		return setup
	}
	setup := game.GameSetup{ModeID: message.ModeID}
	if message.TimeControl != nil {
		setup.TimeControl = *message.TimeControl
	}
	if message.StartingPosition != nil {
		setup.StartingPosition = *message.StartingPosition
	}
	return setup
}

// Challenge is the wire form of a Seek: a game somebody is waiting to play.
//
// TargetUsername is what makes it private. Addressed to a display name, only
// that person sees it and only that person can accept it. Left empty, the same
// object is an *open* challenge: it goes out to the whole lobby and the first
// person to take it gets the game.
//
// Setup is the whole of what the game will be, which is why there is nothing
// beside it: a challenge is a normal game with edits, and a row with a standard
// setup and Queued set is somebody in matchmaking. One type covers all three
// because they differ only in these fields.
type Challenge struct {
	ID         string             `json:"id"`
	Challenger game.PlayerProfile `json:"challenger"`
	// Empty means open to anybody.
	TargetUsername string `json:"targetUsername,omitempty"`
	// ModeName saves every client a lookup for the one string it always shows.
	ModeName string         `json:"modeName"`
	Setup    game.GameSetup `json:"setup"`
	// Queued marks a row whose author is actively searching rather than
	// advertising: they pressed play, or they wrote out a game that turned out
	// to be the standard one. Such a row never expires, and is shown as a
	// search. It changes nothing about what the row can pair with.
	Queued bool `json:"queued,omitempty"`
	// Present is false for a row whose author has closed the tab or wandered
	// off. Their row stays on the board — they are still queued, and taking it
	// summons them — but the game will not open the instant you click, so the
	// lobby has to be able to say so.
	//
	// Deliberately not omitempty: false is the value carrying the information,
	// and a client that saw no field could not tell "away" from "old server".
	Present         bool  `json:"present"`
	CreatedAtUnixMs int64 `json:"createdAtUnixMs"`
	// Zero for a seek that does not expire, which is what a plain search is.
	ExpiresAtUnixMs int64 `json:"expiresAtUnixMs,omitempty"`
}

// LiveGameSeries places a live game inside the bot series it is one game of.
// It travels with the lobby row rather than as a list of its own because every
// question anybody asks of it — how far along is this run, who is ahead, what
// do I watch next — is asked about a game that is on screen or in the list.
//
// The tally is the run's own count rather than a database read: the lobby
// republishes on every game start and finish, and a query per row would turn
// that into a query per row per broadcast.
type LiveGameSeries struct {
	SeriesID   string `json:"seriesId"`
	GameNumber int    `json:"gameNumber"`
	TotalGames int    `json:"totalGames"`
	FirstWins  int    `json:"firstWins"`
	SecondWins int    `json:"secondWins"`
	Draws      int    `json:"draws"`
	// FirstIsRed says which seat the run's first bot holds in this game, which
	// is the only way to read the tally against the two names on the row. The
	// seats swap every game, so it cannot be inferred from the colours alone.
	FirstIsRed bool `json:"firstIsRed"`
}

// LiveGamePosition is the compact board picture sent to the lobby. A complete
// game.Grid is several kilobytes because every square repeats coordinates and
// field names; the rail only needs the pieces and territory to draw the board.
// Rows use the same RPSrps. alphabet as game.StartingPosition. Owners use r/b.
// for Red, Blue, and neutral territory respectively.
type LiveGamePosition struct {
	Rows   []string `json:"rows"`
	Owners []string `json:"owners"`
}

// LiveGameSummary is the public lobby representation of an in-progress game.
// Ratings are captured when the match starts so a disconnected player still
// has a complete row in the live-game list. Position, turn, and move number
// make the lobby board a real live view without publishing the much larger
// full game state to every connected client.
type LiveGameSummary struct {
	GameID          string             `json:"gameId"`
	ModeID          game.ModeID        `json:"modeId"`
	ModeName        string             `json:"modeName"`
	RedPlayer       game.PlayerProfile `json:"redPlayer"`
	BluePlayer      game.PlayerProfile `json:"bluePlayer"`
	RedElo          int                `json:"redElo"`
	BlueElo         int                `json:"blueElo"`
	SpectatorCount  int                `json:"spectatorCount"`
	StartedAtUnixMs int64              `json:"startedAtUnixMs"`
	Position        LiveGamePosition   `json:"position"`
	CurrentTurn     game.PlayerColor   `json:"currentTurn"`
	MoveNumber      int                `json:"moveNumber"`
	// Series is set only for a game being played as part of a bot series.
	Series *LiveGameSeries `json:"series,omitempty"`
}

// ChatMessage is authored from the authenticated client profile. SenderRole
// allows players to locally hide spectator messages without weakening the
// server-side identity attached to each message.
type ChatMessage struct {
	ID string `json:"id"`
	// RoomID is the conversation this belongs to, which is what a client
	// matches against: GameID below is only the board it was typed at, and a
	// bot series has several of those in one room.
	RoomID       string `json:"roomId"`
	GameID       string `json:"gameId"`
	SenderUserID string `json:"senderUserId"`
	SenderName   string `json:"senderName"`
	// SenderTitle is the tag worn in front of the name, empty for most people.
	// Recorded on the message rather than resolved when it is rendered, so a
	// transcript still reads the way the room read at the time: a title granted
	// or revoked later does not rewrite what everybody saw.
	SenderTitle  string           `json:"senderTitle,omitempty"`
	SenderRole   string           `json:"senderRole"`
	SenderColor  game.PlayerColor `json:"senderColor,omitempty"`
	Text         string           `json:"text"`
	SentAtUnixMs int64            `json:"sentAtUnixMs"`
}

// ServerMessage is the shared WebSocket response envelope.
type ServerMessage struct {
	Type        string                `json:"type"`
	Message     string                `json:"message,omitempty"`
	ModeID      game.ModeID           `json:"modeId,omitempty"`
	Modes       []game.ModeDefinition `json:"modes,omitempty"`
	LiveGames   []LiveGameSummary     `json:"liveGames,omitempty"`
	Tournaments []TournamentSnapshot  `json:"tournaments,omitempty"`
	Challenge   *Challenge            `json:"challenge,omitempty"`
	Challenges  []Challenge           `json:"challenges,omitempty"`
	// OpenChallenges is the public board of challenges nobody has claimed.
	// Separate from Challenges, which is this player's own private inbox: the
	// two are different lists to different audiences, and merging them would
	// make "somebody challenged me" indistinguishable from "somebody is looking
	// for a game".
	OpenChallenges     []Challenge          `json:"openChallenges,omitempty"`
	Account            *persistence.Account `json:"account,omitempty"`
	DefaultTimeControl *game.TimeControl    `json:"defaultTimeControl,omitempty"`
	TimeControl        *game.TimeControl    `json:"timeControl,omitempty"`
	// Setup accompanies a queue update, so a searching client can show what it
	// is searching for without keeping its own copy of what it asked for.
	Setup     *game.GameSetup  `json:"setup,omitempty"`
	Color     game.PlayerColor `json:"color,omitempty"`
	GameState *game.GameState  `json:"gameState,omitempty"`
	// PGN is the game so far, written the same way a finished one is archived.
	//
	// A board snapshot says where the pieces are and nothing about how they got
	// there, so a spectator who arrived at move twenty and a player who
	// refreshed had no history: no move list, and nothing to step back through.
	// This is that history, in the one form every screen here already replays.
	//
	// Carried on every message that hands over a live GameState, rather than
	// sent once and then patched move by move, because a client that missed one
	// patch would be silently wrong about the game for the rest of it. Written
	// only when somebody is there to read it — see sessionAudience — since a
	// bot-versus-bot game nobody is watching would otherwise re-encode itself
	// on every move for no reader.
	//
	// Result is `*` until the game ends, which is what the writer already does
	// for a game interrupted by a restart.
	PGN              string              `json:"pgn,omitempty"`
	From             *game.Position      `json:"from,omitempty"`
	ValidMoves       []game.Position     `json:"validMoves,omitempty"`
	SearchRange      int                 `json:"searchRange,omitempty"`
	QueuedForMs      int64               `json:"queuedForMs,omitempty"`
	ModePlayerCounts map[game.ModeID]int `json:"modePlayerCounts,omitempty"`
	ModeQueueCounts  map[game.ModeID]int `json:"modeQueueCounts,omitempty"`
	BotPlayerCount   int                 `json:"botPlayerCount,omitempty"`
	// OnlineCount is every person connected to the lobby, however they are
	// spending their time. The per-mode figures beside it are populations of
	// one activity each; this is the whole room.
	OnlineCount  int                       `json:"onlineCount,omitempty"`
	RatingUpdate *persistence.RatingUpdate `json:"ratingUpdate,omitempty"`
	ChatMessage  *ChatMessage              `json:"chatMessage,omitempty"`
	ChatMessages []ChatMessage             `json:"chatMessages,omitempty"`
	// ChatRoomID accompanies a chat history, naming the conversation the
	// client has just joined so it can tell which later messages are for it.
	// Equal to the game id for an ordinary game; equal to the series id for
	// every game of a bot series, and to the tournament id for every match of
	// a bots-only event.
	ChatRoomID string `json:"chatRoomId,omitempty"`
	// ChatRoomScope says which of those the room is, so a client can name the
	// conversation rather than guess from the id. See ChatScope.
	ChatRoomScope ChatScope `json:"chatRoomScope,omitempty"`
	// ChatOccupancy is how many people are in that conversation, sent with a
	// history and again whenever somebody joins or leaves it. It counts the
	// room rather than the game's spectator list, so it stays meaningful after
	// the result: a finished game's room still has people in it.
	ChatOccupancy           int   `json:"chatOccupancy,omitempty"`
	ReconnectDeadlineUnixMs int64 `json:"reconnectDeadlineUnixMs,omitempty"`
	// EngineBots is the roster of connected engines. Kept separate from
	// BotPlayerCount, which counts people practising against browser bots and
	// means very nearly the opposite thing.
	EngineBots []BotPresence `json:"engineBots,omitempty"`
	BotName    string        `json:"botName,omitempty"`
	// BotID names the registry row a bot_drain_update is about. The owner's
	// page keys its list on that id rather than on the name, which is the
	// account's and can be changed from the client's config file.
	BotID  string `json:"botId,omitempty"`
	GameID string `json:"gameId,omitempty"`
	// Drain is the graceful shutdown a bot is under, carried on bot_draining,
	// bot_shutdown and bot_drain_update. See bot_shutdown.go.
	Drain *BotDrainState `json:"drain,omitempty"`
	// BotBench is the scheduled window in which no engine takes a game,
	// carried on engine_bots and on connection_ready. See bot_bench.go.
	//
	// Sent whether or not one is running: when none is, it describes the next
	// one, which is what lets the lobby warn people that the ladder closes at
	// half past rather than only explain it once it has.
	BotBench *BotBenchState `json:"botBench,omitempty"`
	// Update is the graceful restart the whole server is under, carried on
	// server_update and on connection_ready. The same idea as Drain one scale
	// up, and deliberately a separate field: a bot can be draining on a server
	// that is not, and the reverse is the ordinary case. See deploy_drain.go.
	Update *ServerUpdateState `json:"update,omitempty"`
	// Notice is the standing announcement, carried on server_notice and on
	// connection_ready. A notice with no text means take the banner down. See
	// announcements.go.
	Notice *ServerNotice `json:"notice,omitempty"`
	// Restrictions is what this account may not do, carried on `restrictions`
	// and on connection_ready. Absent means nothing is in force, which is the
	// case for almost everybody.
	//
	// Sent so a client can say why in advance rather than only after a refusal:
	// a muted player should see a disabled chat box explaining itself, not
	// discover the mute by typing into one that swallows their message. See
	// moderation.go.
	Restrictions []persistence.PublicRestriction `json:"restrictions,omitempty"`

	// FirstMoveDeadlineUnixMs is when a game that has been opened but not begun
	// gives up waiting. Zero for every game that is already being played, which
	// is how a client tells the two apart without a second message: a board with
	// a deadline on it is one where nothing is rated yet and nothing is ticking.
	FirstMoveDeadlineUnixMs int64 `json:"firstMoveDeadlineUnixMs,omitempty"`
	// Queue is this client's own search, sent on connection_ready so a
	// reconnecting player learns in one message whether their place was held.
	Queue *QueueSnapshot `json:"queue,omitempty"`
	// PushEnabled says whether this server can call anybody back at all. False
	// turns off the whole offer to wait with the tab closed, rather than leaving
	// a button that quietly cannot work.
	PushEnabled bool `json:"pushEnabled,omitempty"`
	// PushTransports says by which means, so a client can answer the same
	// question about the device it is actually running on. A server with VAPID
	// keys and no Apple key can call a laptop back and not a phone, and the
	// phone has to be told that rather than shown the laptop's answer.
	PushTransports *pushTransports `json:"pushTransports,omitempty"`
	// ModeReadyCounts is the subset of ModeQueueCounts who are at the keyboard
	// right now. The nudge shown to somebody playing a bot keys off this one:
	// telling them a human is waiting, when that human is asleep, turns a
	// helpful prompt into a wasted click.
	ModeReadyCounts map[game.ModeID]int `json:"modeReadyCounts,omitempty"`
}
