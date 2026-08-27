package game

import (
	"strings"
	"testing"
)

// A mode on a board that is neither nine wide nor square, so nothing about it
// can accidentally pass because 9 was hard-coded somewhere.
//
// Standard movement and capture, and Total War's annihilation rule, over five
// files and seven ranks. Red starts on rank 1 and Blue on rank 7, both pushed
// left of centre, so the layout does not mirror either — which is the other
// thing an assumption about the board could get away with on a symmetric one.
const rectangleModeID ModeID = "rectangle-test"

var rectangleStartingPosition = MustStartingPosition(
	"RPS..",
	".....",
	".....",
	".....",
	".....",
	".....",
	"rps..",
)

type rectangleTestMode struct {
	rules standardRPSRules
}

func (*rectangleTestMode) Definition() ModeDefinition {
	return ModeDefinition{
		ID:               rectangleModeID,
		ShortCode:        "RECT",
		Name:             "Rectangle Test",
		Description:      "Test-only mode on a five by seven board.",
		Objective:        "Annihilate the enemy.",
		DisplayOrder:     98,
		Playable:         true,
		Features:         []ModeFeature{},
		StartingPosition: rectangleStartingPosition,
	}
}

func (mode *rectangleTestMode) Initialize(state *GameState) {
	mode.rules.initializeBoard(state, rectangleStartingPosition)
}

func (mode *rectangleTestMode) ValidMoves(
	state GameState,
	player PlayerColor,
	from Position,
) []Position {
	return mode.rules.validMoves(state, player, from)
}

func (mode *rectangleTestMode) Move(
	state *GameState,
	player PlayerColor,
	from Position,
	to Position,
) error {
	if err := mode.rules.movePiece(state, player, from, to); err != nil {
		return err
	}
	if countPieces(state.Grid, OtherColor(player)) == 0 {
		mode.rules.finish(state, player, EndReasonAnnihilation)
		return nil
	}
	mode.rules.passTurn(state, player)
	return nil
}

func rectangleGame(t *testing.T) *Game {
	t.Helper()
	registry := NewModeRegistry()
	registry.MustRegister(func() GameMode { return &rectangleTestMode{} })
	game, err := NewGameWithRegistry(
		registry,
		"rectangle-game",
		rectangleModeID,
		PlayerProfile{UserID: "red"},
		PlayerProfile{UserID: "blue"},
	)
	if err != nil {
		t.Fatal(err)
	}
	return game
}

func TestAModeMayBeAnyRectangle(t *testing.T) {
	state := rectangleGame(t).Snapshot()
	if state.Grid.Width() != 5 || state.Grid.Height() != 7 {
		t.Fatalf("board is %d by %d, expected 5 by 7", state.Grid.Width(), state.Grid.Height())
	}
	for y, row := range state.Grid {
		if len(row) != 5 {
			t.Fatalf("rank %d holds %d tiles, expected 5", y+1, len(row))
		}
		for x, tile := range row {
			if tile.X != x || tile.Y != y {
				t.Fatalf("tile (%d, %d) carries coordinates (%d, %d)", x, y, tile.X, tile.Y)
			}
		}
	}
	if got := state.Grid.At(Position{X: 0, Y: 0}).Occupant; got != Rock {
		t.Fatalf("a1 holds %s, expected the Blue rock the layout puts there", got)
	}
}

