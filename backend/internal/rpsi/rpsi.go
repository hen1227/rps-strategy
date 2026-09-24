// Package rpsi formats the engine protocol described in docs/rpsi.md.
//
// The server does this work rather than the bot client, because the server
// already owns the board, both clocks, and the move history. Moving the
// translation here is what lets the client be a pipe: it writes the lines it
// is handed to the engine's stdin and sends back what the engine printed,
// without ever parsing a position. It also means a protocol fix ships from the
// server instead of requiring every bot author to download a new script.
package rpsi

import (
	"fmt"
	"strconv"
	"strings"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/notation"
)

// ProtocolVersion is the major version this server speaks.
const ProtocolVersion = 1

// PositionCommand writes `position fen <pieces> <side> <territory> moves ...`
// for a game as it currently stands.
//
// The FEN is the board the game was actually played from, taken from the
// record rather than from the mode's present-day opening, because a mode's
// starting layout can be redesigned and games can begin from a position a
// player chose. The full move list follows because it is the only way an
// engine can see a threefold repetition coming — the FEN carries no history.
func PositionCommand(record game.Record) string {
	startingFEN := notation.EncodeStartingPosition(record.StartingPosition())
	if record.InitialPosition != nil {
		startingFEN = notation.EncodePosition(
			record.InitialPosition.Grid,
			record.InitialPosition.CurrentTurn,
		)
	}

	var builder strings.Builder
	builder.WriteString("position fen ")
	builder.WriteString(startingFEN)
	moves := record.Moves()
	if len(moves) > 0 {
		builder.WriteString(" moves")
		for _, event := range moves {
			builder.WriteByte(' ')
			builder.WriteString(FormatMove(event.From, event.To, event.Captured))
		}
	}
	return builder.String()
}

// FormatMove writes one move the way the protocol reads it.
//
// The `x` marks a capture, matching the archive's spelling so a line copied
// between the two means the same thing. Readers are told not to depend on it:
// whether a move captures is a fact about the position, not about the move.
func FormatMove(from game.Position, to game.Position, captured game.Piece) string {
	separator := "-"
	if captured != game.Empty && captured != "" {
		separator = "x"
	}
	return notation.FormatSquare(from) + separator + notation.FormatSquare(to)
}

// LegalMovesCommand lists every move the side to move may play.
//
// Sent before every `go`, unconditionally. It costs a kilobyte and it is the
// difference between a ten-line bot and one that must first implement move
// generation for three different modes — there is no library for this game, so
// without it the floor for writing a bot is high enough to stop most people.
func LegalMovesCommand(moves []game.Move) string {
	if len(moves) == 0 {
		return "legalmoves"
	}
	var builder strings.Builder
	builder.WriteString("legalmoves")
	for _, move := range moves {
		builder.WriteByte(' ')
		// A legal-move list describes moves, not outcomes, so it always uses
		// the quiet spelling; an engine may echo any entry back verbatim.
		builder.WriteString(notation.FormatSquare(move.From) + "-" + notation.FormatSquare(move.To))
	}
	return builder.String()
}

// GoCommand writes the search request for the side to move.
//
// Both clocks are reported rather than only the mover's, because an engine
// that knows its opponent is short of time may legitimately play differently.
func GoCommand(clock game.ClockState, control game.TimeControl) string {
	return fmt.Sprintf(
		"go rtime %d btime %d rinc %d binc %d",
		max(clock.RedRemainingMs, 0),
		max(clock.BlueRemainingMs, 0),
		control.IncrementMs,
		control.IncrementMs,
	)
}

// NewGameCommand starts an unrelated game in a mode.
func NewGameCommand(modeID game.ModeID) string {
	return "newgame " + string(modeID)
}

// ParseBestMove reads the move out of a `bestmove d7-d6` line.
//
// Tokenised rather than compared, because an engine may append information
// after the move — RPSFish's own `search` output does exactly that — and a
// strict equality check would reject a conforming engine.
func ParseBestMove(line string) (game.Position, game.Position, error) {
	fields := strings.Fields(line)
	if len(fields) < 2 || fields[0] != "bestmove" {
		return game.Position{}, game.Position{}, fmt.Errorf("not a bestmove line: %q", line)
	}
	return ParseMove(fields[1])
}

// ParseMove reads `d7-d6`, `d7xd6`, or the PGN spelling `Rd7xd6`.
//
// The piece letter is accepted and discarded so that a move copied out of a
// stored game works without being cleaned up first.
func ParseMove(text string) (game.Position, game.Position, error) {
	text = strings.TrimSpace(text)
	if len(text) == 6 {
		switch text[0] {
		case 'R', 'P', 'S':
			text = text[1:]
		}
	}
	if len(text) != 5 || (text[2] != '-' && text[2] != 'x') {
		return game.Position{}, game.Position{}, fmt.Errorf("%q is not a move like \"d7-d6\"", text)
	}
	from, err := notation.ParseSquare(text[0:2])
	if err != nil {
		return game.Position{}, game.Position{}, fmt.Errorf("%q: %w", text, err)
	}
	to, err := notation.ParseSquare(text[3:5])
	if err != nil {
		return game.Position{}, game.Position{}, fmt.Errorf("%q: %w", text, err)
	}
	return from, to, nil
}

// Handshake is what an engine reported in answer to `rpsi`.
type Handshake struct {
	Name   string
	Author string
	// Version is the build the engine says it is, from `id version`.
	//
	// A field of its own rather than a convention inside Name, which is how it
	// was done before this existed: the protocol told authors that `id name` was
	// free text and to include a version in it, so the name arrived as
	// "RPSFish 0.1.0" and nothing could tell the two halves apart. A site that
	// wants to say which build played a game, or when a build changed, cannot
	// get there by splitting a string somebody else chose the shape of.
	//
	// Empty for every engine that has not been changed to send it, which is all
	// of them today and is a fine answer: an engine that declares no build has
	// none recorded, and nothing about it behaves differently.
	Version  string
	Protocol int
	Rules    int
	Modes    []game.ModeID
}

// ParseHandshake reads the lines an engine printed before `rpsiok`.
//
// Unknown lines are ignored rather than refused. An engine is allowed to
// declare a mode this server has never heard of, and a future protocol version
// is allowed to add lines; treating either as fatal would break engines that
// are behaving correctly.
func ParseHandshake(lines []string) Handshake {
	var handshake Handshake
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		switch fields[0] {
		case "id":
			if len(fields) < 3 {
				continue
			}
			value := strings.Join(fields[2:], " ")
			switch fields[1] {
			case "name":
				handshake.Name = value
			case "author":
				handshake.Author = value
			case "version":
				handshake.Version = value
			}
		case "protocol":
			if len(fields) > 1 {
				handshake.Protocol, _ = strconv.Atoi(fields[1])
			}
		case "rules":
			if len(fields) > 1 {
				handshake.Rules, _ = strconv.Atoi(fields[1])
			}
		case "mode":
			if len(fields) > 1 {
				handshake.Modes = append(handshake.Modes, game.ModeID(fields[1]))
			}
		}
	}
	return handshake
}

// Supports reports whether the engine declared a mode.
//
// An engine that declared no modes at all is treated as supporting everything:
// the field is young, and refusing to seat an otherwise working engine over a
// missing advisory line would be the wrong trade.
func (handshake Handshake) Supports(modeID game.ModeID) bool {
	if len(handshake.Modes) == 0 {
		return true
	}
	for _, mode := range handshake.Modes {
		if mode == modeID {
			return true
		}
	}
	return false
}
