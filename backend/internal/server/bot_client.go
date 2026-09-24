package server

import (
	"context"
	"encoding/base64"
	"errors"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"rps-strategy/backend/internal/botclient"
	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
	"rps-strategy/backend/internal/rpsi"
)

// Engine bots: connections that are programs rather than people.
//
// The server drives them. It formats the RPSI lines, ships them over the
// socket, and reads back whatever the engine printed; the client on the far
// end is a pipe with no game logic in it. Everything downstream of choosing a
// move — seating, clocks, chat rooms, spectating, archiving — is the ordinary
// path, because a bot is an ordinary account.

const (
	// botHandshakeTimeout covers `rpsi` and `isready`, which should be
	// instant. A budget this large is for a cold process on a slow machine,
	// not for thinking.
	botHandshakeTimeout = 15 * time.Second
	// botMoveGrace is added to the engine's own clock budget before the server
	// gives up on a reply, covering the round trip and process scheduling.
	botMoveGrace = 5 * time.Second
	// botMinimumMoveTimeout keeps a bot on a nearly-flagged clock from being
	// declared faulty when it is merely about to lose on time. Losing on time
	// is a game result; being declared faulty is not.
	botMinimumMoveTimeout = 10 * time.Second
	// botMaxConcurrentGames is the most slots one bot may open, whatever its
	// config file says. A ceiling rather than a guess at what a machine can do:
	// the point of the setting is that its owner knows, and the point of the
	// ceiling is that a bot cannot take an unbounded share of the lobby.
	botMaxConcurrentGames = 5
	// botMoveInterval is the least wall time between one move of a game and the
	// next, where an engine is playing them. An engine that answers sooner than
	// that has its move held until the interval is up.
	//
	// Two engines left to themselves play a five-minute game in a second or so
	// of real time, and every one of those moves is a record appended, a PGN
	// rendered, a position broadcast and a lobby view republished. A machine
	// running several such games spends all of itself on boards nobody is
	// watching yet. Five moves a second per game is still faster than anyone
	// can read, and a twentieth of the work.
	//
	// Neither clock pays for the wait, so pacing cannot decide a game: an
	// engine is charged for the time it spent thinking and for nothing else.
	// See game.HoldClock.
	botMoveInterval = 200 * time.Millisecond
)

// botClient is the engine session hanging off one connection.
type botClient struct {
	botID string
	// record is the registry row as of the last claim, used for the roster and
	// for settings. Settings can change while the bot is online, so this is
	// refreshed rather than trusted forever.
	mu        sync.Mutex
	record    persistence.Bot
	handshake rpsi.Handshake
	ready     bool
	// pending is the exchange the server is waiting on. Only one is ever in
	// flight: the protocol is strict request/response, which is what lets the
	// client be as small as it is.
	pending *botExchange
	// sequence numbers every exchange so a reply that arrives after its
	// timeout can be discarded instead of being mistaken for the next answer.
	sequence int64
	// retriedGameID is the game an illegal or unreadable move has already been
	// forgiven once in, so the second one is a fault rather than a loop.
	retriedGameID string
	// heldGameID is the game this engine has already given a move in, until
	// that move is played or given up on. Empty the rest of the time.
	//
	// The second half of `pending` above, and what keeps promptBot safe to call
	// redundantly across a paced move. A question is outstanding from the ask
	// until the reply is read; the answer is then in hand until it reaches the
	// board, which with a pace on it is a fifth of a second later. Through all
	// of that the position still shows this engine on move, so a prompt that
	// found neither field set would ask it for a move it has already given --
	// and two copies of that move arrive, the second of them out of turn and
	// faulted as illegal.
	//
	// Set by handleEngineReply under the lock that clears `pending`, so there
	// is no instant in which the engine holds neither, and cleared by whoever
	// deals with the answer. See releaseBotMove and botMoveInterval.
	heldGameID string
	// clientVersion is the rpsbot.py this bot is running, for the roster and
	// for the owner to see when something misbehaves.
	//
	// Not to be confused with the engine's own build, which is engineVersion
	// below. These move independently and mean different things: one is the
	// script this site publishes, the other is the program its owner wrote.
	clientVersion string
	// engineVersion is a build declared in rpsbot.conf, which overrides nothing
	// unless the engine declined to declare one itself. See beginBotHandshake.
	engineVersion    string
	upgradeAvailable bool
	// publicBase is the origin this connection arrived on, kept because the
	// upgrade notice is sent after the handshake request is gone. Set once and
	// never written again, so it is read without the lock.
	publicBase string
	// iconWarning is why the icon this client sent was not used, held until the
	// handshake finishes so it can travel with bot_ready. Same treatment as
	// publicBase: written once, before the connection is registered.
	iconWarning string
	// drain is the graceful shutdown this connection is under, or nil. Held
	// here rather than in the registry because it lasts exactly as long as the
	// socket does — see bot_shutdown.go. Set on every connection of a bot at
	// once: a drain is something the bot is doing, not something one of its
	// sockets is doing.
	drain *botDrain
	// sessionID is the process on the far end, and slot is which of its
	// connections this is. One rpsbot.py opens `maxGames` sockets sharing a
	// session id; a socket arriving with a different one is a second process
	// holding the same token, which displaces the first. See registerBot.
	sessionID string
	slot      int
	maxGames  int
	// reservedBy is a bot-versus-bot series holding this connection between its
	// pairs, or empty. A series is a run of games with the same two engines, so
	// the slot it is using has to stay its own across the second or so between
	// one game ending and the next starting — otherwise a challenge arriving in
	// that gap takes the slot and the series aborts mid-run.
	reservedBy string
}

// sessionSeat is whoever is holding one colour of a game right now, and nil for
// a seat standing empty.
//
// Read under the lock, which is not a formality here. The three places an
// engine is spoken to about a game all resolve their seat through this or
// through sessionSeats, and the write they race is the one this whole file is
// about: a socket dropping mid-game sets the seat to nil under server.mu, and a
// reconnect fills it in again. Read unsynchronised, promptBot could hand the
// position to a socket that has just gone — and then wait out the whole move
// timeout before calling the engine faulty, turning a reconnect that would have
// worked into a lost game.
func (server *Server) sessionSeat(session *GameSession, color game.PlayerColor) *Client {
	server.mu.RLock()
	defer server.mu.RUnlock()
	switch color {
	case game.Red:
		return session.redClient
	case game.Blue:
		return session.blueClient
	default:
		return nil
	}
}

// sessionSeats is both seats of a game, for the callers that speak to whichever
// of them is an engine.
func (server *Server) sessionSeats(session *GameSession) []*Client {
	server.mu.RLock()
	defer server.mu.RUnlock()
	return []*Client{session.redClient, session.blueClient}
}

