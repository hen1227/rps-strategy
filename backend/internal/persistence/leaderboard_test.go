package persistence

import (
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
)

// seedRecord gives an account a lifetime record and one mode rating to carry it,
// which is the shape ranked games leave behind. The leaderboard reads ratings
// and counts rather than replaying games, so seeding them directly keeps these
// tests about the query.
func seedRecord(t *testing.T, store *Store, userID string, elo int, played int) {
	t.Helper()
	if _, err := store.db.ExecContext(t.Context(), `
UPDATE accounts SET wins = ?, games_played = ? WHERE user_id = ?
`, played, played, userID); err != nil {
		t.Fatalf("seed record for %s: %v", userID, err)
	}
	if played > 0 {
		seedModeRating(t, store, userID, game.ModeTotalWar, elo, played)
	}
}

// seedModeRating writes a settled rating, every one of its games ranked, with a
// strength and deviation that publish as exactly elo.
func seedModeRating(t *testing.T, store *Store, userID string, modeID game.ModeID, elo int, played int) {
	t.Helper()
	seedRatingRow(t, store, userID, modeID, elo, played, played)
}

// seedUnplacedRating is an account that has played a mode without a ranked
// game in it, which leaves a row and no rating.
func seedUnplacedRating(
	t *testing.T, store *Store, userID string, modeID game.ModeID, elo int, played int,
) {
	t.Helper()
	seedRatingRow(t, store, userID, modeID, elo, played, 0)
}

func seedRatingRow(
	t *testing.T,
	store *Store,
	userID string,
	modeID game.ModeID,
	elo int,
	played int,
	rated int,
) {
	t.Helper()
	deviation, ratedAt := ratingStartDeviation, int64(0)
	if rated > 0 {
		deviation, ratedAt = ratingMinimumDeviation, time.Now().UnixMilli()
	}
	if _, err := store.db.ExecContext(t.Context(), `
INSERT INTO account_mode_ratings
    (user_id, mode_id, elo, wins, games_played,
     strength, deviation, volatility, rated_games, last_rated_at_unix_ms,
     created_at_unix_ms, updated_at_unix_ms)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1)
`, userID, modeID, elo, played, played,
		float64(elo)+ratingShownDeviations*deviation, deviation, ratingStartVolatility,
		rated, ratedAt); err != nil {
		t.Fatalf("seed mode rating for %s: %v", userID, err)
	}
}

func usernames(entries []LeaderboardEntry) []string {
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Username)
	}
	return names
}

func TestLeaderboardRanksRegisteredPlayersByElo(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")
	registeredOwner(t, store, "alan", "Alan")
	seedRecord(t, store, "ada", 1500, 12)
	seedRecord(t, store, "grace", 1700, 20)
	seedRecord(t, store, "alan", 1300, 4)

	board, err := store.Leaderboard(ctx, LeaderboardFilter{})
	if err != nil {
		t.Fatalf("leaderboard: %v", err)
	}
	if got := usernames(board); len(got) != 3 || got[0] != "Grace" || got[2] != "Alan" {
		t.Fatalf("expected Grace, Ada, Alan by Elo, got %v", got)
	}
	if board[0].Rank != 1 || board[2].Rank != 3 {
		t.Fatalf("ranks should count from one: %#v", board)
	}
	if board[0].Elo != 1700 || board[0].GamesPlayed != 20 {
		t.Fatalf("row should carry the account's own numbers: %#v", board[0])
	}
	if board[0].ModeID != string(game.ModeTotalWar) {
		t.Fatalf("the combined board must say which mode the rating came from: %#v", board[0])
	}

	// Rank is a position on the whole board, not a position on the page, or
	// page two would restart at one and every row would claim to be the best.
	page, err := store.Leaderboard(ctx, LeaderboardFilter{Limit: 1, Offset: 1})
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	if len(page) != 1 || page[0].Username != "Ada" || page[0].Rank != 2 {
		t.Fatalf("second page should be Ada at rank 2: %#v", page)
	}
}

func TestLeaderboardExcludesGuestsDisabledAccountsAndTheUntested(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "ada", "Ada")
	seedRecord(t, store, "ada", 1400, 6)

	// A rating nobody has tested is a starting value, not an achievement. This
	// account has the highest seed in the table and no games, so if it appears
	// the floor is not working.
	registeredOwner(t, store, "idle", "Idle")
	seedRecord(t, store, "idle", 1900, 0)

	// Every browser that loads the site owns a real, playable "Guest" account.
	// A ladder of strangers all called Guest is not a ladder.
	if _, err := store.EnsureAccountWithProfileKey(ctx, "anon", "Guest", testProfileKey); err != nil {
		t.Fatalf("create anonymous account: %v", err)
	}
	seedRecord(t, store, "anon", 2000, 30)

	registeredOwner(t, store, "banned", "Banned")
	seedRecord(t, store, "banned", 2100, 40)
	if err := store.SetAccountDisabled(ctx, "banned", true); err != nil {
		t.Fatalf("disable: %v", err)
	}

	board, err := store.Leaderboard(ctx, LeaderboardFilter{})
	if err != nil {
		t.Fatalf("leaderboard: %v", err)
	}
	if got := usernames(board); len(got) != 1 || got[0] != "Ada" {
		t.Fatalf("expected only Ada, got %v", got)
	}
}

