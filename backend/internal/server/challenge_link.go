package server

import (
	"context"
	"crypto/rand"
	"math/big"
	"strings"
	"sync"
	"time"

	"rps-strategy/backend/internal/game"
)

// Challenge links: a game offered to whoever opens an address.
//
// A posted game waits on the lobby's board and a named challenge waits in one
// person's inbox, and both need the other player to be here already. A link is
// for the friend who is not. Its author sends the address wherever they talk,
// and whoever opens it is taken straight into the game. Everybody who opens it
// after that is shown the game rather than refused, so one address works for a
// whole group chat.
//
// It is deliberately not a Seek. A seek is "this person is waiting for a game",
// one per person, and the queue, the public board and pairing are all built on
// that. A link is an hour-long invitation whose author may well walk away — to
// play somebody else in the meantime, or to put the phone down — so having one
// out must not stop them doing anything else, and nothing about it may pair
// with the queue.
//
// Its life:
//
//   - open: nobody has taken it. It expires after challengeLinkLifetime.
//   - waiting: somebody took it while the author could not play. The author is
//     told, and the taker waits in the lobby for as long as they like: no
//     expiry runs while somebody is waiting.
//   - started: the game opened. From then on the link names that game, so the
//     people it was sent to can watch it.
//
// The game opens the moment both people can play: the author at the screen and
// in no other game, the taker connected and in no other game. That is asked
// when the link is taken, when either of them reports coming back to the
// screen, and on every lobby tick — which is what notices an author arriving
// from a notification.
//
// Lock ordering: the board's lock is never held across a call into Server, for
// the reason match_start.go gives about seekBoard.

const (
	// challengeLinkLifetime is how long a link waits for somebody to open it.
	challengeLinkLifetime = time.Hour
	// challengeLinkTakerGrace is how long somebody waiting on a link keeps
	// their place with nothing connected: a reload, a phone changing networks.
	// The same promise as a seat in a game, so the same number.
	challengeLinkTakerGrace = reconnectGracePeriod
	// challengeLinkRetention is how long a link that became a game goes on
	// answering after the game is over, so a late click lands on the record
	// of the game rather than on "expired".
	challengeLinkRetention = time.Hour
	// freshSocketGrace is how long a socket that has said nothing about itself
	// is given to say so before a link counts it as somebody who is not
	// looking.
	//
	// A tab reports where its person is as soon as it connects, but the lobby
	// tick can land first. Until the report arrives the author is neither
	// seated nor called: seated, a phone whose socket came back in somebody's
	// pocket opened a game nobody would see; called, an author already
	// looking at the screen got a notification about it.
	freshSocketGrace = 3 * time.Second
	// challengeLinkCodeLength is how long a code is. Ten characters from an
	// alphabet of 56 is about 58 bits: plenty for an address that lives an
	// hour, and short enough not to wrap in a chat window.
	challengeLinkCodeLength = 10
	// challengeLinkAlphabet leaves out what people misread: 0, O and o, 1, l
	// and I.
	challengeLinkAlphabet = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ"
)

// What a waiting taker is told about the author, in ChallengeLink.AuthorStatus.
const (
	linkAuthorHere = "here"
	linkAuthorBusy = "busy"
	linkAuthorIdle = "idle"
	linkAuthorAway = "away"
)

// challengeLink is one address and the game behind it.
type challengeLink struct {
	Code      string
	Author    game.PlayerProfile
	Setup     game.GameSetup
	ModeName  string
	CreatedAt time.Time
	// ExpiresAt bounds the link only while it is open.
	ExpiresAt time.Time

	// Everything above is written once. Everything below changes while the
	// link is out and is read and written only under the board's lock.
	taker *linkTaker
	// gameID is the game the link became. starting is set while that game is
	// being made, so two paths that both find the link ready cannot open two
	// boards for it.
	gameID   string
	starting bool
	// endedAt is when the game stopped being live, which starts the
	// retention clock.
	endedAt time.Time
	// watchers are the sockets that opened the link: whoever it was sent to,
	// looking at it now.
	watchers map[*Client]struct{}
	// shownStatus is the author status a waiting taker was last sent, so a
	// change is published and an unchanged one is not.
	shownStatus string
	// leftBy is everybody who took the link and then pressed to leave it.
	// Opening it again shows them the link rather than putting them back in
	// the wait: a reload of the page they left on is not a second yes. Taking
	// it again is a press of its own (take_challenge_link).
	leftBy map[string]struct{}
}

// linkTaker is whoever took a link.
type linkTaker struct {
	profile    game.PlayerProfile
	acceptedAt time.Time
	// goneSince is when the taker was first found with nothing connected,
	// zero while they are connected.
	goneSince time.Time
	// callTried is whether the author has been sent word of this taker, and
	// called whether that word had anywhere to go.
	callTried bool
	called    bool
}

