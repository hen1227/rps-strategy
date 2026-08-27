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
	// clientVersion is the rpsbot.py this bot is running, for the roster and
	// for the owner to see when something misbehaves.
	clientVersion    string
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
	// socket does — see bot_shutdown.go.
	drain *botDrain
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
	BotID         string              `json:"botId"`
	UserID        string              `json:"userId"`
	Name          string              `json:"name"`
	OwnerUsername string              `json:"ownerUsername,omitempty"`
	Description   string              `json:"description,omitempty"`
	EngineName    string              `json:"engineName,omitempty"`
	EngineAuthor  string              `json:"engineAuthor,omitempty"`
	Modes         []game.ModeID       `json:"modes,omitempty"`
	Elo           int                 `json:"elo"`
	ModeRatings   map[game.ModeID]int `json:"modeRatings,omitempty"`
	// IconSHA256 is empty for a bot with no picture, which is every bot whose
	// owner has not given it one. See persistence.Bot.IconSHA256.
	IconSHA256      string `json:"iconSha256,omitempty"`
	Busy            bool   `json:"busy"`
	AllowPublicPlay bool   `json:"allowPublicPlay"`
	ClientVersion   string `json:"clientVersion,omitempty"`
	// Draining is an engine on its way out: it is playing what it already owes
	// and will take nothing new. Published rather than merely enforced, so the
	// lobby says "shutting down" instead of offering a button that refuses.
	Draining bool `json:"draining,omitempty"`
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

	bot, err := server.data.ClaimBot(ctx, message.Token, persistence.BotSettings{
		Name:             strings.TrimSpace(message.Name),
		Description:      strings.TrimSpace(message.Description),
		AllowPublicPlay:  message.PublicPlay,
		EnterTournaments: message.EnterTournaments,
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
			upgradeAvailable: upgradeAvailable,
			publicBase:       publicBase,
			iconWarning:      iconWarning,
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

// registerBot puts a connected bot in the directory, displacing any earlier
// connection holding the same bot id.
//
// Two processes running one token is a configuration mistake, usually a
// forgotten terminal. Displacing follows what a reconnecting player already
// does and beats the alternative, which is two engines answering for one bot.
func (server *Server) registerBot(client *Client) {
	server.mu.Lock()
	previous := server.bots[client.bot.botID]
	server.bots[client.bot.botID] = client
	server.mu.Unlock()

	if previous != nil && previous != client {
		previous.Send(ServerMessage{
			Type:    "bot_rejected",
			Message: "this bot connected from somewhere else",
		})
		previous.close()
	}
	server.broadcastBots()
}

func (server *Server) unregisterBot(client *Client) {
	if !client.isBot() {
		return
	}
	// A series with one engine left in it is not a series.
	server.abortSeriesForBot(client.bot.botID)
	server.mu.Lock()
	if server.bots[client.bot.botID] == client {
		delete(server.bots, client.bot.botID)
	}
	server.mu.Unlock()
	server.broadcastBots()
}

// botRoster is the published list of engines available right now.
func (server *Server) botRoster() []BotPresence {
	server.mu.RLock()
	clients := make([]*Client, 0, len(server.bots))
	for _, client := range server.bots {
		clients = append(clients, client)
	}
	busy := make(map[*Client]bool, len(clients))
	for _, client := range clients {
		_, playing := server.participants[client]
		busy[client] = playing
	}
	server.mu.RUnlock()

	draining := make(map[*Client]bool, len(clients))
	for _, client := range clients {
		draining[client] = botIsDraining(client)
	}

	roster := make([]BotPresence, 0, len(clients))
	for _, client := range clients {
		client.bot.mu.Lock()
		record := client.bot.record
		handshake := client.bot.handshake
		ready := client.bot.ready
		clientVersion := client.bot.clientVersion
		client.bot.mu.Unlock()
		if !ready {
			// A bot that has not finished its handshake cannot be challenged
			// yet, so listing it would only produce failures.
			continue
		}
		presence := BotPresence{
			BotID:           record.BotID,
			UserID:          record.UserID,
			Name:            record.Name,
			Description:     record.Description,
			EngineName:      handshake.Name,
			EngineAuthor:    handshake.Author,
			Modes:           handshake.Modes,
			Elo:             client.account.Elo,
			Busy:            busy[client],
			Draining:        draining[client],
			AllowPublicPlay: record.AllowPublicPlay,
			ClientVersion:   clientVersion,
			IconSHA256:      record.IconSHA256,
		}
		if len(client.account.ModeRatings) > 0 {
			presence.ModeRatings = make(map[game.ModeID]int, len(client.account.ModeRatings))
			for modeID, rating := range client.account.ModeRatings {
				presence.ModeRatings[modeID] = rating.Elo
			}
		}
		roster = append(roster, presence)
	}
	return roster
}

func (server *Server) broadcastBots() {
	server.broadcastToClients(ServerMessage{Type: "engine_bots", EngineBots: server.botRoster()})
}

// botClientFor returns the connected client for a bot account, if any.
func (server *Server) botClientFor(userID string) *Client {
	server.mu.RLock()
	defer server.mu.RUnlock()
	for _, client := range server.bots {
		if client.profile.UserID == userID {
			return client
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
	if bot.pending != nil {
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
	bot.pending = nil
	bot.mu.Unlock()

	if message.Type == "engine_error" {
		server.faultBot(client, pending.gameID, message.Reason)
		return
	}
	pending.onReply(message.Lines)
}

// beginBotHandshake runs `rpsi` then `isready`, then publishes the bot.
func (server *Server) beginBotHandshake(client *Client) {
	server.ask(client, "", []string{"rpsi"}, "rpsiok", botHandshakeTimeout, func(lines []string) {
		handshake := rpsi.ParseHandshake(lines)
		client.bot.mu.Lock()
		client.bot.handshake = handshake
		botID := client.bot.botID
		client.bot.mu.Unlock()

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
				Name:   handshake.Name,
				Author: handshake.Author,
				Modes:  handshake.Modes,
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
				client.Send(ready)
				server.broadcastBots()
			})
	})
}

// beginBotGame tells every engine in a session that a new game has started,
// then asks whichever of them moves first.
//
// `newgame` and `isready` travel together: the second is where UCI allows an
// engine to do slow setup, so waiting for `readyok` before the clock matters
// is the difference between a fair first move and one searched while the
// transposition table was still being allocated.
func (server *Server) beginBotGame(session *GameSession) {
	for _, client := range []*Client{session.redClient, session.blueClient} {
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

	server.mu.RLock()
	botClientConn := server.bots[botID]
	server.mu.RUnlock()
	if botClientConn == nil {
		refuse("that bot is not online")
		return
	}

	botClientConn.bot.mu.Lock()
	record := botClientConn.bot.record
	handshake := botClientConn.bot.handshake
	ready := botClientConn.bot.ready
	botClientConn.bot.mu.Unlock()

	if !ready {
		refuse("that bot is still starting up")
		return
	}
	if !record.AllowPublicPlay {
		refuse("that bot is not open to challenges")
		return
	}
	if botIsDraining(botClientConn) {
		refuse(record.Name + " is shutting down and is not taking new games")
		return
	}
	if !handshake.Supports(modeID) {
		refuse(record.Name + " does not play that mode")
		return
	}
	if server.participantFor(botClientConn) != nil {
		refuse(record.Name + " is already playing a game")
		return
	}

	server.releaseFromLobby(client)
	// Unranked: an engine must never move a person's rating, which is what
	// keeps the bot ladder and the human ladder separate without any extra
	// machinery.
	setup := game.GameSetup{ModeID: modeID, TimeControl: control, Casual: true}
	human := QueueEntry{
		Client:   client,
		Setup:    setup,
		Elo:      matchmakingElo(client, modeID),
		JoinedAt: time.Now(),
	}
	engine := QueueEntry{
		Client:   botClientConn,
		Setup:    setup,
		Elo:      matchmakingElo(botClientConn, modeID),
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
	session := server.startConfiguredMatch(first, second, matchSetup{})
	if session == nil {
		return
	}
	server.broadcastBots()
}

// promptBot asks the engine for a move, if it is its turn and nothing is
// already in flight.
//
// Called after every change to a game a bot is in. It is safe to call
// redundantly: `ask` drops a second question while one is outstanding, and the
// turn check drops it when it is the opponent's move.
func (server *Server) promptBot(session *GameSession, state game.GameState) {
	if state.Status != game.InProgress {
		return
	}
	var client *Client
	switch state.CurrentTurn {
	case game.Red:
		client = session.redClient
	case game.Blue:
		client = session.blueClient
	default:
		return
	}
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

	gameID := session.gameID
	server.ask(client, gameID, lines, "bestmove", timeout, func(lines []string) {
		server.applyBotMove(client, gameID, lines)
	})
}

// applyBotMove plays the move an engine returned.
//
// A refused move must be answered here. `makeMove` replies `move_rejected` and
// stops, which is right for a person — their client shows the error and they
// try again — but a bot has no such loop, so the game would sit there looking
// alive until the engine flagged. One retry covers a garbled reply; a second
// refusal is the engine disagreeing with the rules, and is a fault.
func (server *Server) applyBotMove(client *Client, gameID string, lines []string) {
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
	if server.gameParticipant(client, gameID) == nil {
		return
	}
	// Deliberately the same entry point a person's move takes, so a bot cannot
	// reach a code path with different rules.
	if server.makeMove(client, from, to) {
		client.bot.mu.Lock()
		client.bot.retriedGameID = ""
		client.bot.mu.Unlock()
		return
	}
	server.retryOrFault(client, gameID, "the engine played "+bestmove+", which is not legal here")
}

// retryOrFault asks the engine once more for the same position, then gives up.
func (server *Server) retryOrFault(client *Client, gameID string, reason string) {
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
	server.notifyBotOwner(client, gameID, reason+" — asking again")
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
	for _, client := range []*Client{session.redClient, session.blueClient} {
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
	server.mu.RLock()
	clients := make([]*Client, 0, len(server.bots))
	for _, client := range server.bots {
		clients = append(clients, client)
	}
	server.mu.RUnlock()

	for _, client := range clients {
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
