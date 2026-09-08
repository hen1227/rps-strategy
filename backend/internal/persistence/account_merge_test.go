package persistence

import (
	"errors"
	"strings"
	"testing"
)

// A guest who has been playing for weeks, signing in with a Discord account
// that has never played. That is the one case where folding one into the other
// is unambiguous, and it is the case this whole file exists for.
func TestMergingAGuestIntoAnUnplayedDiscordAccount(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	anonymousAccount(t, store, "guest", "Guest")
	anonymousAccount(t, store, "opponent", "Rival")
	playRankedGame(t, store, "game-1", "guest", "opponent")
	playRankedGame(t, store, "game-2", "opponent", "guest")

	guestBefore, err := store.Account(ctx, "guest")
	if err != nil {
		t.Fatal(err)
	}
	if guestBefore.GamesPlayed != 2 {
		t.Fatalf("fixture did not play two games: %+v", guestBefore)
	}

	anonymousAccount(t, store, "discord", "Yuki")
	if _, err := store.ClaimAccountWithDiscord(ctx, "discord", "Yuki", "8035111", "yuki"); err != nil {
		t.Fatalf("claim: %v", err)
	}

	rewritten, err := store.MergeAccountHistory(ctx, "guest", "discord")
	if err != nil {
		t.Fatalf("merge: %v", err)
	}
	if rewritten != 2 {
		t.Fatalf("rewrote %d archived records, want 2", rewritten)
	}

	merged, err := store.Account(ctx, "discord")
	if err != nil {
		t.Fatal(err)
	}
	if merged.GamesPlayed != guestBefore.GamesPlayed || merged.Wins != guestBefore.Wins {
		t.Fatalf("the record did not come across: %+v want %+v", merged, guestBefore)
	}
	if merged.Elo != guestBefore.Elo {
		t.Fatalf("rating did not come across: %d want %d", merged.Elo, guestBefore.Elo)
	}
	if merged.Username != "Yuki" || !merged.DiscordVerified {
		t.Fatalf("the surviving account lost its own identity: %+v", merged)
	}

	// The guest row is gone rather than left sealed: nothing refers to it any
	// more, and a stray empty account is only confusing to find later.
	if _, err := store.Account(ctx, "guest"); !errors.Is(err, ErrAccountNotFound) {
		t.Fatalf("the merged account survived: %v", err)
	}

	// Every seat the guest held now names the surviving account, in both the
	// columns and the PGN's own copy — the one an exported archive carries.
	if remaining := countRows(t, store, `
SELECT COUNT(*) FROM game_history
WHERE red_player_id = 'guest' OR blue_player_id = 'guest' OR winner_player_id = 'guest'
`); remaining != 0 {
		t.Errorf("%d game_history rows still point at the merged account", remaining)
	}
	if remaining := countRows(t, store,
		`SELECT COUNT(*) FROM game_pgn WHERE red_player_id = 'guest' OR blue_player_id = 'guest'`,
	); remaining != 0 {
		t.Errorf("%d game_pgn rows still point at the merged account", remaining)
	}
	pgn := onlyPGN(t, store, "game-1")
	if strings.Contains(pgn, `"guest"`) {
		t.Errorf("the stored record still names the merged account:\n%s", pgn)
	}
	if !strings.Contains(pgn, `[Red "Yuki"]`) || !strings.Contains(pgn, `[RedId "discord"]`) {
		t.Errorf("the stored record was not reseated:\n%s", pgn)
	}
}

func onlyPGN(t *testing.T, store *Store, gameID string) string {
	t.Helper()
	var pgn string
	if err := store.db.QueryRowContext(t.Context(),
		`SELECT pgn FROM game_pgn WHERE game_id = ?`, gameID,
	).Scan(&pgn); err != nil {
		t.Fatalf("read pgn: %v", err)
	}
	return pgn
}

// The rule that keeps this affordable. A target with games would mean
// arbitrating two ratings and two records, and — because the two accounts may
// have played each other — reassignments that game_history's own CHECK forbids.
func TestMergingRefusesATargetThatHasAlreadyPlayed(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	anonymousAccount(t, store, "guest", "Guest")
	anonymousAccount(t, store, "discord", "Yuki")
	if _, err := store.ClaimAccountWithDiscord(ctx, "discord", "Yuki", "8035111", "yuki"); err != nil {
		t.Fatal(err)
	}
	playRankedGame(t, store, "game-1", "guest", "discord")

	if _, err := store.MergeAccountHistory(ctx, "guest", "discord"); !errors.Is(
		err, ErrMergeTargetHasHistory,
	) {
		t.Fatalf("merged into an account that had played: %v", err)
	}
	// And nothing moved. A refused merge must not be a partial one.
	guest, err := store.Account(ctx, "guest")
	if err != nil {
		t.Fatalf("the guest account was disturbed: %v", err)
	}
	if guest.GamesPlayed != 1 {
		t.Fatalf("the guest lost its history to a refused merge: %+v", guest)
	}
}

func TestMergingRefusesToAbsorbARegisteredAccount(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	anonymousAccount(t, store, "established", "Ada")
	if _, err := store.ClaimAccountWithDiscord(
		ctx, "established", "Ada", "111", "ada",
	); err != nil {
		t.Fatal(err)
	}
	anonymousAccount(t, store, "discord", "Yuki")
	if _, err := store.ClaimAccountWithDiscord(ctx, "discord", "Yuki", "222", "yuki"); err != nil {
		t.Fatal(err)
	}

	// Only a guest identity may be absorbed. Folding one real account into
	// another is an account deletion wearing a friendly name.
	if _, err := store.MergeAccountHistory(ctx, "established", "discord"); !errors.Is(
		err, ErrMergeSourceIsRegistered,
	) {
		t.Fatalf("absorbed a registered account: %v", err)
	}
}

// The archive has to survive being reseated, or the merge has quietly
// destroyed the thing it was preserving. Only the tag block may change: the
// movetext is what makes a stored record replayable, and it must come out
// byte-identical.
func TestReseatingARecordLeavesTheMovetextUntouched(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	anonymousAccount(t, store, "guest", "Guest")
	anonymousAccount(t, store, "opponent", "Rival")
	playRankedGame(t, store, "game-1", "guest", "opponent")
	anonymousAccount(t, store, "discord", "Yuki")
	if _, err := store.ClaimAccountWithDiscord(ctx, "discord", "Yuki", "8035111", "yuki"); err != nil {
		t.Fatal(err)
	}
	before := movetext(t, onlyPGN(t, store, "game-1"))
	if _, err := store.MergeAccountHistory(ctx, "guest", "discord"); err != nil {
		t.Fatalf("merge: %v", err)
	}
	after := movetext(t, onlyPGN(t, store, "game-1"))
	if before != after {
		t.Fatalf("the merge rewrote the movetext:\n--- before ---\n%s\n--- after ---\n%s",
			before, after)
	}
	if before == "" {
		t.Fatal("the fixture has no movetext, so this assertion proves nothing")
	}
}

// movetext is everything after the tag block, which ends at the first blank
// line.
func movetext(t *testing.T, pgn string) string {
	t.Helper()
	_, moves, found := strings.Cut(pgn, "\n\n")
	if !found {
		t.Fatalf("record has no movetext section:\n%s", pgn)
	}
	return moves
}
