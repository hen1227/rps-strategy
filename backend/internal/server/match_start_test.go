package server

import (
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
)

// queueTestServer is a server whose push sender says everybody is reachable, so
// a test can exercise the away queue without a push service. reachable is the
// one fact the whole feature branches on, so faking exactly it — and nothing
// else — keeps these tests about the queue rather than about crypto.
func queueTestServer(reachable bool) *Server {
	server := New(nil)
	server.push.webEnabled = reachable
	server.push.reachableOverride = &reachable
	return server
}

// queueUp puts a client in matchmaking and clears the messages that produces.
func queueUp(t *testing.T, server *Server, client *Client, modeID game.ModeID) *Seek {
	t.Helper()
	server.handleMessage(client, ClientMessage{Type: "join_queue", ModeID: modeID})
	drainChallengeTestMessages(t, client)
	seek := server.seeks.ForClient(client)
	if seek == nil {
		t.Fatalf("expected %s to be queued", client.profile.Username)
	}
	return seek
}

// theOnlyGame is the single live session, which every test here expects to have
// created exactly one of.
func theOnlyGame(t *testing.T, server *Server) *GameSession {
	t.Helper()
	server.mu.RLock()
	defer server.mu.RUnlock()
	if len(server.games) != 1 {
		t.Fatalf("expected exactly one live game, got %d", len(server.games))
	}
	for _, session := range server.games {
		return session
	}
	return nil
}

// Two people watching the lobby get a game the instant they pair, with nothing
// to click — and so does everybody else now, which is the whole change.
func TestPairingSeatsTheGameImmediately(t *testing.T) {
	server := queueTestServer(true)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)
	queueUp(t, server, alice, game.ModeTotalWar)
	queueUp(t, server, bob, game.ModeTotalWar)

	server.seeks.pair()

	found, ok := messageOfType(drainChallengeTestMessages(t, alice), "match_found")
	if !ok {
		t.Fatal("pairing should open the board at once")
	}
	if found.FirstMoveDeadlineUnixMs <= time.Now().UnixMilli() {
		t.Fatal("a newly seated game should carry a first-move deadline in the future")
	}
	if found.GameState.Clock.ActiveColor != game.Neutral {
		t.Fatalf("no clock should be running before the first move, got %q",
			found.GameState.Clock.ActiveColor)
	}
}

// The point of seating immediately: a player who closed the tab gets a board
// waiting for them rather than a second thing to accept.
func TestAnAwayPlayerIsSeatedAnyway(t *testing.T) {
	server := queueTestServer(true)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)
	queueUp(t, server, alice, game.ModeTotalWar)
	bobSeek := queueUp(t, server, bob, game.ModeTotalWar)

	// Bob closes the tab. He is reachable, so his place is held.
	server.disconnect(bob)
	if server.seeks.ForOwner(bobSeek.Owner) == nil {
		t.Fatal("a reachable player should keep their place in the queue")
	}
	drainChallengeTestMessages(t, alice)

	server.seeks.pair()

	if _, ok := messageOfType(drainChallengeTestMessages(t, alice), "match_found"); !ok {
		t.Fatal("the present player should be seated even though nobody is opposite")
	}
	session := theOnlyGame(t, server)
	if !session.game.AwaitingFirstMove() {
		t.Fatal("a game nobody has moved in should be awaiting its first move")
	}
	// The absent seat is empty, and the game is named so that a fresh tab
	// opened by the notification can be handed straight back into it.
	server.mu.RLock()
	empty := session.blueClient == nil || session.redClient == nil
	server.mu.RUnlock()
	if !empty {
		t.Fatal("the away player's seat should have no socket in it")
	}
	if server.liveGameFor("bob") != session.gameID {
		t.Fatal("a reconnecting browser should be told the game it is already in")
	}
}

