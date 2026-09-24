package rpsi

import (
	"strings"
	"testing"

	"rps-strategy/backend/internal/game"
)

func TestPositionCommandCarriesTheBoardPlayedFromAndEveryMove(t *testing.T) {
	instance, err := game.NewGameWithRegistry(
		game.DefaultModeRegistry, "g1", game.ModeTotalWar,
		game.PlayerProfile{UserID: "red"}, game.PlayerProfile{UserID: "blue"},
	)
	if err != nil {
		t.Fatalf("new game: %v", err)
	}
	command := PositionCommand(instance.Record())
	if !strings.HasPrefix(command, "position fen ") {
		t.Fatalf("expected a fen command, got %q", command)
	}
	// There is no `startpos`: a mode's opening board can be redesigned, so an
	// engine must never be left to assume one.
	if strings.Contains(command, "startpos") {
		t.Fatalf("the protocol has no startpos: %q", command)
	}
	if strings.Contains(command, " moves") {
		t.Fatalf("a fresh game has no moves: %q", command)
	}
	// Three space-separated FEN fields, the third being territory, which is
	// what decides Total War and cannot be derived from the pieces.
	fields := strings.Fields(strings.TrimPrefix(command, "position fen "))
	if len(fields) != 3 {
		t.Fatalf("expected pieces, side, and territory, got %q", command)
	}

	moves := instance.LegalMoves()
	if _, err := instance.Move(game.FirstToMove, moves[0].From, moves[0].To); err != nil {
		t.Fatalf("play a move: %v", err)
	}
	command = PositionCommand(instance.Record())
	if !strings.Contains(command, " moves ") {
		t.Fatalf("the move list is the only repetition history an engine gets: %q", command)
	}
}

func TestLegalMovesCommandRoundTripsThroughTheMoveParser(t *testing.T) {
	instance, err := game.NewGameWithRegistry(
		game.DefaultModeRegistry, "g1", game.ModeInfiltration,
		game.PlayerProfile{UserID: "red"}, game.PlayerProfile{UserID: "blue"},
	)
	if err != nil {
		t.Fatalf("new game: %v", err)
	}
	moves := instance.LegalMoves()
	command := LegalMovesCommand(moves)
	tokens := strings.Fields(command)
	if tokens[0] != "legalmoves" || len(tokens)-1 != len(moves) {
		t.Fatalf("expected %d moves, got %q", len(moves), command)
	}
	// A ten-line bot echoes one of these back verbatim, so every entry it
	// contains has to be something the server will accept.
	for index, token := range tokens[1:] {
		from, to, err := ParseMove(token)
		if err != nil {
			t.Fatalf("own output did not parse: %v", err)
		}
		if from != moves[index].From || to != moves[index].To {
			t.Fatalf("round trip changed move %d: %q", index, token)
		}
	}
	if LegalMovesCommand(nil) != "legalmoves" {
		t.Error("a position with no moves still needs a well-formed line")
	}
}

func TestParseBestMoveToleratesExtraTokens(t *testing.T) {
	from, to, err := ParseBestMove("bestmove d7-d6")
	if err != nil {
		t.Fatalf("plain: %v", err)
	}
	if from.X != 3 || from.Y != 6 || to.X != 3 || to.Y != 5 {
		t.Fatalf("wrong squares: %v -> %v", from, to)
	}
	// RPSFish's own search output appends a coordinate form after the move, so
	// a strict equality check would reject a conforming engine.
	if _, _, err := ParseBestMove("bestmove d7-d6 ((3, 6) -> (3, 5))"); err != nil {
		t.Fatalf("trailing tokens must be tolerated: %v", err)
	}
	// The capture marker is a fact about the position, not the move.
	if _, _, err := ParseBestMove("bestmove d7xd6"); err != nil {
		t.Fatalf("capture spelling: %v", err)
	}
	// The PGN spelling, so a move copied out of a stored game works.
	if _, _, err := ParseMove("Rd7xd6"); err != nil {
		t.Fatalf("piece letter: %v", err)
	}
	for _, bad := range []string{"", "bestmove", "d7-d6", "bestmove zz-zz", "bestmove d7d6"} {
		if _, _, err := ParseBestMove(bad); err == nil {
			t.Errorf("%q should not parse", bad)
		}
	}
}

func TestParseHandshakeReadsIdentityAndIgnoresTheUnknown(t *testing.T) {
	handshake := ParseHandshake([]string{
		"id name RPSFish 0.1.0",
		"id author Henry Abrahamsen",
		"protocol 1",
		"rules 2",
		"option name Hash type spin default 16 min 1 max 4096",
		"mode V3 Infiltration",
		"mode V5 Total War",
		// A mode this server has never shipped, and a line from a protocol
		// version that does not exist yet. Neither may break the handshake.
		"mode V9 Something New",
		"telemetry off",
		"rpsiok",
	})
	if handshake.Name != "RPSFish 0.1.0" || handshake.Author != "Henry Abrahamsen" {
		t.Fatalf("identity: %#v", handshake)
	}
	if handshake.Protocol != 1 || handshake.Rules != 2 {
		t.Fatalf("versions: %#v", handshake)
	}
	if !handshake.Supports(game.ModeTotalWar) || !handshake.Supports(game.ModeInfiltration) {
		t.Fatalf("declared modes: %#v", handshake.Modes)
	}
	if handshake.Supports(game.ModeID("V7")) {
		t.Error("a mode the engine did not declare must not be assumed")
	}

	// An engine that declared nothing is taken at its word rather than refused:
	// the line is advisory and a working engine should not be locked out over it.
	if !ParseHandshake([]string{"id name Minimal", "rpsiok"}).Supports(game.ModeTotalWar) {
		t.Error("an engine declaring no modes should be allowed to play")
	}

	// The fixture above declares no build, which is every engine written before
	// the field existed. It has to parse exactly as it always did.
	if handshake.Version != "" {
		t.Errorf("an engine that sends no build has none: %q", handshake.Version)
	}
}

// `id version` is a new sub-key of a line that already existed, which is safe
// only because the parser ignores what it does not know. This pins both halves:
// the new key is read, and an engine sending it to an older server was never
// refused for it.
func TestParseHandshakeReadsTheEngineBuild(t *testing.T) {
	handshake := ParseHandshake([]string{
		"id name RPSFish",
		"id author Henry Abrahamsen",
		"id version 0.4.1-rc2",
		"rpsiok",
	})
	if handshake.Version != "0.4.1-rc2" {
		t.Fatalf("declared build: %#v", handshake)
	}
	// The build is separate from the name, so an engine that sends both keeps a
	// name with no version buried in it.
	if handshake.Name != "RPSFish" {
		t.Fatalf("the name is not the version: %#v", handshake)
	}

	// Free text, like the name beside it: a build stamp can be a tag, a commit
	// or a date, and this is not the place to have an opinion about which.
	spaced := ParseHandshake([]string{"id version 2026-09-14 build 77", "rpsiok"})
	if spaced.Version != "2026-09-14 build 77" {
		t.Fatalf("a build stamp is free text: %q", spaced.Version)
	}
}
