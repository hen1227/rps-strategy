package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

type GameSession struct {
	gameID             string
	modeID             game.ModeID
	game               *game.Game
	redClient          *Client
	blueClient         *Client
	redElo             int
	blueElo            int
	spectators         map[*Client]struct{}
	chatMessages       []ChatMessage
	redDisconnectedAt  time.Time
	blueDisconnectedAt time.Time
	startedAt          time.Time
	ranked             bool
	tournament         *tournamentMatchRef
	closeOnce          sync.Once
}

type CompletedGame struct {
	state     game.GameState
	expiresAt time.Time
}

const (
	reconnectGracePeriod   = 30 * time.Second
	completedGameRetention = 30 * time.Second
	authenticationTimeout  = 10 * time.Second
	maximumChatRunes       = 300
	maximumChatHistory     = 100
	challengeLifetime      = 10 * time.Minute
	maximumPendingPerName  = 10
)

type Participant struct {
	session *GameSession
	color   game.PlayerColor
}

type Server struct {
	hub            *Hub
	matchmaking    *MatchmakingQueue
	registry       *game.ModeRegistry
	data           *persistence.Store
	upgrader       websocket.Upgrader
	originAllowed  func(*http.Request) bool
	adminTokenHash [sha256.Size]byte
	adminEnabled   bool

	mu             sync.RWMutex
	participants   map[*Client]Participant
	games          map[string]*GameSession
	completedGames map[string]CompletedGame
	spectating     map[*Client]*GameSession
	challenges     map[string]*pendingChallenge
	// A finished game leaves the lobby immediately but stays addressable as a
	// chat room, so the people who were in it can keep talking. Its members
	// move out of participants and spectating into postGameMembers, and the
	// room closes as soon as the last of them leaves or disconnects.
	postGameRooms   map[string]*GameSession
	postGameMembers map[*Client]Participant
	// Scheduled tournament matches waiting for both players, then playing out
	// in an ordinary game session.
	tournamentReady map[tournamentMatchKey]map[string]struct{}
	tournamentGames map[tournamentMatchKey]*GameSession
	// Players practising against a client-side bot. The board itself never
	// reaches the server; this is presence only, so the lobby can say how many
	// people are busy with bots and a bot player can still be told that a real
	// opponent is waiting.
	botSessions map[*Client]botSession
}

// botSession is what the server knows about a bot game: who is playing one,
// in which mode, and since when.
type botSession struct {
	modeID    game.ModeID
	startedAt time.Time
}

func New(allowedOrigins []string) *Server {
	return NewWithRegistry(game.DefaultModeRegistry, allowedOrigins)
}

func NewWithRegistry(registry *game.ModeRegistry, allowedOrigins []string) *Server {
	data, err := persistence.Open(":memory:")
	if err != nil {
		panic(fmt.Sprintf("initialize in-memory persistence: %v", err))
	}
	return NewWithRegistryAndStore(registry, data, allowedOrigins)
}

func NewWithStore(data *persistence.Store, allowedOrigins []string) *Server {
	return NewWithRegistryAndStore(game.DefaultModeRegistry, data, allowedOrigins)
}

func NewWithStoreAndAdminToken(
	data *persistence.Store,
	allowedOrigins []string,
	adminToken string,
) *Server {
	server := NewWithRegistryAndStore(game.DefaultModeRegistry, data, allowedOrigins)
	server.setAdminToken(adminToken)
	return server
}

func NewWithRegistryAndStore(
	registry *game.ModeRegistry,
	data *persistence.Store,
	allowedOrigins []string,
) *Server {
	if data == nil {
		panic("server persistence store is required")
	}
	originAllowed := originChecker(allowedOrigins)
	server := &Server{
		hub:            NewHub(),
		registry:       registry,
		data:           data,
		originAllowed:  originAllowed,
		participants:   make(map[*Client]Participant),
		games:          make(map[string]*GameSession),
		completedGames: make(map[string]CompletedGame),
		spectating:     make(map[*Client]*GameSession),
		challenges:     make(map[string]*pendingChallenge),

		postGameRooms:   make(map[string]*GameSession),
		postGameMembers: make(map[*Client]Participant),

		tournamentReady: make(map[tournamentMatchKey]map[string]struct{}),
		tournamentGames: make(map[tournamentMatchKey]*GameSession),

		botSessions: make(map[*Client]botSession),
	}
	server.matchmaking = NewMatchmakingQueue(server.startMatch)
	server.upgrader = websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		CheckOrigin:     originAllowed,
	}
	return server
}

func (server *Server) Run(ctx context.Context) {
	go server.matchmaking.Run(ctx)
	lobbyTicker := time.NewTicker(matchmakingTick)
	clockTicker := time.NewTicker(100 * time.Millisecond)
	defer lobbyTicker.Stop()
	defer clockTicker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-lobbyTicker.C:
			server.broadcastQueueStatus(now)
			server.expireChallenges(now)
		case now := <-clockTicker.C:
			server.expireGames(now)
		}
	}
}

