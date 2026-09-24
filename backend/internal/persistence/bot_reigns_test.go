package persistence

import (
	"testing"

	"rps-strategy/backend/internal/game"
)

const totalWar = string(game.ModeTotalWar)

// sweep runs one pass of the ledger at a given clock and fails on error.
func sweep(t *testing.T, store *Store, now int64) map[string]BotReign {
	t.Helper()
	changed, err := store.SyncBotReigns(t.Context(), now)
	if err != nil {
		t.Fatalf("sync bot reigns at %d: %v", now, err)
	}
	return changed
}

// rerate moves an engine's existing rating, which is what a refit does. Not
// seedRecord again: that inserts, and a rating row already exists by the time
// anything here wants to change one.
func rerate(t *testing.T, store *Store, userID string, elo int) {
	t.Helper()
	if _, err := store.db.ExecContext(t.Context(), `
UPDATE account_mode_ratings SET elo = ? WHERE user_id = ? AND mode_id = ?
`, elo, userID, totalWar); err != nil {
		t.Fatalf("rerate %s: %v", userID, err)
	}
}

// currentReign is the open reign of a mode, and whether there is one.
func currentReign(t *testing.T, store *Store, modeID string) (BotReign, bool) {
	t.Helper()
	reigns, err := store.currentBotReigns(t.Context())
	if err != nil {
		t.Fatalf("read current reigns: %v", err)
	}
	reign, ok := reigns[modeID]
	return reign, ok
}

// A leader has to be seen twice before it is written, because a bot rating
// moves with no game played — evidence decays on a clock — so one sighting is
// not yet evidence of anything.
func TestAReignIsWrittenOnlyAfterASecondSighting(t *testing.T) {
	store := authTestStore(t)

	registeredOwner(t, store, "ada", "Ada")
	claimBotFor(t, store, "ada", "AdaTop", 1900, 30)

	if changed := sweep(t, store, 1_000); len(changed) != 0 {
		t.Fatalf("first sighting must not open a reign, got %v", changed)
	}
	if _, ok := currentReign(t, store, totalWar); ok {
		t.Fatal("a leader seen once is a candidate, not a reign")
	}

	changed := sweep(t, store, 2_000)
	if len(changed) != 1 {
		t.Fatalf("the second sighting should open one reign, got %v", changed)
	}
	reign, ok := currentReign(t, store, totalWar)
	if !ok {
		t.Fatal("expected an open reign after two sightings")
	}
	// Dated from the sighting, not from the confirmation: the engine was in
	// front at 1,000 and the ledger has no reason to say otherwise.
	if reign.StartedAtUnixMs != 1_000 {
		t.Fatalf("reign should start at the first sighting, got %d", reign.StartedAtUnixMs)
	}
	if !reign.Current {
		t.Fatalf("a reign with no end is the current one: %#v", reign)
	}
}

// A challenger that leads one sweep and is gone by the next never held the
// seat. Without this a refit that swapped two engines a point apart would file
// a reign for each pass.
func TestAOneSweepFlickerNeverBecomesAReign(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")
	ada := claimBotFor(t, store, "ada", "AdaTop", 1900, 30)
	grace := claimBotFor(t, store, "grace", "GraceOne", 1800, 30)

	sweep(t, store, 1_000)
	sweep(t, store, 2_000)
	if reign, _ := currentReign(t, store, totalWar); reign.UserID != ada.UserID {
		t.Fatalf("Ada's engine should hold the seat: %#v", reign)
	}

	// Grace goes in front for exactly one sweep, then back.
	rerate(t, store, grace.UserID, 2_000)
	sweep(t, store, 3_000)
	rerate(t, store, grace.UserID, 1_800)
	sweep(t, store, 4_000)

	reigns, err := store.BotReigns(ctx, grace.UserID)
	if err != nil {
		t.Fatalf("read Grace's reigns: %v", err)
	}
	if len(reigns) != 0 {
		t.Fatalf("a one-sweep flicker is not a reign: %#v", reigns)
	}
	reign, ok := currentReign(t, store, totalWar)
	if !ok || reign.UserID != ada.UserID || reign.StartedAtUnixMs != 1_000 {
		t.Fatalf("Ada's reign should be untouched and unbroken: %#v", reign)
	}
}

