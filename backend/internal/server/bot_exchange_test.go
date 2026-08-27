package server

import (
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/notation"
)

// A game that ends while its engine is still being asked something must not
// leave that question behind. Only one exchange is in flight per engine, so a
// leftover gags the bot for the whole of its next game: `ask` drops the new
// game's `newgame` as a duplicate.
func TestAFinishedGameLeavesNoQuestionOutstanding(t *testing.T) {
	server := New(nil)
	human := fakeClient(t, server, "human", false)
	bot := fakeClient(t, server, "engine", true)

	// Game one. The bot is asked to set up, and no engine answers.
	first := server.startConfiguredMatch(testEntry(human), testEntry(bot), matchSetup{})
	if first == nil {
		t.Fatal("expected a first session")
	}
	bot.bot.mu.Lock()
	pending := bot.bot.pending
	bot.bot.mu.Unlock()
	if pending == nil || pending.gameID != first.gameID {
		t.Fatalf("expected an outstanding question about game one, got %#v", pending)
	}

	// It ends with that question still in flight — here the opponent resigns,
	// but the bot flagging mid-search does the same thing.
	server.resign(human)

	bot.bot.mu.Lock()
	leftover := bot.bot.pending
	bot.bot.mu.Unlock()
	if leftover != nil {
		t.Errorf("game one left a question outstanding: %#v", leftover)
	}

	// So the next game reaches the engine.
	second := server.startConfiguredMatch(testEntry(human), testEntry(bot), matchSetup{})
	if second == nil {
		t.Fatal("expected a second session")
	}
	bot.bot.mu.Lock()
	asked := bot.bot.pending
	bot.bot.mu.Unlock()
	if asked == nil || asked.gameID != second.gameID {
		t.Fatalf("the bot was not asked about game two, got %#v", asked)
	}
}

// The second line: a question about a finished game, if one ever does survive,
// may end that game and no other. This injects the leftover directly, so it
// pins the guard rather than the cleanup that now usually prevents it.
func TestATimedOutQuestionOnlyEndsItsOwnGame(t *testing.T) {
	server := New(nil)
	human := fakeClient(t, server, "human", false)
	bot := fakeClient(t, server, "engine", true)

	first := server.startConfiguredMatch(testEntry(human), testEntry(bot), matchSetup{})
	if first == nil {
		t.Fatal("expected a first session")
	}
	server.resign(human)

	second := server.startConfiguredMatch(testEntry(human), testEntry(bot), matchSetup{})
	if second == nil {
		t.Fatal("expected a second session")
	}

	// A question about game one, outstanding and long overdue.
	bot.bot.mu.Lock()
	bot.bot.pending = &botExchange{
		sequence: 99,
		gameID:   first.gameID,
		expect:   "bestmove",
		deadline: time.Now().Add(-time.Hour),
		onReply:  func([]string) {},
	}
	bot.bot.mu.Unlock()

	server.expireBotExchanges(time.Now())

	if state := second.game.Snapshot(); state.Status == game.Finished {
		t.Fatalf(
			"game two ended %s (winner %v) over a question about game one",
			state.EndReason, state.Winner,
		)
	}
}

// The same leftover, answered rather than timed out: a move chosen for one
// board must not be played onto another.
func TestAMoveChosenForAFinishedGameIsNotPlayedIntoTheNextOne(t *testing.T) {
	server := New(nil)
	human := fakeClient(t, server, "human", false)
	bot := fakeClient(t, server, "engine", true)

	// The bot takes the first seat in both games, so it is on move in game two
	// and the leftover move would in fact be legal there.
	first := server.startConfiguredMatch(testEntry(bot), testEntry(human), matchSetup{})
	if first == nil {
		t.Fatal("expected a first session")
	}
	moves := first.game.LegalMoves()
	if len(moves) == 0 {
		t.Fatal("expected legal moves in game one")
	}
	chosen := moves[0]
	server.resign(human)

	second := server.startConfiguredMatch(testEntry(bot), testEntry(human), matchSetup{})
	if second == nil {
		t.Fatal("expected a second session")
	}
	if state := second.game.Snapshot(); state.CurrentTurn != game.Red {
		t.Fatalf("expected the bot to be on move in game two, turn is %v", state.CurrentTurn)
	}
	before := len(second.game.Record().Moves())

	// The engine answers game one's question, late but inside its deadline.
	server.applyBotMove(bot, first.gameID, []string{
		"bestmove " + notation.FormatSquare(chosen.From) + "-" + notation.FormatSquare(chosen.To),
	})

	if after := len(second.game.Record().Moves()); after != before {
		t.Errorf(
			"a move chosen for game one was played into game two (%d moves became %d)",
			before, after,
		)
	}
}
