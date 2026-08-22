package server

import (
	"encoding/json"
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
	if challengerMatch.Type != "match_found" || challengerMatch.Color != game.Red {
		t.Fatalf("unexpected challenger match message: %#v", challengerMatch)
	}
	if targetMatch.Type != "match_found" || targetMatch.Color != game.Blue {
		t.Fatalf("unexpected target match message: %#v", targetMatch)
	}
	participant := server.participantFor(challenger)
	if participant == nil || participant.session.ranked {
		t.Fatal("accepted player challenges must start an unranked game")
	}
	if len(server.challenges) != 0 {
		t.Fatalf("accepted challenge was not removed: %#v", server.challenges)
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
	if len(server.challenges) != 1 {
		t.Fatal("a different username must not consume the challenge")
	}
}

func challengeTestClient(userID string, username string) *Client {
	return &Client{
		send:    make(chan []byte, 8),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: userID, Username: username},
		account: persistence.Account{UserID: userID, Username: username, Elo: persistence.DefaultElo},
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
