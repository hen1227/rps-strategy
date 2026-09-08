package server

import (
	"context"
	"strings"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/notation"
	"rps-strategy/backend/internal/persistence"
)

// The position a pair of series games starts from.
//
// Two engines from the same starting position play the same game every time,
// which measures nothing. Varying the opening fixes that, and playing each
// opening twice with the colours swapped cancels both the opening's own bias
// and the first-move advantage. That is the same scheme `RPSFish/src/bin/arena.rs`
// and `frontend/engine/botArena.js` already use; this is the server-side
// version so the games are real, watchable, and archived.
//
// Where the variety comes from is the part worth reading. A walk of random
// legal moves varies the opening, but what it produces is a position nobody
// has ever played and the engine has never looked at -- so a series measured
// twenty of those was measuring twenty curiosities. The published book is full
// of openings the engine did look at, so the deal comes from there: a seeded
// walk down the graph in `opening_positions` / `opening_edges`, choosing among
// the moves it ranked at each position. The random walk survives underneath as
// the fallback for a mode whose book has not been imported yet.

// splitMix64 is the generator the rest of the project already agreed on.
//
// Ported from `RPSFish/src/selfplay.rs`, which `frontend/engine/botEngine.js`
// also mirrors. Sharing the algorithm means a seed names the same sequence in
// Go, Rust, and JavaScript, so an opening found in one place can be reproduced
// in the others.
type splitMix64 struct{ state uint64 }

func newSplitMix64(seed uint64) *splitMix64 { return &splitMix64{state: seed} }

func (generator *splitMix64) next() uint64 {
	generator.state += 0x9e3779b97f4a7c15
	value := generator.state
	value = (value ^ (value >> 30)) * 0xbf58476d1ce4e5b9
	value = (value ^ (value >> 27)) * 0x94d049bb133111eb
	return value ^ (value >> 31)
}

// below returns a value in [0, bound).
func (generator *splitMix64) below(bound int) int {
	if bound <= 0 {
		return 0
	}
	return int(generator.next() % uint64(bound))
}

// openingWalkAttempts bounds the retries when a seed produces an opening that
// decides the game before either engine has moved.
const openingWalkAttempts = 32

// buildOpening walks `plies` random legal moves from a mode's starting board.
//
// The fallback under dealOpening, for a mode with no published book. Kept
// because a book is something a mode acquires rather than something it has:
// a new mode, or a rebuilt one whose scan has not been imported yet, still has
// to be able to run a series.
//
// The walk happens on a throwaway game rather than the one about to be played,
// so a seed that ends the game costs nothing and can simply be rejected. An
// opening that decided or stalemated the position would not be an opening at
// all — both engines would be handed a finished game.
func buildOpening(
	registry *game.ModeRegistry,
	modeID game.ModeID,
	seed uint64,
	plies int,
) ([]game.Move, uint64, bool) {
	if plies <= 0 {
		return nil, seed, true
	}
	generator := newSplitMix64(seed)
	for attempt := 0; attempt < openingWalkAttempts; attempt++ {
		attemptSeed := generator.next()
		if moves, ok := walkOpening(registry, modeID, attemptSeed, plies); ok {
			return moves, attemptSeed, true
		}
	}
	return nil, seed, false
}

func walkOpening(
	registry *game.ModeRegistry,
	modeID game.ModeID,
	seed uint64,
	plies int,
) ([]game.Move, bool) {
	// A generous time control: the scratch game's clock is never consumed, but
	// TimeControl.Validate insists on a positive allowance.
	scratch, err := game.NewGameWithRegistryAndTimeControl(
		registry, "opening-walk", modeID,
		game.PlayerProfile{UserID: "walk-red"},
		game.PlayerProfile{UserID: "walk-blue"},
		game.TimeControl{InitialTimeMs: int64(time.Hour / time.Millisecond)},
	)
	if err != nil {
		return nil, false
	}
	generator := newSplitMix64(seed)
	moves := make([]game.Move, 0, plies)
	for range plies {
		state := scratch.Snapshot()
		if state.Status != game.InProgress {
			return nil, false
		}
		legal := scratch.LegalMoves()
		if len(legal) == 0 {
			return nil, false
		}
		choice := legal[generator.below(len(legal))]
		if _, err := scratch.Move(state.CurrentTurn, choice.From, choice.To); err != nil {
			return nil, false
		}
		moves = append(moves, choice)
	}
	if scratch.Snapshot().Status != game.InProgress {
		return nil, false
	}
	return moves, true
}

