package server

import (
	"context"

	"rps-strategy/backend/internal/persistence"
)

// One conversation for a whole bots-only event.
//
// An event with people in it is many games and many rooms, and that is right:
// the people talking around a board are talking to the two players, and a room
// that reached the other boards would carry what one player's opponent is doing
// into a game being played. Chat between concurrent matches of a human event is
// coaching.
//
// A bots-only event has none of that. Nobody in it is playing — the engines are
// sent RPSI lines rather than chat, and are left out of every room's audience —
// so each board's room holds spectators only, and the site's answer to four
// simultaneous matches was four rooms with one person in each, none of whom
// could hear the others. The event is the thing being watched, so the event is
// the room: whoever is on any of its boards, live or finished, is in one
// conversation with everybody on the rest.
//
// This is the same move a bot series already makes for the games of a run, and
// for the same reason — see chat_room.go. The difference is only in the shape:
// a run's games are one after another, an event's are side by side.

// tournamentChatRoom is the conversation this event's matches belong to, or nil
// when each of its games should open a room of its own.
//
// Field rather than "are both of these seats engines". An open event can pair
// two bots in round one and two people in round two, and a room that appeared
// and vanished between rounds would be worse than either answer on its own. The
// field is fixed when the event is built and is the thing that makes the whole
// event safe to run as one room.
func (server *Server) tournamentChatRoom(tournament persistence.Tournament) *chatRoom {
	if tournament.Field != persistence.FieldBots {
		return nil
	}
	server.mu.Lock()
	defer server.mu.Unlock()
	room, open := server.tournamentChats[tournament.TournamentID]
	if !open {
		room = newScopedChatRoom(tournament.TournamentID, ChatScopeTournament)
		server.tournamentChats[tournament.TournamentID] = room
	}
	return room
}

// pruneTournamentChats forgets the room of every event that is no longer
// running, so the map does not grow for the life of the process.
//
// Dropping the entry does not end the conversation. Whoever is still sitting in
// a finished match keeps the room through their own session, exactly as they do
// after any other game, and the last of them leaving closes it the ordinary
// way. What is dropped is the *name* a future match would join by — and a
// finished event has no future matches.
//
// Waiting for the event rather than for the room to empty is deliberate: there
// is a gap between rounds when every match is over and the next has not been
// paired, and a room forgotten in that gap would leave round two talking in a
// second room with round one's transcript missing from it.
func (server *Server) pruneTournamentChats() {
	// Cheap guard first, and the reason this can sit on the lobby ticker: the
	// map is empty on a server that has never run a bot event, and empty again
	// one tick after the last one finished. Without it this reads every
	// tournament out of SQLite twice a minute forever, over the single
	// connection the game loop also uses.
	server.mu.RLock()
	held := len(server.tournamentChats)
	server.mu.RUnlock()
	if held == 0 {
		return
	}

	tournaments, err := server.data.Tournaments(context.Background())
	if err != nil {
		// Left as it was, on the same reasoning as refreshBotReservations: an
		// unreadable tournament table is not evidence that nothing is running,
		// and splitting a live event's audience is the wrong way to be wrong.
		return
	}
	running := make(map[string]struct{}, held)
	for _, tournament := range tournaments {
		if tournament.Status == persistence.TournamentInProgress {
			running[tournament.TournamentID] = struct{}{}
		}
	}

	server.mu.Lock()
	for tournamentID := range server.tournamentChats {
		if _, live := running[tournamentID]; !live {
			delete(server.tournamentChats, tournamentID)
		}
	}
	server.mu.Unlock()
}
