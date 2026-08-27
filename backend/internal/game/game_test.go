package game

import (
	"errors"
	"testing"
	"time"
)

func testGame(t *testing.T, modeID ModeID) *Game {
	t.Helper()
	game, err := NewGame("test", modeID, PlayerProfile{UserID: "red"}, PlayerProfile{UserID: "blue"})
	if err != nil {
		t.Fatal(err)
	}
	return game
}

// firstPieceOf locates a piece on the live board.
//
// Tests derive their squares from the mode's own starting position instead of
// hard-coding coordinates, so changing a mode's opening layout does not
// silently invalidate unrelated tests.
func firstPieceOf(t *testing.T, game *Game, owner PlayerColor, piece Piece) Position {
	t.Helper()
	for y := 0; y < BoardSize; y++ {
		for x := 0; x < BoardSize; x++ {
			tile := game.state.Grid[y][x]
			if tile.OccupantOwner == owner && tile.Occupant == piece {
				return Position{X: x, Y: y}
			}
		}
	}
	t.Fatalf("no %s %s on the board", owner, piece)
	return Position{}
}

// anyLegalMove returns some legal move for the player whose turn it is, asking
// the active mode rather than assuming standard movement.
func anyLegalMove(t *testing.T, game *Game) (Position, Position) {
	t.Helper()
	player := game.state.CurrentTurn
	for y := 0; y < BoardSize; y++ {
		for x := 0; x < BoardSize; x++ {
			if game.state.Grid[y][x].OccupantOwner != player {
				continue
			}
			from := Position{X: x, Y: y}
			if moves := game.mode.ValidMoves(game.state, player, from); len(moves) > 0 {
				return from, moves[0]
			}
		}
	}
	t.Fatalf("%s has no legal move", player)
	return Position{}, Position{}
}

func clearTiles(game *Game, rows ...int) {
	for _, y := range rows {
		for x := 0; x < BoardSize; x++ {
			game.state.Grid[y][x].Occupant = Empty
			game.state.Grid[y][x].OccupantOwner = Neutral
		}
	}
}

func TestMoveRequiresOneTile(t *testing.T) {
	game := testGame(t, ModeTotalWar)
	from := firstPieceOf(t, game, Red, Rock)
	_, err := game.Move(Red, from, Position{X: from.X - 2, Y: from.Y})
	if !errors.Is(err, ErrInvalidMovement) {
		t.Fatalf("expected ErrInvalidMovement, got %v", err)
	}
}

func TestCombatHierarchy(t *testing.T) {
	place := func(game *Game, at Position, piece Piece) {
		game.state.Grid[at.Y][at.X] = Tile{
			X:             at.X,
			Y:             at.Y,
			Occupant:      piece,
			OccupantOwner: Blue,
			OwnerColor:    Neutral,
		}
	}

	game := testGame(t, ModeTotalWar)
	from := firstPieceOf(t, game, Red, Rock)
	target := Position{X: from.X - 1, Y: from.Y + 1}
	place(game, target, Scissors)
	if _, err := game.Move(Red, from, target); err != nil {
		t.Fatalf("rock should capture scissors: %v", err)
	}

	game = testGame(t, ModeTotalWar)
	place(game, target, Paper)
	if _, err := game.Move(Red, from, target); !errors.Is(err, ErrInvalidCapture) {
		t.Fatalf("rock should not capture paper, got %v", err)
	}
}