func (server *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /api/modes", func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(server.registry.Definitions())
	})
	mux.HandleFunc("GET /api/accounts/{userID}", server.getAccount)
	mux.HandleFunc("PATCH /api/accounts/{userID}", server.updateAccount)
	mux.HandleFunc("GET /api/accounts/{userID}/games", server.getGameHistory)
	mux.HandleFunc("GET /api/accounts/{userID}/games/pgn", server.getAccountGamePGNs)
	mux.HandleFunc("GET /api/games/{gameID}/pgn", server.getGamePGN)
	mux.HandleFunc(
		"GET /api/accounts/{userID}/record/{opponentID}",
		server.getHeadToHeadRecord,
	)
	mux.HandleFunc("GET /api/tournaments", server.getTournaments)
	mux.HandleFunc("GET /api/tournaments/{tournamentID}", server.getTournament)
	mux.HandleFunc(
		"POST /api/tournaments/{tournamentID}/signups",
		server.signupForTournament,
	)
	mux.HandleFunc("GET /api/admin/session", server.adminOnly(server.getAdminSession))
	mux.HandleFunc("GET /api/admin/games/pgn", server.adminOnly(server.exportGamePGNs))
	mux.HandleFunc(
		"POST /api/admin/tournaments",
		server.adminOnly(server.createTournament),
	)
	mux.HandleFunc(
		"POST /api/admin/tournaments/{tournamentID}/start",
		server.adminOnly(server.startTournament),
	)
	mux.HandleFunc(
		"PATCH /api/admin/tournaments/{tournamentID}/matches/{matchID}",
		server.adminOnly(server.updateTournamentMatch),
	)
	mux.HandleFunc("GET /ws", server.handleWebSocket)
	return server.withCORS(mux)
}

func (server *Server) setAdminToken(token string) {
	token = strings.TrimSpace(token)
	server.adminEnabled = token != ""
	server.adminTokenHash = sha256.Sum256([]byte(token))
}

func (server *Server) hasValidAdminToken(request *http.Request) bool {
	authorization := strings.TrimSpace(request.Header.Get("Authorization"))
	scheme, token, found := strings.Cut(authorization, " ")
	if !found || !strings.EqualFold(scheme, "Bearer") || strings.TrimSpace(token) == "" {
		return false
	}
	return server.hasValidAdminTokenValue(token)
}

func (server *Server) hasValidAdminTokenValue(token string) bool {
	if !server.adminEnabled || strings.TrimSpace(token) == "" {
		return false
	}
	providedHash := sha256.Sum256([]byte(strings.TrimSpace(token)))
	return subtle.ConstantTimeCompare(
		server.adminTokenHash[:],
		providedHash[:],
	) == 1
}

func usesReservedIdentity(username string, discord string) bool {
	for _, value := range []string{username, discord} {
		value = strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(value), "@"))
		if strings.EqualFold(value, "Henhen1227") || strings.EqualFold(value, "webgoatguy") {
			return true
		}
	}
	return false
}

func (server *Server) adminOnly(next http.HandlerFunc) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		if !server.adminEnabled {
			writeAPIError(writer, http.StatusServiceUnavailable, "admin commands are not configured")
			return
		}
		if !server.hasValidAdminToken(request) {
			writer.Header().Set("WWW-Authenticate", `Bearer realm="tournament-admin"`)
			writeAPIError(writer, http.StatusUnauthorized, "invalid admin token")
			return
		}
		next(writer, request)
	}
}

func (server *Server) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		origin := request.Header.Get("Origin")
		if origin != "" && server.originAllowed(request) {
			writer.Header().Set("Access-Control-Allow-Origin", origin)
			writer.Header().Add("Vary", "Origin")
			writer.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS")
			writer.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			if request.Method == http.MethodOptions {
				writer.WriteHeader(http.StatusNoContent)
				return
			}
		} else if request.Method == http.MethodOptions {
			writeAPIError(writer, http.StatusForbidden, "origin is not allowed")
			return
		}
		next.ServeHTTP(writer, request)
	})
}

func (server *Server) handleWebSocket(writer http.ResponseWriter, request *http.Request) {
	connection, err := server.upgrader.Upgrade(writer, request, nil)
	if err != nil {
		log.Printf("websocket upgrade: %v", err)
		return
	}
	connection.SetReadLimit(maxMessage)
	_ = connection.SetReadDeadline(time.Now().Add(authenticationTimeout))
	var authentication ClientMessage
	if err := connection.ReadJSON(&authentication); err != nil ||
		authentication.Type != "authenticate" {
		_ = connection.WriteJSON(ServerMessage{
			Type:    "authentication_failed",
			Message: "send the local account key before using online play",
		})
		_ = connection.Close()
		return
	}
	account, err := server.data.EnsureAccountWithProfileKey(
		request.Context(),
		authentication.UserID,
		"Guest",
		authentication.ProfileKey,
	)
	if err != nil {
		_ = connection.WriteJSON(ServerMessage{
			Type:    "authentication_failed",
			Message: "this device's local account key does not match the account",
		})
		_ = connection.Close()
		return
	}
	profile := game.PlayerProfile{
		UserID:   account.UserID,
		Username: account.Username,
		Discord:  account.Discord,
	}

	client := &Client{
		connection: connection,
		send:       make(chan []byte, 32),
		done:       make(chan struct{}),
		profile:    profile,
		account:    account,
		server:     server,
	}
	server.hub.Register(client)
	defaultTimeControl := game.DefaultTimeControl()
	client.Send(ServerMessage{
		Type:               "connection_ready",
		Modes:              server.registry.Definitions(),
		ModePlayerCounts:   server.modePlayerCounts(),
		ModeQueueCounts:    server.matchmaking.PlayerCountsByMode(),
		BotPlayerCount:     server.botPlayerCount(),
		LiveGames:          server.liveGames(),
		Tournaments:        server.tournamentSnapshots(request.Context()),
		Challenges:         server.pendingChallengesFor(client, time.Now()),
		Account:            &account,
		DefaultTimeControl: &defaultTimeControl,
	})
	go client.writePump()
	client.readPump()
}