// A confirmed change closes the old reign and opens a new one, and the two meet
// at the same instant so the history has no gap in it.
func TestAConfirmedChangeHandsTheSeatOver(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")
	ada := claimBotFor(t, store, "ada", "AdaTop", 1900, 30)
	grace := claimBotFor(t, store, "grace", "GraceOne", 1800, 30)

	sweep(t, store, 1_000)
	sweep(t, store, 2_000)

	rerate(t, store, grace.UserID, 2_000)
	sweep(t, store, 3_000)
	sweep(t, store, 4_000)

	adaReigns, err := store.BotReigns(ctx, ada.UserID)
	if err != nil {
		t.Fatalf("read Ada's reigns: %v", err)
	}
	if len(adaReigns) != 1 {
		t.Fatalf("Ada should have exactly one finished reign: %#v", adaReigns)
	}
	if adaReigns[0].Current {
		t.Fatalf("Ada no longer holds the seat: %#v", adaReigns[0])
	}
	// Ended when Grace was first seen in front, which is also when Grace's
	// reign starts: one seat, handed over, with no interval belonging to
	// nobody.
	if adaReigns[0].EndedAtUnixMs != 3_000 {
		t.Fatalf("Ada's reign should end at the first sighting of Grace: %#v", adaReigns[0])
	}
	graceReigns, err := store.BotReigns(ctx, grace.UserID)
	if err != nil {
		t.Fatalf("read Grace's reigns: %v", err)
	}
	if len(graceReigns) != 1 || graceReigns[0].StartedAtUnixMs != 3_000 {
		t.Fatalf("Grace's reign should start where Ada's ended: %#v", graceReigns)
	}
	if !graceReigns[0].Current {
		t.Fatalf("Grace holds the seat now: %#v", graceReigns[0])
	}
}

// Taking the seat back is a second reign rather than a resumed first one. This
// is the record "former number one" is read off, and a bot that led twice with
// somebody else in between led twice.
func TestWinningTheSeatBackOpensASecondReign(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")
	ada := claimBotFor(t, store, "ada", "AdaTop", 1900, 30)
	grace := claimBotFor(t, store, "grace", "GraceOne", 1800, 30)

	sweep(t, store, 1_000)
	sweep(t, store, 2_000)

	rerate(t, store, grace.UserID, 2_000)
	sweep(t, store, 3_000)
	sweep(t, store, 4_000)

	rerate(t, store, ada.UserID, 2_100)
	sweep(t, store, 5_000)
	sweep(t, store, 6_000)

	reigns, err := store.BotReigns(ctx, ada.UserID)
	if err != nil {
		t.Fatalf("read Ada's reigns: %v", err)
	}
	if len(reigns) != 2 {
		t.Fatalf("Ada led twice, so there are two reigns: %#v", reigns)
	}
	// Newest first, which is the order the profile page draws them in.
	if reigns[0].StartedAtUnixMs != 5_000 || !reigns[0].Current {
		t.Fatalf("the newest reign should be the open one: %#v", reigns[0])
	}
	if reigns[1].StartedAtUnixMs != 1_000 || reigns[1].EndedAtUnixMs != 3_000 {
		t.Fatalf("the first reign should be closed and unchanged: %#v", reigns[1])
	}
}

// A mode nobody qualifies on has no leader, and the reign it left behind has to
// close — an open reign is a claim about the present.
func TestAnEmptiedBoardEndsTheReign(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "ada", "Ada")
	ada := claimBotFor(t, store, "ada", "AdaTop", 1900, 30)

	sweep(t, store, 1_000)
	sweep(t, store, 2_000)

	if err := store.SetAccountDisabled(ctx, ada.UserID, true); err != nil {
		t.Fatalf("disable the engine: %v", err)
	}
	changed := sweep(t, store, 3_000)
	if len(changed) != 1 {
		t.Fatalf("losing the last engine is a change: %v", changed)
	}
	if _, ok := currentReign(t, store, totalWar); ok {
		t.Fatal("no engine qualifies, so no reign is running")
	}
	reigns, err := store.BotReigns(ctx, ada.UserID)
	if err != nil {
		t.Fatalf("read reigns: %v", err)
	}
	if len(reigns) != 1 || reigns[0].EndedAtUnixMs != 3_000 || reigns[0].Current {
		t.Fatalf("the reign should be closed at the sweep that found it gone: %#v", reigns)
	}
}

