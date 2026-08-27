package game

// The line a game is playing, in the opening book's own notation.
//
// The book keys every position by the moves that reach it, written `d8-c7`:
// two squares and a dash, with no piece letter and no capture marker, because
// from a known starting position the squares already say both. That is not the
// archive's spelling — `Rd7xd6`, see internal/notation — and deliberately so:
// the archive describes a game, the book describes a position.
//
// A game carries the line rather than a client rebuilding it from the boards
// it has seen. Rebuilding is what a client would have to do, and it cannot: a
// player who refreshes mid-game and a spectator who arrives at move twenty
// never saw the moves that made the opening, and those are exactly the people
// the badge on the board is for.

import "strconv"

// OpeningLineLimit is how many plies a game reports. Openings are named a few
// moves deep; past this the answer is always "no opening by that name", and
// the line is only weight on every snapshot the server sends.
const OpeningLineLimit = 24

// FileLetters is one letter per file, which is why MaxBoardSide is 26. Files
// run left to right and ranks from Blue's home boundary to Red's, matching the
// engine's own coordinates.
const FileLetters = "abcdefghijklmnopqrstuvwxyz"

// SquareName renders a board coordinate as "a1" through "z26" — the spelling
// every record, book line and diagram in this project uses.
//
// Bounded by MaxBoardSide rather than by the board this coordinate came from:
// the callers are all writing text about a game in progress and have no board
// to hand, and a rank past nine is now an ordinary square rather than a
// mistake. A coordinate outside every possible board renders as "??" rather
// than panicking.
func SquareName(position Position) string {
	if position.X < 0 || position.X >= MaxBoardSide ||
		position.Y < 0 || position.Y >= MaxBoardSide {
		return "??"
	}
	return string(FileLetters[position.X]) + strconv.Itoa(position.Y+1)
}

// OpeningMoveName is one move as the book spells it.
func OpeningMoveName(from, to Position) string {
	return SquareName(from) + "-" + SquareName(to)
}

// recordOpeningMoveLocked extends the line this game is playing.
//
// The slice is rebuilt rather than appended to. Every snapshot handed out so
// far shares the array underneath it, and an append with room to spare would
// write into a line another goroutine is in the middle of sending.
func (game *Game) recordOpeningMoveLocked(from, to Position) {
	if !game.standardOpening || len(game.state.OpeningLine) >= OpeningLineLimit {
		return
	}
	line := make([]string, len(game.state.OpeningLine)+1)
	copy(line, game.state.OpeningLine)
	line[len(line)-1] = OpeningMoveName(from, to)
	game.state.OpeningLine = line
}