func (server *Server) handleMessage(client *Client, message ClientMessage) {
	switch message.Type {
	case "send_challenge":
		server.sendChallenge(client, message.Username, message.ModeID, message.TimeControl)
	case "accept_challenge":
		server.acceptChallenge(client, message.ChallengeID)
	case "decline_challenge":
		server.declineChallenge(client, message.ChallengeID)
	case "cancel_challenge":
		server.cancelChallenge(client, message.ChallengeID)
	case "join_queue":
		if server.hasOutgoingChallenge(client) {
			client.Send(ServerMessage{Type: "error", Message: "cancel your pending challenge before joining matchmaking"})
			return
		}
		if !server.registry.Has(message.ModeID) {
			client.Send(ServerMessage{Type: "error", Message: "invalid game mode"})
			return
		}
		if !server.registry.Playable(message.ModeID) {
			client.Send(ServerMessage{Type: "error", Message: "that game mode is no longer open for new matches"})
			return
		}
		timeControl := game.DefaultTimeControl()
		if message.TimeControl != nil {
			timeControl = *message.TimeControl
		}
		if err := timeControl.Validate(); err != nil {
			client.Send(ServerMessage{Type: "error", Message: err.Error()})
			return
		}
		if server.participantFor(client) != nil {
			client.Send(ServerMessage{Type: "error", Message: "player is already in a game"})
			return
		}
		if server.spectatorFor(client) != nil {
			client.Send(ServerMessage{Type: "error", Message: "stop spectating before joining matchmaking"})
			return
		}
		entry := server.matchmaking.AddWithTimeControl(client, message.ModeID, timeControl)
		client.Send(ServerMessage{
			Type:        "queue_update",
			ModeID:      message.ModeID,
			TimeControl: &entry.TimeControl,
			SearchRange: entry.SearchRange(time.Now()),
		})
		server.broadcastModePlayerCounts()
	case "leave_queue":
		server.matchmaking.Remove(client)
		client.Send(ServerMessage{Type: "queue_left"})
		server.broadcastModePlayerCounts()
	case "bot_session_start":
		// A bot game is played entirely in the browser, so the only thing to
		// validate is the mode it claims to be practising.
		if !server.registry.Has(message.ModeID) {
			client.Send(ServerMessage{Type: "error", Message: "invalid game mode"})
			return
		}
		server.startBotSession(client, message.ModeID)
	case "bot_session_end":
		server.endBotSession(client)
	case "rejoin_game":
		server.rejoinGame(client, message.GameID)
	case "spectate_game":
		if server.hasOutgoingChallenge(client) {
			client.Send(ServerMessage{Type: "spectate_unavailable", Message: "cancel your pending challenge before spectating"})
			return
		}
		server.spectateGame(client, message.GameID)
	case "stop_spectating":
		server.stopSpectating(client, true)
	case "leave_game":
		server.leaveGame(client)
	case "tournament_ready":
		server.readyForTournamentMatch(client, message.TournamentID, message.MatchID)
	case "tournament_withdraw":
		server.withdrawFromTournamentMatch(client, message.TournamentID, message.MatchID)
	case "send_chat":
		server.sendChat(client, message.Text)
	case "make_move":
		server.makeMove(client, message.From, message.To)
	case "request_moves":
		server.sendValidMoves(client, message.From)
	case "offer_draw":
		server.offerDraw(client)
	case "accept_draw":
		server.acceptDraw(client)
	case "decline_draw":
		server.declineDraw(client)
	case "offer_time":
		server.offerTimeExtension(client)
	case "accept_time":
		server.acceptTimeExtension(client)
	case "decline_time":
		server.declineTimeExtension(client)
	case "resign_game":
		server.resign(client)
	default:
		client.Send(ServerMessage{Type: "error", Message: "unknown message type"})
	}
}

func (server *Server) spectateGame(client *Client, gameID string) {
	gameID = strings.TrimSpace(gameID)
	if gameID == "" {
		client.Send(ServerMessage{Type: "spectate_unavailable", Message: "missing game session id"})
		return
	}
	if server.participantFor(client) != nil {
		client.Send(ServerMessage{Type: "spectate_unavailable", Message: "players cannot spectate during a game"})
		return
	}
	if _, queued := server.matchmaking.Status(client); queued {
		client.Send(ServerMessage{Type: "spectate_unavailable", Message: "leave matchmaking before spectating"})
		return
	}
	server.leaveRoom(client)

	changed := false
	server.mu.Lock()
	session, ok := server.games[gameID]
	if !ok {
		server.mu.Unlock()
		client.Send(ServerMessage{Type: "spectate_unavailable", Message: "that game is no longer live"})
		return
	}
	state := session.game.Snapshot()
	if colorForUser(state, client.profile.UserID) != game.Neutral {
		server.mu.Unlock()
		client.Send(ServerMessage{Type: "spectate_unavailable", Message: "rejoin your game instead of spectating it"})
		return
	}
	if previous := server.spectating[client]; previous != nil && previous != session {
		delete(previous.spectators, client)
		changed = true
	}
	if session.spectators == nil {
		session.spectators = make(map[*Client]struct{})
	}
	if _, alreadyWatching := session.spectators[client]; !alreadyWatching {
		session.spectators[client] = struct{}{}
		changed = true
	}
	server.spectating[client] = session
	history := append([]ChatMessage(nil), session.chatMessages...)
	server.mu.Unlock()

	client.Send(ServerMessage{
		Type:         "spectator_joined",
		Color:        game.Neutral,
		GameState:    &state,
		ChatMessages: history,
	})
	if changed {
		server.broadcastLiveGames()
	}
}

func (server *Server) stopSpectating(client *Client, notify bool) {
	server.mu.Lock()
	session := server.spectating[client]
	if session != nil {
		delete(server.spectating, client)
		delete(session.spectators, client)
	}
	server.mu.Unlock()

	if session == nil {
		return
	}
	if notify {
		client.Send(ServerMessage{Type: "spectator_left"})
	}
	server.broadcastLiveGames()
}

