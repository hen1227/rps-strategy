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

func (standardRPSRules) initializeBoard(
	state *GameState,
	startingPosition StartingPosition,
) {
	for y := 0; y < BoardSize; y++ {
		for x := 0; x < BoardSize; x++ {
			state.Grid[y][x] = Tile{
				X:             x,
				Y:             y,
				Occupant:      Empty,
				OccupantOwner: Neutral,
				OwnerColor:    Neutral,
			}
		}
	}
	startingPosition.apply(state)
}

func (rules standardRPSRules) validMoves(state GameState, player PlayerColor, from Position) []Position {
	if state.Status != InProgress || state.CurrentTurn != player || !inBounds(from) {
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
	if !inBounds(from) || !inBounds(to) {
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

func countPieces(grid [BoardSize][BoardSize]Tile, color PlayerColor) int {
	count := 0
	for y := range grid {
		for x := range grid[y] {
			if grid[y][x].OccupantOwner == color {
				count++
			}
		}
	}
	return count
}

func countTerritory(grid [BoardSize][BoardSize]Tile) (red, blue, neutral int) {
	for y := range grid {
		for x := range grid[y] {
			switch grid[y][x].OwnerColor {
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

func inBounds(position Position) bool {
	return position.X >= 0 && position.X < BoardSize && position.Y >= 0 && position.Y < BoardSize
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
