package server

import (
	"context"
	"log"
	"sync"
	"time"

	"rps-strategy/backend/internal/game"
)

// When the bot ladder is recomputed.
//
// It used to be recomputed inside the transaction that recorded a finished game,
// which was the obvious place for it and is no longer the right one. Two things
// moved it out. The fit costs a matrix inverse and the database is pinned to one
// connection, so doing it on the write path puts every other query behind it for
// as long as it takes; and a rating is now a function of the clock as well as of
// the results, because evidence decays, so there is no longer any such thing as
// the moment a rating is correct. See bot_rating.go.
//
// So it runs here instead, on the lobby ticker that already wakes up every couple
// of seconds to do a dozen small jobs, with two cadences:
//
//   - A mode with a finished engine game in it is refitted within
//     ladderRefitDebounce. This is the responsive path, and the debounce is what
//     keeps a pool round of a hundred games from being a hundred fits: they all
//     land in one.
//
//   - Every mode is refitted every ladderDecaySweep whether anything was played
//     or not, which is what makes decay actually happen. Without it an idle
//     ladder would simply be frozen, which is precisely the complaint decay
//     exists to answer.
const (
	// ladderRefitDebounce is how long a mode with new games waits.
	//
	// Ten seconds is chosen against the shape of a series rather than against
	// anybody's patience: engine games are seated back to back, so a pairing
	// that finishes now is usually followed by its colour-swapped partner within
	// a few seconds, and refitting between them would publish a number nobody
	// wanted to read. It is also far below the interval at which a person
	// watching the roster would notice a lag.
	ladderRefitDebounce = 10 * time.Second

	// ladderDecaySweep is how often the whole board is refitted regardless.
	//
	// An hour against a ninety-day half-life means a bot's evidence thins by
	// about three parts in ten thousand between sweeps, so nothing visible ever
	// happens between two of them and the published number never jumps.
	ladderDecaySweep = time.Hour
)

// ladderRefitState is the refit's memory between ticks.
type ladderRefitState struct {
	mu sync.Mutex
	// pending is the modes something has happened in since the last refit.
	pending map[game.ModeID]bool
	// lastRefit and lastSweep are the two clocks above, kept apart so that a
	// busy mode being refitted every ten seconds does not keep postponing the
	// sweep that the quiet ones depend on.
	lastRefit time.Time
	lastSweep time.Time
}

func newLadderRefitState() *ladderRefitState {
	return &ladderRefitState{pending: make(map[game.ModeID]bool)}
}

// requestLadderRefit notes that a mode's ladder is out of date.
//
// Called from the completion path, which must not block on a fit. All this does
// is set a flag; the ticker picks it up.
func (server *Server) requestLadderRefit(modeID game.ModeID) {
	server.ladder.mu.Lock()
	defer server.ladder.mu.Unlock()
	server.ladder.pending[modeID] = true
}

// runLadderRefits is the ticker's entry point: a clock check almost every time,
// and a fit when one is due.
func (server *Server) runLadderRefits(now time.Time) {
	// Not while a deploy is draining. A refit is never urgent — the next tick
	// after the new process comes up will do it — and the games it would read
	// are the games it will read then.
	if server.isUpdating() {
		return
	}

	server.ladder.mu.Lock()
	if server.ladder.lastSweep.IsZero() {
		// A fresh process has already refitted every ladder at startup, so the
		// first sweep is due an hour from now rather than immediately.
		server.ladder.lastSweep = now
	}
	sweeping := now.Sub(server.ladder.lastSweep) >= ladderDecaySweep
	refitting := len(server.ladder.pending) > 0 &&
		now.Sub(server.ladder.lastRefit) >= ladderRefitDebounce
	if !sweeping && !refitting {
		server.ladder.mu.Unlock()
		return
	}

	var modes []game.ModeID
	if sweeping {
		modes = server.ratedModeIDs()
		server.ladder.lastSweep = now
		clear(server.ladder.pending)
	} else {
		modes = make([]game.ModeID, 0, len(server.ladder.pending))
		for modeID := range server.ladder.pending {
			modes = append(modes, modeID)
			delete(server.ladder.pending, modeID)
		}
	}
	server.ladder.lastRefit = now
	server.ladder.mu.Unlock()

	// Outside the lock, and one mode at a time. Each of these is a read, a fit
	// in memory, and a write; holding anything of the server's across them would
	// be holding it across the database.
	refitted := make([]game.ModeID, 0, len(modes))
	for _, modeID := range modes {
		if err := server.data.RefitBotLadder(context.Background(), modeID); err != nil {
			// Worth saying, not worth failing over. The games are on record, the
			// ladder is derived from them, and the next pass computes the same
			// answer from the same rows.
			log.Printf("refit bot ladder for %s: %v", modeID, err)
			continue
		}
		refitted = append(refitted, modeID)
	}
	if len(refitted) > 0 {
		server.republishBotLadder(context.Background(), refitted...)
	}
	server.runLadderReigns(now)
}

// runLadderReigns records who is top of each mode, after the refit that decided
// it.
//
// Here rather than on the title sweep, which is the other candidate and is
// wrong: the ticker runs runBotTitles *before* runLadderRefits, so a reign
// filed there would be read off the board as it stood before the fit that
// changed it, and would lag every handover by a tick.
//
// Unconditional rather than only when something was refitted. A leader can stop
// being one without any rating moving — an engine disabled, an account deleted,
// a mode retired — and those leave nothing for the refit to pick up. The sweep
// is two indexed reads when nothing has changed, which is cheap enough to do on
// a tick that already does a dozen small jobs.
func (server *Server) runLadderReigns(now time.Time) {
	if server.isUpdating() {
		return
	}
	changed, err := server.data.SyncBotReigns(context.Background(), now.UnixMilli())
	if err != nil {
		// Same reading as a failed refit: the ledger is derived from the board,
		// and the next pass computes the same answer from the same rows.
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
