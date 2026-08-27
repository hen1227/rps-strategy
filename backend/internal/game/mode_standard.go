package game

import "errors"

var (
	ErrGameFinished     = errors.New("game is already finished")
	ErrOutOfBounds      = errors.New("position is outside the board")
	ErrWrongTurn        = errors.New("that piece does not belong to the current player")
	ErrInvalidMovement  = errors.New("pieces must move exactly one tile in any direction")
	ErrFriendlyOccupied = errors.New("destination is occupied by a friendly piece")
	ErrInvalidCapture   = errors.New("attacking piece cannot capture the destination piece")
)

// standardRPSRules is a composition helper, not an engine-level rule set.
// Modes may use it, replace it, or combine it with entirely different movement.
type standardRPSRules struct{}

// initializeBoard allocates the board this layout describes and paints it. The
// shape comes from the layout rather than from a constant, which is what lets a
// mode be any rectangle.
func (standardRPSRules) initializeBoard(
	state *GameState,
	startingPosition StartingPosition,
) {
	state.Grid = NewGrid(startingPosition.Width(), startingPosition.Height())
	startingPosition.apply(state)
}

func (rules standardRPSRules) validMoves(state GameState, player PlayerColor, from Position) []Position {
	if state.Status != InProgress || state.CurrentTurn != player ||
		!state.Grid.Contains(from) {
		return nil
	}
	if state.Grid[from.Y][from.X].OccupantOwner != player {
		return nil
	}

	moves := make([]Position, 0, 8)
	for yOffset := -1; yOffset <= 1; yOffset++ {
		for xOffset := -1; xOffset <= 1; xOffset++ {
			if xOffset == 0 && yOffset == 0 {
				continue
			}
			to := Position{X: from.X + xOffset, Y: from.Y + yOffset}
			if rules.validateMove(state, player, from, to) == nil {
				moves = append(moves, to)
			}
		}
	}
	return moves
}

func (standardRPSRules) validateMove(state GameState, player PlayerColor, from, to Position) error {
	if state.Status != InProgress {
		return ErrGameFinished
	}
	if player != state.CurrentTurn {
		return ErrWrongTurn
	}
	if !state.Grid.Contains(from) || !state.Grid.Contains(to) {
		return ErrOutOfBounds
	}

	source := state.Grid[from.Y][from.X]
	destination := state.Grid[to.Y][to.X]
	if source.Occupant == Empty || source.OccupantOwner != player {
		return ErrWrongTurn
	}
	if max(abs(to.X-from.X), abs(to.Y-from.Y)) != 1 {
		return ErrInvalidMovement
	}
	if destination.OccupantOwner == player {
		return ErrFriendlyOccupied
	}
	if destination.Occupant != Empty && !canCapture(source.Occupant, destination.Occupant) {
		return ErrInvalidCapture
	}
	return nil
}

func (rules standardRPSRules) movePiece(
	state *GameState,
	player PlayerColor,
	from Position,
	to Position,
) error {
	if err := rules.validateMove(*state, player, from, to); err != nil {
		return err
	}
	source := &state.Grid[from.Y][from.X]
	destination := &state.Grid[to.Y][to.X]
	destination.Occupant = source.Occupant
	destination.OccupantOwner = player
	source.Occupant = Empty
	source.OccupantOwner = Neutral
	state.MoveNumber++
	return nil
}

func (standardRPSRules) finish(
	state *GameState,
	winner PlayerColor,
	reason GameEndReason,
) {
	state.Status = Finished
	state.Winner = winner
	state.EndReason = reason
}

func (standardRPSRules) passTurn(state *GameState, player PlayerColor) {
	state.CurrentTurn = OtherColor(player)
}

func canCapture(attacker, defender Piece) bool {
	return (attacker == Rock && defender == Scissors) ||
		(attacker == Scissors && defender == Paper) ||
		(attacker == Paper && defender == Rock)
}

func countPieces(grid Grid, color PlayerColor) int {
	count := 0
	for _, row := range grid {
		for _, tile := range row {
			if tile.OccupantOwner == color {
				count++
			}
		}
	}
	return count
}

func countTerritory(grid Grid) (red, blue, neutral int) {
	for _, row := range grid {
		for _, tile := range row {
			switch tile.OwnerColor {
			case Red:
				red++
			case Blue:
				blue++
			default:
				neutral++
			}
		}
	}
	return
}

func OtherColor(color PlayerColor) PlayerColor {
	if color == Red {
		return Blue
	}
	return Red
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
