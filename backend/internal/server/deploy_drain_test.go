package server

import (
	"strings"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
)

// waitForExit is how long a test gives the settle's grace period. The grace
// itself is 400ms; the margin covers a loaded CI box without making a failure
// take a noticeable time to report.
const waitForExit = 3 * time.Second

func awaitExit(t *testing.T, server *Server) bool {
	t.Helper()
	select {
	case <-server.UpdateFinished():
		return true
	case <-time.After(waitForExit):
		return false
	}
}

func exitedYet(server *Server) bool {
	select {
	case <-server.UpdateFinished():
		return true
	default:
		return false
	}
}

// The whole feature in one test: a drain asked for while a game is being played
// waits for that game, and stops the moment it ends.
func TestADrainWaitsForTheGameOnTheBoardAndThenExits(t *testing.T) {
	server := New(nil)
	red := fakeClient(t, server, "red", false)
	blue := fakeClient(t, server, "blue", false)
	if server.startConfiguredMatch(testEntry(red), testEntry(blue), matchSetup{}) == nil {
		t.Fatal("the setup did not open a game")
	}

	state := server.BeginUpdateDrain("Back in a minute.")
	if !state.Updating || len(state.WaitingOn) != 1 {
		t.Fatalf("a drain over a live game should be waiting on it, got %+v", state)
	}
	if exitedYet(server) {
		t.Fatal("the server exited while a game was still being played")
	}

	server.resign(red)

	if !awaitExit(t, server) {
		t.Fatal("the drain never settled once the game it was waiting on ended")
	}
	if remaining := server.UpdateDrainState(); !remaining.Settled ||
		len(remaining.WaitingOn) != 0 {
		t.Fatalf("a settled drain should owe nothing, got %+v", remaining)
	}
}

// A deploy onto an idle server should not wait for a lobby tick to notice the
// lobby is empty. This is the common case — most deploys happen when nobody is
// playing — and it is the one that decides how long a deploy feels.
func TestADrainOnAnIdleServerSettlesImmediately(t *testing.T) {
	server := New(nil)
	state := server.BeginUpdateDrain("")
	if len(state.WaitingOn) != 0 {
		t.Fatalf("an idle server owes nothing, got %+v", state.WaitingOn)
	}
	if !awaitExit(t, server) {
		t.Fatal("a drain on an empty lobby did not settle")
	}
}

// The refusals. Every path that can open a game has its own, because each can
// say something more useful than the backstop in startConfiguredMatch — but the
// backstop is what makes the guarantee, so it is asserted too.
func TestADrainingServerOpensNoNewGames(t *testing.T) {
	server := New(nil)
	server.BeginUpdateDrain("")

	red := fakeClient(t, server, "red", false)
	blue := fakeClient(t, server, "blue", false)
	if server.startConfiguredMatch(testEntry(red), testEntry(blue), matchSetup{}) != nil {
		t.Fatal("a draining server opened a game")
	}
	if _, refused := messageOfType(drain(red), "error"); !refused {
		t.Fatal("the player was not told why the game did not open")
	}
}

func TestADrainingServerRefusesToQueue(t *testing.T) {
	server := New(nil)
	server.BeginUpdateDrain("")

	player := fakeClient(t, server, "player", false)
	server.joinQueue(player, game.GameSetup{ModeID: game.ModeTotalWar})

	if server.seeks.Len() != 0 {
		t.Fatal("a seek was posted to a board that is not pairing")
	}
	if len(drain(player)) == 0 {
		t.Fatal("the player was told nothing about why they could not queue")
	}
}

// The board is paused rather than emptied, so a drain that is called off puts
// everybody back where they were rather than making them press play again.
func TestCancellingADrainPutsTheServerBackInPlay(t *testing.T) {
	server := New(nil)
	// A game on the board, because that is the only situation a cancel can
	// reach: a drain with nothing to wait for has stopped the process before
	// anybody could change their mind about it.
	red := fakeClient(t, server, "red", false)
	blue := fakeClient(t, server, "blue", false)
	if server.startConfiguredMatch(testEntry(red), testEntry(blue), matchSetup{}) == nil {
		t.Fatal("the setup did not open a game")
	}

	server.BeginUpdateDrain("")
	if !server.isUpdating() {
		t.Fatal("the drain did not start")
	}

	state := server.CancelUpdateDrain()
	if state.Updating {
		t.Fatalf("the drain was not called off, got %+v", state)
	}

	third := fakeClient(t, server, "third", false)
	fourth := fakeClient(t, server, "fourth", false)
	if server.startConfiguredMatch(
		testEntry(third), testEntry(fourth), matchSetup{},
	) == nil {
		t.Fatal("a cancelled drain left the server refusing games")
	}
	if exitedYet(server) {
		t.Fatal("a cancelled drain still stopped the process")
	}
}

// A drain that has already stopped the process cannot be called off: the
// binary on disk is the new one and the answer is that it is starting.
func TestASettledDrainCannotBeCancelled(t *testing.T) {
	server := New(nil)
	server.BeginUpdateDrain("")
	if !awaitExit(t, server) {
		t.Fatal("the drain did not settle on an empty lobby")
	}
	if state := server.CancelUpdateDrain(); !state.Updating {
		t.Fatal("a settled drain was cancelled, which cannot be honoured")
	}
}