func TestCombinedBoardRanksByTheStrongestMode(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	// There is no single "how good is this player" number in a game with
	// per-mode ratings, so the combined board ranks each account by its strongest
	// rated mode and says which one it was.
	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")
	seedRecord(t, store, "ada", 1400, 10)
	seedRecord(t, store, "grace", 1300, 10)
	// Ada is decent at two modes; Grace is excellent at one.
	seedModeRating(t, store, "ada", game.ModeInfiltration, 1450, 6)
	seedModeRating(t, store, "grace", game.ModeInfiltration, 1900, 6)

	board, err := store.Leaderboard(ctx, LeaderboardFilter{})
	if err != nil {
		t.Fatalf("leaderboard: %v", err)
	}
	if got := usernames(board); len(got) != 2 || got[0] != "Grace" {
		t.Fatalf("the strongest mode should decide the order, got %v", got)
	}
	if board[0].Elo != 1900 || board[0].ModeID != string(game.ModeInfiltration) {
		t.Fatalf("the row should be the peak, named: %#v", board[0])
	}
	// The counters stay lifetime totals, which do move on every game.
	if board[0].GamesPlayed != 10 {
		t.Fatalf("games played should be the account total: %#v", board[0])
	}
}

func TestLeaderboardPerModeRequiresHavingPlayedThatMode(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")
	// Both play Total War; only Ada plays Infiltration, and Grace is the stronger
	// of the two overall.
	seedRecord(t, store, "ada", 1500, 10)
	seedRecord(t, store, "grace", 1900, 10)
	seedModeRating(t, store, "ada", game.ModeInfiltration, 1610, 7)

	board, err := store.Leaderboard(ctx, LeaderboardFilter{
		ModeID: string(game.ModeInfiltration),
	})
	if err != nil {
		t.Fatalf("leaderboard: %v", err)
	}
	if got := usernames(board); len(got) != 1 || got[0] != "Ada" {
		t.Fatalf("a mode ladder is whoever played that mode, got %v", got)
	}
	if board[0].Elo != 1610 || board[0].GamesPlayed != 7 {
		t.Fatalf("row should carry the mode's numbers, not the account's: %#v", board[0])
	}
	if board[0].ModeID != string(game.ModeInfiltration) {
		t.Fatalf("row should name the mode it describes: %#v", board[0])
	}
}

func TestLeaderboardKeepsBotsOnTheirOwnBoard(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "owner", "Owner")
	seedRecord(t, store, "owner", 1500, 10)

	_, token, err := store.MintBotToken(ctx, "owner")
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	bot, err := store.ClaimBot(ctx, token, BotSettings{Name: "Chomper", AllowPublicPlay: true})
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	seedRecord(t, store, bot.UserID, 1750, 30)

	humans, err := store.Leaderboard(ctx, LeaderboardFilter{})
	if err != nil {
		t.Fatalf("human board: %v", err)
	}
	if got := usernames(humans); len(got) != 1 || got[0] != "Owner" {
		t.Fatalf("a bot must not appear on the human board, got %v", got)
	}

	// A bot has no password, so the registration rule that keeps Guests off the
	// human board cannot be applied to bots without emptying their board.
	bots, err := store.Leaderboard(ctx, LeaderboardFilter{Kind: LeaderboardKindBot})
	if err != nil {
		t.Fatalf("bot board: %v", err)
	}
	if got := usernames(bots); len(got) != 1 || got[0] != "Chomper" {
		t.Fatalf("expected only the bot, got %v", got)
	}
	if bots[0].Kind != AccountKindBot {
		t.Fatalf("row should say what it is: %#v", bots[0])
	}
}