// botExchange is one outstanding question to an engine.
type botExchange struct {
	sequence int64
	gameID   string
	expect   string
	deadline time.Time
	// onReply runs on the reading goroutine when the engine answers.
	onReply func(lines []string)
}

// engineFrame is the only thing the server sends a bot.
//
// Its own type rather than more fields on ServerMessage: `Client.Send` takes
// any value, so this costs nothing, and it keeps four protocol-specific fields
// out of the twenty message types that will never use them.
type engineFrame struct {
	Type      string   `json:"type"`
	GameID    string   `json:"gameId,omitempty"`
	Seq       int64    `json:"seq"`
	Lines     []string `json:"lines"`
	Expect    string   `json:"expect"`
	TimeoutMs int64    `json:"timeoutMs"`
}

// botReadyMessage is what a bot gets instead of connection_ready, which on a
// busy server carries tens of kilobytes of lobby and tournament state that a
// bot will never read.
type botReadyMessage struct {
	Type   string        `json:"type"`
	BotID  string        `json:"botId"`
	Name   string        `json:"name"`
	UserID string        `json:"userId"`
	Modes  []game.ModeID `json:"modes"`
	// ClientUpdate is set when the client works but is not the current one.
	// A notice rather than a refusal: an author mid-tournament should not be
	// knocked offline by a release that does not affect them.
	ClientUpdate *clientUpdate `json:"clientUpdate,omitempty"`
	// IconWarning says why the icon that arrived was not used. A bot with an
	// unreadable picture is still a bot, so this is printed rather than fatal.
	IconWarning string `json:"iconWarning,omitempty"`
	// Rules is the day each mode this engine plays was last republished, keyed
	// by mode. The client prints it on every connect and says so when it is not
	// the date that machine last saw — see game.ModeDefinition.RulesPublished
	// for why an engine has to be told rather than left to notice.
	Rules map[game.ModeID]string `json:"rules,omitempty"`
}

type clientUpdate struct {
	Version string `json:"version"`
	URL     string `json:"url"`
}

// BotPresence is one row of the online-bot roster.
//
// Distinct from the long-standing botPlayerCount, which counts *people*
// practising against browser bots — nearly the opposite thing.
type BotPresence struct {
	BotID  string `json:"botId"`
	UserID string `json:"userId"`
	Name   string `json:"name"`
	// OwnerUserID is the account an engine is registered to, which the lobby
	// needs for one question: whether two engines belong to the same person. A
	// series between two of one owner's bots is casual (see sameBotOwner in
	// bot_series.go), and the form that starts one should be able to say so
	// before it is pressed rather than after.
	//
	// Published as the id rather than as something derived, because it is
	// already public: `GET /api/bots` has always served ownerUserId on every
	// registered engine, unauthenticated. A grouping key or a per-viewer
	// "yours" flag would be hiding, from this one route, something the route
	// next to it hands out — and a per-viewer field cannot work here anyway,
	// since the roster is one payload broadcast to every connected client.
	OwnerUserID  string              `json:"ownerUserId,omitempty"`
	Description  string              `json:"description,omitempty"`
	EngineName   string              `json:"engineName,omitempty"`
	EngineAuthor string              `json:"engineAuthor,omitempty"`
	Modes        []game.ModeID       `json:"modes,omitempty"`
	Elo          int                 `json:"elo"`
	ModeRatings  map[game.ModeID]int `json:"modeRatings,omitempty"`
	// ModeRatingStates says which of those numbers are measurements. A mode
	// missing from it is unrated, which is also what an older server sending
	// neither map means, so a client reading this cannot mistake silence for
	// confidence. See persistence.RatingState.
	ModeRatingStates map[game.ModeID]persistence.RatingState `json:"modeRatingStates,omitempty"`
	// Title is the tag this engine wears, and empty for most of them. Read from
	// the cached account rather than from the connection's profile, which is
	// frozen at connect and so would never show a crown won since — the same
	// reason Elo above is. See republishBotTitles.
	Title persistence.TitleID `json:"title,omitempty"`
	// IconSHA256 is empty for a bot with no picture, which is every bot whose
	// owner has not given it one. See persistence.Bot.IconSHA256.
	IconSHA256 string `json:"iconSha256,omitempty"`
	// ReservedFor names the tournament holding this engine, and is empty for
	// the great majority of them. Published rather than merely enforced, for
	// the reason BotBenchState gives: a bot that is unavailable and healthy
	// needs words that say so, or the lobby ends up describing a working engine
	// as broken. See bot_reserve.go.
	ReservedFor string `json:"reservedFor,omitempty"`
	// Busy is the question every caller actually has: is there anywhere to put
	// a game. A bot allowed more than one at a time is busy only once all of
	// its slots are taken — which is why ActiveGames and Slots are published
	// beside it, so the lobby can say "playing 2 of 3" rather than choosing
	// between "playing" and "free" for a bot that is both.
	Busy        bool `json:"busy"`
	ActiveGames int  `json:"activeGames"`
	Slots       int  `json:"slots"`

	AllowPublicPlay bool `json:"allowPublicPlay"`
	// EnterLadder is whether this engine is in the ranked pool, which is the
	// only place a rating now comes from. Published so the lobby can say which
	// engines on the board are actually competing and which are here to be
	// challenged, and so an owner can see at a glance that the switch took.
	EnterLadder   bool   `json:"enterLadder"`
	ClientVersion string `json:"clientVersion,omitempty"`
	// Draining is an engine on its way out: it is playing what it already owes
	// and will take nothing new. Published rather than merely enforced, so the
	// lobby says "shutting down" instead of offering a button that refuses.
	Draining bool `json:"draining,omitempty"`
	// Benched is the same unavailability for a completely different reason: a
	// scheduled window in which no engine takes a game, which nobody asked for
	// and which ends by itself. See bot_bench.go.
	//
	// A separate field rather than Draining, because the two need different
	// words: an engine that is shutting down is going away, and one that is
	// benched is coming back at six. Every offer path treats them alike; only
	// the lobby tells them apart.
	Benched bool `json:"benched,omitempty"`
}

