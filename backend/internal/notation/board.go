// Package notation reads and writes RPS Strategy games as PGN.
//
// The dialect follows chess PGN's shape — a tag pair section, then movetext
// ending in a result token — with three deliberate differences that come from
// the game rather than from taste:
//
//   - Squares are a1 upwards. Files run left to right as letters (x = 0 is "a")
//     and ranks from Blue's home boundary (y = 0 is rank 1) to Red's, matching
//     the engine's coordinates exactly. The built-in modes are nine by nine, so
//     their squares are a1 to i9; a spec-defined mode may be any rectangle up to
//     26 a side, which is where "z26" and two-digit ranks come from.
//   - A move names the piece that moved, the square it left, and the square it
//     entered: Rd7-d6 quietly, Rd7xd6 for a capture. The captured piece is
//     never written because it cannot be in doubt: rock takes only scissors,
//     paper only rock, scissors only paper.
//   - Everything that is not a move — a draw offer, a time extension, the
//     ending itself — is a %-annotation comment, so the movetext carries the
//     whole game and not just its moves.
//
// Encode and Parse are inverses. Parse hands back a game.Record that
// game.Verify replays into the exact final position, which is what makes an
// archived PGN a complete description of one game and no other.
package notation

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"rps-strategy/backend/internal/game"
)

var ErrInvalidPosition = errors.New("invalid position")

// fileLetters is game.FileLetters, named locally because this package spells
// squares in both directions and the parse side needs an index lookup.
const fileLetters = game.FileLetters

// FormatSquare renders a board coordinate as "a1" through "z26".
//
// The same spelling the opening book uses, and the same function: a record and
// a book line that named squares differently would be two coordinate systems
// with one name.
func FormatSquare(position game.Position) string {
	return game.SquareName(position)
}

// ParseSquare reads "a1" through "z26".
//
// The rank is a decimal number rather than a single digit, so "d10" is a square
// on a board that has one. Bounded by MaxBoardSide rather than by a particular
// board: a move is parsed before its board is known — the FEN in the same file
// is what settles the shape — so this rejects only what can be no square at all.
func ParseSquare(text string) (game.Position, error) {
	invalid := func() (game.Position, error) {
		return game.Position{}, fmt.Errorf("%w: %q is not a square", ErrInvalidPosition, text)
	}
	if len(text) < 2 {
		return invalid()
	}
	x := strings.IndexByte(fileLetters, text[0])
	if x < 0 {
		return invalid()
	}
	rank, err := strconv.Atoi(text[1:])
	if err != nil || rank < 1 || rank > game.MaxBoardSide {
		return invalid()
	}
	return game.Position{X: x, Y: rank - 1}, nil
}

// pieceSymbols follows game.StartingPosition: uppercase is Blue, lowercase is
// Red, so a board written here can be pasted into a mode definition.
func pieceSymbol(piece game.Piece, owner game.PlayerColor) (byte, bool) {
	var symbol byte
	switch piece {
	case game.Rock:
		symbol = 'R'
	case game.Paper:
		symbol = 'P'
	case game.Scissors:
		symbol = 'S'
	default:
		return 0, false
	}
	if owner == game.Red {
		symbol += 'a' - 'A'
	}
	return symbol, true
}

func pieceLetter(piece game.Piece) string {
	switch piece {
	case game.Rock:
		return "R"
	case game.Paper:
		return "P"
	case game.Scissors:
		return "S"
	default:
		return "?"
	}
}

func pieceFromLetter(letter string) (game.Piece, bool) {
	switch letter {
	case "R":
		return game.Rock, true
	case "P":
		return game.Paper, true
	case "S":
		return game.Scissors, true
	default:
		return game.Empty, false
	}
}

// Defeats returns the piece a capture must have taken. Rock beats scissors,
// scissors beats paper, and paper beats rock, so an attacker names its victim.
func Defeats(attacker game.Piece) game.Piece {
	switch attacker {
	case game.Rock:
		return game.Scissors
	case game.Scissors:
		return game.Paper
	case game.Paper:
		return game.Rock
	default:
		return game.Empty
	}
}

func territorySymbol(owner game.PlayerColor) (byte, bool) {
	switch owner {
	case game.Red:
		return 'r', true
	case game.Blue:
		return 'b', true
	default:
		return 0, false
	}
}

func colorCode(color game.PlayerColor) string {
	switch color {
	case game.Red:
		return "r"
	case game.Blue:
		return "b"
	default:
		return "-"
	}
}

