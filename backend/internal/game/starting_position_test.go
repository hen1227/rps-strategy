package game

import (
	"errors"
	"testing"
)

func TestNewStartingPositionRejectsMalformedLayouts(t *testing.T) {
	tests := map[string][]string{
		"wrong row count": {
			".........",
		},
		"wrong column count": {
			"........",
			".........",
			".........",
			".........",
			".........",
			".........",
			".........",
			".........",
			".........",
		},
		"unknown piece symbol": {
			"X........",
			".........",
			".........",
			".........",
			".........",
			".........",
			".........",
			".........",
			".........",
		},
	}

	for name, rows := range tests {
		t.Run(name, func(t *testing.T) {
			if _, err := NewStartingPosition(rows...); !errors.Is(err, ErrInvalidStartingPosition) {
				t.Fatalf("expected ErrInvalidStartingPosition, got %v", err)
			}
		})
	}
}

func TestStartingPositionAppliesPieceAndOwnership(t *testing.T) {
	position := MustStartingPosition(
		"RPS......",
		".........",
		".........",
		".........",
		".........",
		".........",
		".........",
		".........",
		"......rps",
	)
	state := GameState{}
	standardRPSRules{}.initializeBoard(&state, position)

	blueRock := state.Grid[0][0]
	if blueRock.Occupant != Rock || blueRock.OccupantOwner != Blue || blueRock.OwnerColor != Blue {
		t.Fatalf("unexpected Blue rock tile: %#v", blueRock)
	}
	redScissors := state.Grid[8][8]
	if redScissors.Occupant != Scissors || redScissors.OccupantOwner != Red || redScissors.OwnerColor != Red {
		t.Fatalf("unexpected Red scissors tile: %#v", redScissors)
	}
	empty := state.Grid[4][4]
	if empty.Occupant != Empty || empty.OccupantOwner != Neutral || empty.OwnerColor != Neutral {
		t.Fatalf("unexpected empty tile: %#v", empty)
	}
}

// Every built-in layout has to be fair, but the two goal shapes are fair in
// different ways: a mode raced across the ranks is balanced by mirroring files,
// and one raced along the diagonal by the half turn. Intransitive is not file
// symmetric on purpose -- that is what makes its two corners different places
// -- so the opening book must not fold its lines onto their mirrors.
func TestBuiltInStartingPositionsAreBalanced(t *testing.T) {
	tests := []struct {
		name     string
		position StartingPosition
		mirrors  bool
	}{
		{"total war", totalWarStartingPosition, true},
		{"infiltration", infiltrationStartingPosition, true},
		{"intransitive", intransitiveStartingPosition, false},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if turned := test.position.HalfTurn(); turned != test.position {
				t.Fatalf(
					"layout is not balanced under a half turn:\n got %s\nwant %s",
					turned.Layout,
					test.position.Layout,
				)
			}
			if test.position.MirrorsFiles() != test.mirrors {
				t.Fatalf("MirrorsFiles = %v, want %v", test.position.MirrorsFiles(), test.mirrors)
			}
		})
	}
}
