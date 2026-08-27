package game

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

var ErrInvalidStartingPosition = errors.New("invalid starting position")

// StartingPosition is a compact, editable picture of a mode's opening board.
// Rows are written from Blue's home boundary (y=0) to Red's:
//
//	R/P/S = Blue rock/paper/scissors
//	r/p/s = Red rock/paper/scissors
//	.     = empty tile
//
// Use MustStartingPosition when defining a mode so typos fail at startup.
//
// The rows are held as one string joined by "/" rather than as a slice, and
// that is load-bearing rather than a detail: GameSetup is compared with `==`
// and that comparison *is* the whole matchmaking pairing rule (see setup.go),
// so every field reachable from it has to be comparable. A []string would not
// be. The JSON shape is still {"rows": [...]} — see MarshalJSON — so the wire
// format, every stored record and the frontend's own type are unaffected.
//
// The board's shape is derivable from the layout rather than stored beside it:
// the height is the number of rows and the width is their common length, so
// there is no second copy of the size to disagree with the first.
type StartingPosition struct {
	Layout string
}

const layoutRowSeparator = "/"

func NewStartingPosition(rows ...string) (StartingPosition, error) {
	position := StartingPosition{Layout: strings.Join(rows, layoutRowSeparator)}
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

// IsZero reports the absent starting position: the value a GameSetup carries
// when its author did not draw a board, which Normalize fills in from the mode.
func (position StartingPosition) IsZero() bool { return position.Layout == "" }

// Rows is the layout as one string per rank. Freshly allocated, so a caller may
// keep or edit it.
func (position StartingPosition) Rows() []string {
	if position.Layout == "" {
		return nil
	}
	return strings.Split(position.Layout, layoutRowSeparator)
}

// Height is the number of ranks.
func (position StartingPosition) Height() int {
	if position.Layout == "" {
		return 0
	}
	return strings.Count(position.Layout, layoutRowSeparator) + 1
}

// Width is the number of files, taken from the first rank. Only meaningful for
// a position that has passed Validate, which is what makes the ranks agree.
func (position StartingPosition) Width() int {
	if position.Layout == "" {
		return 0
	}
	first, _, _ := strings.Cut(position.Layout, layoutRowSeparator)
	return len(first)
}

// ValidateShape checks everything about a layout that does not depend on which
// letters a mode writes its pieces with: that there are rows, that they are all
// the same length, and that the rectangle is one this project can play.
//
// Separate from Validate because the alphabet belongs to the mode. The built-in
// modes use R/P/S; a spec-defined mode declares its own, and a layout full of
// Lizards is a perfectly good layout that Validate would refuse.
func (position StartingPosition) ValidateShape() error {
	rows := position.Rows()
	if len(rows) == 0 {
		return fmt.Errorf("%w: no rows", ErrInvalidStartingPosition)
	}
	width := len(rows[0])
	if err := ValidateBoardSize(width, len(rows)); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidStartingPosition, err)
	}
	for y, row := range rows {
		if len(row) != width {
			return fmt.Errorf(
				"%w: row %d must contain %d tiles, got %d",
				ErrInvalidStartingPosition,
				y,
				width,
				len(row),
			)
		}
	}
	return nil
}

// Validate is ValidateShape plus the standard R/P/S alphabet. This is what a
// hand-written mode's layout is checked against, at start-up, by
// MustStartingPosition.
func (position StartingPosition) Validate() error {
	if err := position.ValidateShape(); err != nil {
		return err
	}
	for y, row := range position.Rows() {
		for x := 0; x < len(row); x++ {
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

// MarshalJSON keeps the wire shape the fixed array had: {"rows": [...]}. The
// internal string is an implementation detail of staying comparable, and
// leaking it would break every client and every archived record.
func (position StartingPosition) MarshalJSON() ([]byte, error) {
	rows := position.Rows()
	if rows == nil {
		rows = []string{}
	}
	return json.Marshal(startingPositionJSON{Rows: rows})
}

func (position *StartingPosition) UnmarshalJSON(data []byte) error {
	var decoded startingPositionJSON
	if err := json.Unmarshal(data, &decoded); err != nil {
		return err
	}
	position.Layout = strings.Join(decoded.Rows, layoutRowSeparator)
	return nil
}

type startingPositionJSON struct {
	Rows []string `json:"rows"`
}

// apply paints this layout onto a board that is already the right shape.
func (position StartingPosition) apply(state *GameState) {
	for y, row := range position.Rows() {
		for x := 0; x < len(row); x++ {
			if !state.Grid.Contains(Position{X: x, Y: y}) {
				continue
			}
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

// occupantSymbol is startingPiece backwards: the one letter a piece is written
// with, upper case for Blue and lower for Red. The two must stay inverses —
// a layout painted onto a board and read back off it has to be the same string.
func occupantSymbol(piece Piece, owner PlayerColor) byte {
	var letter byte
	switch piece {
	case Rock:
		letter = 'R'
	case Paper:
		letter = 'P'
	case Scissors:
		letter = 'S'
	default:
		return '.'
	}
	switch owner {
	case Blue:
		return letter
	case Red:
		return letter + ('a' - 'A')
	default:
		return '.'
	}
}

// colorSymbol names a side in one character, for the compact position keys in
// board.go. Not a notation anybody reads; territory in a FEN is a whole
// separate field, spelled in internal/notation.
func colorSymbol(color PlayerColor) byte {
	switch color {
	case Red:
		return 'r'
	case Blue:
		return 'b'
	default:
		return '-'
	}
}

// StartingPositionFrom reads a board back out as a layout. The inverse of
// apply, for a caller holding a position somebody drew.
func StartingPositionFrom(grid Grid) StartingPosition {
	rows := make([]string, 0, grid.Height())
	for _, row := range grid {
		symbols := make([]byte, len(row))
		for x, tile := range row {
			symbols[x] = occupantSymbol(tile.Occupant, tile.OccupantOwner)
		}
		rows = append(rows, string(symbols))
	}
	return StartingPosition{Layout: strings.Join(rows, layoutRowSeparator)}
}

// All built-in layouts live together so changing a mode's setup is a small,
// visual edit. Keep opposing formations balanced unless asymmetry is intended.
var (
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

// MirrorsFiles reports whether reversing files leaves this layout unchanged.
//
// It is the one thing a mode has to satisfy for `d8-c7` and `f8-g7` to be the
// same opening seen twice. Nothing else in the rules distinguishes one file
// from another: movement is eight-connected, captures depend only on the two
// pieces, and the only goal that names a coordinate is Infiltration's, which
// is a whole rank. RPSFish folds its book on the same fact -- see
// `Transform::FILES` in its model -- so this is where the website agrees with
// the engine about which positions are the same picture.
func (position StartingPosition) MirrorsFiles() bool {
	for _, row := range position.Rows() {
		for x := 0; x < len(row)/2; x++ {
			if row[x] != row[len(row)-1-x] {
				return false
			}
		}
	}
	return true
}
