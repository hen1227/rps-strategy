package game

import (
	"sort"
	"strings"
)

// The relabellings that leave a mode alone, and what it costs not to know them.
//
// A board and its reflection are the same position: the same moves are legal,
// the same plans work, and the same side is winning. Nothing in the rules can
// tell them apart, so nothing that counts positions should either -- a game
// that opened `e3-f3` and a game that opened `c5-c6` played the same opening on
// the same board, and an explorer that lists them as two lines with half the
// games each has split one fact in two.
//
// This is the *colour-preserving* half of the story, and that restriction is
// the point. RankFlip and HalfTurn in this package also map a game onto an
// equivalent game, but they swap Red and Blue on the way, so they answer "the
// same game played by the other side" -- which is a migration (rank_flip.go) or
// a way of reading an old record (half_turn.go), not a fold. A symmetry here
// leaves the side to move where it was, so two positions it identifies are
// interchangeable *for the player standing on them*, which is the only reading
// under which merging their statistics is honest.
//
// A mode declares which of these it is unchanged by; see ModeDefinition. It has
// to be declared rather than derived because the answer is half layout and half
// win condition. The layout half is checkable from data and is checked, at
// registration -- PreservesLayout. The win-condition half is Go: Infiltration
// races for a rank, so reversing files leaves it alone and transposing does
// not; Intransitive races for a1 and i9, which are the two squares the main
// diagonal fixes. TestBuiltInSymmetriesPlayTheSameGame is what pins that.

// BoardSymmetry is one relabelling of a board's squares.
//
// The zero value is the identity, which is what makes a group easy to carry
// around: a mode that declares no symmetries still has one, and the loops below
// do not special-case it.
type BoardSymmetry string

const (
	// SymmetryNone leaves every square where it is.
	SymmetryNone BoardSymmetry = ""
	// SymmetryMirrorFiles reflects across the board's middle file: on a nine
	// wide board a<->i, b<->h, c<->g, d<->f, and e alone. The symmetry of a
	// mode raced across the ranks, which is Total War and Infiltration.
	SymmetryMirrorFiles BoardSymmetry = "mirror-files"
	// SymmetryDiagonal reflects across the a1 to i9 diagonal: the square at
	// (x, y) goes to (y, x), so e3 <-> c5 and f3 <-> c6. The symmetry of a
	// mode raced along that diagonal, which is Intransitive -- whose two goal
	// corners are the two squares this reflection leaves alone.
	SymmetryDiagonal BoardSymmetry = "diagonal"
)

// Inverse is the symmetry that undoes this one.
//
// All three are their own inverse, and a caller that spelled that assumption
// inline would be right today and quietly wrong the first time a quarter turn
// is added. Naming it costs nothing and makes the direction of a fold something
// the code says out loud.
func (symmetry BoardSymmetry) Inverse() BoardSymmetry { return symmetry }

// FitsBoard reports whether this relabelling is even defined on this shape.
//
// Only the diagonal is fussy, and it is fussy for a real reason: transposing a
// nine by seven board maps real squares onto squares that are not there. A mode
// may be any rectangle, so this is asked rather than assumed.
func (symmetry BoardSymmetry) FitsBoard(width, height int) bool {
	switch symmetry {
	case SymmetryDiagonal:
		return width == height
	case SymmetryNone, SymmetryMirrorFiles:
		return width > 0 && height > 0
	default:
		return false
	}
}

// Square maps a coordinate onto the square it stands on after the relabelling.
func (symmetry BoardSymmetry) Square(width, height int, position Position) Position {
	switch symmetry {
	case SymmetryMirrorFiles:
		return Position{X: width - 1 - position.X, Y: position.Y}
	case SymmetryDiagonal:
		return Position{X: position.Y, Y: position.X}
	default:
		return position
	}
}

// Grid relabels a whole board, territory included.
//
// Territory travels with the square rather than staying where it was, for the
// same reason it does in HalfTurnGrid: Total War is decided by counting owned
// tiles, and a reflection that moved the pieces and left the ownership behind
// would be a different position rather than the same one seen from elsewhere.
//
// Colours are left exactly as they are. That is the difference between this and
// the two relabellings in rank_flip.go and half_turn.go, and it is why folding
// on these is safe for statistics that count Red wins and Blue wins.
func (symmetry BoardSymmetry) Grid(grid Grid) Grid {
	if symmetry == SymmetryNone {
		return grid
	}
	width, height := grid.Width(), grid.Height()
	relabelled := NewGrid(width, height)
	for y, row := range grid {
		for x, tile := range row {
			target := symmetry.Square(width, height, Position{X: x, Y: y})
			relabelled[target.Y][target.X] = Tile{
				X:             target.X,
				Y:             target.Y,
				Occupant:      tile.Occupant,
				OccupantOwner: tile.OccupantOwner,
				OwnerColor:    tile.OwnerColor,
			}
		}
	}
	return relabelled
}

// Layout relabels a starting position, which is the same map applied to the
// picture a mode is written as.
func (symmetry BoardSymmetry) Layout(position StartingPosition) StartingPosition {
	rows := position.Rows()
	if symmetry == SymmetryNone || len(rows) == 0 {
		return position
	}
	width, height := position.Width(), position.Height()
	relabelled := make([][]byte, height)
	for y := range relabelled {
		relabelled[y] = []byte(strings.Repeat(".", width))
	}
	for y, row := range rows {
		for x := 0; x < len(row); x++ {
			target := symmetry.Square(width, height, Position{X: x, Y: y})
			if target.Y < 0 || target.Y >= height || target.X < 0 || target.X >= width {
				return position
			}
			relabelled[target.Y][target.X] = row[x]
		}
	}
	written := make([]string, len(relabelled))
	for y, row := range relabelled {
		written[y] = string(row)
	}
	return StartingPosition{Layout: strings.Join(written, layoutRowSeparator)}
}

