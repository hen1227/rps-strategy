package server

import "time"

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
//     person, at 11:30 in the morning and again at six in the evening. Either
//     one of those is a thing to forget. A window declared ahead of time is a
//     thing that happens whether or not anybody is at a keyboard.
//   - **It is enforced through botIsDraining.** That function is already "the
//     question every path that could hand an engine a new game asks", and the
//     comment there says a second spelling is how one of those paths gets
//     missed. So the bench answers the same question rather than asking a new
//     one, and every offer path — challenges, series, tournament pairings —
//     closes for free.
//   - **It is published, not merely enforced.** An engine that is benched is
//     not shutting down, and a lobby that said "SHUTTING DOWN" against every
//     bot on the ladder for six and a half hours would read as a broken server.
//     BotPresence.Benched and BotBenchState below are what let the words be
//     right.
//
// Nothing here touches the engines themselves. A benched bot stays connected
// and idle, exactly as a paused one does, and is back in the pool the moment
// the window closes — no restart, and nothing for an owner to do.

// botBenchWindow is one stretch of time in which no engine takes a new game.
//
// The instants are UTC on purpose, and the comment beside each one says what
// that is in the timezone the event was announced in. The alternative — a wall
// clock plus a location resolved at runtime — needs the zoneinfo database to be
// present on the host and gets the offset wrong by an hour if it guesses. These
// are two exact moments, and writing them as exact moments is the only spelling
// that cannot drift.
type botBenchWindow struct {
	// reason is why, in the words a player reads. It is shown next to engines
	// that are unavailable, so it should finish the sentence "the engines are
	// off until six because of…".
	reason string
	// untilLabel is when it ends, in the timezone the event was announced in.
	//
	// A written label rather than a format of `until` below, because that is a
	// UTC instant and "22:00 UTC" is not how anybody who was told "noon Eastern"
	// is holding the afternoon in their head. The refusal a person reads should
	// use their clock, not the server's.
	untilLabel string
	from       time.Time
	until      time.Time
}

// botBenchWindows is every scheduled bench, and the only place any of this is
// declared. A future event is one more entry; a past one costs nothing and is
// worth leaving as the record of what happened.
var botBenchWindows = []botBenchWindow{
	{
		reason:     "the official Intransitive tournament on meaf.us/rps2",
		untilLabel: "6 PM Eastern",
		// 11:30 to 18:00 Eastern on Saturday 5 September 2026, which is EDT
		// (UTC-4) on that date. The tournament itself is at noon Eastern; the
		// window opens half an hour early so nobody is mid-game against an
		// engine when it starts, and closes long after the last round.
		from:  time.Date(2026, time.September, 5, 15, 30, 0, 0, time.UTC),
		until: time.Date(2026, time.September, 5, 22, 0, 0, 0, time.UTC),
	},
}

// BotBenchState is a bench as the lobby is told about it.
//
// Sent whether or not one is running, and describing the *next* one when none
// is, which is what lets a page say "the engines go offline at 11:30" ahead of
// the fact instead of only explaining it afterwards. Active is therefore the
// field to branch on; the times are meaningful either way.
type BotBenchState struct {
	Active bool   `json:"active"`
	Reason string `json:"reason,omitempty"`
	// FromUnixMs and UntilUnixMs are zero when there is no window to describe
	// at all — every scheduled one is in the past.
	FromUnixMs  int64 `json:"fromUnixMs,omitempty"`
	UntilUnixMs int64 `json:"untilUnixMs,omitempty"`
}

// botBenchAt is the window covering an instant, or nil.
//
// Half-open — `from` is benched and `until` is not — so two windows that meet
// exactly do not overlap by one instant.
func botBenchAt(now time.Time) *botBenchWindow {
	for index := range botBenchWindows {
		window := &botBenchWindows[index]
		if !now.Before(window.from) && now.Before(window.until) {
			return window
		}
	}
	return nil
}

// nextBotBenchAfter is the earliest window that has not started yet, or nil.
func nextBotBenchAfter(now time.Time) *botBenchWindow {
	var next *botBenchWindow
	for index := range botBenchWindows {
		window := &botBenchWindows[index]
		if !window.from.After(now) {
			continue
		}
		if next == nil || window.from.Before(next.from) {
			next = window
		}
	}
	return next
}

// botsAreBenched is the whole of the enforcement. See botIsDraining, which is
// the only caller that matters and the reason this is not consulted anywhere
// else.
func botsAreBenched(now time.Time) bool { return botBenchAt(now) != nil }

// botBenchState is what the lobby is told: the window that is running, or the
// next one, or nothing.
func botBenchState(now time.Time) BotBenchState {
	if window := botBenchAt(now); window != nil {
		return BotBenchState{
			Active:      true,
			Reason:      window.reason,
			FromUnixMs:  window.from.UnixMilli(),
			UntilUnixMs: window.until.UnixMilli(),
		}
	}
	if window := nextBotBenchAfter(now); window != nil {
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
