package server

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
	"rps-strategy/backend/internal/rpsi"
)

// The published field, which exists to answer one complaint: an owner whose
// engine was not in the round could not find out why.
//
// So these tests are about the *reasons* rather than about the list. A field
// that silently leaves an engine out is the bug this route was written to fix,
// and a field that leaves it in while the pairer would not seat it is the same
// bug with the sign flipped — which is why `ladderBotRefusal` is the one
// function both the pairer and this route ask.

// readLadderRounds asks the route the way a browser does.
func readLadderRounds(t *testing.T, server *Server) LadderRoundsView {
	t.Helper()
	response := tournamentRequest(t, server.Routes(), "GET", "/api/ladder-rounds", nil, "")
	if response.Code != http.StatusOK {
		t.Fatalf("the field should be readable by anybody, got %d: %s", response.Code, response.Body)
	}
	var view LadderRoundsView
	if err := json.Unmarshal(response.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode the rounds view: %v", err)
	}
	return view
}

// fieldEntry finds one engine in the published field, by the name it plays as.
func fieldEntry(t *testing.T, view LadderRoundsView, name string) LadderFieldEngine {
	t.Helper()
	for _, engine := range view.Field {
		if engine.Name == name {
			return engine
		}
	}
	t.Fatalf("%s is not in the published field: %#v", name, view.Field)
	return LadderFieldEngine{}
}

// nextRoundMode is the mode the field is computed for, which the page's own
// countdown points at. Read off the view rather than from the clock, so a test
// that runs across the top of an hour does not assert about the wrong round.
func nextRoundMode(t *testing.T, view LadderRoundsView) game.ModeID {
	t.Helper()
	if len(view.Schedule) == 0 {
		t.Fatal("the schedule is empty, so there is no round to have a field for")
	}
	return view.Schedule[0].ModeID
}

func TestTheFieldSaysWhyAnEnteredEngineIsNotConnected(t *testing.T) {
	server := ladderTestServer(t)
	// Entered through the database and never connected, which is the commonest
	// shape of the complaint: the switch is on, the engine is not running, and
	// nothing anywhere said so.
	_, token, err := server.data.MintBotToken(t.Context(), "owner")
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	if _, err := server.data.ClaimBot(
		t.Context(), token, persistence.BotSettings{Name: "Absent"},
	); err != nil {
		t.Fatalf("claim: %v", err)
	}

	view := readLadderRounds(t, server)
	absent := fieldEntry(t, view, "Absent")
	if absent.Ready {
		t.Error("an engine nobody is running was published as ready for the round")
	}
	if absent.Reason != "not connected" {
		t.Errorf("reason is %q, want %q", absent.Reason, "not connected")
	}
	// The flag rather than the words. The page hides these rows and counts them
	// instead, and it must not be matching on prose to decide which.
	if absent.Online {
		t.Error("an engine nobody is running was published as online")
	}
	// The whole point of listing it: the owner's name is on the row, so they can
	// recognise it as theirs.
	if absent.Author != "Owner" {
		t.Errorf("author is %q, want the owner's name", absent.Author)
	}
}

func TestTheFieldSaysWhenAnEngineDoesNotPlayTheRoundsMode(t *testing.T) {
	server := ladderTestServer(t)
	bot := poolBot(t, server, "Narrow", "owner-narrow")
	view := readLadderRounds(t, server)
	round := nextRoundMode(t, view)
	// A real mode that the rotation does not use, so this holds whatever hour
	// the test runs at. Naming one rather than subtracting the round's mode from
	// `ladderModes`: that list is one entry long now, so the subtraction leaves
	// nothing — and an empty handshake means "plays whatever it is given", which
	// would make this assert the opposite of what it says.
	other := game.ModeTotalWar
	if round == other {
		other = game.ModeInfiltration
	}
	client := server.readyBot(bot.BotID)
	client.bot.mu.Lock()
	client.bot.handshake = rpsi.Handshake{
		Name: "narrow", Protocol: 1, Modes: []game.ModeID{other},
	}
	client.bot.mu.Unlock()

	narrow := fieldEntry(t, readLadderRounds(t, server), "Narrow")
	if narrow.Ready {
		t.Error("an engine that does not play the round's mode was published as ready")
	}
	if narrow.Reason == "" {
		t.Error("an engine that will not be seated must say why")
	}
}

