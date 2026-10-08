package persistence

import (
	"errors"
	"strings"
	"testing"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/notation"
)

// reclassifyBoard is three rival engines and the anchor, every pair played,
// fitted: a board the ladder actually rates. The first pair's games are rr-1 to
// rr-6, which is seedBotRoundRobin's numbering.
func reclassifyBoard(t *testing.T) (*Store, []Account) {
	t.Helper()
	store := botLadderStore(t)
	first, second, third := threeBots(t, store)
	bots := []Account{first, second, third}
	seedBotRoundRobin(t, store, bots, 6, 5)
	if err := store.RefitBotLadder(t.Context(), game.ModeTotalWar); err != nil {
		t.Fatalf("refit: %v", err)
	}
	return store, bots
}

func ladderOf(t *testing.T, store *Store, bots []Account) []int {
	t.Helper()
	ratings := make([]int, 0, len(bots))
	for _, bot := range bots {
		ratings = append(ratings, botRating(t, store, bot.UserID))
	}
	return ratings
}

func sameInts(one []int, other []int) bool {
	if len(one) != len(other) {
		return false
	}
	for index := range one {
		if one[index] != other[index] {
			return false
		}
	}
	return true
}

// A casual game is one the fit never sees, so moving a pair's games to casual
// has to give exactly the board on which that pair was never ranked — not an
// approximation of it — and moving them back has to give the original.
func TestMovingEngineGamesToCasualRefitsTheLadderExactly(t *testing.T) {
	store, bots := reclassifyBoard(t)
	ctx := t.Context()
	before := ladderOf(t, store, bots)

	// The board the first pair's games would have left had they been casual
	// from the start: the same seeding with that pair missing.
	reference := botLadderStore(t)
	first, second, third := threeBots(t, reference)
	seedAnchor(t, reference, []Account{first, second, third})
	seedMatchup(t, reference, "second-third", second, third, 6, 5)
	seedMatchup(t, reference, "first-third", first, third, 6, 5)
	if err := reference.RefitBotLadder(ctx, game.ModeTotalWar); err != nil {
		t.Fatalf("refit reference: %v", err)
	}
	want := ladderOf(t, reference, []Account{first, second, third})
	if sameInts(want, before) {
		t.Fatalf("the fixture is too weak: dropping a pair moved nothing (%v)", before)
	}

	for index := 1; index <= 6; index++ {
		moved, err := store.SetGameRanked(ctx, "rr-"+string(rune('0'+index)), false)
		if err != nil {
			t.Fatalf("move rr-%d: %v", index, err)
		}
		if moved.Changed != 1 || moved.Ranked || moved.ModeID != game.ModeTotalWar {
			t.Fatalf("unexpected report for rr-%d: %#v", index, moved)
		}
	}
	if got := ladderOf(t, store, bots); !sameInts(got, want) {
		t.Fatalf("casual games left a board of %v, want %v", got, want)
	}

	for index := 1; index <= 6; index++ {
		if _, err := store.SetGameRanked(ctx, "rr-"+string(rune('0'+index)), true); err != nil {
			t.Fatalf("restore rr-%d: %v", index, err)
		}
	}
	if got := ladderOf(t, store, bots); !sameInts(got, before) {
		t.Fatalf("moving the games back left %v, want the original %v", got, before)
	}
}

