package server

import (
	"strings"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// An engine's own match outranks whatever else it is doing. See bot_recall.go.

// recallEvent is two connected engines entered in a running round robin.
//
// What the tests below then do is make one of them busy, which is the state the
// reservation in bot_reserve.go cannot prevent: it stops an engine being
// borrowed once an event is running, and says nothing about the game the engine
// was already in when the event began.
func recallEvent(t *testing.T) (*Server, *Client, *Client, persistence.Tournament) {
	t.Helper()
	server := New(nil)
	_, alpha := connectLadderBot(t, server, "Alpha")
	_, beta := connectLadderBot(t, server, "Beta")

	openTournament(t, server.data, "cup", "Test Cup", game.ModeTotalWar, "Total War")
	for _, engine := range []*Client{alpha, beta} {
		if _, err := server.data.SignupForTournament(
			t.Context(), "cup", engine.profile.UserID, engine.profile.Username,
			"bot."+strings.ToLower(engine.profile.Username), true,
		); err != nil {
			t.Fatalf("enter %s: %v", engine.profile.Username, err)
		}
	}
	tournament, err := server.data.StartTournament(t.Context(), "cup")
	if err != nil {
		t.Fatalf("start the event: %v", err)
	}
	if len(tournament.Matches) != 1 {
		t.Fatalf("two entrants should make one pairing, got %d", len(tournament.Matches))
	}
	server.refreshBotReservations()
	return server, alpha, beta, tournament
}

// seatGame puts two clients on a board that is already being played, the way a
// challenge accepted a minute ago would have.
func seatGame(t *testing.T, server *Server, id string, red, blue *Client) *GameSession {
	t.Helper()
	played, err := game.NewGame(id, game.ModeTotalWar, red.profile, blue.profile)
	if err != nil {
		t.Fatalf("new game %s: %v", id, err)
	}
	session := &GameSession{
		gameID:     id,
		modeID:     game.ModeTotalWar,
		game:       played,
		redClient:  red,
		blueClient: blue,
		spectators: make(map[*Client]struct{}),
		chat:       newChatRoom(id),
		startedAt:  time.Now().Add(-time.Minute),
		ranked:     true,
	}
	server.mu.Lock()
	server.games[id] = session
	server.participants[red] = Participant{session: session, color: game.Red}
	server.participants[blue] = Participant{session: session, color: game.Blue}
	server.mu.Unlock()
	return session
}

// liveMatch is the game playing out a scheduled pairing, if one is.
func liveMatch(server *Server, tournament persistence.Tournament) *GameSession {
	return server.tournamentGame(tournamentMatchKey{
		tournamentID: tournament.TournamentID,
		matchID:      tournament.Matches[0].MatchID,
	})
}

func gameIsLive(server *Server, gameID string) bool {
	server.mu.RLock()
	defer server.mu.RUnlock()
	_, live := server.games[gameID]
	return live
}

// The whole point. Without this the round robin stops here: nothing else was
// ever going to end that casual game, so the pairing would wait forever.
func TestAnEngineIsTakenOutOfACasualGameForItsOwnMatch(t *testing.T) {
	server, alpha, _, tournament := recallEvent(t)

	visitor := tournamentTestClient("visitor", "Visitor")
	server.hub.Register(visitor)
	casual := seatGame(t, server, "casual-1", alpha, visitor)
	watcher := tournamentTestClient("watcher", "Watcher")
	server.hub.Register(watcher)
	server.mu.Lock()
	casual.spectators[watcher] = struct{}{}
	server.spectating[watcher] = casual
	server.mu.Unlock()

	server.autoReadyBotMatches()

	if gameIsLive(server, "casual-1") {
		t.Fatal("the game holding the engine should have been stopped")
	}
	if liveMatch(server, tournament) == nil {
		t.Fatal("the scheduled match should have started once the engine was free")
	}
	// Voided, not adjudicated: the position never reached a finish, so there is
	// no result for anything downstream to file or to rate.
	if status := casual.game.Snapshot().Status; status == game.Finished {
		t.Fatalf("a recalled game must not be given a result, got %q", status)
	}
	if _, err := server.data.ArchivedGame(t.Context(), "casual-1"); err == nil {
		t.Fatal("a recalled game must not reach the archive")
	}

	// Everybody who had that board on screen is told why it went, players and
	// spectators alike. A board that vanishes silently is indistinguishable
	// from a crash.
	for _, told := range []struct {
		who    string
		client *Client
	}{{"the opponent", visitor}, {"the spectator", watcher}} {
		notice, ok := messageOfType(drainChallengeTestMessages(t, told.client), "game_cancelled")
		if !ok {
			t.Fatalf("%s should have been told the game was stopped", told.who)
		}
		for _, want := range []string{"Alpha", "Test Cup", "Nothing was rated"} {
			if !strings.Contains(notice.Message, want) {
				t.Fatalf(
					"%s should be told %q; got %q", told.who, want, notice.Message,
				)
			}
		}
	}
}

// A game nobody has moved in yet ends down a different path, because it is
// holding both players' seeks in escrow and only that path gives them back.
func TestRecallingAnEngineFromAnUnstartedGameGivesBothSeeksBack(t *testing.T) {
	server, alpha, _, tournament := recallEvent(t)

	visitor := tournamentTestClient("visitor", "Visitor")
	server.hub.Register(visitor)
	pending := seatGame(t, server, "pending-1", alpha, visitor)
	server.mu.Lock()
	pending.start = &matchStart{
		seats: [2]*startSeat{
			{seek: seekForTest(alpha), requeue: true},
			{seek: seekForTest(visitor), requeue: true},
		},
		deadline: time.Now().Add(30 * time.Second),
	}
	server.mu.Unlock()

	server.autoReadyBotMatches()

	if gameIsLive(server, "pending-1") {
		t.Fatal("the unstarted game should have been called off")
	}
	if liveMatch(server, tournament) == nil {
		t.Fatal("the scheduled match should have started once the engine was free")
	}
	notice, ok := messageOfType(drainChallengeTestMessages(t, visitor), "game_cancelled")
	if !ok {
		t.Fatal("the waiting player should have been told the game was called off")
	}
	// Nobody failed to turn up, so nobody loses their place — the same answer a
	// moderator's stop gives, and for the same reason.
	if !strings.Contains(notice.Message, "your place in the queue is back") {
		t.Fatalf("the notice should return the queue place, got %q", notice.Message)
	}
}

// Another event's live match is the one game a recall will not touch. Two
// overlapping tournaments must not eat each other's games.
func TestARecallLeavesAnotherEventsMatchAlone(t *testing.T) {
	server, alpha, _, tournament := recallEvent(t)

	rival := tournamentTestClient("rival", "Rival")
	server.hub.Register(rival)
	elsewhere := seatGame(t, server, "other-cup-1", alpha, rival)
	server.mu.Lock()
	elsewhere.tournament = &tournamentMatchRef{tournamentID: "other-cup", matchID: 7}
	server.mu.Unlock()

	server.autoReadyBotMatches()

	if !gameIsLive(server, "other-cup-1") {
		t.Fatal("another event's match must survive: it will end on its own")
	}
	if liveMatch(server, tournament) != nil {
		t.Fatal("the pairing should wait rather than start without its engine")
	}
	if _, told := messageOfType(
		drainChallengeTestMessages(t, rival), "game_cancelled",
	); told {
		t.Fatal("nobody in a protected game should be told anything")
	}
}

// Freeing one engine and then finding the other unreachable would have
// destroyed somebody's game for a match that still cannot start. Planning both
// seats before acting on either is what prevents it.
func TestNoGameIsStoppedWhenTheOpponentCannotPlay(t *testing.T) {
	server, alpha, beta, tournament := recallEvent(t)

	// Beta goes offline between the pairing and the sweep.
	server.mu.Lock()
	delete(server.bots, beta.bot.botID)
	server.mu.Unlock()

	visitor := tournamentTestClient("visitor", "Visitor")
	server.hub.Register(visitor)
	seatGame(t, server, "casual-1", alpha, visitor)

	server.autoReadyBotMatches()

	if !gameIsLive(server, "casual-1") {
		t.Fatal("a game must not be stopped for a match that cannot start")
	}
	if liveMatch(server, tournament) != nil {
		t.Fatal("the pairing has only one engine and must not have started")
	}
}

// An idle engine is the ordinary case, and it costs nothing: the plan is a slot
// that was already free and running it stops nothing at all.
func TestAnIdleEngineIsPairedWithoutStoppingAnything(t *testing.T) {
	server, _, _, tournament := recallEvent(t)

	server.autoReadyBotMatches()

	if liveMatch(server, tournament) == nil {
		t.Fatal("two idle engines should simply be paired")
	}
}

// A run holds its engines between the games of a pair as well as during them,
// so freeing one means ending the whole run. That is also the answer the host's
// own controls give: stopGame refuses a single series game and points at the
// run instead.
func TestARunHoldingAnEngineIsCalledOffForItsMatch(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = data.Close() })
	server := NewWithStore(data, nil)
	// Slow enough that a twenty-game run cannot quietly finish before the event
	// starts, which would prove nothing.
	server.seriesDelay = 20 * time.Millisecond

	alpha := addRivalSeriesBot(t, server, "Alpha")
	beta := addRivalSeriesBot(t, server, "Beta")

	// Dealt before the event begins, which is the only way this state is
	// reachable at all: a reservation refuses a run against an engine that is
	// already entered in a running event. See bot_reserve.go.
	if _, err := server.StartBotSeries(
		t.Context(), hostSeries(alpha, beta, game.ModeTotalWar, 10, 0, 99),
	); err != nil {
		t.Fatalf("start series: %v", err)
	}
	seriesID := latestSeriesID(t, server)

	openTournament(t, data, "cup", "Test Cup", game.ModeTotalWar, "Total War")
	for _, entrant := range []persistence.Bot{alpha, beta} {
		if _, err := data.SignupForTournament(
			t.Context(), "cup", entrant.UserID, entrant.Name,
			"bot."+strings.ToLower(entrant.Name), true,
		); err != nil {
			t.Fatalf("enter %s: %v", entrant.Name, err)
		}
	}
	if _, err := data.StartTournament(t.Context(), "cup"); err != nil {
		t.Fatalf("start the event: %v", err)
	}

	// Whether the match *ran*, read from the schedule rather than from the live
	// board. The engines in this test answer instantly, so a match started on
	// one tick can be played out and filed before the next poll looks — which
	// is indistinguishable, from the live board alone, from a match that never
	// started at all. The schedule keeps the game id either way.
	matchRan := func() bool {
		played, err := data.Tournament(t.Context(), "cup")
		if err != nil {
			return false
		}
		return played.Matches[0].GameID != "" ||
			played.Matches[0].Result != persistence.MatchPending
	}

	// The lobby ticker, hurried along. Which tick frees the engines depends on
	// where the run had got to, so this asks more than once rather than assume.
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) && !matchRan() {
		server.autoReadyBotMatches()
		time.Sleep(10 * time.Millisecond)
	}
	if !matchRan() {
		t.Fatal("the match should have been played once the run was called off")
	}
	run, err := data.BotSeries(t.Context(), seriesID)
	if err != nil {
		t.Fatalf("read series: %v", err)
	}
	if run.Status != persistence.BotSeriesAborted {
		t.Fatalf("the run holding both engines should have been called off, got %q", run.Status)
	}
}