func (link *challengeLink) stateLocked() ChallengeLinkState {
	switch {
	case link.gameID != "":
		return LinkStarted
	case link.taker != nil:
		return LinkWaiting
	default:
		return LinkOpen
	}
}

// linkBoard holds every link that is out, by code.
type linkBoard struct {
	mu     sync.Mutex
	byCode map[string]*challengeLink
}

func newLinkBoard() *linkBoard {
	return &linkBoard{byCode: make(map[string]*challengeLink)}
}

// add puts a link out, unless its author already has one out that has not
// become a game. One at a time, so the lobby can show "your link" rather than
// a list of them, and so a forgotten link is replaced by asking rather than
// piling up behind a new one.
func (board *linkBoard) add(link *challengeLink) bool {
	board.mu.Lock()
	defer board.mu.Unlock()
	for _, existing := range board.byCode {
		if existing.Author.UserID == link.Author.UserID && existing.gameID == "" {
			return false
		}
	}
	board.byCode[link.Code] = link
	return true
}

func (board *linkBoard) get(code string) *challengeLink {
	board.mu.Lock()
	defer board.mu.Unlock()
	return board.byCode[code]
}

func (board *linkBoard) all() []*challengeLink {
	board.mu.Lock()
	defer board.mu.Unlock()
	links := make([]*challengeLink, 0, len(board.byCode))
	for _, link := range board.byCode {
		links = append(links, link)
	}
	return links
}

// involving is every link this account is part of that has not become a game:
// the one it sent out, and the one it is waiting on.
func (board *linkBoard) involving(userID string) []*challengeLink {
	if userID == "" {
		return nil
	}
	board.mu.Lock()
	defer board.mu.Unlock()
	links := make([]*challengeLink, 0, 2)
	for _, link := range board.byCode {
		if link.gameID != "" {
			continue
		}
		if link.Author.UserID == userID ||
			(link.taker != nil && link.taker.profile.UserID == userID) {
			links = append(links, link)
		}
	}
	return links
}

// waitingOnFor is the link this account has taken and is still waiting on.
func (board *linkBoard) waitingOnFor(userID string) *challengeLink {
	board.mu.Lock()
	defer board.mu.Unlock()
	for _, link := range board.byCode {
		if link.gameID == "" && link.taker != nil && link.taker.profile.UserID == userID {
			return link
		}
	}
	return nil
}

func (board *linkBoard) forGame(gameID string) *challengeLink {
	if gameID == "" {
		return nil
	}
	board.mu.Lock()
	defer board.mu.Unlock()
	for _, link := range board.byCode {
		if link.gameID == gameID {
			return link
		}
	}
	return nil
}

func (board *linkBoard) state(link *challengeLink) ChallengeLinkState {
	board.mu.Lock()
	defer board.mu.Unlock()
	return link.stateLocked()
}

func (board *linkBoard) gameOf(link *challengeLink) string {
	board.mu.Lock()
	defer board.mu.Unlock()
	return link.gameID
}

// takerID is who took the link, or "" when nobody has.
func (board *linkBoard) takerID(link *challengeLink) string {
	board.mu.Lock()
	defer board.mu.Unlock()
	if link.taker == nil {
		return ""
	}
	return link.taker.profile.UserID
}

// readyTaker is the taker of a link that is waiting and not already being
// started, which is the only kind there is any point trying to start.
func (board *linkBoard) readyTaker(link *challengeLink) (linkTaker, bool) {
	board.mu.Lock()
	defer board.mu.Unlock()
	if link.taker == nil || link.gameID != "" || link.starting {
		return linkTaker{}, false
	}
	return *link.taker, true
}

func (board *linkBoard) watch(link *challengeLink, client *Client) {
	board.mu.Lock()
	defer board.mu.Unlock()
	if board.byCode[link.Code] != link {
		return
	}
	link.watchers[client] = struct{}{}
}

// unwatch forgets a socket everywhere it was looking, which is what a socket
// closing does.
func (board *linkBoard) unwatch(client *Client) {
	board.mu.Lock()
	defer board.mu.Unlock()
	for _, link := range board.byCode {
		delete(link.watchers, client)
	}
}

func (board *linkBoard) watchersOf(link *challengeLink) []*Client {
	board.mu.Lock()
	defer board.mu.Unlock()
	watchers := make([]*Client, 0, len(link.watchers))
	for client := range link.watchers {
		watchers = append(watchers, client)
	}
	return watchers
}

// claim makes somebody the taker of a link, if it is still open. Taking it is
// the claim: two people can both pass every check before this, and only the
// one it answers true for gets the game.
func (board *linkBoard) claim(link *challengeLink, taker game.PlayerProfile, now time.Time) bool {
	board.mu.Lock()
	defer board.mu.Unlock()
	if board.byCode[link.Code] != link || link.stateLocked() != LinkOpen || !now.Before(link.ExpiresAt) {
		return false
	}
	link.taker = &linkTaker{profile: taker, acceptedAt: now}
	return true
}