// The core promise: nobody moves, so nothing happened. No result, no record, no
// rating — and the player who was there keeps every second of their wait.
func TestNoFirstMoveCancelsTheGameWithoutARating(t *testing.T) {
	server := queueTestServer(true)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)
	aliceSeek := queueUp(t, server, alice, game.ModeTotalWar)
	bobSeek := queueUp(t, server, bob, game.ModeTotalWar)

	// Alice has been waiting a long time, so her rating band has widened well
	// past where a fresh search would start. She also asks for the seat that
	// replies, so the no-show is Bob whichever way the seats fell.
	joined := time.Now().Add(-90 * time.Second)
	aliceSeek.JoinedAt = joined
	aliceSeek.Setup.PreferredColor = game.OtherColor(game.FirstToMove)
	widened := aliceSeek.SearchRange(time.Now())
	if widened <= matchmakingInitialEloRange {
		t.Fatalf("test setup: expected a widened search range, got %d", widened)
	}

	server.disconnect(bob)
	server.seeks.pair()
	drainChallengeTestMessages(t, alice)

	server.expireUnstartedGames(time.Now().Add(firstMoveWindow + time.Second))

	server.mu.RLock()
	live := len(server.games)
	server.mu.RUnlock()
	if live != 0 {
		t.Fatalf("a game nobody played should be gone, not finished: %d left", live)
	}
	if server.seeks.ForOwner(bobSeek.Owner) != nil {
		t.Fatal("the player who never moved should be out of the queue")
	}
	survivor := server.seeks.ForOwner(aliceSeek.Owner)
	if survivor == nil {
		t.Fatal("the player who was waiting should be back in the queue")
	}
	if survivor.ID != aliceSeek.ID {
		t.Fatalf("the survivor should keep the same seek: %s vs %s", survivor.ID, aliceSeek.ID)
	}
	if !survivor.JoinedAt.Equal(joined) {
		t.Fatal("requeueing must not reset the wait")
	}
	// The assertion that actually proves the wait was preserved: a reset would
	// snap the rating band back to its opening width.
	if got := survivor.SearchRange(time.Now()); got <= matchmakingInitialEloRange {
		t.Fatalf("the widened search range should survive a cancellation, got %d", got)
	}
	if _, ok := messageOfType(drainChallengeTestMessages(t, alice), "game_cancelled"); !ok {
		t.Fatal("the player who was waiting should be told why the game vanished")
	}
}

// A first move is what turns a seated board into a game. After it, the sweep
// has no business with it at all.
func TestTheFirstMoveStartsTheClockAndEndsTheWindow(t *testing.T) {
	server := queueTestServer(true)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)
	queueUp(t, server, alice, game.ModeTotalWar)
	queueUp(t, server, bob, game.ModeTotalWar)
	server.seeks.pair()

	session := theOnlyGame(t, server)
	state := session.game.Snapshot()
	mover := alice
	if colorForUser(state, "bob") == state.CurrentTurn {
		mover = bob
	}
	from, to := firstLegalMove(t, session, state.CurrentTurn)
	server.handleMessage(mover, ClientMessage{Type: "make_move", From: from, To: to})

	if session.game.AwaitingFirstMove() {
		t.Fatal("a move should end the first-move window")
	}
	if got := session.game.Snapshot().Clock.ActiveColor; got == game.Neutral {
		t.Fatal("a move should start the clock")
	}
	server.mu.RLock()
	escrow := session.start
	server.mu.RUnlock()
	if escrow != nil {
		t.Fatal("the escrow should be released by the first move")
	}

	server.expireUnstartedGames(time.Now().Add(firstMoveWindow + time.Second))
	server.mu.RLock()
	live := len(server.games)
	server.mu.RUnlock()
	if live != 1 {
		t.Fatal("a game that has begun must not be swept away as unplayed")
	}
}

// Neither clock may fall while the game is waiting to begin, however long the
// two players take to arrive.
func TestNoClockFallsBeforeTheFirstMove(t *testing.T) {
	server := queueTestServer(true)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)
	queueUp(t, server, alice, game.ModeTotalWar)
	queueUp(t, server, bob, game.ModeTotalWar)
	server.seeks.pair()

	session := theOnlyGame(t, server)
	initial := session.game.Snapshot().TimeControl.InitialTimeMs
	server.expireGames(time.Now().Add(time.Hour))

	state := session.game.Snapshot()
	if state.Status != game.InProgress {
		t.Fatalf("an unbegun game must not time out, got %q", state.Status)
	}
	if state.Clock.RedRemainingMs != initial || state.Clock.BlueRemainingMs != initial {
		t.Fatalf("neither clock should have moved: %#v", state.Clock)
	}
}

