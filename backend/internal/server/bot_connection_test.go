package server

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// fakeClient is the transport-free client the existing tests already use, plus
// an optional bot session.
func fakeClient(t *testing.T, server *Server, userID string, bot bool) *Client {
	t.Helper()
	client := &Client{
		send:    make(chan []byte, 64),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: userID, Username: userID},
		server:  server,
	}
	if bot {
		client.bot = &botClient{
			botID:  "bot-" + userID,
			record: persistence.Bot{BotID: "bot-" + userID, UserID: userID, Name: userID},
			ready:  true,
		}
		server.mu.Lock()
		server.bots[client.bot.botID] = client
		server.mu.Unlock()
	}
	server.hub.Register(client)
	t.Cleanup(func() { server.hub.Unregister(client) })
	return client
}

func drain(client *Client) []ServerMessage {
	messages := make([]ServerMessage, 0)
	for {
		select {
		case payload := <-client.send:
			var message ServerMessage
			if json.Unmarshal(payload, &message) == nil {
				messages = append(messages, message)
			}
		default:
			return messages
		}
	}
}

// The buffer that protects this is 256 slots and a bot spends most of a game
// blocked in a search, unable to drain it. An overrun closes the connection, so
// a bot that receives lobby chatter gets dropped mid-game — silently, and only
// on a busy server.
func TestBotsAreExcludedFromLobbyBroadcasts(t *testing.T) {
	server := New(nil)
	human := fakeClient(t, server, "human", false)
	bot := fakeClient(t, server, "engine", true)

	server.broadcastLiveGames()
	server.broadcastModePlayerCounts()
	server.broadcastBots()

	if len(drain(human)) == 0 {
		t.Fatal("a person should receive lobby broadcasts")
	}
	if messages := drain(bot); len(messages) != 0 {
		t.Fatalf("a bot must receive no lobby broadcasts, got %d: %#v", len(messages), messages)
	}
}

// A bot is sent RPSI lines instead of board snapshots, so the largest message
// in the protocol should never reach one.
func TestBotsDoNotReceiveBoardSnapshots(t *testing.T) {
	server := New(nil)
	human := fakeClient(t, server, "human", false)
	bot := fakeClient(t, server, "engine", true)

	session := server.startConfiguredMatch(
		testEntry(human), testEntry(bot), matchSetup{},
	)
	if session == nil {
		t.Fatal("expected a session")
	}
	server.broadcastGameState(session, session.game.Snapshot())

	for _, message := range drain(human) {
		if message.Type == "match_found" || message.Type == "game_state" {
			return
		}
	}
	t.Fatal("a person should receive the board")
}

// The regression for the ordering trap: startConfiguredMatch snapshots and
// announces the board before it returns, so an opening replayed by the caller
// would leave both engines searching a stale position and the faster one would
// lose for no reason.
func TestOpeningIsAppliedBeforeTheGameIsAnnounced(t *testing.T) {
	server := New(nil)
	red := fakeClient(t, server, "red", false)
	blue := fakeClient(t, server, "blue", false)

	opening, _, ok := buildOpening(server.registry, game.ModeTotalWar, 12345, 4)
	if !ok || len(opening) != 4 {
		t.Fatalf("expected a four-ply opening, got %d (ok=%v)", len(opening), ok)
	}

	session := server.startConfiguredMatch(
		testEntry(red), testEntry(blue), matchSetup{openingMoves: opening},
	)
	if session == nil {
		t.Fatal("expected a session")
	}

	var found bool
	for _, message := range drain(red) {
		if message.Type != "match_found" || message.GameState == nil {
			continue
		}
		found = true
		if message.GameState.MoveNumber < len(opening) {
			t.Fatalf(
				"match_found announced move %d, but %d book plies were dealt",
				message.GameState.MoveNumber, len(opening),
			)
		}
	}
	if !found {
		t.Fatal("no match_found was sent")
	}
	if session.bookPlies != len(opening) {
		t.Fatalf("session recorded %d book plies, expected %d", session.bookPlies, len(opening))
	}
}