// Modes may deliberately share an opening layout: Total War and Infiltration
// both use the large-army setup and differ only in their win condition. The
// contract tested here is that each mode's board matches the layout it
// declares, not that every layout is unique.
func TestStandardModesUseTheirConfiguredStartingPositions(t *testing.T) {
	for _, modeID := range []ModeID{ModeTotalWar, ModeInfiltration} {
		game := testGame(t, modeID)
		state := game.Snapshot()
		startingPosition := state.Mode.StartingPosition

		for y, row := range startingPosition.Rows() {
			for x := 0; x < len(row); x++ {
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
	from := firstPieceOf(t, game, Red, Rock)
	to := Position{X: from.X, Y: from.Y - 1}
	if owner := game.state.Grid[to.Y][to.X].OwnerColor; owner != Neutral {
		t.Fatalf("expected a neutral destination, got %s", owner)
	}
	state, err := game.Move(Red, from, to)
	if err != nil {
		t.Fatal(err)
	}
	if state.Grid[to.Y][to.X].OwnerColor != Red {
		t.Fatalf("expected red territory, got %s", state.Grid[to.Y][to.X].OwnerColor)
	}
	if state.Grid[from.Y][from.X].OwnerColor != Red {
		t.Fatal("moving away should preserve the starting square as red territory")
	}
}

func TestVersion3BoundaryWin(t *testing.T) {
	game := testGame(t, ModeInfiltration)
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
	clearTiles(game, 0, 1)

	from, to := anyLegalMove(t, game)
	state, err := game.Move(Red, from, to)
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != InProgress {
		t.Fatalf("V3 must end only at the opponent boundary, got %s", state.Status)
	}
}

// Infiltration has no annihilation win condition, so a side with no pieces
// simply has no legal move. Under the stalemate rule that is a draw rather
// than a win for the surviving player.
func TestInfiltrationWipeoutIsAStalemateDrawNotAWin(t *testing.T) {
	game := testGame(t, ModeInfiltration)
	clearTiles(game, 0, 1, 2)

	from, to := anyLegalMove(t, game)
	state, err := game.Move(Red, from, to)
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != Finished {
		t.Fatalf("expected the game to end, got %s", state.Status)
	}
	if state.Winner != Neutral {
		t.Fatalf("expected a draw, got winner %s", state.Winner)
	}
	if state.EndReason != EndReasonStalemate {
		t.Fatalf("expected a stalemate draw, got %s", state.EndReason)
	}
}

func TestStalemateEndsTheGameInADraw(t *testing.T) {
	// A Red Rock ringed by Blue Papers can neither move nor capture, because
	// Paper beats Rock. Every mode inherits this rule from the engine.
	game := testGame(t, ModeTotalWar)
	clearTiles(game, 0, 1, 2, 3, 4, 5, 6, 7, 8)
	game.state.Grid[4][4] = Tile{X: 4, Y: 4, Occupant: Rock, OccupantOwner: Red, OwnerColor: Neutral}
	for y := 3; y <= 5; y++ {
		for x := 3; x <= 5; x++ {
			if x == 4 && y == 4 {
				continue
			}
			game.state.Grid[y][x] = Tile{X: x, Y: y, Occupant: Paper, OccupantOwner: Blue, OwnerColor: Neutral}
		}
	}
	game.state.Grid[6][6] = Tile{X: 6, Y: 6, Occupant: Rock, OccupantOwner: Blue, OwnerColor: Neutral}
	game.state.CurrentTurn = Blue

	if game.HasLegalMove() != true {
		t.Fatal("Blue must still have a move before the stalemate is created")
	}
	state, err := game.Move(Blue, Position{X: 6, Y: 6}, Position{X: 7, Y: 7})
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != Finished || state.Winner != Neutral {
		t.Fatalf("expected a draw, got status=%s winner=%s", state.Status, state.Winner)
	}
	if state.EndReason != EndReasonStalemate {
		t.Fatalf("expected a stalemate draw, got %s", state.EndReason)
	}
}

func TestDrawOfferCanOnlyBeMadeOncePerTurn(t *testing.T) {
	game := testGame(t, ModeTotalWar)
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

	redFrom, redTo := anyLegalMove(t, game)
	state, err = game.Move(Red, redFrom, redTo)
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
	game := testGame(t, ModeTotalWar)
	if _, err := game.OfferDraw(Red); err != nil {
		t.Fatal(err)
	}
	redFrom, redTo := anyLegalMove(t, game)
	state, err := game.Move(Red, redFrom, redTo)
	if err != nil {
		t.Fatal(err)
	}
	if state.DrawOfferedBy != Red {
		t.Fatalf("expected offer to remain for Blue, got %#v", state)
	}
	blueFrom, blueTo := anyLegalMove(t, game)
	state, err = game.Move(Blue, blueFrom, blueTo)
	if err != nil {
		t.Fatal(err)
	}
	if state.DrawOfferedBy != "" {
		t.Fatalf("expected Blue's move to decline the offer, got %#v", state)
	}
}

func TestAcceptDrawAndResignRecordExactEndReasons(t *testing.T) {
	game := testGame(t, ModeTotalWar)
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

	game = testGame(t, ModeTotalWar)
	state, err = game.Resign(Red)
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != Finished || state.Winner != Blue ||
		state.EndReason != EndReasonResignation {
		t.Fatalf("expected Blue to win by resignation, got %#v", state)
	}
}

func TestThirdPositionOccurrenceIsDrawInEveryMode(t *testing.T) {
	type repetitionMove struct {
		player PlayerColor
		from   Position
		to     Position
	}
	tests := []struct {
		name  string
		mode  ModeID
		setup []repetitionMove
		cycle []repetitionMove
	}{
		{
			name: "total war",
			mode: ModeTotalWar,
			setup: []repetitionMove{
				{Red, Position{X: 3, Y: 6}, Position{X: 2, Y: 5}},
				{Blue, Position{X: 3, Y: 2}, Position{X: 2, Y: 3}},
				{Red, Position{X: 2, Y: 5}, Position{X: 3, Y: 6}},
				{Blue, Position{X: 2, Y: 3}, Position{X: 3, Y: 2}},
			},
			cycle: []repetitionMove{
				{Red, Position{X: 3, Y: 6}, Position{X: 2, Y: 5}},
				{Blue, Position{X: 3, Y: 2}, Position{X: 2, Y: 3}},
				{Red, Position{X: 2, Y: 5}, Position{X: 3, Y: 6}},
				{Blue, Position{X: 2, Y: 3}, Position{X: 3, Y: 2}},
			},
		},
		{
			name: "infiltration",
			mode: ModeInfiltration,
			cycle: []repetitionMove{
				{Red, Position{X: 3, Y: 6}, Position{X: 2, Y: 5}},
				{Blue, Position{X: 3, Y: 2}, Position{X: 2, Y: 3}},
				{Red, Position{X: 2, Y: 5}, Position{X: 3, Y: 6}},
				{Blue, Position{X: 2, Y: 3}, Position{X: 3, Y: 2}},
			},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			game := testGame(t, test.mode)
			play := func(moves []repetitionMove) GameState {
				t.Helper()
				var state GameState
				for _, move := range moves {
					var err error
					state, err = game.Move(move.player, move.from, move.to)
					if err != nil {
						t.Fatalf("move %s %v-%v failed: %v", move.player, move.from, move.to, err)
					}
				}
				return state
			}

			if len(test.setup) > 0 {
				state := play(test.setup)
				if state.Status != InProgress {
					t.Fatalf("setup unexpectedly ended the game: %#v", state)
				}
			}
			state := play(test.cycle)
			if state.Status != InProgress {
				t.Fatalf("second occurrence must not end the game: %#v", state)
			}
			for _, move := range test.cycle {
				var err error
				state, err = game.Move(move.player, move.from, move.to)
				if err != nil {
					t.Fatalf("move %s %v-%v failed: %v", move.player, move.from, move.to, err)
				}
				if state.Status == Finished {
					break
				}
			}
			if state.Status != Finished || state.Winner != Neutral ||
				state.EndReason != EndReasonRepetition {
				t.Fatalf("expected draw on third occurrence, got %#v", state)
			}
		})
	}
}

func TestAcceptedTimeExtensionAddsThreeMinutesToBothClocks(t *testing.T) {
	game := testGame(t, ModeTotalWar)
	before := game.Snapshot().Clock
	if _, err := game.OfferTimeExtension(Red); err != nil {
		t.Fatal(err)
	}
	state, err := game.AcceptTimeExtension(Blue)
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != InProgress {
		t.Fatalf("expected the game to continue, got %s", state.Status)
	}
	if state.TimeOfferedBy != "" {
		t.Fatalf("expected the offer to be consumed, got %#v", state)
	}
	// Red's clock is running, so it may have lost a few milliseconds between
	// the two snapshots; only the extension should have grown it.
	if grown := state.Clock.RedRemainingMs - before.RedRemainingMs; grown > TimeExtensionMs ||
		grown < TimeExtensionMs-time.Second.Milliseconds() {
		t.Fatalf("expected Red to gain three minutes, gained %dms", grown)
	}
	if grown := state.Clock.BlueRemainingMs - before.BlueRemainingMs; grown != TimeExtensionMs {
		t.Fatalf("expected Blue to gain three minutes, gained %dms", grown)
	}
}

func TestTimeExtensionCanBeAskedForOffTurnAndSurvivesAMove(t *testing.T) {
	game := testGame(t, ModeTotalWar)
	// Red is to move, so Blue is asking while its own clock is stopped.
	state, err := game.OfferTimeExtension(Blue)
	if err != nil {
		t.Fatalf("expected Blue to be able to ask off-turn: %v", err)
	}
	if state.TimeOfferedBy != Blue || state.TimeOfferUsedBy != Blue {
		t.Fatalf("expected Blue's request to be recorded, got %#v", state)
	}
	if _, err := game.AcceptTimeExtension(Blue); !errors.Is(err, ErrCannotRespondOwnOffer) {
		t.Fatalf("expected Blue to be unable to accept its own request, got %v", err)
	}
	if _, err := game.OfferTimeExtension(Red); !errors.Is(err, ErrTimeOfferExists) {
		t.Fatalf("expected one live request at a time, got %v", err)
	}

	// Red plays on. The request is not a move substitute, so playing does not
	// answer it and Red can still grant it afterwards.
	redFrom, redTo := anyLegalMove(t, game)
	state, err = game.Move(Red, redFrom, redTo)
	if err != nil {
		t.Fatal(err)
	}
	if state.TimeOfferedBy != Blue {
		t.Fatalf("expected the request to survive Red's move, got %#v", state)
	}
	if state.TimeOfferUsedBy != "" {
		t.Fatalf("expected the allowance to reset after a move, got %#v", state)
	}
	before := state.Clock
	state, err = game.AcceptTimeExtension(Red)
	if err != nil {
		t.Fatal(err)
	}
	if state.TimeOfferedBy != "" {
		t.Fatalf("expected the request to be consumed, got %#v", state)
	}
	if state.Clock.RedRemainingMs <= before.RedRemainingMs ||
		state.Clock.BlueRemainingMs <= before.BlueRemainingMs {
		t.Fatalf("expected both clocks to grow, got %#v", state.Clock)
	}
}

func TestTimeExtensionIsLimitedToOnePerPlayerPerMove(t *testing.T) {
	game := testGame(t, ModeTotalWar)
	if _, err := game.OfferTimeExtension(Red); err != nil {
		t.Fatal(err)
	}
	if _, err := game.DeclineTimeExtension(Blue); err != nil {
		t.Fatal(err)
	}
	if _, err := game.OfferTimeExtension(Red); !errors.Is(err, ErrTimeOfferUnavailable) {
		t.Fatalf("expected a second request before any move to fail, got %v", err)
	}
	// Blue has not used its own allowance, so a declined request does not
	// silence the other player.
	if _, err := game.OfferTimeExtension(Blue); err != nil {
		t.Fatalf("expected Blue to still have its own request: %v", err)
	}
	if _, err := game.DeclineTimeExtension(Red); err != nil {
		t.Fatal(err)
	}

	// A draw offer is tracked separately and remains available on Red's turn.
	if _, err := game.OfferDraw(Red); err != nil {
		t.Fatalf("expected a draw offer to remain available: %v", err)
	}
	if _, err := game.OfferDraw(Blue); !errors.Is(err, ErrDrawOfferUnavailable) {
		t.Fatalf("expected a draw offer off-turn to still be refused, got %v", err)
	}

	redFrom, redTo := anyLegalMove(t, game)
	if _, err := game.Move(Red, redFrom, redTo); err != nil {
		t.Fatal(err)
	}
	if _, err := game.OfferTimeExtension(Red); err != nil {
		t.Fatalf("expected the allowance to refresh after a move: %v", err)
	}
}

func TestTimeExtensionIsUnavailableAfterTheGameEnds(t *testing.T) {
	game := testGame(t, ModeTotalWar)
	if _, err := game.Resign(Red); err != nil {
		t.Fatal(err)
	}
	if _, err := game.OfferTimeExtension(Blue); !errors.Is(err, ErrGameFinished) {
		t.Fatalf("expected a finished game to refuse the offer, got %v", err)
	}
}
