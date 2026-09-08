package server

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// drainChallengeTestMessages reads everything queued for a client, which is what
// the open board makes necessary: publishing it is a lobby-wide broadcast, so a
// client's channel holds its own reply *and* the new board.
func drainChallengeTestMessages(t *testing.T, client *Client) []ServerMessage {
	t.Helper()
	messages := make([]ServerMessage, 0, 4)
	for {
		select {
		case encoded := <-client.send:
			var message ServerMessage
			if err := json.Unmarshal(encoded, &message); err != nil {
				t.Fatal(err)
			}
			messages = append(messages, message)
		default:
			return messages
		}
	}
}

func messageOfType(messages []ServerMessage, wanted string) (ServerMessage, bool) {
	for _, message := range messages {
		if message.Type == wanted {
			return message, true
		}
	}
	return ServerMessage{}, false
}

// customOpenChallenge is a game offered to the room with something changed
// about it, which is what keeps it on the board: an open game with nothing
// changed is a plain matchmaking search, and is answered as one.
func customOpenChallenge(modeID game.ModeID) ClientMessage {
	return ClientMessage{
		Type:  "send_challenge",
		Setup: &game.GameSetup{ModeID: modeID, Casual: true},
	}
}

// Posting the standard game *is* joining the queue. Nothing was customized, so
// there is nothing to advertise that matchmaking was not already offering.
func TestOpenChallengeWithNothingCustomisedJoinsTheQueue(t *testing.T) {
	server := New(nil)
	challenger := challengeTestClient("challenger-id", "Alice")
	stranger := challengeTestClient("stranger-id", "Bob")
	server.hub.Register(challenger)
	server.hub.Register(stranger)

	server.handleMessage(challenger, ClientMessage{
		Type:   "send_challenge",
		ModeID: game.ModeTotalWar,
	})

	messages := drainChallengeTestMessages(t, challenger)
	if _, found := messageOfType(messages, "challenge_sent"); found {
		t.Fatal("a standard game offered to the room should not be posted as a challenge")
	}
	update, found := messageOfType(messages, "queue_update")
	if !found || update.Setup == nil || update.ModeID != game.ModeTotalWar {
		t.Fatalf("expected the author to be put in the queue: %#v", messages)
	}

	// It is still on the public board, because somebody in matchmaking is
	// somebody you can start a game with by clicking their row.
	board, found := messageOfType(drainChallengeTestMessages(t, stranger), "open_challenges")
	if !found || len(board.OpenChallenges) != 1 || !board.OpenChallenges[0].Queued {
		t.Fatalf("a searching player should appear on the board as queued: %#v", board)
	}
	if board.OpenChallenges[0].ExpiresAtUnixMs != 0 {
		t.Fatal("a plain search must not carry an expiry")
	}

	server.handleMessage(stranger, ClientMessage{
		Type:        "accept_challenge",
		ChallengeID: board.OpenChallenges[0].ID,
	})
	if _, found := messageOfType(drainChallengeTestMessages(t, stranger), "match_found"); !found {
		t.Fatal("a searching player's row must be takeable")
	}
	participant := server.participantFor(challenger)
	if participant == nil || !participant.session.ranked {
		t.Fatal("taking a standard game must start the rated game it describes")
	}
}

func TestOpenChallengeReachesTheWholeLobbyAndAnyoneCanTakeIt(t *testing.T) {
	server := New(nil)
	challenger := challengeTestClient("challenger-id", "Alice")
	stranger := challengeTestClient("stranger-id", "Bob")
	watcher := challengeTestClient("watcher-id", "Cleo")
	server.hub.Register(challenger)
	server.hub.Register(stranger)
	server.hub.Register(watcher)

	// No username: the challenge is offered to the room.
	server.handleMessage(challenger, customOpenChallenge(game.ModeTotalWar))

	sent, found := messageOfType(drainChallengeTestMessages(t, challenger), "challenge_sent")
	if !found || sent.Challenge == nil {
		t.Fatal("the author should be told their challenge is up")
	}
	if sent.Challenge.TargetUsername != "" || !sent.Challenge.IsOpen() {
		t.Fatalf("an untargeted challenge must be open: %#v", sent.Challenge)
	}

	board, found := messageOfType(drainChallengeTestMessages(t, watcher), "open_challenges")
	if !found || len(board.OpenChallenges) != 1 ||
		board.OpenChallenges[0].ID != sent.Challenge.ID {
		t.Fatalf("a bystander should see the open board: %#v", board)
	}

	// It is not in anybody's private inbox, because nobody was invited.
	if pending := server.pendingChallengesFor(stranger, time.Now()); len(pending) != 0 {
		t.Fatalf("an open challenge is not a personal invitation: %#v", pending)
	}

	server.handleMessage(stranger, ClientMessage{
		Type:        "accept_challenge",
		ChallengeID: sent.Challenge.ID,
	})

	if _, found := messageOfType(drainChallengeTestMessages(t, stranger), "match_found"); !found {
		t.Fatal("a stranger must be able to take an open challenge")
	}
	participant := server.participantFor(challenger)
	if participant == nil || participant.session.ranked {
		t.Fatal("a casual open challenge must start an unranked game")
	}
	if server.seeks.Len() != 0 {
		t.Fatal("a taken challenge must leave the board")
	}
}

