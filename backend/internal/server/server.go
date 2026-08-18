package server

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

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
	redDisconnectedAt  time.Time
	blueDisconnectedAt time.Time
	startedAt          time.Time
	ranked             bool
	closeOnce          sync.Once
}

type CompletedGame struct {
	state     game.GameState
	expiresAt time.Time
}

const (
	reconnectGracePeriod   = 30 * time.Second
	completedGameRetention = 30 * time.Second
)

type Participant struct {
	session *GameSession
	color   game.PlayerColor
}

type Server struct {
	hub         *Hub
	matchmaking *MatchmakingQueue
	registry    *game.ModeRegistry
	data        *persistence.Store
	upgrader    websocket.Upgrader

	mu             sync.RWMutex
	participants   map[*Client]Participant
	games          map[string]*GameSession
	completedGames map[string]CompletedGame
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

func NewWithRegistryAndStore(
	registry *game.ModeRegistry,
	data *persistence.Store,
	allowedOrigins []string,
) *Server {
	if data == nil {
		panic("server persistence store is required")
	}
	server := &Server{
		hub:            NewHub(),
		registry:       registry,
		data:           data,
		participants:   make(map[*Client]Participant),
		games:          make(map[string]*GameSession),
		completedGames: make(map[string]CompletedGame),
	}
	server.matchmaking = NewMatchmakingQueue(server.startMatch)
	server.upgrader = websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		CheckOrigin:     originChecker(allowedOrigins),
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
	mux.HandleFunc("GET /api/accounts/{userID}/games", server.getGameHistory)
	mux.HandleFunc(
		"GET /api/accounts/{userID}/record/{opponentID}",
		server.getHeadToHeadRecord,
	)
	mux.HandleFunc("GET /ws", server.handleWebSocket)
	return mux
}

func (server *Server) handleWebSocket(writer http.ResponseWriter, request *http.Request) {
	profile := profileFromQuery(request.URL.Query())
	account, err := server.data.EnsureAccount(
		request.Context(),
		profile.UserID,
		profile.Username,
	)
	if err != nil {
		http.Error(writer, "could not initialize account", http.StatusBadRequest)
		return
	}
	profile = game.PlayerProfile{UserID: account.UserID, Username: account.Username}

	connection, err := server.upgrader.Upgrade(writer, request, nil)
	if err != nil {
		log.Printf("websocket upgrade: %v", err)
		return
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
		Account:            &account,
		DefaultTimeControl: &defaultTimeControl,
	})
	go client.writePump()
	client.readPump()
}

func (server *Server) handleMessage(client *Client, message ClientMessage) {
	switch message.Type {
	case "join_queue":
		if !server.registry.Has(message.ModeID) {
			client.Send(ServerMessage{Type: "error", Message: "invalid game mode"})
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
	case "rejoin_game":
		server.rejoinGame(client, message.GameID)
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
	case "resign_game":
		server.resign(client)
	default:
		client.Send(ServerMessage{Type: "error", Message: "unknown message type"})
	}
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
	server.mu.Lock()
	session, ok := server.games[gameID]
	if !ok {
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
			Type:      "game_rejoined",
			Color:     playerColor,
			GameState: &rejoinState,
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

func (server *Server) startMatch(first, second QueueEntry) {
	gameID, err := randomID()
	if err != nil {
		first.Client.Send(ServerMessage{Type: "error", Message: "could not create game"})
		second.Client.Send(ServerMessage{Type: "error", Message: "could not create game"})
		return
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
		return
	}

	session := &GameSession{
		gameID:     gameID,
		modeID:     first.ModeID,
		game:       newGame,
		redClient:  first.Client,
		blueClient: second.Client,
		startedAt:  time.Now(),
		ranked:     true,
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

func (server *Server) broadcastModePlayerCounts() {
	message := ServerMessage{
		Type:             "mode_player_counts",
		ModePlayerCounts: server.modePlayerCounts(),
	}
	server.hub.mu.RLock()
	clients := make([]*Client, 0, len(server.hub.clients))
	for client := range server.hub.clients {
		clients = append(clients, client)
	}
	server.hub.mu.RUnlock()
	for _, client := range clients {
		client.Send(message)
	}
}

func (server *Server) disconnect(client *Client) {
	server.matchmaking.Remove(client)
	now := time.Now()
	var disconnected *Participant
	server.mu.Lock()
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

func (server *Server) removeSession(session *GameSession) {
	removed := false
	server.mu.Lock()
	if current, ok := server.games[session.gameID]; ok && current == session {
		if session.redClient != nil {
			delete(server.participants, session.redClient)
		}
		if session.blueClient != nil {
			delete(server.participants, session.blueClient)
		}
		delete(server.games, session.gameID)
		removed = true
	}
	server.mu.Unlock()
	if removed {
		server.broadcastModePlayerCounts()
	}
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
	server.mu.RUnlock()
	if redClient != nil {
		redClient.Send(message)
	}
	if blueClient != nil && blueClient != redClient {
		blueClient.Send(message)
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
		server.removeSession(session)
	})
}

func (server *Server) updateSessionAccounts(
	session *GameSession,
	update persistence.RatingUpdate,
) {
	server.mu.Lock()
	defer server.mu.Unlock()
	if session.redClient != nil {
		session.redClient.account.Elo = update.RedEloAfter
		session.redClient.account.GamesPlayed++
	}
	if session.blueClient != nil {
		session.blueClient.account.Elo = update.BlueEloAfter
		session.blueClient.account.GamesPlayed++
	}
}

func profileFromQuery(values url.Values) game.PlayerProfile {
	return game.PlayerProfile{
		UserID:   queryString(values, "userId", "guest-"+strconv.FormatInt(time.Now().UnixNano(), 36)),
		Username: queryString(values, "username", "Guest"),
	}
}

func queryString(values url.Values, key, fallback string) string {
	if value := strings.TrimSpace(values.Get(key)); value != "" {
		return value
	}
	return fallback
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
		return err == nil && (parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1")
	}
}
