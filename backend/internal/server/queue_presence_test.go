package server

import (
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
)

// The rule the whole feature rests on, in its two halves.

func TestDisconnectKeepsTheSeekOfSomebodyReachable(t *testing.T) {
	server := queueTestServer(true)
	alice := challengeTestClient("alice", "Alice")
	server.hub.Register(alice)
	seek := queueUp(t, server, alice, game.ModeTotalWar)

	server.disconnect(alice)

	kept := server.seeks.ForOwner(seek.Owner)
	if kept == nil {
		t.Fatal("a reachable player keeps their place when the tab closes")
	}
	if kept.Client() != nil {
		t.Fatal("a kept seek should have no socket behind it")
	}
	if kept.Present() {
		t.Fatal("a seek with no socket is away, whatever its client last claimed")
	}
	if kept.ExpiresAt.IsZero() {
		t.Fatal("an away seek should not wait for ever")
	}
}

func TestDisconnectWithoutASubscriptionWithdrawsTheSeek(t *testing.T) {
	server := queueTestServer(false)
	alice := challengeTestClient("alice", "Alice")
	server.hub.Register(alice)
	seek := queueUp(t, server, alice, game.ModeTotalWar)

	server.disconnect(alice)

	if server.seeks.ForOwner(seek.Owner) != nil {
		t.Fatal("somebody who cannot be called back must not be left on the board")
	}
	if server.seeks.Len() != 0 {
		t.Fatalf("the board should be empty, got %d", server.seeks.Len())
	}
}

// A closed socket outranks whatever the browser last said about itself.
func TestDisconnectForcesAwayWhateverWasClaimed(t *testing.T) {
	server := queueTestServer(true)
	alice := challengeTestClient("alice", "Alice")
	server.hub.Register(alice)
	seek := queueUp(t, server, alice, game.ModeTotalWar)

	server.handleMessage(alice, ClientMessage{Type: "queue_presence", Present: true})
	if !seek.Present() {
		t.Fatal("test setup: expected a present seek")
	}
	server.disconnect(alice)

	if seek.Present() {
		t.Fatal("a seek with no socket cannot be present")
	}
}

// An idle tab is a tab with nobody behind it. It gets the board like everybody
// else — with no clock running — and a notification to say so.
func TestAnIdleTabIsSeatedAndNotified(t *testing.T) {
	server := queueTestServer(true)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)
	queueUp(t, server, alice, game.ModeTotalWar)
	queueUp(t, server, bob, game.ModeTotalWar)

	server.handleMessage(bob, ClientMessage{Type: "queue_presence", Present: false})
	drainChallengeTestMessages(t, alice)
	drainChallengeTestMessages(t, bob)

	server.seeks.pair()

	found, ok := messageOfType(drainChallengeTestMessages(t, bob), "match_found")
	if !ok {
		t.Fatal("an idle player is still seated: the clock, not the board, is what waits")
	}
	if found.GameState.Clock.ActiveColor != game.Neutral {
		t.Fatal("nothing should be ticking against somebody who is not looking")
	}
	server.mu.RLock()
	live := len(server.games)
	server.mu.RUnlock()
	if live != 1 {
		t.Fatalf("expected the game to have opened, got %d", live)
	}
}

// One person waiting once, however many tabs they have open.
func TestASecondTabJoinsTheSameWait(t *testing.T) {
	server := queueTestServer(true)
	first := challengeTestClient("alice", "Alice")
	second := challengeTestClient("alice", "Alice")
	server.hub.Register(first)
	server.hub.Register(second)
	seek := queueUp(t, server, first, game.ModeTotalWar)

	if found := server.seeks.ForClient(second); found != seek {
		t.Fatal("a second tab should find the wait its owner is already in")
	}
	if server.seeks.Len() != 1 {
		t.Fatalf("one person is one row on the board, got %d", server.seeks.Len())
	}
}

// Closing one of two windows should not turn a present player into an absent
// one.
func TestClosingOneTabRebindsToTheOther(t *testing.T) {
	server := queueTestServer(true)
	first := challengeTestClient("alice", "Alice")
	second := challengeTestClient("alice", "Alice")
	server.hub.Register(first)
	server.hub.Register(second)
	seek := queueUp(t, server, first, game.ModeTotalWar)

	server.disconnect(first)

	if seek.Client() != second {
		t.Fatal("the wait should move to the tab that is still open")
	}
	if !seek.Present() {
		t.Fatal("a player with another tab open is still present")
	}
}

// A reconnecting player is told what they are already in, rather than having to
// re-join and lose the wait they have served.
func TestReconnectHandsBackTheLiveSeek(t *testing.T) {
	server := queueTestServer(true)
	alice := challengeTestClient("alice", "Alice")
	server.hub.Register(alice)
	seek := queueUp(t, server, alice, game.ModeTotalWar)
	seek.JoinedAt = time.Now().Add(-45 * time.Second)
	server.disconnect(alice)

	back := challengeTestClient("alice", "Alice")
	server.hub.Register(back)
	snapshot := server.rebindSeek(back)

	if snapshot == nil {
		t.Fatal("a reconnecting searcher should be told they are still queued")
	}
	if snapshot.QueuedForMs < 40_000 {
		t.Fatalf("the wait already served should survive a reconnection, got %dms", snapshot.QueuedForMs)
	}
	if seek.Client() != back {
		t.Fatal("the seek should be bound to the new socket")
	}
	if !seek.ExpiresAt.IsZero() {
		t.Fatal("coming back should stop the away clock")
	}
}