// acceptBotConnection claims or recognises a bot from its token and seats the
// connection.
//
// Claiming happens here, over the socket the bot will play on, rather than
// through a separate HTTP call. That is what lets the Python client have no
// HTTP in it at all: one destination to audit instead of two, and no
// registration step that can succeed while the connection fails.
func (server *Server) acceptBotConnection(
	ctx context.Context,
	connection *websocket.Conn,
	message ClientMessage,
	publicBase string,
) {
	reject := func(reason string) {
		_ = connection.WriteJSON(ServerMessage{Type: "bot_rejected", Message: reason})
		_ = connection.Close()
	}

	// Before anything else. A client too old to speak this protocol should be
	// told where to get a new one rather than failing later in a way its owner
	// has to guess at.
	upgradeAvailable, mustUpgrade := botclient.Outdated(message.ClientVersion)
	if mustUpgrade {
		reject(botclient.UpgradeMessage(botClientDownloadURL(publicBase)))
		return
	}

	maxGames, refusal := botSlotRequest(message)
	if refusal != "" {
		reject(refusal)
		return
	}

	bot, err := server.data.ClaimBot(ctx, message.Token, persistence.BotSettings{
		Name:             strings.TrimSpace(message.Name),
		Description:      strings.TrimSpace(message.Description),
		AllowPublicPlay:  message.PublicPlay,
		EnterTournaments: message.EnterTournaments,
		EnterLadder:      message.EnterLadder,
	})
	if err != nil {
		// The reasons here are all things the owner can fix from their own
		// machine or the website, so they are reported plainly rather than
		// flattened into one unhelpful message.
		switch {
		case errors.Is(err, persistence.ErrBotNotFound):
			reject("that bot token is not recognised")
		case errors.Is(err, persistence.ErrBotRetired):
			reject("this bot has been retired")
		case errors.Is(err, persistence.ErrBotDisabled):
			reject("this bot has been disabled by an administrator")
		case errors.Is(err, persistence.ErrUsernameTaken):
			reject("that bot name is already taken; choose another in rpsbot.conf")
		case errors.Is(err, persistence.ErrInvalidUsername):
			reject(err.Error())
		case errors.Is(err, persistence.ErrInvalidBotDescription):
			// Named as the file it comes from, like the username case above:
			// the description is a line in rpsbot.conf, and "invalid bot
			// description" alone leaves the owner hunting for where.
			reject("this server will not publish that description; edit it in rpsbot.conf")
		default:
			log.Printf("claim bot: %v", err)
			reject("could not register this bot")
		}
		return
	}

	account, err := server.data.Account(ctx, bot.UserID)
	if err != nil {
		reject("could not load this bot's account")
		return
	}

	// After the claim rather than inside it. A picture the server cannot read
	// is something to tell the owner about, not a reason to refuse an engine
	// that is otherwise ready to play — and the two failures have nothing to do
	// with each other.
	iconWarning := server.applyBotIcon(ctx, &bot, message.Icon)

	client := &Client{
		connection: connection,
		send:       make(chan []byte, botSendBuffer),
		done:       make(chan struct{}),
		profile:    playerProfile(account),
		account:    account,
		server:     server,
		readLimit:  botMaxMessage,
		bot: &botClient{
			botID:            bot.BotID,
			record:           bot,
			clientVersion:    message.ClientVersion,
			engineVersion:    strings.TrimSpace(message.EngineVersion),
			upgradeAvailable: upgradeAvailable,
			publicBase:       publicBase,
			iconWarning:      iconWarning,
			sessionID:        message.SessionID,
			slot:             message.Slot,
			maxGames:         maxGames,
		},
	}
	server.hub.Register(client)
	server.registerBot(client)
	if err := server.data.TouchBot(ctx, bot.BotID); err != nil {
		log.Printf("touch bot %s: %v", bot.BotID, err)
	}

	go client.writePump()
	// The handshake has to run once the write pump exists, or the first frame
	// sits in the buffer until something else wakes it.
	server.beginBotHandshake(client)
	client.readPump()
}

// botSlotRequest reads how many games at once a client says its machine can
// afford, and checks that this connection is one of that many slots.
//
// Absent on every client before 1.4, which means the single slot they have
// always had. Out of range is refused rather than quietly capped: a client that
// asked for seven slots opens seven sockets, and five of them working is a
// stranger thing to debug than being told the number is wrong.
func botSlotRequest(message ClientMessage) (maxGames int, refusal string) {
	maxGames = message.MaxGames
	if maxGames < 1 {
		maxGames = 1
	}
	if maxGames > botMaxConcurrentGames {
		return 0, "this bot asked to play " + strconv.Itoa(maxGames) +
			" games at once; the most any bot may play is " +
			strconv.Itoa(botMaxConcurrentGames)
	}
	if message.Slot < 0 || message.Slot >= maxGames {
		return 0, "this bot opened slot " + strconv.Itoa(message.Slot+1) +
			" of " + strconv.Itoa(maxGames)
	}
	return maxGames, ""
}

// applyBotIcon stores or removes the icon a client asserted, updating the
// record it was given and returning what to tell the owner when the picture
// could not be used.
//
// The three states of the field are the whole point of this function: see
// ClientMessage.Icon. An older client sends nothing and must keep the icon it
// uploaded before it was downgraded, or a script that predates icons would
// quietly strip every bot it runs.
func (server *Server) applyBotIcon(
	ctx context.Context,
	bot *persistence.Bot,
	encoded *string,
) string {
	if encoded == nil {
		return ""
	}
	// Whitespace is dropped rather than refused: base64 wrapped at 76 columns
	// is not a mistake worth failing an icon over.
	cleaned := strings.Map(func(character rune) rune {
		if character == ' ' || character == '\n' || character == '\r' || character == '\t' {
			return -1
		}
		return character
	}, *encoded)

	if cleaned == "" {
		if err := server.data.ClearBotIcon(ctx, bot.BotID); err != nil {
			log.Printf("clear bot icon %s: %v", bot.BotID, err)
			return "the old icon could not be removed"
		}
		bot.IconSHA256 = ""
		return ""
	}

	raw, err := base64.StdEncoding.DecodeString(cleaned)
	if err != nil {
		return "the icon was not readable base64, so the bot is showing none"
	}
	digest, err := server.data.SetBotIcon(ctx, bot.BotID, raw)
	if err != nil {
		if errors.Is(err, persistence.ErrBotIconInvalid) {
			// Without the sentinel: this is printed under the word "icon:" on
			// somebody's terminal, and "icon: bot icon rejected: it is not a
			// PNG" says the same thing three times.
			return strings.TrimPrefix(err.Error(), persistence.ErrBotIconInvalid.Error()+": ")
		}
		log.Printf("set bot icon %s: %v", bot.BotID, err)
		return "the icon could not be stored"
	}
	bot.IconSHA256 = digest
	return ""
}

