package game

import (
	"math/rand/v2"
	"testing"
)

// The enumerator and the stalemate scan must never disagree: one is the
// authority on what can be played and the other decides whether the game is
// over, so a divergence would end games that were still alive.
func TestLegalMovesAgreeWithTheStalemateScan(t *testing.T) {
	for _, modeID := range DefaultModeRegistry.IDs() {
		instance, err := NewGameWithRegistry(DefaultModeRegistry, "legal-"+string(modeID), modeID,
			PlayerProfile{UserID: "red"}, PlayerProfile{UserID: "blue"})
		if err != nil {
			t.Fatalf("%s: new game: %v", modeID, err)
		}
		random := rand.New(rand.NewPCG(7, 11))
		for ply := 0; ply < 60; ply++ {
			state := instance.Snapshot()
			if state.Status != InProgress {
				break
			}
			moves := instance.LegalMoves()
			if instance.HasLegalMove() != (len(moves) > 0) {
				t.Fatalf(
					"%s ply %d: HasLegalMove says %v but the enumerator found %d moves",
					modeID, ply, instance.HasLegalMove(), len(moves),
				)
			}
			if len(moves) == 0 {
				break
			}
			// Every enumerated move must actually be playable, which is the
			// other half of the contract: the list is sent to engines as the
			// authoritative statement of legality.
			for _, move := range moves {
				if !containsPosition(instance.ValidMoves(state.CurrentTurn, move.From), move.To) {
					t.Fatalf("%s: enumerated %v which ValidMoves rejects", modeID, move)
				}
			}
			choice := moves[random.IntN(len(moves))]
			if _, err := instance.Move(state.CurrentTurn, choice.From, choice.To); err != nil {
				t.Fatalf("%s: enumerated move %v was rejected: %v", modeID, choice, err)
			}
		}
	}
}

// A seeded opening is only reproducible if "the nth legal move" is stable.
func TestLegalMovesAreReturnedInAStableOrder(t *testing.T) {
	first, err := NewGameWithRegistry(DefaultModeRegistry, "order-1", ModeTotalWar,
		PlayerProfile{UserID: "red"}, PlayerProfile{UserID: "blue"})
	if err != nil {
		t.Fatalf("new game: %v", err)
	}
	second, err := NewGameWithRegistry(DefaultModeRegistry, "order-2", ModeTotalWar,
		PlayerProfile{UserID: "red"}, PlayerProfile{UserID: "blue"})
	if err != nil {
		t.Fatalf("new game: %v", err)
	}
	left, right := first.LegalMoves(), second.LegalMoves()
	if len(left) == 0 {
		t.Fatal("the opening position must have moves")
	}
	if len(left) != len(right) {
		t.Fatalf("same position gave %d and %d moves", len(left), len(right))
	}
	for index := range left {
		if left[index] != right[index] {
			t.Fatalf("move %d differs: %v then %v", index, left[index], right[index])
		}
	}
	// Board order, so a human reading a seeded opening can find the move.
	for index := 1; index < len(left); index++ {
		previous, current := left[index-1].From, left[index].From
		if current.Y < previous.Y || (current.Y == previous.Y && current.X < previous.X) {
			t.Fatalf("moves are not in board order at %d: %v then %v", index, previous, current)
		}
	}
}

func TestLegalMovesForTheIdleSideDoesNotPanic(t *testing.T) {
	instance, err := NewGameWithRegistry(DefaultModeRegistry, "idle", ModeInfiltration,
		PlayerProfile{UserID: "red"}, PlayerProfile{UserID: "blue"})
	if err != nil {
		t.Fatalf("new game: %v", err)
	}
	// Red moves first; asking about Blue is a question a caller may reasonably
	// ask and must not be a crash.
	_ = instance.LegalMovesFor(Blue)
	if len(instance.LegalMovesFor(Red)) == 0 {
		t.Fatal("Red has moves in the opening position")
	}
}

func containsPosition(positions []Position, target Position) bool {
	for _, position := range positions {
		if position == target {
			return true
		}
	}
	return false
}
