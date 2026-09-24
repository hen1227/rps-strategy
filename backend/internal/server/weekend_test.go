package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	_ "time/tzdata"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// The recurring bot event, from the two moments that make it: the doors and the
// start. And from the thing weekly scheduling added — a voting window that has
// to name a day as well as an hour.

// weekendServer is a server whose weekend arena is configured and enabled.
func weekendServer(
	t *testing.T,
	apply func(*persistence.WeekendConfig),
) (*Server, persistence.WeekendConfig) {
	t.Helper()
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = data.Close() })
	server := NewWithStoreAndAdminToken(data, nil, "test-secret")

	config, err := data.WeekendConfiguration(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	config.Enabled = true
	config.MinimumField = 2
	if apply != nil {
		apply(&config)
	}
	saved, err := data.SaveWeekendConfiguration(t.Context(), config)
	if err != nil {
		t.Fatalf("save weekend config: %v", err)
	}
	return server, saved
}

func TestWeekendDoorsOpenOnceAndOnlyOnce(t *testing.T) {
	server, config := weekendServer(t, nil)
	ctx := t.Context()

	location, err := time.LoadLocation(config.Zone)
	if err != nil {
		t.Fatalf("the embedded zone database should resolve %q: %v", config.Zone, err)
	}
	today := time.Now().In(location).Format("2006-01-02")
	startAt, err := config.WeekendStartFor(today)
	if err != nil {
		t.Fatal(err)
	}

	server.openWeekendDoors(ctx, config, today, startAt)
	open, err := server.data.OpenWeekend(ctx)
	if err != nil {
		t.Fatalf("the doors should have opened: %v", err)
	}
	if open.Kind != persistence.TournamentWeekend || open.WeekendNumber != 1 {
		t.Fatalf("expected weekend arena #1, got %#v", open.Kind)
	}
	if open.Status != persistence.TournamentRegistration {
		t.Fatalf("an opened event should be taking entries, got %q", open.Status)
	}
	if open.Field != persistence.FieldBots {
		t.Fatalf("a bot arena should admit engines only, got %q", open.Field)
	}
	if open.StartsAtUnixMs == nil || *open.StartsAtUnixMs != startAt.UnixMilli() {
		t.Fatal("the event should publish the hour it means to start")
	}

	// The scheduler runs every minute. Opening a second event for the same
	// weekend is the failure that guard exists for, and a restart is the case it
	// has to survive — which is why the answer is a stored date rather than a
	// flag in memory.
	reread, err := server.data.WeekendConfiguration(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if reread.LastRunDate != today {
		t.Fatalf("the run should be recorded against %s, got %q", today, reread.LastRunDate)
	}
	server.openWeekendDoors(ctx, reread, today, startAt)
	events, err := server.data.RecentWeekends(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("expected one event, got %d", len(events))
	}
}

// An event with nobody in it is called off out loud rather than left open.
func TestAWeekendWithoutAFieldIsCalledOff(t *testing.T) {
	server, config := weekendServer(t, func(config *persistence.WeekendConfig) {
		config.MinimumField = 6
	})
	ctx := t.Context()
	today := time.Now().Format("2006-01-02")
	// Published as having already started, so this test is about the field and
	// not about what time of day it happens to run at. beginWeekend waits for
	// the hour an event published — see TestAWeekendWaitsForItsOwnPublishedHour.
	server.openWeekendDoors(ctx, config, today, time.Now().Add(-time.Minute))
	server.beginWeekend(ctx, config, today)

	events, err := server.data.RecentWeekends(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("expected one event, got %d", len(events))
	}
	if events[0].Status != persistence.TournamentCancelled {
		t.Fatalf("an event with no engines should be cancelled, got %q", events[0].Status)
	}
	if events[0].CancelledAtUnixMs == nil {
		t.Fatal("a cancelled event should carry the moment it was called off")
	}
}

// Engines already in the bracket are a field, and are counted as one.
//
// The sweep skips an engine that is already entered, because there is nothing
// to do for it — and counting only what the sweep *added* called off an arena
// with thirteen engines in it for want of six. The minimum is a rule about who
// is playing, so the number it is checked against has to be the field.
func TestAWeekendCountsEnginesThatAreAlreadyIn(t *testing.T) {
	server, config := weekendServer(t, func(config *persistence.WeekendConfig) {
		config.MinimumField = 6
	})
	ctx := t.Context()
	today := time.Now().Format("2006-01-02")
	server.openWeekendDoors(ctx, config, today, time.Now().Add(-time.Minute))
	open, err := server.data.OpenWeekend(ctx)
	if err != nil {
		t.Fatal(err)
	}

	// Seven engines in the bracket and none of them connected, which is what the
	// sweep sees when the field was filled before it ran.
	names := []string{"Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf"}
	for _, name := range names {
		owner := "owner-" + name
		registeredSession(t, server.data, owner, "Author"+name)
		bot := ownedEngine(t, server.data, owner, name, []game.ModeID{config.ModeID})
		if _, err := server.data.HostSignupForTournament(
			ctx, open.TournamentID, bot.UserID, bot.Name, "bot."+strings.ToLower(name),
		); err != nil {
			t.Fatalf("enter %s: %v", name, err)
		}
	}

	server.beginWeekend(ctx, config, today)

	events, err := server.data.RecentWeekends(ctx, 10)
	if err != nil {
		t.Fatal(err)
	}
	if events[0].Status == persistence.TournamentCancelled {
		t.Fatalf(
			"%d engines in the field and a minimum of %d, and it was called off anyway",
			len(events[0].Players), config.MinimumField,
		)
	}
	if events[0].Status != persistence.TournamentInProgress {
		t.Fatalf("expected the arena to be under way, got %q", events[0].Status)
	}
	// Seven is under the round-robin ceiling, and the format is chosen from the
	// same count. Reading it off the sweep's additions made every such event a
	// round robin of nobody.
	if events[0].Format != persistence.FormatRoundRobin {
		t.Fatalf("a field of %d should play everybody, got %q", len(names), events[0].Format)
	}
}

// An event waits for the hour it published, not for the one in the settings.
//
// The two differ whenever a host opens one by hand, and the page counts down to
// the published one. Getting this wrong meant a hand-opened event was started by
// the next tick, with nobody there.
func TestAWeekendWaitsForItsOwnPublishedHour(t *testing.T) {
	server, config := weekendServer(t, func(config *persistence.WeekendConfig) {
		// An hour that has already gone by today, which is the case that bit.
		// Slot 0 of the default window, so it survives the clamp.
		config.StartDay = config.WindowOpensDay
		config.StartLocal = "09:00"
		config.MinimumField = 1
	})
	ctx := t.Context()
	today := time.Now().Format("2006-01-02")

	// Opened by hand, and published as starting well into the future.
	server.openWeekendDoors(ctx, config, today, time.Now().Add(2*time.Hour))
	server.beginWeekend(ctx, config, today)

	open, err := server.data.OpenWeekend(ctx)
	if err != nil {
		t.Fatalf("the event should still be open: %v", err)
	}
	if open.Status != persistence.TournamentRegistration {
		t.Fatalf("an event published for later must not start now, got %q", open.Status)
	}

	// And once its hour has passed, it goes — here into the cancellation that a
	// field of nobody earns.
	past := time.Now().Add(-time.Minute).UnixMilli()
	if _, err := server.data.UpdateTournament(ctx, open.TournamentID, persistence.TournamentConfig{
		Name:           open.Name,
		Description:    open.Description,
		ModeID:         open.ModeID,
		ModeName:       open.ModeName,
		StartsAtUnixMs: &past,
	}); err != nil {
		t.Fatal(err)
	}
	server.beginWeekend(ctx, config, today)
	after, err := server.data.Tournament(ctx, open.TournamentID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != persistence.TournamentCancelled {
		t.Fatalf("an event whose hour has come should be settled, got %q", after.Status)
	}
}

// The ballot decides the clock, and a thin turnout leaves the host's default.
func TestTheClockBallotDecidesTheEvent(t *testing.T) {
	server, config := weekendServer(t, func(config *persistence.WeekendConfig) {
		config.DefaultControl = "3+1"
		config.MinimumVotes = 2
	})
	ctx := t.Context()
	today := time.Now().Format("2006-01-02")

	// One vote is not a mandate: below the turnout floor the default stands.
	verifiedEntrants(t, server.data, "voter-one", "voter-two")
	if err := server.data.CastWeekendVote(
		ctx, persistence.WeekendVoteClock, today, "voter-one", "5+2",
	); err != nil {
		t.Fatal(err)
	}
	tallies, _, err := server.data.WeekendPoll(ctx, persistence.WeekendVoteClock, today, "")
	if err != nil {
		t.Fatal(err)
	}
	if winner := persistence.WeekendWinner(tallies, config.MinimumVotes, config.DefaultControl); winner != "3+1" {
		t.Fatalf("one vote should not carry the ballot, got %q", winner)
	}

	if err := server.data.CastWeekendVote(
		ctx, persistence.WeekendVoteClock, today, "voter-two", "5+2",
	); err != nil {
		t.Fatal(err)
	}
	tallies, mine, err := server.data.WeekendPoll(
		ctx, persistence.WeekendVoteClock, today, "voter-two",
	)
	if err != nil {
		t.Fatal(err)
	}
	if winner := persistence.WeekendWinner(tallies, config.MinimumVotes, config.DefaultControl); winner != "5+2" {
		t.Fatalf("the ballot should have carried, got %q", winner)
	}
	if mine != "5+2" {
		t.Fatalf("a voter should see their own choice, got %q", mine)
	}

	// A changed vote replaces rather than adds.
	if err := server.data.CastWeekendVote(
		ctx, persistence.WeekendVoteClock, today, "voter-two", "1+1",
	); err != nil {
		t.Fatal(err)
	}
	tallies, _, err = server.data.WeekendPoll(ctx, persistence.WeekendVoteClock, today, "")
	if err != nil {
		t.Fatal(err)
	}
	total := 0
	for _, tally := range tallies {
		total += tally.Votes
	}
	if total != 2 {
		t.Fatalf("changing a vote should not add one, got %d", total)
	}
	// Split one-all, nobody has a mandate and the default stands.
	if winner := persistence.WeekendWinner(tallies, config.MinimumVotes, config.DefaultControl); winner != "3+1" {
		t.Fatalf("a tie should fall back to the default, got %q", winner)
	}
}

// The page reads in one request, and says what it knows before anything is open.
func TestTheWeekendPageReadsBeforeAnythingIsOpen(t *testing.T) {
	server, config := weekendServer(t, nil)
	handler := server.Routes()

	response := tournamentRequest(t, handler, http.MethodGet, "/api/weekend", nil, "")
	if response.Code != http.StatusOK {
		t.Fatalf("expected the weekend arena to read, got %d: %s", response.Code, response.Body)
	}
	var view WeekendView
	if err := json.NewDecoder(response.Body).Decode(&view); err != nil {
		t.Fatal(err)
	}
	if !view.Enabled {
		t.Fatal("the configured weekend arena should read as enabled")
	}
	if view.StartsAtUnixMs == 0 || view.DoorsAtUnixMs == 0 {
		t.Fatal("a scheduled event should say when it opens and starts")
	}
	if view.DoorsAtUnixMs >= view.StartsAtUnixMs {
		t.Fatal("the doors should open before the event starts")
	}
	// The countdown points at the weekday the series runs on, whichever day of
	// the week the test happens to run.
	starts := time.UnixMilli(view.StartsAtUnixMs)
	if location, err := time.LoadLocation(config.Zone); err == nil {
		if day := int(starts.In(location).Weekday()); day != config.StartDay {
			t.Fatalf("expected the next event on weekday %d, got %d", config.StartDay, day)
		}
	}
	if view.Tournament != nil {
		t.Fatal("nothing is open yet, so there should be no event")
	}
	if len(view.Clock.Options) != len(persistence.WeekendControls) {
		t.Fatalf("the whole ballot should be offered, got %#v", view.Clock.Options)
	}
	// Every slot of the window, because the field is worldwide.
	if len(view.Availability.Slots) != persistence.WeekendSlots {
		t.Fatalf("expected %d slots on the grid, got %d",
			persistence.WeekendSlots, len(view.Availability.Slots))
	}
	// With nobody having answered, the grid leaves the slot we already meet at:
	// 20:00 Saturday is eleven hours into a window that opens at 09:00.
	if view.Availability.Leading != 11 {
		t.Fatalf("an unanswered grid should keep slot 11, got %d", view.Availability.Leading)
	}
}

// The window is thirty-six consecutive hours, each carrying the instant it next
// falls on.
//
// The instants are the whole of the fix for weekly scheduling. An hour on its
// own cannot say which night it means — Saturday 21:00 in New York is already
// Sunday in Berlin — so every slot travels as a moment, and each client names
// the day from it in its own zone.
func TestTheVotingWindowSpansSaturdayAndSunday(t *testing.T) {
	server, config := weekendServer(t, nil)
	handler := server.Routes()

	response := tournamentRequest(t, handler, http.MethodGet, "/api/weekend", nil, "")
	var view WeekendView
	if err := json.NewDecoder(response.Body).Decode(&view); err != nil {
		t.Fatal(err)
	}
	location, err := time.LoadLocation(config.Zone)
	if err != nil {
		t.Fatal(err)
	}

	previous := int64(0)
	days := make(map[time.Weekday]int)
	for index, slot := range view.Availability.Slots {
		if slot.Slot != index {
			t.Fatalf("slot %d arrived out of order at %d", slot.Slot, index)
		}
		if slot.AtUnixMs == 0 {
			t.Fatalf("slot %d has no instant to print", slot.Slot)
		}
		// Every slot is ahead of us: the grid is a preference for an event that
		// has not happened, and half a window in the past is unanswerable.
		if slot.AtUnixMs <= time.Now().UnixMilli() {
			t.Fatalf("slot %d should point at its next occurrence", slot.Slot)
		}
		if slot.AtUnixMs <= previous {
			t.Fatalf("slot %d does not follow the one before it", slot.Slot)
		}
		previous = slot.AtUnixMs
		days[time.UnixMilli(slot.AtUnixMs).In(location).Weekday()]++
	}

	// In the host's own zone the default window is Saturday morning to Sunday
	// evening, and nothing else. A reader elsewhere may see three of their own
	// days across the same thirty-six hours, which is exactly why the page names
	// the day from the instant rather than from the slot.
	if len(days) != 2 || days[time.Saturday] != 15 || days[time.Sunday] != 21 {
		t.Fatalf("expected 15 Saturday and 21 Sunday slots in the host's zone, got %#v", days)
	}

	first := time.UnixMilli(view.Availability.Slots[0].AtUnixMs).In(location)
	last := time.UnixMilli(view.Availability.Slots[persistence.WeekendSlots-1].AtUnixMs).In(location)
	if first.Hour() != config.WindowOpensHour {
		t.Fatalf("the window should open at %02d:00, got %02d:00",
			config.WindowOpensHour, first.Hour())
	}
	if last.Hour() != 20 || last.Weekday() != time.Sunday {
		t.Fatalf("the window should close on Sunday at 20:00, got %s", last.Format(time.RFC1123))
	}
}

// A slot is a weekday and an hour, and the two translate both ways.
func TestSlotsAndTheScheduleAgree(t *testing.T) {
	config := persistence.DefaultWeekendConfig()
	config.StartLocal = "20:30"

	// Slot 11 of a window that opens Saturday at 09:00 is Saturday 20:00, which
	// is where the default schedule sits.
	if slot := config.SlotOf(); slot != 11 {
		t.Fatalf("expected the default schedule at slot 11, got %d", slot)
	}
	// The minutes are the host's decision and the grid was never asked about
	// them: slot 8 with a 20:30 schedule is 17:30, not 17:00.
	moved := config.WithSlot(8)
	if moved.StartLocal != "17:30" || moved.StartDay != int(time.Saturday) {
		t.Fatalf("expected Saturday 17:30, got %s %q",
			time.Weekday(moved.StartDay), moved.StartLocal)
	}
	// And the last slot crosses into Sunday, which is the point of the window.
	end := config.WithSlot(persistence.WeekendSlots - 1)
	if end.StartDay != int(time.Sunday) || end.StartLocal != "20:30" {
		t.Fatalf("expected Sunday 20:30, got %s %q",
			time.Weekday(end.StartDay), end.StartLocal)
	}
	for slot := range persistence.WeekendSlots {
		if round := config.WithSlot(slot).SlotOf(); round != slot {
			t.Fatalf("slot %d came back as %d", slot, round)
		}
	}
}

// A schedule the window cannot name is dragged to the nearer end of it.
//
// The grid is the only thing that can move the schedule, so an hour no slot
// points at is an hour nobody can vote away from — including every row written
// by the nightly build, which had an hour and no weekend at all.
func TestAScheduleOutsideTheWindowIsPulledOntoIt(t *testing.T) {
	for _, sample := range []struct {
		name  string
		day   int
		clock string
		slot  int
	}{
		{"a Tuesday lunchtime is nearer the end", int(time.Tuesday), "12:00", 35},
		{"the small hours of Saturday are nearer the start", int(time.Saturday), "02:00", 0},
		{"an hour already on the grid is left alone", int(time.Sunday), "19:00", 34},
	} {
		t.Run(sample.name, func(t *testing.T) {
			server, _ := weekendServer(t, func(config *persistence.WeekendConfig) {
				config.StartDay = sample.day
				config.StartLocal = sample.clock
			})
			stored, err := server.data.WeekendConfiguration(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			if stored.SlotOf() != sample.slot {
				t.Fatalf("expected slot %d, got %d (%s %s)", sample.slot, stored.SlotOf(),
					time.Weekday(stored.StartDay), stored.StartLocal)
			}
		})
	}
}

// Voting needs a session, and refuses anything that is not on the ballot.
func TestWeekendVotingIsSignedInAndBounded(t *testing.T) {
	server, _ := weekendServer(t, nil)
	handler := server.Routes()
	session := registeredSession(t, server.data, "voter", "Voter")

	anonymous := tournamentRequest(
		t, handler, http.MethodPost, "/api/weekend/votes",
		map[string]any{"kind": "clock", "choice": "3+1"}, "",
	)
	if anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without a session, got %d: %s", anonymous.Code, anonymous.Body)
	}

	bogus := tournamentRequest(
		t, handler, http.MethodPost, "/api/weekend/votes",
		map[string]any{"kind": "clock", "choice": "9+9"}, session,
	)
	if bogus.Code != http.StatusBadRequest {
		t.Fatalf("expected a choice off the ballot to be refused, got %d: %s",
			bogus.Code, bogus.Body)
	}

	cast := tournamentRequest(
		t, handler, http.MethodPost, "/api/weekend/votes",
		map[string]any{"kind": "clock", "choice": "5+2"}, session,
	)
	if cast.Code != http.StatusOK {
		t.Fatalf("expected the vote to be taken, got %d: %s", cast.Code, cast.Body)
	}
	// The reply is the page again, so a client never has to ask twice.
	var view WeekendView
	if err := json.NewDecoder(cast.Body).Decode(&view); err != nil {
		t.Fatal(err)
	}
	if view.Clock.Mine != "5+2" {
		t.Fatalf("the voter should see their own choice, got %q", view.Clock.Mine)
	}
}

// Availability is a set, and the fullest slot wins — but only on a real answer.
//
// This is the whole reason it is not a ballot: a field spread across every
// continent has no single favourite slot, and asking for one would pick
// whichever timezone turned up.
func TestAvailabilityPicksTheSlotMostPeopleCanMake(t *testing.T) {
	server, _ := weekendServer(t, func(config *persistence.WeekendConfig) {
		config.StartLocal = "20:30"
		config.MinimumVotes = 2
	})
	handler := server.Routes()
	ctx := t.Context()

	mark := func(session string, slots ...int) *httptest.ResponseRecorder {
		return tournamentRequest(
			t, handler, http.MethodPut, "/api/weekend/availability",
			map[string]any{"slots": slots}, session,
		)
	}

	anonymous := mark("", 20)
	if anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without a session, got %d", anonymous.Code)
	}
	one := registeredSession(t, server.data, "east", "East")
	if bogus := mark(one, persistence.WeekendSlots); bogus.Code != http.StatusBadRequest {
		t.Fatalf("expected a slot off the window to be refused, got %d: %s",
			bogus.Code, bogus.Body)
	}

	// Somebody in Europe and somebody in Asia, overlapping on one slot.
	two := registeredSession(t, server.data, "asia", "Asia")
	three := registeredSession(t, server.data, "west", "West")
	mark(one, 6, 7, 8)
	mark(two, 7, 8, 9)
	reply := mark(three, 8, 9, 10)
	if reply.Code != http.StatusOK {
		t.Fatalf("expected the answer to be taken, got %d: %s", reply.Code, reply.Body)
	}
	var view WeekendView
	if err := json.NewDecoder(reply.Body).Decode(&view); err != nil {
		t.Fatal(err)
	}
	if view.Availability.Answered != 3 {
		t.Fatalf("expected three people to have answered, got %d", view.Availability.Answered)
	}
	if view.Availability.Leading != 8 {
		t.Fatalf("slot 8 is the only one all three can make, got %d", view.Availability.Leading)
	}
	if view.Availability.Mine != 3 {
		t.Fatalf("the reader marked three slots, got %d", view.Availability.Mine)
	}

	// Sending the set again replaces it rather than adding to it.
	mark(three, 8)
	counts, mine, people, err := server.data.WeekendAvailability(ctx, "west")
	if err != nil {
		t.Fatal(err)
	}
	if people != 3 || counts[9] != 1 || counts[10] != 0 {
		t.Fatalf("a replaced set should drop what it left out: %#v", counts[6:11])
	}
	if mine[8] != true || mine[9] != false {
		t.Fatal("the reader's own marks should follow the replacement")
	}

	// A tie keeps the slot we already meet at, because a tie is not a request to
	// move.
	var tied [persistence.WeekendSlots]int
	tied[3], tied[4] = 5, 5
	if slot := persistence.WeekendAvailabilityWinner(tied, 10, 2, 11); slot != 11 {
		t.Fatalf("a tie should hold the current slot, got %d", slot)
	}
	// And so does a turnout nobody would call a mandate.
	var thin [persistence.WeekendSlots]int
	thin[3] = 1
	if slot := persistence.WeekendAvailabilityWinner(thin, 1, 5, 11); slot != 11 {
		t.Fatalf("a thin turnout should hold the current slot, got %d", slot)
	}
}

// The weekend arena plays Intransitive unless a host says otherwise, and
// "otherwise" has to survive a restart.
func TestTheWeekendDefaultsToIntransitiveAndKeepsAnOverride(t *testing.T) {
	// A file rather than :memory:, because the thing under test is what happens
	// on the *second* start: the correction has to run once and never again.
	path := filepath.Join(t.TempDir(), "weekend.sqlite")
	ctx := t.Context()

	data, err := persistence.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	config, err := data.WeekendConfiguration(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if config.ModeID != game.ModeIntransitive {
		t.Fatalf("a fresh weekend arena should play Intransitive, got %q", config.ModeID)
	}

	// A host picking Total War is a decision, and the one-time correction must
	// not undo it — which it would if it ran on every boot rather than once.
	config.ModeID = game.ModeTotalWar
	if _, err := data.SaveWeekendConfiguration(ctx, config); err != nil {
		t.Fatal(err)
	}
	if err := data.Close(); err != nil {
		t.Fatal(err)
	}

	restarted, err := persistence.Open(path)
	if err != nil {
		t.Fatalf("reopening should re-run the migrations cleanly: %v", err)
	}
	defer restarted.Close()
	after, err := restarted.WeekendConfiguration(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if after.ModeID != game.ModeTotalWar {
		t.Fatalf("a restart undid the host's mode choice, got %q", after.ModeID)
	}
}

// The host's settings survive a save, and the scheduler's bookkeeping does not
// come from the request.
func TestWeekendConfigRoundTripsWithoutTakingTheRunDate(t *testing.T) {
	server, _ := weekendServer(t, nil)
	handler := server.Routes()
	ctx := t.Context()
	if err := server.data.MarkWeekendRun(ctx, "2026-01-01"); err != nil {
		t.Fatal(err)
	}

	saved := tournamentRequest(
		t, handler, http.MethodPut, "/api/admin/weekend",
		map[string]any{
			"enabled": true, "zone": "America/New_York", "startLocal": "19:30",
			"startDay": int(time.Sunday), "windowOpensDay": int(time.Saturday),
			"windowOpensHour": 9, "modeId": string(game.ModeIntransitive),
			"minimumField": 4, "doorsMinutes": 45, "pollClosesMinutes": 20,
			"gamesPerMatch": 4, "roundRobinMax": 8, "pollEnabled": true,
			"defaultControl": "1+1", "minimumVotes": 5, "graceSeconds": 120,
			"skipDate": "", "lastRunDate": "1999-12-31", "updatedAtUnixMs": 0,
		},
		"test-secret",
	)
	if saved.Code != http.StatusOK {
		t.Fatalf("expected the settings to save, got %d: %s", saved.Code, saved.Body)
	}
	stored, err := server.data.WeekendConfiguration(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if stored.StartLocal != "19:30" || stored.ModeID != game.ModeIntransitive {
		t.Fatalf("the settings did not survive: %#v", stored)
	}
	// Sunday evening is thirty-four hours into a window that opens Saturday at
	// nine, so it is a slot people can vote for rather than one they cannot.
	if stored.StartDay != int(time.Sunday) || stored.SlotOf() != 34 {
		t.Fatalf("expected Sunday at slot 34, got %s at %d",
			time.Weekday(stored.StartDay), stored.SlotOf())
	}
	// The one field a save must not take: it is how the scheduler knows an event
	// has already run, and letting a save rewind it would re-open it.
	if stored.LastRunDate != "2026-01-01" {
		t.Fatalf("a save rewound the run date to %q", stored.LastRunDate)
	}

	// A zone the binary cannot resolve is a refusal, not a silent hour shift.
	bad := tournamentRequest(
		t, handler, http.MethodPut, "/api/admin/weekend",
		map[string]any{
			"enabled": true, "zone": "Mars/Olympus", "startLocal": "20:00",
			"startDay": int(time.Saturday), "windowOpensDay": int(time.Saturday),
			"windowOpensHour": 9, "modeId": string(game.ModeTotalWar),
			"minimumField": 6, "doorsMinutes": 30, "pollClosesMinutes": 20,
			"gamesPerMatch": 2, "roundRobinMax": 10, "pollEnabled": true,
			"defaultControl": "3+1", "minimumVotes": 3, "graceSeconds": 90,
			"skipDate": "", "lastRunDate": "", "updatedAtUnixMs": 0,
		},
		"test-secret",
	)
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("expected an unknown zone to be refused, got %d: %s", bad.Code, bad.Body)
	}
}

// A weekend arena is not a tournament anybody won for the purposes of the
// lifetime title. It has its own crown instead.
func TestAWeekendDoesNotAwardTournamentChampion(t *testing.T) {
	server, _ := weekendServer(t, nil)
	ctx := t.Context()
	registeredEntrants := []string{"one", "two"}
	verifiedEntrants(t, server.data, registeredEntrants...)

	settings := persistence.DefaultTournamentConfig(game.ModeTotalWar, "Total War")
	settings.Name = "Weekend Bot Arena #1"
	settings.Kind = persistence.TournamentWeekend
	settings.WeekendNumber = 1
	if _, err := server.data.CreateTournament(ctx, "nightly-x", settings); err != nil {
		t.Fatal(err)
	}
	if _, err := server.data.PublishTournament(ctx, "nightly-x"); err != nil {
		t.Fatal(err)
	}
	for _, id := range registeredEntrants {
		if _, err := server.data.SignupForTournament(
			ctx, "nightly-x", id, id, id+".discord", true,
		); err != nil {
			t.Fatal(err)
		}
	}
	started, err := server.data.StartTournament(ctx, "nightly-x")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := server.data.SetTournamentMatchResult(
		ctx, "nightly-x", started.Matches[0].MatchID, persistence.MatchPlayer1Win,
	); err != nil {
		t.Fatal(err)
	}

	titles, err := server.data.EvaluateTitles(ctx, "one")
	if err != nil {
		t.Fatal(err)
	}
	for _, title := range titles {
		if title.ID == persistence.TitleTournamentChampion {
			t.Fatal("winning a weekend arena must not award the lifetime tournament title")
		}
	}
	// The crown counts it, which is the marker a weekend arena does earn.
	wins, err := server.data.WeekendWins(ctx, 0)
	if err != nil {
		t.Fatal(err)
	}
	if wins["one"] != 1 {
		t.Fatalf("expected the winner to hold one weekend win, got %#v", wins)
	}
}