// registerBot puts a connected bot in the directory, displacing whatever was
// holding the slot it claims.
//
// A bot is a set of connections rather than one, because its owner may have
// said it can play up to five games at once: rpsbot.py then opens one socket
// per slot, each with its own engine subprocess, and each still playing one
// game at a time. Everything downstream of here is unchanged by that — a slot
// is exactly the bot connection the server has always had.
//
// Which is why the key is (session, slot) rather than the bot id. The server
// has to tell one process's third socket, which is welcome, from a second
// process holding the same token, which is a configuration mistake — usually a
// forgotten terminal. The second case displaces, following what a reconnecting
// player already does and beating the alternative, which is two engines
// answering for one bot. A client that sends no session id at all — every one
// before 1.4 — has one slot and displaces, exactly as it always did.
func (server *Server) registerBot(client *Client) {
	bot := client.bot
	server.mu.Lock()
	existing := server.bots[bot.botID]
	kept := make([]*Client, 0, len(existing)+1)
	displaced := make([]*Client, 0, len(existing))
	for _, other := range existing {
		switch {
		case other == client:
			continue
		case other.bot.sessionID != bot.sessionID:
			// Another process, holding this token from somewhere else.
			displaced = append(displaced, other)
		case other.bot.slot == bot.slot:
			// This process, reconnecting a slot whose old socket the server has
			// not noticed is gone.
			displaced = append(displaced, other)
		default:
			kept = append(kept, other)
		}
	}
	server.bots[bot.botID] = insertBotConnection(kept, client)
	server.mu.Unlock()

	for _, other := range displaced {
		other.Send(ServerMessage{
			Type:    "bot_rejected",
			Message: "this bot connected from somewhere else",
		})
		other.close()
	}
	server.broadcastBots()
}

// insertBotConnection returns the slice with one connection added, in slot
// order — so the roster, and anything else that walks a bot's sockets, sees
// them in the order their owner would number them.
func insertBotConnection(connections []*Client, client *Client) []*Client {
	at := len(connections)
	for index, other := range connections {
		if other.bot.slot > client.bot.slot {
			at = index
			break
		}
	}
	connections = append(connections, nil)
	copy(connections[at+1:], connections[at:])
	connections[at] = client
	return connections
}

func (server *Server) unregisterBot(client *Client) {
	if !client.isBot() {
		return
	}
	// Nothing here ends a run, and that is the change worth stating. A dropped
	// socket used to abort every series the *bot* was in, immediately, which
	// was wrong three ways over: it killed a run because a spare slot with no
	// game on it hiccuped, it killed a run halfway through a pair — the one
	// place the pairing rule exists to stop it stopping — and, worst, it killed
	// a run on the way *back*, because a reconnecting slot displaces its own
	// stale socket and the close that follows landed here.
	//
	// An engine that is really gone is still not a series, and it still ends
	// one. It just ends it from playNextSeriesGame, after the same window a
	// game on the board gives it to come back. See seriesEngineAway.
	server.mu.Lock()
	remaining := make([]*Client, 0, len(server.bots[client.bot.botID]))
	for _, other := range server.bots[client.bot.botID] {
		if other != client {
			remaining = append(remaining, other)
		}
	}
	if len(remaining) == 0 {
		delete(server.bots, client.bot.botID)
	} else {
		server.bots[client.bot.botID] = remaining
	}
	server.mu.Unlock()
	server.broadcastBots()
}

// botConnections is every live socket for one bot, in slot order.
func (server *Server) botConnections(botID string) []*Client {
	server.mu.RLock()
	defer server.mu.RUnlock()
	if len(server.bots[botID]) == 0 {
		return nil
	}
	return append([]*Client(nil), server.bots[botID]...)
}

// botConnection is any one socket of a bot, for reading what every socket of it
// agrees on: the registry record, the engine handshake, the drain. Nil when the
// bot is not connected.
func (server *Server) botConnection(botID string) *Client {
	server.mu.RLock()
	defer server.mu.RUnlock()
	if len(server.bots[botID]) == 0 {
		return nil
	}
	return server.bots[botID][0]
}

// allBotConnections is every socket of every connected bot, which is what the
// per-connection housekeeping — expiring exchanges, settling drains — walks.
func (server *Server) allBotConnections() []*Client {
	server.mu.RLock()
	defer server.mu.RUnlock()
	clients := make([]*Client, 0, len(server.bots))
	for _, connections := range server.bots {
		clients = append(clients, connections...)
	}
	return clients
}

// botConnectionIsFree reports whether a slot could take a game right now:
// handshaken, not playing, and not held between the pairs of a series.
//
// Says nothing about whether the bot *should* be given one — a drain, a bench,
// and a mode it does not play are all questions about the bot rather than the
// slot, and each offer path asks them in its own words.
func (server *Server) botConnectionIsFree(client *Client) bool {
	if client == nil || !client.isBot() {
		return false
	}
	client.bot.mu.Lock()
	free := client.bot.ready && client.bot.reservedBy == ""
	client.bot.mu.Unlock()
	return free && server.participantFor(client) == nil
}

// freeBotConnection is the slot to hand the next game to, or nil when every one
// of this bot's slots is taken.
func (server *Server) freeBotConnection(botID string) *Client {
	for _, client := range server.botConnections(botID) {
		if server.botConnectionIsFree(client) {
			return client
		}
	}
	return nil
}

// botActiveGames is how many games a bot is in across all of its slots.
func (server *Server) botActiveGames(botID string) int {
	playing := 0
	for _, client := range server.botConnections(botID) {
		if server.participantFor(client) != nil {
			playing++
		}
	}
	return playing
}

// botRoster is the published list of engines available right now.
//
// One row per bot, not per connection: a bot with three slots is one engine
// that can play three games, and publishing it three times would put three
// challenge buttons in the lobby for one opponent.
func (server *Server) botRoster() []BotPresence {
	server.mu.RLock()
	bots := make([][]*Client, 0, len(server.bots))
	for _, connections := range server.bots {
		bots = append(bots, append([]*Client(nil), connections...))
	}
	playing := make(map[*Client]bool)
	for _, connections := range bots {
		for _, client := range connections {
			_, inGame := server.participants[client]
			playing[client] = inGame
		}
	}
	server.mu.RUnlock()

	// The two halves of botIsDraining, read apart: a bench applies to every
	// engine at once and is not something any of them asked for, so it is
	// published as itself rather than as a shutdown each of them is having.
	benched := server.botsAreBenched(time.Now())

	roster := make([]BotPresence, 0, len(bots))
	for _, connections := range bots {
		// The first handshaken slot speaks for the bot. One that has not
		// finished its handshake cannot be challenged yet, so a bot with none
		// is left out entirely: listing it would only produce failures.
		var client *Client
		slots, active, free := 0, 0, false
		for _, candidate := range connections {
			candidate.bot.mu.Lock()
			ready := candidate.bot.ready
			declared := candidate.bot.maxGames
			held := candidate.bot.reservedBy != ""
			candidate.bot.mu.Unlock()
			if declared > slots {
				slots = declared
			}
			if !ready {
				continue
			}
			if client == nil {
				client = candidate
			}
			if playing[candidate] {
				active++
			} else if !held {
				free = true
			}
		}
		if client == nil {
			continue
		}
		if slots < len(connections) {
			// A bot whose client is too old to say how many slots it has. It
			// has at least as many as are connected.
			slots = len(connections)
		}
		// Slots the client has not opened yet are counted in `slots`, so the
		// lobby can say what the engine is for, but they are not somewhere to
		// put a game: `free` is only ever about a socket that exists.

		client.bot.mu.Lock()
		record := client.bot.record
		handshake := client.bot.handshake
		clientVersion := client.bot.clientVersion
		client.bot.mu.Unlock()

		presence := BotPresence{
			BotID:           record.BotID,
			UserID:          record.UserID,
			Name:            record.Name,
			OwnerUserID:     record.OwnerUserID,
			Description:     record.Description,
			EngineName:      handshake.Name,
			EngineAuthor:    handshake.Author,
			Modes:           handshake.Modes,
			Elo:             client.account.Elo,
			Title:           client.account.Title,
			Busy:            !free,
			ActiveGames:     active,
			Slots:           slots,
			Draining:        botHasOwnDrain(client),
			Benched:         benched,
			ReservedFor:     server.botReservation(record.UserID),
			AllowPublicPlay: record.AllowPublicPlay,
			EnterLadder:     record.EnterLadder,
			ClientVersion:   clientVersion,
			IconSHA256:      record.IconSHA256,
		}
		if len(client.account.ModeRatings) > 0 {
			presence.ModeRatings = make(map[game.ModeID]int, len(client.account.ModeRatings))
			presence.ModeRatingStates = make(
				map[game.ModeID]persistence.RatingState, len(client.account.ModeRatings),
			)
			for modeID, rating := range client.account.ModeRatings {
				presence.ModeRatings[modeID] = rating.Elo
				presence.ModeRatingStates[modeID] = rating.State
			}
		}
		roster = append(roster, presence)
	}
	return roster
}