// The bot board names whoever entered the engine, so a row on the ladder says
// who is answering for it without a second request per row. The human board
// leaves both fields empty rather than inventing an owner for a person.
func TestLeaderboardNamesTheOwnerOfABot(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "owner", "Owner")
	seedRecord(t, store, "owner", 1500, 10)

	_, token, err := store.MintBotToken(ctx, "owner")
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	bot, err := store.ClaimBot(ctx, token, BotSettings{Name: "Chomper", AllowPublicPlay: true})
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	if err := store.RecordBotEngineIdentity(ctx, bot.BotID, BotEngineIdentity{
		Name:   "Chomper 2.1",
		Author: "Owner",
	}); err != nil {
		t.Fatalf("engine identity: %v", err)
	}
	seedRecord(t, store, bot.UserID, 1750, 30)

	// Both boards, and both shapes of the query: a mode board and the combined
	// one are two different SELECTs and the columns have to arrive on both.
	for _, filter := range []LeaderboardFilter{
		{Kind: LeaderboardKindBot},
		{Kind: LeaderboardKindBot, ModeID: string(game.ModeTotalWar)},
	} {
		bots, err := store.Leaderboard(ctx, filter)
		if err != nil {
			t.Fatalf("bot board %+v: %v", filter, err)
		}
		if len(bots) != 1 {
			t.Fatalf("bot board %+v: expected one row, got %d", filter, len(bots))
		}
		if bots[0].OwnerUsername != "Owner" {
			t.Fatalf("row should name its owner: %#v", bots[0])
		}
		if bots[0].EngineName != "Chomper 2.1" {
			t.Fatalf("row should name the engine: %#v", bots[0])
		}
	}

	humans, err := store.Leaderboard(ctx, LeaderboardFilter{})
	if err != nil {
		t.Fatalf("human board: %v", err)
	}
	if len(humans) != 1 || humans[0].OwnerUsername != "" || humans[0].EngineName != "" {
		t.Fatalf("a person has no owner and no engine: %#v", humans)
	}
}

// claimBotFor enters an engine under an owner and gives it a record, which is
// three calls every test about the bot board would otherwise repeat.
func claimBotFor(t *testing.T, store *Store, ownerID string, name string, elo int, played int) Bot {
	t.Helper()
	_, token, err := store.MintBotToken(t.Context(), ownerID)
	if err != nil {
		t.Fatalf("mint for %s: %v", ownerID, err)
	}
	bot, err := store.ClaimBot(t.Context(), token, BotSettings{Name: name, AllowPublicPlay: true})
	if err != nil {
		t.Fatalf("claim %s: %v", name, err)
	}
	seedRecord(t, store, bot.UserID, elo, played)
	return bot
}

// One owner, one row.
//
// An owner may hold MaximumBotsPerAccount engines, so without this the whole
// top of the board is one person's five copies of one result.
func TestBotBoardListsOnlyEachOwnersBestEngine(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")

	// Ada enters her whole allowance; Grace enters one engine that is better
	// than four of Ada's five and worse than the fifth. Ungrouped, Grace is
	// rank five behind four rows belonging to one person.
	claimBotFor(t, store, "ada", "AdaTop", 1900, 30)
	claimBotFor(t, store, "ada", "AdaTwo", 1880, 30)
	claimBotFor(t, store, "ada", "AdaThree", 1860, 30)
	claimBotFor(t, store, "ada", "AdaFour", 1840, 30)
	claimBotFor(t, store, "ada", "AdaFive", 1700, 30)
	claimBotFor(t, store, "grace", "GraceOne", 1850, 30)

	// Both shapes: a mode board and the combined one are two different SELECTs,
	// and an owner can only hold one slot on either.
	for _, filter := range []LeaderboardFilter{
		{Kind: LeaderboardKindBot},
		{Kind: LeaderboardKindBot, ModeID: string(game.ModeTotalWar)},
	} {
		board, err := store.Leaderboard(ctx, filter)
		if err != nil {
			t.Fatalf("bot board %+v: %v", filter, err)
		}
		got := usernames(board)
		if len(got) != 2 || got[0] != "AdaTop" || got[1] != "GraceOne" {
			t.Fatalf("bot board %+v: expected AdaTop then GraceOne, got %v", filter, got)
		}
		// Rank counts the board that is left, so the person behind the dropped
		// rows moves up into the place they actually hold.
		if board[0].Rank != 1 || board[1].Rank != 2 {
			t.Fatalf("bot board %+v: ranks should close up: %#v", filter, board)
		}
		// The surviving row is a real engine with its own record, not a total
		// of everything its owner runs.
		if board[0].Elo != 1900 || board[0].GamesPlayed != 30 {
			t.Fatalf("bot board %+v: row should be one engine: %#v", filter, board[0])
		}
	}

	// Paging counts the same board. Filtering a page of fifty after the fact
	// would open page two on a row page one had already shown.
	page, err := store.Leaderboard(ctx, LeaderboardFilter{
		Kind: LeaderboardKindBot, Limit: 1, Offset: 1,
	})
	if err != nil {
		t.Fatalf("second page: %v", err)
	}
	if len(page) != 1 || page[0].Username != "GraceOne" || page[0].Rank != 2 {
		t.Fatalf("second page should be GraceOne at rank 2: %#v", page)
	}
}