// leaveGame is the client's way of saying it has navigated away from a game.
// It covers a spectator watching a live game and anyone still sitting in a
// finished game's chat room.
func (server *Server) leaveGame(client *Client) {
	if server.leaveRoom(client) {
		return
	}
	server.stopSpectating(client, false)
}

// leaveRoom drops a client out of a finished game's chat room and reports
// whether it was in one. The room closes behind the last member so a finished
// session is not retained for a browser tab nobody is looking at.
func (server *Server) leaveRoom(client *Client) bool {
	server.mu.Lock()
	defer server.mu.Unlock()
	return server.leaveRoomLocked(client)
}

func (server *Server) leaveRoomLocked(client *Client) bool {
	member, ok := server.postGameMembers[client]
	if !ok {
		return false
	}
	delete(server.postGameMembers, client)
	session := member.session
	switch member.color {
	case game.Red:
		if session.redClient == client {
			session.redClient = nil
		}
	case game.Blue:
		if session.blueClient == client {
			session.blueClient = nil
		}
	default:
		delete(session.spectators, client)
	}
	if session.redClient == nil && session.blueClient == nil && len(session.spectators) == 0 {
		if current, found := server.postGameRooms[session.gameID]; found && current == session {
			delete(server.postGameRooms, session.gameID)
		}
	}
	return true
}

// chatSeatLocked resolves the game a client may chat in, which is either the
// live game it is playing or watching, or the chat room of a finished game it
// has not left yet.
func (server *Server) chatSeatLocked(
	client *Client,
) (*GameSession, string, game.PlayerColor) {
	if participant, ok := server.participants[client]; ok {
		if server.games[participant.session.gameID] == participant.session {
			return participant.session, "player", participant.color
		}
		return nil, "", ""
	}
	if watched := server.spectating[client]; watched != nil {
		if server.games[watched.gameID] == watched {
			return watched, "spectator", ""
		}
		return nil, "", ""
	}
	member, ok := server.postGameMembers[client]
	if !ok || server.postGameRooms[member.session.gameID] != member.session {
		return nil, "", ""
	}
	if member.color == game.Neutral {
		return member.session, "spectator", ""
	}
	return member.session, "player", member.color
}

func (server *Server) sendChat(client *Client, text string) {
	text = strings.TrimSpace(text)
	if text == "" {
		client.Send(ServerMessage{Type: "chat_rejected", Message: "chat messages cannot be empty"})
		return
	}
	if !utf8.ValidString(text) || utf8.RuneCountInString(text) > maximumChatRunes {
		client.Send(ServerMessage{
			Type:    "chat_rejected",
			Message: fmt.Sprintf("chat messages must be at most %d characters", maximumChatRunes),
		})
		return
	}
	messageID, err := randomID()
	if err != nil {
		client.Send(ServerMessage{Type: "chat_rejected", Message: "could not send chat message"})
		return
	}

	server.mu.Lock()
	session, role, color := server.chatSeatLocked(client)
	if session == nil {
		server.mu.Unlock()
		client.Send(ServerMessage{Type: "chat_rejected", Message: "join a game before chatting"})
		return
	}
	senderName := strings.TrimSpace(client.profile.Username)
	if senderName == "" {
		senderName = "Guest"
	}
	chatMessage := ChatMessage{
		ID:           messageID,
		GameID:       session.gameID,
		SenderUserID: client.profile.UserID,
		SenderName:   senderName,
		SenderRole:   role,
		SenderColor:  color,
		Text:         text,
		SentAtUnixMs: time.Now().UnixMilli(),
	}
	session.chatMessages = append(session.chatMessages, chatMessage)
	if len(session.chatMessages) > maximumChatHistory {
		session.chatMessages = append(
			[]ChatMessage(nil),
			session.chatMessages[len(session.chatMessages)-maximumChatHistory:]...,
		)
	}
	server.mu.Unlock()

	server.broadcastToSession(session, ServerMessage{
		Type:        "chat_message",
		ChatMessage: &chatMessage,
	})
}

// takeRoomSeatLocked reseats a returning player in a finished game's chat room
// and reports the stale connection it displaced, if any.
func (server *Server) takeRoomSeatLocked(
	client *Client,
	room *GameSession,
	color game.PlayerColor,
) *Client {
	if member, ok := server.postGameMembers[client]; ok && member.session != room {
		server.leaveRoomLocked(client)
	}
	var replaced *Client
	switch color {
	case game.Red:
		replaced = room.redClient
		room.redClient = client
	case game.Blue:
		replaced = room.blueClient
		room.blueClient = client
	}
	if replaced != nil && replaced != client {
		delete(server.postGameMembers, replaced)
	}
	server.postGameMembers[client] = Participant{session: room, color: color}
	return replaced
}