// openingBookChoices is how many of a position's ranked moves a dealt opening
// picks between.
//
// The book has already done most of this narrowing: an export keeps only the
// best few moves out of each position, so at every position but one this cap
// does not bind at all. The one it does bind on is the root, where the whole
// legal move list survives -- 23 of them in V3, running from +9 down to -25 --
// and six is where that list stops being moves anybody would open with.
const openingBookChoices = 6

// openingBookDecisive is the engine's MATE_THRESHOLD, from
// `RPSFish/src/search.rs`. A move scored past it is a forced win or a forced
// loss rather than a position, and a series that opened on one would be
// handing two engines a finished game to play out.
//
// Deliberately the one number here that comes from the engine, and deliberately
// a structural one rather than a fitted one: re-tuning the evaluation moves
// every score in the book, but not the score that means mate. A window like
// "within 40 of the best move" would have to be refitted alongside the weights,
// and nothing would fail when it wasn't.
const openingBookDecisive = 29_000

// dealOpening chooses the opening for one pair, from the book where there is
// one.
//
// Returns the seed that produced the opening, which is not always the seed
// asked for: a rejected walk costs a draw from the generator. Reproducing a
// dealt opening from its seed also needs the book it was dealt from, since a
// re-imported scan can rank the same position differently -- which is why the
// archive stores the line itself and not only the seed.
func (server *Server) dealOpening(
	ctx context.Context,
	modeID game.ModeID,
	seed uint64,
	plies int,
) ([]game.Move, uint64, bool) {
	if plies <= 0 {
		return nil, seed, true
	}
	meta, err := server.data.OpeningGraph(ctx, string(modeID))
	if err == nil && meta.RootKey != "" {
		generator := newSplitMix64(seed)
		for attempt := 0; attempt < openingWalkAttempts; attempt++ {
			attemptSeed := generator.next()
			moves, ok := server.walkOpeningBook(ctx, modeID, meta.RootKey, attemptSeed, plies)
			if ok {
				return moves, attemptSeed, true
			}
		}
	}
	// No book for this mode, or a book that could not serve this many plies.
	// The random walk is handed the seed that was asked for rather than what
	// the attempts above left behind, so a mode without a book deals exactly
	// what it dealt before the book existed.
	return buildOpening(server.registry, modeID, seed, plies)
}

// walkOpeningBook walks the published graph, choosing among the moves the
// engine ranked at each position it passes through.
//
// The scratch game is what keeps this honest. The graph is a record of what
// some engine build searched, and this server is the one that owns the rules:
// a move the book lists but the rules refuse fails the walk here rather than
// being played into a real game.
func (server *Server) walkOpeningBook(
	ctx context.Context,
	modeID game.ModeID,
	rootKey string,
	seed uint64,
	plies int,
) ([]game.Move, bool) {
	// A generous time control, for the same reason walkOpening needs one: the
	// scratch game's clock is never consumed, but TimeControl.Validate insists
	// on a positive allowance.
	scratch, err := game.NewGameWithRegistryAndTimeControl(
		server.registry, "opening-walk", modeID,
		game.PlayerProfile{UserID: "walk-red"},
		game.PlayerProfile{UserID: "walk-blue"},
		game.TimeControl{InitialTimeMs: int64(time.Hour / time.Millisecond)},
	)
	if err != nil {
		return nil, false
	}
	generator := newSplitMix64(seed)
	moves := make([]game.Move, 0, plies)
	key := rootKey
	for ply := range plies {
		state := scratch.Snapshot()
		if state.Status != game.InProgress {
			return nil, false
		}
		position, err := server.data.OpeningPositionAt(ctx, string(modeID), key)
		if err != nil {
			return nil, false
		}
		// A line's last move only has to be one the engine ranked; every move
		// before it needs a position stored behind it, because that is what
		// the walk steps into next. Four edges in ten are frontier edges, so
		// requiring a child of the last one would throw away most of the book
		// at exactly the depth an opening ends.
		candidates := soundOpeningMoves(position.Moves, ply == plies-1)
		if len(candidates) == 0 {
			return nil, false
		}
		choice := candidates[generator.below(len(candidates))]
		move, ok := parseOpeningBookMove(choice.Move)
		if !ok {
			return nil, false
		}
		if _, err := scratch.Move(state.CurrentTurn, move.From, move.To); err != nil {
			return nil, false
		}
		moves = append(moves, move)
		key = choice.Child
	}
	if scratch.Snapshot().Status != game.InProgress {
		return nil, false
	}
	return moves, true
}