// A game that was opened and never begun costs nobody anything, and waiting out
// the first-move window on one would add half a minute to every deploy made
// while somebody had a board open they never looked at.
func TestADrainDoesNotWaitOutAnUnbegunGame(t *testing.T) {
	server := New(nil)
	red := fakeClient(t, server, "red", false)
	blue := fakeClient(t, server, "blue", false)
	session := server.startConfiguredMatch(
		testEntry(red),
		testEntry(blue),
		matchSetup{start: &matchStart{
			deadline: time.Now().Add(firstMoveWindow),
			seats: [2]*startSeat{
				{seek: &Seek{ID: "red", Owner: "red"}, requeue: false},
				{seek: &Seek{ID: "blue", Owner: "blue"}, requeue: false},
			},
		}},
	)
	if session == nil {
		t.Fatal("the setup did not open a game")
	}

	server.BeginUpdateDrain("")
	if !awaitExit(t, server) {
		t.Fatal("the drain waited out a game neither player had moved in")
	}
}

// The notice an administrator writes is what everybody reads, on the banner and
// in the refusal. A deploy with something to say should not be reduced to the
// default sentence halfway through.
func TestTheDrainNoticeReachesTheRefusal(t *testing.T) {
	server := New(nil)
	server.BeginUpdateDrain("New openings book is going live.")
	if message := server.updateRefusalMessage(); !strings.Contains(
		message, "New openings book is going live.",
	) {
		t.Fatalf("the refusal did not carry the notice, got %q", message)
	}
}

// Everybody connected hears about the drain, and hears about it again when the
// list empties — that second message is what turns "an update is coming" into
// "it is happening now", and it has to go out before the socket closes.
func TestEverybodyIsToldWhenADrainStartsAndWhenItSettles(t *testing.T) {
	server := New(nil)
	watcher := fakeClient(t, server, "watcher", false)
	red := fakeClient(t, server, "red", false)
	blue := fakeClient(t, server, "blue", false)
	if server.startConfiguredMatch(testEntry(red), testEntry(blue), matchSetup{}) == nil {
		t.Fatal("the setup did not open a game")
	}
	drain(watcher)

	server.BeginUpdateDrain("Back shortly.")
	opening, told := messageOfType(drain(watcher), "server_update")
	if !told || opening.Update == nil || !opening.Update.Updating {
		t.Fatal("a spectator was not told the server is being replaced")
	}
	if opening.Update.GamesRemaining != 1 {
		t.Fatalf("the banner was not told what it is waiting on, got %+v", opening.Update)
	}

	server.resign(red)
	if !awaitExit(t, server) {
		t.Fatal("the drain did not settle")
	}
	settled, told := messageOfType(drain(watcher), "server_update")
	if !told || settled.Update == nil || !settled.Update.Settled {
		t.Fatal("nobody was told the restart was happening")
	}
}

// A run stopped between the two seatings of a pair leaves the matchup's sample
// one game lopsided — the swap exists to cancel the first-move advantage, and
// half a pair does not. So a drain finishes the pair and then lets go, exactly
// as a draining bot does.
func TestADrainStopsASeriesOnAPairBoundary(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	if _, err := server.StartBotSeries(
		t.Context(), hostSeries(alpha, beta, game.ModeTotalWar, 8, 2, 4321),
	); err != nil {
		t.Fatalf("start series: %v", err)
	}

	// Wait for the run to be mid-pair — an odd game number is the first of a
	// pair — so the drain has something to finish rather than nothing to stop.
	seriesID := latestSeriesID(t, server)
	if !waitFor(t, func() bool {
		server.mu.RLock()
		defer server.mu.RUnlock()
		for _, session := range server.games {
			if session.botMatch != nil && session.botMatch.gameNumber%2 == 1 {
				return true
			}
		}
		return false
	}) {
		t.Fatal("the series never reached the first game of a pair")
	}

	server.BeginUpdateDrain("")
	// Longer than the other waits here: the drain has a whole game to sit
	// through before the pair is complete.
	select {
	case <-server.UpdateFinished():
	case <-time.After(60 * time.Second):
		t.Fatal("the drain never settled while a series was running")
	}

	series, err := server.data.BotSeries(t.Context(), seriesID)
	if err != nil {
		t.Fatalf("read series: %v", err)
	}
	if len(series.Games)%2 != 0 {
		t.Fatalf("the series stopped mid-pair after %d games", len(series.Games))
	}
	if len(series.Games) >= 16 {
		t.Fatal("the drain waited out the whole series instead of stopping at a pair")
	}
}

// The window this closes: playNextSeriesGame seats the next game from a
// goroutine after a pause, so there is a moment when a run is very much still
// going and the games map is empty. A settle that only counted boards would fire
// in it and take the process down between the two halves of a pair.
func TestARunBetweenItsGamesStillHoldsTheDrain(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	// Long enough that the gap between two games is a state a test can stand
	// in, rather than something to race.
	server.seriesDelay = 250 * time.Millisecond
	if _, err := server.StartBotSeries(
		t.Context(), hostSeries(alpha, beta, game.ModeTotalWar, 4, 2, 999),
	); err != nil {
		t.Fatalf("start series: %v", err)
	}

	if !waitFor(t, func() bool {
		server.mu.RLock()
		boards := len(server.games)
		server.mu.RUnlock()
		if boards > 0 {
			return false
		}
		// No board, and a run that has not finished: the gap.
		return len(server.runningSeriesNames()) > 0
	}) {
		t.Skip("never observed the gap between two series games")
	}

	if waiting := server.updateDrainCommitments(); len(waiting) == 0 {
		t.Fatal("a running series between its games was counted as nothing to wait for")
	}
}

// waitFor polls a condition for as long as a series game reasonably takes.
func waitFor(t *testing.T, condition func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return false
}
