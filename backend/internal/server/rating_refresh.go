package server

import (
	"context"
	"log"
	"sync"
	"time"
)

// When the ratings the lobby is showing catch up with the ones on record.
//
// A finished game rates its two players inside the transaction that records it,
// and the server patches the two accounts it holds in memory straight after (see
// updateSessionAccounts). Two things are left for this file, both on the lobby
// ticker that already wakes every couple of seconds:
//
//   - The roster of connected engines is broadcast to every lobby, and a pool
//     round finishes dozens of engine games within a minute. Each asks for the
//     roster to be restated, and the restatement waits ratingRosterDebounce so a
//     round lands as one broadcast rather than one per game.
//
//   - A published rating drifts down while its owner is away (see
//     persistence/rating.go), so every ratingRepublishSweep the stored numbers
//     are brought up to date with the clock, and the accounts held in memory
//     with them.
const (
	// ratingRosterDebounce is how long a finished engine game waits for the
	// games around it. Engine games are seated back to back, so a pairing that
	// finishes now is usually followed by its colour-swapped partner within a
	// few seconds, and ten seconds is far below what a person watching the
	// roster would notice.
	ratingRosterDebounce = 10 * time.Second

	// ratingRepublishSweep is how often idle ratings are restated. An hour of
	// drift is a fraction of a point for anybody settled, so nothing visible
	// ever happens between two sweeps.
	ratingRepublishSweep = time.Hour
)

// ratingRefreshState is the refresh's memory between ticks.
type ratingRefreshState struct {
	mu sync.Mutex
	// pending is whether an engine game has finished since the last roster.
	pending bool
	// lastRoster and lastSweep are the two clocks above, kept apart so that a
	// busy ladder restating its roster every ten seconds does not keep
	// postponing the sweep the idle accounts depend on.
	lastRoster time.Time
	lastSweep  time.Time
}

// requestRosterRefresh notes that an engine's rating has moved since the roster
// was last sent. Called from the completion path, which must not block on a
// broadcast; the ticker picks it up.
func (server *Server) requestRosterRefresh() {
	server.ratings.mu.Lock()
	defer server.ratings.mu.Unlock()
	server.ratings.pending = true
}

// runRatingRefresh is the ticker's entry point: a clock check almost every
// time, and a broadcast or a republish when one is due.
func (server *Server) runRatingRefresh(now time.Time) {
	// Not while a deploy is draining. Nothing here is urgent: the next process
	// rebuilds every rating as it starts, and sends every roster as engines
	// reconnect to it.
	if server.isUpdating() {
		return
	}

	server.ratings.mu.Lock()
	if server.ratings.lastSweep.IsZero() {
		// A fresh process has just rebuilt every rating at startup, so the first
		// sweep is due an hour from now rather than immediately.
		server.ratings.lastSweep = now
	}
	sweeping := now.Sub(server.ratings.lastSweep) >= ratingRepublishSweep
	broadcasting := server.ratings.pending &&
		now.Sub(server.ratings.lastRoster) >= ratingRosterDebounce
	if !sweeping && !broadcasting {
		server.ratings.mu.Unlock()
		return
	}
	if sweeping {
		server.ratings.lastSweep = now
	}
	server.ratings.pending = false
	server.ratings.lastRoster = now
	server.ratings.mu.Unlock()

	// Outside the lock: a republish is a read and a write of the whole rating
	// table, and holding anything of the server's across it would be holding it
	// across the database.
	if sweeping {
		modes, err := server.data.RepublishRatings(context.Background(), now.UnixMilli())
		if err != nil {
			// Worth saying, not worth failing over: the ratings behind the
			// numbers are on record, and the next sweep computes the same answer.
			log.Printf("republish ratings: %v", err)
		}
		if len(modes) > 0 {
			server.refreshCachedRatings(context.Background(), modes...)
		} else {
			server.broadcastBots()
		}
	} else {
		server.broadcastBots()
	}
	server.runLadderReigns(now)
}

// runLadderReigns records who is top of each mode, after whatever moved it.
//
// Here rather than on the title sweep, which is the other candidate and is
// wrong: the ticker runs runBotTitles *before* runRatingRefresh, so a reign
// filed there would be read off the board as it stood before the republish that
// changed it, and would lag every handover by a tick.
//
// Unconditional rather than only when something moved. A leader can stop being
// one without any rating moving — an engine disabled, an account deleted, a
// mode retired — and those leave nothing for the refresh to pick up. The sweep
// is two indexed reads when nothing has changed, which is cheap enough to do on
// a tick that already does a dozen small jobs.
func (server *Server) runLadderReigns(now time.Time) {
	if server.isUpdating() {
		return
	}
	changed, err := server.data.SyncBotReigns(context.Background(), now.UnixMilli())
	if err != nil {
		// The ledger is derived from the board, and the next pass computes the
		// same answer from the same rows.
		log.Printf("sync bot reigns: %v", err)
		return
	}
	// A handover is worth a line, because a reign changing hands is explained by
	// nothing in the log unless this says so. A reign continuing is the usual
	// answer and says nothing.
	for modeID, reign := range changed {
		if reign.Current {
			log.Printf("bot ladder: %s took the top of %s", reign.UserID, modeID)
			continue
		}
		log.Printf("bot ladder: %s is no longer top of %s", reign.UserID, modeID)
	}
}
