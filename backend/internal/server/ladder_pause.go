package server

import (
	"errors"
	"fmt"
	"sync"
	"time"

	"rps-strategy/backend/internal/persistence"
)

// The ranked pool standing down for the weekly arena.
//
// The two are played by the same engines, and until this they only knew about
// each other through the reservation: an entrant in a running event is not lent
// to anything else. That kept the arena's own engines out of the rounds once it
// had begun, and still left three ways for the two to collide.
//
//   - **On the hour.** The arena starts on the hour, and so does a round, and
//     the round always gets there first: runLadderRound seats in the first
//     seconds after the hour, while runWeekend looks at the clock only once a
//     minute. So the entrants were paired for ranked games moments before the
//     arena began, and the arena's first act was to recall them from those
//     games and void them. See bot_recall.go.
//   - **Just before.** A pairing held for a busy engine may start at any point
//     in its hour, and a ranked press at any moment at all, so the last ranked
//     games before the arena could still be on the board when it started.
//   - **During.** An engine that was not entered went on playing rounds beside
//     the event, all evening.
//
// So no ranked game starts from ladderArenaLead before the arena until it has
// finished. A round that falls in that stretch is skipped, not made up later —
// the same as an hour lost to a drain — and the pool picks up again at the next
// round on the hour. A ranked run already on the board when the stretch begins
// plays out its pair: stopping between the two seatings would leave the
// matchup one game lopsided, and the lead is there so that the pair is over
// before the arena needs anybody.
//
// # Why only the weekly arena
//
// It is the event every engine is swept into, it starts on a schedule, and it
// always ends — an engine that does not turn up forfeits after a short grace.
// A host's own event has none of those properties: it starts when somebody
// presses the button, and a match can sit waiting for a person for days, which
// would hold the ladder with it. Its entrants are still kept out of the rounds
// by their reservation.

// ladderArenaLead is how long before the arena the pool stops starting games.
//
// Long enough for a pairing that starts just before it to be over by the start:
// two games at 5+2, the slowest clock in the rotation, which the rounds page
// already reckons at the better part of half an hour. A run that goes on longer
// still is recalled when the arena needs its engine, which this makes rare
// rather than impossible.
const ladderArenaLead = 30 * time.Minute

// ladderArenaTitle names an arena whose doors have not opened.
//
// Its number is only given out when it is created, and before that the pool
// can still owe it a stand-down: doors may open as little as five minutes
// ahead, which is inside the lead.
const ladderArenaTitle = "the Weekend Bot Arena"

// errLadderPaused is a ranked game asked for while the pool stands down. It is
// always wrapped with the event, because "paused" alone does not say until when.
var errLadderPaused = errors.New("ranked games are paused")

// ladderArena is what the pool knows about the weekly arena.
//
// Cached rather than read when asked, because ladderBotStanding asks for every
// engine on every read of the rounds page and must not touch the database to do
// it. Filled from two reads the ticker already makes: the tournament list that
// refreshBotReservations loads every tick — and after every change to an
// event's status, which is when the answer moves — and the weekend config that
// runWeekend loads once a minute.
type ladderArena struct {
	mu sync.RWMutex
	// event is the open arena, empty when there is none. running is one that has
	// begun; startsAt is the hour one that has not yet begun published.
	event    string
	running  bool
	startsAt time.Time
	// scheduled is the next start on the calendar while its doors are still shut,
	// and zero otherwise. The weekend page counts down to it before any event
	// exists, and the stand-down has to begin before the doors whenever they open
	// less than ladderArenaLead ahead.
	scheduled time.Time
}

