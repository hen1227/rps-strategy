package server

import (
	"log"

	"rps-strategy/backend/internal/game"
)

// Taking an engine back for its own match.
//
// A reservation — see bot_reserve.go — stops an engine entered in a running
// event from being borrowed, but it can only stop games that have not started
// yet. It says nothing about the game the engine was already in when the event
// began, and there is always one: an untimed board can run for hours, a series
// dealt before the first round has five games left to play, and the roster is
// published a whole lobby tick before the reservation that follows it.
//
// So the schedule comes round, the engine is busy, and the match waits. It
// waits forever, because nothing else in a round robin is going to end that
// game — which is a bots-only event stopping dead halfway through, and a human
// who has pressed ready staring at a bot that never turns up.
//
// A recall is the answer: the engine's own match outranks whatever else it is
// doing, so whatever else it is doing is stopped. The game it was in is voided
// rather than adjudicated — nothing is filed, no rating moves, no archive row.
// Neither player earned a result and neither should get one.
//
// # What is not stopped
//
// Another event's live match. Voiding a real tournament game to feed another
// tournament game is not a rule, it is two events eating each other, and the
// engine will be out of that match soon enough. That match waits, which is the
// behaviour this whole file exists to avoid — but it waits on something that is
// going to end.
//
// # Why it is planned before it is done
//
// A match needs both players. Freeing one engine by stopping its game and then
// discovering the opponent is offline would have destroyed somebody's game for
// nothing, and the match would still not start. So working out what would have
// to be stopped is a separate step from stopping it, and the caller does the
// first for both seats before it does the second for either.

// botRecall is one engine's route back to an idle slot, worked out before
// anything is torn down. Never assembled by hand — see planBotRecall.
type botRecall struct {
	// client is a slot that is already free, which is the answer nearly every
	// time. When it is set the rest is empty and running the recall stops
	// nothing at all.
	client *Client
	// game is an ordinary game to void, and series says a run is holding the
	// slot. Both can be set at once: a run holds its engines between games as
	// well as during them, so a board dealt by one is two things to undo.
	game   *GameSession
	series bool
	// botID is the engine the freed slot will be looked for on, and name is
	// what the people in the stopped game are told was called away.
	botID string
	name  string
}

// planBotRecall works out how an engine could be freed for a scheduled match,
// without freeing it.
//
// Returns nil when it could not be: the engine is not connected, or every slot
// it has is either mid-handshake or holding a game this will not interrupt.
// Callers treat a nil plan as "not startable yet" and try again on the next
// tick, which is what they did with a busy engine before recalls existed.
//
// Changes nothing, which is what makes it safe to ask as a plain predicate —
// and two callers do exactly that, to decide whether an engine counts as
// present without committing to fetching it.
func (server *Server) planBotRecall(userID string) *botRecall {
	client := server.botClientFor(userID)
	if client == nil {
		return nil
	}
	botID := client.bot.botID
	client.bot.mu.Lock()
	name := client.bot.record.Name
	client.bot.mu.Unlock()

	if free := server.freeBotConnection(botID); free != nil {
		return &botRecall{client: free, botID: botID, name: name}
	}

	// Both kinds of blockage are looked for before either is chosen, because
	// they are not equally cheap: voiding one board costs one game, and
	// aborting a run costs every game it had left to play. An engine with a
	// slot in each gives up the board.
	var (
		// ordinary is a plain game — a challenge, a matchmaking pairing — which
		// is the cheapest thing here to stop.
		ordinary *GameSession
		// runGame is the board a run is currently playing on, which is a
		// separate thing from the run's hold on the slot. Both have to go: the
		// hold survives the board, and the board outlives the hold.
		runGame   *GameSession
		heldByRun bool
	)
	for _, candidate := range server.botConnections(botID) {
		candidate.bot.mu.Lock()
		ready, run := candidate.bot.ready, candidate.bot.reservedBy
		candidate.bot.mu.Unlock()
		// A slot that has not finished its handshake cannot be given a game and
		// nothing here can change that.
		if !ready {
			continue
		}
		participant := server.participantFor(candidate)
		if run != "" {
			heldByRun = true
			if participant != nil && runGame == nil {
				runGame = participant.session
			}
			continue
		}
		if participant == nil {
			// Free after all: a game ended between freeBotConnection and here.
			return &botRecall{client: candidate, botID: botID, name: name}
		}
		if participant.session.tournament != nil {
			continue
		}
		if ordinary == nil {
			ordinary = participant.session
		}
	}
	switch {
	case ordinary != nil:
		return &botRecall{game: ordinary, botID: botID, name: name}
	case heldByRun:
		return &botRecall{series: true, game: runGame, botID: botID, name: name}
	}
	return nil
}

// runBotRecall carries a plan out and returns the slot it freed.
//
// nil when the engine did not come free after all, which is a race rather than
// a refusal: something took the slot between the plan and here. The caller
// gives the match's claim back and the next tick tries again.
func (server *Server) runBotRecall(plan *botRecall, tournamentName string) *Client {
	if plan == nil {
		return nil
	}
	if plan.client != nil {
		return plan.client
	}
	if plan.series {
		// The hold goes before the board. A run keeps its engines between the
		// games of a pair — that is what holding a slot means here — so voiding
		// the board without this frees the engine for about as long as it takes
		// the runner to deal the next one. Ending the run is also the operation
		// the host's own tools offer for exactly this: see the refusal in
		// stopGame, which sends a moderator here rather than let them void one
		// game out of six.
		server.abortSeriesForBot(plan.botID)
	}
	if plan.game != nil {
		server.stopGameForRecall(plan.game, botRecallNotice(plan.name, tournamentName))
	}
	freed := server.freeBotConnection(plan.botID)
	if freed != nil && (plan.series || plan.game != nil) {
		log.Printf(
			"recalled bot %s for a match in %q (series=%t, game=%t)",
			plan.name, tournamentName, plan.series, plan.game != nil,
		)
	}
	return freed
}

// stopGameForRecall takes one game off the board, filing nothing.
//
// The two ways a game can be standing there, and they need different endings:
// one that nobody has moved in yet is holding both players' seeks in escrow and
// only cancelUnstartedGame gives those back, and one that is being played is a
// void. The same split, and for the same reason, as the host's stop button.
func (server *Server) stopGameForRecall(session *GameSession, notice string) {
	server.mu.RLock()
	live := server.games[session.gameID] == session
	unstarted := session.start != nil
	server.mu.RUnlock()
	// Gone already: it finished by itself, or — when both engines of a match
	// were sitting in the same game against each other — this is the second
	// recall of one board.
	if !live {
		return
	}
	if unstarted {
		server.cancelUnstartedGame(session, game.Neutral, cancelledByRecall)
		return
	}
	server.voidGame(session, notice)
}

// botRecallNotice is what the players and the spectators of a stopped game are
// told.
//
// It names the engine and the event, because "this game has been stopped" on
// its own is indistinguishable from a crash — which is the thing a board that
// vanishes most looks like. It also says nothing was rated, since that is the
// first question the person who was winning is going to have.
//
// What it does *not* say is that the game was stopped, even though that is the
// news. The game screen puts this under a heading which says exactly that, and
// the two together read as a stutter; everywhere else it appears — the lobby
// notice, the queue card — the reader has just been taken off the board and
// needs the reason rather than the fact.
func botRecallNotice(botName string, tournamentName string) string {
	return botName + " has been called away to play its scheduled match in " +
		tournamentName + ". Nothing was rated."
}
