package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// casualLinkSetup is a game nobody needs an account for, so a test about who
// may take a link is not also a test about ranked play.
func casualLinkSetup() *game.GameSetup {
	return &game.GameSetup{ModeID: game.ModeTotalWar, Casual: true}
}

// putOutLink has a client make a link and hands back its code. The author's
// tab then says somebody is looking at it, as the app's does the moment it
// holds a link (useQueuePresence); a test about an author who is not looking
// says so afterwards.
func putOutLink(t *testing.T, server *Server, author *Client, setup *game.GameSetup) string {
	t.Helper()
	server.handleMessage(author, ClientMessage{Type: "create_challenge_link", Setup: setup})
	made, found := messageOfType(drainChallengeTestMessages(t, author), "challenge_link")
	if !found || made.ChallengeLink == nil || made.ChallengeLink.State != LinkOpen {
		t.Fatalf("expected the author to be handed an open link: %#v", made)
	}
	if made.ChallengeLink.ExpiresAtUnixMs == 0 {
		t.Fatal("an open link should say when it expires")
	}
	server.handleMessage(author, ClientMessage{Type: "queue_presence", Present: true})
	drainChallengeTestMessages(t, author)
	return made.ChallengeLink.Code
}

// lastLink is the newest challenge_link a client was sent.
func lastLink(t *testing.T, messages []ServerMessage) ServerMessage {
	t.Helper()
	var last ServerMessage
	found := false
	for _, message := range messages {
		if message.Type == "challenge_link" {
			last, found = message, true
		}
	}
	if !found || last.ChallengeLink == nil {
		t.Fatalf("expected a challenge_link message: %#v", messages)
	}
	return last
}

func openBoards(server *Server) int {
	server.mu.RLock()
	defer server.mu.RUnlock()
	return len(server.games)
}

// The case the feature is for: the author is at the screen, and whoever opens
// the link is put straight into the game with them.
func TestOpeningALinkStartsTheGameWhenItsAuthorIsHere(t *testing.T) {
	server := queueTestServer(false)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)
	code := putOutLink(t, server, alice, casualLinkSetup())

	server.handleMessage(bob, ClientMessage{Type: "open_challenge_link", LinkCode: code})

	bobMessages := drainChallengeTestMessages(t, bob)
	if _, found := messageOfType(bobMessages, "match_found"); !found {
		t.Fatalf("opening the link should put the taker straight into the game: %#v", bobMessages)
	}
	aliceMessages := drainChallengeTestMessages(t, alice)
	found, ok := messageOfType(aliceMessages, "match_found")
	if !ok {
		t.Fatal("the author should be seated too")
	}
	// The courtesy every challenge carries: with no seat asked for, the author
	// gets the side that opens.
	if found.Color != game.FirstToMove {
		t.Fatalf("the author should move first, got %s", found.Color)
	}
	started := lastLink(t, aliceMessages)
	if started.ChallengeLink.State != LinkStarted || started.ChallengeLink.GameID == "" {
		t.Fatalf("the author should be told the link became a game: %#v", started.ChallengeLink)
	}
	if started.ChallengeLink.Taker == nil || started.ChallengeLink.Taker.UserID != "bob" {
		t.Fatal("the author should be told who took it, for the popup")
	}
	if session := theOnlyGame(t, server); session.ranked {
		t.Fatal("a casual link must start an unranked game")
	}
}

