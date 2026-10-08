package server

import (
	"context"
	"fmt"
	"log"
	"strings"
	"sync"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// The weekend bot arena, driven from the lobby ticker.
//
// There is no scheduler goroutine and no cron. The lobby already wakes up every
// couple of seconds to do a dozen small jobs, and a recurring event is one more
// of them — with a guard so the actual work happens at most once a minute and
// costs one config read the rest of the time.
//
// An event is two moments rather than one:
//
//   - **doors**, when the event is created and published so people can see what
//     is coming, vote on the clock, and watch the expected field fill up;
//   - **start**, when the clock is locked in from the poll, every eligible
//     engine online is enrolled, and the thing either begins or is called off
//     for want of a field.
//
// Everything between and after is the ordinary tournament machinery: the same
// pairing, the same boards, the same standings.
//
// # Why weekly
//
// This ran every night for a year, on the theory that engines do not get tired.
// They do not, but they also do not change much between a Tuesday and a
// Wednesday, and a table that reads the same three nights running is a table
// nobody opens. A week is long enough that authors ship something between one
// event and the next, which is the thing that was actually worth watching.

// weekendTick is how often the scheduler does more than glance at the clock.
const weekendTick = time.Minute

// weekendState is the scheduler's memory between ticks.
type weekendState struct {
	mu       sync.Mutex
	lastLook time.Time
	// graceFrom is when a match first found itself missing an engine, keyed by
	// match. See settleWeekendForfeits.
	graceFrom map[tournamentMatchKey]time.Time
	// graceSpent is every match that has already been waited for once. An engine
	// that vanishes twice is gone, and the round should stop paying for it.
	graceSpent map[tournamentMatchKey]bool
}

func newWeekendState() *weekendState {
	return &weekendState{
		graceFrom:  make(map[tournamentMatchKey]time.Time),
		graceSpent: make(map[tournamentMatchKey]bool),
	}
}

// runWeekend is the whole of the scheduler, called from the lobby ticker.
func (server *Server) runWeekend(now time.Time) {
	server.weekend.mu.Lock()
	if now.Sub(server.weekend.lastLook) < weekendTick {
		server.weekend.mu.Unlock()
		return
	}
	server.weekend.lastLook = now
	server.weekend.mu.Unlock()

	ctx := context.Background()
	config, err := server.data.WeekendConfiguration(ctx)
	if err != nil {
		log.Printf("weekend: read config: %v", err)
		return
	}
	// Before any of the ways out below, so a schedule switched off or skipped
	// stops holding the ranked pool as well. See ladder_pause.go.
	server.ladderPool.arena.observeSchedule(config, now)
	if !config.Enabled {
		return
	}
	location, err := time.LoadLocation(strings.TrimSpace(config.Zone))
	if err != nil {
		// A zone the binary cannot resolve is a configuration problem the host
		// has to see, and running the event at the wrong hour would be worse
		// than not running it.
		log.Printf("weekend: unknown zone %q: %v", config.Zone, err)
		return
	}
	local := now.In(location)
	today := local.Format("2006-01-02")

	if config.SkipDate == today {
		return
	}
	// An event whose doors are open starts at the hour it published, on
	// whatever day that is. The rest of this is about when to open the next
	// one. A host can open one by hand on a day the schedule does not name, to
	// replay an arena that went wrong for instance, and the weekday check below
	// used to leave that event in registration for good.
	if open, err := server.data.OpenWeekend(ctx); err == nil &&
		open.Status == persistence.TournamentRegistration &&
		open.StartsAtUnixMs != nil &&
		!now.Before(time.UnixMilli(*open.StartsAtUnixMs)) {
		// The ballot was cast against the event's own date, which is in its id.
		server.beginWeekend(ctx, config, weekendEventDate(open))
		return
	}
	if !config.RunsOn(local) {
		return
	}
	startAt, err := config.WeekendStartFor(today)
	if err != nil {
		log.Printf("weekend: %v", err)
		return
	}
	doorsAt := startAt.Add(-time.Duration(config.DoorsMinutes) * time.Minute)

	if !local.Before(doorsAt) && config.LastRunDate != today {
		server.openWeekendDoors(ctx, config, today, startAt)
		return
	}
	if !local.Before(startAt) {
		server.beginWeekend(ctx, config, today)
	}
}

// openWeekendDoors creates and publishes this weekend's event.
func (server *Server) openWeekendDoors(
	ctx context.Context,
	config persistence.WeekendConfig,
	today string,
	startAt time.Time,
) {
	// Never two at once. An event that is somehow still being played at the next
	// one's doors is a problem to look at, not to add a second event to.
	if open, err := server.data.OpenWeekend(ctx); err == nil {
		log.Printf("weekend: %s is still open, skipping %s", open.Name, today)
		// Marked anyway, so this decision is made once rather than every minute
		// until midnight.
		if err := server.data.MarkWeekendRun(ctx, today); err != nil {
			log.Printf("weekend: mark run: %v", err)
		}
		return
	}
	// A deploy that is draining is waiting for the games it already has. Adding
	// an hour of new ones to the queue it is trying to empty is the one thing
	// that would make the wait unbounded.
	if server.isUpdating() {
		log.Printf("weekend: a restart is draining, skipping %s", today)
		return
	}

	number, err := server.data.NextWeekendNumber(ctx)
	if err != nil {
		log.Printf("weekend: next number: %v", err)
		return
	}
	modeName := server.modeNameFor(config.ModeID)
	settings := persistence.DefaultTournamentConfig(config.ModeID, modeName)
	settings.Name = fmt.Sprintf("Weekend Bot Arena #%d", number)
	settings.Description =
		"A weekly event for online engines. " +
			"Enable Tournaments to enter automatically."
	settings.Field = persistence.FieldBots
	settings.Seeding = persistence.SeedByRating
	settings.GamesPerMatch = config.GamesPerMatch
	settings.Kind = persistence.TournamentWeekend
	settings.WeekendNumber = number
	// The format is decided at the start, from the size of the field that turned
	// up. Swiss is the safe placeholder: it is legal at any size, where a round
	// robin over forty engines is not.
	settings.Format = persistence.FormatSwiss
	// Its length is set now rather than at the start, because a host can start
	// the event by hand from the tournament board, which never reaches
	// ConfigureWeekendStart and plays whatever the doors published.
	settings.SwissRounds = config.SwissRounds
	// Advisory, and the reason the countdown on the page has something to count
	// down to.
	startsAt := startAt.UnixMilli()
	settings.StartsAtUnixMs = &startsAt
	if control, ok := persistence.WeekendControlFor(config.DefaultControl); ok {
		settings.InitialTimeMs = control.InitialTime
		settings.IncrementMs = control.Increment
	}

	tournamentID := weekendTournamentID(today)
	if _, err := server.data.CreateTournament(ctx, tournamentID, settings); err != nil {
		log.Printf("weekend: create %s: %v", tournamentID, err)
		return
	}
	if _, err := server.data.PublishTournament(ctx, tournamentID); err != nil {
		log.Printf("weekend: publish %s: %v", tournamentID, err)
		return
	}
	if err := server.data.MarkWeekendRun(ctx, today); err != nil {
		log.Printf("weekend: mark run: %v", err)
	}
	// Last weekend's ballot is spent. The slot preference and the
	// game-of-the-weekend votes are not, and stay.
	if err := server.data.PurgeWeekendVotes(ctx, persistence.WeekendVoteClock, today); err != nil {
		log.Printf("weekend: purge ballots: %v", err)
	}
	server.postWeekendNotice(
		settings.Name + " opens for entries. Voting on the clock closes an hour before it starts.",
	)
	server.broadcastTournaments()
}

// beginWeekend locks the clock in, fills the field, and starts the event.
func (server *Server) beginWeekend(
	ctx context.Context,
	config persistence.WeekendConfig,
	today string,
) {
	tournament, err := server.data.OpenWeekend(ctx)
	if err != nil {
		return
	}
	if tournament.Status != persistence.TournamentRegistration {
		return
	}
	// The event's own published hour wins over the config's.
	//
	// They are the same on a scheduled weekend and they differ on every other
	// kind: one the host opened by hand, one whose slot moved while its doors
	// were open. The page counts down to the hour the event published, and
	// starting at a different one makes that countdown a lie — which is exactly
	// what happened the first time this ran, where a hand-opened event was
	// started by the very next tick because the configured hour was already past.
	if tournament.StartsAtUnixMs != nil &&
		time.Now().Before(time.UnixMilli(*tournament.StartsAtUnixMs)) {
		return
	}
	if server.isUpdating() {
		log.Printf("weekend: a restart is draining, not starting %s", tournament.Name)
		return
	}
	if _, err := server.startWeekend(ctx, config, tournament, today, false); err != nil {
		log.Printf("weekend: start %s: %v", tournament.Name, err)
	}
}

// weekendFieldShort is an arena with fewer engines than its minimum. Its text is
// the reason, in the words the banner uses.
type weekendFieldShort struct{ reason string }

func (short weekendFieldShort) Error() string { return short.reason }

// startWeekend locks the clock in, fills the field, and starts the event.
//
// The scheduler calls it at the hour the event published, and a host's START
// calls it early. START used to go straight to StartTournament, which skipped
// all of this: no engines swept in, the doors' placeholder Swiss whatever the
// field, and the default clock whatever the ballot said.
//
// A field under the minimum is where the two differ. The scheduler calls the
// event off, as it always has. A host is told why and the event stays open,
// because a host pressing START wants it played.
func (server *Server) startWeekend(
	ctx context.Context,
	config persistence.WeekendConfig,
	tournament persistence.Tournament,
	eventDate string,
	byHand bool,
) (persistence.Tournament, error) {
	// The poll, resolved once and then never asked again — the clock is a fact
	// about the event from here on, and the page shows it as one.
	control, _ := persistence.WeekendControlFor(config.DefaultControl)
	if config.PollEnabled {
		tallies, _, err := server.data.WeekendPoll(
			ctx, persistence.WeekendVoteClock, eventDate, "",
		)
		if err != nil {
			log.Printf("weekend: read ballot: %v", err)
		} else {
			winner := persistence.WeekendWinner(tallies, config.MinimumVotes, config.DefaultControl)
			if chosen, ok := persistence.WeekendControlFor(winner); ok {
				control = chosen
			}
		}
	}

	// Next weekend's slot is frozen now, from the standing preference. That is
	// what makes the slot a setting people drift rather than a ballot they have
	// to remember to fill in: it moves at most once a week, always a week ahead,
	// and the page can show both weekends as settled facts.
	server.freezeNextWeekendSlot(ctx, config)

	enrolled, skipped := server.enrolOnlineBots(ctx, tournament)
	// The size of the field, rather than the size of what the sweep just added
	// to it. Those are two different numbers the moment anything else has put an
	// engine in — the host's own enrolment button pressed while the doors were
	// open, an entry added by hand, a sweep that a restart made run twice.
	//
	// An engine that is already in is skipped by the sweep as "already signed
	// up", which is correct and which used to make it invisible here: an arena
	// with thirteen engines in its bracket was called off for want of six,
	// because none of the thirteen had been *newly* enrolled. What the minimum
	// is a rule about is who is playing, so that is what is counted.
	field := server.weekendFieldSize(ctx, tournament, len(enrolled))
	if field < config.MinimumField {
		reason := fmt.Sprintf(
			"only %d engine%s were in the field, and %s needs %d",
			field, pluralSuffix(field), tournament.Name, config.MinimumField,
		)
		if byHand {
			// Still open, with whatever the sweep entered on the board.
			server.broadcastTournaments()
			return tournament, weekendFieldShort{reason: reason}
		}
		if _, err := server.data.CancelTournament(ctx, tournament.TournamentID, reason); err != nil {
			log.Printf("weekend: cancel %s: %v", tournament.Name, err)
		}
		server.postWeekendNotice(tournament.Name + " is off this weekend: " + reason + ".")
		server.refreshBotReservations()
		server.broadcastTournaments()
		return tournament, nil
	}

	// Everybody plays everybody while the field is small, which is the fairest
	// table and the best ladder signal. Above that it is a Swiss — the right
	// tool for a big field rather than a round robin with rounds cut off it.
	format := persistence.FormatRoundRobin
	if field > config.RoundRobinMax {
		format = persistence.FormatSwiss
	}
	if _, err := server.data.ConfigureWeekendStart(
		ctx, tournament.TournamentID, format, control.InitialTime, control.Increment,
	); err != nil {
		log.Printf("weekend: configure %s: %v", tournament.Name, err)
	}

	started, err := server.data.StartTournament(ctx, tournament.TournamentID)
	if err != nil {
		return tournament, err
	}
	// The field has just closed, which is the moment its engines go into
	// reserve. See bot_reserve.go.
	server.refreshBotReservations()
	server.postWeekendNotice(fmt.Sprintf(
		"%s is under way: %d engines, %s, %d game%s per match.",
		started.Name, len(started.Players), control.Key,
		started.GamesPerMatch, pluralSuffix(started.GamesPerMatch),
	))
	if len(skipped) > 0 {
		log.Printf("weekend: %s skipped %d engines", started.Name, len(skipped))
	}
	server.broadcastTournaments()
	return started, nil
}

// weekendTournamentID is the id of the arena for one local date.
//
// It keeps the "nightly-" prefix for the same reason the stored kind does:
// every event in the archive is named that way, and the page finds the ballot
// by trimming it. See persistence.TournamentKind. Being the date, it also means
// one arena per date, so replaying one means deleting it first.
func weekendTournamentID(localDate string) string {
	return "nightly-" + localDate
}

// weekendEventDate is the local date an arena belongs to, read off its id.
func weekendEventDate(tournament persistence.Tournament) string {
	return strings.TrimPrefix(tournament.TournamentID, "nightly-")
}

// weekendFieldSize is how many entrants an event holds, after the sweep.
//
// Re-read rather than counted from the sweep's own return, because the sweep
// reports what it did and this question is about what is there. The fallback is
// the sweep's count: a read that failed is not a reason to call off an event
// that may well have a field, and the worst it can do is let one through to
// StartTournament, which refuses an empty bracket itself.
func (server *Server) weekendFieldSize(
	ctx context.Context,
	tournament persistence.Tournament,
	enrolled int,
) int {
	reread, err := server.data.Tournament(ctx, tournament.TournamentID)
	if err != nil {
		log.Printf("weekend: count the field for %s: %v", tournament.Name, err)
		return enrolled
	}
	return len(reread.Players)
}

// freezeNextWeekendSlot moves the schedule to whatever slot is leading.
//
// Called at the moment an event begins, so the next one is decided a full week
// out and nobody turns up to an event that moved while they were on their way.
// A thin turnout or a tie leaves it where it is, which is what
// WeekendAvailabilityWinner answers with the current slot as its fallback.
func (server *Server) freezeNextWeekendSlot(
	ctx context.Context,
	config persistence.WeekendConfig,
) {
	counts, _, answered, err := server.data.WeekendAvailability(ctx, "")
	if err != nil {
		log.Printf("weekend: read availability: %v", err)
		return
	}
	slot := persistence.WeekendAvailabilityWinner(
		counts, answered, config.MinimumVotes, config.SlotOf(),
	)
	if slot == config.SlotOf() {
		return
	}
	moved := config.WithSlot(slot)
	if _, err := server.data.SaveWeekendConfiguration(ctx, moved); err != nil {
		log.Printf("weekend: move the slot to %s: %v", weekendSlotLabel(moved), err)
		return
	}
	// Said in the host's zone because that is what the schedule is written in;
	// the weekend page prints the same slot in each reader's own time, on each
	// reader's own day.
	server.postWeekendNotice(fmt.Sprintf(
		"Next weekend starts %s %s. Available: %d of %d players.",
		weekendSlotLabel(moved), shortZone(moved.Zone), counts[slot], answered,
	))
}

// weekendSlotLabel is a schedule as the host wrote it: "Saturday 20:00".
func weekendSlotLabel(config persistence.WeekendConfig) string {
	return fmt.Sprintf("%s %s", time.Weekday(config.StartDay), config.StartLocal)
}

// shortZone is the readable tail of an IANA name: "New_York" -> "New York".
func shortZone(zone string) string {
	parts := strings.Split(zone, "/")
	return strings.ReplaceAll(parts[len(parts)-1], "_", " ")
}

// pluralSuffix is the "s" on a count. The twin in moderation.go pluralises a
// noun; this one is for a sentence that already has the noun in it.
func pluralSuffix(count int) string {
	if count == 1 {
		return ""
	}
	return "s"
}

// modeNameFor is the display name of a mode, falling back to its id.
func (server *Server) modeNameFor(modeID game.ModeID) string {
	for _, definition := range server.registry.Definitions() {
		if definition.ID == modeID {
			return definition.Name
		}
	}
	return string(modeID)
}

// postWeekendNotice puts a line on the standing announcement banner.
//
// The weekend arena is a community event and the point of it is that people
// turn up, which they cannot do if the only place it is announced is a page they
// are not looking at.
func (server *Server) postWeekendNotice(message string) {
	server.PostNotice(message, "notice", noticeDefaultLifetime)
}

/* --------------------------------------------------------------- grace -- */

// settleWeekendForfeits gives up on matches whose engine has gone away.
//
// An hour of play is long enough that an engine will drop, and a round that
// cannot finish stops the event. So a match kept waiting by a missing engine
// starts a clock, and when it runs out the unplayed games go to whoever is
// still there.
//
// Missing means gone, not busy. A round robin creates every pairing when it
// starts, so most of its schedule is always waiting on engines that are at
// another of its boards. Counting those as missing ended Weekend Bot Arena #6
// ninety seconds into round one: every pairing between two busy engines was
// drawn, and the rest went to whichever engine had a slot free. See
// weekendSideOf.
//
// The clock runs only while somebody is actually waiting, which is the engine
// still here being free to play this match now. An engine that has already
// been waited for once gets no second grace: the round should not keep paying
// for the same absence.
func (server *Server) settleWeekendForfeits(now time.Time) {
	server.mu.RLock()
	connected := len(server.bots)
	server.mu.RUnlock()
	if connected == 0 {
		return
	}
	ctx := context.Background()
	config, err := server.data.WeekendConfiguration(ctx)
	if err != nil || !config.Enabled {
		return
	}
	tournament, err := server.data.OpenWeekend(ctx)
	if err != nil || tournament.Status != persistence.TournamentInProgress {
		return
	}
	grace := time.Duration(config.GraceSeconds) * time.Second

	for _, match := range tournament.Matches {
		if match.Result != persistence.MatchPending {
			continue
		}
		key := tournamentMatchKey{
			tournamentID: tournament.TournamentID,
			matchID:      match.MatchID,
		}
		// A match with a game running is not waiting for anybody.
		if server.tournamentGame(key) != nil {
			server.clearWeekendGrace(key)
			continue
		}
		first := server.weekendSideOf(match.Player1.UserID)
		second := server.weekendSideOf(match.Player2.UserID)
		if first.here && second.here {
			server.clearWeekendGrace(key)
			continue
		}
		// One engine is gone, and the one still here is at another board, so it
		// could not play this match now either. Nothing has waited for the absent
		// engine yet. The clock starts when the other is free and this is what it
		// is waiting for, which in a round robin may be its last pairing.
		if first.here && !first.free || second.here && !second.free {
			server.clearWeekendGrace(key)
			continue
		}

		server.weekend.mu.Lock()
		since, waiting := server.weekend.graceFrom[key]
		spent := server.weekend.graceSpent[key]
		if !waiting && !spent {
			server.weekend.graceFrom[key] = now
			server.weekend.mu.Unlock()
			continue
		}
		expired := spent || now.Sub(since) >= grace
		if expired {
			delete(server.weekend.graceFrom, key)
			server.weekend.graceSpent[key] = true
		}
		server.weekend.mu.Unlock()
		if !expired {
			continue
		}

		// The absent side forfeits every game it has not played. A pairing where
		// neither turned up is a draw: there is nobody to award it to.
		result := persistence.MatchDraw
		switch {
		case first.here && !second.here:
			result = persistence.MatchPlayer1Win
		case second.here && !first.here:
			result = persistence.MatchPlayer2Win
		}
		if _, err := server.data.SetTournamentMatchResult(
			ctx, tournament.TournamentID, match.MatchID, result,
		); err != nil {
			log.Printf("weekend: forfeit match %d: %v", match.MatchID, err)
			continue
		}
		log.Printf("weekend: match %d forfeited after %s of grace", match.MatchID, grace)
		server.refreshBotReservations()
		server.broadcastTournaments()
	}
}

// weekendSide is where one engine of a pending match stands, as the no-show
// clock sees it.
type weekendSide struct {
	// free is an engine that could be brought to this board now.
	free bool
	// here is free, or playing at another tournament board. An engine playing
	// one of its other matches has not gone anywhere.
	here bool
}

// weekendSideOf answers weekendSide for one engine.
//
// free is the question autoReadyBotMatches asks, and it has to be the same
// question: an engine busy in an ordinary game is one a recall can free, so
// calling it absent here would forfeit a match that the sweep earlier in this
// very tick is about to start. Planning reads state and changes none, which is
// what makes it safe to ask as a predicate.
//
// A recall never takes an engine out of a tournament game, which is why here
// needs its own look at the engine's boards. Without it an engine at another
// board counts as gone.
func (server *Server) weekendSideOf(userID string) weekendSide {
	if server.planBotRecall(userID) != nil {
		return weekendSide{free: true, here: true}
	}
	client := server.botClientFor(userID)
	if client == nil {
		return weekendSide{}
	}
	for _, slot := range server.botConnections(client.bot.botID) {
		if participant := server.participantFor(slot); participant != nil &&
			participant.session.tournament != nil {
			return weekendSide{here: true}
		}
	}
	return weekendSide{}
}

func (server *Server) clearWeekendGrace(key tournamentMatchKey) {
	server.weekend.mu.Lock()
	delete(server.weekend.graceFrom, key)
	server.weekend.mu.Unlock()
}
