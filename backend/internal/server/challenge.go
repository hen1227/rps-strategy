package server

import (
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"rps-strategy/backend/internal/game"
)

func normalizeChallengeUsername(username string) (string, bool) {
	username = strings.TrimSpace(username)
	count := utf8.RuneCountInString(username)
	if count < 1 || count > 40 || strings.IndexFunc(username, unicode.IsControl) >= 0 {
		return "", false
	}
	return username, true
}

func sameUsername(first string, second string) bool {
	return strings.EqualFold(strings.TrimSpace(first), strings.TrimSpace(second))
}

// IsOpen reports whether this challenge is offered to the room rather than to
// one person.
func (challenge Challenge) IsOpen() bool {
	return strings.TrimSpace(challenge.TargetUsername) == ""
}

// seekIsAcceptableBy reports whether a client may take a seek: the named
// recipient of a private one, or anybody for an open one.
//
// Deliberately not used for declining. Declining destroys the seek, and letting
// a stranger destroy an open invitation nobody addressed to them turns a public
// board into a heckler's veto — so declining keeps asking seekAddressedTo,
// which only ever matches the named target.
func seekIsAcceptableBy(seek *Seek, client *Client) bool {
	if seek.IsOpen() {
		return true
	}
	return sameUsername(seek.TargetUsername, client.profile.Username)
}

// clientIsFree reports whether a client is in a position to be seated: not
// already playing, and not watching somebody else play.
//
// A game that has been opened but not yet begun counts as playing, which is
// what stops a second tab joining the queue while the first is sitting at a
// board waiting for its first move.
func (server *Server) clientIsFree(client *Client) bool {
	return server.participantFor(client) == nil && server.spectatorFor(client) == nil
}

// refuseSeek answers in the vocabulary of the thing the author pressed. The
// same refusal is an "error" to somebody who asked for a game and a
// "challenge_rejected" to somebody who wrote one out.
func refuseSeek(client *Client, fromQueue bool, message string) {
	if fromQueue {
		client.Send(ServerMessage{Type: "error", Message: message})
		return
	}
	client.Send(ServerMessage{Type: "challenge_rejected", Message: message})
}

// joinQueue is the plain "find me a game" request: the mode's standard setup,
// offered to the room.
func (server *Server) joinQueue(client *Client, requested game.GameSetup) {
	server.postSeek(client, "", requested, true)
}

// sendChallenge posts a customized game, to one person by name or to the room.
func (server *Server) sendChallenge(client *Client, username string, requested game.GameSetup) {
	server.postSeek(client, username, requested, false)
}

