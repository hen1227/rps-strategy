package server

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"rps-strategy/backend/internal/game"
)

func decodeLobbyMessage(t *testing.T, payload []byte) ServerMessage {
	t.Helper()
	var message ServerMessage
	if err := json.Unmarshal(payload, &message); err != nil {
		t.Fatal(err)
	}
	return message
}

func TestBotSessionIsBroadcastAndCleared(t *testing.T) {
	server := New(nil)
	observer := &Client{send: make(chan []byte, 4), done: make(chan struct{})}
	server.hub.Register(observer)
	player := &Client{send: make(chan []byte, 4), done: make(chan struct{})}
	server.hub.Register(player)

	server.handleMessage(player, ClientMessage{
		Type:   "bot_session_start",
		ModeID: game.ModeTotalWar,
	})
	started := decodeLobbyMessage(t, <-observer.send)
	if started.Type != "mode_player_counts" || started.BotPlayerCount != 1 {
		t.Fatalf("expected one bot player to be broadcast, got %#v", started)
	}
	// A bot game is not a queued player and not a live game, so it must not
	// inflate the per-mode populations the lobby shows for real matches.
	if started.ModePlayerCounts[game.ModeTotalWar] != 0 {
		t.Fatalf("a bot game must not count as a Total War player, got %#v", started)
	}

	// Re-announcing the same session is what a reconnect does; it must not
	// double-count the player.
	server.handleMessage(player, ClientMessage{
		Type:   "bot_session_start",
		ModeID: game.ModeTotalWar,
	})
	if count := server.botPlayerCount(); count != 1 {
		t.Fatalf("expected a repeat announcement to be idempotent, got %d", count)
	}

	server.handleMessage(player, ClientMessage{Type: "bot_session_end"})
	ended := decodeLobbyMessage(t, <-observer.send)
	if ended.Type != "mode_player_counts" || ended.BotPlayerCount != 0 {
		t.Fatalf("expected the bot player to be removed, got %#v", ended)
	}
}

func TestBotSessionRejectsUnknownMode(t *testing.T) {
	server := New(nil)
	player := &Client{send: make(chan []byte, 2), done: make(chan struct{})}

	server.handleMessage(player, ClientMessage{
		Type:   "bot_session_start",
		ModeID: game.ModeID("V99"),
	})
	response := decodeLobbyMessage(t, <-player.send)
	if response.Type != "error" {
		t.Fatalf("expected an error for an unknown mode, got %#v", response)
	}
	if count := server.botPlayerCount(); count != 0 {
		t.Fatalf("expected no bot session to be recorded, got %d", count)
	}
}

func TestDisconnectClearsBotSession(t *testing.T) {
	server := New(nil)
	player := &Client{send: make(chan []byte, 4), done: make(chan struct{})}
	server.hub.Register(player)

	server.handleMessage(player, ClientMessage{
		Type:   "bot_session_start",
		ModeID: game.ModeInfiltration,
	})
	if count := server.botPlayerCount(); count != 1 {
		t.Fatalf("expected the bot session to be recorded, got %d", count)
	}

	server.disconnect(player)
	if count := server.botPlayerCount(); count != 0 {
		t.Fatalf("expected disconnecting to clear the bot session, got %d", count)
	}
}

func TestBotPlayerCountDeduplicatesConnectionsForSamePerson(t *testing.T) {
	server := New(nil)
	first := &Client{
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "same-player"},
		send:    make(chan []byte, 4),
	}
	second := &Client{
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "same-player"},
		send:    make(chan []byte, 4),
	}
	other := &Client{
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "other-player"},
		send:    make(chan []byte, 4),
	}

	server.startBotSession(first, game.ModeTotalWar)
	server.startBotSession(second, game.ModeInfiltration)
	if count := server.botPlayerCount(); count != 1 {
		t.Fatalf("reconnect overlap for one person must count once, got %d", count)
	}

	server.startBotSession(other, game.ModeTotalWar)
	if count := server.botPlayerCount(); count != 2 {
		t.Fatalf("two different people must count twice, got %d", count)
	}

	server.disconnect(first)
	if count := server.botPlayerCount(); count != 2 {
		t.Fatalf("disconnecting one of two sessions must leave that person active, got %d", count)
	}
	server.disconnect(second)
	if count := server.botPlayerCount(); count != 1 {
		t.Fatalf("disconnecting the person's last session must remove them, got %d", count)
	}
}

func TestWebSocketDisconnectBroadcastsClearedBotCount(t *testing.T) {
	server := New(nil)
	httpServer := httptest.NewServer(server.Routes())
	defer httpServer.Close()
	websocketURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"

	connect := func(userID string) *websocket.Conn {
		t.Helper()
		connection, _, err := websocket.DefaultDialer.Dial(websocketURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := connection.WriteJSON(ClientMessage{
			Type:       "authenticate",
			UserID:     userID,
			ProfileKey: "0123456789abcdef0123456789abcdef",
		}); err != nil {
			_ = connection.Close()
			t.Fatal(err)
		}
		var ready ServerMessage
		if err := connection.ReadJSON(&ready); err != nil {
			_ = connection.Close()
			t.Fatal(err)
		}
		if ready.Type != "connection_ready" {
			_ = connection.Close()
			t.Fatalf("expected connection_ready, got %#v", ready)
		}
		return connection
	}
	readCount := func(connection *websocket.Conn, want int) {
		t.Helper()
		_ = connection.SetReadDeadline(time.Now().Add(2 * time.Second))
		for {
			var message ServerMessage
			if err := connection.ReadJSON(&message); err != nil {
				t.Fatalf("waiting for bot player count %d: %v", want, err)
			}
			if message.Type == "mode_player_counts" && message.BotPlayerCount == want {
				return
			}
		}
	}

	observer := connect("bot-presence-observer")
	defer observer.Close()
	player := connect("disconnecting-bot-player")
	if err := player.WriteJSON(ClientMessage{
		Type:   "bot_session_start",
		ModeID: game.ModeTotalWar,
	}); err != nil {
		t.Fatal(err)
	}
	readCount(observer, 1)

	if err := player.Close(); err != nil {
		t.Fatal(err)
	}
	readCount(observer, 0)
}

// A bot player still needs to hear that a real opponent is waiting, which is
// what the separate queue-only count is for.
func TestQueueCountsAreBroadcastSeparatelyFromTotals(t *testing.T) {
	server := New(nil)
	observer := &Client{send: make(chan []byte, 4), done: make(chan struct{})}
	server.hub.Register(observer)
	server.games["active-total-war"] = &GameSession{
		modeID: game.ModeTotalWar,
		chat:   newChatRoom("active-total-war"),
	}
	searcher := &Client{send: make(chan []byte, 4), done: make(chan struct{})}

	server.handleMessage(searcher, ClientMessage{
		Type:   "join_queue",
		ModeID: game.ModeTotalWar,
	})
	broadcast := awaitMessageOfType(t, observer, "mode_player_counts")
	if broadcast.ModeQueueCounts[game.ModeTotalWar] != 1 {
		t.Fatalf("expected exactly the waiting player in the queue count, got %#v", broadcast)
	}
	if broadcast.ModePlayerCounts[game.ModeTotalWar] != 3 {
		t.Fatalf("expected the total to include the running game, got %#v", broadcast)
	}
}
