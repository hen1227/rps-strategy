package server

import (
	"log"
	"time"

	"rps-strategy/backend/internal/game"
)

// An engine coming back to the game it dropped out of.
//
// A person who reloads a tab sends `rejoin_game` and is put back in their
// seat. A bot cannot: rpsbot.py is a pipe with a reconnect loop in it, it has
// no memory of what board it was on, and adding one would mean the client had
// to be trusted about which game it may sit down at. So the server does the
// remembering — the seat is still there, empty, with the account that owns it
// written on it, and the first slot of that bot to finish a handshake takes it
// back.
//
// This is what makes botReconnectGracePeriod mean anything. Without it the
// window is not a grace period at all: the seat is held for fifteen seconds,
// the engine reconnects into it after two, and then both sides sit and wait
// for the sweep to call the game abandoned anyway. Every dropped socket cost a
// game, and a bot with a flaky link cost one per blip.

// resumeBotGames puts a freshly handshaken slot back into any game its bot
// left behind.
//
// Called once per connection, after `ready`, because a slot that cannot be
// asked for a move is no use in a seat. Ordinary and cheap: nearly every call
// walks the live games, finds nothing, and returns.
func (server *Server) resumeBotGames(client *Client) {
	if !client.isBot() {
		return
	}
	session, color := server.heldSeatFor(client)
	if session == nil {
		return
	}

	state := session.game.Snapshot()
	server.mu.Lock()
	// Re-checked under the write lock. heldSeatFor read this under the read
	// lock, and two slots of one bot finishing their handshakes together would
	// otherwise both sit down in the same seat.
	if !server.seatIsStillHeld(session, color, state, time.Now()) {
		server.mu.Unlock()
		return
	}
	if color == game.Red {
		session.redClient = client
		session.redDisconnectedAt = time.Time{}
	} else {
		session.blueClient = client
		session.blueDisconnectedAt = time.Time{}
	}
	server.participants[client] = Participant{session: session, color: color}
	room := session.chat
	seriesID := ""
	if session.botMatch != nil {
		seriesID = session.botMatch.seriesID
	}
	server.mu.Unlock()

	// The run that was holding this bot lost its hold when the old socket went
	// away, so the new one has to take it back — otherwise the next challenge
	// to arrive takes the slot out from under a series that is mid-pair. See
	// claimSeriesBot.
	if seriesID != "" {
		client.bot.mu.Lock()
		if client.bot.reservedBy == "" {
			client.bot.reservedBy = seriesID
		}
		client.bot.mu.Unlock()
	}

	log.Printf("bot %s resumed game %s after reconnecting", client.profile.Username, session.gameID)
	server.sendToColor(session, game.OtherColor(color), ServerMessage{Type: "opponent_reconnected"})
	server.announceRoomOccupancy(room)
	server.broadcastLiveGames()
	server.broadcastBots()
	// Whatever was asked of the old socket died with it, so the position has to
	// be put to this one. Idempotent, and a no-op when it is the other side's
	// move — the engine is prompted by the next state broadcast then.
	server.promptBot(session, state)
}

// heldSeatFor finds the one live game this bot has an empty seat in.
//
// Empty *and* still inside its window: a seat whose deadline has passed is a
// game the sweep is about to end, and sitting down in it would restart a game
// that is already lost. The bot's own account is the key, which is what keeps
// a slot from being seated in a game belonging to some other engine.
func (server *Server) heldSeatFor(client *Client) (*GameSession, game.PlayerColor) {
	now := time.Now()
	server.mu.RLock()
	sessions := make([]*GameSession, 0, len(server.games))
	for _, session := range server.games {
		sessions = append(sessions, session)
	}
	// A slot that already has a game keeps it. Two of a bot's sockets can drop
	// together, and the second one back should take the second seat rather
	// than the one its sibling just sat down in.
	_, seated := server.participants[client]
	server.mu.RUnlock()
	if seated {
		return nil, game.Neutral
	}

	for _, session := range sessions {
		state := session.game.Snapshot()
		color := colorForUser(state, client.profile.UserID)
		if color == game.Neutral {
			continue
		}
		server.mu.RLock()
		held := server.seatIsStillHeld(session, color, state, now)
		server.mu.RUnlock()
		if held {
			return session, color
		}
	}
	return nil, game.Neutral
}

// seatIsStillHeld reports whether a colour's seat is empty and inside its
// reconnect window. Callers hold server.mu.
func (server *Server) seatIsStillHeld(
	session *GameSession,
	color game.PlayerColor,
	state game.GameState,
	now time.Time,
) bool {
	if current, ok := server.games[session.gameID]; !ok || current != session {
		return false
	}
	if state.Status != game.InProgress {
		return false
	}
	occupant := session.redClient
	if color == game.Blue {
		occupant = session.blueClient
	}
	if occupant != nil {
		return false
	}
	deadline := session.reconnectDeadline(color, state)
	// A zero deadline is a seat that was never occupied and is not being held
	// for anybody — the far side of an unbegun game. resumeBotGames has no
	// business filling one of those; startConfiguredMatch already decided who
	// sits there.
	return !deadline.IsZero() && now.Before(deadline)
}

// logEngineLeftGame records an engine dropping out of a game it was playing,
// with how long it has to come back.
//
// Worth a line of its own because it is the shape of a whole class of reports
// — "my bot lost a game it was winning" — and the log is where the answer is:
// the socket went away at this time, and either a reconnect landed inside the
// window or the sweep called it.
func (server *Server) logEngineLeftGame(
	client *Client,
	participant *Participant,
	deadline time.Time,
) {
	if !client.isBot() {
		return
	}
	log.Printf(
		"bot %s left game %s; holding its seat for %s",
		client.profile.Username,
		participant.session.gameID,
		time.Until(deadline).Round(time.Second),
	)
}
