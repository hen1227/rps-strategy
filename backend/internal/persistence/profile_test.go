package persistence

import (
	"testing"

	"rps-strategy/backend/internal/game"
)

// A profile's rating is the same number the rest of the site publishes.
//
// `accounts.elo` is the seed a mode with no row of its own inherits, and on the
// old scale that seed was 1200 — which is now RatingCeiling, the top of what the
// scale can print. restateSeededRatings resets it to RatingFloor for people and
// deliberately leaves engines alone, because nothing reads a bot's seed: every
// other rollup takes MAX(account_mode_ratings.elo) and falls back to the seed
// only for an account that has no mode row at all.
//
// So a bot carrying the old seed is the case that tells the profile's rollup
// apart from everybody else's, and it is not a hypothetical — it is every engine
// that was on the board before the rebuild.
func TestProfileRatingIsTheMeasuredOneRatherThanTheOldSeed(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "ada", "Ada")
	bot := claimBotFor(t, store, "ada", "Bu", 240, 249)
	// What the rebuild left on an engine's row: a measured mode rating of 240,
	// beside a seed still holding the old scale's 1200.
	if _, err := store.db.ExecContext(ctx,
		"UPDATE accounts SET elo = 1200 WHERE user_id = ?", bot.UserID,
	); err != nil {
		t.Fatalf("seed the legacy rating: %v", err)
	}

	profile, err := store.PublicProfile(ctx, "Bu", 5)
	if err != nil {
		t.Fatalf("read profile: %v", err)
	}
	if profile.Elo != 240 {
		t.Errorf("profile rating is %d, want the measured 240", profile.Elo)
	}

	// The same engine, by the two other addresses that publish a rating for it.
	// A page that disagrees with the directory it is reached from is the bug,
	// so the assertion is that all three agree rather than that one is right.
	directory, err := store.PublicProfiles(ctx, "Bu", 10, 0)
	if err != nil {
		t.Fatalf("read directory: %v", err)
	}
	if len(directory) != 1 || directory[0].Elo != 240 {
		t.Errorf("directory row is %#v, want one row rated 240", directory)
	}
	board, err := store.Leaderboard(ctx, LeaderboardFilter{Kind: LeaderboardKindBot})
	if err != nil {
		t.Fatalf("read board: %v", err)
	}
	if len(board) != 1 || board[0].Elo != 240 {
		t.Errorf("board row is %#v, want one row rated 240", board)
	}

	// And on its owner's page, which lists the same engine a third time.
	owner, err := store.PublicProfile(ctx, "Ada", 5)
	if err != nil {
		t.Fatalf("read owner profile: %v", err)
	}
	if len(owner.Bots) != 1 || owner.Bots[0].Elo != 240 {
		t.Errorf("owner's engine list is %#v, want one engine rated 240", owner.Bots)
	}
}

// A page says whether its number is a measurement, in the same word the ladder
// uses.
//
// This is the half of the disagreement that survives the rollup being fixed.
// While no yardstick is designated nothing on the bot board is placed, so every
// engine's figure is a placeholder — and a profile that printed it bare would be
// making the claim the row beside it on the ladder withdraws.
func TestProfileSaysWhenItsRatingIsNotAMeasurement(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "ada", "Ada")
	bot := claimBotFor(t, store, "ada", "Bu", 240, 249)
	seedUnplacedRating(t, store, bot.UserID, game.ModeInfiltration, 1, 60)

	profile, err := store.PublicProfile(ctx, "Bu", 5)
	if err != nil {
		t.Fatalf("read profile: %v", err)
	}
	// The measured mode represents it, and says so.
	if profile.Elo != 240 || profile.RatingState != RatingStateRated {
		t.Errorf("profile is %d/%s, want 240/rated", profile.Elo, profile.RatingState)
	}

	// Now the case the board is actually in: nothing placed anywhere.
	if _, err := store.db.ExecContext(ctx,
		"UPDATE account_mode_ratings SET rating_placed = 0, rating_confidence = 0 WHERE user_id = ?",
		bot.UserID,
	); err != nil {
		t.Fatalf("unplace the ratings: %v", err)
	}
	profile, err = store.PublicProfile(ctx, "Bu", 5)
	if err != nil {
		t.Fatalf("read profile: %v", err)
	}
	if profile.RatingState != RatingStateUnrated {
		t.Errorf("profile state is %q, want unrated", profile.RatingState)
	}
	owner, err := store.PublicProfile(ctx, "Ada", 5)
	if err != nil {
		t.Fatalf("read owner profile: %v", err)
	}
	if len(owner.Bots) != 1 || owner.Bots[0].RatingState != RatingStateUnrated {
		t.Errorf("owner's engine list is %#v, want its one engine unrated", owner.Bots)
	}
}

// An account nobody has measured in anything is unrated too, rather than being
// the one shape that publishes a bare seed.
func TestProfileWithNoModeRatingIsUnrated(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "grace", "Grace")
	profile, err := store.PublicProfile(ctx, "Grace", 5)
	if err != nil {
		t.Fatalf("read profile: %v", err)
	}
	if profile.RatingState != RatingStateUnrated {
		t.Errorf("profile state is %q, want unrated", profile.RatingState)
	}
}

// The seed is still the answer for an account with nothing measured, which is
// the case the fallback exists for — and the reason the fix is not simply to
// stop reading `accounts.elo`.
func TestProfileRatingFallsBackToTheSeedWithNoModeRating(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "grace", "Grace")
	if _, err := store.db.ExecContext(ctx,
		"UPDATE accounts SET elo = ? WHERE user_id = ?", 137, "grace",
	); err != nil {
		t.Fatalf("seed the rating: %v", err)
	}

	profile, err := store.PublicProfile(ctx, "Grace", 5)
	if err != nil {
		t.Fatalf("read profile: %v", err)
	}
	if profile.Elo != 137 {
		t.Errorf("profile rating is %d, want the seed 137", profile.Elo)
	}
}

// A mode nobody has been placed in does not get to represent an account.
//
// The combined board picks its row with `ranked DESC, elo DESC` — a measured
// rating beats a higher unmeasured one, because an unrated number is not a
// claim about the player. A profile that took the plain maximum would headline
// the number the board declined to rank.
func TestProfileRatingPrefersAMeasuredModeOverAHigherUnratedOne(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "alan", "Alan")
	seedModeRating(t, store, "alan", game.ModeTotalWar, 210, 40)
	seedUnplacedRating(t, store, "alan", game.ModeInfiltration, 900, 3)
	if _, err := store.db.ExecContext(ctx,
		"UPDATE accounts SET games_played = 43 WHERE user_id = ?", "alan",
	); err != nil {
		t.Fatalf("seed the record: %v", err)
	}

	profile, err := store.PublicProfile(ctx, "Alan", 5)
	if err != nil {
		t.Fatalf("read profile: %v", err)
	}
	if profile.Elo != 210 {
		t.Errorf("profile rating is %d, want the measured 210", profile.Elo)
	}

	board, err := store.Leaderboard(ctx, LeaderboardFilter{})
	if err != nil {
		t.Fatalf("read board: %v", err)
	}
	if len(board) != 1 || board[0].Elo != 210 {
		t.Errorf("board row is %#v, want one row rated 210", board)
	}
}
