package server

import (
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// reconnectSeriesBot brings an engine back the way rpsbot.py does: a brand new
// socket carrying the same token, through registerBot — which is what displaces
// whatever the server still thinks is holding the slot — and then the resume
// that a finished handshake performs.
func reconnectSeriesBot(t *testing.T, server *Server, bot persistence.Bot) *Client {
	t.Helper()
	client := &Client{
		send:    make(chan []byte, 256),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: bot.UserID, Username: bot.Name},
		server:  server,
		bot:     &botClient{botID: bot.BotID, record: bot, ready: true},
	}
	server.hub.Register(client)
	startStubEngine(t, server, client)
	server.registerBot(client)
	server.resumeBotGames(client)
	return client
}

// dropSeriesBot takes every socket of an engine off the server, the way a lost
// connection does: the read pump ends and disconnect runs.
func dropSeriesBot(t *testing.T, server *Server, bot persistence.Bot) {
	t.Helper()
	for _, connection := range server.botConnections(bot.BotID) {
		server.disconnect(connection)
	}
}

func seriesRecord(t *testing.T, server *Server, seriesID string) persistence.BotSeries {
	t.Helper()
	series, err := server.data.BotSeries(t.Context(), seriesID)
	if err != nil {
		t.Fatalf("read series: %v", err)
	}
	return series
}