// Everybody after the first is shown the game rather than refused.
func TestEverybodyElseWhoOpensALinkIsShownTheGame(t *testing.T) {
	server := queueTestServer(false)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	cleo := challengeTestClient("cleo", "Cleo")
	server.hub.Register(alice)
	server.hub.Register(bob)
	server.hub.Register(cleo)
	code := putOutLink(t, server, alice, casualLinkSetup())
	server.handleMessage(bob, ClientMessage{Type: "open_challenge_link", LinkCode: code})
	gameID := theOnlyGame(t, server).gameID

	server.handleMessage(cleo, ClientMessage{Type: "open_challenge_link", LinkCode: code})

	shown := lastLink(t, drainChallengeTestMessages(t, cleo))
	if shown.ChallengeLink.State != LinkStarted || shown.ChallengeLink.GameID != gameID {
		t.Fatalf("a latecomer should be shown the game to watch: %#v", shown.ChallengeLink)
	}
	if server.participantFor(cleo) != nil || openBoards(server) != 1 {
		t.Fatal("a latecomer must not be seated, or start a second game")
	}
	server.handleMessage(cleo, ClientMessage{Type: "spectate_game", GameID: gameID})
	if _, found := messageOfType(drainChallengeTestMessages(t, cleo), "spectator_joined"); !found {
		t.Fatal("the game a link names should be watchable")
	}
}

// The author opening their own link sees it; it does not take itself.
func TestTheAuthorOpeningTheirOwnLinkIsShownIt(t *testing.T) {
	server := queueTestServer(false)
	alice := challengeTestClient("alice", "Alice")
	secondTab := challengeTestClient("alice", "Alice")
	server.hub.Register(alice)
	server.hub.Register(secondTab)
	code := putOutLink(t, server, alice, casualLinkSetup())
	drainChallengeTestMessages(t, secondTab)

	server.handleMessage(secondTab, ClientMessage{Type: "open_challenge_link", LinkCode: code})

	shown := lastLink(t, drainChallengeTestMessages(t, secondTab))
	if shown.ChallengeLink.State != LinkOpen || shown.ChallengeLink.Taker != nil {
		t.Fatalf("the author's own link should still be open: %#v", shown.ChallengeLink)
	}
	if openBoards(server) != 0 {
		t.Fatal("nobody should be playing yet")
	}
}

// An author who has gone is called, and whoever took the link waits in the
// lobby for as long as they like — well past the hour the link was good for.
func TestAnAwayAuthorIsCalledAndTheTakerWaitsIndefinitely(t *testing.T) {
	type delivery struct {
		kind       string
		expiration int64
	}
	delivered := make(chan delivery, 4)
	server, endpoint := pushTestServer(t, func(writer http.ResponseWriter, request *http.Request) {
		raw, _ := io.ReadAll(request.Body)
		var body apnsBody
		_ = json.Unmarshal(raw, &body)
		expiration, _ := strconv.ParseInt(request.Header.Get("apns-expiration"), 10, 64)
		delivered <- delivery{kind: body.Data.Kind, expiration: expiration}
		writer.WriteHeader(http.StatusOK)
	})
	withAPNs(t, server, endpoint)
	seedAccount(t, server, "alice")
	if _, err := server.data.SavePushSubscription(context.Background(), persistence.PushSubscription{
		Endpoint:        testDeviceToken,
		UserID:          "alice",
		Transport:       persistence.TransportAPNs,
		CreatedAtUnixMs: settledAt(),
	}); err != nil {
		t.Fatal(err)
	}
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)
	code := putOutLink(t, server, alice, casualLinkSetup())
	server.disconnect(alice)

	server.handleMessage(bob, ClientMessage{Type: "open_challenge_link", LinkCode: code})

	waiting := lastLink(t, drainChallengeTestMessages(t, bob))
	if waiting.ChallengeLink.State != LinkWaiting {
		t.Fatalf("with the author gone, the taker should be waiting: %#v", waiting.ChallengeLink)
	}
	if waiting.ChallengeLink.AuthorStatus != linkAuthorAway || !waiting.ChallengeLink.AuthorCalled {
		t.Fatalf("the taker should be told the author is away and was called: %#v", waiting.ChallengeLink)
	}
	if waiting.ChallengeLink.ExpiresAtUnixMs != 0 {
		t.Fatal("a taken link must not show an expiry: the taker waits as long as they like")
	}
	if openBoards(server) != 0 {
		t.Fatal("no board should open for an author who is not there")
	}
	select {
	case call := <-delivered:
		if call.kind != "challenge_accepted" {
			t.Fatalf("the author should be told their link was taken, got %q", call.kind)
		}
		// Held for as long as the link was good for, not the forty-five
		// seconds a seat is.
		if remaining := time.Until(time.Unix(call.expiration, 0)); remaining < 50*time.Minute {
			t.Fatalf("the call should outlive a seat's summons, expires in %s", remaining)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the author was never called")
	}

	// Long past the link's hour, the taker is still waiting.
	server.sweepChallengeLinks(time.Now().Add(3 * challengeLinkLifetime))
	if state := server.links.state(server.links.get(code)); state != LinkWaiting {
		t.Fatalf("a taker still in the lobby keeps waiting, got %s", state)
	}
	select {
	case <-delivered:
		t.Fatal("the author should be called once per taker, not on every tick")
	case <-time.After(50 * time.Millisecond):
	}

	// The author comes back from the notification, and the game opens. Their
	// tab says it is looked at as soon as it connects, because it holds a link;
	// until it does, the lobby tick leaves the board closed.
	returned := challengeTestClient("alice", "Alice")
	server.hub.Register(returned)
	server.sweepChallengeLinks(time.Now())
	if openBoards(server) != 0 {
		t.Fatal("a tab that has not said where its person is should not be seated")
	}
	server.handleMessage(returned, ClientMessage{Type: "queue_presence", Present: true})
	if _, found := messageOfType(drainChallengeTestMessages(t, returned), "match_found"); !found {
		t.Fatal("the author coming back should open the game")
	}
	if _, found := messageOfType(drainChallengeTestMessages(t, bob), "match_found"); !found {
		t.Fatal("the waiting taker should be put into the game")
	}
}

