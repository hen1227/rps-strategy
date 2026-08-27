package persistence

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/notation"
)

func finishedTestGame(t *testing.T, gameID string, modeID game.ModeID) *game.Game {
	t.Helper()
	played, err := game.NewGame(
		gameID,
		modeID,
		game.PlayerProfile{UserID: "red-id", Username: "Red Player"},
		game.PlayerProfile{UserID: "blue-id", Username: "Blue Player"},
	)
	if err != nil {
		t.Fatal(err)
	}
	state := played.Snapshot()
	for y := 0; y < game.BoardSize && state.Status == game.InProgress; y++ {
		for x := 0; x < game.BoardSize; x++ {
			if state.Grid[y][x].OccupantOwner != game.Red {
				continue
			}
			from := game.Position{X: x, Y: y}
			moves := played.ValidMoves(game.Red, from)
			if len(moves) == 0 {
				continue
			}
			if _, err := played.Move(game.Red, from, moves[0]); err != nil {
				t.Fatal(err)
			}
			state = played.Snapshot()
			break
		}
	}
	if _, err := played.Resign(game.Blue); err != nil {
		t.Fatal(err)
	}
	return played
}

func TestArchivedGameSurvivesReopeningAndReplays(t *testing.T) {
	path := filepath.Join(t.TempDir(), "archive.sqlite")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	played := finishedTestGame(t, "archived-game", game.ModeTotalWar)
	finishedAt := time.Now()
	archived, err := store.ArchiveGame(
		context.Background(),
		played.Record(),
		notation.Metadata{Event: "Ranked", Ranked: true, FinishedAt: finishedAt},
		"",
	)
	if err != nil {
		t.Fatal(err)
	}
	if archived.PlyCount != 1 || archived.Outcome != "red_win" {
		t.Fatalf("unexpected archive row: %#v", archived)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	stored, err := reopened.ArchivedGame(context.Background(), "archived-game")
	if err != nil {
		t.Fatal(err)
	}
	if stored.PGN != archived.PGN {
		t.Fatal("stored PGN changed on the way to disk")
	}
	parsed, err := notation.Parse(stored.PGN)
	if err != nil {
		t.Fatal(err)
	}
	if err := game.Verify(parsed.Record); err != nil {
		t.Fatalf("stored game does not replay: %v", err)
	}
	if !parsed.Metadata.Ranked || parsed.Metadata.Event != "Ranked" {
		t.Fatalf("metadata did not survive storage: %#v", parsed.Metadata)
	}
}

func TestArchiveGameIgnoresARepeat(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	played := finishedTestGame(t, "repeat-game", game.ModeInfiltration)
	for attempt := 0; attempt < 3; attempt++ {
		if _, err := store.ArchiveGame(
			context.Background(), played.Record(), notation.Metadata{}, "",
		); err != nil {
			t.Fatal(err)
		}
	}
	total, err := store.CountArchivedGames(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if total != 1 {
		t.Fatalf("expected one archived game, got %d", total)
	}
}

func TestArchiveGameRejectsSelfPlay(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	profile := game.PlayerProfile{UserID: "same-id", Username: "Solo"}
	played, err := game.NewGame("self-play", game.ModeTotalWar, profile, profile)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ArchiveGame(
		context.Background(), played.Record(), notation.Metadata{}, "",
	); err == nil {
		t.Fatal("expected the archive to refuse a self-play game")
	}
	if total, err := store.CountArchivedGames(context.Background()); err != nil || total != 0 {
		t.Fatalf("self-play must not reach the archive: total=%d err=%v", total, err)
	}
}

func TestExportArchivedGamesPagesInOrder(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	base := time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC)
	ranked := true
	for index := 0; index < 5; index++ {
		played := finishedTestGame(t, "game-"+string(rune('a'+index)), game.ModeTotalWar)
		if _, err := store.ArchiveGame(
			context.Background(),
			played.Record(),
			notation.Metadata{
				Ranked:     index%2 == 0,
				FinishedAt: base.Add(time.Duration(index) * time.Minute),
			},
			"",
		); err != nil {
			t.Fatal(err)
		}
	}

	page, err := store.ExportArchivedGames(context.Background(), ArchiveFilter{Limit: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(page) != 2 || page[0].GameID != "game-a" || page[1].GameID != "game-b" {
		t.Fatalf("unexpected first page: %#v", page)
	}
	next, err := store.ExportArchivedGames(
		context.Background(), ArchiveFilter{Limit: 2, Offset: 2},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(next) != 2 || next[0].GameID != "game-c" {
		t.Fatalf("unexpected second page: %#v", next)
	}

	rankedOnly, err := store.ExportArchivedGames(
		context.Background(), ArchiveFilter{Ranked: &ranked},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(rankedOnly) != 3 {
		t.Fatalf("expected 3 ranked games, got %d", len(rankedOnly))
	}
	since, err := store.ExportArchivedGames(
		context.Background(),
		ArchiveFilter{SinceUnixMs: base.Add(3 * time.Minute).UnixMilli()},
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(since) != 2 {
		t.Fatalf("expected 2 games after the cutoff, got %d", len(since))
	}

	file := ArchiveFile(page)
	if strings.Count(file, "[GameId ") != 2 {
		t.Fatalf("archive file should hold two games:\n%s", file)
	}
	games, err := notation.ParseMulti(file)
	if err != nil {
		t.Fatal(err)
	}
	if len(games) != 2 {
		t.Fatalf("expected to read back 2 games, got %d", len(games))
	}
}

func TestAccountArchivedGamesFindsBothColors(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	played := finishedTestGame(t, "shared-game", game.ModeTotalWar)
	if _, err := store.ArchiveGame(
		context.Background(), played.Record(), notation.Metadata{}, "",
	); err != nil {
		t.Fatal(err)
	}
	for _, userID := range []string{"red-id", "blue-id"} {
		games, err := store.AccountArchivedGames(context.Background(), userID, 10, 0)
		if err != nil {
			t.Fatal(err)
		}
		if len(games) != 1 {
			t.Fatalf("%s should have one archived game, got %d", userID, len(games))
		}
	}
	if _, err := store.ArchivedGame(context.Background(), "missing"); err == nil {
		t.Fatal("expected a not-found error")
	}
}
