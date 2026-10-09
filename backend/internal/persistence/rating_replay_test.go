package persistence

import (
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/notation"
)

// recordGameAt plays one game to a result and records it the way the server
// does, finished at `at`. A draw is agreed; anything else is a resignation by
// the loser.
func recordGameAt(
	t *testing.T,
	store *Store,
	gameID string,
	modeID game.ModeID,
	redID string,
	blueID string,
	winner game.PlayerColor,
	at time.Time,
	ranked bool,
) RatingUpdate {
	t.Helper()
	played, err := game.NewGame(gameID, modeID,
		game.PlayerProfile{UserID: redID, Username: redID},
		game.PlayerProfile{UserID: blueID, Username: blueID},
	)
	if err != nil {
		t.Fatalf("new game %s: %v", gameID, err)
	}
	var state game.GameState
	switch winner {
	case game.Red:
		state, err = played.Resign(game.Blue)
	case game.Blue:
		state, err = played.Resign(game.Red)
	default:
		if _, err = played.OfferDraw(game.FirstToMove); err == nil {
			state, err = played.AcceptDraw(game.OtherColor(game.FirstToMove))
		}
	}
	if err != nil {
		t.Fatalf("finish game %s: %v", gameID, err)
	}
	update, err := store.RecordCompletedGame(t.Context(), state, at.Add(-time.Minute), at, ranked)
	if err != nil {
		t.Fatalf("record game %s: %v", gameID, err)
	}
	return update
}

// gameRows reads the ratings every game row records, by game id.
func gameRows(t *testing.T, store *Store) map[string]gameRatings {
	t.Helper()
	rows, err := store.db.QueryContext(t.Context(), `
SELECT game_id, red_elo_before, red_elo_after, blue_elo_before, blue_elo_after
FROM game_history
`)
	if err != nil {
		t.Fatalf("read game rows: %v", err)
	}
	defer rows.Close()
	recorded := make(map[string]gameRatings)
	for rows.Next() {
		var gameID string
		var row gameRatings
		if err := rows.Scan(&gameID, &row.redBefore, &row.redAfter, &row.blueBefore, &row.blueAfter); err != nil {
			t.Fatalf("read game row: %v", err)
		}
		recorded[gameID] = row
	}
	return recorded
}

// Recording a game and replaying the record are two roads to one answer, and
// this is the property everything retroactive rests on: if they disagreed,
// every start would restate the board.
func TestRecordingGamesAgreesWithReplayingTheRecord(t *testing.T) {
	store := authTestStore(t)
	for _, id := range []string{"ada", "grace", "alan"} {
		registeredOwner(t, store, id, strings.ToUpper(id[:1])+id[1:])
	}
	start := time.Now().Add(-72 * time.Hour)
	players := []string{"ada", "grace", "alan"}
	for index := range 18 {
		red, blue := players[index%3], players[(index+1)%3]
		winner := []game.PlayerColor{game.Red, game.Blue, game.Neutral}[index*7%3]
		modeID := game.ModeTotalWar
		if index%4 == 3 {
			modeID = game.ModeInfiltration
		}
		recordGameAt(t, store, fmt.Sprintf("g-%02d", index), modeID, red, blue, winner,
			start.Add(time.Duration(index)*3*time.Hour), index != 7)
	}

	accounts := []Account{account(t, store, "ada"), account(t, store, "grace"), account(t, store, "alan")}
	ratings := storedRatings(t, store, game.ModeTotalWar, accounts...)
	rows := gameRows(t, store)
	if ratings[0].games == 0 {
		t.Fatal("the fixture rated nothing")
	}

	replay(t, store)
	if got := storedRatings(t, store, game.ModeTotalWar, accounts...); !slices.Equal(got, ratings) {
		t.Fatalf("replaying changed the ratings:\n%v\n%v", ratings, got)
	}
	got := gameRows(t, store)
	for gameID, row := range rows {
		if got[gameID] != row {
			t.Fatalf("replaying restated %s: %+v then %+v", gameID, row, got[gameID])
		}
	}
	// The casual one moved nobody, on either road.
	if row := rows["g-07"]; row.redBefore != row.redAfter || row.blueBefore != row.blueAfter {
		t.Fatalf("a casual game records a change: %+v", row)
	}
}

