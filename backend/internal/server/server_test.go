package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/notation"
	"rps-strategy/backend/internal/persistence"
)

const catalogTestModeID game.ModeID = "catalog-test"

var catalogTestStartingPosition = game.MustStartingPosition(
	".........",
	".........",
	".........",
	".........",
	".........",
	".........",
	".........",
	".........",
	".........",
)

type catalogTestMode struct{}

func (*catalogTestMode) Definition() game.ModeDefinition {
	return game.ModeDefinition{
		ID:               catalogTestModeID,
		Name:             "Catalog Test",
		StartingPosition: catalogTestStartingPosition,
	}
}

func (*catalogTestMode) Initialize(*game.GameState) {}

func (*catalogTestMode) ValidMoves(
	game.GameState,
	game.PlayerColor,
	game.Position,
) []game.Position {
	return nil
}

func (*catalogTestMode) Move(
	*game.GameState,
	game.PlayerColor,
	game.Position,
	game.Position,
) error {
	return nil
}

func TestModeCatalogComesFromRegistry(t *testing.T) {
	registry := game.NewModeRegistry()
	registry.MustRegister(func() game.GameMode { return &catalogTestMode{} })
	server := NewWithRegistry(registry, nil)
	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/modes", nil)

	server.Routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", recorder.Code)
	}
	var modes []game.ModeDefinition
	if err := json.NewDecoder(recorder.Body).Decode(&modes); err != nil {
		t.Fatal(err)
	}
	if len(modes) != 1 || modes[0].ID != catalogTestModeID {
		t.Fatalf("catalog did not reflect custom registry: %#v", modes)
	}
	if modes[0].StartingPosition != catalogTestStartingPosition {
		t.Fatalf("catalog omitted the custom starting position: %#v", modes[0])
	}
}

func TestWebSocketCanJoinQueue(t *testing.T) {
	server := New(nil)
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()

	websocketURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"
	connection, _, err := websocket.DefaultDialer.Dial(websocketURL, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer connection.Close()
	_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
	if err := connection.WriteJSON(ClientMessage{
		Type:       "authenticate",
		UserID:     "websocket-test-player",
		ProfileKey: "0123456789abcdef0123456789abcdef",
	}); err != nil {
		t.Fatal(err)
	}

	var ready ServerMessage
	if err := connection.ReadJSON(&ready); err != nil {
		t.Fatal(err)
	}
	if ready.Type != "connection_ready" {
		t.Fatalf("expected connection_ready, got %q", ready.Type)
	}
	registered := len(game.DefaultModeRegistry.CatalogueDefinitions())
	if len(ready.Modes) != registered {
		t.Fatalf("expected every registered mode (%d), got %d", registered, len(ready.Modes))
	}
	if ready.DefaultTimeControl == nil || *ready.DefaultTimeControl != game.DefaultTimeControl() {
		t.Fatalf("expected connection default 5/+3, got %#v", ready.DefaultTimeControl)
	}
	if ready.Account == nil || ready.Account.Elo != persistence.RatingFloor {
		t.Fatalf("expected a persisted default account, got %#v", ready.Account)
	}
	if len(ready.ModePlayerCounts) != registered {
		t.Fatalf("expected a player count for every mode, got %#v", ready.ModePlayerCounts)
	}
	for _, modeID := range game.DefaultModeRegistry.IDs() {
		if ready.ModePlayerCounts[modeID] != 0 {
			t.Fatalf("expected no players in %s, got %#v", modeID, ready.ModePlayerCounts)
		}
	}

	if err := connection.WriteJSON(ClientMessage{Type: "join_queue", ModeID: game.ModeTotalWar}); err != nil {
		t.Fatal(err)
	}
	for {
		var message ServerMessage
		if err := connection.ReadJSON(&message); err != nil {
			t.Fatal(err)
		}
		if message.Type == "queue_update" {
			if message.SearchRange != matchmakingInitialRatingRange {
				t.Fatalf(
					"expected initial ±%d range, got %d",
					matchmakingInitialRatingRange,
					message.SearchRange,
				)
			}
			if message.TimeControl == nil || *message.TimeControl != game.DefaultTimeControl() {
				t.Fatalf("expected queue default 5/+3, got %#v", message.TimeControl)
			}
			break
		}
	}
}

func TestOriginCheckerAllowsLocalNetworkOrigins(t *testing.T) {
	checkOrigin := originChecker(nil)
	tests := []struct {
		origin  string
		allowed bool
	}{
		{origin: "http://localhost:8081", allowed: true},
		{origin: "http://127.0.0.1:8081", allowed: true},
		{origin: "http://192.168.86.28:8081", allowed: true},
		{origin: "http://10.0.0.12:8081", allowed: true},
		{origin: "http://172.16.0.5:8081", allowed: true},
		{origin: "https://203.0.113.10", allowed: false},
		{origin: "https://example.com", allowed: false},
	}

	for _, test := range tests {
		t.Run(test.origin, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/ws", nil)
			// Named explicitly, because httptest calls this host example.com
			// and a rejection has to be a rejection on the merits rather than
			// same-origin failing to apply.
			request.Host = "api-rps.example"
			request.Header.Set("Origin", test.origin)
			if allowed := checkOrigin(request); allowed != test.allowed {
				t.Fatalf("origin allowed = %t, want %t", allowed, test.allowed)
			}
		})
	}
}

func TestOriginCheckerAllowsConfiguredPublicOrigin(t *testing.T) {
	checkOrigin := originChecker([]string{"https://rps.example"})
	request := httptest.NewRequest(http.MethodGet, "/ws", nil)
	request.Host = "api-rps.example"
	request.Header.Set("Origin", "https://rps.example")
	if !checkOrigin(request) {
		t.Fatal("configured origin was rejected")
	}
}

