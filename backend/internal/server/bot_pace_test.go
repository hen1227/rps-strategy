package server

import (
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/notation"
)

// Two engines that answer instantly still play at the pace, and the waiting is
// charged to neither of them.
//
// The real interval rather than an override, because the number is the point:
// left to themselves these two stub engines play a whole five-minute game in a
// few milliseconds, which is the load botMoveInterval exists to flatten.
func TestPacedEnginesMoveNoFasterThanTheIntervalAndNeitherClockPays(t *testing.T) {
	// Spelled out here as well as at the constant, so that the rest of this
	// test cannot be satisfied by an interval that has been tuned to nothing:
	// a fifth of a second is the requirement, not an implementation detail.
	if botMoveInterval != 200*time.Millisecond {
		t.Fatalf("an engine's moves are meant to be 200ms apart, not %s", botMoveInterval)
	}

	server := New(nil)
	opener := fakeClient(t, server, "opener-engine", true)
	replier := fakeClient(t, server, "replier-engine", true)
	startStubEngine(t, server, opener)
	startStubEngine(t, server, replier)

	// Before the seating, so the measurement cannot miss any of the game: the
	// first engine is asked for its move from inside startConfiguredMatch.
	began := time.Now()
	session := server.startConfiguredMatch(openingSeat(testEntry(opener), testEntry(replier)))
	if session == nil {
		t.Fatal("expected a session")
	}

	// Four plies is two moves each, which is enough for the pace to be a pace
	// rather than one engine's first answer.
	const plies = 4
	deadline := time.Now().Add(10 * time.Second)
	for len(session.game.Record().Moves()) < plies && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	elapsed := time.Since(began)

	moves := session.game.Record().Moves()
	if len(moves) < plies {
		t.Fatalf("the paced game stalled at %d of %d moves", len(moves), plies)
	}
	if least := plies * botMoveInterval; elapsed < least {
		t.Fatalf(
			"%d paced moves took %s, faster than the %s the interval allows",
			plies, elapsed, least,
		)
	}

	// And the waiting was nobody's: each side has answered twice, so each has
	// been paid two increments and charged only the microseconds it spent
	// choosing. Unpaced, four plies over this much wall clock would have taken
	// a full interval off each clock.
	state := session.game.Snapshot()
	control := state.TimeControl
	for _, seat := range []struct {
		color     game.PlayerColor
		remaining int64
	}{
		{game.Red, state.Clock.RedRemainingMs},
		{game.Blue, state.Clock.BlueRemainingMs},
	} {
		spent := control.InitialTimeMs + 2*control.IncrementMs - seat.remaining
		if spent >= botMoveInterval.Milliseconds() {
			t.Errorf(
				"%s was charged %dms of a game that took %s, so the pace was on its clock",
				seat.color, spent, elapsed,
			)
		}
	}
}

// The pace is a floor under the gap between moves, not a delay added to each of
// them. An engine that took longer than the interval to answer has its move
// played on the spot -- here, before the call that carried it has returned.
func TestAnEngineSlowerThanThePaceIsNotHeld(t *testing.T) {
	server := New(nil)
	human := fakeClient(t, server, "human", false)
	bot := fakeClient(t, server, "engine", true)

	session := server.startConfiguredMatch(openingSeat(testEntry(bot), testEntry(human)))
	if session == nil {
		t.Fatal("expected a session")
	}
	moves := session.game.LegalMoves()
	if len(moves) == 0 {
		t.Fatal("expected the engine to have legal moves")
	}
	chosen := moves[0]

	server.applyBotMove(bot, session.gameID, []string{
		"bestmove " + notation.FormatSquare(chosen.From) + "-" + notation.FormatSquare(chosen.To),
	}, time.Now().Add(-time.Second))

	if played := len(session.game.Record().Moves()); played != 1 {
		t.Fatalf(
			"a move asked for a second ago was not played at once: %d moves on the board",
			played,
		)
	}
}

// An engine is not asked for a move it has already given. The wait a paced move
// spends is a stretch in which the board still shows the engine on move and no
// question is outstanding, and promptBot is called redundantly all over this
// server -- from a reconnect, from the other engine's handshake, from every
// broadcast. Asking again there gets a second copy of the same move, which
// arrives out of turn and is faulted as an illegal one.
func TestAnEngineIsNotAskedAgainWhileItsMoveWaits(t *testing.T) {
	server := New(nil)
	human := fakeClient(t, server, "human", false)
	bot := fakeClient(t, server, "engine", true)

	session := server.startConfiguredMatch(openingSeat(testEntry(bot), testEntry(human)))
	if session == nil {
		t.Fatal("expected a session")
	}
	// The seating's own `newgame`/`isready`, answered the way the client does.
	// It has to be answered rather than skipped: an outstanding question is the
	// other thing that drops a prompt, and it would hide what is under test.
	answerEngine(t, server, bot, []string{"readyok"})

	moves := session.game.LegalMoves()
	if len(moves) == 0 {
		t.Fatal("expected the engine to have legal moves")
	}
	chosen := moves[0]
	drain(bot)

	// The engine answers the move question that readyok brought on, instantly,
	// so its move is held for the pace.
	answerEngine(t, server, bot, []string{
		"bestmove " + notation.FormatSquare(chosen.From) + "-" + notation.FormatSquare(chosen.To),
	})
	if held := len(session.game.Record().Moves()); held != 0 {
		t.Fatalf("expected the move to be waiting, not played: %d moves", held)
	}

	// Anything that touches the game asks again while it waits.
	server.promptBot(session, session.game.Snapshot())
	for _, message := range drain(bot) {
		if message.Type == "engine" {
			t.Fatalf(
				"the engine was asked again about game %s while its move waited",
				message.GameID,
			)
		}
	}

	// And the move it did give is played, once.
	deadline := time.Now().Add(10 * time.Second)
	for len(session.game.Record().Moves()) == 0 && time.Now().Before(deadline) {
		time.Sleep(5 * time.Millisecond)
	}
	if played := len(session.game.Record().Moves()); played != 1 {
		t.Fatalf("expected the held move to be played once, got %d moves", played)
	}
}

// answerEngine replies to whatever an engine has been asked, from its own side
// of the socket.
func answerEngine(t *testing.T, server *Server, client *Client, lines []string) {
	t.Helper()
	client.bot.mu.Lock()
	pending := client.bot.pending
	client.bot.mu.Unlock()
	if pending == nil {
		t.Fatal("expected an outstanding question to answer")
	}
	server.handleEngineReply(client, ClientMessage{
		Type:   "engine_reply",
		Seq:    pending.sequence,
		GameID: pending.gameID,
		Lines:  lines,
	})
}