func (server *Server) broadcastBots() {
	bench := server.botBenchState(time.Now())
	server.broadcastToClients(ServerMessage{
		Type:       "engine_bots",
		EngineBots: server.botRoster(),
		BotBench:   &bench,
	})
}

// broadcastBotsForEngines restates the roster when a game has just taken or
// freed a slot, and does nothing when neither seat is an engine.
//
// `Busy` and `ActiveGames` are read off `server.participants`, so every path
// that seats or clears a game changes what the roster says without touching the
// roster itself. Left unpublished, the lobby keeps the badge it was last sent —
// PLAYING on an engine that finished ten minutes ago — until something else
// happens to any bot on the server, which is why the state looked like it
// needed a reload to come right.
//
// Filtered rather than published from the game paths unconditionally: this is
// the whole list of engines, and the great majority of games have no engine in
// them at all.
func (server *Server) broadcastBotsForEngines(red *Client, blue *Client) {
	if !red.isBot() && !blue.isBot() {
		return
	}
	server.broadcastBots()
}

// botClientFor returns a connected slot of a bot account, if any. Any of them:
// the callers want the bot, and use botConnections or freeBotConnection when
// they want a particular socket.
func (server *Server) botClientFor(userID string) *Client {
	server.mu.RLock()
	defer server.mu.RUnlock()
	for _, connections := range server.bots {
		for _, client := range connections {
			if client.profile.UserID == userID {
				return client
			}
		}
	}
	return nil
}

// ask sends one exchange to an engine and records what it is waiting for.
//
// Only one exchange is outstanding at a time. If one is already pending the
// new one is dropped: it can only be a duplicate prompt for a position the
// engine is already thinking about, and asking twice would produce two moves.
func (server *Server) ask(
	client *Client,
	gameID string,
	lines []string,
	expect string,
	timeout time.Duration,
	onReply func(lines []string),
) {
	if !client.isBot() {
		return
	}
	bot := client.bot
	bot.mu.Lock()
	// One question at a time, and an answer already given counts as one: this
	// engine owes the server a move in that game until the move is on the
	// board, which with a pace on it is a fifth of a second after it was given.
	// Both halves are read here, under the lock the send is decided by, because
	// a caller that checked either of them first would be acting on an answer
	// that could arrive in between -- which is exactly how the same move came
	// to be asked for, given, and played twice. See botClient.heldGameID.
	if bot.pending != nil || (expect == "bestmove" && bot.heldGameID == gameID) {
		bot.mu.Unlock()
		return
	}
	bot.sequence++
	exchange := &botExchange{
		sequence: bot.sequence,
		gameID:   gameID,
		expect:   expect,
		deadline: time.Now().Add(timeout),
		onReply:  onReply,
	}
	bot.pending = exchange
	bot.mu.Unlock()

	client.Send(engineFrame{
		Type:      "engine",
		GameID:    gameID,
		Seq:       exchange.sequence,
		Lines:     lines,
		Expect:    expect,
		TimeoutMs: timeout.Milliseconds(),
	})
}

// handleEngineReply matches a reply to its exchange and runs the continuation.
func (server *Server) handleEngineReply(client *Client, message ClientMessage) {
	if !client.isBot() {
		return
	}
	bot := client.bot
	bot.mu.Lock()
	pending := bot.pending
	// A reply whose sequence does not match is a late answer to a question the
	// server has already given up on. Dropping it is the whole reason `seq`
	// exists; without it the stale move would be played into the next position.
	if pending == nil || pending.sequence != message.Seq {
		bot.mu.Unlock()
		return
	}
	// A move is not answered until it is on the board. Handed over here, under
	// the lock that clears `pending`, because the two are one exclusivity and a
	// gap between them is a gap in which this engine is asked for a move it has
	// already given. Every other exchange ends here, its continuation's whole
	// job being to ask the next question. See botClient.heldGameID.
	if pending.expect == "bestmove" {
		bot.heldGameID = pending.gameID
	}
	bot.pending = nil
	bot.mu.Unlock()

	if message.Type == "engine_error" {
		server.faultBot(client, pending.gameID, message.Reason)
		return
	}
	pending.onReply(message.Lines)
}

// releaseBotMove ends an engine's hold on the move it gave in one named game,
// whether that move was played, refused or dropped. A no-op for a connection
// holding nothing, which is every connection most of the time.
//
// Named, for the reason gameParticipant is: by the time a paced move is dealt
// with, the engine may be in a different game. A series seats the next one
// within a second of the last, so a move dropped because its board is gone can
// arrive to find the engine already holding an answer in the game after it —
// and a release that cleared whatever it found would take that one off, leaving
// the new game open to exactly the duplicate this field prevents.
//
// Called by whoever deals with the answer rather than deferred by whoever
// received it, because two of those callers ask the engine again as they go —
// and a question asked while the hold is still on is a question dropped.
func (server *Server) releaseBotMove(client *Client, gameID string) {
	if !client.isBot() {
		return
	}
	client.bot.mu.Lock()
	if client.bot.heldGameID == gameID {
		client.bot.heldGameID = ""
	}
	client.bot.mu.Unlock()
}

