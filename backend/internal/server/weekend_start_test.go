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

// An arena opened by hand starts at the hour it published, even on a day the
// schedule does not name. That is what replaying a broken arena needs. The
// arena that started has moved next weekend's slot, so the replay is opened on
// a day the schedule no longer names.
func TestAHandOpenedArenaStartsOnADayTheScheduleDoesNotName(t *testing.T) {
	server, config := weekendServer(t, func(config *persistence.WeekendConfig) {
		location, err := time.LoadLocation(config.Zone)
		if err != nil {
			t.Fatal(err)
		}
		// Two days on, so the whole thirty-six-hour window misses today.
		elsewhere := (int(time.Now().In(location).Weekday()) + 2) % 7
		config.WindowOpensDay = elsewhere
		config.WindowOpensHour = 9
		config.StartDay = elsewhere
		config.StartLocal = "09:00"
	})
	ctx := t.Context()
	location, err := time.LoadLocation(config.Zone)
	if err != nil {
		t.Fatal(err)
	}
	if config.RunsOn(time.Now().In(location)) {
		t.Fatalf("the schedule should not name today, got %s", time.Weekday(config.StartDay))
	}

	modes := []game.ModeID{config.ModeID}
	for _, name := range []string{"Alpha", "Bravo"} {
		owner := "owner-" + name
		registeredSession(t, server.data, owner, "Author"+name)
		connectEngine(t, server, ownedEngine(t, server.data, owner, name, modes), modes)
	}
	today := time.Now().In(location).Format("2006-01-02")
	server.openWeekendDoors(ctx, config, today, time.Now().Add(-time.Minute))

	server.runWeekend(time.Now())

	open, err := server.data.Tournament(ctx, "nightly-"+today)
	if err != nil {
		t.Fatal(err)
	}
	if open.Status != persistence.TournamentInProgress {
		t.Fatalf("an arena past its published hour should have started, got %q", open.Status)
	}
	if len(open.Players) != 2 || open.Format != persistence.FormatRoundRobin {
		t.Fatalf("it should start the way a scheduled one does: the sweep, then the format; "+
			"got %d players and %q", len(open.Players), open.Format)
	}
}

// START on an arena is the arena's own start, done early. It sweeps in the
// engines online, picks the format the field calls for, and announces it, as
// the timer would. The generic start used to skip all of it and play the doors'
// placeholder Swiss with whoever happened to be entered.
func TestStartingAnArenaByHandStartsItTheWayItsTimerWould(t *testing.T) {
	server, config := weekendServer(t, nil)
	ctx := t.Context()
	modes := []game.ModeID{config.ModeID}
	for _, name := range []string{"Alpha", "Bravo", "Charlie"} {
		owner := "owner-" + name
		registeredSession(t, server.data, owner, "Author"+name)
		connectEngine(t, server, ownedEngine(t, server.data, owner, name, modes), modes)
	}
	today := time.Now().Format("2006-01-02")
	// Published for an hour from now, so this is the host starting it early.
	server.openWeekendDoors(ctx, config, today, time.Now().Add(time.Hour))
	open, err := server.data.OpenWeekend(ctx)
	if err != nil {
		t.Fatal(err)
	}

	response := tournamentRequest(
		t, server.Routes(), http.MethodPost,
		"/api/admin/tournaments/"+open.TournamentID+"/start", nil, "test-secret",
	)
	if response.Code != http.StatusOK {
		t.Fatalf("START should start the arena, got %d: %s", response.Code, response.Body.String())
	}
	started, err := server.data.Tournament(ctx, open.TournamentID)
	if err != nil {
		t.Fatal(err)
	}
	if started.Status != persistence.TournamentInProgress || len(started.Players) != 3 {
		t.Fatalf("the engines online should have been swept in; got %q with %d players",
			started.Status, len(started.Players))
	}
	if started.Format != persistence.FormatRoundRobin {
		t.Fatalf("three engines should play everybody, got %q", started.Format)
	}
	if notice := server.notices.current(); notice == nil || !strings.Contains(notice.Text, "under way") {
		t.Fatalf("the start should be announced, got %#v", notice)
	}
}

// START on an arena whose field is under the minimum keeps it open and says
// why. The timer calls such an arena off. A host pressing START wants it played,
// and a cancelled event cannot be.
func TestStartingAThinArenaByHandSaysWhyAndKeepsItOpen(t *testing.T) {
	server, config := weekendServer(t, func(config *persistence.WeekendConfig) {
		config.MinimumField = 4
	})
	ctx := t.Context()
	modes := []game.ModeID{config.ModeID}
	registeredSession(t, server.data, "owner-Alpha", "AuthorAlpha")
	connectEngine(t, server, ownedEngine(t, server.data, "owner-Alpha", "Alpha", modes), modes)
	server.openWeekendDoors(ctx, config, time.Now().Format("2006-01-02"), time.Now().Add(time.Hour))
	open, err := server.data.OpenWeekend(ctx)
	if err != nil {
		t.Fatal(err)
	}

	response := tournamentRequest(
		t, server.Routes(), http.MethodPost,
		"/api/admin/tournaments/"+open.TournamentID+"/start", nil, "test-secret",
	)
	if response.Code != http.StatusConflict || !strings.Contains(response.Body.String(), "needs 4") {
		t.Fatalf("a thin field should be refused with the reason, got %d: %s",
			response.Code, response.Body.String())
	}
	still, err := server.data.Tournament(ctx, open.TournamentID)
	if err != nil {
		t.Fatal(err)
	}
	if still.Status != persistence.TournamentRegistration {
		t.Fatalf("the arena should still be open, got %q", still.Status)
	}
}

// An arena's id is its date, so today's has to go before it can be run again.
// OPEN used to fail the insert into a log and answer "could not be opened".
func TestOpeningASecondArenaTodayNamesTheOneInTheWay(t *testing.T) {
	server, _ := weekendServer(t, nil)
	handler := server.Routes()
	ctx := t.Context()

	first := tournamentRequest(t, handler, http.MethodPost, "/api/admin/weekend/open", nil, "test-secret")
	if first.Code != http.StatusCreated {
		t.Fatalf("open: %d %s", first.Code, first.Body.String())
	}
	var opened persistence.Tournament
	if err := json.Unmarshal(first.Body.Bytes(), &opened); err != nil {
		t.Fatal(err)
	}
	// Over, as #6 is: no longer open, still on record.
	if _, err := server.data.CancelTournament(ctx, opened.TournamentID, "test"); err != nil {
		t.Fatal(err)
	}

	again := tournamentRequest(t, handler, http.MethodPost, "/api/admin/weekend/open", nil, "test-secret")
	if again.Code != http.StatusConflict ||
		!strings.Contains(again.Body.String(), opened.Name) ||
		!strings.Contains(again.Body.String(), "delete") {
		t.Fatalf("a second arena today should name the one in the way, got %d: %s",
			again.Code, again.Body.String())
	}

	deleted := tournamentRequest(
		t, handler, http.MethodDelete, "/api/admin/tournaments/"+opened.TournamentID, nil, "test-secret",
	)
	if deleted.Code != http.StatusOK {
		t.Fatalf("delete: %d %s", deleted.Code, deleted.Body.String())
	}
	rerun := tournamentRequest(t, handler, http.MethodPost, "/api/admin/weekend/open", nil, "test-secret")
	if rerun.Code != http.StatusCreated {
		t.Fatalf("once it is deleted, today's arena should open again; got %d: %s",
			rerun.Code, rerun.Body.String())
	}
}