// The ledger and the board have to name the same engine. They are separate
// queries, so this is the test that stops them drifting apart.
func TestTheReignAgreesWithTheBoardItIsReadFrom(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")

	// Ada owns the two best engines. The board collapses that to one row, so
	// the leader is AdaTop and Grace is second — a ledger that skipped the
	// collapse would agree here by luck, which is why the next case exists.
	claimBotFor(t, store, "ada", "AdaTop", 1900, 30)
	claimBotFor(t, store, "ada", "AdaTwo", 1880, 30)
	claimBotFor(t, store, "grace", "GraceOne", 1850, 30)

	// An engine with the highest raw rating that the fit could not place. It
	// sorts last on the board because unranked rows go last, so a ledger that
	// ordered on the number alone would crown it.
	unplaced := claimBotFor(t, store, "grace", "GraceUnplaced", 0, 0)
	seedUnplacedRating(t, store, unplaced.UserID, game.ModeTotalWar, 3_000, 30)

	board, err := store.Leaderboard(ctx, LeaderboardFilter{
		Kind: LeaderboardKindBot, ModeID: totalWar,
	})
	if err != nil {
		t.Fatalf("bot board: %v", err)
	}
	if len(board) == 0 {
		t.Fatal("expected a populated board")
	}

	leaders, err := store.modeBoardLeaders(ctx)
	if err != nil {
		t.Fatalf("mode board leaders: %v", err)
	}
	if leaders[totalWar].UserID != board[0].UserID {
		t.Fatalf(
			"the ledger crowned %q and the board's first row is %q (%s)",
			leaders[totalWar].UserID, board[0].UserID, board[0].Username,
		)
	}
	if board[0].Username != "AdaTop" {
		t.Fatalf("expected AdaTop to lead the board, got %q", board[0].Username)
	}
}

// The board is where "#1 for 24 days" is drawn, so the row in front has to
// carry its reign and the rows behind it must not.
func TestTheBoardCarriesTheLeadersReign(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")
	claimBotFor(t, store, "ada", "AdaTop", 1900, 30)
	grace := claimBotFor(t, store, "grace", "GraceOne", 1800, 30)

	sweep(t, store, 1_000)
	sweep(t, store, 2_000)

	board, err := store.Leaderboard(ctx, LeaderboardFilter{
		Kind: LeaderboardKindBot, ModeID: totalWar,
	})
	if err != nil {
		t.Fatalf("bot board: %v", err)
	}
	if len(board) != 2 {
		t.Fatalf("expected two engines on the board: %#v", board)
	}
	if board[0].LeadingSinceUnixMs != 1_000 || !board[0].HeldTopSeat {
		t.Fatalf("the leader should carry its reign: %#v", board[0])
	}
	if board[1].LeadingSinceUnixMs != 0 || board[1].HeldTopSeat {
		t.Fatalf("an engine that has never led carries nothing: %#v", board[1])
	}

	// Grace takes it, and Ada keeps the mark that says she used to hold it —
	// which is the whole point of recording the past separately from the tag.
	rerate(t, store, grace.UserID, 2_000)
	sweep(t, store, 3_000)
	sweep(t, store, 4_000)

	board, err = store.Leaderboard(ctx, LeaderboardFilter{
		Kind: LeaderboardKindBot, ModeID: totalWar,
	})
	if err != nil {
		t.Fatalf("bot board after the handover: %v", err)
	}
	if board[0].Username != "GraceOne" || board[0].LeadingSinceUnixMs != 3_000 {
		t.Fatalf("Grace should lead since the handover: %#v", board[0])
	}
	if board[1].Username != "AdaTop" {
		t.Fatalf("expected AdaTop behind: %#v", board[1])
	}
	if board[1].LeadingSinceUnixMs != 0 {
		t.Fatalf("a former leader is not leading: %#v", board[1])
	}
	if !board[1].HeldTopSeat {
		t.Fatalf("a former leader still held the seat once: %#v", board[1])
	}
}