// Somebody who opens the notification and cannot play frees their opponent at
// once, rather than making them wait out a countdown that is already decided.
func TestAbortingReleasesTheOpponentImmediately(t *testing.T) {
	server := queueTestServer(true)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)
	aliceSeek := queueUp(t, server, alice, game.ModeTotalWar)
	bobSeek := queueUp(t, server, bob, game.ModeTotalWar)
	server.seeks.pair()
	drainChallengeTestMessages(t, alice)
	drainChallengeTestMessages(t, bob)

	server.handleMessage(bob, ClientMessage{Type: "abort_game"})

	if server.seeks.ForOwner(aliceSeek.Owner) == nil {
		t.Fatal("aborting should put the other player straight back in the queue")
	}
	if server.seeks.ForOwner(bobSeek.Owner) != nil {
		t.Fatal("aborting should take the player who aborted out of the queue")
	}
	server.mu.RLock()
	live := len(server.games)
	server.mu.RUnlock()
	if live != 0 {
		t.Fatalf("an aborted game should leave nothing behind, got %d", live)
	}
	if _, ok := messageOfType(drainChallengeTestMessages(t, alice), "game_cancelled"); !ok {
		t.Fatal("the other player should be told the game was called off")
	}
}

// Abort is only an escape from a game that has not begun. Once a move is on the
// board the only way out is a resignation, which is rated.
func TestAbortIsRefusedOnceTheGameHasBegun(t *testing.T) {
	server := queueTestServer(true)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)
	queueUp(t, server, alice, game.ModeTotalWar)
	queueUp(t, server, bob, game.ModeTotalWar)
	server.seeks.pair()

	session := theOnlyGame(t, server)
	state := session.game.Snapshot()
	mover, waiter := alice, bob
	if colorForUser(state, "bob") == state.CurrentTurn {
		mover, waiter = bob, alice
	}
	from, to := firstLegalMove(t, session, state.CurrentTurn)
	server.handleMessage(mover, ClientMessage{Type: "make_move", From: from, To: to})
	drainChallengeTestMessages(t, waiter)

	server.handleMessage(waiter, ClientMessage{Type: "abort_game"})

	if _, ok := messageOfType(drainChallengeTestMessages(t, waiter), "action_rejected"); !ok {
		t.Fatal("a game with a move in it should refuse to be aborted")
	}
	server.mu.RLock()
	live := len(server.games)
	server.mu.RUnlock()
	if live != 1 {
		t.Fatal("the game should still be being played")
	}
}

// The opponent moving on the last second must not cost an absent player the
// game: their grace period runs from when the game became real.
func TestTheFirstMoveReanchorsTheAbsentPlayersGrace(t *testing.T) {
	server := queueTestServer(true)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)
	aliceSeek := queueUp(t, server, alice, game.ModeTotalWar)
	// Alice takes the opening seat, so she is the one who can move while Bob is
	// away.
	aliceSeek.Setup.PreferredColor = game.FirstToMove
	queueUp(t, server, bob, game.ModeTotalWar)
	server.disconnect(bob)
	server.seeks.pair()

	session := theOnlyGame(t, server)
	// Bob holds whichever seat Alice did not ask for, and it is his clock the
	// grace period is measured on.
	awayAt := &session.redDisconnectedAt
	if game.FirstToMove == game.Red {
		awayAt = &session.blueDisconnectedAt
	}
	server.mu.Lock()
	// Bob has been gone almost the whole window.
	*awayAt = time.Now().Add(-firstMoveWindow + time.Second)
	server.mu.Unlock()

	state := session.game.Snapshot()
	from, to := firstLegalMove(t, session, state.CurrentTurn)
	server.handleMessage(alice, ClientMessage{Type: "make_move", From: from, To: to})

	server.mu.RLock()
	away := game.Red
	if awayAt == &session.blueDisconnectedAt {
		away = game.Blue
	}
	grace := session.reconnectDeadline(away, session.game.Snapshot()).Sub(time.Now())
	server.mu.RUnlock()
	if grace < firstMoveWindow-time.Second {
		t.Fatalf("the absent player should get a whole grace period, got %s", grace)
	}
}

