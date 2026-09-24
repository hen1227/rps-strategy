package server

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

func TestChallengeWaitsForNamedPlayerToConnect(t *testing.T) {
	server := New(nil)
	challenger := challengeTestClient("challenger-id", "Alice")
	server.hub.Register(challenger)

	server.handleMessage(challenger, ClientMessage{
		Type:     "send_challenge",
		Username: "  bOb  ",
		ModeID:   game.ModeTotalWar,
	})

	sent := readChallengeTestMessage(t, challenger)
	if sent.Type != "challenge_sent" || sent.Challenge == nil {
		t.Fatalf("expected challenge_sent, got %#v", sent)
	}
	if sent.Challenge.TargetUsername != "bOb" {
		t.Fatalf("expected trimmed target username, got %q", sent.Challenge.TargetUsername)
	}

	connectingPlayer := challengeTestClient("target-id", "Bob")
	pending := server.pendingChallengesFor(connectingPlayer, time.Now())
	if len(pending) != 1 || pending[0].ID != sent.Challenge.ID {
		t.Fatalf("expected challenge on the target's next connection, got %#v", pending)
	}
}

func TestConnectedPlayerCanAcceptChallenge(t *testing.T) {
	server := New(nil)
	challenger := challengeTestClient("challenger-id", "Alice")
	target := challengeTestClient("target-id", "Bob")
	server.hub.Register(challenger)
	server.hub.Register(target)

	server.handleMessage(challenger, ClientMessage{
		Type:     "send_challenge",
		Username: "Bob",
		ModeID:   game.ModeTotalWar,
	})
	sent := readChallengeTestMessage(t, challenger)
	received := readChallengeTestMessage(t, target)
	if received.Type != "challenge_received" || received.Challenge == nil ||
		received.Challenge.ID != sent.Challenge.ID {
		t.Fatalf("expected the connected target to receive the challenge, got %#v", received)
	}

	server.handleMessage(target, ClientMessage{
		Type:        "accept_challenge",
		ChallengeID: sent.Challenge.ID,
	})

	challengerMatch := readChallengeTestMessage(t, challenger)
	targetMatch := readChallengeTestMessage(t, target)
	// The author of a challenge gets the side that moves first.
	if challengerMatch.Type != "match_found" || challengerMatch.Color != game.FirstToMove {
		t.Fatalf("unexpected challenger match message: %#v", challengerMatch)
	}
	if targetMatch.Type != "match_found" ||
		targetMatch.Color != game.OtherColor(game.FirstToMove) {
		t.Fatalf("unexpected target match message: %#v", targetMatch)
	}
	participant := server.participantFor(challenger)
	// A challenge is a normal game with edits, so one that edited nothing is a
	// normal game — rated included. Casual is a knob its author can reach for,
	// not a property of having been challenged.
	if participant == nil || !participant.session.ranked {
		t.Fatal("a challenge that changed nothing must start the rated game it describes")
	}
	if server.seeks.Len() != 0 {
		t.Fatal("accepted challenge was not removed from the board")
	}
}

func TestCasualChallengeStartsAnUnratedGame(t *testing.T) {
	server := New(nil)
	challenger := challengeTestClient("challenger-id", "Alice")
	target := challengeTestClient("target-id", "Bob")
	server.hub.Register(challenger)
	server.hub.Register(target)

	server.handleMessage(challenger, ClientMessage{
		Type:     "send_challenge",
		Username: "Bob",
		Setup:    &game.GameSetup{ModeID: game.ModeTotalWar, Casual: true},
	})
	sent := readChallengeTestMessage(t, challenger)
	_ = readChallengeTestMessage(t, target)
	if sent.Challenge == nil || !sent.Challenge.Setup.Casual {
		t.Fatalf("challenge lost the casual flag: %#v", sent.Challenge)
	}

	server.handleMessage(target, ClientMessage{
		Type:        "accept_challenge",
		ChallengeID: sent.Challenge.ID,
	})
	_ = readChallengeTestMessage(t, challenger)
	_ = readChallengeTestMessage(t, target)
	participant := server.participantFor(challenger)
	if participant == nil || participant.session.ranked {
		t.Fatal("a casual challenge must start an unrated game")
	}
}