// TestOriginCheckerAllowsItsOwnHost covers the native app, which cannot say
// anything else: React Native builds the Origin header from the socket URL, so
// the iOS client's Origin is the API host it is dialling. Nothing configures
// that host here -- the point is that no deployment has to.
func TestOriginCheckerAllowsItsOwnHost(t *testing.T) {
	checkOrigin := originChecker([]string{"https://rps.example"})
	tests := []struct {
		name    string
		host    string
		origin  string
		allowed bool
	}{
		{name: "native app", host: "api-rps.example", origin: "https://api-rps.example", allowed: true},
		{name: "case insensitive", host: "api-rps.example", origin: "https://API-RPS.example", allowed: true},
		{name: "with port", host: "api-rps.example:8443", origin: "https://api-rps.example:8443", allowed: true},
		{name: "port mismatch", host: "api-rps.example:8443", origin: "https://api-rps.example", allowed: false},
		{name: "neighbouring host", host: "api-rps.example", origin: "https://evil.example", allowed: false},
		{name: "prefix only", host: "api-rps.example", origin: "https://api-rps.example.evil.com", allowed: false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/ws", nil)
			request.Host = test.host
			request.Header.Set("Origin", test.origin)
			if allowed := checkOrigin(request); allowed != test.allowed {
				t.Fatalf("origin %q on host %q allowed = %t, want %t",
					test.origin, test.host, allowed, test.allowed)
			}
		})
	}
}

func TestPersistentAccountHistoryAndHeadToHeadRoutes(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	red := game.PlayerProfile{UserID: "route-red", Username: "Route Red"}
	blue := game.PlayerProfile{UserID: "route-blue", Username: "Route Blue"}
	newGame, err := game.NewGame("route-game", game.ModeTotalWar, red, blue)
	if err != nil {
		t.Fatal(err)
	}
	state, err := newGame.Resign(game.Blue)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := data.RecordCompletedGame(
		t.Context(), state, time.Now().Add(-time.Minute), time.Now(), true,
	); err != nil {
		t.Fatal(err)
	}
	server := NewWithStore(data, nil)

	accountRecorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(
		accountRecorder,
		httptest.NewRequest(http.MethodGet, "/api/accounts/route-red", nil),
	)
	if accountRecorder.Code != http.StatusOK {
		t.Fatalf("expected account 200, got %d: %s", accountRecorder.Code, accountRecorder.Body)
	}
	var account persistence.Account
	if err := json.NewDecoder(accountRecorder.Body).Decode(&account); err != nil {
		t.Fatal(err)
	}
	if account.Wins != 1 || account.ModeElo(game.ModeTotalWar) <= persistence.RatingFloor {
		t.Fatalf("unexpected account response: %#v", account)
	}

	historyRecorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(
		historyRecorder,
		httptest.NewRequest(http.MethodGet, "/api/accounts/route-red/games", nil),
	)
	var history []persistence.GameRecord
	if err := json.NewDecoder(historyRecorder.Body).Decode(&history); err != nil {
		t.Fatal(err)
	}
	if historyRecorder.Code != http.StatusOK || len(history) != 1 ||
		history[0].GameID != state.GameID {
		t.Fatalf("unexpected history response: code=%d history=%#v", historyRecorder.Code, history)
	}

	recordRecorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(
		recordRecorder,
		httptest.NewRequest(
			http.MethodGet,
			"/api/accounts/route-blue/record/route-red",
			nil,
		),
	)
	var record persistence.HeadToHeadRecord
	if err := json.NewDecoder(recordRecorder.Body).Decode(&record); err != nil {
		t.Fatal(err)
	}
	if recordRecorder.Code != http.StatusOK || record.Player1Wins != 0 ||
		record.Player2Wins != 1 || record.GamesPlayed != 1 {
		t.Fatalf("unexpected record response: code=%d record=%#v", recordRecorder.Code, record)
	}
}

func TestJoinQueueAcceptsCustomTimeControl(t *testing.T) {
	server := New(nil)
	client := &Client{
		send:    make(chan []byte, 1),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "custom-clock-player"},
	}
	control := game.TimeControl{InitialTimeMs: 90_000, IncrementMs: 500}

	server.handleMessage(client, ClientMessage{
		Type:        "join_queue",
		ModeID:      game.ModeTotalWar,
		TimeControl: &control,
	})

	seek := server.seeks.ForClient(client)
	if seek == nil || seek.Setup.TimeControl != control {
		t.Fatalf("expected custom queue control %#v, got %#v", control, seek)
	}
	// Pressing play is a search whatever clock it names: it waits without
	// expiring, and pairs with anybody else who asked for the same clock.
	if !seek.Queued {
		t.Fatal("joining the queue with a custom clock is still a search")
	}
	if !seek.ExpiresAt.IsZero() {
		t.Fatal("a search must not expire out from under the person searching")
	}
	var response ServerMessage
	if err := json.Unmarshal(<-client.send, &response); err != nil {
		t.Fatal(err)
	}
	if response.Type != "queue_update" || response.TimeControl == nil ||
		*response.TimeControl != control {
		t.Fatalf("expected echoed custom control, got %#v", response)
	}
}

