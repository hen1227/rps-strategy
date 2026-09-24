package server

import (
	"context"
	"log"
	"sync"
	"time"

	"rps-strategy/backend/internal/persistence"
)

// Engine titles on the wire: when the sweep runs, and who is told.
//
// The rules are in persistence/bot_titles.go. Nothing here decides what an
// engine deserves; it decides when to ask.
//
// # Why a sweep and not an event
//
// A person's titles are evaluated for the two accounts that just did something,
// because a person's rules are about that person. An engine's are comparative:
// the crown moves from one engine to another, and the engine that lost it did
// nothing to lose it. There is no list of accounts a result implicates, so the
// question is asked of the whole fleet — see SyncBotTitles, which is built for
// exactly that and is cheap enough to run on the lobby ticker.
//
// Two triggers, for two different reasons. A finished tournament is asked
// immediately, because a crown that arrives a quarter of an hour after the
// event it was won at looks like a bug to the author watching the standings.
// A deleted one asks too, for the same reason in reverse. The ticker is the
// backstop for what is left.

// botTitleSweep is how often the fleet is re-examined with nothing having
// happened.
//
// A quarter of an hour, and deliberately a backstop rather than the thing that
// keeps a tag current. Both engine rules read completed events, and every route
// that finishes or deletes one asks for a sweep of its own — so what the clock
// is here for is the record moving without an event behind it at all: an
// account deleted out of an archived arena, a row corrected by hand. Cheap
// enough to sit on the lobby ticker, which is what lets it cover cases nobody
// has thought to name.
const botTitleSweep = 15 * time.Minute

// botTitleState is the sweep's memory between ticks.
type botTitleState struct {
	mu       sync.Mutex
	lastLook time.Time
}

// runBotTitles is the ticker's entry point: a clock check almost every time,
// and a sweep once a quarter of an hour.
func (server *Server) runBotTitles(now time.Time) {
	server.botTitles.mu.Lock()
	if now.Sub(server.botTitles.lastLook) < botTitleSweep {
		server.botTitles.mu.Unlock()
		return
	}
	server.botTitles.lastLook = now
	server.botTitles.mu.Unlock()

	server.syncBotTitles(context.Background())
}

// syncBotTitles re-runs the engine rulebook over the whole fleet and republishes
// anything that moved.
//
// Failures are logged and swallowed, for the reason awardTitles gives: a title
// is a decoration, and the game or the event that provoked this has already
// been recorded, broadcast and archived.
func (server *Server) syncBotTitles(ctx context.Context) {
	changes, err := server.data.SyncBotTitles(ctx)
	if err != nil {
		log.Printf("sync bot titles: %v", err)
		return
	}
	if len(changes) == 0 {
		return
	}
	for userID, change := range changes {
		log.Printf("bot titles for %s: %s", userID, change)
	}
	server.republishBotTitles(changes)
}

// republishBotTitles brings every connected engine's cached account back in line
// with the tag it now wears, and restates the roster.
//
// The same job, and the same reasoning, as republishBotLadder: an engine that
// connects on Friday and plays all weekend would otherwise keep publishing the
// tag it had when it connected, which for the engine that just won the arena is
// no tag at all.
//
// Client.profile is deliberately left alone — see publishAccount for why
// writing it would be a data race. The consequence is the same one a person's
// title has: the crown is on the ladder, the roster and the engine's page at
// once, and reaches the player bar of a game already in progress when the
// engine next reconnects.
func (server *Server) republishBotTitles(changes map[string]persistence.BotTitleChange) {
	server.mu.Lock()
	for _, connections := range server.bots {
		for _, client := range connections {
			change, moved := changes[client.account.UserID]
			if !moved {
				continue
			}
			client.account.Title = change.Worn
		}
	}
	server.mu.Unlock()
	server.broadcastBots()
}