// An author with the tab open and nobody behind it is idle: the taker waits,
// and the game opens the moment the author comes back to the screen.
func TestAnIdleAuthorStartsTheGameByComingBack(t *testing.T) {
	server := queueTestServer(false)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)
	code := putOutLink(t, server, alice, casualLinkSetup())
	server.handleMessage(alice, ClientMessage{Type: "queue_presence", Present: false})

	server.handleMessage(bob, ClientMessage{Type: "open_challenge_link", LinkCode: code})

	waiting := lastLink(t, drainChallengeTestMessages(t, bob))
	if waiting.ChallengeLink.State != LinkWaiting || waiting.ChallengeLink.AuthorStatus != linkAuthorIdle {
		t.Fatalf("an idle author should leave the taker waiting: %#v", waiting.ChallengeLink)
	}
	if waiting.ChallengeLink.AuthorCalled {
		t.Fatal("nobody can be called on a server with no way to reach them")
	}
	if told := lastLink(t, drainChallengeTestMessages(t, alice)); told.ChallengeLink.State != LinkWaiting {
		t.Fatal("the author's open tab should hear that somebody is waiting")
	}

	server.handleMessage(alice, ClientMessage{Type: "queue_presence", Present: true})

	if _, found := messageOfType(drainChallengeTestMessages(t, alice), "match_found"); !found {
		t.Fatal("coming back to the screen should open the game at once")
	}
}

// Only a socket that has said somebody is looking at it is somebody at the
// screen. One that has said nothing is given a moment, during which it is
// neither seated nor called, and after that it is nobody.
func TestOnlyASocketThatSaysSoIsSomebodyAtTheScreen(t *testing.T) {
	client := challengeTestClient("alice", "Alice")
	client.connectedAt = time.Now()
	if client.readyToBeSeated() {
		t.Fatal("a socket that has just connected has not said anything yet")
	}
	if !client.awaitingPresence(time.Now()) {
		t.Fatal("a socket that has just connected is about to say where its person is")
	}
	if client.awaitingPresence(time.Now().Add(freshSocketGrace)) {
		t.Fatal("a socket that says nothing for long enough has nothing to say")
	}
	client.setPresence(PresenceIdle)
	if client.readyToBeSeated() || client.awaitingPresence(time.Now()) {
		t.Fatal("a socket that has said it is not looked at is not")
	}
	client.setPresence(PresenceHere)
	if !client.readyToBeSeated() {
		t.Fatal("a socket that says it is looked at is")
	}

	// Saying "here" straight away is heard straight away, though it changes
	// nothing on paper — which is how a reconnecting author's game opens.
	fresh := challengeTestClient("alice", "Alice")
	fresh.connectedAt = time.Now()
	fresh.setPresence(PresenceHere)
	if !fresh.readyToBeSeated() {
		t.Fatal("a fresh socket that has said it is looked at needs no grace")
	}
}

