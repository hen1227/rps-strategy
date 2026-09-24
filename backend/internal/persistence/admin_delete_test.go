package persistence

import (
	"context"
	"errors"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/notation"
)

// playRankedGame records a finished game between two accounts and archives it,
// so a test has a game that exists in every table a delete has to reach.
func playRankedGame(
	t *testing.T,
	store *Store,
	gameID string,
	redID string,
	blueID string,
) game.GameState {
	t.Helper()
	ctx := t.Context()
	played, err := game.NewGame(
		gameID, game.ModeTotalWar,
		game.PlayerProfile{UserID: redID, Username: redID},
		game.PlayerProfile{UserID: blueID, Username: blueID},
	)
	if err != nil {
		t.Fatalf("new game: %v", err)
	}
	state, err := played.Resign(game.Blue)
	if err != nil {
		t.Fatalf("resign: %v", err)
	}
	finishedAt := time.Now()
	if _, err := store.RecordCompletedGame(
		ctx, state, finishedAt.Add(-time.Minute), finishedAt, true,
	); err != nil {
		t.Fatalf("record game: %v", err)
	}
	if _, err := store.ArchiveGame(
		ctx, played.Record(), notation.Metadata{Event: "Ranked"}, "",
	); err != nil {
		t.Fatalf("archive game: %v", err)
	}
	return state
}

func countRows(t *testing.T, store *Store, query string, args ...any) int {
	t.Helper()
	var count int
	if err := store.db.QueryRowContext(context.Background(), query, args...).Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	return count
}

// A deleted game has to leave nothing behind in any of the four places a game
// is written, and it has to hand the rating back — the usual reason to delete
// one is that its result should not stand.
func TestDeleteGameRemovesEveryCopyAndRefundsTheRating(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "winner", "Winner")
	registeredOwner(t, store, "loser", "Loser")
	playRankedGame(t, store, "doomed", "winner", "loser")

	if _, err := store.RecordGameAccuracy(ctx, GameAccuracy{
		GameID: "doomed", Color: game.Red, UserID: "winner",
		Accuracy: 90, MoveCount: 1,
	}); err != nil {
		t.Fatalf("record accuracy: %v", err)
	}

	before, err := store.Account(ctx, "winner")
	if err != nil {
		t.Fatalf("read account: %v", err)
	}
	if before.ModeElo(game.ModeTotalWar) <= RatingFloor || before.Wins != 1 {
		t.Fatalf("the game should have moved the rating first: %#v", before)
	}

	deletion, err := store.DeleteGame(ctx, "doomed", true)
	if err != nil {
		t.Fatalf("delete game: %v", err)
	}
	if !deletion.HistoryDeleted || !deletion.ArchiveDeleted ||
		deletion.ReviewsDeleted != 1 || !deletion.RatingsReverted {
		t.Fatalf("unexpected report: %#v", deletion)
	}

	if count := countRows(t, store,
		`SELECT COUNT(*) FROM game_history WHERE game_id = 'doomed'`); count != 0 {
		t.Fatalf("history row survived: %d", count)
	}
	if _, err := store.ArchivedGame(ctx, "doomed"); !errors.Is(err, ErrGamePGNNotFound) {
		t.Fatalf("archive row survived: %v", err)
	}
	if count := countRows(t, store,
		`SELECT COUNT(*) FROM game_accuracy WHERE game_id = 'doomed'`); count != 0 {
		t.Fatalf("review survived: %d", count)
	}

	for _, userID := range []string{"winner", "loser"} {
		account, err := store.Account(ctx, userID)
		if err != nil {
			t.Fatalf("read %s: %v", userID, err)
		}
		if account.ModeElo(game.ModeTotalWar) != RatingFloor {
			t.Fatalf("%s kept rating from a deleted game: %d",
				userID, account.ModeElo(game.ModeTotalWar))
		}
		if account.GamesPlayed != 0 || account.Wins != 0 || account.Losses != 0 {
			t.Fatalf("%s kept a record from a deleted game: %#v", userID, account)
		}
		rating := account.ModeRatings[game.ModeTotalWar]
		if rating.GamesPlayed != 0 || rating.Wins != 0 || rating.Losses != 0 {
			t.Fatalf("%s kept a mode record from a deleted game: %#v", userID, rating)
		}
	}
}

