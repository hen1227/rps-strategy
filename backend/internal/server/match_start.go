package server

import (
	"time"

	"rps-strategy/backend/internal/game"
)

// The gap between "two seeks fit" and "a game is being played".
//
// There used to be a step in the middle. Pairing produced a *held* match, and
// the game opened only once both players had pressed a button to say they were
// there. It read well and it did not work: the button is one more thing to
// miss, a notification that leads to a second notification is a notification
// people stop opening, and two people who were both perfectly willing to play
// would routinely fail to meet.
//
// So pairing seats the game immediately. Both players are notified — the board
// is already open, and it is theirs — and the only thing held back is the
// clock. Neither clock runs until somebody moves, so arriving late costs
// nothing, and a game nobody moves in inside firstMoveWindow is cancelled
// outright: no result, no record, no rating. The seeks that made it are kept in
// escrow on the session until then, because a match that never begins has to be
// able to put its players back where it found them.
//
// The rule for what takes the escrow and what skips it: **the escrow exists to
// cover the walk back to the board, so a path where nobody has walked away does
// not take it.** A tournament ready-up is a button pressed seconds ago. A bot
// is a pipe with nobody to summon. Both open with the clock already running.
//
// Lock ordering, which is the one way this file can deadlock: never hold
// server.mu across a call into seekBoard, and never hold a board lock across a
// call into Server. pair() already obeys the second half by releasing before it
// calls onPair; expireUnstartedGames obeys the first by collecting under the
// lock, releasing, and only then posting seeks back to the board.

// firstMoveWindow is how long a game may sit unplayed before it is called off.
//
// Written as the reconnect grace period rather than as thirty seconds, because
// it is the same promise — we will hold your place for half a minute — and a
// player should not have to learn two numbers for it. Changing one changes
// both, which is the intent.
const firstMoveWindow = reconnectGracePeriod

// matchStart is the escrow behind a game that has been opened but not begun.
type matchStart struct {
	// deadline is when a game with no moves in it is given up on.
	deadline time.Time
	// seats are the seeks the game was made from, Red first. A seek is kept
	// whole rather than copied so that requeueing restores the wait already
	// served: same id, same JoinedAt, same widened rating band.
	seats [2]*startSeat
	// cancelled claims the cancellation slot. Read and written only under
	// Server.mu, so a sweep and a disconnect cannot both call the match off.
	cancelled bool
}

// startSeat is one side of an unbegun game: the seek that earned the seat, and
// what becomes of it if the game never happens.
type startSeat struct {
	seek *Seek
	// requeue says what becomes of this seek if the game is called off. A
	// matchmaking search goes back on the board exactly where it was; somebody
	// who took a posted challenge never asked to be in the queue at all.
	requeue bool
}

// startPairedMatch is what the board calls when two seeks fit. It opens the
// game there and then, whether or not either player is looking at the screen.
func (server *Server) startPairedMatch(first, second *Seek) {
	red, blue := seatOrder(first, second)
	server.seatMatch(
		&startSeat{seek: red, requeue: true},
		&startSeat{seek: blue, requeue: true},
	)
}

// startAcceptedChallenge seats a challenge somebody has just taken.
//
// The taker is here by definition — they just clicked. The author may not be,
// which is exactly the case the escrow covers: the board opens for both of
// them, and if the author never comes the game is called off rather than
// costing them a rating.
func (server *Server) startAcceptedChallenge(posted *Seek, taker *Client) {
	// Both sides of an escrow are Seeks, so the requeue path has one shape to
	// know about. The taker's is synthesised and never goes back on the board:
	// they asked for one game against one person, not for a place in
	// matchmaking.
	takerSeek := &Seek{
		ID:       posted.ID + ":taker",
		Owner:    seekOwnerKey(taker),
		Poster:   taker.profile,
		Setup:    posted.Setup,
		ModeName: posted.ModeName,
		Elo:      matchmakingElo(taker, posted.Setup.ModeID),
		JoinedAt: time.Now(),
	}
	takerSeek.bind(taker)

	// The author's seat preference is honoured and the person taking the game
	// gets the other one. With no preference the author plays Red, which is the
	// side that moves first — the same courtesy a challenge has always carried.
	postedSeat := &startSeat{seek: posted, requeue: false}
	takerSeat := &startSeat{seek: takerSeek, requeue: false}
	red, blue := postedSeat, takerSeat
	if posted.Setup.PreferredColor == game.Blue {
		red, blue = takerSeat, postedSeat
	}
	server.seatMatch(red, blue)
}