// beginBotHandshake runs `rpsi` then `isready`, then publishes the bot.
func (server *Server) beginBotHandshake(client *Client) {
	server.ask(client, "", []string{"rpsi"}, "rpsiok", botHandshakeTimeout, func(lines []string) {
		handshake := rpsi.ParseHandshake(lines)
		client.bot.mu.Lock()
		client.bot.handshake = handshake
		botID := client.bot.botID
		declared := client.bot.engineVersion
		client.bot.mu.Unlock()

		// The engine's own word first, and the conf line only when it said
		// nothing. An author who rebuilds gets the new number reported without
		// having to remember to edit a file, which is the case a stale version
		// string is most likely to be wrong in; the conf line is there for
		// somebody wrapping a binary they cannot change.
		engineVersion := handshake.Version
		if engineVersion == "" {
			engineVersion = declared
		}

		if handshake.Protocol != 0 && handshake.Protocol != rpsi.ProtocolVersion {
			client.Send(ServerMessage{
				Type: "bot_rejected",
				Message: "this server speaks RPSI protocol " +
					strconv.Itoa(rpsi.ProtocolVersion) + "; the engine reported " +
					strconv.Itoa(handshake.Protocol),
			})
			client.close()
			return
		}
		if err := server.data.RecordBotEngineIdentity(
			context.Background(), botID,
			persistence.BotEngineIdentity{
				Name:    handshake.Name,
				Author:  handshake.Author,
				Version: engineVersion,
				Modes:   handshake.Modes,
			},
		); err != nil {
			log.Printf("record engine identity for %s: %v", botID, err)
		}

		server.ask(client, "", []string{"isready"}, "readyok", botHandshakeTimeout,
			func([]string) {
				client.bot.mu.Lock()
				client.bot.ready = true
				record := client.bot.record
				client.bot.mu.Unlock()
				ready := botReadyMessage{
					Type:   "bot_ready",
					BotID:  record.BotID,
					Name:   record.Name,
					UserID: record.UserID,
					Modes:  handshake.Modes,
				}
				if client.bot.upgradeAvailable {
					ready.ClientUpdate = &clientUpdate{
						Version: botclient.Version(),
						URL:     botClientDownloadURL(client.bot.publicBase),
					}
				}
				ready.IconWarning = client.bot.iconWarning
				ready.Rules = server.rulesPublishedFor(handshake.Modes)
				client.Send(ready)
				server.broadcastBots()
				// After bot_ready, never before: the first thing this may do is
				// put a position to the engine, and a `go` arriving ahead of
				// the line that says the handshake finished is a frame the
				// client has no state to handle. See bot_resume.go.
				server.resumeBotGames(client)
			})
	})
}

// rulesPublishedFor dates the rules of the modes an engine says it plays.
//
// Only those modes: a bot told about a rule change in a mode it does not play
// has been given something to check that cannot affect it, and the next real
// one is that much easier to skim past.
func (server *Server) rulesPublishedFor(modes []game.ModeID) map[game.ModeID]string {
	published := make(map[game.ModeID]string, len(modes))
	for _, definition := range server.registry.Definitions() {
		for _, modeID := range modes {
			if definition.ID == modeID && definition.RulesPublished != "" {
				published[modeID] = definition.RulesPublished
			}
		}
	}
	if len(published) == 0 {
		return nil
	}
	return published
}

// beginBotGame tells every engine in a session that a new game has started,
// then asks whichever of them moves first.
//
// `newgame` and `isready` travel together: the second is where UCI allows an
// engine to do slow setup, so waiting for `readyok` before the clock matters
// is the difference between a fair first move and one searched while the
// transposition table was still being allocated.
func (server *Server) beginBotGame(session *GameSession) {
	for _, client := range server.sessionSeats(session) {
		if !client.isBot() {
			continue
		}
		seat := client
		server.ask(
			seat, session.gameID,
			[]string{rpsi.NewGameCommand(session.modeID), "isready"},
			"readyok", botHandshakeTimeout,
			func([]string) { server.promptBot(session, session.game.Snapshot()) },
		)
	}
}

// challengeBot seats a person against an engine that has opted in.
//
// A dedicated message rather than the ordinary challenge flow, which carries
// name broadcast, a pending-offer cap, and ten-minute expiry — all of it
// pointless against a counterparty that answers synchronously.
func (server *Server) challengeBot(
	client *Client,
	botID string,
	modeID game.ModeID,
	timeControl *game.TimeControl,
	preferredColor game.PlayerColor,
) {
	if client.isBot() {
		return
	}
	refuse := func(reason string) {
		client.Send(ServerMessage{Type: "bot_unavailable", Message: reason})
	}
	if !server.registry.Has(modeID) || !server.registry.Playable(modeID) {
		refuse("that game mode is not open for new matches")
		return
	}
	switch preferredColor {
	case "", game.Neutral, game.Red, game.Blue:
	default:
		refuse("choose Red, Blue, or either side")
		return
	}
	control := game.DefaultTimeControl()
	if timeControl != nil {
		control = *timeControl
	}
	if err := control.Validate(); err != nil {
		refuse(err.Error())
		return
	}
	if !server.clientIsFree(client) || server.seeks.ForClient(client) != nil {
		refuse("finish your current game before challenging a bot")
		return
	}

	botClientConn := server.botConnection(botID)
	if botClientConn == nil {
		refuse("that bot is not online")
		return
	}

	botClientConn.bot.mu.Lock()
	record := botClientConn.bot.record
	handshake := botClientConn.bot.handshake
	ready := botClientConn.bot.ready
	botClientConn.bot.mu.Unlock()

	// Before anything about the bot: this is the server refusing, not the
	// engine, and saying "that bot is not taking games" would send its owner
	// looking at a bot that is perfectly fine.
	if server.isUpdating() {
		refuse(server.updateRefusalMessage())
		return
	}
	if !ready {
		refuse("that bot is still starting up")
		return
	}
	if !record.AllowPublicPlay {
		refuse("that bot is not open to challenges")
		return
	}
	// The bench first, because it is the reason that is true of every engine
	// at once: "Fishy is shutting down" is a plainly wrong thing to say about a
	// bot whose owner has not touched it and which is back in play at six.
	if window := server.botBenchAt(time.Now()); window != nil {
		refuse(botBenchRefusal(window))
		return
	}
	if botIsDraining(botClientConn) {
		refuse(record.Name + " is shutting down and is not taking new games")
		return
	}
	// After the two that are about the engine being unavailable, because this
	// one is not: a reserved engine is healthy, connected and busy with
	// something. See bot_reserve.go.
	if event := server.botReservation(record.UserID); event != "" {
		refuse(botReserveRefusal(record.Name, event))
		return
	}
	if !handshake.Supports(modeID) {
		refuse(record.Name + " does not play that mode")
		return
	}
	// Which socket of the bot, rather than whether the bot is free: an engine
	// its owner allowed three games at once has three of them, and the game
	// goes to whichever is empty.
	seat := server.freeBotConnection(botID)
	if seat == nil {
		refuse(botFullRefusal(record.Name, server.botActiveGames(botID)))
		return
	}

	server.releaseFromLobby(client)
	// Casual against a community engine, ranked against one of the server's own.
	//
	// The first half is the old rule and still the right one: an engine's author
	// can tune it to lose, so a rating handed out by somebody's bot is a rating
	// its owner controls. That has to stay casual however tempting it looks.
	//
	// The second half is what puts people and engines on one scale. A yardstick
	// is frozen, server-run and owned by nobody, so it cannot be tuned to lose
	// and there is no author to benefit — and it is the fixed point every bot
	// rating is a distance from. A person who plays one is therefore measured
	// against the same object the whole engine ladder is measured against, which
	// makes "about as strong as a 90-rated engine" a fact rather than a
	// comparison of two unrelated numbers. It costs one exception here and no
	// human-versus-community-bot ranked play at all.
	//
	// Not rated for an account that cannot play ranked, the same as any other
	// game: rankedAllowed covers the unregistered and the sanctioned.
	calibration := server.botIsYardstick(record.BotID) && server.rankedAllowed(client)
	setup := game.GameSetup{ModeID: modeID, TimeControl: control, Casual: !calibration}
	human := QueueEntry{
		Client:   client,
		Setup:    setup,
		Elo:      matchmakingElo(client, modeID),
		JoinedAt: time.Now(),
	}
	engine := QueueEntry{
		Client:   seat,
		Setup:    setup,
		Elo:      matchmakingElo(seat, modeID),
		JoinedAt: time.Now(),
	}
	// startConfiguredMatch seats its first entry Red, so the seat the player
	// asked for is simply the order the two go in. An engine takes whichever
	// side is left: it has no preference to weigh, and beginBotGame already
	// prompts it from either seat.
	first, second := human, engine
	if preferredColor == game.Blue {
		first, second = engine, human
	}
	// Nothing to do with the session here: it says what it needs to on its own,
	// and the roster this game changes is restated by startConfiguredMatch —
	// which every other seating path goes through too.
	server.startConfiguredMatch(first, second, matchSetup{})
}