func TestEveryPublishedRoundIsIntransitive(t *testing.T) {
	// The rule, pinned. Ranked bot games come from this pool and nowhere else,
	// so the rotation is the whole of "what do rated engine games get played
	// at" — and it is a one-line list, which is exactly the kind of thing that
	// gets a mode added back to it by somebody who did not mean to.
	//
	// Asserted over the published schedule rather than over `ladderModes`, so
	// it also covers the derivation: a page reads these previews, and a client
	// told the round is Intransitive while the pairer seats Total War would be
	// wrong in the way nobody checks.
	view := readLadderRounds(t, ladderTestServer(t))
	if len(view.Schedule) == 0 {
		t.Fatal("no schedule was published")
	}
	for _, round := range view.Schedule {
		if round.ModeID != game.ModeIntransitive {
			t.Errorf("a round at %d is %s, and the pool plays only Intransitive",
				round.AtUnixMs, round.ModeID)
		}
	}
	// And the clocks still move, which is what carries the rest of the argument
	// for a rotation on its own: an engine tuned for one time control has to
	// answer at the others.
	clocks := map[int64]bool{}
	for _, round := range view.Schedule {
		clocks[round.InitialTimeMs] = true
	}
	if len(clocks) < 2 {
		t.Errorf("the schedule uses %d clock, so there is no rotation left", len(clocks))
	}
	if view.RotationHours != len(ladderClocks) {
		t.Errorf("the rotation is published as %d hours, want %d",
			view.RotationHours, len(ladderClocks))
	}
}

func TestTheFieldAgreesWithThePairerAboutEveryEngine(t *testing.T) {
	// The invariant that matters. Two ways to get this wrong and they cost the
	// same: a field that shows an engine as ready when the round will not seat
	// it, and one that shows a refusal for an engine the round will seat.
	server := ladderTestServer(t)
	poolBot(t, server, "Alpha", "owner-alpha")
	poolBot(t, server, "Beta", "owner-beta")

	view := readLadderRounds(t, server)
	round := nextRoundMode(t, view)
	for _, engine := range view.Field {
		if engine.Ready != server.ladderBotIsAvailable(engine.BotID, round) {
			t.Errorf(
				"%s: the field says ready=%t and the pairer disagrees (reason %q)",
				engine.Name, engine.Ready, engine.Reason,
			)
		}
		if engine.Ready != (engine.Reason == "") {
			t.Errorf("%s: ready=%t with reason %q", engine.Name, engine.Ready, engine.Reason)
		}
	}
}

func TestTheFieldPutsReadyEnginesFirst(t *testing.T) {
	server := ladderTestServer(t)
	poolBot(t, server, "Connected", "owner-connected")
	if _, token, err := server.data.MintBotToken(t.Context(), "owner"); err != nil {
		t.Fatalf("mint: %v", err)
	} else if _, err := server.data.ClaimBot(
		t.Context(), token, persistence.BotSettings{Name: "Offline"},
	); err != nil {
		t.Fatalf("claim: %v", err)
	}

	view := readLadderRounds(t, server)
	if len(view.Field) < 2 {
		t.Fatalf("both engines should be in the field: %#v", view.Field)
	}
	if view.Field[0].Name != "Connected" {
		t.Errorf("field is led by %q, want the engine that would be seated", view.Field[0].Name)
	}
	// Both are still served, offline one included. The page decides what to
	// draw; the route's job is to be able to answer for every entrant, because
	// an owner's own engine that is not running is the case their panel has to
	// explain.
	if !fieldEntry(t, view, "Connected").Online || fieldEntry(t, view, "Offline").Online {
		t.Error("online was not published per engine")
	}
}

