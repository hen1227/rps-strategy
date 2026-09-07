package server

import (
	"strings"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
)

// benchNow puts every engine on a bench for the length of one test, and answers
// an instant inside it.
//
// The declared schedule is replaced rather than the clock moved, because the
// clock is time.Now() in production code and the schedule is the thing under
// test. Restored on cleanup, so a test that benches the world does not bench
// the ones after it.
func benchNow(t *testing.T, reason string) {
	t.Helper()
	original := botBenchWindows
	t.Cleanup(func() { botBenchWindows = original })
	now := time.Now()
	botBenchWindows = []botBenchWindow{{
		reason:     reason,
		untilLabel: "6 PM Eastern",
		from:       now.Add(-time.Hour),
		until:      now.Add(time.Hour),
	}}
}

// The window this was written for, asserted as the event rather than as two
// timestamps: the tournament is at noon Eastern on 5 September 2026, and the
// engines are meant to be off from half an hour before it until six.
//
// Worth a test because the dates are the one part of this feature nobody finds
// out is wrong until the afternoon it matters.
func TestTheTournamentBenchCoversTheTournament(t *testing.T) {
	eastern := time.FixedZone("EDT", -4*60*60)
	cases := []struct {
		when    time.Time
		benched bool
		what    string
	}{
		{time.Date(2026, time.September, 5, 11, 0, 0, 0, eastern), false, "an hour before"},
		{time.Date(2026, time.September, 5, 11, 30, 0, 0, eastern), true, "the moment it opens"},
		{time.Date(2026, time.September, 5, 12, 0, 0, 0, eastern), true, "the first round"},
		{time.Date(2026, time.September, 5, 17, 59, 0, 0, eastern), true, "a minute before six"},
		{time.Date(2026, time.September, 5, 18, 0, 0, 0, eastern), false, "six exactly"},
		{time.Date(2026, time.September, 6, 12, 0, 0, 0, eastern), false, "the next day"},
	}
	for _, testCase := range cases {
		if botsAreBenched(testCase.when) != testCase.benched {
			t.Errorf(
				"%s (%s): benched = %t, wanted %t",
				testCase.what,
				testCase.when.Format(time.RFC3339),
				!testCase.benched,
				testCase.benched,
			)
		}
	}
}

// The point of the whole thing: a benched engine takes no games. Asserted
// through challengeBot rather than through botIsDraining, because a refusal
// that never reaches the person who pressed the button is not a refusal.
func TestABenchedEngineRefusesAChallengeAndSaysWhy(t *testing.T) {
	benchNow(t, "the official Intransitive tournament on meaf.us/rps2")
	server := New(nil)
	human := fakeClient(t, server, "human", false)
	engine := openToChallenges(t, server, "engine")

	server.challengeBot(human, engine.bot.botID, game.ModeTotalWar, nil, game.Red)

	if server.participantFor(engine) != nil {
		t.Fatal("a benched engine was seated in a game")
	}
	refusal, ok := messageOfType(drain(human), "bot_unavailable")
	if !ok {
		t.Fatal("the challenger was not told the engine is unavailable")
	}
	// The wording is the reason this is a field of its own rather than a reuse
	// of the drain: "shutting down" is a false thing to say about an engine
	// whose owner has not touched it and which is back at six.
	if strings.Contains(refusal.Message, "shutting down") {
		t.Errorf("a benched engine was described as shutting down: %q", refusal.Message)
	}
	if !strings.Contains(refusal.Message, "meaf.us/rps2") {
		t.Errorf("the refusal does not say what the bench is for: %q", refusal.Message)
	}
	// In the timezone the event was announced in, not the server's. See
	// botBenchWindow.untilLabel.
	if !strings.Contains(refusal.Message, "6 PM Eastern") {
		t.Errorf("the refusal does not say when the engines are back: %q", refusal.Message)
	}
}

// The lobby has to be able to tell the two apart, because it says different
// words for each and the bench applies to engines nobody has asked to stop.
func TestTheRosterPublishesABenchRatherThanAShutdown(t *testing.T) {
	benchNow(t, "a tournament")
	server := New(nil)
	engine := openToChallenges(t, server, "engine")

	roster := server.botRoster()
	if len(roster) != 1 {
		t.Fatalf("expected one engine on the roster, got %d", len(roster))
	}
	if !roster[0].Benched {
		t.Error("a benched engine is not published as benched")
	}
	if roster[0].Draining {
		t.Error("a benched engine is published as draining, which its owner never asked for")
	}
	// And the owner's own view of it, which is where a phantom drain would come
	// with a Resume button that could not work.
	if botHasOwnDrain(engine) {
		t.Error("a bench was reported as a drain the owner started")
	}
	// Enforcement still runs through the one question every offer path asks.
	if !botIsDraining(engine) {
		t.Error("a benched engine is still being offered games")
	}
}

// The state is published whether or not a bench is running, so that a page can
// warn people the ladder closes at half past instead of only explaining it
// afterwards.
func TestTheBenchStateDescribesTheNextWindowWhenNoneIsRunning(t *testing.T) {
	original := botBenchWindows
	t.Cleanup(func() { botBenchWindows = original })
	soon := time.Now().Add(time.Hour)
	botBenchWindows = []botBenchWindow{{
		reason:     "a tournament",
		untilLabel: "six",
		from:       soon,
		until:      soon.Add(time.Hour),
	}}

	state := botBenchState(time.Now())
	if state.Active {
		t.Error("a bench that has not started is reported as running")
	}
	if state.FromUnixMs != soon.UnixMilli() {
		t.Errorf("the coming bench is not described: %+v", state)
	}
}

// Nothing scheduled is the ordinary state of this server, and it must publish
// as nothing rather than as a window at the zero time.
func TestNoScheduledBenchPublishesNothing(t *testing.T) {
	original := botBenchWindows
	t.Cleanup(func() { botBenchWindows = original })
	botBenchWindows = nil

	if state := (botBenchState(time.Now())); state.Active || state.FromUnixMs != 0 {
		t.Errorf("an empty schedule published a bench: %+v", state)
	}
}
