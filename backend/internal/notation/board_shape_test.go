package notation

import (
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
	if turn != game.Red {
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
