package server

import (
	"context"
	"log"
	"sync"
	"time"

	"rps-strategy/backend/internal/persistence"
)

// Taking every engine off the board for a while, on a schedule.
//
// The drain next door in bot_shutdown.go is one owner retiring one build, and
// the one in deploy_drain.go is the whole server going away. This is neither:
// the engines are fine, the server is fine, and they are being stood down for a
// few hours because something is happening elsewhere that they would spoil.
//
// The occasion it was written for is an official tournament on somebody else's
// site. Nobody wants to spend the hour before their round warming up against a
// bot that is stronger than everyone in the draw, and the people running the
// event would rather the practice ladder were not the interesting thing on this
// site that afternoon. So the ladder closes and reopens on its own.
//
// Three decisions worth stating:
//
//   - **It is a window, not a switch.** A switch has to be thrown twice, by a
//     person, at a quarter to ten in the morning and again at four in the
//     afternoon. Either one of those is a thing to forget. A window declared
//     ahead of time is a thing that happens whether or not anybody is at a
//     keyboard.
//   - **It is enforced through botIsDraining.** That function is already "the
//     question every path that could hand an engine a new game asks", and the
//     comment there says a second spelling is how one of those paths gets
//     missed. So the bench answers the same question rather than asking a new
//     one, and every offer path — challenges, series, tournament pairings —
//     closes for free.
//   - **It is published, not merely enforced.** An engine that is benched is
//     not shutting down, and a lobby that said "SHUTTING DOWN" against every
//     bot on the ladder for six and a quarter hours would read as a broken
//     server. BotPresence.Benched and BotBenchState below are what let the
//     words be right.
//
// Nothing here touches the engines themselves. A benched bot stays connected
// and idle, exactly as a paused one does, and is back in the pool the moment
// the window closes — no restart, and nothing for an owner to do.
//
// # Why the schedule is in the database
//
// It was a slice in this file, and for one event that was right: the window was
// known when the binary was built. It stopped being right the second time
// somebody wanted one, because the schedule then had a property nothing else
// about an event does — you could not add to it without a deploy, and the
// people who know an event is happening are not always the people who can cut a
// release. A bench that needs a build is a bench that gets scheduled late, or
// by hand at the keyboard, which is the thing the first bullet above rejects.
//
// So the schedule lives in persistence/bot_bench.go and a host edits it from
// the admin screen. The binary still *carries* windows — see botBenchSeeds —
// but only as something to offer a database once; after that the database is
// the only authority, and a window deleted there stays deleted.
//
// It is cached in memory for the reason moderation.go sets out at length: every
// path that could open a game asks whether the engines are benched, those paths
// run under server.mu and over the same single SQLite connection the game loop
// uses, and a question asked that often cannot be a query. The cost is the same
// one invariant — nothing may write `bot_bench_windows` without going through
// this file — and the admin routes below are the only writers.

// botBenchWindow is one stretch of time in which no engine takes a new game.
//
// The instants are UTC on purpose, and whatever declares one says what that is
// in the timezone the event was announced in. The alternative — a wall clock
// plus a location resolved at runtime — needs the zoneinfo database to be
// present on the host and gets the offset wrong by an hour if it guesses. These
// are two exact moments, and writing them as exact moments is the only spelling
// that cannot drift.
type botBenchWindow struct {
	// id is what the host's screen deletes by, and is the stored row's key.
	id string
	// reason is why, in the words a player reads. It is shown next to engines
	// that are unavailable, so it should finish the sentence "the engines are
	// off until four because of…".
	reason string
	// untilLabel is when it ends, in the timezone the event was announced in.
	//
	// A written label rather than a format of `until` below, because that is a
	// UTC instant and "20:00 UTC" is not how anybody who was told "10 AM
	// Eastern" is holding the day in their head. The refusal a person reads
	// should use their clock, not the server's.
	untilLabel string
	from       time.Time
	until      time.Time
}

// botBenchSeed is a window the binary carries, and the key that remembers it.
//
// The key is the identity of the *offer*, not of the row: it stays in the
// ledger after a host deletes the window, which is what stops the next deploy
// putting a cancelled bench back. Never reuse one for a different event.
type botBenchSeed struct {
	key    string
	window persistence.BotBenchWindow
}

// botBenchSeeds is every window shipped in this binary.
//
// A future event may be added here *or* from the admin screen, and the screen
// is the ordinary way — this exists so that a window known at build time is
// live the moment the build is, without waiting on somebody to type it in. Each
// entry is offered to the database exactly once, ever. Past ones cost nothing
// and are worth leaving as the record of what shipped.
var botBenchSeeds = []botBenchSeed{
	{
		key: "official-intransitive-tournament-2026-09-05",
		window: persistence.BotBenchWindow{
			ID:         "bench-2026-09-05-meaf",
			Reason:     "the official Intransitive tournament on meaf.us/rps2",
			UntilLabel: "6 PM Eastern",
			// 11:30 to 18:00 Eastern on Saturday 5 September 2026, which is EDT
			// (UTC-4) on that date. The tournament itself was at noon Eastern;
			// the window opened half an hour early so nobody was mid-game
			// against an engine when it started, and closed long after the last
			// round.
			FromUnixMs:  time.Date(2026, time.September, 5, 15, 30, 0, 0, time.UTC).UnixMilli(),
			UntilUnixMs: time.Date(2026, time.September, 5, 22, 0, 0, 0, time.UTC).UnixMilli(),
		},
	},
	{
		key: "official-intransitive-tournament-2026-09-13",
		window: persistence.BotBenchWindow{
			ID:         "bench-2026-09-13-meaf",
			Reason:     "the official Intransitive tournament on meaf.us/rps2",
			UntilLabel: "4 PM Eastern",
			// 09:45 to 16:00 Eastern on Sunday 13 September 2026, which is EDT
			// (UTC-4) on that date. The tournament is at 10 AM Eastern; the
			// window opens a quarter of an hour early so nobody is mid-game
			// against an engine when it starts, and runs six hours past the
			// start.
			FromUnixMs:  time.Date(2026, time.September, 13, 13, 45, 0, 0, time.UTC).UnixMilli(),
			UntilUnixMs: time.Date(2026, time.September, 13, 20, 0, 0, 0, time.UTC).UnixMilli(),
		},
	},
}

