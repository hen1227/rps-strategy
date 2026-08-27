package spec

// The two shipped modes, played twice: once through the hand-written Go rules,
// and once through this interpreter reading the same modes written as specs.
//
// The corpus test proves this reader agrees with the browser's. This one proves
// it agrees with the *game* — with `TotalWarMode` and `InfiltrationMode`, whose
// right answers were settled long before the rule language existed. A format
// that could not express the games this project already ships would be a format
// that quietly failed on somebody's first invention instead.

import (
	"math/rand"
	"testing"

	"rps-strategy/backend/internal/game"
)

func liveGame(t *testing.T, factory game.ModeFactory, id game.ModeID) *game.Game {
	t.Helper()
	registry := game.NewModeRegistry()
	registry.MustRegister(factory)
	live, err := game.NewGameWithRegistry(
		registry, "differential", id,
		game.PlayerProfile{UserID: "red"}, game.PlayerProfile{UserID: "blue"},
	)
	if err != nil {
		t.Fatal(err)
	}
	return live
}

func describeState(state game.GameState) string {
	return game.StartingPositionFrom(state.Grid).Layout + " | " +
		state.Grid.Key() + " | " +
		string(state.CurrentTurn) + " " + string(state.Status) + " " +
		string(state.Winner) + " " + string(state.EndReason)
}

func movesOf(live *game.Game) []string {
	found := make([]string, 0, 32)
	for _, move := range live.LegalMoves() {
		found = append(found, moveName(move.From, move.To))
	}
	sortStrings(found)
	return found
}

func joined(list []string) string {
	out := ""
	for index, entry := range list {
		if index > 0 {
			out += " "
		}
		out += entry
	}
	return out
}

func TestTheShippedModesPlayIdenticallyAsSpecs(t *testing.T) {
	for _, testCase := range []struct {
		id     game.ModeID
		parsed RuleSpec
		native game.ModeFactory
	}{
		{game.ModeTotalWar, TotalWar, func() game.GameMode { return &game.TotalWarMode{} }},
		{game.ModeInfiltration, Infiltration, func() game.GameMode { return &game.InfiltrationMode{} }},
	} {
		t.Run(string(testCase.id), func(t *testing.T) {
			mode, err := NewMode(testCase.id, testCase.parsed, game.OriginBuiltin)
			if err != nil {
				t.Fatal(err)
			}
			for seed := int64(1); seed <= 25; seed++ {
				random := rand.New(rand.NewSource(seed))
				native := liveGame(t, testCase.native, testCase.id)
				fromSpec := liveGame(t, mode.Factory(), testCase.id)

				for ply := 0; ply < 200; ply++ {
					nativeState := native.Snapshot()
					specState := fromSpec.Snapshot()
					if describeState(nativeState) != describeState(specState) {
						t.Fatalf("seed %d ply %d: positions differ\n  native: %s\n  spec:   %s",
							seed, ply, describeState(nativeState), describeState(specState))
					}
					if nativeState.Status != game.InProgress {
						break
					}
					nativeMoves := movesOf(native)
					specMoves := movesOf(fromSpec)
					if joined(nativeMoves) != joined(specMoves) {
						t.Fatalf("seed %d ply %d: legal moves differ\n  native: %s\n  spec:   %s",
							seed, ply, joined(nativeMoves), joined(specMoves))
					}
					if len(nativeMoves) == 0 {
						break
					}
					chosen := native.LegalMoves()[random.Intn(len(nativeMoves))]
					if _, err := native.Move(nativeState.CurrentTurn, chosen.From, chosen.To); err != nil {
						t.Fatalf("seed %d ply %d: native refused its own move: %v", seed, ply, err)
					}
					if _, err := fromSpec.Move(specState.CurrentTurn, chosen.From, chosen.To); err != nil {
						t.Fatalf("seed %d ply %d: the spec refused %s: %v",
							seed, ply, moveName(chosen.From, chosen.To), err)
					}
				}
			}
		})
	}
}

// A mode from a spec is an ordinary registered mode, which is the whole point of
// implementing game.GameMode rather than something new.
func TestASpecModeIsAnOrdinaryRegisteredMode(t *testing.T) {
	mode, err := NewMode("custom:jumpers@1", MustParse(TotalWarJSON), game.OriginCommunity)
	if err != nil {
		t.Fatal(err)
	}
	registry := game.NewModeRegistry()
	registry.MustRegister(mode.Factory())

	if !registry.Has("custom:jumpers@1") {
		t.Fatal("a registered spec mode is not in the registry")
	}
	if !registry.Playable("custom:jumpers@1") {
		t.Fatal("a published mode should accept new games")
	}
	definition := mode.Definition()
	if definition.Origin != game.OriginCommunity {
		t.Fatalf("origin is %q", definition.Origin)
	}
	if len(definition.Spec) == 0 {
		t.Fatal("the definition should carry the rules, so they travel with the game")
	}
	if !definition.HasFeature(game.FeatureTerritory) {
		t.Fatal("a mode that claims ground has the territory feature")
	}
}