// release takes the taker off a waiting link. It goes back to being open if it
// has time left, and otherwise reports that it has expired, leaving the caller
// to close it. Refused while the game is being made: by then it is too late to
// walk away from anything but the board.
func (board *linkBoard) release(link *challengeLink, takerID string, now time.Time) (released, expired bool) {
	board.mu.Lock()
	defer board.mu.Unlock()
	if link.taker == nil || link.taker.profile.UserID != takerID || link.gameID != "" || link.starting {
		return false, false
	}
	link.taker = nil
	link.shownStatus = ""
	return true, !now.Before(link.ExpiresAt)
}

// markLeft records that somebody walked away from a link they had taken. See
// challengeLink.leftBy.
func (board *linkBoard) markLeft(link *challengeLink, userID string) {
	board.mu.Lock()
	defer board.mu.Unlock()
	if link.leftBy == nil {
		link.leftBy = make(map[string]struct{})
	}
	link.leftBy[userID] = struct{}{}
}

// hasLeft reports whether somebody took this link once and left it.
func (board *linkBoard) hasLeft(link *challengeLink, userID string) bool {
	board.mu.Lock()
	defer board.mu.Unlock()
	_, left := link.leftBy[userID]
	return left
}

// beginStart claims the right to open the link's game.
func (board *linkBoard) beginStart(link *challengeLink) bool {
	board.mu.Lock()
	defer board.mu.Unlock()
	if board.byCode[link.Code] != link || link.taker == nil || link.gameID != "" || link.starting {
		return false
	}
	link.starting = true
	return true
}

func (board *linkBoard) finishStart(link *challengeLink, gameID string) {
	board.mu.Lock()
	defer board.mu.Unlock()
	link.starting = false
	link.gameID = gameID
}

func (board *linkBoard) abortStart(link *challengeLink) {
	board.mu.Lock()
	defer board.mu.Unlock()
	link.starting = false
}

// remove takes a link off the board and hands back who was looking at it and
// who had taken it, for the caller to tell. outstandingOnly refuses a link that
// has become a game, or is becoming one, which is what cancelling needs.
func (board *linkBoard) remove(link *challengeLink, outstandingOnly bool) (watchers []*Client, takerID string, removed bool) {
	board.mu.Lock()
	defer board.mu.Unlock()
	if board.byCode[link.Code] != link {
		return nil, "", false
	}
	if outstandingOnly && (link.gameID != "" || link.starting) {
		return nil, "", false
	}
	delete(board.byCode, link.Code)
	for client := range link.watchers {
		watchers = append(watchers, client)
	}
	link.watchers = map[*Client]struct{}{}
	if link.taker != nil {
		takerID = link.taker.profile.UserID
	}
	return watchers, takerID, true
}

// takerAbsentFor is how long the taker has had nothing connected, starting the
// clock the first time it is asked. connected stops it.
func (board *linkBoard) takerAbsentFor(link *challengeLink, connected bool, now time.Time) time.Duration {
	board.mu.Lock()
	defer board.mu.Unlock()
	if link.taker == nil {
		return 0
	}
	if connected {
		link.taker.goneSince = time.Time{}
		return 0
	}
	if link.taker.goneSince.IsZero() {
		link.taker.goneSince = now
	}
	return now.Sub(link.taker.goneSince)
}

// endedFor is how long the game a link became has been over, starting the
// clock the first time it is asked.
func (board *linkBoard) endedFor(link *challengeLink, now time.Time) time.Duration {
	board.mu.Lock()
	defer board.mu.Unlock()
	if link.endedAt.IsZero() {
		link.endedAt = now
	}
	return now.Sub(link.endedAt)
}

// beginCall claims the one notification a taker is worth sending. It answers
// false once it has been tried, whatever came of it.
func (board *linkBoard) beginCall(link *challengeLink) (linkTaker, bool) {
	board.mu.Lock()
	defer board.mu.Unlock()
	if link.taker == nil || link.gameID != "" || link.taker.callTried {
		return linkTaker{}, false
	}
	link.taker.callTried = true
	return *link.taker, true
}

func (board *linkBoard) setCalled(link *challengeLink, takerID string, called bool) {
	board.mu.Lock()
	defer board.mu.Unlock()
	if link.taker != nil && link.taker.profile.UserID == takerID {
		link.taker.called = called
	}
}

// noteStatus records the author status the people waiting were just shown,
// and reports whether it is news.
func (board *linkBoard) noteStatus(link *challengeLink, status string) bool {
	board.mu.Lock()
	defer board.mu.Unlock()
	if link.shownStatus == status {
		return false
	}
	link.shownStatus = status
	return true
}

