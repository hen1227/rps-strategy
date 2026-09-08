package game

import "strings"

// The rank flip: reverse the ranks and swap the colours.
//
// This is how a record written before 2026-09-03 is read under today's rules,
// and it is a *migration* rather than a symmetry -- which is the whole reason
// it is not the half turn in half_turn.go.
//
// Two things changed that day, not one. Blue moves first now, where Red used
// to; and Intransitive's board was flipped end for end, so the corner Red runs
// for moved from i1 to a1 and Blue's from a9 to i9. Reversing the ranks and
// swapping the colours undoes both at once: an old game's Red, opening from
// the top of the board and racing for i1, becomes a new game's Blue, opening
// from the bottom and racing for i9. Nothing about the play changes, only
// which end of the board it is written from.
//
// The half turn is a symmetry of today's rules -- TestHalfTurnPlaysTheSameGame
// proves it, and it stays true. It is simply the wrong map for the archive: it
// carries today's Intransitive onto itself, and what an old record needs is
// the map from *yesterday's* Intransitive onto today's. The two agree on Total
// War and Infiltration, whose layouts and rank goals are unchanged by
// reversing files, which is why the difference only shows up on V6 -- and why
// it showed up as an entire mode's archive being skipped rather than as
// anything obviously wrong.
//
// TestRankFlipReadsThePreChangeArchive pins it against real archived games.

// RankFlip reverses a layout's ranks and swaps every piece's colour. Files are
// left alone: this is an end-for-end flip, not a rotation.
func (position StartingPosition) RankFlip() StartingPosition {
	rows := position.Rows()
	flipped := make([]string, len(rows))
	for y, row := range rows {
		swapped := make([]byte, len(row))
		for x := 0; x < len(row); x++ {
			swapped[x] = swapSymbolColor(row[x])
		}
		flipped[len(rows)-1-y] = string(swapped)
	}
	return StartingPosition{Layout: strings.Join(flipped, layoutRowSeparator)}
}

// RankFlipSquare maps a square onto the square it stands on after the flip.
func RankFlipSquare(_, height int, position Position) Position {
	return Position{X: position.X, Y: height - 1 - position.Y}
}

// RankFlipGrid flips a whole board, territory included.
//
// Territory travels with the pieces rather than staying where it was: a tile
// Red owned is, after the relabelling, a tile Blue owns on the opposite rank,
// and Total War is decided by counting those.
func RankFlipGrid(grid Grid) Grid {
	width, height := grid.Width(), grid.Height()
	flipped := NewGrid(width, height)
	for y, row := range grid {
		for x, tile := range row {
			target := RankFlipSquare(width, height, Position{X: x, Y: y})
			flipped[target.Y][target.X] = Tile{
				X:             target.X,
				Y:             target.Y,
				Occupant:      tile.Occupant,
				OccupantOwner: swapColor(tile.OccupantOwner),
				OwnerColor:    swapColor(tile.OwnerColor),
			}
		}
	}
	return flipped
}