// The slot goes to the row that would have led the group anyway, which matters
// when two of an owner's engines are level: something has to break the tie, and
// if nothing does they both survive and the rule quietly does not hold.
func TestBotBoardBreaksATieBetweenOneOwnersEngines(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "ada", "Ada")
	claimBotFor(t, store, "ada", "Zeno", 1700, 20)
	claimBotFor(t, store, "ada", "Atlas", 1700, 20)

	board, err := store.Leaderboard(ctx, LeaderboardFilter{Kind: LeaderboardKindBot})
	if err != nil {
		t.Fatalf("bot board: %v", err)
	}
	if got := usernames(board); len(got) != 1 || got[0] != "Atlas" {
		t.Fatalf("a tie should still leave one row, first by the board's order: %v", got)
	}
}

// An unknown owner is not a shared one. Two engines whose registry rows have
// gone still have accounts and still have ratings, and grouping them together
// would rank them as one person's — the same reading sameOwner takes when it
// decides whether a pair of bots may score against each other.
func TestBotBoardKeepsEnginesWithNoOwnerApart(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "ada", "Ada")
	first := claimBotFor(t, store, "ada", "Orphan", 1800, 12)
	second := claimBotFor(t, store, "ada", "Foundling", 1600, 12)
	for _, bot := range []Bot{first, second} {
		if _, err := store.db.ExecContext(ctx, `
DELETE FROM bots WHERE bot_id = ?
`, bot.BotID); err != nil {
			t.Fatalf("drop registry row for %s: %v", bot.UserID, err)
		}
	}

	board, err := store.Leaderboard(ctx, LeaderboardFilter{Kind: LeaderboardKindBot})
	if err != nil {
		t.Fatalf("bot board: %v", err)
	}
	if got := usernames(board); len(got) != 2 || got[0] != "Orphan" || got[1] != "Foundling" {
		t.Fatalf("ownerless engines each keep their place, got %v", got)
	}
}

// The human board has no owners to group on, so it must list everybody it
// listed before — including the people whose bots the rule above thins out.
func TestHumanBoardIsNotGroupedByOwner(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")
	seedRecord(t, store, "ada", 1500, 10)
	seedRecord(t, store, "grace", 1400, 10)
	claimBotFor(t, store, "ada", "AdaTop", 1900, 30)
	claimBotFor(t, store, "ada", "AdaTwo", 1880, 30)

	for _, filter := range []LeaderboardFilter{
		{},
		{ModeID: string(game.ModeTotalWar)},
	} {
		board, err := store.Leaderboard(ctx, filter)
		if err != nil {
			t.Fatalf("human board %+v: %v", filter, err)
		}
		if got := usernames(board); len(got) != 2 || got[0] != "Ada" || got[1] != "Grace" {
			t.Fatalf("human board %+v: expected Ada then Grace, got %v", filter, got)
		}
	}
}

// An account that has only played casual games has no rating, only the number
// everybody starts on, and the board lists ratings. It used to list these last
// under "Not enough data to rank"; there is nothing to rank them by.
func TestLeaderboardListsOnlyAccountsWithARankedGame(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "casual", "Casual")
	seedRecord(t, store, "ada", 1300, 4)
	if _, err := store.db.ExecContext(ctx,
		"UPDATE accounts SET games_played = 40 WHERE user_id = ?", "casual",
	); err != nil {
		t.Fatalf("seed casual record: %v", err)
	}
	seedUnplacedRating(t, store, "casual", game.ModeTotalWar, RatingStart, 40)

	for _, filter := range []LeaderboardFilter{
		{},
		{ModeID: string(game.ModeTotalWar)},
	} {
		board, err := store.Leaderboard(ctx, filter)
		if err != nil {
			t.Fatalf("leaderboard %+v: %v", filter, err)
		}
		if got := usernames(board); len(got) != 1 || got[0] != "Ada" {
			t.Fatalf("leaderboard %+v: expected only Ada, got %v", filter, got)
		}
		if board[0].State != RatingStateRated {
			t.Fatalf("a settled row reads %q", board[0].State)
		}
	}
}

// A rating whose deviation is still wide says so, so the board can mark the
// number as one that is still climbing towards its owner's strength.
func TestLeaderboardMarksAProvisionalRating(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()

	registeredOwner(t, store, "ada", "Ada")
	seedRecord(t, store, "ada", 1300, 3)
	if _, err := store.db.ExecContext(ctx,
		"UPDATE account_mode_ratings SET deviation = 180 WHERE user_id = ?", "ada",
	); err != nil {
		t.Fatalf("widen deviation: %v", err)
	}

	board, err := store.Leaderboard(ctx, LeaderboardFilter{})
	if err != nil {
		t.Fatalf("leaderboard: %v", err)
	}
	if len(board) != 1 || board[0].State != RatingStateProvisional {
		t.Fatalf("a three-game rating should be provisional: %#v", board)
	}
}