// soundOpeningMoves narrows a position's ranked moves to the ones worth
// handing two engines to start from.
//
// The rank cap is read off the book's own ranking rather than counting
// survivors, so a move the book ranked tenth cannot be reached by the ones
// above it being unusable. Fewer candidates is the right answer there: the
// walk is rejected, and the next seed tries a different position.
func soundOpeningMoves(
	ranked []persistence.OpeningMove,
	last bool,
) []persistence.OpeningMove {
	candidates := make([]persistence.OpeningMove, 0, openingBookChoices)
	for _, move := range ranked {
		if move.Rank > openingBookChoices {
			continue
		}
		if move.Score >= openingBookDecisive || move.Score <= -openingBookDecisive {
			continue
		}
		if !last && move.Child == "" {
			continue
		}
		candidates = append(candidates, move)
	}
	return candidates
}

// parseOpeningBookMove reads a book move, "d8-c7", as a move on the board.
//
// Split on the dash rather than at a fixed offset: a board with ten ranks
// writes "d10-c9", and the book's own notation has room for it.
func parseOpeningBookMove(text string) (game.Move, bool) {
	origin, destination, found := strings.Cut(text, "-")
	if !found {
		return game.Move{}, false
	}
	from, err := notation.ParseSquare(origin)
	if err != nil {
		return game.Move{}, false
	}
	to, err := notation.ParseSquare(destination)
	if err != nil {
		return game.Move{}, false
	}
	return game.Move{From: from, To: to}, true
}

// replayOpeningLine reports whether a line is legal from a mode's own start.
//
// The check a *nameable* line needs, and deliberately not the check
// `openingBookForLine` makes. That one asks whether the engine analyzed the
// line, which is the right question for the explorer and the wrong one for
// naming: the whole point of letting players name openings is that the
// interesting ones are often the lines RPSFish never looked at. What matters
// here is that the moves are moves -- that somebody could sit down and play
// them -- and the rules are what own that answer.
//
// A line that ends the game is refused. A finished game is not an opening, and
// naming one would put a name on a position no opening can continue from.
func replayOpeningLine(
	registry *game.ModeRegistry,
	modeID game.ModeID,
	line []string,
) bool {
	scratch, err := game.NewGameWithRegistryAndTimeControl(
		registry, "opening-name", modeID,
		game.PlayerProfile{UserID: "name-red"},
		game.PlayerProfile{UserID: "name-blue"},
		game.TimeControl{InitialTimeMs: int64(time.Hour / time.Millisecond)},
	)
	if err != nil {
		return false
	}
	for _, text := range line {
		movement, ok := parseOpeningBookMove(text)
		if !ok {
			return false
		}
		state := scratch.Snapshot()
		if state.Status != game.InProgress {
			return false
		}
		if _, err := scratch.Move(state.CurrentTurn, movement.From, movement.To); err != nil {
			return false
		}
	}
	return scratch.Snapshot().Status == game.InProgress
}