func TestJoinQueueRejectsInvalidTimeControl(t *testing.T) {
	server := New(nil)
	client := &Client{
		send: make(chan []byte, 1),
		done: make(chan struct{}),
	}
	control := game.TimeControl{InitialTimeMs: -1, IncrementMs: 0}

	server.handleMessage(client, ClientMessage{
		Type:        "join_queue",
		ModeID:      game.ModeTotalWar,
		TimeControl: &control,
	})

	if server.seeks.ForClient(client) != nil {
		t.Fatal("invalid time control must not enter matchmaking")
	}
	var response ServerMessage
	if err := json.Unmarshal(<-client.send, &response); err != nil {
		t.Fatal(err)
	}
	if response.Type != "error" || !strings.Contains(response.Message, "initialTimeMs") {
		t.Fatalf("expected initialTimeMs validation error, got %#v", response)
	}
}

// postedSeek is a seek on the board with a live socket behind it, which is the
// ordinary shape a count should include.
func postedSeek(id string, modeID game.ModeID) *Seek {
	client := &Client{}
	seek := &Seek{
		ID:    id,
		Owner: seekOwnerKey(client),
		Setup: game.GameSetup{ModeID: modeID},
	}
	seek.bind(client)
	return seek
}

func TestModePlayerCountsIncludeActiveGamesAndMatchmaking(t *testing.T) {
	server := New(nil)
	server.seeks.Post(postedSeek("total-war-seek", game.ModeTotalWar))
	server.seeks.Post(postedSeek("infiltration-seek", game.ModeInfiltration))
	server.games["active-total-war"] = &GameSession{
		modeID: game.ModeTotalWar,
		chat:   newChatRoom("active-total-war"),
	}

	counts := server.modePlayerCounts()
	if counts[game.ModeTotalWar] != 3 {
		t.Fatalf("expected two active and one searching Total War players, got %#v", counts)
	}
	if counts[game.ModeInfiltration] != 1 {
		t.Fatalf("expected one searching Infiltration player, got %#v", counts)
	}
	if counts[game.ModeID("V7")] != 0 {
		t.Fatalf("a mode with nobody in it must report zero, got %#v", counts)
	}
}

// awaitMessageOfType reads until the wanted message arrives. Several lobby
// actions publish more than one thing — joining a queue changes both the public
// board and the population counts — and a test that cares about one of them
// should not depend on the order they go out in.
func awaitMessageOfType(t *testing.T, client *Client, wanted string) ServerMessage {
	t.Helper()
	deadline := time.After(time.Second)
	for {
		select {
		case encoded := <-client.send:
			var message ServerMessage
			if err := json.Unmarshal(encoded, &message); err != nil {
				t.Fatal(err)
			}
			if message.Type == wanted {
				return message
			}
		case <-deadline:
			t.Fatalf("timed out waiting for a %s message", wanted)
			return ServerMessage{}
		}
	}
}

func TestQueueChangesBroadcastModePlayerCounts(t *testing.T) {
	server := New(nil)
	observer := &Client{send: make(chan []byte, 8), done: make(chan struct{})}
	server.hub.Register(observer)
	player := &Client{send: make(chan []byte, 8), done: make(chan struct{})}

	server.handleMessage(player, ClientMessage{
		Type:   "join_queue",
		ModeID: game.ModeTotalWar,
	})
	joined := awaitMessageOfType(t, observer, "mode_player_counts")
	if joined.ModePlayerCounts[game.ModeTotalWar] != 1 {
		t.Fatalf("expected the queued player to be broadcast, got %#v", joined)
	}

	server.handleMessage(player, ClientMessage{Type: "leave_queue"})
	left := awaitMessageOfType(t, observer, "mode_player_counts")
	if left.ModePlayerCounts[game.ModeTotalWar] != 0 {
		t.Fatalf("expected the departed player to be removed, got %#v", left)
	}
}

func TestServerExpiresAndRemovesTimedOutSession(t *testing.T) {
	server := New(nil)
	redClient := &Client{send: make(chan []byte, 1), done: make(chan struct{})}
	blueClient := &Client{send: make(chan []byte, 1), done: make(chan struct{})}
	newGame, err := game.NewGameWithTimeControl(
		"server-timeout",
		game.ModeTotalWar,
		game.PlayerProfile{UserID: "red"},
		game.PlayerProfile{UserID: "blue"},
		game.TimeControl{InitialTimeMs: 1_000, IncrementMs: 0},
	)
	if err != nil {
		t.Fatal(err)
	}
	session := &GameSession{
		gameID:     "server-timeout",
		game:       newGame,
		redClient:  redClient,
		blueClient: blueClient,
		chat:       newChatRoom("server-timeout"),
	}
	server.games[session.gameID] = session
	server.participants[redClient] = Participant{session: session, color: game.Red}
	server.participants[blueClient] = Participant{session: session, color: game.Blue}

	server.expireGames(time.Now().Add(2 * time.Second))
	if len(server.games) != 0 || len(server.participants) != 0 {
		t.Fatal("expected the timed-out session to be removed")
	}
	for _, client := range []*Client{redClient, blueClient} {
		var message ServerMessage
		if err := json.Unmarshal(<-client.send, &message); err != nil {
			t.Fatal(err)
		}
		if message.Type != "game_state" || message.GameState == nil ||
			message.GameState.EndReason != game.EndReasonTimeout {
			t.Fatalf("expected final timeout game state, got %#v", message)
		}
	}
}