// postSeek is the one way anybody ends up waiting for a game.
//
// fromQueue says which button was pressed, and is used only to word a refusal.
// What the author actually gets is decided by the setup they sent: a standard
// rated game offered to the room *is* a matchmaking search, however it was
// requested, so filling the custom form in and changing nothing puts somebody
// in the queue rather than posting a row that duplicates it.
func (server *Server) postSeek(
	client *Client,
	username string,
	requested game.GameSetup,
	fromQueue bool,
) {
	// First, because a seek posted during a drain is a row that can never pair:
	// the board stops matching for the duration. Letting it be posted anyway
	// would leave somebody watching a search that was never going to end, and
	// then losing it to the restart without ever being told why.
	if server.isUpdating() {
		refuseSeek(client, fromQueue, server.updateRefusalMessage())
		return
	}
	// The other half of a mute. A challenge carries a username somebody typed
	// and lands in that person's inbox, which is the second way to put words in
	// front of somebody who does not want them — see persistence.RestrictMute.
	if refusal := server.muteRefusal(client, "send challenges"); refusal != "" {
		refuseSeek(client, fromQueue, refusal)
		return
	}
	// No target means the game is offered to the lobby. Every check below that
	// asks *who* it is for is therefore skipped; every check about what the
	// game is stays exactly as it was.
	open := strings.TrimSpace(username) == ""
	if open {
		username = ""
	} else {
		var valid bool
		username, valid = normalizeChallengeUsername(username)
		if !valid {
			refuseSeek(client, fromQueue, "enter a username between 1 and 40 characters")
			return
		}
		if sameUsername(username, "Guest") {
			refuseSeek(client, fromQueue, "Guest is not a challengeable username")
			return
		}
		if sameUsername(username, client.profile.Username) {
			refuseSeek(client, fromQueue, "you cannot challenge yourself")
			return
		}
		// A challenge addressed by name lands in somebody's inbox, which is the
		// half of a block that is not about chat. An open seek is not checked
		// here: it is offered to the room, and pairing is deliberately left
		// alone — see the note at the top of persistence/blocks.go.
		if server.challengeIsBlocked(client, username) {
			refuseSeek(client, fromQueue, challengeBlockRefusal)
			return
		}
	}
	if !server.registry.Has(requested.ModeID) {
		refuseSeek(client, fromQueue, "invalid game mode")
		return
	}
	if !server.registry.Playable(requested.ModeID) {
		refuseSeek(client, fromQueue, "that game mode is no longer open for new matches")
		return
	}
	mode, err := server.registry.New(requested.ModeID)
	if err != nil {
		refuseSeek(client, fromQueue, "invalid game mode")
		return
	}
	definition := mode.Definition()
	setup := requested.Normalize(definition)
	if err := setup.ValidateForMode(mode); err != nil {
		refuseSeek(client, fromQueue, err.Error())
		return
	}
	// The whole unification, in one line. Pressing play is a search, and so is
	// writing out a game that turns out to be the standard one offered to the
	// room — there is nothing about it left to advertise.
	queued := open && (fromQueue || setup.IsStandard(definition))

	// Ranked play needs an account. Anonymous players are downgraded to casual
	// rather than refused: they still get a game, it just does not move a
	// rating, which keeps a first visit one click away while the ladder stays
	// worth something.
	//
	// This has to come *after* `queued`. IsStandard is whole-struct equality
	// against StandardSetup, which is rated — so flipping Casual first would
	// make an anonymous player's standard challenge stop looking standard, and
	// their "play now" would silently become an expiring board posting instead
	// of a place in the queue.
	downgraded := setup.Ranked() && !server.rankedAllowed(client)
	if downgraded {
		setup.Casual = true
	}

	if !server.clientIsFree(client) {
		refuseSeek(client, queued, "leave your current game or matchmaking first")
		return
	}
	// Swapping one plain search for another is the same act repeated — somebody
	// changing their mind about which mode to wait in — so it replaces silently.
	// Anything else would be throwing away a game somebody wrote out, or a
	// challenge somebody else can see, without being asked.
	if existing := server.seeks.ForClient(client); existing != nil && !(existing.Queued && queued) {
		if queued {
			refuseSeek(client, true, "cancel your pending challenge before joining matchmaking")
		} else {
			refuseSeek(client, false, "cancel your current challenge before sending another")
		}
		return
	}
	if !open && server.pendingForName(username) >= maximumPendingPerName {
		// The cap protects one person from an inbox full of invitations. An open
		// seek fills nobody's inbox, and one-per-client above already holds
		// every client to a single seek, so there is nothing there to cap.
		refuseSeek(client, false, "that player has too many pending challenges")
		return
	}

	id, err := randomID()
	if err != nil {
		refuseSeek(client, queued, "could not create the challenge")
		return
	}
	now := time.Now()
	seek := &Seek{
		ID:             id,
		Owner:          seekOwnerKey(client),
		Poster:         client.profile,
		TargetUsername: username,
		Setup:          setup,
		ModeName:       definition.Name,
		Elo:            matchmakingElo(client, setup.ModeID),
		JoinedAt:       now,
		Queued:         queued,
	}
	seek.bind(client)
	// A plain search waits as long as the person is willing to. A posted game
	// expires, because it is an advertisement and a stale one is worse than
	// none.
	if !queued {
		seek.ExpiresAt = now.Add(challengeLifetime)
	}
	server.seeks.Post(seek)

	challenge := seek.Challenge()
	if queued {
		client.Send(ServerMessage{
			Type:        "queue_update",
			ModeID:      setup.ModeID,
			TimeControl: &setup.TimeControl,
			Setup:       &setup,
			SearchRange: seek.SearchRange(now),
		})
	} else {
		client.Send(ServerMessage{Type: "challenge_sent", Challenge: &challenge})
	}
	if downgraded {
		// After the reply, not before it: this is an aside about the game that
		// was just made, and a client waiting for its answer should not have to
		// read past an advisory to find it. The corrected setup is already on
		// the wire above; only somebody comparing it field by field would
		// notice, which is why it is also said in words.
		client.Send(ServerMessage{
			Type:    "ranked_unavailable",
			Message: server.rankedRefusal(client),
		})
	}
	if open {
		server.broadcastOpenChallenges()
		server.broadcastModePlayerCounts()
		return
	}
	for _, recipient := range server.connectedClients() {
		if recipient != client && sameUsername(recipient.profile.Username, username) {
			recipient.Send(ServerMessage{Type: "challenge_received", Challenge: &challenge})
		}
	}
}