// Movement must stop at the real edges, not at file i or rank 9.
func TestLegalMovesRespectTheBoardsOwnEdges(t *testing.T) {
	game := rectangleGame(t)
	// Rank 1 is Blue's home boundary, so Red's corner rock stands on a7.
	corner := game.ValidMoves(Red, Position{X: 0, Y: 6})
	for _, to := range corner {
		if !game.Snapshot().Grid.Contains(to) {
			t.Fatalf("a7 may move to %v, which is off a 5 by 7 board", to)
		}
	}
	// a7 is a corner: three neighbours, one of them holding a friendly paper.
	if len(corner) != 2 {
		t.Fatalf("the corner rock has %d moves, expected 2: %v", len(corner), corner)
	}
	// The far corner of the board exists and the rank above it does not.
	state := game.Snapshot()
	if !state.Grid.Contains(Position{X: 4, Y: 6}) {
		t.Fatal("e7 should be on a 5 by 7 board")
	}
	if state.Grid.Contains(Position{X: 4, Y: 7}) {
		t.Fatal("e8 is off a 5 by 7 board")
	}
	if state.Grid.Contains(Position{X: 5, Y: 6}) {
		t.Fatal("f7 is off a 5 by 7 board")
	}
}

// The stalemate and repetition rules the engine gives every mode have to work
// off the board's own shape too: both walk every tile.
func TestEngineRulesFollowTheBoardShape(t *testing.T) {
	game := rectangleGame(t)
	if !game.HasLegalMove() {
		t.Fatal("the opening position of a 5 by 7 board has moves")
	}
	// Shuffling one rock back and forth reaches the same position three times.
	for range 2 {
		if _, err := game.Move(Red, Position{X: 0, Y: 6}, Position{X: 0, Y: 5}); err != nil {
			t.Fatal(err)
		}
		if _, err := game.Move(Blue, Position{X: 0, Y: 0}, Position{X: 0, Y: 1}); err != nil {
			t.Fatal(err)
		}
		if _, err := game.Move(Red, Position{X: 0, Y: 5}, Position{X: 0, Y: 6}); err != nil {
			t.Fatal(err)
		}
		state, err := game.Move(Blue, Position{X: 0, Y: 1}, Position{X: 0, Y: 0})
		if err != nil {
			t.Fatal(err)
		}
		if state.Status == Finished {
			if state.EndReason != EndReasonRepetition {
				t.Fatalf("game ended as %s, expected repetition", state.EndReason)
			}
			return
		}
	}
	t.Fatal("the third repetition of a position did not end the game")
}

// A snapshot has to survive the next move. The fixed array this replaced gave
// that away for free; a slice does not, so it is worth a test of its own.
func TestASnapshotIsNotTheLiveBoard(t *testing.T) {
	game := rectangleGame(t)
	before := game.Snapshot()
	if _, err := game.Move(Red, Position{X: 0, Y: 6}, Position{X: 0, Y: 5}); err != nil {
		t.Fatal(err)
	}
	if before.Grid.At(Position{X: 0, Y: 6}).Occupant != Rock {
		t.Fatal("playing a move rewrote a snapshot taken before it")
	}
	if before.Grid.At(Position{X: 0, Y: 5}).Occupant != Empty {
		t.Fatal("playing a move rewrote a snapshot taken before it")
	}
}

// A mode is handed a copy when it is only being asked a question. Nothing in
// the shipped modes writes to the board in ValidMoves, and this is what keeps
// a mode that does from corrupting a live game rather than failing its own test.
func TestAskingAModeForMovesCannotChangeTheBoard(t *testing.T) {
	registry := NewModeRegistry()
	registry.MustRegister(func() GameMode { return &vandalTestMode{} })
	game, err := NewGameWithRegistry(
		registry, "vandal", vandalModeID,
		PlayerProfile{UserID: "red"}, PlayerProfile{UserID: "blue"},
	)
	if err != nil {
		t.Fatal(err)
	}
	game.ValidMoves(Red, Position{X: 0, Y: 0})
	if got := game.Snapshot().Grid.At(Position{X: 4, Y: 4}).Occupant; got != Empty {
		t.Fatalf("a mode wrote %s onto the live board from ValidMoves", got)
	}
}

const vandalModeID ModeID = "vandal-test"

type vandalTestMode struct{ rules standardRPSRules }