func (server *Server) rejoinGame(client *Client, gameID string) {
	if strings.TrimSpace(gameID) == "" {
		client.Send(ServerMessage{Type: "game_unavailable", Message: "missing game session id"})
		return
	}

	now := time.Now()
	var oldClient *Client
	var participant Participant
	var opponentDeadline time.Time
	expiredColor := game.Neutral
	var terminalState *game.GameState
	var rejoinState game.GameState
	var chatHistory []ChatMessage
	server.mu.Lock()
	session, ok := server.games[gameID]
	if !ok {
		// A finished game whose chat room is still open readmits its players,
		// so a dropped connection does not cut them out of the conversation.
		if room, open := server.postGameRooms[gameID]; open {
			state := room.game.Snapshot()
			if color := colorForUser(state, client.profile.UserID); color != game.Neutral {
				replaced := server.takeRoomSeatLocked(client, room, color)
				history := append([]ChatMessage(nil), room.chatMessages...)
				server.mu.Unlock()
				client.Send(ServerMessage{
					Type:         "game_rejoined",
					Color:        color,
					GameState:    &state,
					ChatMessages: history,
				})
				if replaced != nil && replaced != client {
					replaced.close()
				}
				return
			}
		}
		completed, found := server.completedGames[gameID]
		if found && now.Before(completed.expiresAt) {
			color := colorForUser(completed.state, client.profile.UserID)
			if color != game.Neutral {
				client.Send(ServerMessage{
					Type:      "game_rejoined",
					Color:     color,
					GameState: &completed.state,
				})
				server.mu.Unlock()
				return
			}
		} else if found {
			delete(server.completedGames, gameID)
		}
		server.mu.Unlock()
		client.Send(ServerMessage{
			Type:    "game_unavailable",
			Message: "that game is no longer available",
		})
		return
	}

	rejoinState = session.game.Snapshot()
	chatHistory = append([]ChatMessage(nil), session.chatMessages...)
	playerColor := colorForUser(rejoinState, client.profile.UserID)
	if playerColor == game.Neutral {
		server.mu.Unlock()
		client.Send(ServerMessage{
			Type:    "game_unavailable",
			Message: "that game is no longer available",
		})
		return
	}
	if rejoinState.Status == game.Finished {
		terminalState = &rejoinState
		client.Send(ServerMessage{
			Type:         "game_rejoined",
			Color:        playerColor,
			GameState:    &rejoinState,
			ChatMessages: chatHistory,
		})
		server.mu.Unlock()
		server.finishSession(session, *terminalState)
		return
	}

	switch playerColor {
	case game.Red:
		if deadline := disconnectDeadline(session.redDisconnectedAt); !deadline.IsZero() &&
			!now.Before(deadline) {
			expiredColor = game.Red
		} else {
			participant = Participant{session: session, color: game.Red}
			oldClient = session.redClient
			session.redClient = client
			session.redDisconnectedAt = time.Time{}
			opponentDeadline = disconnectDeadline(session.blueDisconnectedAt)
		}
	case game.Blue:
		if deadline := disconnectDeadline(session.blueDisconnectedAt); !deadline.IsZero() &&
			!now.Before(deadline) {
			expiredColor = game.Blue
		} else {
			participant = Participant{session: session, color: game.Blue}
			oldClient = session.blueClient
			session.blueClient = client
			session.blueDisconnectedAt = time.Time{}
			opponentDeadline = disconnectDeadline(session.redDisconnectedAt)
		}
	}
	if expiredColor == game.Neutral {
		if oldClient != nil && oldClient != client {
			delete(server.participants, oldClient)
		}
		server.participants[client] = participant
		client.Send(ServerMessage{
			Type:                    "game_rejoined",
			Color:                   participant.color,
			GameState:               &rejoinState,
			ChatMessages:            chatHistory,
			ReconnectDeadlineUnixMs: deadlineUnixMilli(opponentDeadline),
		})
		var opponent *Client
		if participant.color == game.Red {
			opponent = participant.session.blueClient
		} else {
			opponent = participant.session.redClient
		}
		if opponent != nil {
			opponent.Send(ServerMessage{Type: "opponent_reconnected"})
		}
	}
	server.mu.Unlock()

	if expiredColor != game.Neutral {
		if state, err := session.game.Abandon(expiredColor); err == nil {
			server.finishSession(session, state)
		}
		client.Send(ServerMessage{
			Type:    "game_unavailable",
			Message: "that game is no longer available",
		})
		return
	}
	if oldClient != nil && oldClient != client {
		oldClient.close()
	}
}

func colorForUser(state game.GameState, userID string) game.PlayerColor {
	switch userID {
	case state.RedPlayer.UserID:
		return game.Red
	case state.BluePlayer.UserID:
		return game.Blue
	default:
		return game.Neutral
	}
}

func (server *Server) sendValidMoves(client *Client, from game.Position) {
	participant := server.participantFor(client)
	if participant == nil {
		client.Send(ServerMessage{Type: "valid_moves", From: &from, ValidMoves: []game.Position{}})
		return
	}
	moves := participant.session.game.ValidMoves(participant.color, from)
	client.Send(ServerMessage{Type: "valid_moves", From: &from, ValidMoves: moves})
}

func (server *Server) makeMove(client *Client, from, to game.Position) {
	participant := server.participantFor(client)
	if participant == nil {
		client.Send(ServerMessage{Type: "move_rejected", Message: "player is not in a game"})
		return
	}

	state, err := participant.session.game.Move(participant.color, from, to)
	if err != nil {
		if state.Status == game.Finished {
			server.finishSession(participant.session, state)
			return
		}
		client.Send(ServerMessage{Type: "move_rejected", Message: err.Error()})
		return
	}
	if state.Status == game.Finished {
		server.finishSession(participant.session, state)
		return
	}
	server.broadcastGameState(participant.session, state)
}

func (server *Server) offerDraw(client *Client) {
	participant := server.participantFor(client)
	if participant == nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: "player is not in a game"})
		return
	}
	state, err := participant.session.game.OfferDraw(participant.color)
	if err != nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: err.Error()})
		return
	}
	server.broadcastGameState(participant.session, state)
}

func (server *Server) acceptDraw(client *Client) {
	participant := server.participantFor(client)
	if participant == nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: "player is not in a game"})
		return
	}
	state, err := participant.session.game.AcceptDraw(participant.color)
	if err != nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: err.Error()})
		return
	}
	server.finishSession(participant.session, state)
}

func (server *Server) declineDraw(client *Client) {
	participant := server.participantFor(client)
	if participant == nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: "player is not in a game"})
		return
	}
	state, err := participant.session.game.DeclineDraw(participant.color)
	if err != nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: err.Error()})
		return
	}
	server.broadcastGameState(participant.session, state)
}

