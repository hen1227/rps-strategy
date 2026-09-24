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

// Infiltration's goal ranks come off the board, not off BoardSize.
//
// The mode is nine by nine everywhere a live game can reach -- ValidateForMode
// refuses any other shape -- so comparing against the constant was right for
// every game this server plays. It was wrong for a *record*, which is replayed
// on the board its own FEN describes and may be any rectangle, and the review
// screen replays records people paste. Blue's goal has to be the last rank of
// this board, not the ninth rank of some other one.
//
// Eleven ranks, so the two answers differ: the constant would have ended the
// game two ranks early for Blue and not at all for a runner standing there.
func TestInfiltrationGoalRanksFollowTheBoardItIsPlayedOn(t *testing.T) {
	const height = 11

	for _, runner := range []struct {
		name   string
		player PlayerColor
		rows   []string
		from   Position
		// step is the direction this side advances: up the ranks for Blue,
		// down for Red.
		step int
	}{
		{
			// Blue opens on rank 1 and runs at rank 11 -- y = 10 here, where
			// the constant said y = 8.
			name:   "Blue runs at the last rank of this board",
			player: Blue,
			rows: []string{
				"....R....",
				".........", ".........", ".........", ".........",
				".........", ".........", ".........", ".........",
				".........",
				"r........",
			},
			from: Position{X: 4, Y: 0},
			step: 1,
		},
		{
			// Red's goal is rank 1 in every era and on every board, so this
			// half is the control: it passed before the change too.
			name:   "Red runs at rank 1",
			player: Red,
			rows: []string{
				"R........",
				".........", ".........", ".........", ".........",
				".........", ".........", ".........", ".........",
				".........",
				"....r....",
			},
			from: Position{X: 4, Y: height - 1},
			step: -1,
		},
	} {
		t.Run(runner.name, func(t *testing.T) {
			position := MustStartingPosition(runner.rows...)
			game, err := NewGameWithRegistryTimeControlAndStartingPosition(
				DefaultModeRegistry,
				"tall",
				ModeInfiltration,
				PlayerProfile{UserID: "red"},
				PlayerProfile{UserID: "blue"},
				DefaultTimeControl(),
				&position,
			)
			if err != nil {
				t.Fatal(err)
			}

			// The runner walks its own file; the other side shuffles a lone
			// piece in the far corner, which is only there to hand the turn
			// back. They never meet, so nothing here depends on a capture.
			state := game.Snapshot()
			at := runner.from
			for ply := 0; ply < height*3; ply++ {
				if state.Status != InProgress {
					break
				}
				if state.CurrentTurn != runner.player {
					from, to := anyLegalMoveFor(t, game, state.CurrentTurn)
					if state, err = game.Move(state.CurrentTurn, from, to); err != nil {
						t.Fatal(err)
					}
					continue
				}
				next := Position{X: at.X, Y: at.Y + runner.step}
				if !state.Grid.Contains(next) {
					t.Fatalf("the runner reached %v without the game ending", at)
				}
				if state, err = game.Move(runner.player, at, next); err != nil {
					t.Fatalf("move %v to %v: %v", at, next, err)
				}
				at = next
			}

			boundary := height - 1
			if runner.player == Red {
				boundary = 0
			}
			if at.Y != boundary {
				t.Fatalf(
					"the game ended with the runner on rank %d, want the boundary at rank %d",
					at.Y+1, boundary+1,
				)
			}
			if state.Status != Finished || state.Winner != runner.player {
				t.Fatalf(
					"reaching rank %d left the game %s with winner %q",
					boundary+1, state.Status, state.Winner,
				)
			}
			if state.EndReason != EndReasonInfiltration {
				t.Fatalf("end reason is %q, want %q", state.EndReason, EndReasonInfiltration)
			}
		})
	}
}

// anyLegalMoveFor finds a move for a side that is only being asked to hand the
// turn back.
func anyLegalMoveFor(t *testing.T, game *Game, player PlayerColor) (Position, Position) {
	t.Helper()
	state := game.Snapshot()
	for y, row := range state.Grid {
		for x, tile := range row {
			if tile.OccupantOwner != player {
				continue
			}
			from := Position{X: x, Y: y}
			if moves := game.ValidMoves(player, from); len(moves) > 0 {
				return from, moves[0]
			}
		}
	}
	t.Fatalf("%s has no legal move", player)
	return Position{}, Position{}
}
