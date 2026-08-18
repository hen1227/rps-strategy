package game

import (
	"errors"
	"fmt"
)

var ErrInvalidStartingPosition = errors.New("invalid starting position")

// StartingPosition is a compact, editable picture of a mode's opening board.
// Rows are written from Blue's home boundary (y=0) to Red's (y=8):
//
//	R/P/S = Blue rock/paper/scissors
//	r/p/s = Red rock/paper/scissors
//	.     = empty tile
//
// Use MustStartingPosition when defining a mode so typos fail at startup.
type StartingPosition struct {
	Rows [BoardSize]string `json:"rows"`
}

func NewStartingPosition(rows ...string) (StartingPosition, error) {
	var position StartingPosition
	if len(rows) != BoardSize {
		return position, fmt.Errorf(
			"%w: expected %d rows, got %d",
			ErrInvalidStartingPosition,
			BoardSize,
			len(rows),
		)
	}
	copy(position.Rows[:], rows)
	if err := position.Validate(); err != nil {
		return StartingPosition{}, err
	}
	return position, nil
}

func MustStartingPosition(rows ...string) StartingPosition {
	position, err := NewStartingPosition(rows...)
	if err != nil {
		panic(err)
	}
	return position
}

func (position StartingPosition) Validate() error {
	for y, row := range position.Rows {
		if len(row) != BoardSize {
			return fmt.Errorf(
				"%w: row %d must contain %d tiles, got %d",
				ErrInvalidStartingPosition,
				y,
				BoardSize,
				len(row),
			)
		}
		for x := 0; x < BoardSize; x++ {
			if _, _, valid := startingPiece(row[x]); !valid {
				return fmt.Errorf(
					"%w: unsupported symbol %q at (%d, %d)",
					ErrInvalidStartingPosition,
					row[x],
					x,
					y,
				)
			}
		}
	}
	return nil
}

func (position StartingPosition) apply(state *GameState) {
	for y, row := range position.Rows {
		for x := 0; x < BoardSize; x++ {
			piece, owner, _ := startingPiece(row[x])
			if piece == Empty {
				continue
			}
			state.Grid[y][x].Occupant = piece
			state.Grid[y][x].OccupantOwner = owner
			state.Grid[y][x].OwnerColor = owner
		}
	}
}

func startingPiece(symbol byte) (Piece, PlayerColor, bool) {
	switch symbol {
	case '.':
		return Empty, Neutral, true
	case 'R':
		return Rock, Blue, true
	case 'P':
		return Paper, Blue, true
	case 'S':
		return Scissors, Blue, true
	case 'r':
		return Rock, Red, true
	case 'p':
		return Paper, Red, true
	case 's':
		return Scissors, Red, true
	default:
		return Empty, Neutral, false
	}
}

// All built-in layouts live together so changing a mode's setup is a small,
// visual edit. Keep opposing formations balanced unless asymmetry is intended.
var (
	annihilationStartingPosition = MustStartingPosition(
		".........",
		".........",
		".........",
		".R.....s.",
		".P.....p.",
		".S.....r.",
		".........",
		".........",
		".........",
	)

	totalWarStartingPosition = MustStartingPosition(
		"...SSS...",
		"...PPP...",
		"...RRR...",
		".........",
		".........",
		".........",
		"...rrr...",
		"...ppp...",
		"...sss...",
	)

	infiltrationStartingPosition = MustStartingPosition(
		"...SSS...",
		"...PPP...",
		"...RRR...",
		".........",
		".........",
		".........",
		"...rrr...",
		"...ppp...",
		"...sss...",
	)
)