func (server *Server) offerTimeExtension(client *Client) {
	participant := server.participantFor(client)
	if participant == nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: "player is not in a game"})
		return
	}
	state, err := participant.session.game.OfferTimeExtension(participant.color)
	if err != nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: err.Error()})
		return
	}
	server.broadcastGameState(participant.session, state)
}

func (server *Server) acceptTimeExtension(client *Client) {
	participant := server.participantFor(client)
	if participant == nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: "player is not in a game"})
		return
	}
	state, err := participant.session.game.AcceptTimeExtension(participant.color)
	if err != nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: err.Error()})
		return
	}
	server.broadcastGameState(participant.session, state)
}

func (server *Server) declineTimeExtension(client *Client) {
	participant := server.participantFor(client)
	if participant == nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: "player is not in a game"})
		return
	}
	state, err := participant.session.game.DeclineTimeExtension(participant.color)
	if err != nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: err.Error()})
		return
	}
	server.broadcastGameState(participant.session, state)
}

func (server *Server) resign(client *Client) {
	participant := server.participantFor(client)
	if participant == nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: "player is not in a game"})
		return
	}
	state, err := participant.session.game.Resign(participant.color)
	if err != nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: err.Error()})
		return
	}
	server.finishSession(participant.session, state)
}

// matchSetup describes everything about a new game that is not carried by the
// two queue entries, so ranked matchmaking, private challenges, and tournament
// matches all share one session-creation path.
type matchSetup struct {
	ranked     bool
	tournament *tournamentMatchRef
}

func (server *Server) startMatch(first, second QueueEntry) {
	server.startConfiguredMatch(first, second, matchSetup{ranked: true})
}

func (server *Server) startConfiguredMatch(
	first QueueEntry,
	second QueueEntry,
	setup matchSetup,
) *GameSession {
	gameID, err := randomID()
	if err != nil {
		first.Client.Send(ServerMessage{Type: "error", Message: "could not create game"})
		second.Client.Send(ServerMessage{Type: "error", Message: "could not create game"})
		return nil
	}
	newGame, err := game.NewGameWithRegistryAndTimeControl(
		server.registry,
		gameID,
		first.ModeID,
		first.Client.profile,
		second.Client.profile,
		first.TimeControl,
	)
	if err != nil {
		first.Client.Send(ServerMessage{Type: "error", Message: err.Error()})
		second.Client.Send(ServerMessage{Type: "error", Message: err.Error()})
		return nil
	}

	server.leaveRoom(first.Client)
	server.leaveRoom(second.Client)

	session := &GameSession{
		gameID:     gameID,
		modeID:     first.ModeID,
		game:       newGame,
		redClient:  first.Client,
		blueClient: second.Client,
		redElo:     first.Elo,
		blueElo:    second.Elo,
		spectators: make(map[*Client]struct{}),
		startedAt:  time.Now(),
		ranked:     setup.ranked,
		tournament: setup.tournament,
	}
	server.mu.Lock()
	server.games[gameID] = session
	server.participants[first.Client] = Participant{session: session, color: game.Red}
	server.participants[second.Client] = Participant{session: session, color: game.Blue}
	server.mu.Unlock()

	state := newGame.Snapshot()
	first.Client.Send(ServerMessage{Type: "match_found", Color: game.Red, GameState: &state})
	second.Client.Send(ServerMessage{Type: "match_found", Color: game.Blue, GameState: &state})
	server.broadcastModePlayerCounts()
	server.broadcastLiveGames()
	return session
}

func (server *Server) participantFor(client *Client) *Participant {
	server.mu.RLock()
	participant, ok := server.participants[client]
	server.mu.RUnlock()
	if !ok {
		return nil
	}
	return &participant
}

func (server *Server) spectatorFor(client *Client) *GameSession {
	server.mu.RLock()
	session := server.spectating[client]
	server.mu.RUnlock()
	return session
}

func (server *Server) broadcastQueueStatus(now time.Time) {
	server.hub.mu.RLock()
	clients := make([]*Client, 0, len(server.hub.clients))
	for client := range server.hub.clients {
		clients = append(clients, client)
	}
	server.hub.mu.RUnlock()

	for _, client := range clients {
		if entry, ok := server.matchmaking.Status(client); ok {
			client.Send(ServerMessage{
				Type:        "queue_update",
				ModeID:      entry.ModeID,
				TimeControl: &entry.TimeControl,
				SearchRange: entry.SearchRange(now),
				QueuedForMs: now.Sub(entry.JoinedAt).Milliseconds(),
			})
		}
	}
	server.broadcastModePlayerCounts()
}

func (server *Server) modePlayerCounts() map[game.ModeID]int {
	counts := make(map[game.ModeID]int)
	for _, modeID := range server.registry.IDs() {
		counts[modeID] = 0
	}
	for modeID, count := range server.matchmaking.PlayerCountsByMode() {
		counts[modeID] += count
	}

	server.mu.RLock()
	for _, session := range server.games {
		counts[session.modeID] += 2
	}
	server.mu.RUnlock()
	return counts
}