// wire is the link as it is sent, less the author's status, which the board
// cannot know.
func (board *linkBoard) wire(link *challengeLink) ChallengeLink {
	board.mu.Lock()
	defer board.mu.Unlock()
	author, setup := link.Author, link.Setup
	wire := ChallengeLink{
		Code:            link.Code,
		Challenger:      &author,
		ModeName:        link.ModeName,
		Setup:           &setup,
		State:           link.stateLocked(),
		GameID:          link.gameID,
		CreatedAtUnixMs: link.CreatedAt.UnixMilli(),
	}
	if link.taker != nil {
		taker := link.taker.profile
		wire.Taker = &taker
		wire.AuthorCalled = link.taker.called
	}
	if wire.State == LinkOpen {
		wire.ExpiresAtUnixMs = link.ExpiresAt.UnixMilli()
	}
	return wire
}

// newChallengeLinkCode is a fresh, unguessable code.
func newChallengeLinkCode() (string, error) {
	code := make([]byte, challengeLinkCodeLength)
	limit := big.NewInt(int64(len(challengeLinkAlphabet)))
	for index := range code {
		pick, err := rand.Int(rand.Reader, limit)
		if err != nil {
			return "", err
		}
		code[index] = challengeLinkAlphabet[pick.Int64()]
	}
	return string(code), nil
}

// readyToBeSeated is whether a tab counts as somebody at the screen for the
// purpose of opening a board in front of them: it has said so.
//
// The difference from isHere is a socket that has said nothing, which isHere
// reads as here because a seek is made by the tab that was just pressed. A
// link's author can have tabs that never touched it — a second window, or a
// page still running a build from before links, which never reports at all —
// and a board opened on one of those in the background is a game nobody sees.
// A tab that knows about the link reports as soon as it does (see
// useQueuePresence), so waiting for its word costs nothing.
func (client *Client) readyToBeSeated() bool {
	client.presenceMu.Lock()
	defer client.presenceMu.Unlock()
	return client.presence == PresenceHere
}

// awaitingPresence is a socket that has said nothing yet and has only just
// connected, so its report is on the way — see freshSocketGrace.
func (client *Client) awaitingPresence(now time.Time) bool {
	client.presenceMu.Lock()
	defer client.presenceMu.Unlock()
	return client.presence == "" && now.Sub(client.connectedAt) < freshSocketGrace
}

// createChallengeLink puts out a link to the game a client wrote out.
//
// Refused in the same words and for the same reasons a posted game is: it is
// one, offered by address instead of on the board.
func (server *Server) createChallengeLink(client *Client, requested game.GameSetup) {
	refuse := func(message string) {
		client.Send(ServerMessage{Type: "challenge_rejected", Message: message})
	}
	if server.isUpdating() {
		refuse(server.updateRefusalMessage())
		return
	}
	if refusal := server.muteRefusal(client, "send challenges"); refusal != "" {
		refuse(refusal)
		return
	}
	// A link is followed back to its author by account, across every socket
	// they open, so it needs one. Every browser has one, guest or not; this is
	// an engine, or a test client built without one.
	if client.isBot() || strings.TrimSpace(client.profile.UserID) == "" {
		refuse("reconnect before making a challenge link")
		return
	}
	if !server.registry.Has(requested.ModeID) {
		refuse("invalid game mode")
		return
	}
	if !server.registry.Playable(requested.ModeID) {
		refuse("that game mode is no longer open for new matches")
		return
	}
	mode, err := server.registry.New(requested.ModeID)
	if err != nil {
		refuse("invalid game mode")
		return
	}
	definition := mode.Definition()
	setup := requested.Normalize(definition)
	if err := setup.ValidateForMode(mode); err != nil {
		refuse(err.Error())
		return
	}
	// Downgraded rather than refused, for the reason postSeek gives.
	downgraded := setup.Ranked() && !server.rankedAllowed(client)
	if downgraded {
		setup.Casual = true
	}
	code, err := newChallengeLinkCode()
	if err != nil {
		refuse("could not make the link")
		return
	}
	now := time.Now()
	link := &challengeLink{
		Code:      code,
		Author:    client.profile,
		Setup:     setup,
		ModeName:  definition.Name,
		CreatedAt: now,
		ExpiresAt: now.Add(challengeLinkLifetime),
		watchers:  make(map[*Client]struct{}),
	}
	if !server.links.add(link) {
		refuse("you already have a challenge link out; cancel it to make another")
		return
	}
	server.publishChallengeLink(link)
	if downgraded {
		client.Send(ServerMessage{Type: "ranked_unavailable", Message: server.rankedRefusal(client)})
	}
}

// openChallengeLink is somebody following a link. What it does depends on who
// they are and where the link has got to: its author is shown their own link,
// anybody else takes it if it is still open, and everybody after that is shown
// the game it became. Somebody who took it once and left is only shown it.
func (server *Server) openChallengeLink(client *Client, code string) {
	server.followChallengeLink(client, code, false)
}

// retakeChallengeLink is the link's page asking to take it outright: its PLAY
// button, pressed after a refusal or after leaving. The same as following the
// link, except that having left it before does not stop it.
func (server *Server) retakeChallengeLink(client *Client, code string) {
	server.followChallengeLink(client, code, true)
}