// A withdrawal is one act on one object, and the author has to hear it in the
// vocabulary they were waiting in: a client told its *challenge* was cancelled
// has no reason to stop showing a search.
func TestWithdrawingAnnouncesTheKindOfSeekItWas(t *testing.T) {
	server := New(nil)
	searcher := challengeTestClient("searcher-id", "Ada")
	poster := challengeTestClient("poster-id", "Bo")
	server.hub.Register(searcher)
	server.hub.Register(poster)

	server.handleMessage(searcher, ClientMessage{Type: "join_queue", ModeID: game.ModeTotalWar})
	server.handleMessage(poster, customOpenChallenge(game.ModeTotalWar))
	update, _ := messageOfType(drainChallengeTestMessages(t, searcher), "queue_update")
	sent, _ := messageOfType(drainChallengeTestMessages(t, poster), "challenge_sent")
	if update.Type == "" || sent.Challenge == nil {
		t.Fatal("expected one search and one posted game")
	}

	// Both go through cancel_challenge, which is the button the board shows.
	server.handleMessage(searcher, ClientMessage{
		Type:        "cancel_challenge",
		ChallengeID: server.seeks.ForClient(searcher).ID,
	})
	messages := drainChallengeTestMessages(t, searcher)
	if _, found := messageOfType(messages, "queue_left"); !found {
		t.Fatalf("a cancelled search must be reported as a search: %#v", messages)
	}
	if _, found := messageOfType(messages, "challenge_cancelled"); found {
		t.Fatal("a search is not a challenge, and saying so leaves the client spinning")
	}

	server.handleMessage(poster, ClientMessage{
		Type:        "cancel_challenge",
		ChallengeID: sent.Challenge.ID,
	})
	posted := drainChallengeTestMessages(t, poster)
	if _, found := messageOfType(posted, "challenge_cancelled"); !found {
		t.Fatalf("a cancelled posted game must be reported as a challenge: %#v", posted)
	}
	if server.seeks.Len() != 0 {
		t.Fatal("both withdrawals should have emptied the board")
	}
}

func TestOpenChallengeCannotBeDeclinedOrSelfAccepted(t *testing.T) {
	server := New(nil)
	challenger := challengeTestClient("challenger-id", "Alice")
	stranger := challengeTestClient("stranger-id", "Bob")
	server.hub.Register(challenger)
	server.hub.Register(stranger)

	server.handleMessage(challenger, customOpenChallenge(game.ModeInfiltration))
	sent, _ := messageOfType(drainChallengeTestMessages(t, challenger), "challenge_sent")
	drainChallengeTestMessages(t, stranger)

	// Declining destroys a challenge. Letting a passer-by decline an invitation
	// that was never addressed to them would be a heckler's veto over the board.
	server.handleMessage(stranger, ClientMessage{
		Type:        "decline_challenge",
		ChallengeID: sent.Challenge.ID,
	})
	reply, found := messageOfType(drainChallengeTestMessages(t, stranger), "challenge_unavailable")
	if !found {
		t.Fatalf("a stranger must not be able to decline an open challenge: %#v", reply)
	}
	if server.seeks.Len() != 1 {
		t.Fatal("the open challenge should still be on the board")
	}

	// The author taking their own game would be a game against themselves.
	server.handleMessage(challenger, ClientMessage{
		Type:        "accept_challenge",
		ChallengeID: sent.Challenge.ID,
	})
	if _, found := messageOfType(drainChallengeTestMessages(t, challenger), "match_found"); found {
		t.Fatal("the author must not accept their own open challenge")
	}
}

func TestOnlyOneAcceptorWinsAnOpenChallenge(t *testing.T) {
	server := New(nil)
	challenger := challengeTestClient("challenger-id", "Alice")
	first := challengeTestClient("first-id", "Bob")
	second := challengeTestClient("second-id", "Cleo")
	for _, client := range []*Client{challenger, first, second} {
		server.hub.Register(client)
	}

	server.handleMessage(challenger, customOpenChallenge(game.ModeTotalWar))
	sent, _ := messageOfType(drainChallengeTestMessages(t, challenger), "challenge_sent")
	drainChallengeTestMessages(t, first)
	drainChallengeTestMessages(t, second)

	// Two people reaching for the same open seat at the same instant is the one
	// race a public board has that a private invitation never did.
	var waiting sync.WaitGroup
	for _, taker := range []*Client{first, second} {
		waiting.Add(1)
		go func(client *Client) {
			defer waiting.Done()
			server.handleMessage(client, ClientMessage{
				Type:        "accept_challenge",
				ChallengeID: sent.Challenge.ID,
			})
		}(taker)
	}
	waiting.Wait()

	matched := 0
	for _, client := range []*Client{first, second} {
		if _, found := messageOfType(drainChallengeTestMessages(t, client), "match_found"); found {
			matched++
		}
	}
	if matched != 1 {
		t.Fatalf("exactly one acceptor should get the game, got %d", matched)
	}
	if server.seeks.Len() != 0 {
		t.Fatal("the challenge should be gone either way")
	}
}

func TestOnlineCountCountsPeopleNotSockets(t *testing.T) {
	server := New(nil)
	// One person with two tabs open is one person.
	firstTab := challengeTestClient("ada", "Ada")
	secondTab := challengeTestClient("ada", "Ada")
	other := challengeTestClient("grace", "Grace")
	engine := challengeTestClient("bot-account", "Chomper")
	engine.bot = &botClient{botID: "bot-1", record: persistence.Bot{BotID: "bot-1"}, ready: true}
	for _, client := range []*Client{firstTab, secondTab, other, engine} {
		server.hub.Register(client)
	}

	// An engine is connected but is not somebody who is here.
	if count := server.onlineCount(); count != 2 {
		t.Fatalf("expected two people online, got %d", count)
	}

	server.hub.Unregister(secondTab)
	if count := server.onlineCount(); count != 2 {
		t.Fatalf("closing one of a person's two tabs should not change the count, got %d", count)
	}
	server.hub.Unregister(firstTab)
	if count := server.onlineCount(); count != 1 {
		t.Fatalf("expected one person online, got %d", count)
	}
}
