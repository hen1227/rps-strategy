package game

import (
	"errors"
	"testing"
)

func testGame(t *testing.T, modeID ModeID) *Game {
	t.Helper()
	game, err := NewGame("test", modeID, PlayerProfile{UserID: "red"}, PlayerProfile{UserID: "blue"})
	if err != nil {
		t.Fatal(err)
	}
	return game
}

func TestMoveRequiresOneTile(t *testing.T) {
	game := testGame(t, ModeAnnihilation)
	_, err := game.Move(Red, Position{X: 0, Y: 8}, Position{X: 0, Y: 6})
	if !errors.Is(err, ErrInvalidMovement) {
		t.Fatalf("expected ErrInvalidMovement, got %v", err)
	}
}

func TestCombatHierarchy(t *testing.T) {
	game := testGame(t, ModeAnnihilation)
	game.state.Grid[7][0] = Tile{X: 0, Y: 7, Occupant: Scissors, OccupantOwner: Blue, OwnerColor: Neutral}
	_, err := game.Move(Red, Position{X: 0, Y: 8}, Position{X: 0, Y: 7})
	if err != nil {
		t.Fatalf("rock should capture scissors: %v", err)
	}

	game = testGame(t, ModeAnnihilation)
	game.state.Grid[7][0] = Tile{X: 0, Y: 7, Occupant: Paper, OccupantOwner: Blue, OwnerColor: Neutral}
	_, err = game.Move(Red, Position{X: 0, Y: 8}, Position{X: 0, Y: 7})
	if !errors.Is(err, ErrInvalidCapture) {
		t.Fatalf("rock should not capture paper, got %v", err)
	}
}

func TestStandardModesUseTheirConfiguredStartingPositions(t *testing.T) {
	seen := make(map[StartingPosition]ModeID)
	for _, modeID := range []ModeID{ModeAnnihilation, ModeTotalWar, ModeInfiltration} {
		game := testGame(t, modeID)
		state := game.Snapshot()
		startingPosition := state.Mode.StartingPosition
		if previousMode, exists := seen[startingPosition]; exists {
			t.Fatalf("%s and %s unexpectedly share the same starting position", modeID, previousMode)
		}
		seen[startingPosition] = modeID

		for y, row := range startingPosition.Rows {
			for x := 0; x < BoardSize; x++ {
				expectedPiece, expectedOwner, _ := startingPiece(row[x])
				tile := state.Grid[y][x]
				if tile.Occupant != expectedPiece || tile.OccupantOwner != expectedOwner {
					t.Fatalf(
						"%s: expected %s %s at (%d, %d), got %s %s",
						modeID,
						expectedOwner,
						expectedPiece,
						x,
						y,
						tile.OccupantOwner,
						tile.Occupant,
					)
				}
				if expectedPiece != Empty && tile.OwnerColor != expectedOwner {
					t.Fatalf(
						"%s: expected %s to own occupied starting tile (%d, %d)",
						modeID,
						expectedOwner,
						x,
						y,
					)
				}
			}
		}
	}
}

func TestVersion5PaintsNeutralDestinationAndPreservesHomeTerritory(t *testing.T) {
	game := testGame(t, ModeTotalWar)
	state, err := game.Move(Red, Position{X: 0, Y: 8}, Position{X: 0, Y: 7})
	if err != nil {
		t.Fatal(err)
	}
	if state.Grid[7][0].OwnerColor != Red {
		t.Fatalf("expected red territory, got %s", state.Grid[7][0].OwnerColor)
	}
	if state.Grid[8][0].OwnerColor != Red {
		t.Fatal("moving away should preserve the starting square as red territory")
	}
}

func TestVersion3BoundaryWin(t *testing.T) {
	game := testGame(t, ModeInfiltration)
	game.state.Grid[8][0].Occupant = Empty
	game.state.Grid[8][0].OccupantOwner = Neutral
	game.state.Grid[1][0] = Tile{X: 0, Y: 1, Occupant: Rock, OccupantOwner: Red, OwnerColor: Neutral}
	game.state.Grid[0][0] = Tile{X: 0, Y: 0, Occupant: Scissors, OccupantOwner: Blue, OwnerColor: Neutral}

	state, err := game.Move(Red, Position{X: 0, Y: 1}, Position{X: 0, Y: 0})
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != Finished || state.Winner != Red {
		t.Fatalf("expected Red boundary win, got status=%s winner=%s", state.Status, state.Winner)
	}
}

func TestVersion3DoesNotUseAnnihilationWinCondition(t *testing.T) {
	game := testGame(t, ModeInfiltration)
	for x := 0; x < BoardSize; x++ {
		game.state.Grid[0][x].Occupant = Empty
		game.state.Grid[0][x].OccupantOwner = Neutral
	}

	state, err := game.Move(Red, Position{X: 0, Y: 8}, Position{X: 0, Y: 7})
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != InProgress {
		t.Fatalf("V3 must end only at the opponent boundary, got %s", state.Status)
	}
}

func TestDrawOfferCanOnlyBeMadeOncePerTurn(t *testing.T) {
	game := testGame(t, ModeAnnihilation)
	state, err := game.OfferDraw(Red)
	if err != nil {
		t.Fatal(err)
	}
	if state.DrawOfferedBy != Red || state.DrawOfferUsedBy != Red {
		t.Fatalf("expected Red's draw offer, got %#v", state)
	}
	if _, err := game.DeclineDraw(Blue); err != nil {
		t.Fatal(err)
	}
	if _, err := game.OfferDraw(Red); !errors.Is(err, ErrDrawOfferUnavailable) {
		t.Fatalf("expected a repeated offer on the same turn to fail, got %v", err)
	}

	state, err = game.Move(Red, Position{X: 0, Y: 8}, Position{X: 0, Y: 7})
	if err != nil {
		t.Fatal(err)
	}
	if state.DrawOfferUsedBy != "" {
		t.Fatalf("expected draw offer allowance to reset after a move, got %#v", state)
	}
	if _, err := game.OfferDraw(Blue); err != nil {
		t.Fatalf("expected Blue to be able to offer on their turn: %v", err)
	}
}

func TestDrawOfferPersistsForOpponentAndMoveDeclinesIt(t *testing.T) {
	game := testGame(t, ModeAnnihilation)
	if _, err := game.OfferDraw(Red); err != nil {
		t.Fatal(err)
	}
	state, err := game.Move(Red, Position{X: 0, Y: 8}, Position{X: 0, Y: 7})
	if err != nil {
		t.Fatal(err)
	}
	if state.DrawOfferedBy != Red {
		t.Fatalf("expected offer to remain for Blue, got %#v", state)
	}
	state, err = game.Move(Blue, Position{X: 0, Y: 0}, Position{X: 0, Y: 1})
	if err != nil {
		t.Fatal(err)
	}
	if state.DrawOfferedBy != "" {
		t.Fatalf("expected Blue's move to decline the offer, got %#v", state)
	}
}

func TestAcceptDrawAndResignRecordExactEndReasons(t *testing.T) {
	game := testGame(t, ModeAnnihilation)
	if _, err := game.OfferDraw(Red); err != nil {
		t.Fatal(err)
	}
	state, err := game.AcceptDraw(Blue)
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != Finished || state.Winner != Neutral ||
		state.EndReason != EndReasonDrawAgreement {
		t.Fatalf("expected a draw by agreement, got %#v", state)
	}

	game = testGame(t, ModeAnnihilation)
	state, err = game.Resign(Red)
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != Finished || state.Winner != Blue ||
		state.EndReason != EndReasonResignation {
		t.Fatalf("expected Blue to win by resignation, got %#v", state)
	}
}