// seatMatch opens the board for two seeks and calls whoever is not looking at
// it. The seats arrive in the order they will be seated, Red first.
func (server *Server) seatMatch(red, blue *startSeat) {
	redClient := server.seatClient(red.seek)
	blueClient := server.seatClient(blue.seek)
	// Anything either player was doing that conflicts with sitting down — a
	// board they were watching, a game they had posted — ends here rather than
	// after the game has opened behind it.
	server.releaseFromLobby(redClient)
	server.releaseFromLobby(blueClient)

	start := &matchStart{
		deadline: time.Now().Add(firstMoveWindow),
		seats:    [2]*startSeat{red, blue},
	}
	session := server.startConfiguredMatch(
		red.seek.entry(redClient),
		blue.seek.entry(blueClient),
		matchSetup{start: start},
	)
	if session == nil {
		// The game could not be made. Put back whatever can go back and let the
		// next tick try again; startConfiguredMatch has already said why to
		// anybody who was connected.
		server.requeueOrRelease(red)
		server.requeueOrRelease(blue)
		server.broadcastOpenChallenges()
		server.broadcastModePlayerCounts()
		return
	}

	// Two rows just left the public board, and a plain search is published
	// there too, so the lobby has to be told even though this is not a
	// withdrawal. The population figures went out with the game itself, from
	// startConfiguredMatch, so only the board is republished here.
	server.broadcastOpenChallenges()

	server.summon(session, red.seek, blue.seek, redClient == nil)
	server.summon(session, blue.seek, red.seek, blueClient == nil)
}

// seatClient resolves the socket that will sit in a seat, preferring the one
// that posted the seek and falling back to any other tab the same account has
// open. Nil is a perfectly good answer: the game opens without them.
func (server *Server) seatClient(seek *Seek) *Client {
	if client := seek.Client(); client != nil &&
		server.clientIsConnected(client) && server.clientIsFree(client) {
		return client
	}
	if seek.Poster.UserID == "" {
		return nil
	}
	for _, candidate := range server.connectedClients() {
		if candidate.profile.UserID == seek.Poster.UserID && server.clientIsFree(candidate) {
			return candidate
		}
	}
	return nil
}

// summon tells one player their game has started, by whatever means reaches
// them. A notification goes to anybody who is not demonstrably watching: they
// have gone, or the tab is in the background and they are not looking at it.
//
// This is still the only notification this server ever sends. What changed is
// what it says — the game is open, not "come and accept something" — and that
// it now goes to both sides rather than only to the one that was away, because
// a game that is already running is news to a player who was merely idle too.
func (server *Server) summon(session *GameSession, seek, opponent *Seek, absent bool) {
	if !absent && seek.Present() {
		return
	}
	opponentName := opponent.Poster.Username
	if opponentName == "" {
		opponentName = "Someone"
	}
	go server.push.Send(seek.Poster.UserID, pushPayload{
		Kind:   "match_started",
		Title:  "Your game has started",
		Body:   opponentName + " is at the board · move within 30s or the game is called off",
		Tag:    "rps-match",
		GameID: session.gameID,
	})
}

// matchBegan is the first move landing: the escrow is over, the clock is
// running, and this is an ordinary game from here on.
//
// It also re-anchors the absent side's reconnect clock. Without that, a player
// whose opponent moved on the twenty-ninth second would have one second to get
// back before being ruled to have abandoned a game that had only just started.
func (server *Server) matchBegan(session *GameSession) {
	now := time.Now()
	server.mu.Lock()
	defer server.mu.Unlock()
	if session.start == nil {
		return
	}
	session.start = nil
	if session.redClient == nil && !session.redDisconnectedAt.IsZero() {
		session.redDisconnectedAt = now
	}
	if session.blueClient == nil && !session.blueDisconnectedAt.IsZero() {
		session.blueDisconnectedAt = now
	}
}

// expireUnstartedGames calls off the games nobody played a move in.
//
// The player who was to move is the no-show: they are the reason the other
// person's search stalled for thirty seconds, and leaving them in the queue
// would stall the next one too. The other player goes back to searching behind
// the seek they already had — same id, same JoinedAt — so the wait they have
// already served still counts and the rating band they had widened to does not
// snap shut.
func (server *Server) expireUnstartedGames(now time.Time) {
	server.mu.Lock()
	expired := make([]*GameSession, 0)
	for _, session := range server.games {
		start := session.start
		if start == nil || start.cancelled || now.Before(start.deadline) {
			continue
		}
		// Claiming the slot here, so a first move racing this sweep loses
		// rather than leaving a live game with no escrow and no players.
		start.cancelled = true
		expired = append(expired, session)
	}
	server.mu.Unlock()

	for _, session := range expired {
		// The side that was to move is the one that failed to show. Read from
		// the game rather than assumed to be Red, so a mode or an opening that
		// seats Blue first still names the right person.
		server.cancelUnstartedGame(session, session.game.Snapshot().CurrentTurn, cancelledByTimeout)
	}
}

// why a game was called off, which decides only what the two players are told.
type cancelReason int

const (
	cancelledByTimeout cancelReason = iota
	cancelledByAbort
)

func (reason cancelReason) tellNoShow() string {
	if reason == cancelledByAbort {
		return "You called the game off, so it does not count and neither does your place in the queue."
	}
	return "You were taken out of the queue because you did not play your first move in time."
}

func (reason cancelReason) tellWaiting() string {
	if reason == cancelledByAbort {
		return "Your opponent called the game off before it started. Nothing was rated."
	}
	return "The game was called off: no first move was played. Nothing was rated."
}