// PreservesLayout reports whether a mode's opening board is unchanged by this
// relabelling. The checkable half of "is this a symmetry of the mode": the
// other half is the win condition, which lives in Go and is declared.
func (symmetry BoardSymmetry) PreservesLayout(position StartingPosition) bool {
	if position.IsZero() {
		return false
	}
	if !symmetry.FitsBoard(position.Width(), position.Height()) {
		return false
	}
	return symmetry.Layout(position) == position
}

// SymmetryGroup is every relabelling a board of this mode may be folded by,
// identity first.
//
// Identity is always present and always first, so a caller may iterate this
// without asking whether the mode declared anything: a mode with no symmetries
// gets a group of one and every fold below becomes the identity fold, which is
// exactly the behaviour of not folding at all.
//
// A declared symmetry that does not fit the mode's own board is dropped rather
// than honoured. Registration refuses that mode, so this is belt and braces for
// a definition built at runtime -- a Lab mode, a test -- where nothing has
// checked it.
func (definition ModeDefinition) SymmetryGroup() []BoardSymmetry {
	group := make([]BoardSymmetry, 0, len(definition.Symmetries)+1)
	group = append(group, SymmetryNone)
	for _, symmetry := range definition.Symmetries {
		if symmetry == SymmetryNone || !symmetry.PreservesLayout(definition.StartingPosition) {
			continue
		}
		if !containsSymmetry(group, symmetry) {
			group = append(group, symmetry)
		}
	}
	return group
}

func containsSymmetry(group []BoardSymmetry, symmetry BoardSymmetry) bool {
	for _, candidate := range group {
		if candidate == symmetry {
			return true
		}
	}
	return false
}

// CanonicalBoard names a board once, however it happens to be turned.
//
// Returns the smallest spelling of the board under the group, and every
// symmetry in the group that produces it. Which of the equivalent boards wins
// does not matter -- that both of them pick the same one is the whole point,
// and the same argument canonicalOpeningLine makes about mirrored lines.
//
// The second return is not a diagnostic. A caller folding *moves* onto the same
// board needs to know which relabellings took it there: from a board the
// reflection leaves alone, e3-f3 and c5-c6 are one move written twice, and the
// set returned here is exactly what says so. It is never empty, because the
// group always contains the identity.
func CanonicalBoard(grid Grid, group []BoardSymmetry) (string, []BoardSymmetry) {
	width, height := grid.Width(), grid.Height()
	best := ""
	var achieving []BoardSymmetry
	for _, symmetry := range group {
		if !symmetry.FitsBoard(width, height) {
			continue
		}
		spelling := symmetry.Grid(grid).Key()
		switch {
		case achieving == nil || spelling < best:
			best, achieving = spelling, []BoardSymmetry{symmetry}
		case spelling == best:
			achieving = append(achieving, symmetry)
		}
	}
	if achieving == nil {
		return grid.Key(), []BoardSymmetry{SymmetryNone}
	}
	return best, achieving
}

// CanonicalMoveName is the one spelling a move out of a board is stored under.
//
// `transforms` is CanonicalBoard's second return for the board the move is
// played *from*: every relabelling that takes it to its canonical spelling. So
// this writes the move on the canonical board and picks the smallest spelling
// of it there, and two games that played mirror-image moves from mirror-image
// boards both arrive at the same string -- which is what merges their counts
// into one row instead of two.
func CanonicalMoveName(
	width, height int,
	transforms []BoardSymmetry,
	from, to Position,
) string {
	best := ""
	for _, symmetry := range transforms {
		name := OpeningMoveName(
			symmetry.Square(width, height, from),
			symmetry.Square(width, height, to),
		)
		if best == "" || name < best {
			best = name
		}
	}
	if best == "" {
		return OpeningMoveName(from, to)
	}
	return best
}

// MoveSpellings is every way a stored move can be written on the board the
// caller is actually standing on, smallest first.
//
// The inverse of CanonicalMoveName, and the reason the explorer can fold
// without lying about the board on screen: the statistics are kept on a
// canonical board, the visitor is standing on whichever image of it they walked
// to, and this maps a stored move back into their coordinates. More than one
// spelling comes back exactly when the board they are standing on is left alone
// by a symmetry -- that is `e3-f3` and `c5-c6` from the opening position, one
// move that can be played two ways, which the board draws as one arrow and its
// dashed twin.
func MoveSpellings(
	width, height int,
	transforms []BoardSymmetry,
	from, to Position,
) []string {
	spellings := make([]string, 0, len(transforms))
	for _, symmetry := range transforms {
		inverse := symmetry.Inverse()
		name := OpeningMoveName(
			inverse.Square(width, height, from),
			inverse.Square(width, height, to),
		)
		if !containsString(spellings, name) {
			spellings = append(spellings, name)
		}
	}
	if len(spellings) == 0 {
		return []string{OpeningMoveName(from, to)}
	}
	sort.Strings(spellings)
	return spellings
}

func containsString(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
