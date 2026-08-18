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

	var ready ServerMessage
	if err := connection.ReadJSON(&ready); err != nil {
		t.Fatal(err)
	}
	if ready.Type != "connection_ready" {
		t.Fatalf("expected connection_ready, got %q", ready.Type)
	}
	if len(ready.Modes) != 3 {
		t.Fatalf("expected three registered base modes, got %d", len(ready.Modes))
	}
	if ready.DefaultTimeControl == nil || *ready.DefaultTimeControl != game.DefaultTimeControl() {
		t.Fatalf("expected connection default 5/+3, got %#v", ready.DefaultTimeControl)
	}
	if ready.Account == nil || ready.Account.Elo != persistence.DefaultElo {
		t.Fatalf("expected a persisted default account, got %#v", ready.Account)
	}
	if len(ready.ModePlayerCounts) != 3 {
		t.Fatalf("expected a player count for every mode, got %#v", ready.ModePlayerCounts)
	}
	for _, modeID := range game.DefaultModeRegistry.IDs() {
		if ready.ModePlayerCounts[modeID] != 0 {
			t.Fatalf("expected no players in %s, got %#v", modeID, ready.ModePlayerCounts)
		}
	}

	if err := connection.WriteJSON(ClientMessage{Type: "join_queue", ModeID: game.ModeAnnihilation}); err != nil {
		t.Fatal(err)
	}
	for {
		var message ServerMessage
		if err := connection.ReadJSON(&message); err != nil {
			t.Fatal(err)
		}
		if message.Type == "queue_update" {
			if message.SearchRange != matchmakingInitialEloRange {
				t.Fatalf(
					"expected initial ±%d range, got %d",
					matchmakingInitialEloRange,
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

func TestPersistentAccountHistoryAndHeadToHeadRoutes(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	red := game.PlayerProfile{UserID: "route-red", Username: "Route Red"}
	blue := game.PlayerProfile{UserID: "route-blue", Username: "Route Blue"}
	newGame, err := game.NewGame("route-game", game.ModeAnnihilation, red, blue)
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
	if account.Wins != 1 || account.Elo != 1216 {
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
		ModeID:      game.ModeAnnihilation,
		TimeControl: &control,
	})

	entry, ok := server.matchmaking.Status(client)
	if !ok || entry.TimeControl != control {
		t.Fatalf("expected custom queue control %#v, got %#v", control, entry.TimeControl)
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
		ModeID:      game.ModeAnnihilation,
		TimeControl: &control,
	})

	if _, ok := server.matchmaking.Status(client); ok {
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

func TestModePlayerCountsIncludeActiveGamesAndMatchmaking(t *testing.T) {
	server := New(nil)
	server.matchmaking.Add(&Client{}, game.ModeAnnihilation)
	server.matchmaking.Add(&Client{}, game.ModeInfiltration)
	server.games["active-annihilation"] = &GameSession{modeID: game.ModeAnnihilation}

	counts := server.modePlayerCounts()
	if counts[game.ModeAnnihilation] != 3 {
		t.Fatalf("expected two active and one searching Annihilation players, got %#v", counts)
	}
	if counts[game.ModeInfiltration] != 1 {
		t.Fatalf("expected one searching Infiltration player, got %#v", counts)
	}
	if counts[game.ModeTotalWar] != 0 {
		t.Fatalf("expected zero Total War players, got %#v", counts)
	}
}

func TestQueueChangesBroadcastModePlayerCounts(t *testing.T) {
	server := New(nil)
	observer := &Client{send: make(chan []byte, 1), done: make(chan struct{})}
	server.hub.Register(observer)
	player := &Client{send: make(chan []byte, 2), done: make(chan struct{})}

	server.handleMessage(player, ClientMessage{
		Type:   "join_queue",
		ModeID: game.ModeAnnihilation,
	})
	var joined ServerMessage
	if err := json.Unmarshal(<-observer.send, &joined); err != nil {
		t.Fatal(err)
	}
	if joined.Type != "mode_player_counts" ||
		joined.ModePlayerCounts[game.ModeAnnihilation] != 1 {
		t.Fatalf("expected the queued player to be broadcast, got %#v", joined)
	}

	server.handleMessage(player, ClientMessage{Type: "leave_queue"})
	var left ServerMessage
	if err := json.Unmarshal(<-observer.send, &left); err != nil {
		t.Fatal(err)
	}
	if left.Type != "mode_player_counts" ||
		left.ModePlayerCounts[game.ModeAnnihilation] != 0 {
		t.Fatalf("expected the departed player to be removed, got %#v", left)
	}
}

func TestServerExpiresAndRemovesTimedOutSession(t *testing.T) {
	server := New(nil)
	redClient := &Client{send: make(chan []byte, 1), done: make(chan struct{})}
	blueClient := &Client{send: make(chan []byte, 1), done: make(chan struct{})}
	newGame, err := game.NewGameWithTimeControl(
		"server-timeout",
		game.ModeAnnihilation,
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
	newGame, err := game.NewGame("rejoin-session", game.ModeAnnihilation, redProfile, blueProfile)
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
		game.ModeAnnihilation,
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
	newGame, err := game.NewGame("abandon-session", game.ModeAnnihilation, redProfile, blueProfile)
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
		game.ModeAnnihilation,
		game.PlayerProfile{UserID: "red-user"},
		game.PlayerProfile{UserID: "blue-user"},
	)
	if err != nil {
		t.Fatal(err)
	}
	server.games["private-session"] = &GameSession{gameID: "private-session", game: newGame}
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
	newGame, err := game.NewGame("completed-session", game.ModeAnnihilation, redProfile, blueProfile)
	if err != nil {
		t.Fatal(err)
	}
	session := &GameSession{gameID: "completed-session", game: newGame}
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
