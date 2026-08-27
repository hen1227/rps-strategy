package game

import (
	"errors"
	"testing"
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
	if len(definitions) != 2 {
		t.Fatalf("expected only two base modes, got %d", len(definitions))
	}
	expected := []ModeID{ModeTotalWar, ModeInfiltration}
	for index, modeID := range expected {
		if definitions[index].ID != modeID {
			t.Fatalf("mode %d: expected %s, got %s", index, modeID, definitions[index].ID)
		}
	}
}