func TestAcceptedChallengeUsesCustomStartingPosition(t *testing.T) {
	server := New(nil)
	challenger := challengeTestClient("challenger-id", "Alice")
	target := challengeTestClient("target-id", "Bob")
	server.hub.Register(challenger)
	server.hub.Register(target)
	position := game.MustStartingPosition(
		".........",
		".........",
		"....R....",
		".........",
		".........",
		".........",
		"....r....",
		".........",
		".........",
	)

	// Decode the same JSON shape the frontend sends so the test covers the
	// WebSocket field name as well as the in-memory challenge path.
	encoded, err := json.Marshal(map[string]any{
		"type":             "send_challenge",
		"username":         "Bob",
		"modeId":           game.ModeTotalWar,
		"startingPosition": position,
	})
	if err != nil {
		t.Fatal(err)
	}
	var request ClientMessage
	if err := json.Unmarshal(encoded, &request); err != nil {
		t.Fatal(err)
	}
	server.handleMessage(challenger, request)
	sent := readChallengeTestMessage(t, challenger)
	_ = readChallengeTestMessage(t, target)
	if sent.Challenge == nil || sent.Challenge.Setup.StartingPosition != position {
		t.Fatalf("challenge omitted custom position: %#v", sent.Challenge)
	}

	server.handleMessage(target, ClientMessage{
		Type:        "accept_challenge",
		ChallengeID: sent.Challenge.ID,
	})
	challengerMatch := readChallengeTestMessage(t, challenger)
	_ = readChallengeTestMessage(t, target)
	if challengerMatch.GameState == nil ||
		challengerMatch.GameState.Mode.StartingPosition != position {
		t.Fatalf("match did not use custom position: %#v", challengerMatch.GameState)
	}
	for y, row := range position.Rows() {
		for x := range row {
			tile := challengerMatch.GameState.Grid[y][x]
			piece, owner := expectedStartingPiece(row[x])
			if tile.Occupant != piece || tile.OccupantOwner != owner {
				t.Fatalf(
					"custom position mismatch at (%d, %d): got %s/%s, want %s/%s",
					x,
					y,
					tile.Occupant,
					tile.OccupantOwner,
					piece,
					owner,
				)
			}
		}
	}
}

func expectedStartingPiece(symbol byte) (game.Piece, game.PlayerColor) {
	switch symbol {
	case 'R':
		return game.Rock, game.Blue
	case 'P':
		return game.Paper, game.Blue
	case 'S':
		return game.Scissors, game.Blue
	case 'r':
		return game.Rock, game.Red
	case 'p':
		return game.Paper, game.Red
	case 's':
		return game.Scissors, game.Red
	default:
		return game.Empty, game.Neutral
	}
}

func TestChallengeRejectsInvalidStartingPosition(t *testing.T) {
	server := New(nil)
	challenger := challengeTestClient("challenger-id", "Alice")
	server.hub.Register(challenger)
	// A row of the wrong width, not an empty board: an entirely empty position
	// is how a client says "whatever the mode uses", so it is filled in rather
	// than refused.
	invalid := game.StartingPosition{Layout: strings.Join([]string{
		"...",
		".........",
		".........",
		".........",
		".........",
		".........",
		".........",
		".........",
		".........",
	}, "/")}

	server.handleMessage(challenger, ClientMessage{
		Type:             "send_challenge",
		Username:         "Bob",
		ModeID:           game.ModeTotalWar,
		StartingPosition: &invalid,
	})

	response := readChallengeTestMessage(t, challenger)
	if response.Type != "challenge_rejected" {
		t.Fatalf("expected challenge_rejected, got %#v", response)
	}
	if server.seeks.Len() != 0 {
		t.Fatal("invalid custom position must not create a challenge")
	}
}

func TestChallengeCannotBeAcceptedByAnotherUsername(t *testing.T) {
	server := New(nil)
	challenger := challengeTestClient("challenger-id", "Alice")
	wrongTarget := challengeTestClient("wrong-id", "Charlie")
	server.hub.Register(challenger)
	server.hub.Register(wrongTarget)

	server.handleMessage(challenger, ClientMessage{
		Type:     "send_challenge",
		Username: "Bob",
		ModeID:   game.ModeTotalWar,
	})
	sent := readChallengeTestMessage(t, challenger)
	server.handleMessage(wrongTarget, ClientMessage{
		Type:        "accept_challenge",
		ChallengeID: sent.Challenge.ID,
	})

	response := readChallengeTestMessage(t, wrongTarget)
	if response.Type != "challenge_unavailable" {
		t.Fatalf("expected challenge_unavailable, got %#v", response)
	}
	if server.seeks.Len() != 1 {
		t.Fatal("a different username must not consume the challenge")
	}
}

func challengeTestClient(userID string, username string) *Client {
	return &Client{
		// The same buffer a real connection gets. A smaller one turns any burst
		// of lobby broadcasts into a closed client, which reads in a test as
		// "the server never sent it".
		send:    make(chan []byte, sendBuffer),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: userID, Username: username},
		// Registered, because ranked play requires an account and almost every
		// test in this package is about a rated game. One unregistered client
		// here would silently turn seventy-odd of them casual, and most would
		// keep passing while quietly asserting nothing.
		account: persistence.Account{
			UserID:     userID,
			Username:   username,
			Registered: true,
			Elo:        persistence.RatingFloor,
		},
	}
}

func readChallengeTestMessage(t *testing.T, client *Client) ServerMessage {
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