// A pair is only fair if both games start from exactly the same board with the
// seats reversed. Mirroring the board instead would measure something else.
func TestAPairedOpeningIsIdenticalAndOnlyTheSeatsSwap(t *testing.T) {
	server := New(nil)
	for _, modeID := range []game.ModeID{game.ModeTotalWar, game.ModeInfiltration} {
		first, seed, ok := buildOpening(server.registry, modeID, 99, 6)
		if !ok {
			t.Fatalf("%s: no opening", modeID)
		}
		second, secondSeed, ok := buildOpening(server.registry, modeID, 99, 6)
		if !ok {
			t.Fatalf("%s: no opening on the second call", modeID)
		}
		if seed != secondSeed || len(first) != len(second) {
			t.Fatalf("%s: the same seed produced a different opening", modeID)
		}
		for index := range first {
			if first[index] != second[index] {
				t.Fatalf("%s: opening diverged at ply %d", modeID, index)
			}
		}
	}
}

// The generator is shared with the Rust arena and the JavaScript one, so a seed
// has to mean the same thing in all three. A refactor that quietly changed it
// would make cross-language comparisons wrong without failing anything.
func TestSplitMix64MatchesTheSharedReferenceStream(t *testing.T) {
	generator := newSplitMix64(0)
	expected := []uint64{
		0xe220a8397b1dcdaf,
		0x6e789e6aa1b965f4,
		0x06c45d188009454f,
	}
	for index, want := range expected {
		if got := generator.next(); got != want {
			t.Fatalf("draw %d: got %#016x, want %#016x", index, got, want)
		}
	}
}

func TestBuildOpeningRejectsAWalkThatEndsTheGame(t *testing.T) {
	server := New(nil)
	// Zero plies is a legitimate request and must not be treated as failure.
	moves, _, ok := buildOpening(server.registry, game.ModeTotalWar, 7, 0)
	if !ok || len(moves) != 0 {
		t.Fatalf("zero plies should succeed with no moves, got %d (ok=%v)", len(moves), ok)
	}
	// A long walk in Infiltration can reach the boundary and decide the game;
	// whatever comes back must still be a live position.
	if moves, _, ok := buildOpening(server.registry, game.ModeInfiltration, 3, 20); ok {
		scratch, err := game.NewGameWithRegistry(
			server.registry, "check", game.ModeInfiltration,
			game.PlayerProfile{UserID: "a"}, game.PlayerProfile{UserID: "b"},
		)
		if err != nil {
			t.Fatalf("new game: %v", err)
		}
		for _, move := range moves {
			state := scratch.Snapshot()
			if _, err := scratch.Move(state.CurrentTurn, move.From, move.To); err != nil {
				t.Fatalf("opening move rejected: %v", err)
			}
		}
		if scratch.Snapshot().Status != game.InProgress {
			t.Fatal("an accepted opening must leave a game still to play")
		}
	}
}

func testEntry(client *Client) QueueEntry {
	return QueueEntry{
		Client:   client,
		Setup:    game.GameSetup{ModeID: game.ModeTotalWar},
		Elo:      1200,
		JoinedAt: time.Now(),
	}
}

// The soft path: a client that still works but is not the current one is told
// where to get the new one instead of being disconnected. There is no version
// gap in the shipped build to exercise this at runtime, so the shape of the
// notice is pinned here — a mistyped JSON tag would otherwise be invisible
// until the first release that actually has one.
func TestBotReadyCarriesAnUpgradeNoticeWhenOneIsAvailable(t *testing.T) {
	quiet := botReadyMessage{Type: "bot_ready", BotID: "b", Name: "Quiet"}
	encoded, err := json.Marshal(quiet)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	if strings.Contains(string(encoded), "clientUpdate") {
		t.Fatalf("an up-to-date client must be told nothing: %s", encoded)
	}

	noticed := quiet
	noticed.ClientUpdate = &clientUpdate{Version: "1.1", URL: "https://example/rpsbot.py"}
	encoded, err = json.Marshal(noticed)
	if err != nil {
		t.Fatalf("encode: %v", err)
	}
	var decoded struct {
		ClientUpdate *struct {
			Version string `json:"version"`
			URL     string `json:"url"`
		} `json:"clientUpdate"`
	}
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if decoded.ClientUpdate == nil ||
		decoded.ClientUpdate.Version != "1.1" ||
		decoded.ClientUpdate.URL != "https://example/rpsbot.py" {
		t.Fatalf("the notice did not survive the wire: %s", encoded)
	}
}