// waitForSeriesStatus blocks until a run leaves "running", sweeping the stall
// as the lobby ticker would.
func waitForSeriesStatus(t *testing.T, server *Server, seriesID string) persistence.BotSeries {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		// Both sweeps, because a run whose engine vanished mid-game is waiting
		// on the board before it is waiting on itself: expireGames is what
		// calls the abandoned game, and only then is the run between games.
		server.expireGames(time.Now())
		server.resumeStalledSeries(time.Now())
		series := seriesRecord(t, server, seriesID)
		if series.Status != persistence.BotSeriesRunning {
			return series
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("series %s never stopped running", seriesID)
	return persistence.BotSeries{}
}

// A run used to be written off the instant a socket dropped. rpsbot.py
// reconnects on a one-second backoff, so that turned every blip into a lost
// run — and, when the blip landed mid-pair, into a matchup whose sample is one
// game lopsided.
func TestABlipDoesNotEndASeries(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	server.seriesAwayOverride = 10 * time.Second
	if _, err := server.StartBotSeries(
		t.Context(), hostSeries(alpha, beta, game.ModeTotalWar, 50, 2, 7),
	); err != nil {
		t.Fatalf("start series: %v", err)
	}
	seriesID := latestSeriesID(t, server)

	dropSeriesBot(t, server, beta)
	server.resumeStalledSeries(time.Now())
	if status := seriesRecord(t, server, seriesID).Status; status != persistence.BotSeriesRunning {
		t.Fatalf("a blip ended the run: %q", status)
	}

	reconnectSeriesBot(t, server, beta)
	server.resumeStalledSeries(time.Now())

	// Back in play, and playing: the run is not merely un-aborted, it deals the
	// game it stopped at and carries on to the end of its fifty pairs.
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if len(seriesRecord(t, server, seriesID).Games) > 1 {
			return
		}
		server.resumeStalledSeries(time.Now())
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatal("the run never dealt another game after the engine came back")
}

// The other half of the same rule: an engine that is really gone still ends the
// run, it just does it after the window rather than on the instant.
func TestAnEngineThatDoesNotComeBackEndsTheSeries(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	server.seriesAwayOverride = 20 * time.Millisecond
	if _, err := server.StartBotSeries(
		t.Context(), hostSeries(alpha, beta, game.ModeTotalWar, 50, 2, 7),
	); err != nil {
		t.Fatalf("start series: %v", err)
	}
	seriesID := latestSeriesID(t, server)

	dropSeriesBot(t, server, beta)
	// The seat on the board has a window of its own, and it is the real fifteen
	// seconds. Wind it back rather than wait it out: what is under test here is
	// what the *run* does once that game has been called, not how long the game
	// itself waits.
	expireHeldSeats(server)

	series := waitForSeriesStatus(t, server, seriesID)
	if series.Status != persistence.BotSeriesAborted {
		t.Fatalf("expected the run to be abandoned, got %q", series.Status)
	}
}

// expireHeldSeats pushes every empty seat's reconnect clock past its window.
func expireHeldSeats(server *Server) {
	gone := time.Now().Add(-reconnectGracePeriod - time.Second)
	server.mu.Lock()
	defer server.mu.Unlock()
	for _, session := range server.games {
		if !session.redDisconnectedAt.IsZero() {
			session.redDisconnectedAt = gone
		}
		if !session.blueDisconnectedAt.IsZero() {
			session.blueDisconnectedAt = gone
		}
	}
}

// A bot allowed several games at once holds one socket per slot, and only one
// of them is in the run. The spare dropping says nothing about the engine's
// ability to finish what it owes.
func TestASpareSlotDroppingLeavesTheRunAlone(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	server.seriesAwayOverride = 10 * time.Second
	spare := addSlotToSeriesBot(t, server, beta, 1)
	if _, err := server.StartBotSeries(
		t.Context(), hostSeries(alpha, beta, game.ModeTotalWar, 50, 2, 7),
	); err != nil {
		t.Fatalf("start series: %v", err)
	}
	seriesID := latestSeriesID(t, server)

	server.disconnect(spare)
	server.resumeStalledSeries(time.Now())
	if status := seriesRecord(t, server, seriesID).Status; status != persistence.BotSeriesRunning {
		t.Fatalf("a spare slot dropping ended the run: %q", status)
	}
}

// The worst of the three: a reconnecting slot displaces its own stale socket,
// and the close that follows used to land on the run it had just come back to
// finish.
func TestReconnectingDoesNotEndTheRunItCameBackFor(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	server.seriesAwayOverride = 10 * time.Second
	if _, err := server.StartBotSeries(
		t.Context(), hostSeries(alpha, beta, game.ModeTotalWar, 50, 2, 7),
	); err != nil {
		t.Fatalf("start series: %v", err)
	}
	seriesID := latestSeriesID(t, server)

	// No disconnect first: the point is a second socket arriving while the
	// server still believes in the first, which is what a reconnect looks like
	// when the old one's close has not been noticed yet. registerBot pushes the
	// stale socket out, and in production its read pump then lands on
	// disconnect — which is where the abort used to be.
	stale := server.botConnection(beta.BotID)
	reconnectSeriesBot(t, server, beta)
	server.disconnect(stale)
	server.resumeStalledSeries(time.Now())

	if status := seriesRecord(t, server, seriesID).Status; status != persistence.BotSeriesRunning {
		t.Fatalf("reconnecting ended the run: %q", status)
	}
}

// addSlotToSeriesBot opens a second socket for an engine that already has one,
// the way a client configured for two games at once does.
func addSlotToSeriesBot(
	t *testing.T,
	server *Server,
	bot persistence.Bot,
	slot int,
) *Client {
	t.Helper()
	client := &Client{
		send:    make(chan []byte, 256),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: bot.UserID, Username: bot.Name},
		server:  server,
		bot: &botClient{
			botID: bot.BotID, record: bot, ready: true,
			sessionID: "one-process", slot: slot, maxGames: slot + 1,
		},
	}
	server.hub.Register(client)
	startStubEngine(t, server, client)
	server.mu.Lock()
	server.bots[bot.BotID] = append(server.bots[bot.BotID], client)
	server.mu.Unlock()
	return client
}