func (server *Server) liveGames() []LiveGameSummary {
	server.mu.RLock()
	liveGames := make([]LiveGameSummary, 0, len(server.games))
	for _, session := range server.games {
		state := session.game.Snapshot()
		startedAtUnixMs := int64(0)
		if !session.startedAt.IsZero() {
			startedAtUnixMs = session.startedAt.UnixMilli()
		}
		liveGames = append(liveGames, LiveGameSummary{
			GameID:          session.gameID,
			ModeID:          state.Mode.ID,
			ModeName:        state.Mode.Name,
			RedPlayer:       state.RedPlayer,
			BluePlayer:      state.BluePlayer,
			RedElo:          session.redElo,
			BlueElo:         session.blueElo,
			SpectatorCount:  len(session.spectators),
			StartedAtUnixMs: startedAtUnixMs,
		})
	}
	server.mu.RUnlock()
	sort.Slice(liveGames, func(first, second int) bool {
		if liveGames[first].StartedAtUnixMs == liveGames[second].StartedAtUnixMs {
			return liveGames[first].GameID < liveGames[second].GameID
		}
		return liveGames[first].StartedAtUnixMs > liveGames[second].StartedAtUnixMs
	})
	return liveGames
}

// startBotSession records that a player is busy with a client-side bot. A
// repeat announcement replaces the previous one, which is how a reconnecting
// player restores their presence.
func (server *Server) startBotSession(client *Client, modeID game.ModeID) {
	server.mu.Lock()
	existing, alreadyPlaying := server.botSessions[client]
	if alreadyPlaying && existing.modeID == modeID {
		server.mu.Unlock()
		return
	}
	startedAt := existing.startedAt
	if !alreadyPlaying {
		startedAt = time.Now()
	}
	server.botSessions[client] = botSession{modeID: modeID, startedAt: startedAt}
	server.mu.Unlock()
	server.broadcastModePlayerCounts()
}

func (server *Server) endBotSession(client *Client) {
	server.mu.Lock()
	_, wasPlaying := server.botSessions[client]
	delete(server.botSessions, client)
	server.mu.Unlock()
	if wasPlaying {
		server.broadcastModePlayerCounts()
	}
}

func (server *Server) botPlayerCount() int {
	server.mu.RLock()
	defer server.mu.RUnlock()
	return len(server.botSessions)
}

func (server *Server) broadcastModePlayerCounts() {
	server.broadcastToClients(ServerMessage{
		Type:             "mode_player_counts",
		ModePlayerCounts: server.modePlayerCounts(),
		// Waiting players are broadcast separately from the total: a bot player
		// wants to know that someone is looking for a game right now, which the
		// combined figure cannot tell them.
		ModeQueueCounts: server.matchmaking.PlayerCountsByMode(),
		BotPlayerCount:  server.botPlayerCount(),
	})
}

func (server *Server) broadcastLiveGames() {
	server.broadcastToClients(ServerMessage{
		Type:      "live_games",
		LiveGames: server.liveGames(),
	})
}

// broadcastToClients delivers one lobby-wide message to every connection.
func (server *Server) broadcastToClients(message ServerMessage) {
	for _, client := range server.connectedClients() {
		client.Send(message)
	}
}

func (server *Server) disconnect(client *Client) {
	server.matchmaking.Remove(client)
	server.cancelChallengesFrom(client, "The challenger disconnected.")
	now := time.Now()
	var disconnected *Participant
	wasSpectating := false
	server.mu.Lock()
	if session := server.spectating[client]; session != nil {
		delete(server.spectating, client)
		delete(session.spectators, client)
		wasSpectating = true
	}
	server.leaveRoomLocked(client)
	delete(server.botSessions, client)
	if participant, ok := server.participants[client]; ok {
		delete(server.participants, client)
		session := participant.session
		switch participant.color {
		case game.Red:
			if session.redClient == client {
				session.redClient = nil
				session.redDisconnectedAt = now
				disconnected = &participant
			}
		case game.Blue:
			if session.blueClient == client {
				session.blueClient = nil
				session.blueDisconnectedAt = now
				disconnected = &participant
			}
		}
	}
	server.mu.Unlock()
	server.hub.Unregister(client)
	server.broadcastModePlayerCounts()
	if wasSpectating {
		server.broadcastLiveGames()
	}
	if server.clearTournamentReadiness(client) {
		server.broadcastTournaments()
	}

	if disconnected != nil {
		server.sendToColor(
			disconnected.session,
			game.OtherColor(disconnected.color),
			ServerMessage{
				Type:                    "opponent_disconnected",
				ReconnectDeadlineUnixMs: now.Add(reconnectGracePeriod).UnixMilli(),
			},
		)
	}
}

// retireSession takes a finished game out of the lobby and hands whoever is
// still connected to it over to a chat room, so the conversation survives the
// result. Nobody is a player or spectator of a live game any more, which frees
// them to queue for another match while they talk.
func (server *Server) retireSession(session *GameSession) {
	server.mu.Lock()
	current, ok := server.games[session.gameID]
	if !ok || current != session {
		server.mu.Unlock()
		return
	}
	delete(server.games, session.gameID)

	members := 0
	seat := func(client *Client, color game.PlayerColor) {
		if client == nil {
			return
		}
		server.postGameMembers[client] = Participant{session: session, color: color}
		members++
	}
	for spectator := range session.spectators {
		if server.spectating[spectator] != session {
			continue
		}
		delete(server.spectating, spectator)
		seat(spectator, game.Neutral)
	}
	for _, player := range []struct {
		client *Client
		color  game.PlayerColor
	}{
		{session.redClient, game.Red},
		{session.blueClient, game.Blue},
	} {
		if player.client == nil ||
			server.participants[player.client].session != session {
			continue
		}
		delete(server.participants, player.client)
		seat(player.client, player.color)
	}
	if members > 0 {
		server.postGameRooms[session.gameID] = session
	}
	server.mu.Unlock()

	server.broadcastModePlayerCounts()
	server.broadcastLiveGames()
}