// The author's tab that never says anything — a second window, or a page on a
// build from before links — is nobody at the screen. The board does not open
// on it; the author is called, and the game opens when a tab says it is
// looked at.
func TestASilentTabIsNotTakenForTheAuthor(t *testing.T) {
	server := queueTestServer(false)
	alice := challengeTestClient("alice", "Alice")
	silent := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(silent)
	server.hub.Register(bob)
	code := putOutLink(t, server, alice, casualLinkSetup())
	server.disconnect(alice)

	server.handleMessage(bob, ClientMessage{Type: "open_challenge_link", LinkCode: code})

	waiting := lastLink(t, drainChallengeTestMessages(t, bob))
	if waiting.ChallengeLink.State != LinkWaiting || waiting.ChallengeLink.AuthorStatus != linkAuthorIdle {
		t.Fatalf("a tab that never said where its person is should leave the taker waiting: %#v", waiting.ChallengeLink)
	}
	if openBoards(server) != 0 {
		t.Fatal("no board should open on a tab nobody said they were looking at")
	}
	server.sweepChallengeLinks(time.Now())
	if openBoards(server) != 0 {
		t.Fatal("the lobby tick must not open it either")
	}

	server.handleMessage(silent, ClientMessage{Type: "queue_presence", Present: true})
	if _, found := messageOfType(drainChallengeTestMessages(t, silent), "match_found"); !found {
		t.Fatal("the tab saying it is looked at should open the game")
	}
}

// A fresh socket of the author's, whose report has not arrived, reads as
// here to the person waiting: the author is not called in the gap.
func TestAnAuthorWhoseTabIsStillReportingIsNotCalledYet(t *testing.T) {
	server := queueTestServer(false)
	returned := challengeTestClient("alice", "Alice")
	returned.connectedAt = time.Now()
	server.hub.Register(returned)
	if status := server.challengeLinkAuthorStatus("alice", time.Now()); status != linkAuthorHere {
		t.Fatalf("a socket that is about to report should not read as away from it, got %q", status)
	}
	if status := server.challengeLinkAuthorStatus("alice", time.Now().Add(freshSocketGrace)); status != linkAuthorIdle {
		t.Fatalf("a socket that never reports is not looked at, got %q", status)
	}
}

// The author's tab coming back says "here" first thing, and that is when the
// game opens, not a lobby tick later.
func TestAReconnectedAuthorSayingHereOpensTheGameAtOnce(t *testing.T) {
	server := queueTestServer(false)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)
	code := putOutLink(t, server, alice, casualLinkSetup())
	server.disconnect(alice)
	server.handleMessage(bob, ClientMessage{Type: "open_challenge_link", LinkCode: code})

	returned := challengeTestClient("alice", "Alice")
	returned.connectedAt = time.Now()
	server.hub.Register(returned)
	server.handleMessage(returned, ClientMessage{Type: "queue_presence", Present: true})

	if _, found := messageOfType(drainChallengeTestMessages(t, returned), "match_found"); !found {
		t.Fatal("the author's first report should open the game")
	}
}