func (server *Server) pendingForName(username string) int {
	return len(server.seeks.AddressedTo(username, time.Now()))
}

func (server *Server) acceptChallenge(client *Client, challengeID string) {
	seek := server.seeks.Get(strings.TrimSpace(challengeID))
	if seek == nil || !seekIsAcceptableBy(seek, client) {
		client.Send(ServerMessage{Type: "challenge_unavailable", Message: "that challenge is no longer available"})
		return
	}
	// Refused rather than downgraded, which is the opposite of postSeek and
	// deliberately so: the setup belongs to whoever posted it. Quietly turning
	// their rated game casual would change the game they advertised, and they
	// may not even be connected to be told.
	//
	// It must also come before anything that calls seeks.Claim below — three
	// later branches do, and a refusal landing after one of them would destroy
	// a third party's open challenge on the way out.
	if seek.Setup.Ranked() && !server.rankedAllowed(client) {
		client.Send(ServerMessage{
			Type:    "challenge_rejected",
			Message: server.rankedAcceptRefusal(client),
		})
		return
	}
	if seek.expired(time.Now()) {
		challenge := seek.Challenge()
		server.seeks.Claim(seek.ID)
		client.Send(ServerMessage{Type: "challenge_unavailable", Challenge: &challenge, Message: "that challenge has expired"})
		return
	}
	if !server.clientIsFree(client) {
		client.Send(ServerMessage{Type: "challenge_rejected", Message: "leave your current game or matchmaking first"})
		return
	}
	if waiting := server.seeks.ForClient(client); waiting != nil {
		message := "cancel your outgoing challenge before accepting another"
		if waiting.Queued {
			message = "leave matchmaking before accepting a game"
		}
		client.Send(ServerMessage{Type: "challenge_rejected", Message: message})
		return
	}
	// An author who has closed the tab is no longer a reason to refuse: their
	// seek is still theirs, and taking it summons them. What still disqualifies
	// them is being *here* and busy — sitting at another board, or watching one.
	poster := seek.Client()
	posterIsSelf := seek.Owner == seekOwnerKey(client) ||
		(seek.Poster.UserID != "" && seek.Poster.UserID == client.profile.UserID)
	posterIsBusy := poster != nil && server.clientIsConnected(poster) && !server.clientIsFree(poster)
	if posterIsSelf || posterIsBusy {
		challenge := seek.Challenge()
		server.seeks.Claim(seek.ID)
		client.Send(ServerMessage{Type: "challenge_unavailable", Challenge: &challenge, Message: "the challenger is no longer available"})
		return
	}

	// The claim is what makes an open game safe to publish: two people can pass
	// every check above, and only the one this returns a seek to gets the game.
	claimed := server.seeks.Claim(seek.ID)
	if claimed == nil {
		client.Send(ServerMessage{Type: "challenge_unavailable", Message: "that challenge is no longer available"})
		return
	}
	if claimed.IsOpen() {
		server.broadcastOpenChallenges()
	}

	server.startAcceptedChallenge(claimed, client)
}

func (server *Server) declineChallenge(client *Client, challengeID string) {
	seek := server.seekAddressedTo(client, challengeID)
	if seek == nil {
		client.Send(ServerMessage{Type: "challenge_unavailable", Message: "that challenge is no longer available"})
		return
	}
	claimed := server.seeks.Claim(seek.ID)
	if claimed == nil {
		client.Send(ServerMessage{Type: "challenge_unavailable", Message: "that challenge is no longer available"})
		return
	}
	challenge := claimed.Challenge()
	server.notifySeeker(claimed, ServerMessage{Type: "challenge_declined", Challenge: &challenge, Message: "Your challenge was declined."})
	client.Send(ServerMessage{Type: "challenge_removed", Challenge: &challenge})
}

