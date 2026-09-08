package game

import (
	"math/rand/v2"
	"testing"
	"time"
)

// halfTurnTestPlies caps a random game. Loose, because the point is to reach a
// finish -- an unfinished game tests the movement rules and leaves the win
// conditions, which are where a colour could be baked in, unmirrored. The
// seeded games here take 202, 323 and 983 plies; Intransitive is the long one
// because it has no draw and a one-tile goal, so random play wanders.
const halfTurnTestPlies = 20000

// The half turn is claimed to be a symmetry of every mode's rules, which is
// what lets the opening statistics count a game recorded before Blue moved
// first. This plays a random game and its image side by side and insists they
// stay images of each other, move for move, to the same result.
//
// The image cannot be an ordinary game -- it opens with Red, which is what a
// game from before 2026-09-03 looks like and is no longer legal to start --
// so it is set up from its own initial position with Red to move. That is
// exactly the shape of the archived records this symmetry exists to read.
func TestHalfTurnPlaysTheSameGame(t *testing.T) {
	for _, modeID := range DefaultModeRegistry.IDs() {
		t.Run(string(modeID), func(t *testing.T) {
			mode, err := DefaultModeRegistry.New(modeID)
			if err != nil {
				t.Fatal(err)
			}
			if !mode.Definition().StartingPosition.HalfTurnSwapsColors() {
				t.Skipf("%s is not balanced under a half turn", modeID)
			}
			played, turned := halfTurnGamePair(t, modeID)
			random := rand.New(rand.NewPCG(1, uint64(len(modeID))))

			for ply := 0; ply < halfTurnTestPlies; ply++ {
				state := played.Snapshot()
				if state.Status != InProgress {
					break
				}
				moves := played.LegalMoves()
				if len(moves) == 0 {
					break
				}
				move := moves[random.IntN(len(moves))]
				if _, err := played.Move(state.CurrentTurn, move.From, move.To); err != nil {
					t.Fatalf("ply %d: %v", ply, err)
				}
				grid := state.Grid
				image := Move{
					From: HalfTurnSquare(grid.Width(), grid.Height(), move.From),
					To:   HalfTurnSquare(grid.Width(), grid.Height(), move.To),
				}
				mirrored := swapColor(state.CurrentTurn)
				if _, err := turned.Move(mirrored, image.From, image.To); err != nil {
					t.Fatalf(
						"ply %d: %s played %v in the game but %s cannot play %v in its image: %v",
						ply, state.CurrentTurn, move, mirrored, image, err,
					)
				}
				assertHalfTurnImage(t, ply, played.Snapshot(), turned.Snapshot())
			}
			// A test that never reached a finish would pass on the movement
			// rules alone, and the win conditions are the interesting half.
			if played.Snapshot().Status != Finished {
				t.Fatalf("%d plies of random play did not finish a game", halfTurnTestPlies)
			}
		})
	}
}

// halfTurnGamePair is one game and the board it becomes under the half turn,
// the second one set up with Red to move.
func halfTurnGamePair(t *testing.T, modeID ModeID) (*Game, *Game) {
	t.Helper()
	players := []PlayerProfile{{UserID: "red"}, {UserID: "blue"}}
	// An hour each, because the clock is real here and a timeout would read as
	// a rules difference.
	control := TimeControl{InitialTimeMs: int64(time.Hour / time.Millisecond)}
	played, err := NewGameWithRegistryAndTimeControl(
		DefaultModeRegistry, "half-turn", modeID, players[0], players[1], control,
	)
	if err != nil {
		t.Fatal(err)
	}
	turned, err := newGame(
		DefaultModeRegistry, "half-turn-image", modeID, players[0], players[1], control,
		gameOptions{initialPosition: &InitialPosition{
			Grid:        HalfTurnGrid(played.Snapshot().Grid),
			CurrentTurn: swapColor(FirstToMove),
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	assertHalfTurnImage(t, 0, played.Snapshot(), turned.Snapshot())
	return played, turned
}

func assertHalfTurnImage(t *testing.T, ply int, state, image GameState) {
	t.Helper()
	if want := HalfTurnGrid(state.Grid); !image.Grid.Equal(want) {
		t.Fatalf("ply %d: the image board is not the turned board\n got %s\nwant %s",
			ply, image.Grid.Key(), want.Key())
	}
	if image.CurrentTurn != swapColor(state.CurrentTurn) {
		t.Fatalf("ply %d: %s to move in the image, want %s",
			ply, image.CurrentTurn, swapColor(state.CurrentTurn))
	}
	if image.Status != state.Status || image.EndReason != state.EndReason {
		t.Fatalf("ply %d: the image ended %s/%s, want %s/%s",
			ply, image.Status, image.EndReason, state.Status, state.EndReason)
	}
	if image.Winner != swapColor(state.Winner) {
		t.Fatalf("ply %d: the image was won by %s, want %s",
			ply, image.Winner, swapColor(state.Winner))
	}
}
