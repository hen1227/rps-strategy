package server

import (
	"encoding/json"
	"testing"

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

// A bot player still needs to hear that a real opponent is waiting, which is
// what the separate queue-only count is for.
func TestQueueCountsAreBroadcastSeparatelyFromTotals(t *testing.T) {
	server := New(nil)
	observer := &Client{send: make(chan []byte, 4), done: make(chan struct{})}
	server.hub.Register(observer)
	server.games["active-total-war"] = &GameSession{modeID: game.ModeTotalWar}
	searcher := &Client{send: make(chan []byte, 4), done: make(chan struct{})}

	server.handleMessage(searcher, ClientMessage{
		Type:   "join_queue",
		ModeID: game.ModeTotalWar,
	})
	broadcast := decodeLobbyMessage(t, <-observer.send)
	if broadcast.ModeQueueCounts[game.ModeTotalWar] != 1 {
		t.Fatalf("expected exactly the waiting player in the queue count, got %#v", broadcast)
	}
	if broadcast.ModePlayerCounts[game.ModeTotalWar] != 3 {
		t.Fatalf("expected the total to include the running game, got %#v", broadcast)
	}
}
