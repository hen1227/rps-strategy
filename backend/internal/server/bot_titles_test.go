package server

import (
	"testing"

	"rps-strategy/backend/internal/persistence"
)

// The sweep's answer has to reach the roster the lobby is reading, not only the
// database.
//
// An engine connects on Friday and plays all weekend, so the cached account it
// is published from is the one it had before the arena it went on to win. This
// is the line that corrects it — and, because it takes the server lock and then
// broadcasts, it is also the check that doing so from a lobby tick or a
// finished tournament does not deadlock.
func TestASweptTagReachesTheEngineRoster(t *testing.T) {
	server := New(nil)
	engine := openToChallenges(t, server, "engine")
	server.mu.Lock()
	engine.account.UserID = "engine"
	server.mu.Unlock()

	if roster := server.botRoster(); len(roster) != 1 || roster[0].Title != "" {
		t.Fatalf("an engine with no tag should publish none, got %#v", roster)
	}

	server.republishBotTitles(map[string]persistence.BotTitleChange{
		"engine": {Worn: persistence.TitleReigningChampion},
	})
	roster := server.botRoster()
	if len(roster) != 1 || roster[0].Title != persistence.TitleReigningChampion {
		t.Fatalf("expected the crown on the roster, got %#v", roster)
	}

	// And taken off again, which is the half a rolling title needs: the engine
	// that lost the crown is not the one the event just told us about.
	server.republishBotTitles(map[string]persistence.BotTitleChange{"engine": {Worn: ""}})
	if roster := server.botRoster(); len(roster) != 1 || roster[0].Title != "" {
		t.Fatalf("expected the crown to come off, got %#v", roster)
	}
}