func (server *Server) followChallengeLink(client *Client, code string, pressed bool) {
	code = strings.TrimSpace(code)
	link := server.links.get(code)
	if link == nil {
		client.Send(closedChallengeLink(code, linkExpired))
		return
	}
	// An open link past its hour that the sweep has not reached yet is closed
	// here rather than taken: an address that works for a minute longer than
	// it says it will is one nobody can rely on.
	if server.links.state(link) == LinkOpen && !time.Now().Before(link.ExpiresAt) {
		server.closeChallengeLink(link, linkExpiredForAuthor, linkExpired)
		client.Send(closedChallengeLink(code, linkExpired))
		return
	}
	server.links.watch(link, client)
	if client.isBot() || client.profile.UserID == link.Author.UserID ||
		server.links.state(link) != LinkOpen ||
		(!pressed && server.links.hasLeft(link, client.profile.UserID)) {
		server.sendChallengeLinkTo(client, link, "")
		return
	}
	server.takeChallengeLink(client, link)
}

// watchChallengeLink is a page that already has a link open asking to go on
// being told about it — after a reconnection, when its old socket's place
// among the watchers went with the socket. It never takes the link: somebody
// who just left the wait would otherwise be put straight back in it by their
// own reconnect.
func (server *Server) watchChallengeLink(client *Client, code string) {
	code = strings.TrimSpace(code)
	link := server.links.get(code)
	if link == nil {
		client.Send(closedChallengeLink(code, linkExpired))
		return
	}
	server.links.watch(link, client)
	server.sendChallengeLinkTo(client, link, "")
}

// takeChallengeLink makes a client the other player of an open link.
//
// Refusals are sent as the link with a reason beside it, rather than as an
// error, because the person reading them is on the link's own page and the
// reason belongs there: "sign in to accept it" next to the game it is about.
func (server *Server) takeChallengeLink(client *Client, link *challengeLink) {
	refuse := func(message string) { server.sendChallengeLinkTo(client, link, message) }
	userID := client.profile.UserID
	switch {
	case server.isUpdating():
		refuse(server.updateRefusalMessage())
		return
	case userID == "":
		refuse("reload the page to take this challenge")
		return
	case server.blockedBetween(userID, link.Author.UserID):
		refuse("you cannot play this player")
		return
	// Refused rather than downgraded, as acceptChallenge refuses it: the game
	// belongs to its author, who may not even be here to be told it changed.
	case link.Setup.Ranked() && !server.rankedAllowed(client):
		refuse(server.rankedAcceptRefusal(client))
		return
	case server.liveGameFor(userID) != "":
		refuse("finish your current game first")
		return
	}
	if waiting := server.links.waitingOnFor(userID); waiting != nil && waiting != link {
		refuse("you are already waiting on another challenge; leave it to take this one")
		return
	}
	if !server.links.claim(link, client.profile, time.Now()) {
		// Somebody else got there first, which makes this person somebody who
		// was sent the link: shown it, and the game it becomes.
		server.sendChallengeLinkTo(client, link, "")
		return
	}
	// Whatever the taker was waiting behind in the lobby is over. They have a
	// game now, or are waiting for one, and either way a search left running
	// could pair them with somebody else in the meantime.
	if seek := server.seeks.RemoveClient(client); seek != nil {
		reason := "The challenge was cancelled."
		if seek.Queued {
			reason = "The search was stopped."
		}
		server.withdrawSeek(seek, "", reason)
	}
	if server.tryStartChallengeLink(link) {
		return
	}
	server.callChallengeLinkAuthor(link)
	server.publishChallengeLink(link)
}

// cancelChallengeLink is the author taking their link back, whether or not
// somebody is waiting on it. A link that has become a game is a game, and is
// resigned or aborted like one.
func (server *Server) cancelChallengeLink(client *Client, code string) {
	code = strings.TrimSpace(code)
	link := server.links.get(code)
	if link == nil || link.Author.UserID != client.profile.UserID {
		client.Send(closedChallengeLink(code, ""))
		return
	}
	watchers, takerID, removed := server.links.remove(link, true)
	if !removed {
		server.sendChallengeLinkTo(client, link, "that game has already started")
		return
	}
	// Silent for the author, who pressed it: a notice saying so would only
	// report the press back. Everybody else hears why.
	server.announceClosedChallengeLink(link, watchers, takerID, "", "The challenge was cancelled.")
}

// leaveChallengeLink is the taker giving up waiting. The link goes back to
// being open for whatever is left of its hour, so the author's address still
// works for somebody else; with nothing left, it closes.
func (server *Server) leaveChallengeLink(client *Client, code string) {
	code = strings.TrimSpace(code)
	link := server.links.get(code)
	if link == nil {
		client.Send(closedChallengeLink(code, ""))
		return
	}
	// Marked before the release is published, so the page that hears it, and
	// any reload of that page, finds the link one this person has left.
	userID := client.profile.UserID
	if server.links.takerID(link) == userID && userID != "" {
		server.links.markLeft(link, userID)
	}
	server.releaseChallengeLinkTaker(link, userID, time.Now())
}

