package server

import (
	"time"

	"rps-strategy/backend/internal/game"
)

// Seeded random openings, for measuring one engine against another.
//
// Two engines from the same starting position play the same game every time,
// which measures nothing. Varying the opening fixes that, and playing each
// opening twice with the colours swapped cancels both the opening's own bias
// and the first-move advantage. That is the same scheme `RPSFish/src/bin/arena.rs`
// and `frontend/engine/botArena.js` already use; this is the server-side
// version so the games are real, watchable, and archived.

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
