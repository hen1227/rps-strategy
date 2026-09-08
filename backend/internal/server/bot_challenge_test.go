package server

import (
	"testing"

	"rps-strategy/backend/internal/game"
)

// An engine challenge carries the seat its challenger wants, the same wish a
// posted seek spells inside its setup. The engine takes what is left: it has no
// preference, and beginBotGame prompts it from either side.
func openToChallenges(t *testing.T, server *Server, userID string) *Client {
	t.Helper()
	engine := fakeClient(t, server, userID, true)
	engine.bot.mu.Lock()
	engine.bot.record.AllowPublicPlay = true
	engine.bot.mu.Unlock()
	return engine
}

func seatOf(t *testing.T, server *Server, client *Client) game.PlayerColor {
	t.Helper()
	participant := server.participantFor(client)
	if participant == nil {
		t.Fatalf("%s is not seated in a game", client.profile.Username)
	}
	return participant.color
}

func TestChallengingAnEngineHonoursTheSeatTheChallengerAsked(t *testing.T) {
	for _, want := range []game.PlayerColor{game.Red, game.Blue} {
		t.Run(string(want), func(t *testing.T) {
			server := New(nil)
			human := fakeClient(t, server, "human", false)
			engine := openToChallenges(t, server, "engine")

			server.challengeBot(human, engine.bot.botID, game.ModeTotalWar, nil, want)

			if got := seatOf(t, server, human); got != want {
				t.Fatalf("asked for %s, got %s", want, got)
			}
			if got := seatOf(t, server, engine); got == want {
				t.Fatalf("both players were seated %s", got)
			}
		})
	}
}

// No preference seats the challenger Red — the side that moves first, and the
// courtesy every other challenge here carries. This is also what every client
// that predates the seat picker sends, so it is the behaviour they keep.
func TestChallengingAnEngineWithNoPreferenceSeatsTheChallengerRed(t *testing.T) {
	server := New(nil)
	human := fakeClient(t, server, "human", false)
	engine := openToChallenges(t, server, "engine")

	server.challengeBot(human, engine.bot.botID, game.ModeTotalWar, nil, "")

	if got := seatOf(t, server, human); got != game.Red {
		t.Fatalf("expected Red for a challenger who did not choose, got %s", got)
	}
}

// A seat that is not a seat is refused rather than quietly rounded to one, so a
// typo in a client cannot silently hand somebody the wrong colour.
func TestChallengingAnEngineRefusesASeatThatIsNotAColour(t *testing.T) {
	server := New(nil)
	human := fakeClient(t, server, "human", false)
	engine := openToChallenges(t, server, "engine")

	server.challengeBot(human, engine.bot.botID, game.ModeTotalWar, nil, game.PlayerColor("Green"))

	if server.participantFor(human) != nil {
		t.Fatal("a game should not have opened")
	}
	if _, ok := messageOfType(drain(human), "bot_unavailable"); !ok {
		t.Fatal("the challenger should be told why the game did not open")
	}
}