func TestPlayerCanRejoinReservedSeat(t *testing.T) {
	server := New(nil)
	redProfile := game.PlayerProfile{UserID: "red-user"}
	blueProfile := game.PlayerProfile{UserID: "blue-user"}
	newGame, err := game.NewGame("rejoin-session", game.ModeTotalWar, redProfile, blueProfile)
	if err != nil {
		t.Fatal(err)
	}
	blueClient := &Client{
		send:    make(chan []byte, 2),
		done:    make(chan struct{}),
		profile: blueProfile,
	}
	session := &GameSession{
		gameID:            "rejoin-session",
		game:              newGame,
		blueClient:        blueClient,
		redDisconnectedAt: time.Now(),
		chat:              newChatRoom("rejoin-session"),
	}
	server.games[session.gameID] = session
	server.participants[blueClient] = Participant{session: session, color: game.Blue}

	rejoinedClient := &Client{
		send:    make(chan []byte, 1),
		done:    make(chan struct{}),
		profile: redProfile,
	}
	server.rejoinGame(rejoinedClient, session.gameID)

	participant := server.participantFor(rejoinedClient)
	if participant == nil || participant.session != session || participant.color != game.Red {
		t.Fatalf("expected the new connection to own Red's seat, got %#v", participant)
	}
	if !session.redDisconnectedAt.IsZero() {
		t.Fatal("expected the disconnect deadline to be cleared")
	}
	var rejoined ServerMessage
	if err := json.Unmarshal(<-rejoinedClient.send, &rejoined); err != nil {
		t.Fatal(err)
	}
	if rejoined.Type != "game_rejoined" || rejoined.Color != game.Red ||
		rejoined.GameState == nil || rejoined.GameState.GameID != session.gameID {
		t.Fatalf("unexpected rejoin response: %#v", rejoined)
	}
	var opponentNotice ServerMessage
	if err := json.Unmarshal(<-blueClient.send, &opponentNotice); err != nil {
		t.Fatal(err)
	}
	if opponentNotice.Type != "opponent_reconnected" {
		t.Fatalf("expected opponent reconnected notice, got %#v", opponentNotice)
	}
}

func TestDisconnectReservesSeatAndNotifiesOpponent(t *testing.T) {
	server := New(nil)
	redClient := &Client{
		send:    make(chan []byte, 1),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "red-user"},
	}
	blueClient := &Client{
		send:    make(chan []byte, 1),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "blue-user"},
	}
	newGame, err := game.NewGame(
		"disconnect-session",
		game.ModeTotalWar,
		redClient.profile,
		blueClient.profile,
	)
	if err != nil {
		t.Fatal(err)
	}
	session := &GameSession{
		gameID:     "disconnect-session",
		game:       newGame,
		redClient:  redClient,
		blueClient: blueClient,
		chat:       newChatRoom("disconnect-session"),
	}
	server.games[session.gameID] = session
	server.participants[redClient] = Participant{session: session, color: game.Red}
	server.participants[blueClient] = Participant{session: session, color: game.Blue}

	beforeDisconnect := time.Now()
	server.disconnect(redClient)
	if server.games[session.gameID] != session {
		t.Fatal("disconnect should keep the game available during the grace period")
	}
	if server.participantFor(redClient) != nil || server.participantFor(blueClient) == nil {
		t.Fatal("expected only the disconnected client's participant binding to be removed")
	}
	if session.redClient != nil || session.redDisconnectedAt.IsZero() {
		t.Fatal("expected Red's seat to be reserved without its old connection")
	}
	var notice ServerMessage
	if err := json.Unmarshal(<-blueClient.send, &notice); err != nil {
		t.Fatal(err)
	}
	minimumDeadline := beforeDisconnect.Add(reconnectGracePeriod).UnixMilli()
	if notice.Type != "opponent_disconnected" ||
		notice.ReconnectDeadlineUnixMs < minimumDeadline {
		t.Fatalf("expected a 30-second reconnect deadline, got %#v", notice)
	}
}

func TestDisconnectedPlayerLosesByAbandonmentAfterThirtySeconds(t *testing.T) {
	server := New(nil)
	redProfile := game.PlayerProfile{UserID: "red-user"}
	blueProfile := game.PlayerProfile{UserID: "blue-user"}
	newGame, err := game.NewGame("abandon-session", game.ModeTotalWar, redProfile, blueProfile)
	if err != nil {
		t.Fatal(err)
	}
	baseTime := time.Now()
	blueClient := &Client{
		send:    make(chan []byte, 1),
		done:    make(chan struct{}),
		profile: blueProfile,
	}
	session := &GameSession{
		gameID:            "abandon-session",
		game:              newGame,
		blueClient:        blueClient,
		redDisconnectedAt: baseTime,
		chat:              newChatRoom("abandon-session"),
	}
	server.games[session.gameID] = session
	server.participants[blueClient] = Participant{session: session, color: game.Blue}

	server.expireGames(baseTime.Add(reconnectGracePeriod))
	if len(server.games) != 0 || len(server.participants) != 0 {
		t.Fatal("expected the abandoned game session to be removed")
	}
	var finished ServerMessage
	if err := json.Unmarshal(<-blueClient.send, &finished); err != nil {
		t.Fatal(err)
	}
	if finished.Type != "game_state" || finished.GameState == nil ||
		finished.GameState.Winner != game.Blue ||
		finished.GameState.EndReason != game.EndReasonAbandonment {
		t.Fatalf("expected Blue to win by abandonment, got %#v", finished)
	}
}

func TestRejoinRejectsDifferentUser(t *testing.T) {
	server := New(nil)
	newGame, err := game.NewGame(
		"private-session",
		game.ModeTotalWar,
		game.PlayerProfile{UserID: "red-user"},
		game.PlayerProfile{UserID: "blue-user"},
	)
	if err != nil {
		t.Fatal(err)
	}
	server.games["private-session"] = &GameSession{
		gameID: "private-session", game: newGame, chat: newChatRoom("private-session"),
	}
	intruder := &Client{
		send:    make(chan []byte, 1),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "another-user"},
	}

	server.rejoinGame(intruder, "private-session")
	var response ServerMessage
	if err := json.Unmarshal(<-intruder.send, &response); err != nil {
		t.Fatal(err)
	}
	if response.Type != "game_unavailable" || server.participantFor(intruder) != nil {
		t.Fatalf("expected a generic unavailable response, got %#v", response)
	}
}