// Deleting the record without touching the result is the other case: a game
// that was played fairly but should not be on display.
func TestDeleteGameCanLeaveTheRatingAlone(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "winner", "Winner")
	registeredOwner(t, store, "loser", "Loser")
	playRankedGame(t, store, "kept-result", "winner", "loser")

	before, err := store.Account(ctx, "winner")
	if err != nil {
		t.Fatalf("read account: %v", err)
	}
	deletion, err := store.DeleteGame(ctx, "kept-result", false)
	if err != nil {
		t.Fatalf("delete game: %v", err)
	}
	if deletion.RatingsReverted {
		t.Fatal("ratings were reverted when the caller asked not to")
	}
	after, err := store.Account(ctx, "winner")
	if err != nil {
		t.Fatalf("read account: %v", err)
	}
	if after.ModeElo(game.ModeTotalWar) != before.ModeElo(game.ModeTotalWar) ||
		after.Wins != before.Wins {
		t.Fatalf("the rating moved anyway: %#v -> %#v", before, after)
	}
}

// A game interrupted by a restart reaches the archive without ever reaching the
// history, and the host still has to be able to remove it.
func TestDeleteGameHandlesAnArchiveOnlyGameAndAnUnknownID(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "red", "Red")
	registeredOwner(t, store, "blue", "Blue")

	played, err := game.NewGame(
		"unfinished", game.ModeTotalWar,
		game.PlayerProfile{UserID: "red", Username: "Red"},
		game.PlayerProfile{UserID: "blue", Username: "Blue"},
	)
	if err != nil {
		t.Fatalf("new game: %v", err)
	}
	moves := played.LegalMoves()
	if _, err := played.Move(game.FirstToMove, moves[0].From, moves[0].To); err != nil {
		t.Fatalf("play a move: %v", err)
	}
	if _, err := store.ArchiveGame(
		ctx, played.Record(), notation.Metadata{Event: "Interrupted"}, "",
	); err != nil {
		t.Fatalf("archive: %v", err)
	}

	deletion, err := store.DeleteGame(ctx, "unfinished", true)
	if err != nil {
		t.Fatalf("delete archive-only game: %v", err)
	}
	if deletion.HistoryDeleted || !deletion.ArchiveDeleted || deletion.RatingsReverted {
		t.Fatalf("nothing was ever rated, so nothing should be given back: %#v", deletion)
	}
	if _, err := store.DeleteGame(ctx, "never-played", true); !errors.Is(err, ErrGameNotFound) {
		t.Fatalf("unknown game: %v", err)
	}
}

// Purging is the opposite of anonymizing, and the point of it is that the
// opponent is left as if the games never happened.
func TestPurgeAccountTakesItsGamesAndLeavesTheOpponentWhole(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "spammer", "Spammer")
	registeredOwner(t, store, "victim", "Victim")
	playRankedGame(t, store, "game-1", "spammer", "victim")
	playRankedGame(t, store, "game-2", "victim", "spammer")

	purge, err := store.PurgeAccount(ctx, "spammer")
	if err != nil {
		t.Fatalf("purge: %v", err)
	}
	if purge.GamesDeleted != 2 || purge.Username != "Spammer" {
		t.Fatalf("unexpected purge report: %#v", purge)
	}
	if _, err := store.Account(ctx, "spammer"); !errors.Is(err, ErrAccountNotFound) {
		t.Fatalf("the account should be gone: %v", err)
	}
	if count := countRows(t, store, `SELECT COUNT(*) FROM game_history`); count != 0 {
		t.Fatalf("games survived their player: %d", count)
	}
	if count := countRows(t, store, `SELECT COUNT(*) FROM game_pgn`); count != 0 {
		t.Fatalf("archived games survived their player: %d", count)
	}

	victim, err := store.Account(ctx, "victim")
	if err != nil {
		t.Fatalf("the opponent must survive: %v", err)
	}
	if victim.GamesPlayed != 0 || victim.ModeElo(game.ModeTotalWar) != RatingFloor {
		t.Fatalf("the opponent kept a record of games that no longer exist: %#v", victim)
	}
	// And the name the purged account held is free again.
	registeredOwner(t, store, "someone-else", "Spammer")
}

// A bot's rows are spread over four tables and its account is a fifth, so this
// is the delete most likely to trip over a foreign key.
func TestDeleteBotRemovesTheBotItsAccountAndItsGames(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "owner", "Owner")
	registeredOwner(t, store, "human", "Human")

	_, token, err := store.MintBotToken(ctx, "owner")
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	bot, err := store.ClaimBot(ctx, token, BotSettings{Name: "Botty", AllowPublicPlay: true})
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	playRankedGame(t, store, "bot-game", bot.UserID, "human")

	deletion, err := store.DeleteBot(ctx, bot.BotID)
	if err != nil {
		t.Fatalf("delete bot: %v", err)
	}
	if deletion.Name != "Botty" || deletion.GamesDeleted != 1 || !deletion.AccountDeleted {
		t.Fatalf("unexpected report: %#v", deletion)
	}
	if _, err := store.Bot(ctx, bot.BotID); !errors.Is(err, ErrBotNotFound) {
		t.Fatalf("the bot survived: %v", err)
	}
	if _, err := store.Account(ctx, bot.UserID); !errors.Is(err, ErrAccountNotFound) {
		t.Fatalf("the bot's account survived: %v", err)
	}
	human, err := store.Account(ctx, "human")
	if err != nil {
		t.Fatalf("the opponent must survive: %v", err)
	}
	if human.GamesPlayed != 0 || human.ModeElo(game.ModeTotalWar) != RatingFloor {
		t.Fatalf("the opponent kept rating from a deleted bot's game: %#v", human)
	}
	// The slot is free again, which is the difference from retiring.
	if count := countRows(t, store, `SELECT COUNT(*) FROM bots`); count != 0 {
		t.Fatalf("bot row survived: %d", count)
	}
}