// releaseChallengeLinkTaker takes the taker off a link and tells everybody.
// The person released hears it too, wherever they are, so their lobby stops
// showing a wait that is over.
func (server *Server) releaseChallengeLinkTaker(link *challengeLink, takerID string, now time.Time) {
	released, expired := server.links.release(link, takerID, now)
	if !released {
		return
	}
	if expired {
		server.closeChallengeLink(link, linkExpiredForAuthor, linkExpired, takerID)
		return
	}
	server.publishChallengeLink(link, takerID)
}

// tryStartChallengeLink opens the game behind a taken link if both people can
// play it now, and reports whether it did.
func (server *Server) tryStartChallengeLink(link *challengeLink) bool {
	// No new games during a drain. The link keeps waiting, and the restart
	// takes it — the board is in memory, like every other wait in the lobby.
	if server.isUpdating() {
		return false
	}
	taker, waiting := server.links.readyTaker(link)
	if !waiting {
		return false
	}
	now := time.Now()
	authorClient := server.challengeLinkSeat(link.Author.UserID, true, now)
	takerClient := server.challengeLinkSeat(taker.profile.UserID, false, now)
	if authorClient == nil || takerClient == nil {
		return false
	}
	if !server.links.beginStart(link) {
		return false
	}
	session := server.seatChallengeLink(link, taker, authorClient, takerClient)
	if session == nil {
		server.links.abortStart(link)
		return false
	}
	server.links.finishStart(link, session.gameID)
	server.publishChallengeLink(link)
	return true
}

// challengeLinkSeat is a socket of userID's that could sit down to a link's
// game right now, or nil.
//
// mustBeHere is the author's half of the rule. A board opens for the author
// only while they are looking at the screen, because they are the one who
// walked away; the taker asked for this game a moment ago, or is waiting for
// it, and is summoned like any other player if they have wandered off.
func (server *Server) challengeLinkSeat(userID string, mustBeHere bool, now time.Time) *Client {
	if userID == "" || server.liveGameFor(userID) != "" {
		return nil
	}
	var fallback *Client
	for _, client := range server.connectedClients() {
		if client.isBot() || client.profile.UserID != userID {
			continue
		}
		if client.readyToBeSeated() {
			return client
		}
		if fallback == nil {
			fallback = client
		}
	}
	if mustBeHere {
		return nil
	}
	return fallback
}

// seatChallengeLink opens a link's game for its two players.
//
// Seated the way an accepted challenge is: the author's seat preference is
// honoured, and with none they get the side that moves first. The game takes
// the first-move escrow too, so a board somebody never plays in is called off
// rather than rated — and neither side goes back in any queue, because neither
// asked to be in one.
func (server *Server) seatChallengeLink(link *challengeLink, taker linkTaker, authorClient, takerClient *Client) *GameSession {
	authorSeek := &Seek{
		ID:       "link:" + link.Code,
		Owner:    seekOwnerKey(authorClient),
		Poster:   authorClient.profile,
		Setup:    link.Setup,
		ModeName: link.ModeName,
		Elo:      seatElo(authorClient, link.Setup.ModeID),
		JoinedAt: link.CreatedAt,
	}
	authorSeek.bind(authorClient)
	takerSeek := &Seek{
		ID:       "link:" + link.Code + ":taker",
		Owner:    seekOwnerKey(takerClient),
		Poster:   takerClient.profile,
		Setup:    link.Setup,
		ModeName: link.ModeName,
		Elo:      seatElo(takerClient, link.Setup.ModeID),
		JoinedAt: taker.acceptedAt,
	}
	takerSeek.bind(takerClient)
	// A taker who has waited long enough to wander off is sent the same
	// "your game has started" anybody away from their board is.
	if !takerClient.isHere() {
		takerSeek.setPresence(takerClient, PresenceIdle)
	}
	// Out of whatever else they were doing first. seatMatch does this too, but
	// only after choosing the socket to seat, and a socket that is watching a
	// board is one it will not choose.
	server.releaseFromLobby(authorClient)
	server.releaseFromLobby(takerClient)

	authorSeat := &startSeat{seek: authorSeek}
	takerSeat := &startSeat{seek: takerSeek}
	opener, replier := authorSeat, takerSeat
	if link.Setup.PreferredColor == game.OtherColor(game.FirstToMove) {
		opener, replier = takerSeat, authorSeat
	}
	return server.seatMatch(seatColors(opener, replier))
}

