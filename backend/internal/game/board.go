package game

import (
	"errors"
	"fmt"
	"strings"
)

var ErrInvalidBoardSize = errors.New("invalid board size")

// The board, as a shape rather than a constant.
//
// Every built-in mode is nine by nine, and for a long time that was spelled as
// a fixed array — which made the size a compile-time fact and handed every
// caller a copy for free. A spec-defined mode may be any rectangle, so the grid
// is a slice now, and the two properties the array gave away have to be bought
// back deliberately:
//
//  1. **Bounds come from the board, not from a constant.** `Contains` is the
//     only bounds check; nothing may compare a coordinate against BoardSize.
//  2. **A slice is shared, an array was copied.** Anything that hands a grid
//     outside the mutex that guards it must `Clone` first. `Game.snapshotLocked`
//     is where that happens for live games, and `Grid.Equal` replaces the `==`
//     that record verification used to rely on.

// Grid is the playing surface: rows of tiles addressed grid[y][x], with y
// running from Blue's home boundary to Red's. Rectangular by construction —
// every row has the same length.
//
// It marshals as a JSON array of arrays, exactly as the fixed array did, so the
// wire format and every client reading `grid[y][x]` are unaffected.
type Grid [][]Tile

// NewGrid returns an empty board of the given shape, with every tile carrying
// its own coordinates. Callers that build a board by hand rely on those
// coordinates being right: they travel to the client inside each tile.
func NewGrid(width, height int) Grid {
	grid := make(Grid, height)
	for y := range grid {
		row := make([]Tile, width)
		for x := range row {
			row[x] = Tile{
				X:             x,
				Y:             y,
				Occupant:      Empty,
				OccupantOwner: Neutral,
				OwnerColor:    Neutral,
			}
		}
		grid[y] = row
	}
	return grid
}

// Width is the number of files. Zero for an empty grid, which is what a
// zero-value GameState carries before a mode initializes it.
func (grid Grid) Width() int {
	if len(grid) == 0 {
		return 0
	}
	return len(grid[0])
}

// Height is the number of ranks.
func (grid Grid) Height() int { return len(grid) }

// Contains reports whether a coordinate is on this board. The only bounds check
// in the package: a comparison against BoardSize would be wrong on any board
// that is not nine wide.
func (grid Grid) Contains(position Position) bool {
	return position.Y >= 0 && position.Y < len(grid) &&
		position.X >= 0 && position.X < len(grid[position.Y])
}

// At is the tile at a coordinate. Callers must have checked Contains; this
// panics on an off-board coordinate rather than inventing an empty tile,
// because a rule that reads off the edge of the board is a bug and returning
// something plausible would hide it.
func (grid Grid) At(position Position) Tile {
	return grid[position.Y][position.X]
}

// Clone is a deep copy. Every hand-off of a grid across a lock boundary needs
// one; see the note at the top of this file.
func (grid Grid) Clone() Grid {
	if grid == nil {
		return nil
	}
	copied := make(Grid, len(grid))
	for y, row := range grid {
		copied[y] = make([]Tile, len(row))
		copy(copied[y], row)
	}
	return copied
}

// Equal compares two boards tile for tile. This is what `==` on the old fixed
// array did, and record verification depends on it.
func (grid Grid) Equal(other Grid) bool {
	if len(grid) != len(other) {
		return false
	}
	for y, row := range grid {
		if len(row) != len(other[y]) {
			return false
		}
		for x, tile := range row {
			if tile != other[y][x] {
				return false
			}
		}
	}
	return true
}

// Key is a compact, comparable spelling of everything about this board that
// determines legal play: what stands where, whose it is, and who owns the
// ground. Deliberately not a FEN — `internal/notation` imports this package, so
// it cannot be reached from here — and deliberately not the tiles themselves,
// because the repetition table needs a map key and a slice cannot be one.
//
// Pieces are written by name rather than by letter, and that is not verbosity.
// A letter needs an alphabet, and the alphabet belongs to the mode: a
// spec-defined mode's Stone has no letter here, so a symbol table would spell
// every Stone as an empty square and collide two different positions into one —
// which is a *false threefold repetition*, a game declared drawn that was not.
// `positionKey` in the browser encodes the same three fields for the same
// reason.
func (grid Grid) Key() string {
	var key strings.Builder
	key.Grow(grid.Width() * grid.Height() * 12)
	for y, row := range grid {
		if y > 0 {
			key.WriteByte('/')
		}
		for _, tile := range row {
			key.WriteString(string(tile.Occupant))
			key.WriteByte(':')
			key.WriteString(string(tile.OccupantOwner))
			key.WriteByte(':')
			key.WriteString(string(tile.OwnerColor))
			key.WriteByte(',')
		}
	}
	return key.String()
}

// ValidateBoardSize reports whether a rectangle is a board this project can
// play, name and search. The lower bound is a board with somewhere to move; the
// upper bounds are one letter per file (a to z) and a cap on how much work a
// single position can be.
func ValidateBoardSize(width, height int) error {
	if width < MinBoardSide || height < MinBoardSide {
		return errBoardSize(
			"board must be at least %d by %d, got %d by %d",
			MinBoardSide, MinBoardSide, width, height,
		)
	}
	if width > MaxBoardSide || height > MaxBoardSide {
		return errBoardSize(
			"board must be at most %d by %d, got %d by %d",
			MaxBoardSide, MaxBoardSide, width, height,
		)
	}
	if width*height > MaxBoardTiles {
		return errBoardSize(
			"board must hold at most %d tiles, got %d",
			MaxBoardTiles, width*height,
		)
	}
	return nil
}

func errBoardSize(format string, args ...any) error {
	return fmt.Errorf("%w: "+format, append([]any{ErrInvalidBoardSize}, args...)...)
}
