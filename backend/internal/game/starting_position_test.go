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