// challengeLinkAuthorStatus is where a link's author is, in the words the
// person waiting on it is shown.
//
// A socket whose report is still on its way counts as here: the game opens or
// the author goes idle within a few seconds, and calling them in that gap would
// be calling somebody who may be looking straight at the screen.
func (server *Server) challengeLinkAuthorStatus(userID string, now time.Time) string {
	connected, here := false, false
	for _, client := range server.connectedClients() {
		if client.isBot() || client.profile.UserID != userID {
			continue
		}
		connected = true
		if client.readyToBeSeated() || client.awaitingPresence(now) {
			here = true
		}
	}
	switch {
	case !connected:
		return linkAuthorAway
	case server.liveGameFor(userID) != "":
		return linkAuthorBusy
	case !here:
		return linkAuthorIdle
	}
	return linkAuthorHere
}

// callChallengeLinkAuthor tells a link's author that somebody took it and is
// waiting — once per taker, and only when it would reach somebody who is not
// already looking. An author at the screen has the board opened in front of
// them instead, and one in another game has it opened when that game is over;
// neither wants a notification on top of the game they are playing.
func (server *Server) callChallengeLinkAuthor(link *challengeLink) {
	status := server.challengeLinkAuthorStatus(link.Author.UserID, time.Now())
	if status != linkAuthorIdle && status != linkAuthorAway {
		return
	}
	taker, ok := server.links.beginCall(link)
	if !ok {
		return
	}
	// Asked rather than assumed, so the person waiting is told the truth about
	// whether anybody is coming: an author with alerts off will only find out
	// by opening the app.
	reachable := server.push.Reachable(context.Background(), link.Author.UserID)
	server.links.setCalled(link, taker.profile.UserID, reachable)
	if !reachable {
		return
	}
	name := strings.TrimSpace(taker.profile.Username)
	if name == "" {
		name = "Someone"
	}
	go server.push.Send(link.Author.UserID, pushPayload{
		Kind:  "challenge_accepted",
		Title: "Challenge accepted",
		Body:  name + " took your challenge link and is waiting to play",
		Tag:   "rps-match",
		// As long as a link lasts. The taker waits for as long as they like,
		// so this stays worth reading for longer than a summons does.
		TTL: challengeLinkLifetime,
	})
}

// challengeLinkPresenceChanged is a tab saying its person came or went. For
// the author of a waiting link, coming back is when the game opens; going is
// when the taker is told so, and when the author is called.
func (server *Server) challengeLinkPresenceChanged(client *Client) {
	for _, link := range server.links.involving(client.profile.UserID) {
		if server.links.state(link) != LinkWaiting {
			continue
		}
		if server.tryStartChallengeLink(link) {
			continue
		}
		server.callChallengeLinkAuthor(link)
		server.publishChallengeLinkIfStatusChanged(link)
	}
}

// sweepChallengeLinks is the lobby tick's pass over every link: expire the
// open ones that ran out, let go of takers who have gone, start the games that
// can start, and forget the links whose games are long over.
func (server *Server) sweepChallengeLinks(now time.Time) {
	for _, link := range server.links.all() {
		switch server.links.state(link) {
		case LinkOpen:
			if !now.Before(link.ExpiresAt) {
				server.closeChallengeLink(link, linkExpiredForAuthor, linkExpired)
			}
		case LinkWaiting:
			takerID := server.links.takerID(link)
			absent := server.links.takerAbsentFor(link, server.userConnected(takerID), now)
			if absent >= challengeLinkTakerGrace {
				server.releaseChallengeLinkTaker(link, takerID, now)
				continue
			}
			if server.tryStartChallengeLink(link) {
				continue
			}
			// An author who was busy when the link was taken may have gone
			// since, and is called now rather than never.
			server.callChallengeLinkAuthor(link)
			server.publishChallengeLinkIfStatusChanged(link)
		case LinkStarted:
			if server.gameIsLive(server.links.gameOf(link)) {
				continue
			}
			if server.links.endedFor(link, now) >= challengeLinkRetention {
				// Nobody to tell: the game ended an hour ago.
				server.links.remove(link, false)
			}
		}
	}
}

// What an expiring link says, to its author and to everybody else.
const (
	linkExpiredForAuthor = "Your challenge link expired."
	linkExpired          = "This challenge link has expired."
)

// closeChallengeLink takes a link off the board and tells everybody concerned
// why: its author in their own words, everybody else in reason. extraUserIDs
// are people who were part of it a moment ago and are not any more — a taker
// just let go — who need to hear it too.
func (server *Server) closeChallengeLink(
	link *challengeLink,
	authorReason string,
	reason string,
	extraUserIDs ...string,
) {
	watchers, takerID, removed := server.links.remove(link, false)
	if !removed {
		return
	}
	server.announceClosedChallengeLink(link, watchers, takerID, authorReason, reason, extraUserIDs...)
}

// closeChallengeLinkForGame closes the link a game came from, if it came from
// one.
func (server *Server) closeChallengeLinkForGame(gameID string, reason string) {
	if link := server.links.forGame(gameID); link != nil {
		server.closeChallengeLink(link, reason, reason)
	}
}

