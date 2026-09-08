package persistence

import (
	"testing"

	"rps-strategy/backend/internal/game"
)

// claimedBot mints a bot for a registered owner and claims it, which is what
// gives it the account its games are filed against.
func claimedBot(t *testing.T, store *Store, owner string, name string) Bot {
	t.Helper()
	_, token, err := store.MintBotToken(t.Context(), owner)
	if err != nil {
		t.Fatalf("mint %s: %v", name, err)
	}
	bot, err := store.ClaimBot(t.Context(), token, BotSettings{Name: name})
	if err != nil {
		t.Fatalf("claim %s: %v", name, err)
	}
	return bot
}

// seedGame files a finished game straight into the history table.
//
// Directly, rather than through RecordCompletedGame, for the reason seedRecord
// gives: BotMatches reads rows rather than replaying games, so building a whole
// finished GameState would put a board engine between the test and the query it
// is about.
func seedGame(
	t *testing.T,
	store *Store,
	gameID string,
	red Account,
	blue Account,
	finishedAt int64,
) {
	t.Helper()
	if _, err := store.db.ExecContext(t.Context(), `
INSERT INTO game_history (
    game_id, mode_id, mode_name,
    red_player_id, red_username, blue_player_id, blue_username,
    winner_player_id, winner_color, outcome, end_reason, ranked,
    red_elo_before, red_elo_after, blue_elo_before, blue_elo_after,
    move_number, initial_time_ms, increment_ms,
    started_at_unix_ms, finished_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Red', 'red_win', 'resignation', 1,
          1200, 1216, 1200, 1184, 30, 60000, 0, ?, ?)
`,
		gameID, game.ModeTotalWar, "Total War",
		red.UserID, red.Username, blue.UserID, blue.Username, red.UserID,
		finishedAt, finishedAt,
	); err != nil {
		t.Fatalf("seed game %s: %v", gameID, err)
	}
}

// account reads back the account a claimed bot plays as.
func account(t *testing.T, store *Store, userID string) Account {
	t.Helper()
	found, err := store.Account(t.Context(), userID)
	if err != nil {
		t.Fatalf("read account %s: %v", userID, err)
	}
	return found
}

func TestBotMatchesExcludesGamesAPersonPlayed(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "owner", "Owner")
	registeredOwner(t, store, "ada", "Ada")

	alpha := claimedBot(t, store, "owner", "Alpha")
	beta := claimedBot(t, store, "owner", "Beta")
	alphaAccount := account(t, store, alpha.UserID)
	betaAccount := account(t, store, beta.UserID)
	ada := account(t, store, "ada")

	seedGame(t, store, "bots", alphaAccount, betaAccount, 2000)
	// A bot's game against a person is a real game and belongs on that bot's own
	// history. It does not belong here: this list exists to say which engine is
	// better than which, and those games are unranked precisely because they
	// cannot answer that.
	seedGame(t, store, "human", alphaAccount, ada, 3000)

	matches, err := store.BotMatches(t.Context(), BotMatchFilter{})
	if err != nil {
		t.Fatalf("bot matches: %v", err)
	}
	if len(matches) != 1 || matches[0].GameID != "bots" {
		t.Fatalf("expected only the bot-versus-bot game, got %#v", matches)
	}
	if matches[0].RedPlayer.Username != "Alpha" || matches[0].BluePlayer.Username != "Beta" {
		t.Fatalf("a match should carry both seats: %#v", matches[0])
	}
}

func TestBotMatchesAreNewestFirstAndNameTheirSeries(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "owner", "Owner")
	alpha := claimedBot(t, store, "owner", "Alpha")
	beta := claimedBot(t, store, "owner", "Beta")
	alphaAccount := account(t, store, alpha.UserID)
	betaAccount := account(t, store, beta.UserID)

	seedGame(t, store, "older", alphaAccount, betaAccount, 1000)
	seedGame(t, store, "newer", betaAccount, alphaAccount, 2000)

	series, err := store.CreateBotSeries(t.Context(), BotSeries{
		SeriesID: "run", ModeID: game.ModeTotalWar,
		FirstBotID: alpha.BotID, SecondBotID: beta.BotID,
		Pairs: 1, OpeningPlies: 4, Seed: 7,
		InitialTimeMs: 60_000, RequestedByUserID: "owner",
	})
	if err != nil {
		t.Fatalf("create series: %v", err)
	}
	if series.RequestedByName != "Owner" {
		t.Fatalf("a run should say who asked for it: %#v", series)
	}
	if err := store.RecordBotSeriesGame(
		t.Context(), "run", 1, 1, false, "newer", "a1-a2",
	); err != nil {
		t.Fatalf("record series game: %v", err)
	}

	matches, err := store.BotMatches(t.Context(), BotMatchFilter{})
	if err != nil {
		t.Fatalf("bot matches: %v", err)
	}
	if len(matches) != 2 || matches[0].GameID != "newer" {
		t.Fatalf("newest game first, got %#v", matches)
	}
	if matches[0].SeriesID != "run" {
		t.Fatalf("a series game should name its run: %#v", matches[0])
	}
	// A game that was not part of a run carries no run, rather than carrying a
	// wrong one from the row beside it.
	if matches[1].SeriesID != "" {
		t.Fatalf("a standalone game has no series: %#v", matches[1])
	}
}

