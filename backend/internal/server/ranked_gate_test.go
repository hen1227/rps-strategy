package server

import (
	"testing"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// awaitMessage reads past lobby broadcasts to the reply being tested.
//
// A guest sitting in the lobby receives open_challenges and player counts
// whenever anybody else acts, so asserting on "the next message" would make
// these tests depend on how chatty the room happens to be.
func awaitMessage(t *testing.T, client *Client, wantType string) ServerMessage {
	t.Helper()
	var seen []string
	for range 16 {
		message := readChallengeTestMessage(t, client)
		if message.Type == wantType {
			return message
		}
		seen = append(seen, message.Type)
	}
	t.Fatalf("never received %q; saw %v", wantType, seen)
	return ServerMessage{}
}

// anonymousTestClient is challengeTestClient's opposite: a browser that has
// never signed in, which is what the ranked gate is about.
func anonymousTestClient(userID string, username string) *Client {
	client := challengeTestClient(userID, username)
	client.account.Registered = false
	return client
}

// Pressing Play as a guest still puts them in matchmaking — casually.
//
// The second half of this is the assertion that matters. Forcing Casual before
// `queued` is computed would leave them with a ten-minute expiring board
// posting instead of a queue place, and the game would still *work*, so the
// mistake would never announce itself. Only the message type tells them apart.
func TestAnAnonymousPlayerIsQueuedCasuallyRatherThanPosted(t *testing.T) {
	server := New(nil)
	guest := anonymousTestClient("guest-id", "Guest")
	server.hub.Register(guest)

	server.handleMessage(guest, ClientMessage{Type: "join_queue", ModeID: game.ModeTotalWar})

	update := awaitMessage(t, guest, "queue_update")
	if update.Setup == nil || update.Setup.Ranked() {
		t.Fatalf("a guest was queued for a rated game: %#v", update.Setup)
	}
	// And they are told, rather than left to compare setups field by field.
	awaitMessage(t, guest, "ranked_unavailable")

	// The seek on the board agrees with what the player was told.
	seek := server.seeks.ForClient(guest)
	if seek == nil {
		t.Fatal("no seek was posted")
	}
	if !seek.Queued {
		t.Fatal("a guest's search became an expiring board posting instead of a queue place")
	}
	if seek.Setup.Ranked() {
		t.Fatalf("the posted seek is still rated: %#v", seek.Setup)
	}
}

// The ordering hazard, on the path that can actually show it.
//
// join_queue sets fromQueue, which short-circuits the IsStandard check, so it
// cannot catch this. Writing out the standard game and posting it is the case
// where `queued` depends entirely on the setup still looking standard — and
// flipping Casual before that comparison makes it stop, turning a place in the
// queue into a ten-minute advertisement that expires.
func TestAnAnonymousStandardChallengeStillJoinsMatchmaking(t *testing.T) {
	server := New(nil)
	guest := anonymousTestClient("guest-id", "Guest")
	server.hub.Register(guest)

	// The standard game, written out longhand and offered to the room: the
	// same thing pressing Play produces, by the other route.
	definition, err := server.registry.New(game.ModeTotalWar)
	if err != nil {
		t.Fatal(err)
	}
	standard := game.StandardSetup(definition.Definition())
	server.handleMessage(guest, ClientMessage{
		Type:   "send_challenge",
		ModeID: game.ModeTotalWar,
		Setup:  &standard,
	})

	update := awaitMessage(t, guest, "queue_update")
	if update.Setup == nil || update.Setup.Ranked() {
		t.Fatalf("a guest was queued for a rated game: %#v", update.Setup)
	}
	seek := server.seeks.ForClient(guest)
	if seek == nil {
		t.Fatal("no seek was posted")
	}
	if !seek.Queued || !seek.ExpiresAt.IsZero() {
		t.Fatal("the guest's standard challenge became an expiring posting instead of a queue place")
	}
}

func TestASignedInPlayerStillQueuesRanked(t *testing.T) {
	server := New(nil)
	player := challengeTestClient("player-id", "Ada")
	server.hub.Register(player)

	server.handleMessage(player, ClientMessage{Type: "join_queue", ModeID: game.ModeTotalWar})

	update := awaitMessage(t, player, "queue_update")
	if update.Setup == nil {
		t.Fatalf("queue_update carried no setup: %#v", update)
	}
	if !update.Setup.Ranked() {
		t.Fatal("a signed-in player was downgraded to casual")
	}
}

// The asymmetry with postSeek, and the reason for it: the setup belongs to
// whoever posted it, so a guest is refused rather than quietly changing
// somebody else's rated game into a casual one.
func TestAnAnonymousPlayerCannotAcceptARankedChallenge(t *testing.T) {
	server := New(nil)
	poster := challengeTestClient("poster-id", "Ada")
	guest := anonymousTestClient("guest-id", "Guest")
	server.hub.Register(poster)
	server.hub.Register(guest)

	// A non-standard time control, so this is a *posted* rated game rather
	// than a queue entry: an open standard challenge is by definition joining
	// matchmaking, and matchmaking has nothing for anyone to accept.
	server.handleMessage(poster, ClientMessage{
		Type:   "send_challenge",
		ModeID: game.ModeTotalWar,
		Setup: &game.GameSetup{
			ModeID:      game.ModeTotalWar,
			TimeControl: game.TimeControl{InitialTimeMs: 90_000, IncrementMs: 2_000},
		},
	})
	sent := awaitMessage(t, poster, "challenge_sent")
	if sent.Challenge == nil {
		t.Fatalf("expected a posted challenge, got %#v", sent)
	}
	if !sent.Challenge.Setup.Ranked() {
		t.Fatalf("the fixture posted a casual game, so this proves nothing: %#v", sent.Challenge.Setup)
	}

	server.handleMessage(guest, ClientMessage{
		Type:        "accept_challenge",
		ChallengeID: sent.Challenge.ID,
	})
	awaitMessage(t, guest, "challenge_rejected")

	// The refusal must not have eaten the challenge on the way out. Three
	// branches further down accept_challenge claim the seek, and a gate placed
	// after any of them would destroy a third party's open game.
	if server.seeks.Get(sent.Challenge.ID) == nil {
		t.Fatal("refusing a guest destroyed the poster's challenge")
	}
}

func TestAnAnonymousPlayerMayAcceptACasualChallenge(t *testing.T) {
	server := New(nil)
	poster := challengeTestClient("poster-id", "Ada")
	guest := anonymousTestClient("guest-id", "Guest")
	server.hub.Register(poster)
	server.hub.Register(guest)

	server.handleMessage(poster, ClientMessage{
		Type:   "send_challenge",
		ModeID: game.ModeTotalWar,
		Setup:  &game.GameSetup{ModeID: game.ModeTotalWar, Casual: true},
	})
	sent := awaitMessage(t, poster, "challenge_sent")
	if sent.Challenge == nil {
		t.Fatalf("expected a posted challenge, got %#v", sent)
	}

	server.handleMessage(guest, ClientMessage{
		Type:        "accept_challenge",
		ChallengeID: sent.Challenge.ID,
	})
	for range 16 {
		switch reply := readChallengeTestMessage(t, guest); reply.Type {
		case "challenge_rejected":
			t.Fatalf("a guest was refused a casual game: %s", reply.Message)
		case "match_found":
			if reply.Setup != nil && reply.Setup.Ranked() {
				t.Fatal("the guest was seated at a rated game after all")
			}
			return
		}
	}
	t.Fatal("the casual game never started for the guest")
}

// A bot account has no password and no Discord identity, so it reads as
// unregistered. Gating on that without exempting bots would quietly turn every
// ranked bot-versus-bot series casual — which is why the gate lives at these
// two entry points and asks isBot as well.
func TestRankedIsStillAllowedForBots(t *testing.T) {
	engine := challengeTestClient("bot-account", "MyBot")
	engine.account = persistence.Account{
		UserID: "bot-account", Kind: persistence.AccountKindBot, Registered: false,
	}
	engine.bot = &botClient{}

	if !rankedAllowed(engine) {
		t.Fatal("a bot was refused ranked play")
	}
}