func TestRejoinReturnsRecentlyCompletedGameResult(t *testing.T) {
	server := New(nil)
	redProfile := game.PlayerProfile{UserID: "red-user"}
	blueProfile := game.PlayerProfile{UserID: "blue-user"}
	newGame, err := game.NewGame("completed-session", game.ModeTotalWar, redProfile, blueProfile)
	if err != nil {
		t.Fatal(err)
	}
	session := &GameSession{
		gameID: "completed-session", game: newGame, chat: newChatRoom("completed-session"),
	}
	server.games[session.gameID] = session
	state, err := newGame.Resign(game.Red)
	if err != nil {
		t.Fatal(err)
	}
	server.finishSession(session, state)

	rejoinedClient := &Client{
		send:    make(chan []byte, 1),
		done:    make(chan struct{}),
		profile: blueProfile,
	}
	server.rejoinGame(rejoinedClient, session.gameID)
	var response ServerMessage
	if err := json.Unmarshal(<-rejoinedClient.send, &response); err != nil {
		t.Fatal(err)
	}
	if response.Type != "game_rejoined" || response.Color != game.Blue ||
		response.GameState == nil || response.GameState.Status != game.Finished ||
		response.GameState.Winner != game.Blue ||
		response.GameState.EndReason != game.EndReasonResignation {
		t.Fatalf("expected the retained final result, got %#v", response)
	}
}

func TestLiveGamesExposeNamesRatingsAndSpectatorCount(t *testing.T) {
	server := New(nil)
	redClient := &Client{
		send:    make(chan []byte, 4),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "live-red", Username: "Alice"},
		account: persistence.Account{UserID: "live-red", Elo: 1315},
	}
	blueClient := &Client{
		send:    make(chan []byte, 4),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "live-blue", Username: "Bob"},
		account: persistence.Account{UserID: "live-blue", Elo: 1278},
	}
	server.startConfiguredMatch(
		QueueEntry{Client: redClient, Setup: game.GameSetup{ModeID: game.ModeTotalWar}, Elo: 1315},
		QueueEntry{Client: blueClient, Setup: game.GameSetup{ModeID: game.ModeTotalWar}, Elo: 1278},
		matchSetup{},
	)
	_ = readClientMessage(t, redClient)
	_ = readClientMessage(t, blueClient)

	liveGames := server.liveGames()
	if len(liveGames) != 1 {
		t.Fatalf("expected one live game, got %#v", liveGames)
	}
	liveGame := liveGames[0]
	if liveGame.RedPlayer.Username != "Alice" || liveGame.BluePlayer.Username != "Bob" ||
		liveGame.RedElo != 1315 || liveGame.BlueElo != 1278 || liveGame.SpectatorCount != 0 {
		t.Fatalf("live game omitted public player details: %#v", liveGame)
	}
	if liveGame.Position.Rows[0] != "...SSS..." ||
		liveGame.Position.Owners[0] != "...bbb..." ||
		liveGame.CurrentTurn != game.FirstToMove || liveGame.MoveNumber != 0 {
		t.Fatalf("live game omitted its compact board position: %#v", liveGame)
	}

	spectator := &Client{
		send:    make(chan []byte, 4),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "live-watcher", Username: "Watcher"},
	}
	server.spectateGame(spectator, liveGame.GameID)
	joined := awaitMessageOfType(t, spectator, "spectator_joined")
	if joined.GameState == nil ||
		joined.GameState.GameID != liveGame.GameID || joined.Color != game.Neutral {
		t.Fatalf("unexpected spectator join response: %#v", joined)
	}
	if count := server.liveGames()[0].SpectatorCount; count != 1 {
		t.Fatalf("expected one spectator in the live table, got %d", count)
	}

	watchedSession := server.spectatorFor(spectator)
	server.broadcastGameState(watchedSession, watchedSession.game.Snapshot())
	updated := awaitMessageOfType(t, spectator, "game_state")
	if updated.GameState == nil {
		t.Fatalf("spectator did not receive game state: %#v", updated)
	}
	server.handleMessage(spectator, ClientMessage{Type: "make_move"})
	awaitMessageOfType(t, spectator, "move_rejected")

	server.disconnect(spectator)
	if server.spectatorFor(spectator) != nil || server.liveGames()[0].SpectatorCount != 0 {
		t.Fatal("disconnect should remove the spectator from the live game")
	}
}

func TestLiveGameBoardBroadcastsAfterEveryMove(t *testing.T) {
	server := New(nil)
	observer := &Client{send: make(chan []byte, 8), done: make(chan struct{})}
	server.hub.Register(observer)
	redClient := &Client{
		send:    make(chan []byte, 8),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "board-red", Username: "Alice"},
	}
	blueClient := &Client{
		send:    make(chan []byte, 8),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "board-blue", Username: "Bob"},
	}
	server.startConfiguredMatch(
		QueueEntry{Client: redClient, Setup: game.GameSetup{ModeID: game.ModeTotalWar}},
		QueueEntry{Client: blueClient, Setup: game.GameSetup{ModeID: game.ModeTotalWar}},
		matchSetup{},
	)
	started := awaitMessageOfType(t, observer, "live_games")
	if len(started.LiveGames) != 1 || started.LiveGames[0].MoveNumber != 0 {
		t.Fatalf("expected the opening board in the lobby, got %#v", started.LiveGames)
	}

	// Blue opens, and advances up the ranks: d3-d4 off its own rock rank.
	if !server.makeMove(blueClient, game.Position{X: 3, Y: 2}, game.Position{X: 3, Y: 3}) {
		t.Fatal("expected the opening move to be accepted")
	}
	updated := awaitMessageOfType(t, observer, "live_games")
	if len(updated.LiveGames) != 1 {
		t.Fatalf("expected one updated board, got %#v", updated.LiveGames)
	}
	live := updated.LiveGames[0]
	if live.MoveNumber != 1 || live.CurrentTurn != game.Red ||
		live.Position.Rows[3][3] != 'R' || live.Position.Rows[2][3] != '.' ||
		live.Position.Owners[3][3] != 'b' || live.Position.Owners[2][3] != 'b' {
		t.Fatalf("lobby board did not follow the move: %#v", live)
	}
}