// botFullRefusal is what a bot with nowhere to put a game says. The count is
// the wording's whole job: "already playing a game" is a plainly wrong thing to
// tell somebody who can see the engine is in three of them.
func botFullRefusal(name string, active int) string {
	switch {
	case active == 0:
		// Nothing on any board, and no room either: every slot is held by a
		// series, between one of its games and the next.
		return name + " is in the middle of a series"
	case active == 1:
		return name + " is already playing a game"
	default:
		return name + " is already playing " + strconv.Itoa(active) +
			" games, which is as many as it takes at once"
	}
}

// promptBot asks the engine for a move, if it is its turn and nothing is
// already in flight.
//
// Called after every change to a game a bot is in. It is safe to call
// redundantly: the turn check drops it when it is the opponent's move, and
// `ask` drops it while this engine still owes the server an answer -- either a
// question it has not replied to or a move on its way to the board.
func (server *Server) promptBot(session *GameSession, state game.GameState) {
	if state.Status != game.InProgress {
		return
	}
	client := server.sessionSeat(session, state.CurrentTurn)
	if !client.isBot() {
		return
	}
	record := session.game.Record()
	moves := session.game.LegalMoves()
	lines := []string{
		rpsi.PositionCommand(record),
		rpsi.LegalMovesCommand(moves),
		rpsi.GoCommand(state.Clock, state.TimeControl),
	}

	// The engine's own clock is the real deadline; the server only needs to
	// stop waiting somewhat after it, so that a flagged bot loses on time —
	// an ordinary game result — rather than being reported as broken.
	remaining := state.Clock.RedRemainingMs
	if state.CurrentTurn == game.Blue {
		remaining = state.Clock.BlueRemainingMs
	}
	timeout := time.Duration(remaining)*time.Millisecond + botMoveGrace
	if timeout < botMinimumMoveTimeout {
		timeout = botMinimumMoveTimeout
	}

	// The pace is measured from here rather than from the move this position
	// came out of, because this is the instant the server can be sure of and
	// the two are the same instant in the ordinary case: a bot is asked from
	// inside the broadcast of the move before it. Where they differ -- a
	// reconnect, a retry, an engine asked after its own handshake -- asking is
	// the later of the two, so measuring from it paces the move by at least as
	// long as it would have been paced anyway.
	askedAt := time.Now()
	gameID := session.gameID
	server.ask(client, gameID, lines, "bestmove", timeout, func(lines []string) {
		server.applyBotMove(client, gameID, lines, askedAt)
	})
}

// applyBotMove reads the move an engine returned and plays it, waiting out the
// pace first if the engine answered sooner than botMoveInterval allows.
//
// The reply is read before anything waits, so an engine that said something
// unusable is told so at once rather than a fifth of a second later. Only a
// move is paced; a fault is not a move.
func (server *Server) applyBotMove(
	client *Client,
	gameID string,
	lines []string,
	askedAt time.Time,
) {
	var bestmove string
	for _, line := range lines {
		if strings.HasPrefix(strings.TrimSpace(line), "bestmove") {
			bestmove = line
		}
	}
	if bestmove == "" {
		server.faultBot(client, gameID, "the engine returned no bestmove")
		return
	}
	from, to, err := rpsi.ParseBestMove(bestmove)
	if err != nil {
		server.retryOrFault(client, gameID, err.Error())
		return
	}
	// A move chosen for one position must not be played into another. An engine
	// that answers after its game has ended is answering in good faith — the
	// search was already running — but the board it was asked about is gone.
	participant := server.gameParticipant(client, gameID)
	if participant == nil {
		server.releaseBotMove(client, gameID)
		return
	}
	pause := server.botMovePace() - time.Since(askedAt)
	if pause <= 0 {
		server.playBotMove(client, gameID, from, to, bestmove)
		return
	}
	// Stopped before anything waits on it, so that the engine is charged for
	// the thinking it did and the wait is charged to nobody. An engine that had
	// already run out of time while it thought loses the game rather than the
	// pause: the same ending `makeMove` would have reached below.
	if state, expired := participant.session.game.HoldClock(pause); expired {
		server.releaseBotMove(client, gameID)
		server.finishSession(participant.session, state)
		return
	}
	// On its own goroutine because this one is the engine's socket being read.
	// Nothing else it sends can be dealt with while this function runs, and a
	// connection that cannot be read is a connection that cannot be seen to
	// have dropped.
	go func() {
		time.Sleep(pause)
		server.playBotMove(client, gameID, from, to, bestmove)
	}()
}

// botMovePace is how long a game an engine is playing leaves between moves.
func (server *Server) botMovePace() time.Duration {
	if server.movePaceOverride > 0 {
		return server.movePaceOverride
	}
	return botMoveInterval
}

