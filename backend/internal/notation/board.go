// Package notation reads and writes RPS Strategy games as PGN.
//
// The dialect follows chess PGN's shape — a tag pair section, then movetext
// ending in a result token — with three deliberate differences that come from
// the game rather than from taste:
//
//   - Squares are a1 to i9 on a 9x9 board. Files a to i run left to right
//     (x = 0 to 8) and ranks 1 to 9 run from Blue's home boundary (y = 0) to
//     Red's (y = 8), matching the engine's coordinates exactly.
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
	"strings"

	"rps-strategy/backend/internal/game"
)

var ErrInvalidPosition = errors.New("invalid position")

const fileLetters = "abcdefghi"

// FormatSquare renders a board coordinate as "a1" through "i9".
func FormatSquare(position game.Position) string {
	if position.X < 0 || position.X >= game.BoardSize ||
		position.Y < 0 || position.Y >= game.BoardSize {
		return "??"
	}
	return fmt.Sprintf("%c%d", fileLetters[position.X], position.Y+1)
}

// ParseSquare reads "a1" through "i9".
func ParseSquare(text string) (game.Position, error) {
	if len(text) != 2 {
		return game.Position{}, fmt.Errorf("%w: %q is not a square", ErrInvalidPosition, text)
	}
	x := strings.IndexByte(fileLetters, text[0])
	y := int(text[1] - '1')
	if x < 0 || y < 0 || y >= game.BoardSize {
		return game.Position{}, fmt.Errorf("%w: %q is not a square", ErrInvalidPosition, text)
	}
	return game.Position{X: x, Y: y}, nil
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
// Rows run from rank 1 to rank 9 separated by "/", digits count consecutive
// unoccupied (or unowned) tiles, and territory uses "r" and "b".
func EncodePosition(grid [game.BoardSize][game.BoardSize]game.Tile, turn game.PlayerColor) string {
	pieces := encodeRows(grid, func(tile game.Tile) (byte, bool) {
		return pieceSymbol(tile.Occupant, tile.OccupantOwner)
	})
	territory := encodeRows(grid, func(tile game.Tile) (byte, bool) {
		return territorySymbol(tile.OwnerColor)
	})
	return pieces + " " + colorCode(turn) + " " + territory
}

func encodeRows(
	grid [game.BoardSize][game.BoardSize]game.Tile,
	symbolFor func(game.Tile) (byte, bool),
) string {
	rows := make([]string, 0, game.BoardSize)
	for y := 0; y < game.BoardSize; y++ {
		row := strings.Builder{}
		gap := 0
		for x := 0; x < game.BoardSize; x++ {
			symbol, occupied := symbolFor(grid[y][x])
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
func DecodePosition(text string) ([game.BoardSize][game.BoardSize]game.Tile, game.PlayerColor, error) {
	var grid [game.BoardSize][game.BoardSize]game.Tile
	for y := 0; y < game.BoardSize; y++ {
		for x := 0; x < game.BoardSize; x++ {
			grid[y][x] = game.Tile{
				X: x, Y: y,
				Occupant:      game.Empty,
				OccupantOwner: game.Neutral,
				OwnerColor:    game.Neutral,
			}
		}
	}
	fields := strings.Fields(strings.TrimSpace(text))
	if len(fields) == 0 {
		return grid, game.Neutral, fmt.Errorf("%w: empty position", ErrInvalidPosition)
	}
	if err := decodeRows(fields[0], func(x, y int, symbol byte) error {
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
		for y := 0; y < game.BoardSize; y++ {
			for x := 0; x < game.BoardSize; x++ {
				grid[y][x].OwnerColor = game.Neutral
			}
		}
		if err := decodeRows(fields[2], func(x, y int, symbol byte) error {
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

func decodeRows(field string, place func(x, y int, symbol byte) error) error {
	rows := strings.Split(field, "/")
	if len(rows) != game.BoardSize {
		return fmt.Errorf(
			"%w: expected %d rows, got %d",
			ErrInvalidPosition, game.BoardSize, len(rows),
		)
	}
	for y, row := range rows {
		x := 0
		for index := 0; index < len(row); index++ {
			symbol := row[index]
			switch {
			case symbol >= '1' && symbol <= '9':
				x += int(symbol - '0')
			case symbol == '.':
				x++
			default:
				if x >= game.BoardSize {
					return fmt.Errorf("%w: rank %d overflows the board", ErrInvalidPosition, y+1)
				}
				if err := place(x, y, symbol); err != nil {
					return err
				}
				x++
			}
		}
		if x != game.BoardSize {
			return fmt.Errorf(
				"%w: rank %d covers %d tiles, expected %d",
				ErrInvalidPosition, y+1, x, game.BoardSize,
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
	rows := make([]string, 0, game.BoardSize)
	for y := 0; y < game.BoardSize; y++ {
		row := make([]byte, game.BoardSize)
		for x := 0; x < game.BoardSize; x++ {
			symbol, occupied := pieceSymbol(grid[y][x].Occupant, grid[y][x].OccupantOwner)
			if !occupied {
				symbol = '.'
			}
			row[x] = symbol
		}
		rows = append(rows, string(row))
	}
	return game.NewStartingPosition(rows...)
}

// EncodeStartingPosition writes a mode's opening board in the same form.
func EncodeStartingPosition(position game.StartingPosition) string {
	var state game.GameState
	grid := blankGrid()
	state.Grid = grid
	for y, row := range position.Rows {
		for x := 0; x < len(row) && x < game.BoardSize; x++ {
			piece, owner, valid := startingPieceSymbol(row[x])
			if !valid || piece == game.Empty {
				continue
			}
			state.Grid[y][x].Occupant = piece
			state.Grid[y][x].OccupantOwner = owner
			state.Grid[y][x].OwnerColor = owner
		}
	}
	return EncodePosition(state.Grid, game.Red)
}

func blankGrid() [game.BoardSize][game.BoardSize]game.Tile {
	var grid [game.BoardSize][game.BoardSize]game.Tile
	for y := 0; y < game.BoardSize; y++ {
		for x := 0; x < game.BoardSize; x++ {
			grid[y][x] = game.Tile{
				X: x, Y: y,
				Occupant:      game.Empty,
				OccupantOwner: game.Neutral,
				OwnerColor:    game.Neutral,
			}
		}
	}
	return grid
}
