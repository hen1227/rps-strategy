package server

import (
	"errors"
	"slices"
	"testing"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// The point of the button: a press produces games that count.
//
// Asserted on the filed history rather than on the reply, because the ranked
// flag is written onto each game as it is seated and everything downstream —
// the ladder's own query, the archive, the PGN — reads it from there. A reply
// that said "ranked" over games filed casual is exactly the failure this has to
// catch.
func TestARankedMatchIsRanked(t *testing.T) {
	server, _, _ := seriesTestBots(t)
	asking := addRivalSeriesBot(t, server, "Asking")
	addRivalSeriesBot(t, server, "Opponent")

	if _, err := server.StartLadderMatch(
		t.Context(), asking.BotID, asking.OwnerUserID,
	); err != nil {
		t.Fatalf("start ranked match: %v", err)
	}
	awaitSeriesFinished(t, server)

	history, err := server.data.GameHistory(t.Context(), asking.UserID, 10, 0)
	if err != nil {
		t.Fatalf("read history: %v", err)
	}
	if len(history) == 0 {
		t.Fatal("the match filed no games")
	}
	for _, played := range history {
		if !played.Ranked {
			t.Fatalf("a ranked match game %s was seated casual", played.GameID)
		}
	}
}

// The conditions are the rotation's, not the requester's.
//
// There is no field on the route to send a clock in, which is the real defence
// — this is the test that notices when somebody adds one. An engine that could
// be rated only ever at the clock it was tuned for is the specialisation the
// rotation exists to prevent, and a button is a much easier place to reintroduce
// it than the pairer was.
func TestARankedMatchTakesItsConditionsFromTheRotation(t *testing.T) {
	server, _, _ := seriesTestBots(t)
	asking := addRivalSeriesBot(t, server, "Asking")
	addRivalSeriesBot(t, server, "Opponent")

	series, err := server.StartLadderMatch(t.Context(), asking.BotID, asking.OwnerUserID)
	if err != nil {
		t.Fatalf("start ranked match: %v", err)
	}
	t.Cleanup(func() { _ = server.AbortBotSeries(series.SeriesID, "", true) })

	clock := game.TimeControl{
		InitialTimeMs: series.InitialTimeMs,
		IncrementMs:   series.IncrementMs,
	}
	if !slices.Contains(ladderClocks, clock) {
		t.Fatalf("a ranked match was played at %#v, which is not in the rotation", clock)
	}
	if !slices.Contains(ladderModes, series.ModeID) {
		t.Fatalf("a ranked match was played at %s, which is not a ranked mode", series.ModeID)
	}
	// One pairing, two games, colours swapped — the same budget a round spends,
	// because the press is a round rather than a longer thing somebody asked
	// for. A run of six would be the old hand-started series wearing a new hat.
	if series.Pairs != 1 {
		t.Fatalf("a ranked match ran %d pairs rather than one", series.Pairs)
	}
}

// Two engines one person owns produce no rating, so drawing one as an opponent
// would be a press that visibly played two games and moved nothing.
//
// Alpha and Beta share an owner here, which is what makes the first half of
// this a real assertion rather than a coincidence of the fixture.
func TestARankedMatchNeverDrawsTheAskersOwnEngine(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)

	if _, err := server.pickLadderOpponent(
		t.Context(), alpha.BotID, game.ModeIntransitive,
	); !errors.Is(err, errLadderMatchNoOpponent) {
		t.Fatalf("one owner's second engine was offered as an opponent: %v", err)
	}

	// With somebody else on the board the draw has a legal answer, and it is
	// that one every time — repeated because this is a uniform pick and a single
	// pass could be luck.
	rival := addRivalSeriesBot(t, server, "Rival")
	for range 20 {
		opponent, err := server.pickLadderOpponent(
			t.Context(), alpha.BotID, game.ModeIntransitive,
		)
		if err != nil {
			t.Fatalf("pick opponent: %v", err)
		}
		if opponent == beta.BotID {
			t.Fatal("the draw picked another of the asker's own engines")
		}
		if opponent != rival.BotID {
			t.Fatalf("the draw picked %s, which is not on the board", opponent)
		}
	}
}

// The ladder switch is the consent to be rated, and it is also the consent to
// spend the owner's machine. A press must not quietly stand in for either.
func TestARankedMatchRefusesAnEngineThatHasNotEntered(t *testing.T) {
	server, _, _ := seriesTestBots(t)
	asking := addRivalSeriesBot(t, server, "Asking")
	addRivalSeriesBot(t, server, "Opponent")

	if _, err := server.data.UpdateBotSettings(
		t.Context(), asking.BotID, true, true, false, "",
	); err != nil {
		t.Fatalf("withdraw: %v", err)
	}

	_, err := server.StartLadderMatch(t.Context(), asking.BotID, asking.OwnerUserID)
	if !errors.Is(err, errLadderMatchNotEntered) {
		t.Fatalf("a withdrawn engine was given a ranked match: %v", err)
	}
}

// The consent rule from the other side: an engine that has not entered is not
// an opponent either, however online it is.
//
// A board with engines on it rather than an empty one, because those are the
// two ways to have nobody to play and only this one can regress. The press is
// refused rather than matched against a bystander, and the message says to come
// back — a button that fails silently is one people press until something
// breaks.
func TestARankedMatchWillNotDrawAnEngineThatHasNotEntered(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	asking := addRivalSeriesBot(t, server, "Asking")
	for _, bot := range []persistence.Bot{alpha, beta} {
		if _, err := server.data.UpdateBotSettings(
			t.Context(), bot.BotID, true, true, false, "",
		); err != nil {
			t.Fatalf("withdraw %s: %v", bot.Name, err)
		}
	}

	_, err := server.StartLadderMatch(t.Context(), asking.BotID, asking.OwnerUserID)
	if !errors.Is(err, errLadderMatchNoOpponent) {
		t.Fatalf("an engine that had not entered was drawn as an opponent: %v", err)
	}
}
