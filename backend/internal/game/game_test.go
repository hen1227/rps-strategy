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
	from := firstPieceOf(t, game, Blue, Rock)
	_, err := game.Move(Blue, from, Position{X: from.X - 2, Y: from.Y})
	if !errors.Is(err, ErrInvalidMovement) {
		t.Fatalf("expected ErrInvalidMovement, got %v", err)
	}
}

// place seats one piece on the live board, replacing whatever stood there.
func place(game *Game, at Position, owner PlayerColor, piece Piece) {
	game.state.Grid[at.Y][at.X] = Tile{
		X:             at.X,
		Y:             at.Y,
		Occupant:      piece,
		OccupantOwner: owner,
		OwnerColor:    Neutral,
	}
}

func TestCombatHierarchy(t *testing.T) {
	game := testGame(t, ModeTotalWar)
	from := firstPieceOf(t, game, Blue, Rock)
	target := Position{X: from.X - 1, Y: from.Y + 1}
	place(game, target, Red, Scissors)
	if _, err := game.Move(Blue, from, target); err != nil {
		t.Fatalf("rock should capture scissors: %v", err)
	}

	game = testGame(t, ModeTotalWar)
	place(game, target, Red, Paper)
	if _, err := game.Move(Blue, from, target); !errors.Is(err, ErrInvalidCapture) {
		t.Fatalf("rock should not capture paper, got %v", err)
	}
}

// Modes may deliberately share an opening layout: Total War and Infiltration
// both use the large-army setup and differ only in their win condition. The
// contract tested here is that each mode's board matches the layout it
// declares, not that every layout is unique.
func TestStandardModesUseTheirConfiguredStartingPositions(t *testing.T) {
	for _, modeID := range []ModeID{ModeTotalWar, ModeInfiltration, ModeIntransitive} {
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
	from := firstPieceOf(t, game, Blue, Rock)
	// Blue's home is rank 1, so Blue advances up the ranks and the square in
	// front of its rock is the empty middle of the board.
	to := Position{X: from.X, Y: from.Y + 1}
	if owner := game.state.Grid[to.Y][to.X].OwnerColor; owner != Neutral {
		t.Fatalf("expected a neutral destination, got %s", owner)
	}
	state, err := game.Move(Blue, from, to)
	if err != nil {
		t.Fatal(err)
	}
	if state.Grid[to.Y][to.X].OwnerColor != Blue {
		t.Fatalf("expected blue territory, got %s", state.Grid[to.Y][to.X].OwnerColor)
	}
	if state.Grid[from.Y][from.X].OwnerColor != Blue {
		t.Fatal("moving away should preserve the starting square as blue territory")
	}
}

func TestVersion3BoundaryWin(t *testing.T) {
	last := BoardSize - 1
	game := testGame(t, ModeInfiltration)
	// Blue runs at Red's home rank, which is the last one.
	game.state.Grid[last-1][0] = Tile{
		X: 0, Y: last - 1, Occupant: Rock, OccupantOwner: Blue, OwnerColor: Neutral,
	}
	game.state.Grid[last][0] = Tile{
		X: 0, Y: last, Occupant: Scissors, OccupantOwner: Red, OwnerColor: Neutral,
	}

	state, err := game.Move(Blue, Position{X: 0, Y: last - 1}, Position{X: 0, Y: last})
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != Finished || state.Winner != Blue {
		t.Fatalf("expected Blue boundary win, got status=%s winner=%s", state.Status, state.Winner)
	}
}

// The two corners, from both sides, because a goal read off the wrong end of
// the grid would still pass a test that only ever checked one of them.
func TestVersion6CornerWin(t *testing.T) {
	last := BoardSize - 1
	tests := []struct {
		name   string
		player PlayerColor
		from   Position
		to     Position
	}{
		{"red reaches Blue's corner", Red, Position{X: 1, Y: 1}, Position{X: 0, Y: 0}},
		{
			"blue reaches Red's corner",
			Blue,
			Position{X: last - 1, Y: last - 1},
			Position{X: last, Y: last},
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			game := testGame(t, ModeIntransitive)
			clearTiles(game, 0, 1, 2, 3, 4, 5, 6, 7, 8)
			place(game, test.from, test.player, Rock)
			game.state.CurrentTurn = test.player

			state, err := game.Move(test.player, test.from, test.to)
			if err != nil {
				t.Fatal(err)
			}
			if state.Status != Finished || state.Winner != test.player {
				t.Fatalf(
					"expected %s to win, got status=%s winner=%s",
					test.player,
					state.Status,
					state.Winner,
				)
			}
			if state.EndReason != EndReasonCorner {
				t.Fatalf("expected a corner win, got %s", state.EndReason)
			}
		})
	}
}