// Whatever moment an engine is asked to stop, the run stops on a whole number
// of pairs. Half a pair is the one thing the pairing is there to prevent: the
// two seatings cancel the first mover's advantage, and one of them on its own
// measures that advantage instead.
func TestADrainStopsARunOnAPairBoundary(t *testing.T) {
	for _, when := range []int{1, 2, 3} {
		server, alpha, beta := seriesTestBots(t)
		// Slow enough that a drain asked for after game N lands while the run
		// is still going, rather than after it has finished all six games.
		server.seriesDelay = 150 * time.Millisecond
		if _, err := server.StartBotSeries(
			t.Context(), hostSeries(alpha, beta, game.ModeTotalWar, 3, 2, 7),
		); err != nil {
			t.Fatalf("start series: %v", err)
		}
		seriesID := latestSeriesID(t, server)
		waitForFinishedSeriesGames(t, server, seriesID, when)

		server.requestBotShutdown(server.readyBot(beta.BotID), true, "the test")
		series := waitForSeriesStatus(t, server, seriesID)

		played := finishedSeriesGames(series)
		if series.Status != persistence.BotSeriesAborted {
			t.Fatalf(
				"drained after game %d: expected the run to stop, got %q after %d game(s)",
				when, series.Status, played,
			)
		}
		if played == 0 || played%2 != 0 {
			t.Fatalf(
				"drained after game %d: the run stopped on %d game(s), which is not a whole number of pairs",
				when, played,
			)
		}
		if played < when {
			t.Fatalf(
				"drained after game %d: the run recorded only %d game(s)", when, played,
			)
		}
	}
}

// A drain settles the moment its last commitment clears, and the pair it was
// waiting on is one of them. Before this, the pair finishing left the engine
// waiting on the next lobby tick to be told it could go.
func TestFinishingThePairReleasesTheDrainedEngine(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	server.seriesDelay = 40 * time.Millisecond
	if _, err := server.StartBotSeries(
		t.Context(), hostSeries(alpha, beta, game.ModeTotalWar, 3, 2, 7),
	); err != nil {
		t.Fatalf("start series: %v", err)
	}
	seriesID := latestSeriesID(t, server)
	waitForFinishedSeriesGames(t, server, seriesID, 1)

	engine := server.readyBot(beta.BotID)
	server.requestBotShutdown(engine, true, "the test")
	waitForSeriesStatus(t, server, seriesID)

	// No lobby tick in this test, so a settle that only happened there would
	// never arrive.
	if state := server.botDrainState(engine); len(state.WaitingOn) != 0 {
		t.Fatalf("the drain is still waiting on %v after the run ended", state.WaitingOn)
	}
	if !drainSettled(engine) {
		t.Fatal("the engine was never told its drain had finished")
	}
}

func drainSettled(client *Client) bool {
	client.bot.mu.Lock()
	defer client.bot.mu.Unlock()
	return client.bot.drain != nil && client.bot.drain.settled
}

func finishedSeriesGames(series persistence.BotSeries) int {
	played := 0
	for _, entry := range series.Games {
		if entry.Result != persistence.BotSeriesPending {
			played++
		}
	}
	return played
}

func waitForFinishedSeriesGames(t *testing.T, server *Server, seriesID string, want int) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if finishedSeriesGames(seriesRecord(t, server, seriesID)) >= want {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("the run never finished %d game(s)", want)
}

// A seat is held open for a set time, and how long depends on who left it. A
// person is finding their phone; an engine is a process with a reconnect loop
// in it, and one that has not come back in fifteen seconds is not coming back
// for this game.
func TestAnEngineSeatIsHeldForHalfAsLongAsAPersons(t *testing.T) {
	leftAt := time.Now()
	state := game.GameState{Status: game.InProgress, CurrentTurn: game.Blue}

	person := &GameSession{redDisconnectedAt: leftAt}
	if held := person.reconnectDeadline(game.Red, state).Sub(leftAt); held != reconnectGracePeriod {
		t.Fatalf("a person's seat was held for %s, want %s", held, reconnectGracePeriod)
	}

	engine := &GameSession{redDisconnectedAt: leftAt, redIsEngine: true}
	if held := engine.reconnectDeadline(game.Red, state).Sub(leftAt); held != botReconnectGracePeriod {
		t.Fatalf("an engine's seat was held for %s, want %s", held, botReconnectGracePeriod)
	}
}