func (server *Server) announceClosedChallengeLink(
	link *challengeLink,
	watchers []*Client,
	takerID string,
	authorReason string,
	reason string,
	extraUserIDs ...string,
) {
	toAuthor := closedChallengeLink(link.Code, authorReason)
	toEverybody := closedChallengeLink(link.Code, reason)
	server.sendToChallengeLinkAudience(
		func(client *Client) ServerMessage {
			if client.profile.UserID == link.Author.UserID {
				return toAuthor
			}
			return toEverybody
		},
		watchers,
		append([]string{link.Author.UserID, takerID}, extraUserIDs...),
	)
}

func closedChallengeLink(code string, reason string) ServerMessage {
	return ServerMessage{
		Type:          "challenge_link",
		ChallengeLink: &ChallengeLink{Code: code, State: LinkClosed},
		Message:       reason,
	}
}

// challengeLinkWire is the link as it is sent, with its author's whereabouts
// filled in for a link somebody is waiting on.
func (server *Server) challengeLinkWire(link *challengeLink) ChallengeLink {
	wire := server.links.wire(link)
	if wire.State == LinkWaiting {
		wire.AuthorStatus = server.challengeLinkAuthorStatus(link.Author.UserID, time.Now())
	}
	return wire
}

// publishChallengeLink tells everybody concerned how a link now stands: every
// socket its author and its taker have open, everybody looking at it, and
// whoever else the caller names.
func (server *Server) publishChallengeLink(link *challengeLink, extraUserIDs ...string) {
	wire := server.challengeLinkWire(link)
	// Noted here and only here, because only a publish reaches the person
	// waiting. An answer to one socket — somebody else opening the link, a
	// reconnection's connection_ready — noted it too, and the change it
	// carried was then never published to the taker at all.
	if wire.State == LinkWaiting {
		server.links.noteStatus(link, wire.AuthorStatus)
	}
	userIDs := append([]string{link.Author.UserID}, extraUserIDs...)
	if wire.Taker != nil {
		userIDs = append(userIDs, wire.Taker.UserID)
	}
	message := ServerMessage{Type: "challenge_link", ChallengeLink: &wire}
	server.sendToChallengeLinkAudience(
		func(*Client) ServerMessage { return message },
		server.links.watchersOf(link),
		userIDs,
	)
}

// publishChallengeLinkIfStatusChanged republishes a waiting link when what the
// taker is told about its author has changed: they came online, went idle,
// sat down to another game.
func (server *Server) publishChallengeLinkIfStatusChanged(link *challengeLink) {
	if server.links.state(link) != LinkWaiting {
		return
	}
	status := server.challengeLinkAuthorStatus(link.Author.UserID, time.Now())
	if server.links.noteStatus(link, status) {
		server.publishChallengeLink(link)
	}
}

// sendChallengeLinkTo answers one socket with a link as it stands, and a
// reason when its request was refused.
func (server *Server) sendChallengeLinkTo(client *Client, link *challengeLink, reason string) {
	wire := server.challengeLinkWire(link)
	client.Send(ServerMessage{Type: "challenge_link", ChallengeLink: &wire, Message: reason})
}

// sendToChallengeLinkAudience delivers a message once to each socket that is
// either looking at a link or belongs to one of the named accounts, worded for
// that socket by messageFor.
func (server *Server) sendToChallengeLinkAudience(
	messageFor func(*Client) ServerMessage,
	watchers []*Client,
	userIDs []string,
) {
	sent := make(map[*Client]bool, len(watchers))
	for _, client := range watchers {
		if sent[client] {
			continue
		}
		sent[client] = true
		client.Send(messageFor(client))
	}
	named := make(map[string]bool, len(userIDs))
	for _, userID := range userIDs {
		if userID != "" {
			named[userID] = true
		}
	}
	if len(named) == 0 {
		return
	}
	for _, client := range server.connectedClients() {
		if sent[client] || client.isBot() || !named[client.profile.UserID] {
			continue
		}
		sent[client] = true
		client.Send(messageFor(client))
	}
}

// challengeLinksFor is every link an account is part of that has not become a
// game, for connection_ready.
func (server *Server) challengeLinksFor(userID string) []ChallengeLink {
	links := server.links.involving(userID)
	wires := make([]ChallengeLink, 0, len(links))
	for _, link := range links {
		wires = append(wires, server.challengeLinkWire(link))
	}
	return wires
}

// userConnected reports whether an account has any socket open.
func (server *Server) userConnected(userID string) bool {
	if userID == "" {
		return false
	}
	for _, client := range server.connectedClients() {
		if !client.isBot() && client.profile.UserID == userID {
			return true
		}
	}
	return false
}

// gameIsLive reports whether a game is still on the board.
func (server *Server) gameIsLive(gameID string) bool {
	if gameID == "" {
		return false
	}
	server.mu.RLock()
	defer server.mu.RUnlock()
	_, live := server.games[gameID]
	return live
}