func (server *Server) expireGames(now time.Time) {
	server.mu.RLock()
	sessions := make([]*GameSession, 0, len(server.games))
	for _, session := range server.games {
		sessions = append(sessions, session)
	}
	server.mu.RUnlock()

	for _, session := range sessions {
		state, expired := session.game.Tick(now)
		if expired {
			server.finishSession(session, state)
			continue
		}
		if abandoned := server.abandonedPlayer(session, now); abandoned != game.Neutral {
			state, err := session.game.Abandon(abandoned)
			if err == nil {
				server.finishSession(session, state)
			}
		}
	}
	server.removeExpiredCompletedGames(now)
}

func (server *Server) removeExpiredCompletedGames(now time.Time) {
	server.mu.Lock()
	for gameID, completed := range server.completedGames {
		if !now.Before(completed.expiresAt) {
			delete(server.completedGames, gameID)
		}
	}
	server.mu.Unlock()
}

func (server *Server) broadcastGameState(session *GameSession, state game.GameState) {
	server.broadcastToSession(session, ServerMessage{Type: "game_state", GameState: &state})
}

func (server *Server) broadcastToSession(session *GameSession, message ServerMessage) {
	server.mu.RLock()
	redClient := session.redClient
	blueClient := session.blueClient
	spectators := make([]*Client, 0, len(session.spectators))
	for spectator := range session.spectators {
		spectators = append(spectators, spectator)
	}
	server.mu.RUnlock()
	if redClient != nil {
		redClient.Send(message)
	}
	if blueClient != nil && blueClient != redClient {
		blueClient.Send(message)
	}
	for _, spectator := range spectators {
		if spectator != redClient && spectator != blueClient {
			spectator.Send(message)
		}
	}
}

func (server *Server) sendToColor(
	session *GameSession,
	color game.PlayerColor,
	message ServerMessage,
) {
	server.mu.RLock()
	var client *Client
	if color == game.Red {
		client = session.redClient
	} else if color == game.Blue {
		client = session.blueClient
	}
	server.mu.RUnlock()
	if client != nil {
		client.Send(message)
	}
}

func (server *Server) abandonedPlayer(session *GameSession, now time.Time) game.PlayerColor {
	server.mu.RLock()
	defer server.mu.RUnlock()
	if current, ok := server.games[session.gameID]; !ok || current != session {
		return game.Neutral
	}
	redDeadline := disconnectDeadline(session.redDisconnectedAt)
	blueDeadline := disconnectDeadline(session.blueDisconnectedAt)
	redExpired := !redDeadline.IsZero() && !now.Before(redDeadline)
	blueExpired := !blueDeadline.IsZero() && !now.Before(blueDeadline)
	switch {
	case redExpired && blueExpired:
		if redDeadline.Before(blueDeadline) {
			return game.Red
		}
		if blueDeadline.Before(redDeadline) {
			return game.Blue
		}
		return game.Red
	case redExpired:
		return game.Red
	case blueExpired:
		return game.Blue
	default:
		return game.Neutral
	}
}

func disconnectDeadline(disconnectedAt time.Time) time.Time {
	if disconnectedAt.IsZero() {
		return time.Time{}
	}
	return disconnectedAt.Add(reconnectGracePeriod)
}

func deadlineUnixMilli(deadline time.Time) int64 {
	if deadline.IsZero() {
		return 0
	}
	return deadline.UnixMilli()
}

func (server *Server) finishSession(session *GameSession, state game.GameState) {
	session.closeOnce.Do(func() {
		finishedAt := time.Now()
		ratingUpdate, err := server.data.RecordCompletedGame(
			context.Background(),
			state,
			session.startedAt,
			finishedAt,
			session.ranked,
		)
		if err != nil {
			log.Printf("persist completed game %s: %v", session.gameID, err)
		}
		if err == nil {
			server.updateSessionAccounts(session, ratingUpdate)
		}
		// Archived after the rating transaction so the stored game can name
		// the ratings it produced, but never gated on it: every finished game
		// is written down.
		server.archiveGame(session, finishedAt, ratingUpdate, err == nil)
		server.mu.Lock()
		server.completedGames[session.gameID] = CompletedGame{
			state:     state,
			expiresAt: finishedAt.Add(completedGameRetention),
		}
		server.mu.Unlock()
		message := ServerMessage{Type: "game_state", GameState: &state}
		if err == nil {
			message.RatingUpdate = &ratingUpdate
		}
		server.broadcastToSession(session, message)
		server.retireSession(session)
		server.recordTournamentMatchResult(session, state)
	})
}

func (server *Server) updateSessionAccounts(
	session *GameSession,
	update persistence.RatingUpdate,
) {
	server.mu.Lock()
	defer server.mu.Unlock()
	if session.redClient != nil {
		session.redClient.account.RecordRatedGame(update.ModeID, update.RedEloAfter)
	}
	if session.blueClient != nil {
		session.blueClient.account.RecordRatedGame(update.ModeID, update.BlueEloAfter)
	}
}

func randomID() (string, error) {
	data := make([]byte, 12)
	if _, err := rand.Read(data); err != nil {
		return "", fmt.Errorf("random id: %w", err)
	}
	return hex.EncodeToString(data), nil
}

func originChecker(allowed []string) func(*http.Request) bool {
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, origin := range allowed {
		if trimmed := strings.TrimSpace(origin); trimmed != "" {
			allowedSet[trimmed] = struct{}{}
		}
	}
	return func(request *http.Request) bool {
		origin := request.Header.Get("Origin")
		if origin == "" {
			return true // Native clients generally do not send an Origin header.
		}
		if _, ok := allowedSet[origin]; ok {
			return true
		}
		parsed, err := url.Parse(origin)
		if err != nil {
			return false
		}
		hostname := parsed.Hostname()
		if hostname == "localhost" {
			return true
		}
		ip := net.ParseIP(hostname)
		return ip != nil && (ip.IsLoopback() || ip.IsPrivate())
	}
}
