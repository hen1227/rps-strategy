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
	if account.Elo != RatingFloor || account.Username != "Ada" {
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
	if persisted.Username != "Ada" || persisted.Elo != RatingFloor {
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
	// Both start at the floor, having proved nothing. The winner rises; the
	// loser does not pay for it, which is the property that separates this from
	// the transfer it replaced. There is no reservoir of points on a scale
	// everybody starts at the bottom of, so a rating cannot be taken from
	// somebody and given to somebody else — the game said one thing about the
	// winner and a different thing about the loser, and each is applied to its
	// own side.
	if update.RedEloBefore != RatingFloor || update.BlueEloBefore != RatingFloor {
		t.Fatalf("two new accounts did not start at the floor: %#v", update)
	}
	if update.RedEloAfter <= update.RedEloBefore {
		t.Fatalf("the winner did not gain: %#v", update)
	}
	if gained, lost := update.RedEloAfter-update.RedEloBefore,
		update.BlueEloBefore-update.BlueEloAfter; gained == lost {
		t.Fatalf("the winner took exactly what the loser lost, which is a transfer: %#v",
			update)
	}
	if update.BlueEloAfter < RatingFloor {
		t.Fatalf("a rating went below the floor: %#v", update)
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
	// The shared rating is only the seed a mode starts from, so a rated result
	// must leave it untouched.
	if redAccount.Elo != RatingFloor || blueAccount.Elo != RatingFloor {
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
	if update.RedEloAfter != RatingFloor || update.BlueEloAfter != RatingFloor {
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

// Modes are rated separately, and a mode you have never played starts from the
// strength the rest of your play established — held at arm's length, because a
// strength is not a rating until it has been demonstrated here.
//
// This used to seed the new mode from a shared Elo column and copy the number
// straight across. On this scale that would put a figure in front of somebody
// that no strength of theirs backs, and their first win in the mode would appear
// to move them from 130 to 18. What carries over now is the strength; what is
// published is that strength shrunk by the uncertainty of a mode with no games
// in it, which reads near the floor and climbs as they play.
func TestModeRatingsCarryStrengthAcrossModesButNotCertainty(t *testing.T) {
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
	if infiltration.RedEloAfter <= RatingFloor {
		t.Fatalf("six wins did not lift the winner off the floor: %#v", infiltration)
	}

	// Total War has never been played, so it publishes far below what
	// Infiltration does — but not from nothing, because the strength came with
	// them.
	redAccount, err := store.Account(context.Background(), red.UserID)
	if err != nil {
		t.Fatal(err)
	}
	established := redAccount.ModeElo(game.ModeInfiltration)
	totalWar := record(game.ModeTotalWar, game.Red)
	if totalWar.RedEloBefore >= established {
		t.Fatalf("an unplayed mode published as much as an established one: %d against %d",
			totalWar.RedEloBefore, established)
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