func TestPlayersAndSpectatorsShareAuthenticatedGameChat(t *testing.T) {
	server := New(nil)
	redClient := &Client{
		send:    make(chan []byte, 8),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "chat-red", Username: "Alice"},
		account: persistence.Account{UserID: "chat-red", Elo: 1200},
	}
	blueClient := &Client{
		send:    make(chan []byte, 8),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "chat-blue", Username: "Bob"},
		account: persistence.Account{UserID: "chat-blue", Elo: 1200},
	}
	server.startConfiguredMatch(
		QueueEntry{Client: redClient, Setup: game.GameSetup{ModeID: game.ModeInfiltration}, Elo: 1200},
		QueueEntry{Client: blueClient, Setup: game.GameSetup{ModeID: game.ModeInfiltration}, Elo: 1200},
		matchSetup{},
	)
	redMatch := readClientMessage(t, redClient)
	_ = readClientMessage(t, blueClient)

	spectator := &Client{
		send:    make(chan []byte, 8),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "chat-watcher", Username: "Casey"},
	}
	server.spectateGame(spectator, redMatch.GameState.GameID)
	_ = readClientMessage(t, spectator)

	server.handleMessage(spectator, ClientMessage{Type: "send_chat", Text: "Good luck!"})
	for _, client := range []*Client{redClient, blueClient, spectator} {
		message := awaitMessageOfType(t, client, "chat_message")
		if message.ChatMessage == nil ||
			message.ChatMessage.SenderName != "Casey" ||
			message.ChatMessage.SenderRole != "spectator" ||
			message.ChatMessage.Text != "Good luck!" {
			t.Fatalf("client received incorrect spectator chat: %#v", message)
		}
	}

	server.handleMessage(redClient, ClientMessage{Type: "send_chat", Text: "Thanks!"})
	redChat := awaitMessageOfType(t, redClient, "chat_message")
	awaitMessageOfType(t, blueClient, "chat_message")
	playerChat := awaitMessageOfType(t, spectator, "chat_message")
	if redChat.ChatMessage == nil || playerChat.ChatMessage == nil ||
		playerChat.ChatMessage.SenderName != "Alice" ||
		playerChat.ChatMessage.SenderRole != "player" ||
		playerChat.ChatMessage.SenderColor != game.Red {
		t.Fatalf("authenticated player identity was not preserved in chat: %#v", playerChat)
	}

	lateSpectator := &Client{
		send:    make(chan []byte, 4),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "late-watcher", Username: "Late watcher"},
	}
	server.spectateGame(lateSpectator, redMatch.GameState.GameID)
	joined := awaitMessageOfType(t, lateSpectator, "spectator_joined")
	if len(joined.ChatMessages) != 2 || joined.ChatMessages[0].Text != "Good luck!" ||
		joined.ChatMessages[1].Text != "Thanks!" {
		t.Fatalf("spectator did not receive chat history: %#v", joined.ChatMessages)
	}
}

func readClientMessage(t *testing.T, client *Client) ServerMessage {
	t.Helper()
	select {
	case encoded := <-client.send:
		var message ServerMessage
		if err := json.Unmarshal(encoded, &message); err != nil {
			t.Fatal(err)
		}
		return message
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for server message")
		return ServerMessage{}
	}
}

func TestFinishedRankedGameMovesOnlyThePlayedModesRating(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	server := NewWithStore(data, nil)

	clients := make([]*Client, 0, 2)
	for _, userID := range []string{"rated-red", "rated-blue"} {
		account, err := data.EnsureAccount(t.Context(), userID, userID)
		if err != nil {
			t.Fatal(err)
		}
		clients = append(clients, &Client{
			send:    make(chan []byte, 8),
			done:    make(chan struct{}),
			profile: game.PlayerProfile{UserID: userID, Username: userID},
			account: account,
		})
	}
	redClient, blueClient := clients[0], clients[1]

	entryTime := time.Now()
	server.startConfiguredMatch(
		QueueEntry{
			Client:   redClient,
			Setup:    game.GameSetup{ModeID: game.ModeTotalWar},
			Elo:      matchmakingElo(redClient, game.ModeTotalWar),
			JoinedAt: entryTime,
		},
		QueueEntry{
			Client:   blueClient,
			Setup:    game.GameSetup{ModeID: game.ModeTotalWar},
			Elo:      matchmakingElo(blueClient, game.ModeTotalWar),
			JoinedAt: entryTime,
		},
		matchSetup{},
	)
	_ = readClientMessage(t, redClient)
	_ = readClientMessage(t, blueClient)

	server.resign(blueClient)
	final := awaitMessageOfType(t, redClient, "game_state")
	if final.RatingUpdate == nil || final.RatingUpdate.ModeID != game.ModeTotalWar ||
		final.RatingUpdate.RedEloAfter <= final.RatingUpdate.RedEloBefore {
		t.Fatalf("unexpected rating update: %#v", final.RatingUpdate)
	}
	won := final.RatingUpdate.RedEloAfter

	// The connection keeps playing, so its in-memory account has to carry the
	// new Total War rating while every other mode stays on the shared seed.
	if got := matchmakingElo(redClient, game.ModeTotalWar); got != won {
		t.Fatalf("expected the winner to queue at %d, got %d", won, got)
	}
	if got := matchmakingElo(blueClient, game.ModeTotalWar); got != final.RatingUpdate.BlueEloAfter {
		t.Fatalf("expected the loser to queue at %d, got %d",
			final.RatingUpdate.BlueEloAfter, got)
	}
	if got := matchmakingElo(redClient, game.ModeInfiltration); got != persistence.RatingFloor {
		t.Fatalf("Infiltration must not inherit the Total War result, got %d", got)
	}

	stored, err := data.Account(t.Context(), "rated-red")
	if err != nil {
		t.Fatal(err)
	}
	if stored.ModeElo(game.ModeTotalWar) != won || stored.Elo != persistence.RatingFloor {
		t.Fatalf("unexpected stored account: %#v", stored)
	}
}