// cancelChallenge withdraws the author's own seek by id, which is how the lobby
// takes a row off the board.
func (server *Server) cancelChallenge(client *Client, challengeID string) {
	claimed := server.seeks.ClaimFrom(client, strings.TrimSpace(challengeID))
	if claimed == nil {
		client.Send(ServerMessage{Type: "challenge_unavailable", Message: "that challenge is no longer available"})
		return
	}
	server.announceWithdrawnSeek(claimed, "The challenge was cancelled.")
}

// leaveQueue withdraws whatever the client was waiting behind. Cancelling a
// posted game and stopping a search are the same act on the same object, so
// this and cancelChallenge differ only in how the seek is named.
func (server *Server) leaveQueue(client *Client) {
	claimed := server.seeks.RemoveClient(client)
	if claimed == nil {
		// Nothing to withdraw, but a client that thinks it is searching should
		// be corrected rather than left waiting.
		client.Send(ServerMessage{Type: "queue_left"})
		return
	}
	// Silent for the author. They pressed cancel, so a notice telling them the
	// search stopped reports back the act they just performed, and it outlives
	// the press — it sits at the top of the lobby until something else replaces
	// it. Everybody else still hears why the row went away.
	server.withdrawSeek(claimed, "", "The search was stopped.")
}

// announceWithdrawnSeek tells everybody who could see a seek that it is gone,
// in the same words.
func (server *Server) announceWithdrawnSeek(seek *Seek, reason string) {
	server.withdrawSeek(seek, reason, reason)
}

// withdrawSeek is announceWithdrawnSeek with a separate word for the author, so
// a withdrawal somebody performed themselves can say nothing back to them while
// the room still hears why. An empty `authorReason` is dropped by
// `message,omitempty`, leaving the bare message its type carries: enough to
// leave the searching state, and nothing to display.
//
// The author hears it in the vocabulary they were waiting in: somebody who
// pressed play gets `queue_left`, because a client told its *challenge* was
// cancelled has no reason to stop showing a search — which is exactly how a
// cancelled row once left a spinner running forever.
func (server *Server) withdrawSeek(seek *Seek, authorReason, reason string) {
	challenge := seek.Challenge()
	message := ServerMessage{Type: "challenge_cancelled", Challenge: &challenge, Message: reason}
	if seek.Queued {
		server.notifySeeker(seek, ServerMessage{Type: "queue_left", Message: authorReason})
	} else {
		server.notifySeeker(seek, ServerMessage{
			Type: "challenge_cancelled", Challenge: &challenge, Message: authorReason,
		})
	}
	if seek.IsOpen() {
		server.broadcastOpenChallenges()
		server.broadcastModePlayerCounts()
		return
	}
	server.sendToChallengeRecipients(seek.TargetUsername, message)
}

func (server *Server) seekAddressedTo(client *Client, challengeID string) *Seek {
	seek := server.seeks.Get(strings.TrimSpace(challengeID))
	if seek == nil || seek.IsOpen() ||
		!sameUsername(seek.TargetUsername, client.profile.Username) {
		return nil
	}
	return seek
}

func (server *Server) pendingChallengesFor(client *Client, now time.Time) []Challenge {
	addressed := server.seeks.AddressedTo(client.profile.Username, now)
	// A challenge from somebody one of you has blocked does not belong in an
	// inbox. postSeek already refuses to create one, and blocking withdraws
	// whatever was on the board at the time — but a seek can outlive its
	// socket, so one posted by somebody who was offline when the block landed
	// can still be sitting here. Filtered on the way out rather than chased
	// down, because this is the only place it would be seen.
	//
	// The public board is deliberately not filtered the same way: an open row
	// is offered to the room rather than to you, and matchmaking is the half of
	// this a block does not touch.
	kept := addressed[:0]
	for _, challenge := range addressed {
		if server.blockedBetween(client.profile.UserID, challenge.Challenger.UserID) {
			continue
		}
		kept = append(kept, challenge)
	}
	return kept
}