// An author in another game finishes it first.
func TestABusyAuthorPlaysTheLinkAfterTheirGame(t *testing.T) {
	server := queueTestServer(false)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	dana := challengeTestClient("dana", "Dana")
	server.hub.Register(alice)
	server.hub.Register(bob)
	server.hub.Register(dana)
	code := putOutLink(t, server, alice, casualLinkSetup())
	// Alice sits down to somebody else while her link is out.
	server.handleMessage(dana, customOpenChallenge(game.ModeTotalWar))
	sent, _ := messageOfType(drainChallengeTestMessages(t, dana), "challenge_sent")
	server.handleMessage(alice, ClientMessage{Type: "accept_challenge", ChallengeID: sent.Challenge.ID})
	first := theOnlyGame(t, server)

	server.handleMessage(bob, ClientMessage{Type: "open_challenge_link", LinkCode: code})

	waiting := lastLink(t, drainChallengeTestMessages(t, bob))
	if waiting.ChallengeLink.State != LinkWaiting || waiting.ChallengeLink.AuthorStatus != linkAuthorBusy {
		t.Fatalf("an author mid-game should leave the taker waiting: %#v", waiting.ChallengeLink)
	}
	server.sweepChallengeLinks(time.Now())
	if openBoards(server) != 1 {
		t.Fatal("nothing may open over a game the author is playing")
	}

	server.resign(alice)
	server.sweepChallengeLinks(time.Now())

	var linked *GameSession
	server.mu.RLock()
	for _, session := range server.games {
		if session != first {
			linked = session
		}
	}
	server.mu.RUnlock()
	if linked == nil {
		t.Fatal("the link's game should open once the author's game is over")
	}
	state := linked.game.Snapshot()
	if colorForUser(state, "alice") == game.Neutral || colorForUser(state, "bob") == game.Neutral {
		t.Fatal("the link's game is the author against the taker")
	}
}

// An open link lasts an hour, and says so to its author when it runs out.
func TestAnOpenLinkExpiresAfterAnHour(t *testing.T) {
	server := queueTestServer(false)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)
	code := putOutLink(t, server, alice, casualLinkSetup())

	server.sweepChallengeLinks(time.Now().Add(challengeLinkLifetime - time.Minute))
	if server.links.get(code) == nil {
		t.Fatal("a link should last its hour")
	}
	server.sweepChallengeLinks(time.Now().Add(challengeLinkLifetime + time.Second))

	closed := lastLink(t, drainChallengeTestMessages(t, alice))
	if closed.ChallengeLink.State != LinkClosed || closed.ChallengeLink.Code != code ||
		closed.Message != linkExpiredForAuthor {
		t.Fatalf("the author should be told their link expired: %#v", closed)
	}
	server.handleMessage(bob, ClientMessage{Type: "open_challenge_link", LinkCode: code})
	if late := lastLink(t, drainChallengeTestMessages(t, bob)); late.ChallengeLink.State != LinkClosed {
		t.Fatal("an expired link should lead nowhere")
	}
	if openBoards(server) != 0 {
		t.Fatal("an expired link must not start a game")
	}
}

// Leaving puts the link back out for what is left of its hour.
func TestATakerWhoLeavesPutsTheLinkBack(t *testing.T) {
	server := queueTestServer(false)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	cleo := challengeTestClient("cleo", "Cleo")
	server.hub.Register(alice)
	server.hub.Register(bob)
	server.hub.Register(cleo)
	code := putOutLink(t, server, alice, casualLinkSetup())
	server.handleMessage(alice, ClientMessage{Type: "queue_presence", Present: false})
	server.handleMessage(bob, ClientMessage{Type: "open_challenge_link", LinkCode: code})
	drainChallengeTestMessages(t, alice)
	drainChallengeTestMessages(t, bob)

	server.handleMessage(bob, ClientMessage{Type: "leave_challenge_link", LinkCode: code})

	if reopened := lastLink(t, drainChallengeTestMessages(t, alice)); reopened.ChallengeLink.State != LinkOpen {
		t.Fatalf("the author's link should be open again: %#v", reopened.ChallengeLink)
	}
	if left := lastLink(t, drainChallengeTestMessages(t, bob)); left.ChallengeLink.State != LinkOpen {
		t.Fatal("the person who left should hear that they are no longer waiting")
	}
	// Bob's page reconnecting asks to be kept told, and must not take the link
	// he has just left.
	server.handleMessage(bob, ClientMessage{Type: "watch_challenge_link", LinkCode: code})
	if watched := lastLink(t, drainChallengeTestMessages(t, bob)); watched.ChallengeLink.Taker != nil {
		t.Fatal("watching a link must never take it")
	}
	server.handleMessage(cleo, ClientMessage{Type: "open_challenge_link", LinkCode: code})
	if taken := lastLink(t, drainChallengeTestMessages(t, cleo)); taken.ChallengeLink.Taker == nil ||
		taken.ChallengeLink.Taker.UserID != "cleo" {
		t.Fatal("somebody else should be able to take the link back out")
	}
}

