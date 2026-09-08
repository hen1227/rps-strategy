package game

import (
	"math/rand/v2"
	"testing"
	"time"
)

// symmetryTestPlies caps a random game, loosely and for the same reason
// halfTurnTestPlies is loose: a game that never finishes has tested the
// movement rules and left the win conditions untested, and the win conditions
// are the half a declared symmetry can be wrong about. Infiltration reaches a
// boundary quickly, Total War fills the board, and Intransitive wanders because
// it has no draw and a one-tile goal.
const symmetryTestPlies = 20000

// Every symmetry a mode declares is a claim about its *rules*, and registration
// can only check its layout. This is the other half: play a random game and its
// reflection side by side, and insist they stay reflections of each other move
// for move, to the same winner for the same reason.
//
// It is the win conditions that make this worth running. Movement is
// eight-connected and captures depend only on the two pieces, so no relabelling
// of the squares can disturb them; what a reflection can disturb is a goal that
// names a coordinate. Infiltration's is a rank, which reversing files leaves
// alone and transposing would not; Intransitive's is the pair of corners a1 and
// i9, which is exactly what the main diagonal fixes and what reversing files
// would swap. A mode that declared the wrong one of those two would fold half
// its opening statistics onto positions that are not the same position, and
// this is what would notice.
//
// Colours are untouched throughout, unlike TestHalfTurnPlaysTheSameGame: the
// image is the same side to move, playing the same colour, which is what makes
// folding safe for statistics that count Red wins and Blue wins separately.
func TestBuiltInSymmetriesPlayTheSameGame(t *testing.T) {
	for _, modeID := range DefaultModeRegistry.IDs() {
		mode, err := DefaultModeRegistry.New(modeID)
		if err != nil {
			t.Fatal(err)
		}
		declared := mode.Definition().Symmetries
		if len(declared) == 0 {
			t.Errorf("%s declares no symmetry at all", modeID)
			continue
		}
		for _, symmetry := range declared {
			t.Run(string(modeID)+"/"+string(symmetry), func(t *testing.T) {
				played, reflected := symmetryGamePair(t, modeID, symmetry)
				random := rand.New(rand.NewPCG(2, uint64(len(modeID))))

				for ply := 0; ply < symmetryTestPlies; ply++ {
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
					width, height := state.Grid.Width(), state.Grid.Height()
					image := Move{
						From: symmetry.Square(width, height, move.From),
						To:   symmetry.Square(width, height, move.To),
					}
					if _, err := reflected.Move(state.CurrentTurn, image.From, image.To); err != nil {
						t.Fatalf(
							"ply %d: %s played %v but cannot play its image %v: %v",
							ply, state.CurrentTurn, move, image, err,
						)
					}
					assertSymmetryImage(t, ply, symmetry, played.Snapshot(), reflected.Snapshot())
				}
				if played.Snapshot().Status != Finished {
					t.Fatalf("%d plies of random play did not finish a game", symmetryTestPlies)
				}
			})
		}
	}
}

// symmetryGamePair is one game and its reflection, both with the opener to
// move. The reflected board is set up explicitly rather than started fresh
// because that is the claim being tested -- a mode whose layout survives the
// relabelling starts both games from the same picture, and assertSymmetryImage
// says so before a move is played.
func symmetryGamePair(t *testing.T, modeID ModeID, symmetry BoardSymmetry) (*Game, *Game) {
	t.Helper()
	players := []PlayerProfile{{UserID: "red"}, {UserID: "blue"}}
	control := TimeControl{InitialTimeMs: int64(time.Hour / time.Millisecond)}
	played, err := NewGameWithRegistryAndTimeControl(
		DefaultModeRegistry, "symmetry", modeID, players[0], players[1], control,
	)
	if err != nil {
		t.Fatal(err)
	}
	reflected, err := newGame(
		DefaultModeRegistry, "symmetry-image", modeID, players[0], players[1], control,
		gameOptions{initialPosition: &InitialPosition{
			Grid:        symmetry.Grid(played.Snapshot().Grid),
			CurrentTurn: FirstToMove,
		}},
	)
	if err != nil {
		t.Fatal(err)
	}
	assertSymmetryImage(t, 0, symmetry, played.Snapshot(), reflected.Snapshot())
	return played, reflected
}