// openChallenges is the public board: every unclaimed game anybody is waiting
// behind, plain searches included.
func (server *Server) openChallenges(now time.Time) []Challenge {
	return server.seeks.Open(now)
}

// broadcastOpenChallenges republishes the whole board.
//
// The whole list rather than a delta, and only when it changes rather than on
// the lobby ticker: it is a handful of rows, a client that missed one message
// would otherwise show a game that is gone, and the expiry countdown is
// computed from each row's own timestamp.
func (server *Server) broadcastOpenChallenges() {
	server.broadcastToClients(ServerMessage{
		Type:           "open_challenges",
		OpenChallenges: server.openChallenges(time.Now()),
	})
}

func (server *Server) expireChallenges(now time.Time) {
	expired := server.seeks.TakeExpired(now)
	openExpired := false
	for _, seek := range expired {
		challenge := seek.Challenge()
		message := ServerMessage{
			Type:      "challenge_cancelled",
			Challenge: &challenge,
			Message:   "The challenge expired.",
		}
		// A search only carries an expiry once its author has gone away, so the
		// one that runs out here is a queue somebody left open and never came
		// back to. They hear it as a search ending, in the same words they would
		// have heard had they pressed cancel — a client told its *challenge*
		// expired has no reason to stop showing a spinner.
		if seek.Queued {
			server.notifySeeker(seek, ServerMessage{
				Type:    "queue_left",
				Message: "Your search ended after waiting a long time with nobody at the keyboard.",
			})
			openExpired = openExpired || seek.IsOpen()
			continue
		}
		server.notifySeeker(seek, message)
		if seek.IsOpen() {
			openExpired = true
			continue
		}
		server.sendToChallengeRecipients(seek.TargetUsername, message)
	}
	if openExpired {
		server.broadcastOpenChallenges()
		server.broadcastModePlayerCounts()
	}
}

func (server *Server) cancelChallengesFrom(client *Client, reason string) {
	cancelled := server.seeks.TakeFrom(client)
	openCancelled := false
	for _, seek := range cancelled {
		if seek.IsOpen() {
			openCancelled = true
			continue
		}
		challenge := seek.Challenge()
		server.sendToChallengeRecipients(
			seek.TargetUsername,
			ServerMessage{Type: "challenge_cancelled", Challenge: &challenge, Message: reason},
		)
	}
	if openCancelled {
		server.broadcastOpenChallenges()
	}
}

// notifySeeker delivers a lobby message to every socket a seek's author has
// open, which is none while they are away and more than one when they have
// several tabs.
//
// It replaces writing to a seek's single client, because a seek no longer has
// one. Sending to all of them is not merely defensive: a person watching the
// queue in two tabs should see it end in both, and the tab a notification opens
// is frequently not the tab that joined.
func (server *Server) notifySeeker(seek *Seek, message ServerMessage) {
	if seek == nil {
		return
	}
	if seek.Poster.UserID == "" {
		// An anonymous seek is tied to its own socket and cannot be recognised
		// across connections, so there is exactly one place to write to.
		if client := seek.Client(); client != nil {
			client.Send(message)
		}
		return
	}
	for _, client := range server.connectedClients() {
		if client.profile.UserID == seek.Poster.UserID {
			client.Send(message)
		}
	}
}

func (server *Server) sendToChallengeRecipients(username string, message ServerMessage) {
	// An open seek has no recipient. Without this guard the loop below would
	// match every client whose username is also empty, which is nobody in
	// production and every embedded test client in a test.
	if strings.TrimSpace(username) == "" {
		return
	}
	for _, client := range server.connectedClients() {
		if sameUsername(client.profile.Username, username) {
			client.Send(message)
		}
	}
}

func (server *Server) connectedClients() []*Client {
	server.hub.mu.RLock()
	clients := make([]*Client, 0, len(server.hub.clients))
	for client := range server.hub.clients {
		clients = append(clients, client)
	}
	server.hub.mu.RUnlock()
	return clients
}

func (server *Server) clientIsConnected(client *Client) bool {
	server.hub.mu.RLock()
	_, connected := server.hub.clients[client]
	server.hub.mu.RUnlock()
	return connected
}
