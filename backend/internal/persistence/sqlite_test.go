package persistence

import (
	"context"
	"fmt"
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
	if account.Elo != RatingStart || account.Username != "Ada" {
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
	if persisted.Username != "Ada" || persisted.Elo != RatingStart {
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
	if !update.Recorded {
		t.Fatalf("the game was not recorded: %#v", update)
	}
	// Both start where everybody starts. The winner rises a long way and the
	// loser falls only a little, because both were newcomers: the game narrowed
	// both deviations, which lifts both published numbers, while it moved their
	// strengths apart by the same amount.
	if update.RedEloBefore != RatingStart || update.BlueEloBefore != RatingStart {
		t.Fatalf("two new accounts did not start at %d: %#v", RatingStart, update)
	}
	if update.RedEloAfter <= update.RedEloBefore || update.BlueEloAfter >= update.BlueEloBefore {
		t.Fatalf("the winner should gain and the loser lose: %#v", update)
	}
	if gained, lost := update.RedEloAfter-update.RedEloBefore,
		update.BlueEloBefore-update.BlueEloAfter; gained <= lost {
		t.Fatalf("a newcomer's first win should be worth more than a first loss costs: %#v",
			update)
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
	if redAccount.ModeElo(game.ModeInfiltration) != update.RedEloAfter ||
		redAccount.Wins != 1 || redAccount.GamesPlayed != 1 {
		t.Fatalf("unexpected Red account: %#v", redAccount)
	}
	if blueAccount.ModeElo(game.ModeInfiltration) != update.BlueEloAfter ||
		blueAccount.Losses != 1 || blueAccount.GamesPlayed != 1 {
		t.Fatalf("unexpected Blue account: %#v", blueAccount)
	}
	// The account's headline rating is its best rated mode, which here is the
	// only one.
	if redAccount.Elo != update.RedEloAfter || blueAccount.Elo != update.BlueEloAfter {
		t.Fatalf("the headline ratings are %d and %d, want %d and %d",
			redAccount.Elo, blueAccount.Elo, update.RedEloAfter, update.BlueEloAfter)
	}
	if rating := redAccount.ModeRatings[game.ModeInfiltration]; rating.RatedGames != 1 ||
		rating.State != RatingStateProvisional {
		t.Fatalf("one ranked game should leave a provisional rating: %#v", rating)
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

// A draw between two equal players leaves both strengths where they were and
// narrows both deviations, so it lifts both published numbers by the same
// amount: playing is what is rewarded, and nobody beat anybody.
func TestADrawBetweenEqualsLiftsBothTheSameWay(t *testing.T) {
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
	if _, err := newGame.OfferDraw(game.FirstToMove); err != nil {
		t.Fatal(err)
	}
	state, err := newGame.AcceptDraw(game.OtherColor(game.FirstToMove))
	if err != nil {
		t.Fatal(err)
	}
	update, err := store.RecordCompletedGame(
		context.Background(), state, time.Now().Add(-time.Minute), time.Now(), true,
	)
	if err != nil {
		t.Fatal(err)
	}
	if update.RedEloAfter != update.BlueEloAfter || update.RedEloAfter <= RatingStart {
		t.Fatalf("a draw between newcomers should lift both equally: %#v", update)
	}
	redAccount, err := store.Account(context.Background(), red.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if strength := redAccount.ModeRatings[game.ModeInfiltration].Strength; strength != 1500 {
		t.Fatalf("a draw between equals moved the strength to %d", strength)
	}
	record, err := store.HeadToHead(context.Background(), red.UserID, blue.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if record.Draws != 1 || record.GamesPlayed != 1 {
		t.Fatalf("draw was not counted: %#v", record)
	}
}

// Modes are rated separately, and a mode you have never played starts from
// scratch: Intransitive and Infiltration are different games, and a strength in
// one says little about the other.
func TestModesAreRatedIndependently(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	red := game.PlayerProfile{UserID: "seed-red", Username: "Red"}
	blue := game.PlayerProfile{UserID: "seed-blue", Username: "Blue"}
	for _, userID := range []string{red.UserID, blue.UserID} {
		if _, err := store.EnsureAccount(context.Background(), userID, "Player"); err != nil {
			t.Fatal(err)
		}
	}

	counter := 0
	record := func(modeID game.ModeID, resigning game.PlayerColor) RatingUpdate {
		counter++
		newGame, err := game.NewGame(
			fmt.Sprintf("seed-%d", counter), modeID, red, blue,
		)
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

	// Red builds a real record in Infiltration.
	var infiltration RatingUpdate
	for range 6 {
		infiltration = record(game.ModeInfiltration, game.Blue)
	}
	if infiltration.RedEloAfter <= RatingStart {
		t.Fatalf("six wins did not lift the winner: %#v", infiltration)
	}

	// Total War has never been played, so it starts where everybody does.
	redAccount, err := store.Account(context.Background(), red.UserID)
	if err != nil {
		t.Fatal(err)
	}
	established := redAccount.ModeElo(game.ModeInfiltration)
	totalWar := record(game.ModeTotalWar, game.Red)
	if totalWar.RedEloBefore != RatingStart {
		t.Fatalf("an unplayed mode started at %d, want %d", totalWar.RedEloBefore, RatingStart)
	}

	// And they rate independently: losing in Total War does not touch
	// Infiltration.
	after, err := store.Account(context.Background(), red.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if after.ModeElo(game.ModeInfiltration) != established {
		t.Fatalf("a Total War game moved the Infiltration rating: %d then %d",
			established, after.ModeElo(game.ModeInfiltration))
	}
	if after.GamesPlayed != 7 || after.Wins != 6 || after.Losses != 1 {
		t.Fatalf("lifetime totals must span every mode: %#v", after)
	}
	if after.ModeRatings[game.ModeInfiltration].GamesPlayed != 6 ||
		after.ModeRatings[game.ModeTotalWar].GamesPlayed != 1 {
		t.Fatalf("unexpected per-mode records: %#v", after.ModeRatings)
	}
}
