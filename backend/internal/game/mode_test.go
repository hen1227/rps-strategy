package game

import (
	"errors"
	"testing"
	"time"
)

const customModeID ModeID = "teleport-test"

var errTeleportDestination = errors.New("teleport destination must be the center")

var teleportTestStartingPosition = MustStartingPosition(
	"........R",
	".........",
	".........",
	".........",
	".........",
	".........",
	".........",
	".........",
	"r........",
)

// teleportTestMode intentionally shares none of the standard movement rules.
// It demonstrates that Game can host a new ruleset without engine changes.
type teleportTestMode struct{}

func (*teleportTestMode) Definition() ModeDefinition {
	return ModeDefinition{
		ID:               customModeID,
		ShortCode:        "TP",
		Name:             "Teleport Test",
		Description:      "Test-only extensibility mode.",
		Objective:        "Teleport to the center.",
		DisplayOrder:     99,
		Features:         []ModeFeature{},
		StartingPosition: teleportTestStartingPosition,
	}
}

func (*teleportTestMode) Initialize(state *GameState) {
	standardRPSRules{}.initializeBoard(state, teleportTestStartingPosition)
}

func (*teleportTestMode) ValidMoves(
	_ GameState,
	_ PlayerColor,
	_ Position,
) []Position {
	return []Position{{X: 4, Y: 4}}
}

func (*teleportTestMode) Move(
	state *GameState,
	player PlayerColor,
	_ Position,
	to Position,
) error {
	if to != (Position{X: 4, Y: 4}) {
		return errTeleportDestination
	}
	state.MoveNumber++
	state.Status = Finished
	state.Winner = player
	return nil
}

func TestGameDelegatesAllRulesToRegisteredMode(t *testing.T) {
	registry := NewModeRegistry()
	registry.MustRegister(func() GameMode { return &teleportTestMode{} })
	game, err := NewGameWithRegistry(
		registry,
		"custom-game",
		customModeID,
		PlayerProfile{UserID: "red"},
		PlayerProfile{UserID: "blue"},
	)
	if err != nil {
		t.Fatal(err)
	}

	moves := game.ValidMoves(Red, Position{X: 0, Y: 8})
	if len(moves) != 1 || moves[0] != (Position{X: 4, Y: 4}) {
		t.Fatalf("engine did not delegate legal moves: %#v", moves)
	}
	if _, err := game.Move(Red, Position{}, Position{X: 3, Y: 3}); !errors.Is(err, errTeleportDestination) {
		t.Fatalf("engine did not delegate validation: %v", err)
	}
	state, err := game.Move(Red, Position{}, Position{X: 4, Y: 4})
	if err != nil {
		t.Fatal(err)
	}
	if state.Status != Finished || state.Winner != Red {
		t.Fatalf("engine did not preserve custom win condition: %#v", state)
	}
}

func TestDefaultRegistryContainsOnlyBaseModes(t *testing.T) {
	definitions := DefaultModeRegistry.Definitions()
	expected := []ModeID{ModeIntransitive, ModeTotalWar, ModeInfiltration}
	if len(definitions) != len(expected) {
		t.Fatalf("expected only the %d base modes, got %d", len(expected), len(definitions))
	}
	for index, modeID := range expected {
		if definitions[index].ID != modeID {
			t.Fatalf("mode %d: expected %s, got %s", index, modeID, definitions[index].ID)
		}
	}
}

// A mode with no publication date tells every bot author nothing, silently:
// the client prints the line it was given, and a mode that skipped the field is
// simply absent from it. Cheaper to fail here than to find out from an engine
// that kept playing the old rules.
func TestEveryRegisteredModeDatesItsRules(t *testing.T) {
	for _, definition := range DefaultModeRegistry.Definitions() {
		published := definition.RulesPublished
		if len(published) != len("2006-01-02") {
			t.Errorf("%s: rulesPublished is %q, want a YYYY-MM-DD date",
				definition.ID, published)
			continue
		}
		if _, err := time.Parse("2006-01-02", published); err != nil {
			t.Errorf("%s: rulesPublished %q does not parse: %v",
				definition.ID, published, err)
		}
	}
}
