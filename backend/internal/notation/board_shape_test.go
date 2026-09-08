package notation

import (
	"strings"
	"testing"

	"rps-strategy/backend/internal/game"
)

// A FEN is self-describing: an eleven by five board reads back as one, with
// nothing beside it saying so.
func TestPositionRoundTripsOnANonSquareBoard(t *testing.T) {
	position := game.MustStartingPosition(
		"RPS.....SPR",
		"...........",
		"...........",
		"...........",
		"rps.....spr",
	)
	encoded := EncodeStartingPosition(position)
	decoded, turn, err := DecodePosition(encoded)
	if err != nil {
		t.Fatalf("%q did not decode: %v", encoded, err)
	}
	if decoded.Width() != 11 || decoded.Height() != 5 {
		t.Fatalf("%q decoded as %d by %d", encoded, decoded.Width(), decoded.Height())
	}
	if turn != game.FirstToMove {
		t.Fatalf("side to move was %s", turn)
	}
	if got := game.StartingPositionFrom(decoded); got != position {
		t.Fatalf("round trip gave %q, expected %q", got.Layout, position.Layout)
	}
	// A gap wider than nine has to survive, which is what multi-digit runs are for.
	if _, _, err := DecodePosition("11/11/11/11/11 r"); err != nil {
		t.Fatalf("an empty eleven-wide board did not decode: %v", err)
	}
	if _, _, err := DecodePosition("11/11/11/11/10 r"); err == nil {
		t.Fatal("ranks that disagree in width are not a board")
	}
}

// A position may leave the territory field out, which is what lets somebody
// writing a board by hand — for a mode where ownership decides nothing — write
// two fields and be understood.
//
// Ownership then follows the pieces, which is how every mode's opening board
// looks, so the short form and the long form of an opening are the same board.
func TestPositionMayLeaveOutTerritory(t *testing.T) {
	const short = "3SSS3/3PPP3/3RRR3/9/9/9/3rrr3/3ppp3/3sss3 b"
	const long = short + " 3bbb3/3bbb3/3bbb3/9/9/9/3rrr3/3rrr3/3rrr3"

	brief, briefTurn, err := DecodePosition(short)
	if err != nil {
		t.Fatalf("%q did not decode: %v", short, err)
	}
	full, fullTurn, err := DecodePosition(long)
	if err != nil {
		t.Fatalf("%q did not decode: %v", long, err)
	}
	if !brief.Equal(full) {
		t.Fatal("a position without territory is not the same board as one with it")
	}
	if briefTurn != game.Blue || fullTurn != game.Blue {
		t.Fatalf("side to move read as %s and %s", briefTurn, fullTurn)
	}

	// The pieces alone are a board too: no side to move, and ownership still
	// following the pieces.
	pieces, turn, err := DecodePosition("3SSS3/9/9/9/9/9/9/9/3sss3")
	if err != nil {
		t.Fatalf("a bare piece field did not decode: %v", err)
	}
	if turn != game.Neutral {
		t.Fatalf("side to move read as %s with no field for it", turn)
	}
	if pieces[0][3].OwnerColor != game.Blue {
		t.Fatal("ownership did not follow the pieces")
	}

	// What the server writes is unchanged: three fields, so a stored record
	// describes its territory rather than implying it.
	if fields := len(strings.Fields(EncodePosition(full, game.Blue))); fields != 3 {
		t.Fatalf("EncodePosition wrote %d fields", fields)
	}
}