// The whole difference from Infiltration: the goal is one tile, not the rank it
// sits on. Blue landing anywhere else on Red's home rank -- including its other
// end, which is Red's *own* goal -- has won nothing.
func TestVersion6IgnoresTheRestOfTheGoalRank(t *testing.T) {
	last := BoardSize - 1
	for _, to := range []Position{{X: 4, Y: last}, {X: 0, Y: last}} {
		game := testGame(t, ModeIntransitive)
		clearTiles(game, 0, 1, 2, 3, 4, 5, 6, 7, 8)
		from := Position{X: to.X, Y: last - 1}
		place(game, from, Blue, Rock)
		// Red needs a piece with somewhere to go: in this mode being unable to
		// move loses, so a bare board would end the game for the wrong reason.
		place(game, Position{X: 4, Y: 0}, Red, Rock)

		state, err := game.Move(Blue, from, to)
		if err != nil {
			t.Fatal(err)
		}
		if state.Status != InProgress {
			t.Fatalf(
				"V6 must end only at the corner, but %v ended it: status=%s reason=%s",
				to,
				state.Status,
				state.EndReason,
			)
		}
	}
}

func TestVersion3DoesNotUseAnnihilationWinCondition(t *testing.T) {
	game := testGame(t, ModeInfiltration)
	clearTiles(game, BoardSize-2, BoardSize-1)

	from, to := anyLegalMove(t, game)
	state, err := game.Move(Blue, from, to)
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
	clearTiles(game, BoardSize-3, BoardSize-2, BoardSize-1)

	from, to := anyLegalMove(t, game)
	state, err := game.Move(Blue, from, to)
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
	state, err := game.OfferDraw(Blue)
	if err != nil {
		t.Fatal(err)
	}
	if state.DrawOfferedBy != Blue || state.DrawOfferUsedBy != Blue {
		t.Fatalf("expected Blue's draw offer, got %#v", state)
	}
	if _, err := game.DeclineDraw(Red); err != nil {
		t.Fatal(err)
	}
	if _, err := game.OfferDraw(Blue); !errors.Is(err, ErrDrawOfferUnavailable) {
		t.Fatalf("expected a repeated offer on the same turn to fail, got %v", err)
	}

	blueFrom, blueTo := anyLegalMove(t, game)
	state, err = game.Move(Blue, blueFrom, blueTo)
	if err != nil {
		t.Fatal(err)
	}
	if state.DrawOfferUsedBy != "" {
		t.Fatalf("expected draw offer allowance to reset after a move, got %#v", state)
	}
	if _, err := game.OfferDraw(Red); err != nil {
		t.Fatalf("expected Red to be able to offer on their turn: %v", err)
	}
}

func TestDrawOfferPersistsForOpponentAndMoveDeclinesIt(t *testing.T) {
	game := testGame(t, ModeTotalWar)
	if _, err := game.OfferDraw(Blue); err != nil {
		t.Fatal(err)
	}
	blueFrom, blueTo := anyLegalMove(t, game)
	state, err := game.Move(Blue, blueFrom, blueTo)
	if err != nil {
		t.Fatal(err)
	}
	if state.DrawOfferedBy != Blue {
		t.Fatalf("expected offer to remain for Red, got %#v", state)
	}
	redFrom, redTo := anyLegalMove(t, game)
	state, err = game.Move(Red, redFrom, redTo)
	if err != nil {
		t.Fatal(err)
	}
	if state.DrawOfferedBy != "" {
		t.Fatalf("expected Red's move to decline the offer, got %#v", state)
	}
}

