package persistence

import (
	"testing"

	"rps-strategy/backend/internal/game"
)

// A profile's rating is the same number the rest of the site publishes for the
// account, by every address that publishes one: the page, the directory, the
// board, and the owner's list of engines.
//
// The trap this guards is a stale account-level number. accounts.elo held a
// placeholder under every older rating system — 1200 on the first, 1 on the
// second — and the rollups that read it published that placeholder beside a
// measured mode. A rebuild restates it, so after the replay all four agree.
func TestEveryPageAgreesOnAnAccountsRating(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	strong := rival(t, store, "Bu")
	weak := rival(t, store, "Peanut")
	seedSeries(t, store, "bu", game.ModeTotalWar, strong, weak, 30, 24, recently())
	if _, err := store.db.ExecContext(ctx,
		"UPDATE accounts SET elo = 1200 WHERE user_id = ?", strong.UserID,
	); err != nil {
		t.Fatalf("seed a stale headline: %v", err)
	}
	replay(t, store)

	want := modeRating(t, store, strong.UserID, game.ModeTotalWar).Elo
	if want <= RatingStart {
		t.Fatalf("winning 24 of 30 published %d", want)
	}

	profile, err := store.PublicProfile(ctx, "Bu", 5)
	if err != nil {
		t.Fatalf("read profile: %v", err)
	}
	if profile.Elo != want {
		t.Errorf("profile rating is %d, want %d", profile.Elo, want)
	}
	directory, err := store.PublicProfiles(ctx, "Bu", 10, 0)
	if err != nil {
		t.Fatalf("read directory: %v", err)
	}
	// The search finds the owner too, whose name contains the engine's.
	found := false
	for _, row := range directory {
		if row.Username == "Bu" {
			found = true
			if row.Elo != want {
				t.Errorf("directory row is %#v, want rated %d", row, want)
			}
		}
	}
	if !found {
		t.Errorf("the directory did not list Bu: %#v", directory)
	}
	board, err := store.Leaderboard(ctx, LeaderboardFilter{Kind: LeaderboardKindBot})
	if err != nil {
		t.Fatalf("read board: %v", err)
	}
	if len(board) != 2 || board[0].Username != "Bu" || board[0].Elo != want {
		t.Errorf("board is %#v, want Bu first at %d", board, want)
	}
	owner, err := store.PublicProfile(ctx, "Owner_Bu", 5)
	if err != nil {
		t.Fatalf("read owner profile: %v", err)
	}
	if len(owner.Bots) != 1 || owner.Bots[0].Elo != want {
		t.Errorf("owner's engine list is %#v, want one engine rated %d", owner.Bots, want)
	}
}

// An engine that has only played casual games has no rating, and a page says so
// in the same word the ladder uses rather than printing the starting number as
// though it had been earned.
func TestAProfileWithNoRankedGameIsUnrated(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "ada", "Ada")
	bot := claimBotFor(t, store, "ada", "Bu", RatingStart, 0)
	seedUnplacedRating(t, store, bot.UserID, game.ModeInfiltration, RatingStart, 60)

	profile, err := store.PublicProfile(ctx, "Bu", 5)
	if err != nil {
		t.Fatalf("read profile: %v", err)
	}
	if profile.Elo != RatingStart || profile.RatingState != RatingStateUnrated {
		t.Errorf("profile is %d/%s, want %d/unrated", profile.Elo, profile.RatingState, RatingStart)
	}
	owner, err := store.PublicProfile(ctx, "Ada", 5)
	if err != nil {
		t.Fatalf("read owner profile: %v", err)
	}
	if len(owner.Bots) != 1 || owner.Bots[0].RatingState != RatingStateUnrated {
		t.Errorf("owner's engine list is %#v, want its one engine unrated", owner.Bots)
	}
}

// An account that has played nothing at all is unrated too, at the number
// everybody starts on.
func TestProfileWithNoModeRatingIsUnrated(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "grace", "Grace")
	profile, err := store.PublicProfile(ctx, "Grace", 5)
	if err != nil {
		t.Fatalf("read profile: %v", err)
	}
	if profile.RatingState != RatingStateUnrated || profile.Elo != RatingStart {
		t.Errorf("profile is %d/%s, want %d/unrated", profile.Elo, profile.RatingState, RatingStart)
	}
}

// A mode with no ranked game does not get to represent an account, however its
// number compares. The combined board picks its row the same way.
func TestProfileRatingPrefersARatedModeOverAHigherUnratedOne(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "alan", "Alan")
	seedModeRating(t, store, "alan", game.ModeTotalWar, 1210, 40)
	seedUnplacedRating(t, store, "alan", game.ModeInfiltration, 1900, 3)
	if _, err := store.db.ExecContext(ctx,
		"UPDATE accounts SET games_played = 43 WHERE user_id = ?", "alan",
	); err != nil {
		t.Fatalf("seed the record: %v", err)
	}

	profile, err := store.PublicProfile(ctx, "Alan", 5)
	if err != nil {
		t.Fatalf("read profile: %v", err)
	}
	if profile.Elo != 1210 || profile.RatingState != RatingStateRated {
		t.Errorf("profile is %d/%s, want the rated 1210", profile.Elo, profile.RatingState)
	}

	board, err := store.Leaderboard(ctx, LeaderboardFilter{})
	if err != nil {
		t.Fatalf("read board: %v", err)
	}
	if len(board) != 1 || board[0].Elo != 1210 {
		t.Errorf("board row is %#v, want one row rated 1210", board)
	}
}
