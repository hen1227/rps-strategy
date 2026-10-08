package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"testing"
	"time"

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

// A ranked match between two engines, started by somebody who owns neither,
// counts — and is played at the rotation's conditions like a drawn one, since
// the names are the only thing the person pressing supplies.
//
// It is not a round, though: the rounds page reports `ladder` runs as the hour's
// results and the pairer spends an engine's hourly budget on them, and a match
// somebody named is neither. So the run reads back as a chosen pairing, ranked
// and not ladder, credited to whoever pressed, and its games are filed ranked.
func TestARankedMatchBetweenAnyTwoEnginesCounts(t *testing.T) {
	server, _, _ := seriesTestBots(t)
	first := addRivalSeriesBot(t, server, "First")
	second := addRivalSeriesBot(t, server, "Second")
	registeredSession(t, server.data, "watcher", "Watcher")

	series, err := server.StartRankedMatch(t.Context(), "watcher", first.BotID, second.BotID)
	if err != nil {
		t.Fatalf("start ranked match: %v", err)
	}
	if series.Pairing != persistence.BotSeriesPairingChosen || series.Casual || series.Ladder {
		t.Fatalf("a named ranked match read back as pairing %q, casual %v, ladder %v",
			series.Pairing, series.Casual, series.Ladder)
	}
	if series.FirstBotID != first.BotID || series.SecondBotID != second.BotID {
		t.Fatalf("the match seated %s and %s, not the two engines asked for",
			series.FirstBotID, series.SecondBotID)
	}
	if series.RequestedByUserID != "watcher" {
		t.Fatalf("the match was credited to %q, not to whoever pressed", series.RequestedByUserID)
	}
	if series.Pairs != 1 || !slices.Contains(ladderModes, series.ModeID) ||
		!slices.Contains(ladderClocks, game.TimeControl{
			InitialTimeMs: series.InitialTimeMs, IncrementMs: series.IncrementMs,
		}) {
		t.Fatalf("a named ranked match was not one pair at the rotation's conditions: %#v", series)
	}
	if server.botSeriesRuns.inLadderRun(first.BotID) {
		t.Fatal("a named match spent the engine's hourly round")
	}
	awaitSeriesFinished(t, server)

	history, err := server.data.GameHistory(t.Context(), first.UserID, 10, 0)
	if err != nil {
		t.Fatalf("read history: %v", err)
	}
	if len(history) != 2 {
		t.Fatalf("a ranked match filed %d games, want the pair's two", len(history))
	}
	for _, played := range history {
		if !played.Ranked {
			t.Fatalf("ranked match game %s was seated casual", played.GameID)
		}
	}
}

// A random opponent for somebody else's engine is the same press with no name:
// PLAY NOW, for anybody.
func TestARankedMatchDrawsAnOpponentForAnybodysEngine(t *testing.T) {
	server, _, _ := seriesTestBots(t)
	engine := addRivalSeriesBot(t, server, "Engine")
	addRivalSeriesBot(t, server, "Other")
	registeredSession(t, server.data, "watcher", "Watcher")

	series, err := server.StartRankedMatch(t.Context(), "watcher", engine.BotID, "")
	if err != nil {
		t.Fatalf("start random ranked match: %v", err)
	}
	t.Cleanup(func() { _ = server.AbortBotSeries(series.SeriesID, "", true) })
	if series.Pairing != persistence.BotSeriesPairingRandom || series.Casual {
		t.Fatalf("a random ranked match read back as pairing %q, casual %v",
			series.Pairing, series.Casual)
	}
}

// Every refusal a named match adds, one per case: one owner's two engines, an
// engine that has not entered, a block between the person pressing and an
// engine's owner, and a person barred from ranked play.
func TestARankedMatchRefusesWhatTheLadderWouldNotRate(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	first := addRivalSeriesBot(t, server, "First")
	withdrawn := addRivalSeriesBot(t, server, "Withdrawn")
	blocking := addRivalSeriesBot(t, server, "Blocking")
	registeredSession(t, server.data, "watcher", "Watcher")

	if _, err := server.StartRankedMatch(
		t.Context(), "watcher", alpha.BotID, beta.BotID,
	); !errors.Is(err, errRankedOneOwner) {
		t.Fatalf("one owner's two engines were given a ranked match: %v", err)
	}

	if _, err := server.data.UpdateBotSettings(
		t.Context(), withdrawn.BotID, true, true, false, "",
	); err != nil {
		t.Fatalf("withdraw: %v", err)
	}
	if _, err := server.StartRankedMatch(
		t.Context(), "watcher", first.BotID, withdrawn.BotID,
	); !errors.Is(err, errRankedNotEntered) {
		t.Fatalf("an engine that had not entered was named for a ranked match: %v", err)
	}

	// The engine's owner blocking the person pressing, which is the direction
	// a reader would expect to matter; either one refuses.
	server.cacheBlock(blocking.OwnerUserID, "watcher")
	if _, err := server.StartRankedMatch(
		t.Context(), "watcher", first.BotID, blocking.BotID,
	); !errors.Is(err, errRankedBlocked) {
		t.Fatalf("a ranked match was seated across a block: %v", err)
	}

	restriction, err := server.data.SetRestriction(
		t.Context(), "watcher", persistence.RestrictRanked, "ladder manipulation", "admin", nil,
	)
	if err != nil {
		t.Fatalf("restrict: %v", err)
	}
	server.cacheRestriction("watcher", restriction)
	if _, err := server.StartRankedMatch(
		t.Context(), "watcher", first.BotID, "",
	); !errors.Is(err, errRankedBarred) {
		t.Fatalf("a person barred from ranked play started a ranked match: %v", err)
	}

	if len(server.botSeriesRuns.summaries()) != 0 {
		t.Fatal("a refused ranked match left a run behind")
	}
}