func TestAcceptDrawAndResignRecordExactEndReasons(t *testing.T) {
	game := testGame(t, ModeTotalWar)
	if _, err := game.OfferDraw(Blue); err != nil {
		t.Fatal(err)
	}
	state, err := game.AcceptDraw(Red)
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != Finished || state.Winner != Neutral ||
		state.EndReason != EndReasonDrawAgreement {
		t.Fatalf("expected a draw by agreement, got %#v", state)
	}

	game = testGame(t, ModeTotalWar)
	state, err = game.Resign(Blue)
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != Finished || state.Winner != Red ||
		state.EndReason != EndReasonResignation {
		t.Fatalf("expected Red to win by resignation, got %#v", state)
	}
}

// The shuffle that used to draw is play in every mode now: see
// game.RepetitionDrawEnabled. This is the test that says so, and it is the
// table the rule would be checked from if the switch were ever turned back on —
// the cycles below are the ones that reach a third occurrence in each mode.
//
// Kept as three modes rather than one, because the rule was per-mode for most
// of this project's life and the bug it hides is one mode being adjudicated
// under another's answer.
func TestRepeatingAPositionIsPlayInEveryMode(t *testing.T) {
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
				{Blue, Position{X: 3, Y: 2}, Position{X: 2, Y: 3}},
				{Red, Position{X: 3, Y: 6}, Position{X: 2, Y: 5}},
				{Blue, Position{X: 2, Y: 3}, Position{X: 3, Y: 2}},
				{Red, Position{X: 2, Y: 5}, Position{X: 3, Y: 6}},
			},
			cycle: []repetitionMove{
				{Blue, Position{X: 3, Y: 2}, Position{X: 2, Y: 3}},
				{Red, Position{X: 3, Y: 6}, Position{X: 2, Y: 5}},
				{Blue, Position{X: 2, Y: 3}, Position{X: 3, Y: 2}},
				{Red, Position{X: 2, Y: 5}, Position{X: 3, Y: 6}},
			},
		},
		{
			name: "infiltration",
			mode: ModeInfiltration,
			cycle: []repetitionMove{
				{Blue, Position{X: 3, Y: 2}, Position{X: 2, Y: 3}},
				{Red, Position{X: 3, Y: 6}, Position{X: 2, Y: 5}},
				{Blue, Position{X: 2, Y: 3}, Position{X: 3, Y: 2}},
				{Red, Position{X: 2, Y: 5}, Position{X: 3, Y: 6}},
			},
		},
		{
			// Its own squares because its own opening: Intransitive banks each
			// army in front of a corner rather than across a rank, so the two
			// pieces free to shuffle are not the ones the other modes use.
			name: "intransitive",
			mode: ModeIntransitive,
			cycle: []repetitionMove{
				{Blue, Position{X: 4, Y: 1}, Position{X: 5, Y: 1}},
				{Red, Position{X: 4, Y: 7}, Position{X: 3, Y: 7}},
				{Blue, Position{X: 5, Y: 1}, Position{X: 4, Y: 1}},
				{Red, Position{X: 3, Y: 7}, Position{X: 4, Y: 7}},
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
			// Four laps, so the position reaches a fourth occurrence and not
			// merely a third: a rule that fired one lap late would pass a test
			// that stopped at three.
			for lap := 0; lap < 4; lap++ {
				state := play(test.cycle)
				if state.Status != InProgress || state.EndReason != "" {
					t.Fatalf("lap %d ended the game: %#v", lap, state)
				}
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
	// Blue is to move, so Red is asking while its own clock is stopped.
	state, err := game.OfferTimeExtension(Red)
	if err != nil {
		t.Fatalf("expected Red to be able to ask off-turn: %v", err)
	}
	if state.TimeOfferedBy != Red || state.TimeOfferUsedBy != Red {
		t.Fatalf("expected Red's request to be recorded, got %#v", state)
	}
	if _, err := game.AcceptTimeExtension(Red); !errors.Is(err, ErrCannotRespondOwnOffer) {
		t.Fatalf("expected Red to be unable to accept its own request, got %v", err)
	}
	if _, err := game.OfferTimeExtension(Blue); !errors.Is(err, ErrTimeOfferExists) {
		t.Fatalf("expected one live request at a time, got %v", err)
	}

	// Blue plays on. The request is not a move substitute, so playing does not
	// answer it and Blue can still grant it afterwards.
	blueFrom, blueTo := anyLegalMove(t, game)
	state, err = game.Move(Blue, blueFrom, blueTo)
	if err != nil {
		t.Fatal(err)
	}
	if state.TimeOfferedBy != Red {
		t.Fatalf("expected the request to survive Blue's move, got %#v", state)
	}
	if state.TimeOfferUsedBy != "" {
		t.Fatalf("expected the allowance to reset after a move, got %#v", state)
	}
	before := state.Clock
	state, err = game.AcceptTimeExtension(Blue)
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
	if _, err := game.OfferTimeExtension(Blue); err != nil {
		t.Fatal(err)
	}
	if _, err := game.DeclineTimeExtension(Red); err != nil {
		t.Fatal(err)
	}
	if _, err := game.OfferTimeExtension(Blue); !errors.Is(err, ErrTimeOfferUnavailable) {
		t.Fatalf("expected a second request before any move to fail, got %v", err)
	}
	// Red has not used its own allowance, so a declined request does not
	// silence the other player.
	if _, err := game.OfferTimeExtension(Red); err != nil {
		t.Fatalf("expected Red to still have its own request: %v", err)
	}
	if _, err := game.DeclineTimeExtension(Blue); err != nil {
		t.Fatal(err)
	}

	// A draw offer is tracked separately and remains available on Blue's turn.
	if _, err := game.OfferDraw(Blue); err != nil {
		t.Fatalf("expected a draw offer to remain available: %v", err)
	}
	if _, err := game.OfferDraw(Red); !errors.Is(err, ErrDrawOfferUnavailable) {
		t.Fatalf("expected a draw offer off-turn to still be refused, got %v", err)
	}

	blueFrom, blueTo := anyLegalMove(t, game)
	if _, err := game.Move(Blue, blueFrom, blueTo); err != nil {
		t.Fatal(err)
	}
	if _, err := game.OfferTimeExtension(Blue); err != nil {
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

// Intransitive is a race, and a race is not something a side may sit out. The
// engine's stalemate rule still fires; what changes is who the result belongs
// to.
func TestVersion6StalemateLosesForTheSideThatCannotMove(t *testing.T) {
	game := testGame(t, ModeIntransitive)
	clearTiles(game, 0, 1, 2, 3, 4, 5, 6, 7, 8)
	// A Red rock ringed by Blue papers can neither move nor capture, because
	// paper beats rock. Blue keeps one loose rock so it is Blue's move that
	// creates the position rather than the setup.
	place(game, Position{X: 4, Y: 4}, Red, Rock)
	for y := 3; y <= 5; y++ {
		for x := 3; x <= 5; x++ {
			if x == 4 && y == 4 {
				continue
			}
			place(game, Position{X: x, Y: y}, Blue, Paper)
		}
	}
	place(game, Position{X: 0, Y: 6}, Blue, Rock)

	state, err := game.Move(Blue, Position{X: 0, Y: 6}, Position{X: 0, Y: 5})
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != Finished || state.EndReason != EndReasonStalemate {
		t.Fatalf("expected a stalemate, got status=%s reason=%s", state.Status, state.EndReason)
	}
	if state.Winner != Blue {
		t.Fatalf("expected the stalemated side to lose, got winner %s", state.Winner)
	}
}

// The switch is above every other answer, so nothing a mode or a game says can
// put the draw back while it is off.
//
// Written against the switch rather than against its current value, so it is
// still the right test the day it is turned on: with the rule off nothing draws
// on repetition, and with it on the answer is whatever the mode and the game
// said. Only the second half needs the per-mode machinery, which is why that
// machinery is still here.
func TestTheRepetitionSwitchIsAboveEveryOtherAnswer(t *testing.T) {
	for _, definition := range DefaultModeRegistry.Definitions() {
		state := GameState{Mode: definition}
		draws := repetitionDraws(state)
		if !RepetitionDrawEnabled && draws {
			t.Errorf("%s draws on repetition with the rule switched off", definition.ID)
		}
		if RepetitionDrawEnabled && draws == definition.HasFeature(FeatureNoRepetitionDraw) {
			t.Errorf(
				"%s: repetitionDraws=%v does not match its own feature",
				definition.ID, draws,
			)
		}
		state.Rules = RuleFlags{NoRepetitionDraw: true}
		if repetitionDraws(state) {
			t.Errorf("%s ignores a game that switched the draw off", definition.ID)
		}
	}
}

// The corner a side wins on is the corner the *other* side's wedge is banked
// in front of, and Blue's is a1. Read off the layout rather than restated, so
// redrawing the opening cannot quietly move a goal.
func TestVersion6GoalCornersAreTheEnemyHomeCorners(t *testing.T) {
	grid := testGame(t, ModeIntransitive).Snapshot().Grid
	if got := goalCorner(grid, Red); got != (Position{X: 0, Y: 0}) {
		t.Fatalf("Red should run at a1, got %v", got)
	}
	if want := (Position{X: grid.Width() - 1, Y: grid.Height() - 1}); goalCorner(grid, Blue) != want {
		t.Fatalf("Blue should run at i9, got %v", goalCorner(grid, Blue))
	}
	// Each side's rocks stand on the diagonal that cuts its own corner off, so
	// the goal a side defends is the one nearer its own rocks than the enemy's.
	for _, side := range []PlayerColor{Red, Blue} {
		own, enemy := goalCorner(grid, OtherColor(side)), goalCorner(grid, side)
		near, far := 0, 0
		for _, row := range grid {
			for _, tile := range row {
				if tile.OccupantOwner != side {
					continue
				}
				at := Position{X: tile.X, Y: tile.Y}
				near += chebyshev(at, own)
				far += chebyshev(at, enemy)
			}
		}
		if near >= far {
			t.Fatalf("%s's army is not banked in front of its own corner %v", side, own)
		}
	}
}

func chebyshev(from, to Position) int {
	return max(abs(to.X-from.X), abs(to.Y-from.Y))
}

// The bound on a game's length, and the one nothing can lift. QuietPlyLimit is
// counted in plies, so two hundred of them is a hundred moves from each side.
//
// Every mode, and with the repetition draw switched off at the game as well as
// globally, because that is the whole point of the rule: a game that may repeat
// freely has nothing else bounding it, and QuietPlyLimit is what stops it
// running until somebody's clock does. The RuleFlag is redundant while
// RepetitionDrawEnabled is false and is kept so this test still means what it
// says if that is ever turned back on.
//
// A two-square shuffle rather than a wandering army: any hundred moves with
// nothing taken will do, and this is the shortest way to write a hundred of
// them.
func TestAHundredMovesWithNoCaptureIsADraw(t *testing.T) {
	for _, modeID := range []ModeID{ModeTotalWar, ModeInfiltration, ModeIntransitive} {
		t.Run(string(modeID), func(t *testing.T) {
			created, err := NewGameFromSetup(
				DefaultModeRegistry,
				"quiet-test",
				GameSetup{ModeID: modeID, Rules: RuleFlags{NoRepetitionDraw: true}},
				PlayerProfile{UserID: "red"},
				PlayerProfile{UserID: "blue"},
			)
			if err != nil {
				t.Fatal(err)
			}
			shuffle := quietShuffle(t, created)
			var state GameState
			for ply := 0; ply < QuietPlyLimit; ply++ {
				if state.Status == Finished {
					t.Fatalf("game ended after %d quiet plies: %s", ply, state.EndReason)
				}
				move := shuffle[ply%len(shuffle)]
				state, err = created.Move(move.player, move.from, move.to)
				if err != nil {
					t.Fatalf("quiet move %d (%s %v-%v) failed: %v",
						ply, move.player, move.from, move.to, err)
				}
				if got := created.QuietPlies(); got != ply+1 {
					t.Fatalf("after %d quiet plies the counter reads %d", ply+1, got)
				}
			}
			if state.Status != Finished || state.Winner != Neutral ||
				state.EndReason != EndReasonNoCapture {
				t.Fatalf("expected a draw on quiet ply %d, got %#v", QuietPlyLimit, state)
			}
		})
	}
}

// A capture starts the count again, so a game that is still taking pieces is
// never cut short however long it runs.
//
// A board with one piece each, because the point is the counter and not the
// position: four steps that take nothing, then one that does. The mode's own
// size, since a custom setup is a different opening rather than a different
// board.
func TestACaptureResetsTheQuietMoveCount(t *testing.T) {
	board := MustStartingPosition(
		"R........",
		"..s......",
		".........",
		".........",
		".........",
		".........",
		".........",
		".........",
		".........",
	)
	created, err := NewGameFromSetup(
		DefaultModeRegistry,
		"capture-test",
		GameSetup{ModeID: ModeTotalWar, StartingPosition: board},
		PlayerProfile{UserID: "red"},
		PlayerProfile{UserID: "blue"},
	)
	if err != nil {
		t.Fatal(err)
	}
	approach := []plannedMove{
		{Blue, Position{X: 0, Y: 0}, Position{X: 0, Y: 1}},
		{Red, Position{X: 2, Y: 1}, Position{X: 2, Y: 0}},
		{Blue, Position{X: 0, Y: 1}, Position{X: 1, Y: 1}},
		{Red, Position{X: 2, Y: 0}, Position{X: 2, Y: 1}},
	}
	for index, move := range approach {
		if _, err := created.Move(move.player, move.from, move.to); err != nil {
			t.Fatalf("quiet move %d (%v-%v) failed: %v", index, move.from, move.to, err)
		}
		if got := created.QuietPlies(); got != index+1 {
			t.Fatalf("after %d quiet moves the counter reads %d", index+1, got)
		}
	}
	// Rock takes scissors, which is the only capture on this board.
	state, err := created.Move(Blue, Position{X: 1, Y: 1}, Position{X: 2, Y: 1})
	if err != nil {
		t.Fatalf("capture failed: %v", err)
	}
	if created.QuietPlies() != 0 {
		t.Fatalf("a capture must restart the count, got %d", created.QuietPlies())
	}
	if state.EndReason != EndReasonAnnihilation {
		t.Fatalf("expected the capture to take Red's last piece, got %#v", state)
	}
}

type plannedMove struct {
	player   PlayerColor
	from, to Position
}

// quietShuffle finds one piece per side that can step to an empty square and
// back forever, and returns the four moves that do it.
//
// Derived from the live board rather than written down, because the three modes
// open from three different layouts and this test is about none of them.
func quietShuffle(t *testing.T, created *Game) []plannedMove {
	t.Helper()
	state := created.Snapshot()
	moves := make([]plannedMove, 0, 4)
	for _, player := range []PlayerColor{FirstToMove, OtherColor(FirstToMove)} {
		from, to, ok := emptyStep(state, player)
		if !ok {
			t.Fatalf("no piece of %s's can step onto an empty square", player)
		}
		moves = append(moves, plannedMove{player: player, from: from, to: to})
	}
	// There and back: the second pair is the first pair reversed, in the same
	// order, so the four together return the board to where they found it.
	return []plannedMove{
		moves[0],
		moves[1],
		{player: moves[0].player, from: moves[0].to, to: moves[0].from},
		{player: moves[1].player, from: moves[1].to, to: moves[1].from},
	}
}

// emptyStep is a move by player onto an empty square, whoever's turn it is.
func emptyStep(state GameState, player PlayerColor) (from, to Position, ok bool) {
	for y, row := range state.Grid {
		for x, tile := range row {
			if tile.OccupantOwner != player {
				continue
			}
			at := Position{X: x, Y: y}
			for _, step := range neighbours(state.Grid, at) {
				if state.Grid.At(step).Occupant == Empty {
					return at, step, true
				}
			}
		}
	}
	return Position{}, Position{}, false
}

func neighbours(grid Grid, at Position) []Position {
	steps := make([]Position, 0, 8)
	for yOffset := -1; yOffset <= 1; yOffset++ {
		for xOffset := -1; xOffset <= 1; xOffset++ {
			if xOffset == 0 && yOffset == 0 {
				continue
			}
			step := Position{X: at.X + xOffset, Y: at.Y + yOffset}
			if grid.Contains(step) {
				steps = append(steps, step)
			}
		}
	}
	return steps
}