func TestThereIsNoLastRoundBeforeOneHasRun(t *testing.T) {
	// A fresh server, and the epoch is not a round. A page handed one would
	// draw January 1970 with an empty scoreboard under it.
	view := readLadderRounds(t, ladderTestServer(t))
	if view.Last != nil {
		t.Errorf("a pool that has never run a round reported one: %#v", view.Last)
	}
	if view.MinimumField != ladderMinimumField || view.GamesPerRound != 2 {
		t.Errorf("the pool's own numbers did not travel: %#v", view)
	}
}

func TestTheLastRoundReportsTheConditionsOfItsOwnHour(t *testing.T) {
	// The conditions are derived from the hour rather than stored, so a report
	// that read them off the current clock would describe every past round as
	// having played whatever this hour plays. Five hours back is guaranteed to
	// differ in both: the modes step every hour over a list of three and the
	// clocks over a list of four, and five is coprime to neither.
	server := ladderTestServer(t)
	slot := ladderRoundSlot(time.Now().Add(-5 * time.Hour))
	if err := server.data.MarkLadderRound(t.Context(), slot.UnixMilli()); err != nil {
		t.Fatalf("mark round: %v", err)
	}

	last := readLadderRounds(t, server).Last
	if last == nil {
		t.Fatal("a round that ran was not reported")
	}
	if last.AtUnixMs != slot.UnixMilli() {
		t.Errorf("round at %d, want its slot %d", last.AtUnixMs, slot.UnixMilli())
	}
	modeID, clock := ladderConditions(slot)
	if last.ModeID != modeID || last.InitialTimeMs != clock.InitialTimeMs {
		t.Errorf("conditions are %s/%d, want %s/%d",
			last.ModeID, last.InitialTimeMs, modeID, clock.InitialTimeMs)
	}
	nowMode, nowClock := ladderConditions(time.Now())
	if modeID == nowMode && clock.InitialTimeMs == nowClock.InitialTimeMs {
		t.Fatal("the fixture no longer differs from the current hour, so it proves nothing")
	}
	// A round with nothing in it is a round that found an empty room, and is
	// drawn as one. Nil would read as a round that never happened.
	if last.Series == nil {
		t.Error("a round with no runs should report an empty list rather than nothing")
	}
}

func TestTheLastRoundReportsOnlyTheRunsThePoolSeated(t *testing.T) {
	server := ladderTestServer(t)
	alpha := poolBot(t, server, "Alpha", "owner-alpha")
	beta := poolBot(t, server, "Beta", "owner-beta")

	// Marked at the current slot, because a run is filed at the moment it is
	// created and the window is the round's own hour.
	slot := ladderRoundSlot(time.Now())
	if err := server.data.MarkLadderRound(t.Context(), slot.UnixMilli()); err != nil {
		t.Fatalf("mark round: %v", err)
	}
	modeID, clock := ladderConditions(slot)
	if _, err := server.data.CreateBotSeries(t.Context(), persistence.BotSeries{
		SeriesID:      "round-run",
		ModeID:        modeID,
		FirstBotID:    alpha.BotID,
		SecondBotID:   beta.BotID,
		Pairs:         1,
		OpeningPlies:  ladderOpeningPlies,
		InitialTimeMs: clock.InitialTimeMs,
		IncrementMs:   clock.IncrementMs,
		Ladder:        true,
	}); err != nil {
		t.Fatalf("create series: %v", err)
	}
	// And one somebody started by hand in the same hour, which the round did not
	// seat and which moved nothing on the ladder. Showing it as the round's
	// result would be describing the wrong games.
	if _, err := server.data.CreateBotSeries(t.Context(), persistence.BotSeries{
		SeriesID:      "by-hand",
		ModeID:        modeID,
		FirstBotID:    beta.BotID,
		SecondBotID:   alpha.BotID,
		Pairs:         1,
		InitialTimeMs: clock.InitialTimeMs,
	}); err != nil {
		t.Fatalf("create casual series: %v", err)
	}

	last := readLadderRounds(t, server).Last
	if last == nil {
		t.Fatal("a round that ran was not reported")
	}
	if len(last.Series) != 1 || last.Series[0].SeriesID != "round-run" {
		t.Fatalf("the round should report its own run and only that: %#v", last.Series)
	}
}
