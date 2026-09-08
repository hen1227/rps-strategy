package server

import (
	"context"
	"sync"

	"rps-strategy/backend/internal/persistence"
)

// Holding an engine for a tournament it has entered.
//
// A bot event is a round robin between programs that are also sitting on the
// public ladder taking challenges from anybody. Without this, the second half
// eats the first: an engine allowed one game at a time finishes its round-two
// match, is immediately challenged by somebody browsing the bots page, and is
// then unavailable for round three. A four-engine event stops making progress
// because its competitors keep being borrowed.
//
// So an engine entered in a running tournament is **in reserve**: still
// connected, still idle, still visible — and not available for anything except
// its own scheduled matches. That is the state a substitute is in, which is why
// it is called that, and it lasts until the event finishes rather than until
// the engine's last match is played. An engine that has finished its own games
// early is exactly the one most likely to be sitting there when a replay or a
// re-paired round needs it.
//
// # Why this is not folded into botIsDraining
//
// botIsDraining is documented as "the question every path that could hand an
// engine a new game asks", and adding a fourth reason to it would close every
// such path for free. It is also precisely wrong here: the whole point of a
// reservation is that *tournament* pairings still go through. Reserve is a
// narrower answer asked at the two doors that lead somewhere else — a challenge
// and a series — and nowhere near the pairing code.
//
// # Why it is cached
//
// Knowing whether an engine is reserved means knowing which tournaments are
// running and who is in them, which is several SQLite reads. botRoster is
// called on every lobby broadcast, so the answer is computed on the lobby
// ticker and held. The staleness that buys is bounded by one tick, and the
// worst it can do is let one challenge through in the couple of seconds after
// an event starts — which is why every path that changes an event's status also
// refreshes it directly.

// reservationBoard is which bot accounts are being held, and for what.
type reservationBoard struct {
	mu sync.RWMutex
	// byUserID maps a bot's *account* id — not its bot id — to the name of the
	// event holding it. The account id is what a tournament signup records, and
	// what every caller here has to hand.
	byUserID map[string]string
}

// refreshBotReservations recomputes which engines are being held.
//
// Called from the lobby ticker and from every path that starts, cancels or
// finishes an event. Cheap when nothing is running, which is nearly always: the
// only work in that case is one query returning a handful of rows.
func (server *Server) refreshBotReservations() {
	tournaments, err := server.data.Tournaments(context.Background())
	if err != nil {
		// Left as it was rather than cleared. An unreadable tournament table is
		// not evidence that nobody is in an event, and releasing every engine
		// on the strength of it is the wrong way to be wrong.
		return
	}
	held := make(map[string]string)
	for _, tournament := range tournaments {
		if tournament.Status != persistence.TournamentInProgress {
			continue
		}
		for _, player := range tournament.Players {
			// Every entrant, not only the ones with matches left. See the note
			// above about why a finished competitor stays in reserve.
			held[player.UserID] = tournament.Name
		}
	}
	server.reservations.mu.Lock()
	server.reservations.byUserID = held
	server.reservations.mu.Unlock()
}

// botReservation returns the name of the event holding a bot account, or empty
// when nothing is.
//
// Answers for human accounts too, and always empty for them in practice: a
// person in a tournament is not prevented from playing casual games, because a
// person can be told to come back for their round and an engine cannot.
func (server *Server) botReservation(userID string) string {
	if userID == "" {
		return ""
	}
	server.reservations.mu.RLock()
	defer server.reservations.mu.RUnlock()
	return server.reservations.byUserID[userID]
}

// botIsReserved is the predicate form, for the two gates that only need a yes.
func (server *Server) botIsReserved(client *Client) bool {
	if client == nil || !client.isBot() {
		return false
	}
	return server.botReservation(client.account.UserID) != ""
}

// botReserveRefusal is what a challenge to a reserved engine is told.
//
// It names the event, because the answer to "why can I not play Fishy" is "it
// is in the middle of a tournament" and that is a satisfying answer rather than
// a mysterious one. It also says the engine is fine, since the shape of the
// refusal otherwise reads like the ones about a bot that is broken.
func botReserveRefusal(name string, tournament string) string {
	return name + " is in reserve for " + tournament +
		" and is not taking other games until it finishes"
}