func (*vandalTestMode) Definition() ModeDefinition {
	return ModeDefinition{
		ID:               vandalModeID,
		ShortCode:        "VAN",
		Name:             "Vandal Test",
		StartingPosition: totalWarStartingPosition,
	}
}

func (mode *vandalTestMode) Initialize(state *GameState) {
	mode.rules.initializeBoard(state, totalWarStartingPosition)
}

func (mode *vandalTestMode) ValidMoves(state GameState, player PlayerColor, from Position) []Position {
	state.Grid[4][4].Occupant = Rock
	return mode.rules.validMoves(state, player, from)
}

func (mode *vandalTestMode) Move(state *GameState, player PlayerColor, from, to Position) error {
	return mode.rules.movePiece(state, player, from, to)
}

func TestBoardSizeBounds(t *testing.T) {
	for _, testCase := range []struct {
		width, height int
		valid         bool
	}{
		{9, 9, true},
		{5, 7, true},
		{MinBoardSide, MinBoardSide, true},
		{MaxBoardSide, 13, true},
		{2, 9, false},
		{9, 2, false},
		{MaxBoardSide + 1, 3, false},
		// 26 by 26 is 676 tiles, past the cap even though both sides are legal.
		{MaxBoardSide, MaxBoardSide, false},
	} {
		err := ValidateBoardSize(testCase.width, testCase.height)
		if testCase.valid != (err == nil) {
			t.Fatalf("%dx%d: valid=%v, err=%v", testCase.width, testCase.height, testCase.valid, err)
		}
	}
}

// The layout round-trips through the board it paints, whatever shape it is.
func TestStartingPositionRoundTripsThroughAnyBoard(t *testing.T) {
	for _, position := range []StartingPosition{
		totalWarStartingPosition,
		rectangleStartingPosition,
		MustStartingPosition("rps", "...", "RPS"),
	} {
		state := GameState{}
		standardRPSRules{}.initializeBoard(&state, position)
		if got := StartingPositionFrom(state.Grid); got != position {
			t.Fatalf("layout %q painted and read back as %q", position.Layout, got.Layout)
		}
	}
}

// The JSON shape is the fixed array's, not the string the type stores.
func TestStartingPositionKeepsItsWireShape(t *testing.T) {
	encoded, err := rectangleStartingPosition.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(encoded), `{"rows":["RPS..","`) {
		t.Fatalf("starting position marshalled as %s", encoded)
	}
	var decoded StartingPosition
	if err := decoded.UnmarshalJSON(encoded); err != nil {
		t.Fatal(err)
	}
	if decoded != rectangleStartingPosition {
		t.Fatalf("round trip gave %q, expected %q", decoded.Layout, rectangleStartingPosition.Layout)
	}
}

// A mode owns its board. A position somebody drew is a different arrangement of
// the same squares, and a board of another shape is refused rather than played
// on — otherwise every rule a mode states about a rank would answer for the
// wrong board.
func TestACustomBoardMustBeTheModesShape(t *testing.T) {
	mode := &rectangleTestMode{}
	definition := mode.Definition()
	setup := StandardSetup(definition).Normalize(definition)
	if err := setup.ValidateForMode(mode); err != nil {
		t.Fatalf("the mode's own opening was refused: %v", err)
	}

	// Same shape, pieces moved: allowed.
	rearranged := setup
	rearranged.StartingPosition = MustStartingPosition(
		"..RPS", ".....", ".....", ".....", ".....", ".....", "..rps",
	)
	if err := rearranged.ValidateForMode(mode); err != nil {
		t.Fatalf("a redrawn board of the right shape was refused: %v", err)
	}

	// A nine by nine board, which is a valid position and the wrong board.
	wrongShape := setup
	wrongShape.StartingPosition = totalWarStartingPosition
	if err := wrongShape.ValidateForMode(mode); err == nil {
		t.Fatal("a 9 by 9 board was accepted for a 5 by 7 mode")
	}
}