// The upgrade itself: a database written under the anchored scale, with its
// numbers on every game row and in every archived record, comes out of one
// start on today's ratings throughout.
func TestRebuildingRestatesARecordWrittenUnderAnOlderScale(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")
	ada, grace := account(t, store, "ada"), account(t, store, "grace")
	start := recently()
	seedSeries(t, store, "old", game.ModeTotalWar, ada, grace, 8, 6, start)

	// What the anchored scale left behind: its numbers on the rows, and an
	// archived record that names its scale.
	if _, err := store.db.ExecContext(ctx, `
UPDATE game_history SET red_elo_before = 182, red_elo_after = 186,
                        blue_elo_before = 196, blue_elo_after = 192
`); err != nil {
		t.Fatalf("write the old numbers: %v", err)
	}
	played, err := game.NewGame("old-1", game.ModeTotalWar,
		game.PlayerProfile{UserID: "ada", Username: "Ada"},
		game.PlayerProfile{UserID: "grace", Username: "Grace"},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ArchiveGame(ctx, played.Record(), notation.Metadata{
		Event: "Ranked", Ranked: true,
		RedEloBefore: 182, RedEloAfter: 186, BlueEloBefore: 196, BlueEloAfter: 192,
	}, ""); err != nil {
		t.Fatalf("archive: %v", err)
	}
	for _, statement := range []string{
		`UPDATE game_pgn SET pgn = replace(pgn, '` + notation.RatingSystem + `', 'anchored/1')`,
		`DELETE FROM rating_system`,
	} {
		if _, err := store.db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("age the database: %v", err)
		}
	}

	if err := store.RebuildRatings(ctx); err != nil {
		t.Fatalf("rebuild: %v", err)
	}

	// seedSeries spreads Ada's six wins through the eight, so the first game is
	// one of Grace's two.
	first := gameRow(t, store, "old-1")
	if first.redBefore != RatingStart || first.blueBefore != RatingStart {
		t.Fatalf("the first game should start both players fresh: %+v", first)
	}
	if first.blueAfter <= first.blueBefore || first.redAfter >= first.redBefore {
		t.Fatalf("the first game's result was not applied: %+v", first)
	}
	archived, err := store.ArchivedGame(ctx, "old-1")
	if err != nil {
		t.Fatal(err)
	}
	for _, tag := range []string{
		fmt.Sprintf(`[RedElo "%d"]`, first.redBefore),
		fmt.Sprintf(`[RedEloAfter "%d"]`, first.redAfter),
		fmt.Sprintf(`[BlueEloAfter "%d"]`, first.blueAfter),
		`[RatingSystem "` + notation.RatingSystem + `"]`,
	} {
		if !strings.Contains(archived.PGN, tag) {
			t.Fatalf("the archived record does not carry %s:\n%s", tag, archived.PGN)
		}
	}
	if strings.Contains(archived.PGN, "anchored/1") || strings.Contains(archived.PGN, `"182"`) {
		t.Fatalf("the archived record still carries the old scale:\n%s", archived.PGN)
	}
	if rating := modeRating(t, store, "ada", game.ModeTotalWar); rating.RatedGames != 8 ||
		rating.Elo <= RatingStart {
		t.Fatalf("six wins in eight should leave a rating above the start: %#v", rating)
	}
	var version string
	if err := store.db.QueryRowContext(ctx, "SELECT version FROM rating_system").Scan(&version); err != nil ||
		version != notation.RatingSystem {
		t.Fatalf("the rebuild did not record its system: %q, %v", version, err)
	}
}

// A person's rating used to be undone by subtracting the deleted game's stored
// change, which was exact only for their latest game. A replay is exact for any
// of them: the board reads as though the game had never been played.
func TestDeletingAPersonsGameReplaysTheirRatingExactly(t *testing.T) {
	start := time.Now().Add(-24 * time.Hour)
	results := []struct {
		id     string
		winner game.PlayerColor
	}{
		{"first", game.Red}, {"middle", game.Red}, {"last", game.Blue},
	}
	board := func(skip string) (*Store, []glickoRating) {
		t.Helper()
		store := authTestStore(t)
		registeredOwner(t, store, "ada", "Ada")
		registeredOwner(t, store, "grace", "Grace")
		for index, result := range results {
			if result.id == skip {
				continue
			}
			recordGameAt(t, store, result.id, game.ModeTotalWar, "ada", "grace", result.winner,
				start.Add(time.Duration(index)*time.Hour), true)
		}
		return store, storedRatings(t, store, game.ModeTotalWar,
			account(t, store, "ada"), account(t, store, "grace"))
	}

	store, before := board("")
	reference, want := board("middle")
	if slices.Equal(before, want) {
		t.Fatal("the fixture is too weak: the middle game changed nothing")
	}
	if _, err := store.DeleteGame(t.Context(), "middle", true); err != nil {
		t.Fatalf("delete: %v", err)
	}
	got := storedRatings(t, store, game.ModeTotalWar, account(t, store, "ada"), account(t, store, "grace"))
	if !slices.Equal(got, want) {
		t.Fatalf("deleting the middle game left %v, want %v", got, want)
	}
	// And the game after it records what it did on the corrected board.
	if row, wantRow := gameRow(t, store, "last"), gameRow(t, reference, "last"); row != wantRow {
		t.Fatalf("the last game records %+v, want %+v", row, wantRow)
	}
}

// Two engines one person registered control both sides of their games, so
// those games never move a rating, whatever they were filed as.
func TestOneOwnersEnginesNeverRateEachOther(t *testing.T) {
	store := botLadderStore(t)
	sibling := rivalBot(t, store, "Sibling")
	mate := stablemate(t, store, sibling, "Mate")
	one, other := account(t, store, sibling.UserID), account(t, store, mate.UserID)
	seedSeries(t, store, "stable", game.ModeTotalWar, one, other, 10, 10, recently())
	replay(t, store)

	for _, player := range []Account{one, other} {
		if rating := modeRating(t, store, player.UserID, game.ModeTotalWar); rating.RatedGames != 0 ||
			rating.State != RatingStateUnrated || rating.Elo != RatingStart {
			t.Fatalf("%s was rated by its stablemate: %#v", player.Username, rating)
		}
	}
	if row := gameRow(t, store, "stable-4"); row.redBefore != row.redAfter {
		t.Fatalf("a stablemate game records a change: %+v", row)
	}
}

