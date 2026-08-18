package persistence

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
)

func TestSQLitePersistsAccountsAndRetainsChosenUsername(t *testing.T) {
	path := filepath.Join(t.TempDir(), "accounts.sqlite")
	store, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	account, err := store.EnsureAccount(context.Background(), "player-1", "Ada")
	if err != nil {
		t.Fatal(err)
	}
	if account.Elo != DefaultElo || account.Username != "Ada" {
		t.Fatalf("unexpected new account: %#v", account)
	}
	if _, err := store.EnsureAccount(context.Background(), "player-1", "Guest"); err != nil {
		t.Fatal(err)
	}
	if err := store.Close(); err != nil {
		t.Fatal(err)
	}

	reopened, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	persisted, err := reopened.Account(context.Background(), "player-1")
	if err != nil {
		t.Fatal(err)
	}
	if persisted.Username != "Ada" || persisted.Elo != DefaultElo {
		t.Fatalf("account did not survive reopening: %#v", persisted)
	}
}

func TestCompletedRankedGameUpdatesEloHistoryAndHeadToHeadExactlyOnce(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	red := game.PlayerProfile{UserID: "red-id", Username: "Red Player"}
	blue := game.PlayerProfile{UserID: "blue-id", Username: "Blue Player"}
	newGame, err := game.NewGame("ranked-game", game.ModeAnnihilation, red, blue)
	if err != nil {
		t.Fatal(err)
	}
	state, err := newGame.Resign(game.Blue)
	if err != nil {
		t.Fatal(err)
	}
	finishedAt := time.Date(2026, time.August, 17, 20, 0, 0, 0, time.UTC)
	update, err := store.RecordCompletedGame(
		context.Background(), state, finishedAt.Add(-time.Minute), finishedAt, true,
	)
	if err != nil {
		t.Fatal(err)
	}
	if !update.Recorded || update.RedEloAfter != 1216 || update.BlueEloAfter != 1184 {
		t.Fatalf("unexpected Elo update: %#v", update)
	}

	duplicate, err := store.RecordCompletedGame(
		context.Background(), state, finishedAt.Add(-time.Minute), finishedAt, true,
	)
	if err != nil {
		t.Fatal(err)
	}
	if duplicate.Recorded {
		t.Fatal("recording the same game twice must not apply a second result")
	}

	redAccount, err := store.Account(context.Background(), red.UserID)
	if err != nil {
		t.Fatal(err)
	}
	blueAccount, err := store.Account(context.Background(), blue.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if redAccount.Elo != 1216 || redAccount.Wins != 1 || redAccount.GamesPlayed != 1 {
		t.Fatalf("unexpected Red account: %#v", redAccount)
	}
	if blueAccount.Elo != 1184 || blueAccount.Losses != 1 || blueAccount.GamesPlayed != 1 {
		t.Fatalf("unexpected Blue account: %#v", blueAccount)
	}

	history, err := store.GameHistory(context.Background(), red.UserID, 20, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 1 || history[0].Outcome != "red_win" ||
		history[0].WinnerUserID == nil || *history[0].WinnerUserID != red.UserID {
		t.Fatalf("unexpected game history: %#v", history)
	}
	record, err := store.HeadToHead(context.Background(), blue.UserID, red.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if record.Player1Wins != 0 || record.Player2Wins != 1 ||
		record.Draws != 0 || record.GamesPlayed != 1 {
		t.Fatalf("unexpected head-to-head record: %#v", record)
	}
}

func TestDrawIsRecordedWithoutChangingEqualRatings(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	red := game.PlayerProfile{UserID: "draw-red", Username: "Red"}
	blue := game.PlayerProfile{UserID: "draw-blue", Username: "Blue"}
	newGame, err := game.NewGame("draw-game", game.ModeAnnihilation, red, blue)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := newGame.OfferDraw(game.Red); err != nil {
		t.Fatal(err)
	}
	state, err := newGame.AcceptDraw(game.Blue)
	if err != nil {
		t.Fatal(err)
	}
	update, err := store.RecordCompletedGame(
		context.Background(), state, time.Now().Add(-time.Minute), time.Now(), true,
	)
	if err != nil {
		t.Fatal(err)
	}
	if update.RedEloAfter != DefaultElo || update.BlueEloAfter != DefaultElo {
		t.Fatalf("equal players should not change Elo on a draw: %#v", update)
	}
	record, err := store.HeadToHead(context.Background(), red.UserID, blue.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if record.Draws != 1 || record.GamesPlayed != 1 {
		t.Fatalf("draw was not counted: %#v", record)
	}
}