func colorFromCode(code string) (game.PlayerColor, error) {
	switch code {
	case "r":
		return game.Red, nil
	case "b":
		return game.Blue, nil
	case "-":
		return game.Neutral, nil
	default:
		return game.Neutral, fmt.Errorf("%w: %q is not a color", ErrInvalidPosition, code)
	}
}

// EncodePosition writes a board as an FEN-like string with three fields:
// pieces, the side to move, and territory ownership. Territory is a separate
// field because a tile can be owned by a player who has no piece on it, which
// decides Total War.
//
// Rows run from rank 1 upwards separated by "/", numbers count consecutive
// unoccupied (or unowned) tiles, and territory uses "r" and "b". The board's
// shape is derivable from the string — the rows are the ranks and each row's
// runs add up to the files — so a position needs nothing beside it to be read
// back on a board of any size.
func EncodePosition(grid game.Grid, turn game.PlayerColor) string {
	pieces := encodeRows(grid, func(tile game.Tile) (byte, bool) {
		return pieceSymbol(tile.Occupant, tile.OccupantOwner)
	})
	territory := encodeRows(grid, func(tile game.Tile) (byte, bool) {
		return territorySymbol(tile.OwnerColor)
	})
	return pieces + " " + colorCode(turn) + " " + territory
}

func encodeRows(
	grid game.Grid,
	symbolFor func(game.Tile) (byte, bool),
) string {
	rows := make([]string, 0, grid.Height())
	for _, tiles := range grid {
		row := strings.Builder{}
		gap := 0
		for _, tile := range tiles {
			symbol, occupied := symbolFor(tile)
			if !occupied {
				gap++
				continue
			}
			if gap > 0 {
				fmt.Fprintf(&row, "%d", gap)
				gap = 0
			}
			row.WriteByte(symbol)
		}
		if gap > 0 {
			fmt.Fprintf(&row, "%d", gap)
		}
		rows = append(rows, row.String())
	}
	return strings.Join(rows, "/")
}

// DecodePosition reverses EncodePosition. The territory field may be omitted,
// in which case ownership follows the pieces, which is how every mode's
// opening board looks.
//
// The board's shape comes from the text rather than from a constant: the ranks
// are the rows and the files are what one rank's runs add up to. That is what
// makes an archived position self-describing, so a record played on an eleven
// by eleven board replays without anything telling the parser so.
func DecodePosition(text string) (game.Grid, game.PlayerColor, error) {
	fields := strings.Fields(strings.TrimSpace(text))
	if len(fields) == 0 {
		return nil, game.Neutral, fmt.Errorf("%w: empty position", ErrInvalidPosition)
	}
	width, height, err := measureRows(fields[0])
	if err != nil {
		return nil, game.Neutral, err
	}
	if err := game.ValidateBoardSize(width, height); err != nil {
		return nil, game.Neutral, fmt.Errorf("%w: %v", ErrInvalidPosition, err)
	}
	grid := game.NewGrid(width, height)
	if err := decodeRows(fields[0], width, height, func(x, y int, symbol byte) error {
		piece, owner, valid := startingPieceSymbol(symbol)
		if !valid {
			return fmt.Errorf("%w: unsupported piece %q", ErrInvalidPosition, string(symbol))
		}
		grid[y][x].Occupant = piece
		grid[y][x].OccupantOwner = owner
		grid[y][x].OwnerColor = owner
		return nil
	}); err != nil {
		return grid, game.Neutral, err
	}

	turn := game.Neutral
	if len(fields) > 1 {
		parsed, err := colorFromCode(fields[1])
		if err != nil {
			return grid, game.Neutral, err
		}
		turn = parsed
	}
	if len(fields) > 2 {
		for _, row := range grid {
			for x := range row {
				row[x].OwnerColor = game.Neutral
			}
		}
		if err := decodeRows(fields[2], width, height, func(x, y int, symbol byte) error {
			owner, err := colorFromCode(string(symbol))
			if err != nil || owner == game.Neutral {
				return fmt.Errorf("%w: unsupported territory %q", ErrInvalidPosition, string(symbol))
			}
			grid[y][x].OwnerColor = owner
			return nil
		}); err != nil {
			return grid, game.Neutral, err
		}
	}
	return grid, turn, nil
}

