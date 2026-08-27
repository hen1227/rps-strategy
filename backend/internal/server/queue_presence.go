package server

import (
	"context"
	"time"

	"rps-strategy/backend/internal/game"
)

// What happens to a wait when the socket behind it comes and goes.
//
// Before the queue could outlive a tab, this was one line in disconnect:
// withdraw the seek. That was correct when a seek *was* a connection. Now that
// a seek belongs to a person, closing a socket asks a real question — can this
// person still be reached? — and the answer decides whether a row stays on the
// public board.
//
// The rule the whole feature rests on: **a seek may only wait for somebody who
// can be called back.** A player with a live push subscription keeps their
// place with the tab closed. Everybody else is withdrawn exactly as they always
// were. That is what makes every row on the open board an answerable person
// rather than a thirty-second trap for whoever clicks it.

// setQueuePresence records a presence report and republishes the board if it
// changed anything anybody can see.
func (server *Server) setQueuePresence(client *Client, present bool) {
	presence := PresenceIdle
	if present {
		presence = PresenceHere
	}
	if seek := server.seeks.SetPresence(client, presence); seek != nil {
		server.broadcastOpenChallenges()
		server.broadcastModePlayerCounts()
	}
}

// seekCanOutliveSocket reports whether a seek may sit on the board with nobody
// connected behind it.
//
// Three conditions, each doing its own work. Only a plain search: a posted
// challenge is an advertisement with its own ten-minute expiry, and two
// lifetimes competing over one row buys nothing. Only a named account: an
// anonymous browser cannot be recognised across connections, so there is
// nothing to call back to. And only somebody push can actually reach, which is
// the condition the other two exist to support.
func (server *Server) seekCanOutliveSocket(seek *Seek) bool {
	if seek == nil || !seek.Queued || seek.Poster.UserID == "" {
		return false
	}
	return server.push.Reachable(context.Background(), seek.Poster.UserID)
}

// releaseSeeksOnDisconnect is what a closing socket does to whatever its owner
// was waiting behind.
//
// Order matters here. Another tab of the same account is checked first, because
// closing one of two windows should not turn a present player into an absent
// one. Only then does the reachability rule decide between keeping the seek and
// withdrawing it.
func (server *Server) releaseSeeksOnDisconnect(client *Client, reason string) {
	seek := server.seeks.Detach(client)
	if seek == nil {
		return
	}

	// disconnect runs before hub.Unregister, so this client is still in the hub
	// and has to be excluded by hand.
	if other := server.anotherClientForUser(client, seek.Poster.UserID); other != nil {
		seek.bind(other)
		return
	}

	if !server.seekCanOutliveSocket(seek) {
		if claimed := server.seeks.Claim(seek.ID); claimed != nil {
			server.announceWithdrawnSeek(claimed, reason)
		}
		return
	}

	// Kept, but not for ever. A search left running overnight would summon
	// somebody at four in the morning for a game they no longer want, and the
	// person who clicked it would wait out the whole thirty seconds finding
	// that out.
	seek.ExpiresAt = time.Now().Add(awaySeekLifetime)
	server.broadcastOpenChallenges()
	server.broadcastModePlayerCounts()
}

// dropUnreachableSeeks withdraws the wait of somebody who has just stopped
// being reachable, which is what a push service answering 404 or 410 means.
//
// Without this the one situation the reachability rule exists to prevent is the
// one a dead subscription creates: a row on the board for a person no message
// can arrive at, discovered only by the next player to spend thirty seconds on
// them.
func (server *Server) dropUnreachableSeeks(userID string) {
	seek := server.seeks.ForOwner(userID)
	if seek == nil || seek.Client() != nil {
		return
	}
	if claimed := server.seeks.Claim(seek.ID); claimed != nil {
		server.announceWithdrawnSeek(claimed, "Your search ended because notifications stopped working.")
	}
}

// rebindSeek hands a reconnecting player — or a second tab — the wait they are
// already behind, with its id, its place in the queue and its clock untouched.
//
// The client never re-sends join_queue for this. Re-joining would mint a new
// seek with a new JoinedAt, throwing away the wait already served and snapping
// the widened rating band shut; being told what you are already in is the only
// version of this that keeps a promise.
func (server *Server) rebindSeek(client *Client) *QueueSnapshot {
	seek := server.seeks.Bind(client)
	if seek == nil {
		return nil
	}
	// Back in somebody's hands, so the away clock stops.
	seek.ExpiresAt = time.Time{}
	server.broadcastOpenChallenges()
	server.broadcastModePlayerCounts()
	if !seek.Queued {
		return nil
	}
	return queueSnapshot(seek, time.Now())
}

// anotherClientForUser finds a different live socket belonging to one account,
// which is how a second tab keeps a wait alive when the first one closes.
func (server *Server) anotherClientForUser(exclude *Client, userID string) *Client {
	if userID == "" {
		return nil
	}
	for _, candidate := range server.connectedClients() {
		if candidate == exclude || candidate.profile.UserID != userID || candidate.isBot() {
			continue
		}
		return candidate
	}
	return nil
}

func queueSnapshot(seek *Seek, now time.Time) *QueueSnapshot {
	return &QueueSnapshot{
		ModeID:      seek.Setup.ModeID,
		Setup:       seek.Setup,
		TimeControl: seek.Setup.TimeControl,
		SearchRange: seek.SearchRange(now),
		QueuedForMs: now.Sub(seek.JoinedAt).Milliseconds(),
	}
}

// sendQueueUpdate tells a searcher where their search stands, to every tab they
// have open.
func (server *Server) sendQueueUpdate(seek *Seek) {
	if seek == nil || !seek.Queued {
		return
	}
	now := time.Now()
	setup := seek.Setup
	server.notifySeeker(seek, ServerMessage{
		Type:        "queue_update",
		ModeID:      setup.ModeID,
		TimeControl: &setup.TimeControl,
		Setup:       &setup,
		SearchRange: seek.SearchRange(now),
		QueuedForMs: now.Sub(seek.JoinedAt).Milliseconds(),
	})
}

// modeReadyCounts is how many people per mode are waiting *and* at the keyboard.
func (server *Server) modeReadyCounts() map[game.ModeID]int {
	counts := make(map[game.ModeID]int)
	for _, modeID := range server.registry.CatalogueIDs() {
		counts[modeID] = 0
	}
	for modeID, count := range server.seeks.PresentCountsByMode() {
		counts[modeID] += count
	}
	return counts
}