// A posted challenge is an advertisement with its own expiry. Two lifetimes
// competing over one row buys nothing, so it still dies with its socket.
func TestAPostedChallengeStillDiesWithItsSocket(t *testing.T) {
	server := queueTestServer(true)
	alice := challengeTestClient("alice", "Alice")
	server.hub.Register(alice)
	server.handleMessage(alice, customOpenChallenge(game.ModeTotalWar))
	drainChallengeTestMessages(t, alice)
	if server.seeks.Len() != 1 {
		t.Fatal("test setup: expected a posted challenge")
	}

	server.disconnect(alice)

	if server.seeks.Len() != 0 {
		t.Fatal("a posted challenge should not outlive its author's socket")
	}
}

// An anonymous browser cannot be recognised across connections, so there is
// nothing to call back to.
func TestAnAnonymousSeekNeverOutlivesItsSocket(t *testing.T) {
	server := queueTestServer(true)
	guest := challengeTestClient("", "")
	server.hub.Register(guest)
	server.handleMessage(guest, ClientMessage{Type: "join_queue", ModeID: game.ModeTotalWar})
	drainChallengeTestMessages(t, guest)
	if server.seeks.Len() != 1 {
		t.Fatal("test setup: expected a queued guest")
	}

	server.disconnect(guest)

	if server.seeks.Len() != 0 {
		t.Fatal("an anonymous search cannot be summoned, so it must not be kept")
	}
}

// An away seek is honest about being away, and the lobby can say so.
func TestTheBoardLabelsAnAwaySearcher(t *testing.T) {
	server := queueTestServer(true)
	alice := challengeTestClient("alice", "Alice")
	watcher := challengeTestClient("watcher", "Watcher")
	server.hub.Register(alice)
	server.hub.Register(watcher)
	queueUp(t, server, alice, game.ModeTotalWar)

	board := server.openChallenges(time.Now())
	if len(board) != 1 || !board[0].Present {
		t.Fatalf("a searcher at the keyboard should read as present: %#v", board)
	}
	if server.modeReadyCounts()[game.ModeTotalWar] != 1 {
		t.Fatal("a present searcher should be counted as ready")
	}

	server.disconnect(alice)

	board = server.openChallenges(time.Now())
	if len(board) != 1 {
		t.Fatalf("an away searcher is still a row on the board: %#v", board)
	}
	if board[0].Present {
		t.Fatal("an away searcher must not be advertised as being at the keyboard")
	}
	if server.modeReadyCounts()[game.ModeTotalWar] != 0 {
		t.Fatal("an away searcher is not somebody you can play right now")
	}
	if server.seeks.CountsByMode()[game.ModeTotalWar] != 1 {
		t.Fatal("an away searcher is still queued")
	}
}

// An away seek does not wait for ever.
func TestAnAwaySeekExpires(t *testing.T) {
	server := queueTestServer(true)
	alice := challengeTestClient("alice", "Alice")
	server.hub.Register(alice)
	seek := queueUp(t, server, alice, game.ModeTotalWar)
	server.disconnect(alice)

	server.expireChallenges(time.Now().Add(awaySeekLifetime + time.Minute))

	if server.seeks.ForOwner(seek.Owner) != nil {
		t.Fatal("a search left running should eventually end by itself")
	}
}

// Withdrawing a seek whose author has gone must not reach through a nil socket.
func TestAnnouncingAWithdrawnAwaySeekDoesNotPanic(t *testing.T) {
	server := queueTestServer(true)
	alice := challengeTestClient("alice", "Alice")
	server.hub.Register(alice)
	seek := queueUp(t, server, alice, game.ModeTotalWar)
	server.disconnect(alice)
	server.hub.Unregister(alice)

	claimed := server.seeks.Claim(seek.ID)
	if claimed == nil {
		t.Fatal("test setup: expected the seek to still be there")
	}
	server.announceWithdrawnSeek(claimed, "gone")
}

// Losing the last subscription is the moment a kept seek stops being honest.
func TestLosingReachabilityDropsAnAwaySeek(t *testing.T) {
	server := queueTestServer(true)
	alice := challengeTestClient("alice", "Alice")
	server.hub.Register(alice)
	seek := queueUp(t, server, alice, game.ModeTotalWar)
	server.disconnect(alice)
	if server.seeks.ForOwner(seek.Owner) == nil {
		t.Fatal("test setup: expected the seek to be kept")
	}

	server.dropUnreachableSeeks("alice")

	if server.seeks.ForOwner(seek.Owner) != nil {
		t.Fatal("a seek nobody can be summoned from must come off the board")
	}
}

// A seek that has been through a cancelled game must still listen to its owner.
//
// Requeueing puts the same *Seek back on the board, so anything the cancelled
// game left behind on it travels with it — and a seek that has stopped
// believing its own socket is one that can never be marked away again, which
// quietly turns the next pairing into a game against an empty chair.
func TestPresenceStillWorksAfterACancelledGameRequeue(t *testing.T) {
	server := queueTestServer(true)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)
	aliceSeek := queueUp(t, server, alice, game.ModeTotalWar)
	// Alice takes Blue, so the game waits on Bob — who has gone — and it is
	// Alice's seek that comes back to the board.
	aliceSeek.Setup.PreferredColor = game.Blue
	queueUp(t, server, bob, game.ModeTotalWar)

	server.disconnect(bob)
	server.seeks.pair()
	server.expireUnstartedGames(time.Now().Add(firstMoveWindow + time.Second))

	requeued := server.seeks.ForClient(alice)
	if requeued == nil {
		t.Fatal("test setup: alice should be back on the board")
	}
	if !requeued.Present() {
		t.Fatal("test setup: alice is still at her keyboard")
	}

	server.handleMessage(alice, ClientMessage{Type: "queue_presence", Present: false})

	if requeued.Present() {
		t.Fatal("a requeued seek must still hear its owner say they have wandered off")
	}
}