// measureRows reads a board's shape off one field. Every rank must cover the
// same number of files; a field whose ranks disagree is not a board.
func measureRows(field string) (width, height int, err error) {
	rows := strings.Split(field, "/")
	for y, row := range rows {
		covered, err := rowWidth(row)
		if err != nil {
			return 0, 0, fmt.Errorf("%w: rank %d: %v", ErrInvalidPosition, y+1, err)
		}
		if y == 0 {
			width = covered
			continue
		}
		if covered != width {
			return 0, 0, fmt.Errorf(
				"%w: rank %d covers %d tiles, rank 1 covers %d",
				ErrInvalidPosition, y+1, covered, width,
			)
		}
	}
	return width, len(rows), nil
}

func rowWidth(row string) (int, error) {
	covered := 0
	for index := 0; index < len(row); {
		symbol := row[index]
		switch {
		case symbol >= '1' && symbol <= '9':
			gap, next, err := readGap(row, index)
			if err != nil {
				return 0, err
			}
			covered += gap
			index = next
		case symbol == '0':
			return 0, fmt.Errorf("a gap cannot start with %q", "0")
		case symbol == '.':
			covered++
			index++
		default:
			covered++
			index++
		}
	}
	return covered, nil
}

// readGap reads one run of empty tiles. Multi-digit on purpose — a board can be
// wider than nine — and unambiguous because the encoder never writes two runs
// side by side: "19" is nineteen empties, and one empty followed by nine of them
// can only appear with a piece between, as "1R9".
func readGap(row string, index int) (gap, next int, err error) {
	end := index
	for end < len(row) && row[end] >= '0' && row[end] <= '9' {
		end++
	}
	gap, err = strconv.Atoi(row[index:end])
	if err != nil {
		return 0, 0, err
	}
	return gap, end, nil
}

func decodeRows(field string, width, height int, place func(x, y int, symbol byte) error) error {
	rows := strings.Split(field, "/")
	if len(rows) != height {
		return fmt.Errorf(
			"%w: expected %d rows, got %d",
			ErrInvalidPosition, height, len(rows),
		)
	}
	for y, row := range rows {
		x := 0
		for index := 0; index < len(row); {
			symbol := row[index]
			switch {
			case symbol >= '1' && symbol <= '9':
				gap, next, err := readGap(row, index)
				if err != nil {
					return fmt.Errorf("%w: rank %d: %v", ErrInvalidPosition, y+1, err)
				}
				x += gap
				index = next
			case symbol == '.':
				x++
				index++
			default:
				if x >= width {
					return fmt.Errorf("%w: rank %d overflows the board", ErrInvalidPosition, y+1)
				}
				if err := place(x, y, symbol); err != nil {
					return err
				}
				x++
				index++
			}
		}
		if x != width {
			return fmt.Errorf(
				"%w: rank %d covers %d tiles, expected %d",
				ErrInvalidPosition, y+1, x, width,
			)
		}
	}
	return nil
}

func startingPieceSymbol(symbol byte) (game.Piece, game.PlayerColor, bool) {
	switch symbol {
	case 'R':
		return game.Rock, game.Blue, true
	case 'P':
		return game.Paper, game.Blue, true
	case 'S':
		return game.Scissors, game.Blue, true
	case 'r':
		return game.Rock, game.Red, true
	case 'p':
		return game.Paper, game.Red, true
	case 's':
		return game.Scissors, game.Red, true
	default:
		return game.Empty, game.Neutral, false
	}
}

// StartingPositionFrom converts an encoded position into the row form a mode
// definition uses, so a record can be replayed on the exact board it was
// played from.
func StartingPositionFrom(text string) (game.StartingPosition, error) {
	grid, _, err := DecodePosition(text)
	if err != nil {
		return game.StartingPosition{}, err
	}
	return game.NewStartingPosition(game.StartingPositionFrom(grid).Rows()...)
}

// EncodeStartingPosition writes a mode's opening board in the same form.
func EncodeStartingPosition(position game.StartingPosition) string {
	grid := game.NewGrid(position.Width(), position.Height())
	for y, row := range position.Rows() {
		for x := 0; x < len(row); x++ {
			piece, owner, valid := startingPieceSymbol(row[x])
			if !valid || piece == game.Empty {
				continue
			}
			grid[y][x].Occupant = piece
			grid[y][x].OccupantOwner = owner
			grid[y][x].OwnerColor = owner
		}
	}
	return EncodePosition(grid, game.FirstToMove)
}