// observeEvents records the open arena, from the tournament list.
//
// One begun outranks one taking entries. Only one should ever be open —
// openWeekendDoors refuses a second — and preferring the running one means the
// pool stays held for the event that is actually being played if that ever
// fails.
func (arena *ladderArena) observeEvents(tournaments []persistence.Tournament) {
	event, running, startsAt := "", false, time.Time{}
	for _, tournament := range tournaments {
		if tournament.Kind.Normalized() != persistence.TournamentWeekend {
			continue
		}
		switch tournament.Status {
		case persistence.TournamentInProgress:
			event, running, startsAt = tournament.Name, true, time.Time{}
		case persistence.TournamentRegistration:
			// Without a published hour there is nothing to lead. Every arena
			// carries one, the hand-opened kind included; see runWeekendNow.
			if running || tournament.StartsAtUnixMs == nil {
				continue
			}
			at := time.UnixMilli(*tournament.StartsAtUnixMs)
			if startsAt.IsZero() || at.Before(startsAt) {
				event, startsAt = tournament.Name, at
			}
		}
	}
	arena.mu.Lock()
	arena.event, arena.running, arena.startsAt = event, running, startsAt
	arena.mu.Unlock()
}

// observeSchedule records the calendar's next start, from the weekend config.
//
// Only while that date's doors are shut. Once they have opened the event itself
// is the answer, including the answer that there is none: an arena the host
// called off during its doors leaves the calendar still naming tonight, and
// holding the pool for it would be holding it for nothing.
func (arena *ladderArena) observeSchedule(config persistence.WeekendConfig, now time.Time) {
	scheduled := time.Time{}
	if config.Enabled {
		if date, startAt, ok := nextWeekendDate(config, now); ok && date != config.LastRunDate {
			scheduled = startAt
		}
	}
	arena.mu.Lock()
	arena.scheduled = scheduled
	arena.mu.Unlock()
}

// ladderStandDown is the arena the pool is standing down for and when that
// began, or begins. The zero value stands down for nothing.
type ladderStandDown struct {
	event string
	// from is the first moment no ranked game may start. Zero for an arena under
	// way, which holds every moment until it finishes.
	from time.Time
}

// covers reports whether no ranked game may start at this moment.
//
// Asked about now by everything that starts a game, and about a round's hour by
// the published schedule — which, not knowing when the arena will end, marks
// every round from the start of the stand-down on.
func (stand ladderStandDown) covers(at time.Time) bool {
	return stand.event != "" && !at.Before(stand.from)
}

// refusal is what a ranked game asked for inside the stand-down is told.
func (stand ladderStandDown) refusal() error {
	return fmt.Errorf("%w until %s ends", errLadderPaused, stand.event)
}

// standDown is what the pool is holding for, as of now.
//
// An arena taking entries holds the pool from the lead before its hour until a
// lead after it. The second half covers the minute it may take runWeekend to
// begin it and a drain that delays the start; past it, an arena still taking
// entries is one that is not going to begin — a day that rolled over, a
// schedule switched off — and the pool goes back to its hours.
func (arena *ladderArena) standDown(now time.Time) ladderStandDown {
	arena.mu.RLock()
	defer arena.mu.RUnlock()
	switch {
	case arena.running:
		return ladderStandDown{event: arena.event}
	case !arena.startsAt.IsZero():
		if now.Before(arena.startsAt.Add(ladderArenaLead)) {
			return ladderStandDown{
				event: arena.event,
				from:  arena.startsAt.Add(-ladderArenaLead),
			}
		}
	case !arena.scheduled.IsZero():
		return ladderStandDown{
			event: ladderArenaTitle,
			from:  arena.scheduled.Add(-ladderArenaLead),
		}
	}
	return ladderStandDown{}
}

// ladderStandDown is the server's copy of the question above.
func (server *Server) ladderStandDown(now time.Time) ladderStandDown {
	return server.ladderPool.arena.standDown(now)
}

// ladderPausedFor refuses a ranked game at this moment, or returns nil.
//
// The one spelling of the rule. The pairer, a held pairing, a press, the page
// and StartBotSeries all ask it, so none of them can start what another would
// have refused.
func (server *Server) ladderPausedFor(now time.Time) error {
	if stand := server.ladderStandDown(now); stand.covers(now) {
		return stand.refusal()
	}
	return nil
}