// cancelUnstartedGame takes an unplayed game off the board as though it had
// never happened: no result, no archive row, no rating.
//
// That is the whole point of the thirty-second window. A game abandoned before
// anybody moved says nothing about who is the better player, and a queue you
// can walk away from is only worth having if walking away cannot cost you.
func (server *Server) cancelUnstartedGame(
	session *GameSession,
	blame game.PlayerColor,
	reason cancelReason,
) {
	server.mu.Lock()
	start := session.start
	if start == nil {
		server.mu.Unlock()
		return
	}
	session.start = nil
	noShow, waiting := start.seats[0], start.seats[1]
	if blame == game.Blue {
		noShow, waiting = waiting, noShow
	}
	server.mu.Unlock()

	// Out of the games map and out of both players' hands before anything is
	// said, so neither can move into a game that is being called off.
	server.discardSession(session)

	server.notifySeeker(noShow.seek, ServerMessage{
		Type:    "game_cancelled",
		GameID:  session.gameID,
		Message: reason.tellNoShow(),
	})
	server.notifySeeker(waiting.seek, ServerMessage{
		Type:    "game_cancelled",
		GameID:  session.gameID,
		Message: reason.tellWaiting(),
	})

	if server.requeueOrRelease(waiting) {
		server.broadcastOpenChallenges()
		server.broadcastModePlayerCounts()
	}
	server.broadcastLiveGames()
}

// discardSession forgets a game that produced no result.
//
// Deliberately not retireSession: that one hands the players to a post-game
// chat room and files the board as something to look back at. A game nobody
// played a move in is not a game, so nothing about it is kept.
func (server *Server) discardSession(session *GameSession) {
	server.mu.Lock()
	if current, ok := server.games[session.gameID]; !ok || current != session {
		server.mu.Unlock()
		return
	}
	delete(server.games, session.gameID)
	for _, seat := range []struct {
		client *Client
		color  game.PlayerColor
	}{{session.redClient, game.Red}, {session.blueClient, game.Blue}} {
		if seat.client == nil {
			continue
		}
		if participant, ok := server.participants[seat.client]; ok && participant.session == session {
			delete(server.participants, seat.client)
		}
	}
	for spectator := range session.spectators {
		if server.spectating[spectator] == session {
			delete(server.spectating, spectator)
		}
	}
	session.chat.leave(session)
	server.mu.Unlock()
}

// requeueOrRelease decides one seat's fate when its game is called off, and
// reports whether the public board changed.
func (server *Server) requeueOrRelease(seat *startSeat) bool {
	if !seat.requeue {
		return false
	}
	// A player who has since lost their own socket only goes back on the board
	// if they could still be called back from it. The rule that keeps the queue
	// honest applies here exactly as it does at disconnect.
	if !server.seekCanOutliveSocket(seat.seek) && seat.seek.Client() == nil {
		return false
	}
	// The same *Seek, untouched: its ID, JoinedAt, Elo and Setup all survive, so
	// SearchRange keeps widening from the original join and the row goes back to
	// the place it held in the board's oldest-first order.
	server.seeks.Post(seat.seek)
	server.sendQueueUpdate(seat.seek)
	return true
}

// abortGame is a player saying they cannot play this one after all.
//
// It exists so that somebody who reads the notification on a bus can free their
// opponent in one tap instead of making them wait out the full thirty seconds,
// and so that a player looking at a board they did not expect has an exit that
// is not a rated resignation. The outcome is the same as a no-show, only
// sooner, and it is available to either side because either side may be the one
// who cannot play.
func (server *Server) abortGame(client *Client) {
	participant := server.participantFor(client)
	if participant == nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: "player is not in a game"})
		return
	}
	session := participant.session

	server.mu.Lock()
	start := session.start
	if start == nil || start.cancelled {
		server.mu.Unlock()
		// Not an error worth a banner: a game that began between the press and
		// the message arriving is simply a game to be played.
		client.Send(ServerMessage{
			Type:    "action_rejected",
			Message: "this game has already started, so it can only be resigned",
		})
		return
	}
	// Claiming the slot under the lock, so an abort racing the sweep cannot
	// call the same game off twice.
	start.cancelled = true
	server.mu.Unlock()

	server.cancelUnstartedGame(session, participant.color, cancelledByAbort)
}

// deadlineUnixMs is the moment this game gives up waiting for a first move, or
// zero for a game that has begun or never had an escrow. Nil-safe so that every
// caller can ask without first working out whether there is anything to ask.
func (start *matchStart) deadlineUnixMs() int64 {
	if start == nil {
		return 0
	}
	return start.deadline.UnixMilli()
}

// liveGameFor is the game this account is seated in, named so a fresh tab can
// be handed straight back into it.
//
// This is what makes a notification worth opening. The board was opened while
// they were away, so their browser has never heard of it and cannot ask to
// rejoin by id; connection_ready tells them the id instead.
func (server *Server) liveGameFor(userID string) string {
	if userID == "" {
		return ""
	}
	server.mu.RLock()
	defer server.mu.RUnlock()
	for _, session := range server.games {
		state := session.game.Snapshot()
		if state.Status != game.InProgress {
			continue
		}
		if colorForUser(state, userID) != game.Neutral {
			return session.gameID
		}
	}
	return ""
}
