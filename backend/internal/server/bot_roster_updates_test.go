package server

import (
	"sync"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
)

// The roster is what the lobby's PLAYING badge is drawn from, and `Busy` in it
// is derived from state the game paths write — the participants map, and the
// slot a series holds between its games. Nothing in either of those publishes
// itself, so a roster that is not restated when they change leaves an engine
// showing whatever it was doing when the last engine_bots message went out.
// That is a badge that only comes right when the page is reloaded.

// awaitRoster waits for the next roster and returns one engine's row from it.
func awaitRoster(t *testing.T, observer *Client, userID string) BotPresence {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		message := awaitMessageOfType(t, observer, "engine_bots")
		for _, presence := range message.EngineBots {
			if presence.UserID == userID {
				return presence
			}
		}
	}
	t.Fatalf("timed out waiting for %s on the roster", userID)
	return BotPresence{}
}

func TestTheRosterIsRestatedWhenAnEngineSGameEnds(t *testing.T) {
	server := New(nil)
	observer := fakeClient(t, server, "observer", false)
	engine := openToChallenges(t, server, "engine")
	human := fakeClient(t, server, "human", false)

	server.challengeBot(human, engine.bot.botID, game.ModeTotalWar, nil, game.Red)
	seated := awaitRoster(t, observer, "engine")
	if !seated.Busy || seated.ActiveGames != 1 {
		t.Fatalf("expected the engine to be published as playing, got %#v", seated)
	}

	participant := server.participantFor(engine)
	if participant == nil {
		t.Fatal("the engine should be seated in the challenge")
	}
	state, err := participant.session.game.Resign(game.Red)
	if err != nil {
		t.Fatal(err)
	}
	server.finishSession(participant.session, state)

	// The point of the test: without a broadcast here the lobby is still
	// holding the roster from the challenge, in which this engine is playing.
	freed := awaitRoster(t, observer, "engine")
	if freed.Busy || freed.ActiveGames != 0 {
		t.Fatalf("expected the finished engine to be published as idle, got %#v", freed)
	}
}

// A game called off inside its first-move window produces no result and so
// never reaches finishSession, but it held a slot while it existed.
func TestTheRosterIsRestatedWhenAnUnstartedGameIsDiscarded(t *testing.T) {
	server := New(nil)
	observer := fakeClient(t, server, "observer", false)
	engine := openToChallenges(t, server, "engine")
	human := fakeClient(t, server, "human", false)

	server.challengeBot(human, engine.bot.botID, game.ModeTotalWar, nil, game.Red)
	if presence := awaitRoster(t, observer, "engine"); !presence.Busy {
		t.Fatalf("expected the engine to be published as playing, got %#v", presence)
	}

	participant := server.participantFor(engine)
	if participant == nil {
		t.Fatal("the engine should be seated in the challenge")
	}
	server.discardSession(participant.session)

	freed := awaitRoster(t, observer, "engine")
	if freed.Busy || freed.ActiveGames != 0 {
		t.Fatalf("expected the discarded engine to be published as idle, got %#v", freed)
	}
}

// A series holds its engines' slots between the games of a run, which is what
// keeps a challenge from taking a seat out from under it. Handing them back at
// the end of the run is therefore a change to the roster with no game ending
// left to publish it.
func TestTheRosterIsRestatedWhenASeriesReleasesItsEngines(t *testing.T) {
	server, first, second := seriesTestBots(t)
	watcher := watchRoster(t, server)

	playOneSeries(t, server, first, second)

	// The last thing the lobby was told, rather than the first: a run publishes
	// a roster at every game it seats and every game it ends, and all but the
	// last of those do say the engines are playing.
	deadline := time.Now().Add(2 * time.Second)
	for {
		firstRow, secondRow := watcher.row(first.UserID), watcher.row(second.UserID)
		idle := !firstRow.Busy && firstRow.ActiveGames == 0 &&
			!secondRow.Busy && secondRow.ActiveGames == 0
		if idle {
			return
		}
		if !time.Now().Before(deadline) {
			t.Fatalf("expected both engines to be published as idle after the run, got %#v and %#v",
				firstRow, secondRow)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// rosterWatcher is a lobby client that keeps only the latest row published for
// each engine — what somebody watching the bots page would be looking at.
//
// It reads continuously because it has to: a client whose buffer fills is
// dropped by the server, and a run of games publishes plenty.
type rosterWatcher struct {
	mu   sync.Mutex
	rows map[string]BotPresence
}

func (watcher *rosterWatcher) row(userID string) BotPresence {
	watcher.mu.Lock()
	defer watcher.mu.Unlock()
	return watcher.rows[userID]
}

func watchRoster(t *testing.T, server *Server) *rosterWatcher {
	t.Helper()
	watcher := &rosterWatcher{rows: make(map[string]BotPresence)}
	observer := &Client{send: make(chan []byte, 256), done: make(chan struct{})}
	server.hub.Register(observer)
	t.Cleanup(func() { server.hub.Unregister(observer) })

	stopped := make(chan struct{})
	t.Cleanup(func() { close(stopped) })
	go func() {
		for {
			select {
			case <-stopped:
				return
			case payload := <-observer.send:
				message := decodeLobbyMessage(t, payload)
				if message.Type != "engine_bots" {
					continue
				}
				watcher.mu.Lock()
				for _, presence := range message.EngineBots {
					watcher.rows[presence.UserID] = presence
				}
				watcher.mu.Unlock()
			}
		}
	}()
	return watcher
}