// Fifteen seconds, or until the end of its time — whichever comes first. An
// engine that walked away on its own move is spending a clock it does not have,
// and holding the seat past zero would be holding it in a game that is already
// decided.
func TestAHeldSeatDoesNotOutlastTheClock(t *testing.T) {
	// Truncated, because the clock a state carries is milliseconds since the
	// epoch and the sub-millisecond remainder would land in the comparison.
	leftAt := time.Now().Truncate(time.Millisecond)
	session := &GameSession{redDisconnectedAt: leftAt, redIsEngine: true}
	onTheMove := game.GameState{
		Status:      game.InProgress,
		CurrentTurn: game.Red,
		Clock: game.ClockState{
			RedRemainingMs:  4000,
			BlueRemainingMs: 600000,
			UpdatedAtUnixMs: leftAt.UnixMilli(),
		},
	}
	if held := session.reconnectDeadline(game.Red, onTheMove).Sub(leftAt); held != 4*time.Second {
		t.Fatalf("the seat was held for %s, want the four seconds left on the clock", held)
	}

	// The other side of the board is not spending anything, so its own short
	// clock says nothing about how long it may be away.
	waiting := onTheMove
	waiting.CurrentTurn = game.Blue
	if held := session.reconnectDeadline(game.Red, waiting).Sub(leftAt); held != botReconnectGracePeriod {
		t.Fatalf("a seat off the move was held for %s, want the whole window", held)
	}
}

// The reconnect that makes the window mean anything. A person sends
// rejoin_game; a bot cannot, so the seat is handed back by the server when the
// engine's next socket finishes its handshake.
func TestAnEngineTakesBackTheSeatItDroppedOutOf(t *testing.T) {
	server := New(nil)
	human := fakeClient(t, server, "human", false)
	engine := openToChallenges(t, server, "engine")
	server.challengeBot(human, engine.bot.botID, game.ModeTotalWar, nil, game.Red)
	seat := server.participantFor(engine)
	if seat == nil {
		t.Fatal("test setup: the engine was not seated")
	}
	session, color := seat.session, seat.color

	server.disconnect(engine)
	if occupantOf(session, color) != nil {
		t.Fatal("the seat was not emptied by the disconnect")
	}
	drain(human)

	returning := openToChallenges(t, server, "engine")
	server.resumeBotGames(returning)

	if occupantOf(session, color) != returning {
		t.Fatal("the engine did not get its seat back")
	}
	if server.participantFor(returning) == nil {
		t.Fatal("the engine is in the seat but is not a participant of the game")
	}
	if _, told := messageOfType(drain(human), "opponent_reconnected"); !told {
		t.Fatal("the opponent was not told the engine came back")
	}
	// And is playing again: whatever was asked of the old socket died with it,
	// so the position has to be put to this one or the game sits there until
	// somebody flags.
	if session.game.Snapshot().CurrentTurn == color && pendingExchange(returning) == nil {
		t.Fatal("the engine was seated but never asked for a move")
	}
}

// Past the window the game is one the sweep is about to end, and sitting down
// in it would restart a game that is already lost.
func TestASeatIsNotHandedBackAfterTheWindowHasPassed(t *testing.T) {
	server := New(nil)
	human := fakeClient(t, server, "human", false)
	engine := openToChallenges(t, server, "engine")
	server.challengeBot(human, engine.bot.botID, game.ModeTotalWar, nil, game.Red)
	seat := server.participantFor(engine)
	if seat == nil {
		t.Fatal("test setup: the engine was not seated")
	}
	session, color := seat.session, seat.color

	server.disconnect(engine)
	server.mu.Lock()
	gone := time.Now().Add(-botReconnectGracePeriod - time.Second)
	if color == game.Red {
		session.redDisconnectedAt = gone
	} else {
		session.blueDisconnectedAt = gone
	}
	server.mu.Unlock()

	returning := openToChallenges(t, server, "engine")
	server.resumeBotGames(returning)

	if occupantOf(session, color) != nil {
		t.Fatal("an engine sat back down in a seat that had already run out")
	}
}

func occupantOf(session *GameSession, color game.PlayerColor) *Client {
	if color == game.Red {
		return session.redClient
	}
	return session.blueClient
}

func pendingExchange(client *Client) *botExchange {
	client.bot.mu.Lock()
	defer client.bot.mu.Unlock()
	return client.bot.pending
}