func TestChatOutlivesTheGameUntilEveryoneLeaves(t *testing.T) {
	server := New(nil)
	redClient := &Client{
		send:    make(chan []byte, 8),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "post-red", Username: "Alice"},
	}
	blueClient := &Client{
		send:    make(chan []byte, 8),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "post-blue", Username: "Bob"},
	}
	server.startConfiguredMatch(
		QueueEntry{Client: redClient, Setup: game.GameSetup{ModeID: game.ModeInfiltration, TimeControl: game.DefaultTimeControl()}},
		QueueEntry{Client: blueClient, Setup: game.GameSetup{ModeID: game.ModeInfiltration, TimeControl: game.DefaultTimeControl()}},
		matchSetup{},
	)
	redMatch := readClientMessage(t, redClient)
	_ = readClientMessage(t, blueClient)
	gameID := redMatch.GameState.GameID

	spectator := &Client{
		send:    make(chan []byte, 8),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "post-watcher", Username: "Casey"},
	}
	server.spectateGame(spectator, gameID)
	_ = readClientMessage(t, spectator)

	server.resign(redClient)
	for _, client := range []*Client{redClient, blueClient, spectator} {
		final := awaitMessageOfType(t, client, "game_state")
		if final.GameState == nil || final.GameState.Status != game.Finished {
			t.Fatalf("expected a final game state, got %#v", final)
		}
	}
	// The result is not the end of the room, so everyone still in it is told
	// how many people that is. A client reading the count off the lobby's live
	// table has nothing to read once the game leaves it.
	for _, client := range []*Client{redClient, blueClient, spectator} {
		presence := awaitMessageOfType(t, client, "chat_presence")
		if presence.ChatOccupancy != 3 {
			t.Fatalf("expected three people in the finished game's room, got %#v", presence)
		}
	}
	if server.participantFor(redClient) != nil || server.spectatorFor(spectator) != nil {
		t.Fatal("a finished game should release its players and spectators")
	}

	server.handleMessage(blueClient, ClientMessage{Type: "send_chat", Text: "good game"})
	for _, client := range []*Client{redClient, blueClient, spectator} {
		message := awaitMessageOfType(t, client, "chat_message")
		if message.ChatMessage == nil ||
			message.ChatMessage.SenderRole != "player" ||
			message.ChatMessage.SenderColor != game.Blue ||
			message.ChatMessage.Text != "good game" {
			t.Fatalf("expected chat to keep working after the result: %#v", message)
		}
	}

	// A player who reconnects rejoins the room and catches up on the chat.
	server.disconnect(blueClient)
	returningBlue := &Client{
		send:    make(chan []byte, 8),
		done:    make(chan struct{}),
		profile: blueClient.profile,
	}
	server.rejoinGame(returningBlue, gameID)
	rejoined := awaitMessageOfType(t, returningBlue, "game_rejoined")
	if rejoined.Color != game.Blue || rejoined.ChatOccupancy != 3 ||
		len(rejoined.ChatMessages) != 1 || rejoined.ChatMessages[0].Text != "good game" {
		t.Fatalf("expected the returning player to rejoin the chat room: %#v", rejoined)
	}

	server.handleMessage(spectator, ClientMessage{Type: "leave_game"})
	// Somebody leaving is the other half of the count: the room reports itself
	// again rather than leaving a stale figure on the two people still in it.
	if presence := awaitMessageOfType(t, redClient, "chat_presence"); presence.ChatOccupancy != 2 {
		t.Fatalf("expected the room to lose the spectator, got %#v", presence)
	}
	server.handleMessage(returningBlue, ClientMessage{Type: "send_chat", Text: "you too"})
	kept := awaitMessageOfType(t, redClient, "chat_message")
	if kept.ChatMessage.Text != "you too" {
		t.Fatalf("expected the room to survive the spectator leaving: %#v", kept)
	}
	awaitMessageOfType(t, returningBlue, "chat_message")

	server.handleMessage(returningBlue, ClientMessage{Type: "leave_game"})
	server.handleMessage(redClient, ClientMessage{Type: "leave_game"})
	server.mu.RLock()
	openRooms := len(server.postGameRooms)
	roomMembers := len(server.postGameMembers)
	server.mu.RUnlock()
	if openRooms != 0 || roomMembers != 0 {
		t.Fatalf("expected the room to close behind the last member, got %d rooms and %d members", openRooms, roomMembers)
	}

	server.handleMessage(redClient, ClientMessage{Type: "send_chat", Text: "anyone still here?"})
	closed := awaitMessageOfType(t, redClient, "chat_rejected")
	if closed.Type != "chat_rejected" {
		t.Fatalf("expected a closed room to refuse chat, got %#v", closed)
	}
}