// Somebody who left a link and opens it again — a reload of the page they left
// on — is shown it, not put back in the wait. Pressing PLAY takes it.
func TestATakerWhoLeftIsNotPutBackByOpeningTheLinkAgain(t *testing.T) {
	server := queueTestServer(false)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)
	code := putOutLink(t, server, alice, casualLinkSetup())
	server.handleMessage(alice, ClientMessage{Type: "queue_presence", Present: false})
	server.handleMessage(bob, ClientMessage{Type: "open_challenge_link", LinkCode: code})
	server.handleMessage(bob, ClientMessage{Type: "leave_challenge_link", LinkCode: code})
	drainChallengeTestMessages(t, alice)
	drainChallengeTestMessages(t, bob)

	reloaded := challengeTestClient("bob", "Bob")
	server.hub.Register(reloaded)
	server.handleMessage(reloaded, ClientMessage{Type: "open_challenge_link", LinkCode: code})
	if shown := lastLink(t, drainChallengeTestMessages(t, reloaded)); shown.ChallengeLink.State != LinkOpen ||
		shown.ChallengeLink.Taker != nil {
		t.Fatalf("opening a link you left should show it, not take it: %#v", shown.ChallengeLink)
	}

	server.handleMessage(reloaded, ClientMessage{Type: "take_challenge_link", LinkCode: code})
	if taken := lastLink(t, drainChallengeTestMessages(t, reloaded)); taken.ChallengeLink.State != LinkWaiting ||
		taken.ChallengeLink.Taker == nil || taken.ChallengeLink.Taker.UserID != "bob" {
		t.Fatalf("pressing to take it should take it: %#v", taken.ChallengeLink)
	}
}

// The taker hears when the author's whereabouts change, even when somebody
// else was shown the new answer first.
func TestTheTakerHearsTheAuthorsNewStatusAfterSomebodyElseSawIt(t *testing.T) {
	server := queueTestServer(false)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	cleo := challengeTestClient("cleo", "Cleo")
	server.hub.Register(alice)
	server.hub.Register(bob)
	server.hub.Register(cleo)
	code := putOutLink(t, server, alice, casualLinkSetup())
	server.handleMessage(alice, ClientMessage{Type: "queue_presence", Present: false})
	server.handleMessage(bob, ClientMessage{Type: "open_challenge_link", LinkCode: code})
	if waiting := lastLink(t, drainChallengeTestMessages(t, bob)); waiting.ChallengeLink.AuthorStatus != linkAuthorIdle {
		t.Fatalf("the taker should first be told the author is idle: %#v", waiting.ChallengeLink)
	}

	server.disconnect(alice)
	server.handleMessage(cleo, ClientMessage{Type: "open_challenge_link", LinkCode: code})
	if shown := lastLink(t, drainChallengeTestMessages(t, cleo)); shown.ChallengeLink.AuthorStatus != linkAuthorAway {
		t.Fatalf("a latecomer should be shown the author as away: %#v", shown.ChallengeLink)
	}
	server.sweepChallengeLinks(time.Now())

	told := lastLink(t, drainChallengeTestMessages(t, bob))
	if told.ChallengeLink.AuthorStatus != linkAuthorAway {
		t.Fatalf("the taker should be told the author has gone: %#v", told.ChallengeLink)
	}
}

