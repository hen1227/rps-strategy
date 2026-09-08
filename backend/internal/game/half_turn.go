package game

import "strings"

// The half turn: rotate the board through half a circle and swap the colours.
//
// It is the one relabelling that turns a game one side played into the same
// game played by the other, and it is here because the rules changed on
// 2026-09-03 -- Blue moves first now, where Red used to. A game recorded
// before that opens with a Red move from Red's own half, which is not a legal
// opening now; turned, it is Blue opening from Blue's half, which is. Nothing
// about the play changes, only which end of the board it is written from.
//
// Sound only where a mode is unchanged by it, which is what
// HalfTurnSwapsColors asks of a layout. It is a symmetry of every built-in
// mode's *rules* as well: movement is eight-connected and captures depend only
// on the two pieces, so neither knows a colour; Infiltration's goal ranks and
// Intransitive's goal corners are each other's images; and Total War counts
// pieces and territory, which the relabelling permutes rather than changes.
// TestBuiltInStartingPositionsAreBalanced pins the layouts, and
// TestHalfTurnPlaysTheSameGame the rules.

// HalfTurn turns a layout: rank 1 becomes the last rank, file a becomes the
// last file, and every piece changes hands.
func (position StartingPosition) HalfTurn() StartingPosition {
	rows := position.Rows()
	turned := make([]string, len(rows))
	for y, row := range rows {
		flipped := make([]byte, len(row))
		for x := 0; x < len(row); x++ {
			flipped[x] = swapSymbolColor(row[len(row)-1-x])
		}
		turned[len(rows)-1-y] = string(flipped)
	}
	return StartingPosition{Layout: strings.Join(turned, layoutRowSeparator)}
}

// HalfTurnSwapsColors reports whether the half turn leaves this layout alone.
//
// The companion to MirrorsFiles, and the other way a layout can be fair: a
// mode raced across the ranks is balanced by mirroring files, one raced along
// the diagonal by the half turn. This is the stronger claim of the two for a
// reader of the archive, because it is what makes an old game where Red opened
// the same game as a new one where Blue did.
func (position StartingPosition) HalfTurnSwapsColors() bool {
	return !position.IsZero() && position.HalfTurn() == position
}

// HalfTurnSquare maps a square onto the square it stands on after the turn.
func HalfTurnSquare(width, height int, position Position) Position {
	return Position{X: width - 1 - position.X, Y: height - 1 - position.Y}
}

// HalfTurnGrid turns a whole board, territory included.
//
// Territory is turned with the pieces rather than left where it was: a tile
// Red owned is, after the relabelling, a tile Blue owns at the opposite
// corner, and Total War is decided by counting those.
func HalfTurnGrid(grid Grid) Grid {
	width, height := grid.Width(), grid.Height()
	turned := NewGrid(width, height)
	for y, row := range grid {
		for x, tile := range row {
			target := HalfTurnSquare(width, height, Position{X: x, Y: y})
			turned[target.Y][target.X] = Tile{
				X:             target.X,
				Y:             target.Y,
				Occupant:      tile.Occupant,
				OccupantOwner: swapColor(tile.OccupantOwner),
				OwnerColor:    swapColor(tile.OwnerColor),
			}
		}
	}
	return turned
}

// swapColor exchanges Red and Blue and leaves Neutral where it is, unlike
// OtherColor, which answers "the opponent" and so has no reading for a tile
// nobody owns.
func swapColor(color PlayerColor) PlayerColor {
	switch color {
	case Red:
		return Blue
	case Blue:
		return Red
	default:
		return color
	}
}

// swapSymbolColor changes the case of a layout symbol, which is how a layout
// spells whose piece it is. A symbol that is neither -- an empty tile -- is
// its own image.
func swapSymbolColor(symbol byte) byte {
	switch {
	case symbol >= 'A' && symbol <= 'Z':
		return symbol + ('a' - 'A')
	case symbol >= 'a' && symbol <= 'z':
		return symbol - ('a' - 'A')
	default:
		return symbol
	}
}
