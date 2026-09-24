package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// setBenchWindows replaces one server's schedule for the length of one test.
//
// The cache is written directly rather than through the store, because the
// cache is what every offer path reads and a test that wrote rows would be
// asserting the loader as well as the rule under test. The loader has its own
// tests below. Restored on cleanup, so a test that benches the world does not
// bench the ones after it.
func setBenchWindows(t *testing.T, server *Server, windows ...botBenchWindow) {
	t.Helper()
	server.benches.mu.Lock()
	original := server.benches.windows
	server.benches.windows = windows
	server.benches.mu.Unlock()
	t.Cleanup(func() {
		server.benches.mu.Lock()
		server.benches.windows = original
		server.benches.mu.Unlock()
	})
}

// benchNow puts every engine on one server's bench, and the window covers now.
func benchNow(t *testing.T, server *Server, reason string) {
	t.Helper()
	now := time.Now()
	setBenchWindows(t, server, botBenchWindow{
		id:         "bench-test",
		reason:     reason,
		untilLabel: "4 PM Eastern",
		from:       now.Add(-time.Hour),
		until:      now.Add(time.Hour),
	})
}

// The window this was written for, asserted as the event rather than as two
// timestamps: the tournament is at 10 AM Eastern on Sunday 13 September 2026,
// and the engines are meant to be off from a quarter of an hour before it until
// six hours after it starts.
//
// Asserted against a server built the ordinary way, with nothing injected,
// because the seed is half the feature: a window that ships in the binary and
// does not reach the database is a bench that silently never happens. See
// botBenchSeeds.
//
// Worth a test because the dates are the one part of this feature nobody finds
// out is wrong until the morning it matters.
func TestTheTournamentBenchCoversTheTournament(t *testing.T) {
	server := New(nil)
	eastern := time.FixedZone("EDT", -4*60*60)
	cases := []struct {
		when    time.Time
		benched bool
		what    string
	}{
		{time.Date(2026, time.September, 13, 9, 0, 0, 0, eastern), false, "an hour before"},
		{time.Date(2026, time.September, 13, 9, 44, 0, 0, eastern), false, "a minute early"},
		{time.Date(2026, time.September, 13, 9, 45, 0, 0, eastern), true, "the moment it opens"},
		{time.Date(2026, time.September, 13, 10, 0, 0, 0, eastern), true, "the first round"},
		{time.Date(2026, time.September, 13, 15, 59, 0, 0, eastern), true, "a minute before four"},
		{time.Date(2026, time.September, 13, 16, 0, 0, 0, eastern), false, "four exactly"},
		{time.Date(2026, time.September, 14, 10, 0, 0, 0, eastern), false, "the next day"},
	}
	for _, testCase := range cases {
		if server.botsAreBenched(testCase.when) != testCase.benched {
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

// The one from the September before it, still enforced, because a window in the
// past is the record of what happened and deleting it from the source would
// quietly rewrite that.
func TestTheEarlierTournamentBenchIsStillOnTheSchedule(t *testing.T) {
	server := New(nil)
	eastern := time.FixedZone("EDT", -4*60*60)
	if !server.botsAreBenched(time.Date(2026, time.September, 5, 12, 0, 0, 0, eastern)) {
		t.Error("the 5 September tournament window is no longer on the schedule")
	}
}

// The point of the whole thing: a benched engine takes no games. Asserted
// through challengeBot rather than through botIsDraining, because a refusal
// that never reaches the person who pressed the button is not a refusal.
func TestABenchedEngineRefusesAChallengeAndSaysWhy(t *testing.T) {
	server := New(nil)
	benchNow(t, server, "the official Intransitive tournament on meaf.us/rps2")
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
	// whose owner has not touched it and which is back at four.
	if strings.Contains(refusal.Message, "shutting down") {
		t.Errorf("a benched engine was described as shutting down: %q", refusal.Message)
	}
	if !strings.Contains(refusal.Message, "meaf.us/rps2") {
		t.Errorf("the refusal does not say what the bench is for: %q", refusal.Message)
	}
	// In the timezone the event was announced in, not the server's. See
	// botBenchWindow.untilLabel.
	if !strings.Contains(refusal.Message, "4 PM Eastern") {
		t.Errorf("the refusal does not say when the engines are back: %q", refusal.Message)
	}
}

// The lobby has to be able to tell the two apart, because it says different
// words for each and the bench applies to engines nobody has asked to stop.
func TestTheRosterPublishesABenchRatherThanAShutdown(t *testing.T) {
	server := New(nil)
	benchNow(t, server, "a tournament")
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
// warn people the ladder closes at a quarter to instead of only explaining it
// afterwards.
func TestTheBenchStateDescribesTheNextWindowWhenNoneIsRunning(t *testing.T) {
	server := New(nil)
	soon := time.Now().Add(time.Hour)
	setBenchWindows(t, server, botBenchWindow{
		id:         "bench-test",
		reason:     "a tournament",
		untilLabel: "four",
		from:       soon,
		until:      soon.Add(time.Hour),
	})

	state := server.botBenchState(time.Now())
	if state.Active {
		t.Error("a bench that has not started is reported as running")
	}
	if state.FromUnixMs != soon.UnixMilli() {
		t.Errorf("the coming bench is not described: %+v", state)
	}
}

// Nothing scheduled ahead is the ordinary state of this server, and it must
// publish as nothing rather than as a window at the zero time.
func TestNoScheduledBenchPublishesNothing(t *testing.T) {
	server := New(nil)
	setBenchWindows(t, server)

	if state := server.botBenchState(time.Now()); state.Active || state.FromUnixMs != 0 {
		t.Errorf("an empty schedule published a bench: %+v", state)
	}
}

/* ------------------------------------------------ the schedule as storage -- */

// benchAdminServer is a server with an admin token, over a store a second
// server can be built on.
func benchAdminServer(t *testing.T) (*persistence.Store, *Server, http.Handler) {
	t.Helper()
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { data.Close() })
	server := NewWithStoreAndAdminToken(data, nil, "test-secret")
	return data, server, server.Routes()
}

// A window a host schedules from the admin screen is enforced, without anything
// being restarted. This is the whole reason the schedule moved out of the
// source: a bench that needs a deploy is a bench that gets scheduled late.
func TestAWindowScheduledFromTheAdminScreenIsEnforcedAtOnce(t *testing.T) {
	_, server, handler := benchAdminServer(t)
	engine := openToChallenges(t, server, "engine")
	if botIsDraining(engine) {
		t.Fatal("the engine was already benched before anything was scheduled")
	}

	now := time.Now()
	response := tournamentRequest(t, handler, http.MethodPost, "/api/admin/bot-bench",
		map[string]any{
			"reason":      "the club night",
			"untilLabel":  "9 PM Eastern",
			"fromUnixMs":  now.Add(-time.Minute).UnixMilli(),
			"untilUnixMs": now.Add(time.Hour).UnixMilli(),
		}, "test-secret")
	if response.Code != http.StatusOK {
		t.Fatalf("scheduling the bench failed with %d: %s", response.Code, response.Body)
	}

	if !botIsDraining(engine) {
		t.Error("an engine is still taking games inside a window a host just scheduled")
	}
	if state := server.botBenchState(time.Now()); !state.Active || state.Reason != "the club night" {
		t.Errorf("the lobby was not told about the new bench: %+v", state)
	}
}

// And cancelling one puts the engines straight back, for the same reason: the
// tournament was postponed and nobody should have to restart a server over it.
func TestCancellingAWindowPutsTheEnginesBack(t *testing.T) {
	_, server, handler := benchAdminServer(t)
	engine := openToChallenges(t, server, "engine")

	now := time.Now()
	response := tournamentRequest(t, handler, http.MethodPost, "/api/admin/bot-bench",
		map[string]any{
			"reason":      "the club night",
			"untilLabel":  "9 PM Eastern",
			"fromUnixMs":  now.Add(-time.Minute).UnixMilli(),
			"untilUnixMs": now.Add(time.Hour).UnixMilli(),
		}, "test-secret")
	if response.Code != http.StatusOK {
		t.Fatalf("scheduling the bench failed with %d: %s", response.Code, response.Body)
	}
	var scheduled persistence.BotBenchWindow
	if err := json.NewDecoder(response.Body).Decode(&scheduled); err != nil {
		t.Fatal(err)
	}

	response = tournamentRequest(t, handler, http.MethodDelete,
		"/api/admin/bot-bench/"+scheduled.ID, nil, "test-secret")
	if response.Code != http.StatusOK {
		t.Fatalf("cancelling the bench failed with %d: %s", response.Code, response.Body)
	}
	if botIsDraining(engine) {
		t.Error("the engines are still benched after the window was cancelled")
	}
}

// A window wholly in the past enforces nothing and would sit on the host's
// screen looking like cover the ladder does not have.
func TestAWindowThatHasAlreadyFinishedIsRefused(t *testing.T) {
	_, _, handler := benchAdminServer(t)
	now := time.Now()
	response := tournamentRequest(t, handler, http.MethodPost, "/api/admin/bot-bench",
		map[string]any{
			"reason":      "last week",
			"untilLabel":  "6 PM Eastern",
			"fromUnixMs":  now.Add(-48 * time.Hour).UnixMilli(),
			"untilUnixMs": now.Add(-47 * time.Hour).UnixMilli(),
		}, "test-secret")
	if response.Code != http.StatusBadRequest {
		t.Errorf("a finished window was accepted with %d: %s", response.Code, response.Body)
	}
}

// The backwards one, which is the typo a host actually makes: 4 PM to 10 AM.
func TestAWindowThatEndsBeforeItStartsIsRefused(t *testing.T) {
	_, _, handler := benchAdminServer(t)
	now := time.Now()
	response := tournamentRequest(t, handler, http.MethodPost, "/api/admin/bot-bench",
		map[string]any{
			"reason":      "backwards",
			"untilLabel":  "4 PM Eastern",
			"fromUnixMs":  now.Add(2 * time.Hour).UnixMilli(),
			"untilUnixMs": now.Add(time.Hour).UnixMilli(),
		}, "test-secret")
	if response.Code != http.StatusBadRequest {
		t.Errorf("a backwards window was accepted with %d: %s", response.Code, response.Body)
	}
}

// The property the seed ledger exists for. A host cancels a bench because the
// event was called off; the next deploy restarts the process; the bench must
// not come back. Without the ledger it would, silently, and the only symptom
// would be a ladder that is off on an afternoon nobody expected.
func TestASeededWindowDoesNotComeBackAfterItIsCancelled(t *testing.T) {
	data, _, handler := benchAdminServer(t)

	response := tournamentRequest(t, handler, http.MethodDelete,
		"/api/admin/bot-bench/bench-2026-09-13-meaf", nil, "test-secret")
	if response.Code != http.StatusOK {
		t.Fatalf("cancelling the seeded bench failed with %d: %s", response.Code, response.Body)
	}

	// The restart: a second server over the same store, which re-offers every
	// seed exactly as a fresh process would.
	restarted := NewWithStore(data, nil)
	eastern := time.FixedZone("EDT", -4*60*60)
	if restarted.botsAreBenched(time.Date(2026, time.September, 13, 12, 0, 0, 0, eastern)) {
		t.Error("a cancelled bench was put back by the next restart")
	}
	// And the one beside it is untouched — cancelling is one window, not the
	// schedule.
	if !restarted.botsAreBenched(time.Date(2026, time.September, 5, 12, 0, 0, 0, eastern)) {
		t.Error("cancelling one window removed another")
	}
}

// The host's list says which of the three things each window is, because the
// screen shows different words for each and would otherwise re-derive them
// against a clock this server has already read.
func TestTheAdminScheduleMarksWhichWindowIsRunning(t *testing.T) {
	_, _, handler := benchAdminServer(t)
	now := time.Now()
	response := tournamentRequest(t, handler, http.MethodPost, "/api/admin/bot-bench",
		map[string]any{
			"reason":      "right now",
			"untilLabel":  "9 PM Eastern",
			"fromUnixMs":  now.Add(-time.Minute).UnixMilli(),
			"untilUnixMs": now.Add(time.Hour).UnixMilli(),
		}, "test-secret")
	if response.Code != http.StatusOK {
		t.Fatalf("scheduling the bench failed with %d: %s", response.Code, response.Body)
	}

	response = tournamentRequest(t, handler, http.MethodGet, "/api/admin/bot-bench", nil, "test-secret")
	if response.Code != http.StatusOK {
		t.Fatalf("reading the schedule failed with %d: %s", response.Code, response.Body)
	}
	var windows []AdminBenchWindow
	if err := json.NewDecoder(response.Body).Decode(&windows); err != nil {
		t.Fatal(err)
	}

	running, past := 0, 0
	for _, window := range windows {
		if window.Active {
			running++
			if window.Reason != "right now" {
				t.Errorf("the wrong window is marked running: %q", window.Reason)
			}
		}
		if window.Past {
			past++
		}
	}
	if running != 1 {
		t.Errorf("expected exactly one running window, got %d", running)
	}
	// The 5 September one, which every server carries and which is over.
	if past == 0 {
		t.Error("a finished window is not marked as past")
	}
}

// The schedule is a host's, not a player's: it says what the site is doing on a
// future afternoon and who decided that.
func TestTheScheduleIsNotPublic(t *testing.T) {
	_, _, handler := benchAdminServer(t)
	response := tournamentRequest(t, handler, http.MethodGet, "/api/admin/bot-bench", nil, "")
	if response.Code != http.StatusUnauthorized {
		t.Errorf("the bench schedule answered an unauthenticated request with %d", response.Code)
	}
}