// Clicking PLAY on an away player's row opens the board rather than starting a
// negotiation about whether it may open.
func TestAcceptingAnAwayPlayersRowStartsTheGame(t *testing.T) {
	server := queueTestServer(true)
	poster := challengeTestClient("poster", "Poster")
	taker := challengeTestClient("taker", "Taker")
	server.hub.Register(poster)
	server.hub.Register(taker)
	server.handleMessage(poster, customOpenChallenge(game.ModeTotalWar))
	drainChallengeTestMessages(t, poster)
	seek := server.seeks.ForClient(poster)
	if seek == nil {
		t.Fatal("test setup: expected a posted challenge")
	}
	// The poster wanders off without closing the tab.
	server.handleMessage(poster, ClientMessage{Type: "queue_presence", Present: false})
	drainChallengeTestMessages(t, taker)

	server.handleMessage(taker, ClientMessage{Type: "accept_challenge", ChallengeID: seek.ID})

	found, ok := messageOfType(drainChallengeTestMessages(t, taker), "match_found")
	if !ok {
		t.Fatal("taking a game should open it, whether or not its author is watching")
	}
	if found.FirstMoveDeadlineUnixMs == 0 {
		t.Fatal("an accepted challenge should still wait for a first move")
	}
}

// Somebody who took one posted game never asked to be in matchmaking, so a
// cancellation must not leave them queued.
func TestACancelledChallengeDoesNotQueueEitherPlayer(t *testing.T) {
	server := queueTestServer(true)
	poster := challengeTestClient("poster", "Poster")
	taker := challengeTestClient("taker", "Taker")
	server.hub.Register(poster)
	server.hub.Register(taker)
	server.handleMessage(poster, customOpenChallenge(game.ModeTotalWar))
	drainChallengeTestMessages(t, poster)
	seek := server.seeks.ForClient(poster)
	server.handleMessage(poster, ClientMessage{Type: "queue_presence", Present: false})
	server.handleMessage(taker, ClientMessage{Type: "accept_challenge", ChallengeID: seek.ID})

	server.expireUnstartedGames(time.Now().Add(firstMoveWindow + time.Second))

	if server.seeks.ForClient(taker) != nil {
		t.Fatal("taking one game is not asking to be put in matchmaking")
	}
	if server.seeks.Len() != 0 {
		t.Fatalf("the board should be empty, got %d", server.seeks.Len())
	}
}

// A board with your name on it is a game, so a second tab must not be able to
// queue past it and land the same person in two.
func TestAnUnbegunGameBlocksJoiningAnotherQueue(t *testing.T) {
	server := queueTestServer(true)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)
	queueUp(t, server, alice, game.ModeTotalWar)
	queueUp(t, server, bob, game.ModeTotalWar)
	server.seeks.pair()
	drainChallengeTestMessages(t, alice)

	server.handleMessage(alice, ClientMessage{Type: "join_queue", ModeID: game.ModeInfiltration})

	messages := drainChallengeTestMessages(t, alice)
	if _, ok := messageOfType(messages, "queue_update"); ok {
		t.Fatalf("a player sitting at a board should not be able to join a queue: %#v", messages)
	}
}

// A tournament ready-up is a button pressed seconds ago, so those games open
// with the clock already running and are never swept as unplayed.
func TestTournamentAndBotGamesRunTheClockFromTheStart(t *testing.T) {
	server := queueTestServer(true)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)

	session := server.startConfiguredMatch(
		QueueEntry{Client: alice, Setup: game.GameSetup{ModeID: game.ModeTotalWar}},
		QueueEntry{Client: bob, Setup: game.GameSetup{ModeID: game.ModeTotalWar}},
		matchSetup{},
	)
	if session == nil {
		t.Fatal("expected a game")
	}
	if session.game.AwaitingFirstMove() {
		t.Fatal("a game seated without an escrow should be live from the first tick")
	}
	if got := session.game.Snapshot().Clock.ActiveColor; got != game.FirstToMove {
		t.Fatalf("the clock should already be running, got %q", got)
	}
}

// firstLegalMove finds something the side to move is allowed to play, so a test
// can start a game without knowing a mode's rules.
func firstLegalMove(
	t *testing.T,
	session *GameSession,
	player game.PlayerColor,
) (game.Position, game.Position) {
	t.Helper()
	state := session.game.Snapshot()
	for y := 0; y < game.BoardSize; y++ {
		for x := 0; x < game.BoardSize; x++ {
			from := game.Position{X: x, Y: y}
			targets := session.game.ValidMoves(player, from)
			if len(targets) > 0 {
				return from, targets[0]
			}
		}
	}
	t.Fatalf("no legal move for %s in %s", player, state.Mode.ID)
	return game.Position{}, game.Position{}
}
