package server

import (
	"errors"
	"strings"
	"testing"
	"time"

	_ "time/tzdata"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// The ranked pool and the weekly arena, which are played by the same engines
// and used to meet on the hour. See ladder_pause.go.

// arenaTakingEntries opens this weekend's doors for an arena published to start
// at startAt, and lets the pool see it.
func arenaTakingEntries(
	t *testing.T,
	server *Server,
	config persistence.WeekendConfig,
	startAt time.Time,
) persistence.Tournament {
	t.Helper()
	server.openWeekendDoors(t.Context(), config, time.Now().Format("2006-01-02"), startAt)
	open, err := server.data.OpenWeekend(t.Context())
	if err != nil {
		t.Fatalf("the doors should have opened: %v", err)
	}
	server.refreshBotReservations()
	return open
}

// arenaUnderWay is an arena that has begun between two engines nobody is
// running.
//
// So the engines a test connects afterwards were never swept into it and are
// held by no reservation: anything the pool refuses them is the stand-down and
// nothing else.
func arenaUnderWay(t *testing.T) (*Server, persistence.Tournament) {
	t.Helper()
	server, config := weekendServer(t, nil)
	ctx := t.Context()
	today := time.Now().Format("2006-01-02")
	server.openWeekendDoors(ctx, config, today, time.Now().Add(-time.Minute))
	open, err := server.data.OpenWeekend(ctx)
	if err != nil {
		t.Fatalf("the doors should have opened: %v", err)
	}
	for _, name := range []string{"Entrant", "Rival"} {
		owner := "owner-" + strings.ToLower(name)
		registeredSession(t, server.data, owner, "Author"+name)
		bot := ownedEngine(t, server.data, owner, name, []game.ModeID{config.ModeID})
		if _, err := server.data.HostSignupForTournament(
			ctx, open.TournamentID, bot.UserID, bot.Name, "bot."+strings.ToLower(name),
		); err != nil {
			t.Fatalf("enter %s: %v", name, err)
		}
	}
	server.beginWeekend(ctx, config, today)
	started, err := server.data.Tournament(ctx, open.TournamentID)
	if err != nil {
		t.Fatal(err)
	}
	if started.Status != persistence.TournamentInProgress {
		t.Fatalf("the arena should be under way, got %q", started.Status)
	}
	return server, started
}

// The window on its own: from half an hour before an arena's published hour
// until it is over, and a lead either side for one that never begins.
func TestTheStandDownRunsFromTheLeadUntilTheArenaEnds(t *testing.T) {
	start := time.Date(2026, 9, 26, 20, 0, 0, 0, time.UTC)
	startMs := start.UnixMilli()
	arena := &ladderArena{}
	arena.observeEvents([]persistence.Tournament{{
		Name:           "Weekend Bot Arena #9",
		Kind:           persistence.TournamentWeekend,
		Status:         persistence.TournamentRegistration,
		StartsAtUnixMs: &startMs,
	}})

	cases := []struct {
		name   string
		at     time.Time
		paused bool
	}{
		{"before the lead", start.Add(-ladderArenaLead - time.Second), false},
		{"at the lead", start.Add(-ladderArenaLead), true},
		// The moment the round used to seat itself, a beat ahead of the arena.
		{"the round's first look after the hour", start.Add(5 * time.Second), true},
		{"just inside the tail", start.Add(ladderArenaLead - time.Second), true},
		// Still taking entries half an hour after it was meant to begin: it is
		// not going to, and the pool stops waiting for it.
		{"an arena that never began", start.Add(ladderArenaLead), false},
	}
	for _, check := range cases {
		stand := arena.standDown(check.at)
		if got := stand.covers(check.at); got != check.paused {
			t.Errorf("%s: paused = %t, want %t", check.name, got, check.paused)
		}
		if check.paused && stand.event != "Weekend Bot Arena #9" {
			t.Errorf("%s: stood down for %q", check.name, stand.event)
		}
	}

	// Begun, it holds every moment until it is over, however long it runs.
	arena.observeEvents([]persistence.Tournament{{
		Name:           "Weekend Bot Arena #9",
		Kind:           persistence.TournamentWeekend,
		Status:         persistence.TournamentInProgress,
		StartsAtUnixMs: &startMs,
	}})
	for _, at := range []time.Time{start.Add(time.Hour), start.Add(6 * time.Hour)} {
		if !arena.standDown(at).covers(at) {
			t.Errorf("an arena under way did not hold the pool at %v", at)
		}
	}

	// Over, or somebody else's event, and the pool has its hours back.
	arena.observeEvents([]persistence.Tournament{{
		Name:   "Sunday Cup",
		Kind:   persistence.TournamentManual,
		Status: persistence.TournamentInProgress,
	}})
	if arena.standDown(start).covers(start) {
		t.Error("a host's own event held the pool")
	}
}

// Doors can open as little as five minutes ahead, which is inside the lead, so
// until they do the calendar is what holds the pool.
func TestTheCalendarHoldsThePoolUntilTheDoorsOpen(t *testing.T) {
	config := persistence.DefaultWeekendConfig()
	config.Enabled = true
	config.DoorsMinutes = 10
	location, err := time.LoadLocation(config.Zone)
	if err != nil {
		t.Fatal(err)
	}
	// Saturday evening in the host's zone, for the default eight o'clock start.
	arena := &ladderArena{}
	for _, check := range []struct {
		at     time.Time
		paused bool
	}{
		{time.Date(2026, 9, 26, 19, 0, 0, 0, location), false},
		{time.Date(2026, 9, 26, 19, 40, 0, 0, location), true},
	} {
		arena.observeSchedule(config, check.at)
		stand := arena.standDown(check.at)
		if stand.covers(check.at) != check.paused {
			t.Errorf("at %s: paused = %t, want %t", check.at.Format("15:04"), !check.paused, check.paused)
		}
		if check.paused && stand.event != ladderArenaTitle {
			t.Errorf("stood down for %q before the doors opened", stand.event)
		}
	}

	// Once that date's doors have opened the event is the answer. Here that is
	// that there is none — the host called it off — and the calendar, still
	// naming tonight, must not hold the pool on its behalf.
	evening := time.Date(2026, 9, 26, 19, 40, 0, 0, location)
	config.LastRunDate = "2026-09-26"
	arena.observeSchedule(config, evening)
	if arena.standDown(evening).covers(evening) {
		t.Error("the calendar held the pool for an arena whose doors had already opened")
	}

	config.LastRunDate, config.Enabled = "", false
	arena.observeSchedule(config, evening)
	if arena.standDown(evening).covers(evening) {
		t.Error("a schedule that is switched off held the pool")
	}
}

// The collision this was built for: an arena that starts on the hour, and the
// round for the same hour, which used to seat the arena's engines a minute
// before the arena recalled them and voided their games.
func TestAnArenaOnTheHourHasTheHourToItself(t *testing.T) {
	server, config := weekendServer(t, nil)
	anchor := poolBot(t, server, "Anchor", "owner-anchor")
	markLadderAnchor(t, server, anchor)
	entrant := poolBot(t, server, "Entrant", "owner-entrant")
	server.seriesDelay = time.Hour

	hour := time.Now().UTC().Truncate(time.Hour).Add(time.Hour)
	arena := arenaTakingEntries(t, server, config, hour)

	// The page says so ahead of time rather than counting down to it.
	schedule := server.ladderSchedule(t.Context(), hour.Add(-10*time.Minute), 2)
	if schedule[0].AtUnixMs != hour.UnixMilli() || schedule[0].PausedFor != arena.Name {
		t.Fatalf("the arena's hour should be published as paused for %q, got %+v",
			arena.Name, schedule[0])
	}

	// Five seconds after the hour: when the round looks, and up to a minute
	// before the arena does.
	server.runLadderRound(hour.Add(5 * time.Second))
	if state := ladderState(t, server); state.RoundsRun != 0 {
		t.Fatalf("a round ran at the arena's start: %+v", state)
	}
	for _, bot := range []persistence.Bot{anchor, entrant} {
		if server.botSeriesRuns.inLadderRun(bot.BotID) {
			t.Fatalf("%s was paired for ranked games at the arena's start", bot.Name)
		}
	}

	// Called off for want of a field, a minute after the hour. The round the
	// hour still owes is seated then, inside its grace, rather than lost with
	// the arena.
	if _, err := server.data.CancelTournament(t.Context(), arena.TournamentID, "too few engines"); err != nil {
		t.Fatal(err)
	}
	server.refreshBotReservations()
	server.runLadderRound(hour.Add(2 * time.Minute))
	state := ladderState(t, server)
	if state.RoundsRun != 1 || state.LastRoundAtUnixMs != hour.UnixMilli() {
		t.Fatalf("the hour's round should run once the arena is off: %+v", state)
	}
	if !server.botSeriesRuns.inLadderRun(entrant.BotID) {
		t.Fatal("the round ran without seating the engines it had")
	}
}

// While the arena is on, nothing ranked starts, and that includes an engine that
// is not in it — the case its reservation never covered.
func TestNothingRankedStartsWhileTheArenaIsOn(t *testing.T) {
	server, arena := arenaUnderWay(t)
	anchor := poolBot(t, server, "Anchor", "owner-anchor")
	markLadderAnchor(t, server, anchor)
	outsider := poolBot(t, server, "Outsider", "owner-outsider")
	server.seriesDelay = time.Hour

	want := "ranked games are paused until " + arena.Name + " ends"
	standing := server.ladderBotStanding(outsider.BotID, game.ModeIntransitive)
	if standing.In || standing.Reason != want {
		t.Fatalf("an engine outside the arena should be told %q, got %+v", want, standing)
	}

	// Not the round, not a press, and not the door both of them go through.
	server.runLadderRound(time.Now().UTC().Truncate(time.Hour).Add(20 * time.Second))
	if state := ladderState(t, server); state.RoundsRun != 0 {
		t.Fatalf("a round ran during the arena: %+v", state)
	}
	if _, err := server.StartLadderMatch(t.Context(), outsider.BotID, "owner-outsider"); err == nil ||
		err.Error() != want {
		t.Fatalf("a ranked press during the arena should be refused with %q, got %v", want, err)
	}
	ranked := BotSeriesRequest{
		FirstBotID:   outsider.BotID,
		SecondBotID:  anchor.BotID,
		ModeID:       game.ModeIntransitive,
		Pairs:        1,
		OpeningPlies: ladderOpeningPlies,
		Control:      ladderClocks[0],
		Privileged:   true,
		Ladder:       true,
	}
	if _, err := server.StartBotSeries(t.Context(), ranked); !errors.Is(err, errLadderPaused) {
		t.Fatalf("a ranked run started during the arena: %v", err)
	}

	// The end is not known yet, so every round published is paused.
	for _, preview := range server.ladderSchedule(t.Context(), time.Now(), 3) {
		if preview.PausedFor != arena.Name {
			t.Fatalf("a round during the arena was published as going ahead: %+v", preview)
		}
	}

	// Ranked games only: a series somebody starts for its own sake is not the
	// pool's, and the arena has no quarrel with it.
	casual := ranked
	casual.Ladder = false
	if _, err := server.StartBotSeries(t.Context(), casual); err != nil {
		t.Fatalf("a casual series during the arena was refused: %v", err)
	}

	// Over, and the pool is back at once.
	for _, match := range arena.Matches {
		if _, err := server.data.SetTournamentMatchResult(
			t.Context(), arena.TournamentID, match.MatchID, persistence.MatchPlayer1Win,
		); err != nil {
			t.Fatal(err)
		}
	}
	server.refreshBotReservations()
	if finished, err := server.data.Tournament(t.Context(), arena.TournamentID); err != nil ||
		finished.Status != persistence.TournamentCompleted {
		t.Fatalf("the arena should be over: %v", err)
	}
	if standing := server.ladderBotStanding(outsider.BotID, game.ModeIntransitive); !standing.In {
		t.Fatalf("the pool should be back once the arena is over, got %+v", standing)
	}
	for _, preview := range server.ladderSchedule(t.Context(), time.Now(), 3) {
		if preview.PausedFor != "" {
			t.Fatalf("a round after the arena is still published as paused: %+v", preview)
		}
	}
}

// A pairing held over from the hour before is let go when the stand-down
// begins, rather than starting into it the moment its engine comes free.
func TestAHeldPairingIsLetGoForTheArena(t *testing.T) {
	server, config := weekendServer(t, nil)
	anchor := poolBot(t, server, "Anchor", "owner-anchor")
	markLadderAnchor(t, server, anchor)
	busy := poolBot(t, server, "Busy", "owner-busy")
	server.seriesDelay = time.Hour

	putBotInAGame(t, server, busy.BotID)
	server.seatLadderRound(t.Context(), time.Now())
	if len(heldPairings(server)) != 1 {
		t.Fatal("the pairing was not held")
	}

	// An arena ten minutes off, which puts now inside its lead.
	arenaTakingEntries(t, server, config, time.Now().Add(10*time.Minute))
	freeBotFromItsGame(t, server, busy.BotID)
	server.resumeHeldPairings(t.Context())
	if remaining := heldPairings(server); len(remaining) != 0 {
		t.Fatalf("a held pairing outlived the start of the stand-down: %d held", len(remaining))
	}
	if server.botSeriesRuns.inLadderRun(busy.BotID) {
		t.Fatal("a held pairing started inside the arena's lead")
	}
}
