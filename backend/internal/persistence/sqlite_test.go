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
	newGame, err := game.NewGame("ranked-game", game.ModeInfiltration, red, blue)
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
	if redAccount.ModeElo(game.ModeInfiltration) != 1216 || redAccount.Wins != 1 ||
		redAccount.GamesPlayed != 1 {
		t.Fatalf("unexpected Red account: %#v", redAccount)
	}
	if blueAccount.ModeElo(game.ModeInfiltration) != 1184 || blueAccount.Losses != 1 ||
		blueAccount.GamesPlayed != 1 {
		t.Fatalf("unexpected Blue account: %#v", blueAccount)
	}
	// The shared rating is only the seed a mode starts from, so a rated result
	// must leave it untouched.
	if redAccount.Elo != DefaultElo || blueAccount.Elo != DefaultElo {
		t.Fatalf("ranked play moved the shared seed rating: %d, %d",
			redAccount.Elo, blueAccount.Elo)
	}
	if redAccount.ModeRatings[game.ModeInfiltration].Wins != 1 ||
		blueAccount.ModeRatings[game.ModeInfiltration].Losses != 1 {
		t.Fatalf("mode record was not counted: %#v, %#v",
			redAccount.ModeRatings, blueAccount.ModeRatings)
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
	newGame, err := game.NewGame("draw-game", game.ModeInfiltration, red, blue)
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

func TestModeRatingsRateIndependentlyFromTheSharedSeed(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	red := game.PlayerProfile{UserID: "seed-red", Username: "Red"}
	blue := game.PlayerProfile{UserID: "seed-blue", Username: "Blue"}
	for _, seed := range []struct {
		userID string
		elo    int
	}{{userID: red.UserID, elo: 1300}, {userID: blue.UserID, elo: 1100}} {
		if _, err := store.EnsureAccount(context.Background(), seed.userID, "Player"); err != nil {
			t.Fatal(err)
		}
		// Stand in for an account that carried a single rating before modes
		// rated separately.
		if _, err := store.db.ExecContext(
			context.Background(),
			"UPDATE accounts SET elo = ? WHERE user_id = ?",
			seed.elo, seed.userID,
		); err != nil {
			t.Fatal(err)
		}
	}

	record := func(gameID string, modeID game.ModeID, resigning game.PlayerColor) RatingUpdate {
		newGame, err := game.NewGame(gameID, modeID, red, blue)
		if err != nil {
			t.Fatal(err)
		}
		state, err := newGame.Resign(resigning)
		if err != nil {
			t.Fatal(err)
		}
		update, err := store.RecordCompletedGame(
			context.Background(), state, time.Now().Add(-time.Minute), time.Now(), true,
		)
		if err != nil {
			t.Fatal(err)
		}
		return update
	}

	infiltration := record("seed-infiltration", game.ModeInfiltration, game.Blue)
	if infiltration.ModeID != game.ModeInfiltration ||
		infiltration.RedEloBefore != 1300 || infiltration.BlueEloBefore != 1100 {
		t.Fatalf("the first game in a mode must start from the shared seed: %#v", infiltration)
	}
	if infiltration.RedEloAfter != 1308 || infiltration.BlueEloAfter != 1092 {
		t.Fatalf("unexpected Infiltration rating update: %#v", infiltration)
	}

	// Total War has not been played yet, so it still sits on the shared seed
	// rather than inheriting the Infiltration result.
	totalWar := record("seed-total-war", game.ModeTotalWar, game.Red)
	if totalWar.RedEloBefore != 1300 || totalWar.BlueEloBefore != 1100 {
		t.Fatalf("Total War inherited the Infiltration rating: %#v", totalWar)
	}
	if totalWar.RedEloAfter != 1276 || totalWar.BlueEloAfter != 1124 {
		t.Fatalf("unexpected Total War rating update: %#v", totalWar)
	}

	redAccount, err := store.Account(context.Background(), red.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if redAccount.ModeElo(game.ModeInfiltration) != 1308 ||
		redAccount.ModeElo(game.ModeTotalWar) != 1276 {
		t.Fatalf("modes did not keep separate ratings: %#v", redAccount.ModeRatings)
	}
	if redAccount.ModeElo(game.ModeID("V7")) != 1300 {
		t.Fatal("an unplayed mode must report the shared seed rating")
	}
	if redAccount.GamesPlayed != 2 || redAccount.Wins != 1 || redAccount.Losses != 1 {
		t.Fatalf("lifetime totals must span every mode: %#v", redAccount)
	}
	if redAccount.ModeRatings[game.ModeInfiltration].GamesPlayed != 1 ||
		redAccount.ModeRatings[game.ModeTotalWar].GamesPlayed != 1 {
		t.Fatalf("unexpected per-mode records: %#v", redAccount.ModeRatings)
	}
}