// benchBoard is the in-memory copy of the schedule.
//
// Its own lock rather than Server.mu, like the sanction and block boards it is
// modelled on, because the gates that consult it are called from inside mu.
type benchBoard struct {
	mu      sync.RWMutex
	windows []botBenchWindow
}

// BotBenchState is a bench as the lobby is told about it.
//
// Sent whether or not one is running, and describing the *next* one when none
// is, which is what lets a page say "the engines go offline at a quarter to
// ten" ahead of the fact instead of only explaining it afterwards. Active is
// therefore the field to branch on; the times are meaningful either way.
type BotBenchState struct {
	Active bool   `json:"active"`
	Reason string `json:"reason,omitempty"`
	// FromUnixMs and UntilUnixMs are zero when there is no window to describe
	// at all — every scheduled one is in the past.
	FromUnixMs  int64 `json:"fromUnixMs,omitempty"`
	UntilUnixMs int64 `json:"untilUnixMs,omitempty"`
}

// loadBotBenches applies this binary's seeds and fills the cache. Called once,
// at construction, and again after every write.
//
// A failure is logged rather than fatal, and the consequence is stated plainly:
// the engines would keep taking games through a window somebody scheduled. That
// is the right trade for a server whose main job is to serve games — refusing
// to boot because one table could not be read would turn a missed bench into a
// total outage — but it is the failure worth watching for, because the symptom
// is a ladder that looks perfectly healthy on the one afternoon it should not
// be.
func (server *Server) loadBotBenches(ctx context.Context) {
	for _, seed := range botBenchSeeds {
		seeded, err := server.data.SeedBotBenchWindow(
			ctx, seed.key, seed.window, time.Now().UnixMilli(),
		)
		if err != nil {
			log.Printf("seed bot bench window %q: %v", seed.key, err)
			continue
		}
		if seeded {
			log.Printf(
				"scheduled bot bench %q: %s until %s",
				seed.window.ID, seed.window.Reason, seed.window.UntilLabel,
			)
		}
	}
	server.reloadBotBenches(ctx)
}

// reloadBotBenches refills the cache from the store, without re-offering seeds.
func (server *Server) reloadBotBenches(ctx context.Context) {
	stored, err := server.data.BotBenchWindows(ctx)
	if err != nil {
		log.Printf("load bot bench windows: %v (scheduled benches are not being enforced)", err)
		return
	}
	windows := make([]botBenchWindow, 0, len(stored))
	for _, record := range stored {
		windows = append(windows, botBenchWindow{
			id:         record.ID,
			reason:     record.Reason,
			untilLabel: record.UntilLabel,
			from:       time.UnixMilli(record.FromUnixMs),
			until:      time.UnixMilli(record.UntilUnixMs),
		})
	}
	server.benches.mu.Lock()
	server.benches.windows = windows
	server.benches.mu.Unlock()
}

// botBenchAt is the window covering an instant, or nil.
//
// Half-open — `from` is benched and `until` is not — so two windows that meet
// exactly do not overlap by one instant.
func (server *Server) botBenchAt(now time.Time) *botBenchWindow {
	if server == nil {
		return nil
	}
	server.benches.mu.RLock()
	defer server.benches.mu.RUnlock()
	for index := range server.benches.windows {
		window := server.benches.windows[index]
		if !now.Before(window.from) && now.Before(window.until) {
			// A copy, so a caller holding the answer is not reading a slice
			// the next admin write replaces underneath it.
			return &window
		}
	}
	return nil
}

// nextBotBenchAfter is the earliest window that has not started yet, or nil.
func (server *Server) nextBotBenchAfter(now time.Time) *botBenchWindow {
	if server == nil {
		return nil
	}
	server.benches.mu.RLock()
	defer server.benches.mu.RUnlock()
	var next *botBenchWindow
	for index := range server.benches.windows {
		window := server.benches.windows[index]
		if !window.from.After(now) {
			continue
		}
		if next == nil || window.from.Before(next.from) {
			found := window
			next = &found
		}
	}
	return next
}

// botsAreBenched is the whole of the enforcement. See botIsDraining, which is
// the only caller that matters and the reason this is not consulted anywhere
// else.
func (server *Server) botsAreBenched(now time.Time) bool {
	return server.botBenchAt(now) != nil
}

// botBenchState is what the lobby is told: the window that is running, or the
// next one, or nothing.
func (server *Server) botBenchState(now time.Time) BotBenchState {
	if window := server.botBenchAt(now); window != nil {
		return BotBenchState{
			Active:      true,
			Reason:      window.reason,
			FromUnixMs:  window.from.UnixMilli(),
			UntilUnixMs: window.until.UnixMilli(),
		}
	}
	if window := server.nextBotBenchAfter(now); window != nil {
		return BotBenchState{
			Reason:      window.reason,
			FromUnixMs:  window.from.UnixMilli(),
			UntilUnixMs: window.until.UnixMilli(),
		}
	}
	return BotBenchState{}
}

// botBenchRefusal is what somebody who challenged an engine mid-window is told.
func botBenchRefusal(window *botBenchWindow) string {
	return "the engines are offline until " + window.untilLabel + " for " + window.reason
}