// Every copy of the flag moves: the history the ladder reads, and the archive's
// column and file, which are what a review, a download and an export read.
func TestMovingAGameRewritesItsArchivedRecord(t *testing.T) {
	store, bots := reclassifyBoard(t)
	ctx := t.Context()
	played, err := game.NewGame(
		"rr-1", game.ModeTotalWar,
		game.PlayerProfile{UserID: bots[0].UserID, Username: bots[0].Username},
		game.PlayerProfile{UserID: bots[1].UserID, Username: bots[1].Username},
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ArchiveGame(
		ctx, played.Record(), notation.Metadata{Event: "Bot Match", Ranked: true}, "",
	); err != nil {
		t.Fatalf("archive: %v", err)
	}

	if _, err := store.SetGameRanked(ctx, "rr-1", false); err != nil {
		t.Fatalf("move: %v", err)
	}
	history, err := store.GameHistory(ctx, bots[0].UserID, 50, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range history {
		if record.GameID == "rr-1" && record.Ranked {
			t.Fatal("the history still says ranked")
		}
	}
	archived, err := store.ArchivedGame(ctx, "rr-1")
	if err != nil {
		t.Fatal(err)
	}
	if archived.Ranked {
		t.Fatal("the archive's column still says ranked")
	}
	if !strings.Contains(archived.PGN, `[Ranked "false"]`) ||
		!strings.Contains(archived.PGN, `[Event "Bot Match"]`) {
		t.Fatalf("the archived file was not rewritten:\n%s", archived.PGN)
	}
}

// A person's rating is a running total, so a game with a person in it is left
// alone — with nothing written, rather than half of it.
func TestAGameWithAPersonInItCannotBeMoved(t *testing.T) {
	store := botLadderStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")
	playRankedGame(t, store, "ada-grace", "ada", "grace")
	engine := account(t, store, rivalBot(t, store, "Engine").UserID)
	seedBotGame(t, store, "ada-engine", account(t, store, "ada"), engine, "red_win")

	for _, gameID := range []string{"ada-grace", "ada-engine"} {
		if _, err := store.SetGameRanked(ctx, gameID, false); !errors.Is(err, ErrReclassifyNotEngineGame) {
			t.Fatalf("moving %s: expected the engine-only refusal, got %v", gameID, err)
		}
	}
	history, err := store.GameHistory(ctx, "ada", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range history {
		if !record.Ranked {
			t.Fatalf("a refused move still changed %s", record.GameID)
		}
	}
	if _, err := store.SetGameRanked(ctx, "no-such-game", true); !errors.Is(err, ErrGameNotFound) {
		t.Fatalf("expected an unknown game to be not found, got %v", err)
	}
}

// Two engines one person registered can be made casual, which is what the fit
// already treats them as, and cannot be made ranked, which would read as
// counting while moving nothing.
func TestOneOwnersEnginesCannotBeMadeRanked(t *testing.T) {
	store := botLadderStore(t)
	ctx := t.Context()
	sibling := rivalBot(t, store, "Sibling")
	mate := stablemate(t, store, sibling, "Mate")
	seedBotGame(t, store, "stable", account(t, store, sibling.UserID),
		account(t, store, mate.UserID), "red_win")

	if _, err := store.SetGameRanked(ctx, "stable", true); !errors.Is(err, ErrReclassifySameOwner) {
		t.Fatalf("expected the same-owner refusal, got %v", err)
	}
	moved, err := store.SetGameRanked(ctx, "stable", false)
	if err != nil {
		t.Fatalf("make casual: %v", err)
	}
	if moved.Changed != 1 {
		t.Fatalf("expected the game to move, got %#v", moved)
	}
	// Asking again for what the record already says moves nothing.
	again, err := store.SetGameRanked(ctx, "stable", false)
	if err != nil || again.Changed != 0 {
		t.Fatalf("a repeat should be a no-op, got %#v, %v", again, err)
	}
}

// seriesOfGames files a run between two engines whose games are rr-1 and rr-2.
func seriesOfGames(t *testing.T, store *Store, first Bot, second Bot, ladder bool) string {
	t.Helper()
	ctx := t.Context()
	seriesID := "series-" + strings.ToLower(first.Name)
	if _, err := store.CreateBotSeries(ctx, BotSeries{
		SeriesID: seriesID, ModeID: game.ModeTotalWar,
		FirstBotID: first.BotID, SecondBotID: second.BotID,
		Pairs: 1, InitialTimeMs: 60_000, Ladder: ladder, Ranked: ladder,
	}); err != nil {
		t.Fatalf("create series: %v", err)
	}
	for number := 1; number <= 2; number++ {
		gameID := "rr-" + string(rune('0'+number))
		if err := store.RecordBotSeriesGame(
			ctx, seriesID, number, 1, number == 2, gameID, "",
		); err != nil {
			t.Fatalf("record series game: %v", err)
		}
		if err := store.FinishBotSeriesGame(
			ctx, seriesID, number, BotSeriesFirstWin, "resignation",
		); err != nil {
			t.Fatalf("finish series game: %v", err)
		}
	}
	if err := store.CloseBotSeries(ctx, seriesID, BotSeriesCompleted); err != nil {
		t.Fatalf("close series: %v", err)
	}
	return seriesID
}

// A run moves as one thing: its own flag, so its card says what it is, and every
// game it filed — including when the two disagreed beforehand, which is the
// shape a run started by hand before the pool existed was left in.
func TestMovingARunMovesItAndEveryGameItFiled(t *testing.T) {
	store := botLadderStore(t)
	ctx := t.Context()
	one, other := rivalBot(t, store, "One"), rivalBot(t, store, "Other")
	// Seeded ranked, under a run that reads casual.
	seedBotGame(t, store, "rr-1", account(t, store, one.UserID), account(t, store, other.UserID), "red_win")
	seedBotGame(t, store, "rr-2", account(t, store, other.UserID), account(t, store, one.UserID), "blue_win")
	seriesID := seriesOfGames(t, store, one, other, false)

	read := func() BotSeries {
		t.Helper()
		series, err := store.BotSeries(ctx, seriesID)
		if err != nil {
			t.Fatal(err)
		}
		return series
	}
	if !read().Casual {
		t.Fatal("the fixture's run should read casual")
	}

	casual, err := store.SetBotSeriesRanked(ctx, seriesID, false)
	if err != nil {
		t.Fatalf("make the run casual: %v", err)
	}
	if casual.Changed != 2 {
		t.Fatalf("both games should have followed the run, got %#v", casual)
	}
	ranked, err := store.SetBotSeriesRanked(ctx, seriesID, true)
	if err != nil {
		t.Fatalf("make the run ranked: %v", err)
	}
	if ranked.Changed != 2 {
		t.Fatalf("both games should have moved back, got %#v", ranked)
	}
	if series := read(); series.Casual || !series.Ranked || series.Ladder {
		t.Fatalf("a run made ranked read as %#v", series)
	}
	history, err := store.GameHistory(ctx, one.UserID, 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range history {
		if !record.Ranked {
			t.Fatalf("game %s did not follow its run", record.GameID)
		}
	}

	if _, err := store.SetBotSeriesRanked(ctx, "no-such-series", true); !errors.Is(err, ErrBotSeriesNotFound) {
		t.Fatalf("expected an unknown run to be not found, got %v", err)
	}
}

func TestARunBetweenOneOwnersEnginesCannotBeMadeRanked(t *testing.T) {
	store := botLadderStore(t)
	ctx := t.Context()
	sibling := rivalBot(t, store, "Sibling")
	mate := stablemate(t, store, sibling, "Mate")
	seedBotGame(t, store, "rr-1", account(t, store, sibling.UserID), account(t, store, mate.UserID), "red_win")
	seedBotGame(t, store, "rr-2", account(t, store, mate.UserID), account(t, store, sibling.UserID), "red_win")
	seriesID := seriesOfGames(t, store, sibling, mate, false)

	if _, err := store.SetBotSeriesRanked(ctx, seriesID, true); !errors.Is(err, ErrReclassifySameOwner) {
		t.Fatalf("expected the same-owner refusal, got %v", err)
	}
	series, err := store.BotSeries(ctx, seriesID)
	if err != nil {
		t.Fatal(err)
	}
	if series.Ranked {
		t.Fatal("a refused run was flagged ranked anyway")
	}
}

// Before the column existed a run counted exactly when the pool arranged it, so
// that is what the column has to say about every run already on file.
func TestTheRankedColumnIsFilledInFromWhoArrangedTheRun(t *testing.T) {
	store := botLadderStore(t)
	ctx := t.Context()
	pooled := rivalBot(t, store, "Pooled")
	byHand := rivalBot(t, store, "ByHand")
	opponent := rivalBot(t, store, "Opponent")
	for _, run := range []struct {
		id     string
		first  Bot
		ladder bool
	}{
		{id: "pool-run", first: pooled, ladder: true},
		{id: "hand-run", first: byHand, ladder: false},
	} {
		// Deliberately the opposite of what the backfill will write, so the
		// assertion below can only pass if the migration wrote it.
		if _, err := store.CreateBotSeries(ctx, BotSeries{
			SeriesID: run.id, ModeID: game.ModeTotalWar,
			FirstBotID: run.first.BotID, SecondBotID: opponent.BotID,
			Pairs: 1, InitialTimeMs: 60_000, Ladder: run.ladder, Ranked: !run.ladder,
		}); err != nil {
			t.Fatalf("create %s: %v", run.id, err)
		}
	}
	if _, err := store.db.ExecContext(ctx, "ALTER TABLE bot_series DROP COLUMN ranked"); err != nil {
		t.Fatalf("take the database back to before the column: %v", err)
	}
	if err := store.ensureBotSeriesSchema(ctx); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	for id, wantRanked := range map[string]bool{"pool-run": true, "hand-run": false} {
		series, err := store.BotSeries(ctx, id)
		if err != nil {
			t.Fatal(err)
		}
		if series.Ranked != wantRanked || series.Casual == wantRanked {
			t.Fatalf("%s read back as ranked=%v casual=%v", id, series.Ranked, series.Casual)
		}
	}
}

// The game browser says which rows can be moved, since that depends on who
// played rather than on anything the row itself carries.
func TestTheGameBrowserSaysWhichGamesAreBetweenEngines(t *testing.T) {
	store := botLadderStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")
	playRankedGame(t, store, "ada-grace", "ada", "grace")
	one, other := rivalBot(t, store, "One"), rivalBot(t, store, "Other")
	seedBotGame(t, store, "engines", account(t, store, one.UserID), account(t, store, other.UserID), "draw")
	seedBotGame(t, store, "mixed", account(t, store, "ada"), account(t, store, one.UserID), "draw")

	games, err := store.SearchGames(ctx, "", 50, 0)
	if err != nil {
		t.Fatal(err)
	}
	want := map[string]bool{"ada-grace": false, "engines": true, "mixed": false}
	if len(games) != len(want) {
		t.Fatalf("expected %d games, got %d", len(want), len(games))
	}
	for _, record := range games {
		if record.EngineGame != want[record.GameID] {
			t.Fatalf("%s: engineGame = %v", record.GameID, record.EngineGame)
		}
	}
}
