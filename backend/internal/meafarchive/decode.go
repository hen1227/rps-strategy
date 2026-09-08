package meafarchive

// Reading meaf.us's compact export.
//
// One game per line, space separated, in one of two shapes:
//
//	<result> <moves>
//	<result> <blue> <red> <moves>
//
// `result` is one of b, r, d, u -- Blue won, Red won, drawn, unfinished.
// `blue` and `red` are usernames, or "-" for a player who had none. `moves` is
// the whole game packed ten bits to a move and base64url encoded.
//
// Ten bits is a square and a direction: the top seven are the origin as
// rank*9+file, the bottom three index the eight neighbours. That is what makes
// the export small, and it is also why it cannot express an illegal move shape
// -- a packed move always lands on an adjacent square, so a corrupt file shows
// up as a move nobody could play rather than as a plausible wrong game. The
// decoder checks the bounds anyway.
//
// The port of meaf.us's own decode-games.py, and deliberately a close one: the
// two are checked against each other by hand when the export changes, and a
// clever rewrite would make that comparison harder rather than easier.

import (
	"encoding/base64"
	"fmt"
	"strings"
	"sync"
)

// Result is how a meaf.us game ended.
type Result string

const (
	BlueWin    Result = "blue_win"
	RedWin     Result = "red_win"
	Draw       Result = "draw"
	Unfinished Result = "unfinished"
)

// Game is one decoded game.
type Game struct {
	Result Result
	// BlueUsername and RedUsername are empty when the export did not carry
	// them, which is both the two-field line shape and a "-" in the four-field
	// one. Nothing here needs them; they are decoded because throwing away a
	// field the source took the trouble to send makes the next question about
	// this data harder to answer.
	BlueUsername string
	RedUsername  string
	// Moves are "d2-c3" style, lower case, in the order they were played.
	// Blue moves first, as it does here.
	Moves []string
}

// directions is the neighbour order the packing uses: the three-bit index into
// this table is the low end of every packed move.
var directions = [8][2]int{
	{-1, -1}, {-1, 0}, {-1, 1},
	{0, -1}, {0, 1},
	{1, -1}, {1, 0}, {1, 1},
}

const (
	// boardSize is the export's board, which is fixed at nine by nine. Not
	// game.BoardSize: this is a fact about somebody else's file format, and if
	// the two ever disagree that is a thing to notice rather than to follow.
	boardSize = 9
	// bitsPerMove is the packing width.
	bitsPerMove = 10
)

// Decode reads the whole export.
//
// A malformed line fails the whole call rather than being skipped. The export
// is a fixed asset compiled into the binary, so a line that will not decode
// means the file is wrong, and quietly dropping games would show up as a
// slightly-too-small number that nobody could account for.
func Decode(export string) ([]Game, error) {
	games := make([]Game, 0, 5000)
	for number, line := range strings.Split(export, "\n") {
		line = strings.TrimRight(line, "\r")
		if strings.TrimSpace(line) == "" {
			continue
		}
		game, err := decodeLine(line)
		if err != nil {
			return nil, fmt.Errorf("meaf.us export line %d: %w", number+1, err)
		}
		games = append(games, game)
	}
	return games, nil
}

func decodeLine(line string) (Game, error) {
	parts := strings.Split(line, " ")
	if len(parts) != 2 && len(parts) != 4 {
		return Game{}, fmt.Errorf("expected 2 or 4 fields, got %d", len(parts))
	}
	var game Game
	switch parts[0] {
	case "b":
		game.Result = BlueWin
	case "r":
		game.Result = RedWin
	case "d":
		game.Result = Draw
	case "u":
		game.Result = Unfinished
	default:
		return Game{}, fmt.Errorf("unknown result %q", parts[0])
	}
	if len(parts) == 4 {
		if parts[1] != "-" {
			game.BlueUsername = parts[1]
		}
		if parts[2] != "-" {
			game.RedUsername = parts[2]
		}
	}
	moves, err := DecodeMoves(parts[len(parts)-1])
	if err != nil {
		return Game{}, err
	}
	game.Moves = moves
	return game, nil
}

// DecodeMoves unpacks one game's move list.
func DecodeMoves(encoded string) ([]string, error) {
	data, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(encoded, "="))
	if err != nil {
		return nil, fmt.Errorf("decode packed moves: %w", err)
	}
	// Trailing bits that do not make up a whole move are padding from the
	// encoder rounding up to a byte, not a move.
	count := len(data) * 8 / bitsPerMove
	moves := make([]string, 0, count)
	for index := range count {
		value := packedMoveAt(data, index)
		origin, direction := value>>3, value&7
		rank, file := origin/boardSize, origin%boardSize
		toFile := file + directions[direction][0]
		toRank := rank + directions[direction][1]
		if origin >= boardSize*boardSize ||
			toFile < 0 || toFile >= boardSize ||
			toRank < 0 || toRank >= boardSize {
			return nil, fmt.Errorf("packed move %d runs off the board", index)
		}
		moves = append(moves, fmt.Sprintf(
			"%c%d-%c%d",
			'a'+file, rank+1,
			'a'+toFile, toRank+1,
		))
	}
	return moves, nil
}

// packedMoveAt reads the index'th ten-bit field, counting from the high end of
// the first byte -- which is the order the encoder wrote them in.
func packedMoveAt(data []byte, index int) int {
	value := 0
	for bit := range bitsPerMove {
		offset := index*bitsPerMove + bit
		byteAt, bitAt := offset/8, 7-offset%8
		value <<= 1
		if data[byteAt]&(1<<bitAt) != 0 {
			value |= 1
		}
	}
	return value
}

// Games is the decoded export, decoded once.
//
// Cached because the compiler asks for it once per mode per compile and the
// answer cannot change: the export is embedded, so decoding it twice is
// decoding the same bytes twice. It panics on a bad file rather than returning
// an error, which is the right shape for an asset compiled into the binary --
// a broken export is a broken build, and TestMeafExportIsReadable is where it
// gets caught long before this runs.
var Games = sync.OnceValue(func() []Game {
	games, err := Decode(Export)
	if err != nil {
		panic("the embedded meaf.us export does not decode: " + err.Error())
	}
	return games
})