// Purging an owner has to take their bots with it: the bot rows cascade from
// the owner, and a cascade that fired first would drop a bot out from under its
// own games.
func TestPurgeAccountTakesItsBotsWithIt(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "owner", "Owner")
	registeredOwner(t, store, "human", "Human")

	_, token, err := store.MintBotToken(ctx, "owner")
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	bot, err := store.ClaimBot(ctx, token, BotSettings{Name: "Botty", AllowPublicPlay: true})
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	playRankedGame(t, store, "bot-game", bot.UserID, "human")

	purge, err := store.PurgeAccount(ctx, "owner")
	if err != nil {
		t.Fatalf("purge: %v", err)
	}
	if purge.BotsDeleted != 1 || purge.GamesDeleted != 1 {
		t.Fatalf("unexpected purge report: %#v", purge)
	}
	if count := countRows(t, store, `SELECT COUNT(*) FROM bots`); count != 0 {
		t.Fatalf("bot row survived its owner: %d", count)
	}
	if _, err := store.Account(ctx, bot.UserID); !errors.Is(err, ErrAccountNotFound) {
		t.Fatalf("the bot's account survived its owner: %v", err)
	}
}

// The same guard the other two destructive account tools carry.
func TestPurgeRefusesTheLastAdministrator(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "boss", "Boss")
	if err := store.SetAccountAdmin(ctx, "boss", true); err != nil {
		t.Fatalf("grant: %v", err)
	}
	if _, err := store.PurgeAccount(ctx, "boss"); !errors.Is(err, ErrLastAdministrator) {
		t.Fatalf("purge the only admin: %v", err)
	}
	if _, err := store.PurgeAccount(ctx, "nobody"); !errors.Is(err, ErrAccountNotFound) {
		t.Fatalf("unknown account: %v", err)
	}
}

func TestSearchGamesFindsByPlayerNameAndGameID(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "ada", "Ada")
	registeredOwner(t, store, "grace", "Grace")
	registeredOwner(t, store, "alan", "Alan")
	playRankedGame(t, store, "ada-grace", "ada", "grace")
	playRankedGame(t, store, "alan-grace", "alan", "grace")

	all, err := store.SearchGames(ctx, "", 50, 0)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(all) != 2 {
		t.Fatalf("expected both games, got %d", len(all))
	}
	byPlayer, err := store.SearchGames(ctx, "ada", 50, 0)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(byPlayer) != 1 || byPlayer[0].GameID != "ada-grace" {
		t.Fatalf("player search: %#v", byPlayer)
	}
	byID, err := store.SearchGames(ctx, "alan-grace", 50, 0)
	if err != nil {
		t.Fatalf("search: %v", err)
	}
	if len(byID) != 1 || byID[0].GameID != "alan-grace" {
		t.Fatalf("game id search: %#v", byID)
	}
}

// Deleting from the account list is the same button whether the row is a
// person or a bot, so the bot case has to mean deleting the bot — not nulling
// its account out from under it and leaving a nameless registered engine.
func TestPurgingABotsAccountDeletesTheBot(t *testing.T) {
	store := authTestStore(t)
	ctx := t.Context()
	registeredOwner(t, store, "owner", "Owner")
	registeredOwner(t, store, "human", "Human")

	_, token, err := store.MintBotToken(ctx, "owner")
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	bot, err := store.ClaimBot(ctx, token, BotSettings{Name: "Botty", AllowPublicPlay: true})
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	playRankedGame(t, store, "bot-game", bot.UserID, "human")

	purge, err := store.PurgeAccount(ctx, bot.UserID)
	if err != nil {
		t.Fatalf("purge the bot's account: %v", err)
	}
	if purge.BotsDeleted != 1 || purge.GamesDeleted != 1 {
		t.Fatalf("unexpected purge report: %#v", purge)
	}
	if count := countRows(t, store, `SELECT COUNT(*) FROM bots`); count != 0 {
		t.Fatalf("the bot row survived its own account: %d", count)
	}
	// The owner is untouched: deleting a bot is not deleting its author.
	if _, err := store.Account(ctx, "owner"); err != nil {
		t.Fatalf("the owner must survive: %v", err)
	}
}
