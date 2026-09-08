package server

import (
	"os"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/notation"
	"rps-strategy/backend/internal/persistence"
)

// The archive before 2026-09-03 is read through the rank flip, not the half
// turn, and Intransitive is the mode that can tell the difference.
//
// The record here is a real ranked game off the production archive: V6, played
// 2026-09-02, generator 1, forty-seven plies ending on a corner. It is checked
// in because the distinction it pins cannot be reproduced from today's rules
// alone -- both maps are symmetries of the *current* game, and only a game
// actually played on the old board separates them.
func TestRankFlipReadsThePreChangeArchive(t *testing.T) {
	raw, err := os.ReadFile("testdata/prechange_v6.pgn")
	if err != nil {
		t.Fatal(err)
	}
	pgn := string(raw)
	server := openingTestServer(t)

	parsed, err := notation.Parse(pgn)
	if err != nil {
		t.Fatalf("the archived record no longer parses: %v", err)
	}
	if got := parsed.Tag("Generator"); got != "rps-strategy-pgn/1" {
		t.Fatalf("this fixture is meant to be a pre-change record, got generator %q", got)
	}

	// As recorded it is refused: it opens with Red, and Blue opens now.
	if _, ok := server.replayOpening("V6", parsed, false); ok {
		t.Fatal("a pre-change record replayed as written, so it is not testing what it claims")
	}
	// Flipped it is a legal game, and the compiler says so.
	replay, ok := server.replayArchivedOpening("V6", pgn)
	if !ok {
		t.Fatal("the rank flip did not recover a pre-change V6 game")
	}
	if !replay.turned {
		t.Fatal("the game was counted without being flipped")
	}
	if len(replay.line) == 0 {
		t.Fatal("a forty-seven ply game contributed no opening line")
	}
	// Every move of it, not just the twelve the compiler keeps: a relabelling
	// that only survives the opening is not a relabelling.
	played, total := replayWholeGame(t, server, "V6", parsed, game.RankFlipSquare)
	if played != total {
		t.Fatalf("the rank flip replayed %d of %d moves", played, total)
	}
	// And it reaches the same end by the same route. The archive says Red won
	// on a corner; flipped, that is Blue winning on Blue's corner today.
	flipped := rankFlipArchivedGame(persistence.ArchivedGameOpening{Outcome: "red_win"})
	if got := flipped.Outcome; got != "blue_win" {
		t.Fatalf("a flipped Red win should count as a Blue win, got %q", got)
	}

	// The half turn is the map this used to reach for, and it is wrong here --
	// wrong on the very first move, which is why the failure looked like an
	// unreadable archive rather than a bad transform.
	if halfPlayed, _ := replayWholeGame(t, server, "V6", parsed, game.HalfTurnSquare); halfPlayed != 0 {
		t.Fatalf("the half turn replayed %d moves of a pre-change V6 game; "+
			"if this now works the two maps have stopped disagreeing and this test proves nothing", halfPlayed)
	}
}

// The rank flip must not disturb the two modes that were already being read
// correctly: for them it agrees with the half turn, which is exactly why the
// V6 breakage went unnoticed.
func TestRankFlipAgreesWithTheHalfTurnOnRankGoalModes(t *testing.T) {
	for _, modeID := range []game.ModeID{"V3", "V5"} {
		server := openingTestServer(t)
		mode, err := server.registry.New(modeID)
		if err != nil {
			t.Fatal(err)
		}
		start := mode.Definition().StartingPosition
		if start.RankFlip() != start.HalfTurn() {
			t.Fatalf("%s: the rank flip and the half turn disagree on a layout that mirrors files", modeID)
		}
	}
	// And they disagree on Intransitive, which is the whole reason this file
	// exists. If this ever passes, the layout has changed and the archive
	// needs looking at again.
	server := openingTestServer(t)
	mode, err := server.registry.New("V6")
	if err != nil {
		t.Fatal(err)
	}
	start := mode.Definition().StartingPosition
	if start.RankFlip() == start.HalfTurn() {
		t.Fatal("the two maps agree on Intransitive, which they must not")
	}
}

func replayWholeGame(
	t *testing.T,
	server *Server,
	modeID game.ModeID,
	parsed notation.ParsedGame,
	square func(width, height int, position game.Position) game.Position,
) (int, int) {
	t.Helper()
	scratch, err := game.NewGameWithRegistryAndTimeControl(
		server.registry, "prechange", modeID,
		game.PlayerProfile{UserID: "r"}, game.PlayerProfile{UserID: "b"},
		game.TimeControl{InitialTimeMs: int64(time.Hour / time.Millisecond)},
	)
	if err != nil {
		t.Fatal(err)
	}
	played, total := 0, 0
	for _, event := range parsed.Record.Events {
		if event.Kind == game.EventMove {
			total++
		}
	}
	for _, event := range parsed.Record.Events {
		if event.Kind != game.EventMove {
			continue
		}
		state := scratch.Snapshot()
		if state.Status != game.InProgress {
			break
		}
		width, height := state.Grid.Width(), state.Grid.Height()
		player := game.OtherColor(event.Player)
		from := square(width, height, event.From)
		to := square(width, height, event.To)
		if player != state.CurrentTurn {
			break
		}
		if _, err := scratch.Move(player, from, to); err != nil {
			break
		}
		played++
	}
	return played, total
}