// A taker whose last tab closes keeps their place through a reload, and not
// for ever.
func TestATakerWhoDisconnectsIsLetGoAfterTheGrace(t *testing.T) {
	server := queueTestServer(false)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)
	code := putOutLink(t, server, alice, casualLinkSetup())
	server.handleMessage(alice, ClientMessage{Type: "queue_presence", Present: false})
	server.handleMessage(bob, ClientMessage{Type: "open_challenge_link", LinkCode: code})
	server.disconnect(bob)

	now := time.Now()
	server.sweepChallengeLinks(now)
	server.sweepChallengeLinks(now.Add(challengeLinkTakerGrace - time.Second))
	if server.links.takerID(server.links.get(code)) != "bob" {
		t.Fatal("a reload's worth of absence should not cost the taker their place")
	}
	server.sweepChallengeLinks(now.Add(challengeLinkTakerGrace + time.Second))
	if server.links.state(server.links.get(code)) != LinkOpen {
		t.Fatal("a taker who has gone should be let go, and the link put back out")
	}
}

// The author can take a link back with somebody waiting on it, and that person
// is told.
func TestCancellingALinkTellsWhoeverIsWaiting(t *testing.T) {
	server := queueTestServer(false)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)
	code := putOutLink(t, server, alice, casualLinkSetup())
	server.handleMessage(alice, ClientMessage{Type: "queue_presence", Present: false})
	server.handleMessage(bob, ClientMessage{Type: "open_challenge_link", LinkCode: code})
	drainChallengeTestMessages(t, bob)

	server.handleMessage(alice, ClientMessage{Type: "cancel_challenge_link", LinkCode: code})

	closed := lastLink(t, drainChallengeTestMessages(t, bob))
	if closed.ChallengeLink.State != LinkClosed || closed.Message == "" {
		t.Fatalf("the person waiting should be told why it ended: %#v", closed)
	}
	if own := lastLink(t, drainChallengeTestMessages(t, alice)); own.Message != "" {
		t.Fatalf("the author pressed cancel, and needs no notice saying so: %q", own.Message)
	}
	if server.links.get(code) != nil {
		t.Fatal("a cancelled link should be gone")
	}
	// Only the author's own cancel counts.
	drainChallengeTestMessages(t, alice)
	code = putOutLink(t, server, alice, casualLinkSetup())
	server.handleMessage(bob, ClientMessage{Type: "cancel_challenge_link", LinkCode: code})
	if server.links.get(code) == nil {
		t.Fatal("nobody but the author may cancel a link")
	}
}

// One link out at a time.
func TestOnlyOneLinkAtATime(t *testing.T) {
	server := queueTestServer(false)
	alice := challengeTestClient("alice", "Alice")
	server.hub.Register(alice)
	putOutLink(t, server, alice, casualLinkSetup())

	server.handleMessage(alice, ClientMessage{Type: "create_challenge_link", Setup: casualLinkSetup()})

	if _, found := messageOfType(drainChallengeTestMessages(t, alice), "challenge_rejected"); !found {
		t.Fatal("a second link should be refused while the first is out")
	}
	if links := server.challengeLinksFor("alice"); len(links) != 1 {
		t.Fatalf("expected one link for the reconnecting author, got %d", len(links))
	}
}

// A rated link is refused to a guest — the game belongs to its author — and
// the refusal arrives beside the link, where the page can offer a sign-in.
func TestARatedLinkAsksAGuestToSignIn(t *testing.T) {
	server := queueTestServer(false)
	alice := challengeTestClient("alice", "Alice")
	guest := challengeTestClient("guest-1", "Guest")
	guest.account.Registered = false
	server.hub.Register(alice)
	server.hub.Register(guest)
	code := putOutLink(t, server, alice, &game.GameSetup{ModeID: game.ModeTotalWar})

	server.handleMessage(guest, ClientMessage{Type: "open_challenge_link", LinkCode: code})

	refused := lastLink(t, drainChallengeTestMessages(t, guest))
	if refused.ChallengeLink.State != LinkOpen || refused.Message == "" {
		t.Fatalf("a guest should be told why, with the link still open: %#v", refused)
	}
	if server.links.takerID(server.links.get(code)) != "" || openBoards(server) != 0 {
		t.Fatal("a refused guest must not take the link")
	}
}