func assertSymmetryImage(t *testing.T, ply int, symmetry BoardSymmetry, state, image GameState) {
	t.Helper()
	if want := symmetry.Grid(state.Grid); !image.Grid.Equal(want) {
		t.Fatalf("ply %d: the image board is not the reflected board\n got %s\nwant %s",
			ply, image.Grid.Key(), want.Key())
	}
	if image.CurrentTurn != state.CurrentTurn {
		t.Fatalf("ply %d: %s to move in the image, want %s",
			ply, image.CurrentTurn, state.CurrentTurn)
	}
	if image.Status != state.Status || image.EndReason != state.EndReason {
		t.Fatalf("ply %d: the image ended %s/%s, want %s/%s",
			ply, image.Status, image.EndReason, state.Status, state.EndReason)
	}
	if image.Winner != state.Winner {
		t.Fatalf("ply %d: the image was won by %s, want %s", ply, image.Winner, state.Winner)
	}
}

// The declarations are only as good as the modes that could have made them
// wrongly, so this pins the two that a reader would most reasonably mix up:
// Intransitive is not file-symmetric and Infiltration is not diagonal, and a
// mode claiming either is refused at registration rather than folding boards
// that are genuinely different.
func TestASymmetryAModeDoesNotHaveIsRefused(t *testing.T) {
	for _, claim := range []struct {
		layout   StartingPosition
		symmetry BoardSymmetry
	}{
		{intransitiveStartingPosition, SymmetryMirrorFiles},
		{infiltrationStartingPosition, SymmetryDiagonal},
		{totalWarStartingPosition, SymmetryDiagonal},
	} {
		if claim.symmetry.PreservesLayout(claim.layout) {
			t.Errorf("%q is not a symmetry of\n%s", claim.symmetry, claim.layout.Layout)
		}
		registry := NewModeRegistry()
		layout, symmetry := claim.layout, claim.symmetry
		err := registry.Register(func() GameMode {
			return &symmetryClaimTestMode{layout: layout, symmetry: symmetry}
		})
		if err == nil {
			t.Errorf("a mode claiming %q was registered", claim.symmetry)
		}
	}
}

// A board that is not square cannot be transposed at all, and a mode is refused
// for claiming it rather than being handed a relabelling that reads off the
// edge of its own board.
func TestTheDiagonalNeedsASquareBoard(t *testing.T) {
	oblong := MustStartingPosition("RPS..", ".....", ".....", ".....", ".....", ".....", "rps..")
	if SymmetryDiagonal.FitsBoard(oblong.Width(), oblong.Height()) {
		t.Fatal("a five by seven board was reported transposable")
	}
	registry := NewModeRegistry()
	if err := registry.Register(func() GameMode {
		return &symmetryClaimTestMode{layout: oblong, symmetry: SymmetryDiagonal}
	}); err == nil {
		t.Fatal("a mode claiming the diagonal on an oblong board was registered")
	}
}

// A group is the identity plus whatever survives, so a mode that declares
// nothing still hands its callers something to iterate.
func TestSymmetryGroupAlwaysHoldsTheIdentity(t *testing.T) {
	bare := ModeDefinition{StartingPosition: totalWarStartingPosition}
	if group := bare.SymmetryGroup(); len(group) != 1 || group[0] != SymmetryNone {
		t.Fatalf("a mode with no symmetries has group %v", group)
	}
	claimed := ModeDefinition{
		StartingPosition: intransitiveStartingPosition,
		// The second is not a symmetry of this layout and is dropped: a
		// definition built at runtime never passed registration.
		Symmetries: []BoardSymmetry{SymmetryDiagonal, SymmetryMirrorFiles},
	}
	group := claimed.SymmetryGroup()
	if len(group) != 2 || group[0] != SymmetryNone || group[1] != SymmetryDiagonal {
		t.Fatalf("Intransitive's group is %v", group)
	}
}

// symmetryClaimTestMode is a mode that exists only to make a claim registration
// should refuse. Its rules are never played.
type symmetryClaimTestMode struct {
	layout   StartingPosition
	symmetry BoardSymmetry
	rules    standardRPSRules
}

func (mode *symmetryClaimTestMode) Definition() ModeDefinition {
	return ModeDefinition{
		ID:               "symmetry-claim",
		Name:             "Symmetry claim",
		StartingPosition: mode.layout,
		Symmetries:       []BoardSymmetry{mode.symmetry},
	}
}

func (mode *symmetryClaimTestMode) Initialize(state *GameState) {
	mode.rules.initializeBoard(state, mode.layout)
}

func (mode *symmetryClaimTestMode) ValidMoves(
	state GameState, player PlayerColor, from Position,
) []Position {
	return mode.rules.validMoves(state, player, from)
}

func (mode *symmetryClaimTestMode) Move(
	state *GameState, player PlayerColor, from, to Position,
) error {
	return mode.rules.movePiece(state, player, from, to)
}