// playBotMove plays a move an engine has already chosen and answers a refusal
// on its behalf.
//
// A refused move must be answered here. `makeMove` replies `move_rejected` and
// stops, which is right for a person — their client shows the error and they
// try again — but a bot has no such loop, so the game would sit there looking
// alive until the engine flagged. One retry covers a garbled reply; a second
// refusal is the engine disagreeing with the rules, and is a fault.
func (server *Server) playBotMove(
	client *Client,
	gameID string,
	from game.Position,
	to game.Position,
	bestmove string,
) {
	// Asked again, because a paced move waited and a game can end in the wait:
	// an opponent resigns, a clock runs out, a series seats the next pair.
	if server.gameParticipant(client, gameID) == nil {
		server.releaseBotMove(client, gameID)
		return
	}
	// Deliberately the same entry point a person's move takes, so a bot cannot
	// reach a code path with different rules.
	if server.makeMove(client, from, to) {
		// Released once the move is on the board and not a moment before. The
		// board is what a prompt reads, so an engine let go of while its move
		// is still on its way there can be asked for that move a second time --
		// and the second copy arrives out of turn. Releasing after makeMove is
		// safe for the opposite reason: what it prompts on the way out is the
		// opponent, and this hold is only ever read against this engine.
		server.releaseBotMove(client, gameID)
		client.bot.mu.Lock()
		client.bot.retriedGameID = ""
		client.bot.mu.Unlock()
		return
	}
	// Before the retry rather than after, this function's whole purpose from
	// here being to ask the same engine again.
	server.releaseBotMove(client, gameID)
	server.retryOrFault(client, gameID, "the engine played "+bestmove+", which is not legal here")
}

// retryOrFault asks the engine once more for the same position, then gives up.
func (server *Server) retryOrFault(client *Client, gameID string, reason string) {
	// Whatever it said is dealt with, and this function's whole purpose is to
	// ask again. See releaseBotMove.
	server.releaseBotMove(client, gameID)
	client.bot.mu.Lock()
	alreadyRetried := client.bot.retriedGameID == gameID
	client.bot.retriedGameID = gameID
	client.bot.mu.Unlock()

	if alreadyRetried {
		server.faultBot(client, gameID, reason)
		return
	}
	participant := server.gameParticipant(client, gameID)
	if participant == nil {
		return
	}
	server.notifyBotOwner(client, gameID, reason+". Asking again.")
	server.promptBot(participant.session, participant.session.game.Snapshot())
}

// gameParticipant returns a client's seat in one named game, and nothing at all
// if it has moved on to another.
//
// Every consumer of an exchange goes through here rather than through
// `participantFor`. An exchange names the game it was asked about, and by the
// time it is answered — or given up on — the engine may be sitting in a
// different game entirely: a series seats the next one three quarters of a
// second after the last one ends. Resolving the seat by client alone lands the
// answer on whatever board is in front of the bot now, which is how a question
// about a finished game came to end the one after it.
func (server *Server) gameParticipant(client *Client, gameID string) *Participant {
	participant := server.participantFor(client)
	if participant == nil || participant.session.gameID != gameID {
		return nil
	}
	return participant
}

// faultBot ends a bot's game when its engine misbehaves.
//
// Abandonment rather than a new end reason: `applyRecordedEnd` can only
// reproduce resignation, draw agreement, and abandonment as actions, so a
// reason outside that set would make every affected record fail replay and
// break the archive's central invariant. It is also honest — the engine
// stopped playing. The diagnosis goes to the owner instead, where it is
// actionable.
//
// The game is named rather than looked up from the client, and that is the
// whole of it being honest: a fault ends the game it happened in or no game at
// all. A handshake fault names no game and so ends none, which is right — an
// engine that cannot say `readyok` has not lost anything yet.
func (server *Server) faultBot(client *Client, gameID string, reason string) {
	// Nothing is owed on a move that ends the game it was given in. See
	// releaseBotMove.
	server.releaseBotMove(client, gameID)
	log.Printf("bot fault (%s): %s", gameID, reason)
	server.notifyBotOwner(client, gameID, reason)

	participant := server.gameParticipant(client, gameID)
	if participant == nil {
		return
	}
	state, err := participant.session.game.Abandon(participant.color)
	if err != nil {
		return
	}
	if state.Status == game.Finished {
		server.finishSession(participant.session, state)
		return
	}
	server.broadcastGameState(participant.session, state)
}

// notifyBotOwner tells the human who runs a bot that it broke, on whichever
// connections they have open.
func (server *Server) notifyBotOwner(client *Client, gameID string, reason string) {
	if !client.isBot() {
		return
	}
	client.bot.mu.Lock()
	owner := client.bot.record.OwnerUserID
	name := client.bot.record.Name
	client.bot.mu.Unlock()

	message := ServerMessage{
		Type:    "bot_fault",
		GameID:  gameID,
		BotName: name,
		Message: reason,
	}
	for _, candidate := range server.connectedClients() {
		if !candidate.isBot() && candidate.profile.UserID == owner {
			candidate.Send(message)
		}
	}
	client.Send(message)
}

// retireBotExchanges voids any question still outstanding in a game that has
// just ended.
//
// Only one exchange is in flight per engine, so one left behind by a finished
// game is not merely stale — it is a gag. `ask` drops the next game's
// `newgame` as a duplicate, the engine is never told it has a new board, and
// the leftover question sits there until it times out. Its own game is beyond
// caring; the game the bot is in by then is not.
//
// This is what makes the game-scoped checks elsewhere a second line rather than
// the only one: those keep a leftover question from doing damage, and this
// keeps the engine from going silent for a whole game first.
func (server *Server) retireBotExchanges(session *GameSession) {
	for _, client := range server.sessionSeats(session) {
		if !client.isBot() {
			continue
		}
		client.bot.mu.Lock()
		if client.bot.pending != nil && client.bot.pending.gameID == session.gameID {
			// The engine may still answer this. `sequence` is what makes that
			// safe: the reply matches nothing and is discarded.
			client.bot.pending = nil
		}
		client.bot.mu.Unlock()
	}
}

// expireBotExchanges gives up on engines that have stopped answering.
//
// Runs on the existing lobby ticker rather than a timer per exchange: a
// handful of bots at a two-second granularity is plenty, and it avoids a
// goroutine per move.
func (server *Server) expireBotExchanges(now time.Time) {
	for _, client := range server.allBotConnections() {
		client.bot.mu.Lock()
		pending := client.bot.pending
		expired := pending != nil && now.After(pending.deadline)
		if expired {
			client.bot.pending = nil
		}
		client.bot.mu.Unlock()
		if expired {
			server.faultBot(client, pending.gameID, "the engine did not answer in time")
		}
	}
}