// A published rating falls while its owner is away, by the deviation growing,
// and the hourly republish is what writes that down.
func TestAnIdleRatingIsRepublishedLower(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "ada", "Ada")
	seedModeRating(t, store, "ada", game.ModeTotalWar, 1700, 300)
	away := time.Now().Add(-90 * 24 * time.Hour).UnixMilli()
	if _, err := store.db.ExecContext(ctx,
		"UPDATE account_mode_ratings SET last_rated_at_unix_ms = ? WHERE user_id = 'ada'", away,
	); err != nil {
		t.Fatalf("send Ada away: %v", err)
	}

	moved, err := store.RepublishRatings(ctx, time.Now().UnixMilli())
	if err != nil {
		t.Fatalf("republish: %v", err)
	}
	if len(moved) != 1 || moved[0] != game.ModeTotalWar {
		t.Fatalf("expected Total War to move, got %v", moved)
	}
	rating := modeRating(t, store, "ada", game.ModeTotalWar)
	if rating.Elo >= 1700 || rating.Elo < 1600 {
		t.Fatalf("three months away should cost a few dozen points, got %d", rating.Elo)
	}
	if rating.Strength != 1745 {
		t.Fatalf("time away moved the strength to %d", rating.Strength)
	}
	if account(t, store, "ada").Elo != rating.Elo {
		t.Fatalf("the headline rating did not follow the mode")
	}
	if again, err := store.RepublishRatings(ctx, time.Now().UnixMilli()); err != nil || len(again) != 0 {
		t.Fatalf("a second republish should find nothing to do, got %v, %v", again, err)
	}
}

// Who led each bot ladder, and when, was decided by the old numbers; the first
// start under a new rating system works it out again from the record. A reign
// the old numbers handed out and the new ones do not is gone.
func TestTheUpgradeRebuildsTheReignLedger(t *testing.T) {
	store := botLadderStore(t)
	ctx := t.Context()
	alpha, bravo, charlie := rival(t, store, "Alpha"), rival(t, store, "Bravo"), rival(t, store, "Charlie")
	early := time.Now().Add(-72 * time.Hour).Truncate(time.Hour)
	later := time.Now().Add(-30 * time.Hour).Truncate(time.Hour)
	seedSeries(t, store, "ab", game.ModeTotalWar, alpha, bravo, 12, 11, early)
	seedSeries(t, store, "ac", game.ModeTotalWar, alpha, charlie, 12, 10, early.Add(time.Hour))
	seedSeries(t, store, "ca", game.ModeTotalWar, charlie, alpha, 30, 28, later)
	seedSeries(t, store, "cb", game.ModeTotalWar, charlie, bravo, 20, 19, later.Add(time.Hour))

	// What the old numbers left: Bravo, which the new ones never put in front.
	for _, statement := range []string{
		`DELETE FROM rating_system`,
		fmt.Sprintf(`INSERT INTO bot_reigns (user_id, mode_id, started_at_unix_ms) VALUES ('%s', '%s', 1)`,
			bravo.UserID, totalWar),
	} {
		if _, err := store.db.ExecContext(ctx, statement); err != nil {
			t.Fatalf("age the ledger: %v", err)
		}
	}
	if err := store.RebuildRatings(ctx); err != nil {
		t.Fatalf("rebuild: %v", err)
	}

	reign, ok := currentReign(t, store, totalWar)
	if !ok || reign.UserID != charlie.UserID {
		t.Fatalf("Charlie should lead now, got %+v", reign)
	}
	if reign.StartedAtUnixMs < later.UnixMilli() {
		t.Fatalf("Charlie's reign starts before Charlie took the lead: %d", reign.StartedAtUnixMs)
	}
	past, err := store.BotReigns(ctx, alpha.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if len(past) != 1 || past[0].Current || past[0].EndedAtUnixMs > reign.StartedAtUnixMs {
		t.Fatalf("Alpha should have led once before Charlie: %+v", past)
	}
	if held, err := store.BotReigns(ctx, bravo.UserID); err != nil || len(held) != 0 {
		t.Fatalf("Bravo kept a reign it never had: %+v, %v", held, err)
	}

	// Only the upgrade rebuilds it. An ordinary start leaves the ledger to the
	// live sweep that writes it.
	if _, err := store.db.ExecContext(ctx, `DELETE FROM bot_reigns`); err != nil {
		t.Fatal(err)
	}
	if err := store.RebuildRatings(ctx); err != nil {
		t.Fatalf("second rebuild: %v", err)
	}
	if _, ok := currentReign(t, store, totalWar); ok {
		t.Fatal("an ordinary start rebuilt the reign ledger")
	}
}