// Taking a link ends whatever its taker was searching for, so the queue cannot
// seat them with somebody else while they wait.
func TestTakingALinkStopsTheTakersSearch(t *testing.T) {
	server := queueTestServer(false)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)
	code := putOutLink(t, server, alice, casualLinkSetup())
	server.handleMessage(alice, ClientMessage{Type: "queue_presence", Present: false})
	queueUp(t, server, bob, game.ModeTotalWar)

	server.handleMessage(bob, ClientMessage{Type: "open_challenge_link", LinkCode: code})

	if server.seeks.ForClient(bob) != nil {
		t.Fatal("the taker's search should be over")
	}
}

// A game nobody plays a move in is called off, and the link that led to it
// goes with it rather than pointing at a board that never was.
func TestALinkWhoseGameIsCalledOffCloses(t *testing.T) {
	server := queueTestServer(false)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)
	code := putOutLink(t, server, alice, casualLinkSetup())
	server.handleMessage(bob, ClientMessage{Type: "open_challenge_link", LinkCode: code})
	drainChallengeTestMessages(t, bob)

	server.expireUnstartedGames(time.Now().Add(firstMoveWindow + time.Second))

	if server.links.get(code) != nil {
		t.Fatal("the link should close with its game")
	}
	if closed := lastLink(t, drainChallengeTestMessages(t, bob)); closed.ChallengeLink.State != LinkClosed {
		t.Fatal("the taker should hear the link is closed")
	}
}

// A link that became a game goes on naming it for an hour after it ends.
func TestAFinishedLinkIsForgottenAfterItsRetention(t *testing.T) {
	server := queueTestServer(false)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)
	code := putOutLink(t, server, alice, casualLinkSetup())
	server.handleMessage(bob, ClientMessage{Type: "open_challenge_link", LinkCode: code})
	server.resign(bob)
	if openBoards(server) != 0 {
		t.Fatal("test setup: the resigned game should be over")
	}

	now := time.Now()
	server.sweepChallengeLinks(now)
	if server.links.get(code) == nil {
		t.Fatal("a finished game's link should still lead to it for a while")
	}
	server.sweepChallengeLinks(now.Add(challengeLinkRetention + time.Second))
	if server.links.get(code) != nil {
		t.Fatal("a link should be forgotten once its game is long over")
	}
}

// Nothing new starts while the server is draining for an update.
func TestNoLinkIsMadeOrStartedDuringADrain(t *testing.T) {
	server := queueTestServer(false)
	alice := challengeTestClient("alice", "Alice")
	bob := challengeTestClient("bob", "Bob")
	server.hub.Register(alice)
	server.hub.Register(bob)
	code := putOutLink(t, server, alice, casualLinkSetup())
	server.handleMessage(alice, ClientMessage{Type: "queue_presence", Present: false})
	server.handleMessage(bob, ClientMessage{Type: "open_challenge_link", LinkCode: code})
	server.BeginUpdateDrain("")

	server.handleMessage(alice, ClientMessage{Type: "queue_presence", Present: true})
	server.sweepChallengeLinks(time.Now())
	if openBoards(server) != 0 {
		t.Fatal("a drain must not open a link's game")
	}
	if server.links.state(server.links.get(code)) != LinkWaiting {
		t.Fatal("the taker should go on waiting through the drain")
	}

	server.handleMessage(alice, ClientMessage{Type: "cancel_challenge_link", LinkCode: code})
	drainChallengeTestMessages(t, alice)
	server.handleMessage(alice, ClientMessage{Type: "create_challenge_link", Setup: casualLinkSetup()})
	if _, found := messageOfType(drainChallengeTestMessages(t, alice), "challenge_rejected"); !found {
		t.Fatal("a link made during a drain is a game that could never start")
	}
}
