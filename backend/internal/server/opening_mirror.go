package server

// Mirror-image openings.
//
// Reversing files -- a<->i, b<->h, c<->g, d<->f, e alone -- maps every legal
// move onto a legal move and every position onto an equivalent one, for any
// mode whose starting layout reads the same right to left. So `d8-c7` and
// `f8-g7` are one opening drawn twice, and `d8-c7 f2-g3` and `f8-g7 d2-c3` are
// one line drawn twice.
//
// The engine knows this and folds the two together while searching, but the
// graph it publishes is written in real coordinates: both halves of the book
// are there, because both are boards a visitor can reach. Names are keyed by
// line, so without this every opening in the book would have to be named twice
// -- and the two names would drift, because nothing would hold them together.
//
// The answer is a canonical line: of a line and its mirror, the
// lexicographically smaller one is the key both are stored under. Which of the
// two it is does not matter; that it is the same for both is the whole point.

import (
	"context"
	"log"
	"strings"

	"rps-strategy/backend/internal/game"
)

// openingBoard is everything the mirror rule needs to know about a mode: how
// wide its board is, and whether reflecting it produces the same layout at all.
//
// The width has to travel with the question. `a<->i` is only the right mirror on
// a board nine files wide, and a mode may now be any rectangle — mirroring an
// eleven-wide board across file i would map real squares onto squares that are
// not there.
type openingBoard struct {
	width   int
	mirrors bool
}

// mirrorOpeningSquare reflects a square across the board's middle file.
func mirrorOpeningSquare(square string, width int) string {
	if len(square) != 2 || square[0] < 'a' || square[0] >= byte('a')+byte(width) {
		return square
	}
	return string(rune('a'+width-1-int(square[0]-'a'))) + square[1:]
}

// mirrorOpeningMove reflects both squares of a move: `d8-c7` becomes `f8-g7`.
// Notation this does not recognise is handed back untouched, so a caller that
// skipped validation cannot turn a bad move into a plausible-looking one.
func mirrorOpeningMove(move string, width int) string {
	if !validOpeningMove(move) {
		return move
	}
	return mirrorOpeningSquare(move[:2], width) + "-" + mirrorOpeningSquare(move[3:], width)
}

func mirrorOpeningLine(line []string, width int) []string {
	mirrored := make([]string, len(line))
	for index, move := range line {
		mirrored[index] = mirrorOpeningMove(move, width)
	}
	return mirrored
}

// canonicalOpeningLine is the key a line's name is stored under.
//
// The whole line is mirrored or not at all. Mirroring move by move -- picking
// whichever of `d8-c7` and `f8-g7` sorts first at every ply -- would produce a
// key that is not a line anybody can play, and two real lines could collide on
// it.
func canonicalOpeningLine(line []string, board openingBoard) []string {
	if !board.mirrors || len(line) == 0 {
		return line
	}
	mirrored := mirrorOpeningLine(line, board.width)
	if strings.Join(mirrored, " ") < strings.Join(line, " ") {
		return mirrored
	}
	return line
}

// openingBoardFor reads the mirror rule off a mode.
//
// Two things can switch it off. A mode could be defined with a lopsided opening
// layout, and then `d8-c7` and `f8-g7` really would be two different openings.
// And a mode wider than the book's own notation — five characters, files a to i,
// ranks 1 to 9, see validOpeningMove — has no lines to mirror in the first
// place, because none of its moves can be written down. Asking the mode rather
// than assuming is what keeps both of those modes nameable.
func (server *Server) openingBoardFor(modeID game.ModeID) openingBoard {
	mode, err := server.registry.New(modeID)
	if err != nil {
		return openingBoard{}
	}
	position := mode.Definition().StartingPosition
	width := position.Width()
	if width > game.BoardSize || position.Height() > game.BoardSize {
		return openingBoard{width: width}
	}
	return openingBoard{width: width, mirrors: position.MirrorsFiles()}
}

// canonicalLineFor canonicalizes a line for one mode.
func (server *Server) canonicalLineFor(modeID game.ModeID, line []string) []string {
	return canonicalOpeningLine(line, server.openingBoardFor(modeID))
}

// canonicalizeOpeningNames brings stored names into line with the mirror rule.
//
// Every name written before this rule existed was keyed by the exact line
// somebody typed, so half of them are under a key nothing will ever look up
// again -- the screen asks for the canonical line now. Running once at startup
// is enough: from here on both doors into the table canonicalize on the way in.
//
// A failure is logged and survived. The book is still browsable with names
// half-migrated; refusing to start the whole server over a naming key would be
// a much worse answer.
func (server *Server) canonicalizeOpeningNames() {
	for _, modeID := range server.registry.CatalogueIDs() {
		board := server.openingBoardFor(modeID)
		if !board.mirrors {
			continue
		}
		moved, err := server.data.RekeyOpeningLines(
			context.Background(),
			string(modeID),
			func(line []string) []string { return canonicalOpeningLine(line, board) },
		)
		if err != nil {
			log.Printf("canonicalize %s opening names: %v", modeID, err)
			continue
		}
		if moved > 0 {
			log.Printf("canonicalized %d %s opening lines onto their mirrors", moved, modeID)
		}
	}
}