func TestBotMatchesFilterKeepsEveryGameTheNamedBotsPlayed(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "owner", "Owner")
	alpha := claimedBot(t, store, "owner", "Alpha")
	beta := claimedBot(t, store, "owner", "Beta")
	gamma := claimedBot(t, store, "owner", "Gamma")
	alphaAccount := account(t, store, alpha.UserID)
	betaAccount := account(t, store, beta.UserID)
	gammaAccount := account(t, store, gamma.UserID)

	seedGame(t, store, "alpha-beta", alphaAccount, betaAccount, 3000)
	seedGame(t, store, "alpha-gamma", gammaAccount, alphaAccount, 2000)
	seedGame(t, store, "beta-gamma", betaAccount, gammaAccount, 1000)

	// "One of", not "both of": a leading bot's game against a bot outside the
	// board is still one of its games, and dropping it would make the history
	// under a top-eight table quietly incomplete.
	matches, err := store.BotMatches(t.Context(), BotMatchFilter{
		BotUserIDs: []string{alpha.UserID},
	})
	if err != nil {
		t.Fatalf("bot matches: %v", err)
	}
	if len(matches) != 2 {
		t.Fatalf("expected both of Alpha's games, got %#v", matches)
	}
	if matches[0].GameID != "alpha-beta" || matches[1].GameID != "alpha-gamma" {
		t.Fatalf("expected Alpha's games newest first, got %#v", matches)
	}
}

func TestBotMatchesKeepToOneModeWhenAsked(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "owner", "Owner")
	alpha := claimedBot(t, store, "owner", "Alpha")
	beta := claimedBot(t, store, "owner", "Beta")
	alphaAccount := account(t, store, alpha.UserID)
	betaAccount := account(t, store, beta.UserID)

	seedGame(t, store, "total-war", alphaAccount, betaAccount, 2000)
	if _, err := store.db.ExecContext(t.Context(),
		"UPDATE game_history SET mode_id = ?, mode_name = ? WHERE game_id = ?",
		game.ModeInfiltration, "Infiltration", "total-war",
	); err != nil {
		t.Fatalf("retag game: %v", err)
	}
	seedGame(t, store, "infiltration", betaAccount, alphaAccount, 1000)

	// A board of the best Infiltration bots with their Total War games under it
	// would be answering a question nobody asked.
	matches, err := store.BotMatches(t.Context(), BotMatchFilter{
		ModeID: string(game.ModeInfiltration),
	})
	if err != nil {
		t.Fatalf("bot matches: %v", err)
	}
	if len(matches) != 1 || matches[0].GameID != "total-war" {
		t.Fatalf("expected only the Infiltration game, got %#v", matches)
	}
}

func TestBotMatchesPagesAndCapsItsLimit(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "owner", "Owner")
	alpha := claimedBot(t, store, "owner", "Alpha")
	beta := claimedBot(t, store, "owner", "Beta")
	alphaAccount := account(t, store, alpha.UserID)
	betaAccount := account(t, store, beta.UserID)

	for index := range 4 {
		seedGame(t, store, "game-"+string(rune('a'+index)), alphaAccount, betaAccount, int64(index+1))
	}

	page, err := store.BotMatches(t.Context(), BotMatchFilter{Limit: 2, Offset: 1})
	if err != nil {
		t.Fatalf("bot matches: %v", err)
	}
	if len(page) != 2 || page[0].GameID != "game-c" || page[1].GameID != "game-b" {
		t.Fatalf("expected the second and third newest, got %#v", page)
	}

	// An absurd limit takes the default rather than handing out the table.
	filter := BotMatchFilter{Limit: 10_000}.normalized()
	if filter.Limit != botMatchDefaultLimit {
		t.Fatalf("an over-large limit should fall back to the default, got %d", filter.Limit)
	}
}
