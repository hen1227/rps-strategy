package game

import (
	"strings"
	"testing"
)

func TestSquareNameSpellsTheBoardAndSaysSoWhenItCannot(t *testing.T) {
	for _, testCase := range []struct {
		position Position
		want     string
	}{
		{Position{X: 0, Y: 0}, "a1"},
		{Position{X: 3, Y: 7}, "d8"},
		{Position{X: BoardSize - 1, Y: BoardSize - 1}, "i9"},
		{Position{X: -1, Y: 0}, "??"},
		// A rank past nine is an ordinary square now: a mode may be any
		// rectangle, so the bound is MaxBoardSide rather than this board.
		{Position{X: 9, Y: 9}, "j10"},
		{Position{X: MaxBoardSide - 1, Y: MaxBoardSide - 1}, "z26"},
		{Position{X: 0, Y: MaxBoardSide}, "??"},
		{Position{X: MaxBoardSide, Y: 0}, "??"},
	} {
		if got := SquareName(testCase.position); got != testCase.want {
			t.Errorf("SquareName(%v) = %q, want %q", testCase.position, got, testCase.want)
		}
	}
}

func TestOpeningLineRecordsEveryMoveOfAStandardGame(t *testing.T) {
	game := testGame(t, ModeInfiltration)
	if line := game.Snapshot().OpeningLine; len(line) != 0 {
		t.Fatalf("a game with no moves reports the line %v", line)
	}

	var expected []string
	for ply := 0; ply < 4; ply++ {
		from, to := anyLegalMove(t, game)
		state, err := game.Move(game.state.CurrentTurn, from, to)
		if err != nil {
			t.Fatal(err)
		}
		expected = append(expected, OpeningMoveName(from, to))
		if strings.Join(state.OpeningLine, " ") != strings.Join(expected, " ") {
			t.Fatalf("after %d plies the line is %v, want %v", ply+1, state.OpeningLine, expected)
		}
	}
}

// A snapshot is sent while the next move is being played, so the line it
// carries has to be the line as it was — not a slice the game is still writing
// into.
func TestOpeningLineSnapshotsDoNotChangeUnderneathTheirReader(t *testing.T) {
	game := testGame(t, ModeInfiltration)
	from, to := anyLegalMove(t, game)
	if _, err := game.Move(game.state.CurrentTurn, from, to); err != nil {
		t.Fatal(err)
	}
	taken := game.Snapshot().OpeningLine

	from, to = anyLegalMove(t, game)
	if _, err := game.Move(game.state.CurrentTurn, from, to); err != nil {
		t.Fatal(err)
	}
	if len(taken) != 1 {
		t.Fatalf("the snapshot's line grew to %v", taken)
	}
}

func TestOpeningLineStopsAtItsLimit(t *testing.T) {
	// The rule off, because the walk below plays the first legal move it finds
	// and that shuffles: a repetition draw would end the game before the line
	// reached its limit, and this test is about the limit.
	game := setupGame(t, RuleFlags{NoRepetitionDraw: true})
	for ply := 0; ply < OpeningLineLimit+4; ply++ {
		if game.state.Status != InProgress {
			break
		}
		from, to := anyLegalMove(t, game)
		if _, err := game.Move(game.state.CurrentTurn, from, to); err != nil {
			t.Fatal(err)
		}
	}
	if line := game.Snapshot().OpeningLine; len(line) != OpeningLineLimit {
		t.Fatalf("a long game reports %d plies, want %d", len(line), OpeningLineLimit)
	}
}

// A line is measured from the mode's opening. Measured from a board somebody
// drew, the same moves would name an opening that was never played, so a
// custom game reports no line at all.
func TestCustomStartingPositionHasNoOpeningLine(t *testing.T) {
	mode, err := DefaultModeRegistry.New(ModeInfiltration)
	if err != nil {
		t.Fatal(err)
	}
	// A board somebody drew: the same pieces, one rank shifted across.
	rows := mode.Definition().StartingPosition.Rows()
	rows[0] = "..SSS...."
	custom := MustStartingPosition(rows...)

	game, err := NewGameWithRegistryTimeControlAndStartingPosition(
		DefaultModeRegistry,
		"custom",
		ModeInfiltration,
		PlayerProfile{UserID: "red"},
		PlayerProfile{UserID: "blue"},
		DefaultTimeControl(),
		&custom,
	)
	if err != nil {
		t.Fatal(err)
	}
	from, to := anyLegalMove(t, game)
	state, err := game.Move(game.state.CurrentTurn, from, to)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.OpeningLine) != 0 {
		t.Fatalf("a custom board reports the opening line %v", state.OpeningLine)
	}
}

// The same board, spelled out rather than left to the mode, is still the
// mode's opening: a challenge carries the position it was set up with even
// when nobody changed it.
func TestStandardStartingPositionPassedExplicitlyStillNamesItsOpening(t *testing.T) {
	mode, err := DefaultModeRegistry.New(ModeInfiltration)
	if err != nil {
		t.Fatal(err)
	}
	position := mode.Definition().StartingPosition

	game, err := NewGameWithRegistryTimeControlAndStartingPosition(
		DefaultModeRegistry,
		"standard",
		ModeInfiltration,
		PlayerProfile{UserID: "red"},
		PlayerProfile{UserID: "blue"},
		DefaultTimeControl(),
		&position,
	)
	if err != nil {
		t.Fatal(err)
	}
	from, to := anyLegalMove(t, game)
	state, err := game.Move(game.state.CurrentTurn, from, to)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.OpeningLine) != 1 {
		t.Fatalf("the standard board reports the opening line %v", state.OpeningLine)
	}
}