// Anybody may press for any engine, so the ceiling that keeps one person from
// holding every engine at once applies: one series at a time, ranked or not.
func TestARankedMatchCountsAgainstThePersonsOneSeries(t *testing.T) {
	server, _, _ := seriesTestBots(t)
	one := addRivalSeriesBot(t, server, "One")
	two := addRivalSeriesBot(t, server, "Two")
	three := addRivalSeriesBot(t, server, "Three")
	four := addRivalSeriesBot(t, server, "Four")
	registeredSession(t, server.data, "watcher", "Watcher")

	series, err := server.StartRankedMatch(t.Context(), "watcher", one.BotID, two.BotID)
	if err != nil {
		t.Fatalf("first ranked match: %v", err)
	}
	t.Cleanup(func() { _ = server.AbortBotSeries(series.SeriesID, "", true) })
	if _, err := server.StartRankedMatch(
		t.Context(), "watcher", three.BotID, four.BotID,
	); !errors.Is(err, errSeriesAlreadyYours) {
		t.Fatalf("a second ranked match started while the first was running: %v", err)
	}
}

// A ranked match is played out, like every ranked one: whoever started it
// cannot stop it after watching the first game go badly.
func TestARankedMatchCannotBeStoppedByWhoeverStartedIt(t *testing.T) {
	server, _, _ := seriesTestBots(t)
	first := addRivalSeriesBot(t, server, "First")
	second := addRivalSeriesBot(t, server, "Second")

	series, err := server.StartRankedMatch(t.Context(), first.OwnerUserID, first.BotID, second.BotID)
	if err != nil {
		t.Fatalf("start ranked match: %v", err)
	}
	t.Cleanup(func() { _ = server.AbortBotSeries(series.SeriesID, "", true) })

	if err := server.AbortBotSeries(
		series.SeriesID, first.OwnerUserID, false,
	); !errors.Is(err, errSeriesRankedNoStop) {
		t.Fatalf("the person who started a ranked match stopped it: %v", err)
	}
}

// The route: any signed-in person, for any engine. No body is PLAY NOW, exactly
// as it was before the button could name anybody, and a body naming an engine
// is a named match. Both answer with the run, carrying the pairing a card will
// draw. No session is refused before anything is looked up.
func TestTheRankedMatchRouteTakesAnySignedInPerson(t *testing.T) {
	server, _, _ := seriesTestBots(t)
	first := addRivalSeriesBot(t, server, "First")
	second := addRivalSeriesBot(t, server, "Second")
	token := registeredSession(t, server.data, "watcher", "Watcher")
	handler := server.Routes()
	path := "/api/bots/" + first.BotID + "/ranked-match"

	if anonymous := tournamentRequest(t, handler, http.MethodPost, path, nil, ""); anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("a ranked match without a session answered %d: %s", anonymous.Code, anonymous.Body)
	}

	drawn := tournamentRequest(t, handler, http.MethodPost, path, nil, token)
	if drawn.Code != http.StatusCreated {
		t.Fatalf("PLAY NOW with no body answered %d: %s", drawn.Code, drawn.Body)
	}
	var random persistence.BotSeries
	if err := json.Unmarshal(drawn.Body.Bytes(), &random); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if random.Pairing != persistence.BotSeriesPairingRandom || random.Casual {
		t.Fatalf("PLAY NOW read back as pairing %q, casual %v", random.Pairing, random.Casual)
	}
	if err := server.AbortBotSeries(random.SeriesID, "", true); err != nil {
		t.Fatalf("stop: %v", err)
	}
	// A stopped run lets the game on the board finish, so the engines are free
	// once that game is over rather than the moment the run is.
	deadline := time.Now().Add(30 * time.Second)
	for server.freeBotConnection(first.BotID) == nil || server.freeBotConnection(second.BotID) == nil {
		if time.Now().After(deadline) {
			t.Fatal("the stopped PLAY NOW's last game never finished")
		}
		time.Sleep(5 * time.Millisecond)
	}

	chosen := tournamentRequest(t, handler, http.MethodPost, path,
		map[string]string{"opponentBotId": second.BotID}, token)
	if chosen.Code != http.StatusCreated {
		t.Fatalf("a named ranked match answered %d: %s", chosen.Code, chosen.Body)
	}
	var match persistence.BotSeries
	if err := json.Unmarshal(chosen.Body.Bytes(), &match); err != nil {
		t.Fatalf("decode: %v", err)
	}
	t.Cleanup(func() { _ = server.AbortBotSeries(match.SeriesID, "", true) })
	if match.Pairing != persistence.BotSeriesPairingChosen || match.Casual ||
		match.SecondBotID != second.BotID {
		t.Fatalf("a named ranked match read back as pairing %q, casual %v, against %s",
			match.Pairing, match.Casual, match.SecondBotID)
	}
}