func TestAgreedTimeExtensionAddsThreeMinutesForBothPlayers(t *testing.T) {
	server := New(nil)
	redClient := &Client{
		send:    make(chan []byte, 8),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "extend-red"},
	}
	blueClient := &Client{
		send:    make(chan []byte, 8),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "extend-blue"},
	}
	timeControl := game.TimeControl{InitialTimeMs: 60_000, IncrementMs: 0}
	server.startConfiguredMatch(
		QueueEntry{Client: redClient, Setup: game.GameSetup{ModeID: game.ModeInfiltration, TimeControl: timeControl}},
		QueueEntry{Client: blueClient, Setup: game.GameSetup{ModeID: game.ModeInfiltration, TimeControl: timeControl}},
		matchSetup{},
	)
	_ = readClientMessage(t, redClient)
	_ = readClientMessage(t, blueClient)

	server.handleMessage(blueClient, ClientMessage{Type: "accept_time"})
	awaitMessageOfType(t, blueClient, "action_rejected")

	// Red is to move, so Blue is asking while its own clock is stopped.
	server.handleMessage(blueClient, ClientMessage{Type: "offer_time"})
	offered := awaitMessageOfType(t, redClient, "game_state")
	awaitMessageOfType(t, blueClient, "game_state")
	if offered.GameState.TimeOfferedBy != game.Blue {
		t.Fatalf("expected Blue's off-turn time request to be broadcast, got %#v", offered)
	}

	server.handleMessage(redClient, ClientMessage{Type: "accept_time"})
	extended := awaitMessageOfType(t, redClient, "game_state")
	awaitMessageOfType(t, blueClient, "game_state")
	if extended.GameState.Status != game.InProgress ||
		extended.GameState.TimeOfferedBy != "" {
		t.Fatalf("expected the game to continue with the offer consumed, got %#v", extended)
	}
	clock := extended.GameState.Clock
	if clock.BlueRemainingMs != timeControl.InitialTimeMs+game.TimeExtensionMs {
		t.Fatalf("expected Blue to gain three minutes, got %dms", clock.BlueRemainingMs)
	}
	if clock.RedRemainingMs <= timeControl.InitialTimeMs ||
		clock.RedRemainingMs > timeControl.InitialTimeMs+game.TimeExtensionMs {
		t.Fatalf("expected Red to gain roughly three minutes, got %dms", clock.RedRemainingMs)
	}
}

// A spectator arriving at a game in progress is handed the moves that made the
// position, not just the position. Everything the board screens do with a
// history — the move list, stepping back through it — depends on this being on
// the join message rather than accumulated from what happens next, because
// somebody who joins at move twenty never sees the first nineteen.
func TestSpectatorJoiningMidGameReceivesTheMovesSoFar(t *testing.T) {
	server := New(nil)
	redClient := &Client{
		send:    make(chan []byte, 8),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "pgn-red", Username: "Alice"},
	}
	blueClient := &Client{
		send:    make(chan []byte, 8),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "pgn-blue", Username: "Bob"},
	}
	server.startConfiguredMatch(
		QueueEntry{Client: redClient, Setup: game.GameSetup{ModeID: game.ModeTotalWar}},
		QueueEntry{Client: blueClient, Setup: game.GameSetup{ModeID: game.ModeTotalWar}},
		matchSetup{},
	)
	match := readClientMessage(t, redClient)
	_ = readClientMessage(t, blueClient)

	// Blue opens; Red replies. Two moves are enough to tell a history apart
	// from an empty one, and to check the movetext replays.
	if !server.makeMove(blueClient, game.Position{X: 3, Y: 2}, game.Position{X: 3, Y: 3}) {
		t.Fatal("expected Blue's opening move to be accepted")
	}
	if !server.makeMove(redClient, game.Position{X: 3, Y: 6}, game.Position{X: 3, Y: 5}) {
		t.Fatal("expected Red's reply to be accepted")
	}

	spectator := &Client{
		send:    make(chan []byte, 8),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "pgn-watcher", Username: "Casey"},
	}
	server.spectateGame(spectator, match.GameState.GameID)
	joined := awaitMessageOfType(t, spectator, "spectator_joined")
	if joined.PGN == "" {
		t.Fatal("spectator joined a game in progress with no history to read")
	}

	parsed, err := notation.Parse(joined.PGN)
	if err != nil {
		t.Fatalf("the history handed to a spectator does not parse: %v", err)
	}
	if got := parsed.Record.PlyCount(); got != 2 {
		t.Fatalf("expected the two moves already played, got %d", got)
	}
	// Unfinished, and saying so: a client reading this must not think it is
	// looking at a result.
	if parsed.Result != notation.ResultUnfinished {
		t.Fatalf("a game in progress was written as %q", parsed.Result)
	}
	if parsed.Tag("GameId") != match.GameState.GameID {
		t.Fatalf("history names game %q, not the one being watched", parsed.Tag("GameId"))
	}

	// And it keeps up: the next move reaches the spectator with the move on it.
	if !server.makeMove(blueClient, game.Position{X: 4, Y: 2}, game.Position{X: 4, Y: 3}) {
		t.Fatal("expected Blue's second move to be accepted")
	}
	updated := awaitMessageOfType(t, spectator, "game_state")
	followed, err := notation.Parse(updated.PGN)
	if err != nil {
		t.Fatalf("the history on a state update does not parse: %v", err)
	}
	if got := followed.Record.PlyCount(); got != 3 {
		t.Fatalf("expected three moves after the third was played, got %d", got)
	}
}
