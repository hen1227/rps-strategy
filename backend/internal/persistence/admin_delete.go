package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"rps-strategy/backend/internal/game"
)

// Hard deletion, for a host who wants a thing gone rather than hidden.
//
// The neighbouring file, account_admin.go, is about anonymization: the person
// disappears and the games stay, because a game is a shared object and one
// player cannot decide the other's history. That is the right default and it
// stays the default.
//
// This file is the other case, the one that default cannot serve. A spam
// account, a bot that flooded the ladder, a game recorded from a bug — the host
// does not want those preserved under a placeholder name, they want them out of
// the database. So everything here removes rows for real, and everything here
// is reachable only from an admin route.
//
// Two rules hold throughout:
//
//   - A deleted game gives its points back. Elo, win counts, and games played
//     are all reversed for both players, so an opponent is not left holding
//     rating from a game that no longer exists. For a human that reversal
//     subtracts the delta the game stored rather than recomputing the ladder,
//     which is exact for the last game played and an approximation for an older
//     one; the alternative is replaying every game since, and a rating system
//     that silently rewrites history behind a delete is worse than one that is
//     slightly off.
//
//     A game between two bots is exact, because the bot ladder is not a running
//     total to unwind. It is a fit over every pair's head-to-head record (see
//     bot_rating.go), so the game is removed and the ladder is solved again,
//     giving the numbers that would have stood had it never been played. The
//     stored delta is ignored in that case — it was never a transfer.
//   - Deletes cascade by hand, not by declaration. Half these tables predate
//     the foreign keys and several references were deliberately left off (see
//     bot_series.requested_by_user_id), so the order below is the schema's real
//     dependency graph and is written out rather than assumed.

// ErrGameNotFound is returned for a game id in neither the history nor the
// archive.
var ErrGameNotFound = errors.New("game not found")

// GameDeletion reports what went with a game.
type GameDeletion struct {
	GameID string `json:"gameId"`
	// HistoryDeleted and ArchiveDeleted are separate because the two tables do
	// not always agree: a game interrupted by a restart is archived without
	// ever reaching the history, and a game whose rating transaction failed is
	// the reverse.
	HistoryDeleted  bool `json:"historyDeleted"`
	ArchiveDeleted  bool `json:"archiveDeleted"`
	ReviewsDeleted  int  `json:"reviewsDeleted"`
	RatingsReverted bool `json:"ratingsReverted"`
}

// AccountPurge reports what a purge removed.
type AccountPurge struct {
	UserID            string `json:"userId"`
	Username          string `json:"username"`
	GamesDeleted      int    `json:"gamesDeleted"`
	BotsDeleted       int    `json:"botsDeleted"`
	TournamentEntries int    `json:"tournamentEntriesDeleted"`
}

// BotDeletion reports what a bot took with it.
type BotDeletion struct {
	BotID          string `json:"botId"`
	Name           string `json:"name"`
	GamesDeleted   int    `json:"gamesDeleted"`
	SeriesDeleted  int    `json:"seriesDeleted"`
	AccountDeleted bool   `json:"accountDeleted"`
}

// DeleteGame removes one game from the history, the archive, and the reviews.
//
// revertRatings decides whether both players get the game's rating effect
// back. It is a parameter rather than always-on for the case that motivated
// it: a game deleted for being unwatchable — a disconnect storm, a duplicate —
// where the result itself was fair and the host is removing the record, not
// the outcome.
func (store *Store) DeleteGame(
	ctx context.Context,
	gameID string,
	revertRatings bool,
) (GameDeletion, error) {
	gameID = strings.TrimSpace(gameID)
	if gameID == "" {
		return GameDeletion{}, ErrGameNotFound
	}
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return GameDeletion{}, fmt.Errorf("delete game: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	deletion, err := deleteGameTx(ctx, transaction, gameID, revertRatings, true)
	if err != nil {
		return GameDeletion{}, err
	}
	if err := transaction.Commit(); err != nil {
		return GameDeletion{}, fmt.Errorf("delete game: commit: %w", err)
	}
	return deletion, nil
}

// gameRatingEffect is what one recorded game did to two ratings, read back so
// it can be undone.
type gameRatingEffect struct {
	modeID  string
	redID   string
	blueID  string
	outcome string
	// redDelta and bluDelta are the per-game Elo transfer to undo. Both are
	// zero for a game between two bots, whose ladder is refitted from the
	// remaining games instead; the win counters below are reversed either way,
	// since those are lifetime totals under both systems.
	redDelta int
	bluDelta int
	bothBots bool
}

// refitLadder is false for a caller removing many games at once, which refits
// the bot ladder itself when it has finished. Rebuilding it between every game
// of a four-hundred-game purge would be the same answer computed four hundred
// times, each pass reading every game that is left.
func deleteGameTx(
	ctx context.Context,
	transaction *sql.Tx,
	gameID string,
	revertRatings bool,
	refitLadder bool,
) (GameDeletion, error) {
	deletion := GameDeletion{GameID: gameID}

	var effect gameRatingEffect
	var redBefore, redAfter, blueBefore, blueAfter int
	err := transaction.QueryRowContext(ctx, `
SELECT mode_id, red_player_id, blue_player_id, outcome,
       red_elo_before, red_elo_after, blue_elo_before, blue_elo_after
FROM game_history WHERE game_id = ?
`, gameID).Scan(
		&effect.modeID, &effect.redID, &effect.blueID, &effect.outcome,
		&redBefore, &redAfter, &blueBefore, &blueAfter,
	)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		// Archive-only game. Still deletable; there is simply nothing to give
		// back, because nothing was ever awarded.
	case err != nil:
		return GameDeletion{}, fmt.Errorf("delete game: read history: %w", err)
	default:
		deletion.HistoryDeleted = true
		effect.bothBots, err = bothBotsTx(ctx, transaction, effect.redID, effect.blueID)
		if err != nil {
			return GameDeletion{}, err
		}
		if !effect.bothBots {
			effect.redDelta = redAfter - redBefore
			effect.bluDelta = blueAfter - blueBefore
		}
	}

	if deletion.HistoryDeleted && revertRatings {
		if err := revertGameRatingsTx(ctx, transaction, effect); err != nil {
			return GameDeletion{}, err
		}
		deletion.RatingsReverted = true
	}

	reviews, err := transaction.ExecContext(ctx,
		`DELETE FROM game_accuracy WHERE game_id = ?`, gameID)
	if err != nil {
		return GameDeletion{}, fmt.Errorf("delete game: reviews: %w", err)
	}
	if affected, _ := reviews.RowsAffected(); affected > 0 {
		deletion.ReviewsDeleted = int(affected)
	}

	// These two point *at* the game rather than owning it, so they lose the
	// link and keep the row: a tournament match still happened, and a series
	// game still counted towards its score.
	for _, statement := range []string{
		`UPDATE bot_series_games SET game_id = NULL WHERE game_id = ?`,
		`UPDATE tournament_matches SET game_id = NULL WHERE game_id = ?`,
	} {
		if _, err := transaction.ExecContext(ctx, statement, gameID); err != nil {
			return GameDeletion{}, fmt.Errorf("delete game: unlink: %w", err)
		}
	}

	archive, err := transaction.ExecContext(ctx, `DELETE FROM game_pgn WHERE game_id = ?`, gameID)
	if err != nil {
		return GameDeletion{}, fmt.Errorf("delete game: archive: %w", err)
	}
	if affected, _ := archive.RowsAffected(); affected > 0 {
		deletion.ArchiveDeleted = true
	}
	if _, err := transaction.ExecContext(
		ctx, `DELETE FROM game_history WHERE game_id = ?`, gameID,
	); err != nil {
		return GameDeletion{}, fmt.Errorf("delete game: history: %w", err)
	}
	// After the row is gone, not before: the fit reads the games that remain.
	//
	// Unconditional on revertRatings, which is the one thing that flag cannot
	// ask for here. It means "remove the record, let the result stand", and a
	// derived rating has no way to honour that: the record *is* the result. The
	// alternative is leaving a ladder that counts a game the database no longer
	// has, until the next bot game quietly refits it away — a lie with a
	// randomly timed correction. The win counters below still follow the flag,
	// since those are a tally of games played and genuinely can be kept.
	if deletion.HistoryDeleted && effect.bothBots && refitLadder {
		if err := refitBotLadderTx(
			ctx, transaction, game.ModeID(effect.modeID), time.Now().UnixMilli(),
		); err != nil {
			return GameDeletion{}, err
		}
	}
	if !deletion.HistoryDeleted && !deletion.ArchiveDeleted {
		return GameDeletion{}, ErrGameNotFound
	}
	return deletion, nil
}

// revertGameRatingsTx subtracts one game's effect from both players.
//
// Every counter is floored at zero. Not because it should ever be needed —
// each of these was incremented by the game being removed — but because the
// columns carry CHECK (x >= 0), and a database that has been through a restore
// or an older bug would otherwise fail the whole delete on an arithmetic
// detail the host cannot do anything about.
func revertGameRatingsTx(
	ctx context.Context,
	transaction *sql.Tx,
	effect gameRatingEffect,
) error {
	now := time.Now().UnixMilli()
	for _, side := range []struct {
		userID string
		delta  int
		wins   int
		losses int
		draws  int
	}{
		{
			userID: effect.redID,
			delta:  effect.redDelta,
			wins:   boolToInt(effect.outcome == "red_win"),
			losses: boolToInt(effect.outcome == "blue_win"),
			draws:  boolToInt(effect.outcome == "draw"),
		},
		{
			userID: effect.blueID,
			delta:  effect.bluDelta,
			wins:   boolToInt(effect.outcome == "blue_win"),
			losses: boolToInt(effect.outcome == "red_win"),
			draws:  boolToInt(effect.outcome == "draw"),
		},
	} {
		if _, err := transaction.ExecContext(ctx, `
UPDATE accounts
SET wins = MAX(wins - ?, 0),
    losses = MAX(losses - ?, 0),
    draws = MAX(draws - ?, 0),
    games_played = MAX(games_played - 1, 0),
    updated_at_unix_ms = ?
WHERE user_id = ?
`, side.wins, side.losses, side.draws, now, side.userID); err != nil {
			return fmt.Errorf("delete game: revert account totals: %w", err)
		}
		// An unranked game stored the same Elo before and after, so this
		// subtracts nothing and needs no special case.
		if _, err := transaction.ExecContext(ctx, `
UPDATE account_mode_ratings
SET elo = MAX(elo - ?, 0),
    wins = MAX(wins - ?, 0),
    losses = MAX(losses - ?, 0),
    draws = MAX(draws - ?, 0),
    games_played = MAX(games_played - 1, 0),
    updated_at_unix_ms = ?
WHERE user_id = ? AND mode_id = ?
`, side.delta, side.wins, side.losses, side.draws, now,
			side.userID, effect.modeID,
		); err != nil {
			return fmt.Errorf("delete game: revert mode rating: %w", err)
		}
	}
	return nil
}

// DeleteBot removes a bot, its games, and the account it played under.
//
// The difference from RetireBot, which is what an owner's own delete button
// calls: retiring takes a bot out of play and frees its name while leaving
// every game it played, because those games are also its opponents' games.
// This does not leave them. It is for the case where the bot's record is the
// problem — a broken engine that lost four hundred games in an afternoon and
// dragged a ladder with it — so the games go and the ratings they moved are
// given back.
func (store *Store) DeleteBot(ctx context.Context, botID string) (BotDeletion, error) {
	botID = strings.TrimSpace(botID)
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return BotDeletion{}, fmt.Errorf("delete bot: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	deletion, err := deleteBotTx(ctx, transaction, botID)
	if err != nil {
		return BotDeletion{}, err
	}
	if err := transaction.Commit(); err != nil {
		return BotDeletion{}, fmt.Errorf("delete bot: commit: %w", err)
	}
	return deletion, nil
}

func deleteBotTx(
	ctx context.Context,
	transaction *sql.Tx,
	botID string,
) (BotDeletion, error) {
	deletion := BotDeletion{BotID: botID}

	var accountID sql.NullString
	var name sql.NullString
	err := transaction.QueryRowContext(ctx, `
SELECT b.user_id, a.username FROM bots b
LEFT JOIN accounts a ON a.user_id = b.user_id
WHERE b.bot_id = ?
`, botID).Scan(&accountID, &name)
	if errors.Is(err, sql.ErrNoRows) {
		return BotDeletion{}, ErrBotNotFound
	}
	if err != nil {
		return BotDeletion{}, fmt.Errorf("delete bot: read bot: %w", err)
	}
	deletion.Name = name.String

	// bot_series references bots(bot_id) with no ON DELETE clause, so the
	// series have to go before the bot they are about. Their games cascade.
	series, err := transaction.ExecContext(ctx, `
DELETE FROM bot_series WHERE first_bot_id = ?1 OR second_bot_id = ?1
`, botID)
	if err != nil {
		return BotDeletion{}, fmt.Errorf("delete bot: series: %w", err)
	}
	if affected, _ := series.RowsAffected(); affected > 0 {
		deletion.SeriesDeleted = int(affected)
	}

	if accountID.Valid && accountID.String != "" {
		purge, err := purgeAccountRowTx(ctx, transaction, accountID.String)
		if err != nil {
			return BotDeletion{}, err
		}
		deletion.GamesDeleted = purge.GamesDeleted
		deletion.AccountDeleted = true
	}
	// The icon cascades from the bot row; the bot row is last so nothing still
	// points at it.
	if _, err := transaction.ExecContext(ctx, `DELETE FROM bots WHERE bot_id = ?`, botID); err != nil {
		return BotDeletion{}, fmt.Errorf("delete bot: %w", err)
	}
	// Every mode, because a bot's games are gone from all of them and the
	// opponents it beat should stop carrying a win over something the database
	// no longer contains. Note that *retiring* a bot does none of this on
	// purpose: its games stay, so a throwaway's losses stay on the record and
	// retiring it cannot launder them.
	if err := refitAllBotLaddersTx(ctx, transaction, time.Now().UnixMilli()); err != nil {
		return BotDeletion{}, err
	}
	return deletion, nil
}

// PurgeAccount deletes an account outright, along with everything that is only
// about it: its games, its reviews, its bots, and its tournament entries.
//
// AnonymizeAccount remains the right answer for somebody exercising a privacy
// request, and the admin screen offers both. This one is for the account that
// should never have existed — the spam registration, the duplicate, the
// abandoned test — where leaving "Deleted player" rows in every opponent's
// history preserves nothing anyone wanted.
//
// It refuses to remove the last administrator, for the same reason disabling
// one does.
func (store *Store) PurgeAccount(ctx context.Context, userID string) (AccountPurge, error) {
	userID = strings.TrimSpace(userID)
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return AccountPurge{}, fmt.Errorf("purge account: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var username string
	var isAdmin int
	if err := transaction.QueryRowContext(ctx,
		`SELECT username, is_admin FROM accounts WHERE user_id = ?`, userID,
	).Scan(&username, &isAdmin); errors.Is(err, sql.ErrNoRows) {
		return AccountPurge{}, ErrAccountNotFound
	} else if err != nil {
		return AccountPurge{}, fmt.Errorf("purge account: read account: %w", err)
	}
	if isAdmin == 1 {
		var remaining int
		if err := transaction.QueryRowContext(ctx, `
SELECT COUNT(*) FROM accounts WHERE is_admin = 1 AND disabled = 0 AND user_id <> ?
`, userID).Scan(&remaining); err != nil {
			return AccountPurge{}, fmt.Errorf("purge account: count admins: %w", err)
		}
		if remaining == 0 {
			return AccountPurge{}, ErrLastAdministrator
		}
	}

	// An account a *bot* plays under is not really an account to delete, it is
	// a bot to delete. Going the other way would leave the bot row behind with
	// its user_id nulled by the cascade: still registered, still holding a
	// token, and now nameless.
	var ownBotID string
	switch err := transaction.QueryRowContext(ctx,
		`SELECT bot_id FROM bots WHERE user_id = ?`, userID,
	).Scan(&ownBotID); {
	case err == nil:
		deletion, err := deleteBotTx(ctx, transaction, ownBotID)
		if err != nil {
			return AccountPurge{}, err
		}
		if err := transaction.Commit(); err != nil {
			return AccountPurge{}, fmt.Errorf("purge account: commit: %w", err)
		}
		return AccountPurge{
			UserID:       userID,
			Username:     username,
			GamesDeleted: deletion.GamesDeleted,
			BotsDeleted:  1,
		}, nil
	case errors.Is(err, sql.ErrNoRows):
		// An ordinary account. Carry on below.
	default:
		return AccountPurge{}, fmt.Errorf("purge account: read bot: %w", err)
	}

	// Bots this account *owns* go first. Their rows reference it with ON
	// DELETE CASCADE, so leaving them to the cascade would take the bot out
	// from under its own series and its own games.
	botIDs, err := ownedBotIDsTx(ctx, transaction, userID)
	if err != nil {
		return AccountPurge{}, err
	}
	purge := AccountPurge{UserID: userID, Username: username}
	for _, botID := range botIDs {
		botDeletion, err := deleteBotTx(ctx, transaction, botID)
		if err != nil {
			return AccountPurge{}, err
		}
		purge.GamesDeleted += botDeletion.GamesDeleted
		purge.BotsDeleted++
	}

	own, err := purgeAccountRowTx(ctx, transaction, userID)
	if err != nil {
		return AccountPurge{}, err
	}
	purge.GamesDeleted += own.GamesDeleted
	purge.TournamentEntries = own.TournamentEntries

	if err := transaction.Commit(); err != nil {
		return AccountPurge{}, fmt.Errorf("purge account: commit: %w", err)
	}
	return purge, nil
}

func ownedBotIDsTx(ctx context.Context, transaction *sql.Tx, ownerUserID string) ([]string, error) {
	rows, err := transaction.QueryContext(ctx,
		`SELECT bot_id FROM bots WHERE owner_user_id = ?`, ownerUserID)
	if err != nil {
		return nil, fmt.Errorf("purge account: read bots: %w", err)
	}
	defer rows.Close()
	var botIDs []string
	for rows.Next() {
		var botID string
		if err := rows.Scan(&botID); err != nil {
			return nil, fmt.Errorf("purge account: read bot: %w", err)
		}
		botIDs = append(botIDs, botID)
	}
	return botIDs, rows.Err()
}

// purgeAccountRowTx deletes one account row and the records that exist only
// because of it. It does not look at bots: the two callers handle those
// differently, and a bot's own account owns none.
func purgeAccountRowTx(
	ctx context.Context,
	transaction *sql.Tx,
	userID string,
) (AccountPurge, error) {
	purge := AccountPurge{UserID: userID}

	gameIDs, err := accountGameIDsTx(ctx, transaction, userID)
	if err != nil {
		return AccountPurge{}, err
	}
	for _, gameID := range gameIDs {
		// Reverting is the point rather than a nicety: an opponent should not
		// keep rating won from a game that is being erased.
		if _, err := deleteGameTx(ctx, transaction, gameID, true, false); err != nil {
			return AccountPurge{}, err
		}
		purge.GamesDeleted++
	}

	// A tournament match points at its two player rows, so the matches go
	// first. Both tables are per-tournament records of an entry, and an entry
	// by an account that no longer exists is not a result anyone can read.
	if _, err := transaction.ExecContext(ctx, `
DELETE FROM tournament_matches
WHERE player1_id IN (SELECT player_id FROM tournament_players WHERE user_id = ?1)
   OR player2_id IN (SELECT player_id FROM tournament_players WHERE user_id = ?1)
`, userID); err != nil {
		return AccountPurge{}, fmt.Errorf("purge account: tournament matches: %w", err)
	}
	entries, err := transaction.ExecContext(ctx,
		`DELETE FROM tournament_players WHERE user_id = ?`, userID)
	if err != nil {
		return AccountPurge{}, fmt.Errorf("purge account: tournament entries: %w", err)
	}
	if affected, _ := entries.RowsAffected(); affected > 0 {
		purge.TournamentEntries = int(affected)
	}

	// game_accuracy is keyed by game, and the loop above cleared the games this
	// account played. This catches reviews it filed on somebody else's game.
	if _, err := transaction.ExecContext(ctx,
		`DELETE FROM game_accuracy WHERE user_id = ?`, userID,
	); err != nil {
		return AccountPurge{}, fmt.Errorf("purge account: reviews: %w", err)
	}
	// Sessions, mode ratings, and push subscriptions all cascade from here.
	if _, err := transaction.ExecContext(ctx,
		`DELETE FROM accounts WHERE user_id = ?`, userID,
	); err != nil {
		return AccountPurge{}, fmt.Errorf("purge account: delete: %w", err)
	}
	return purge, nil
}

func accountGameIDsTx(ctx context.Context, transaction *sql.Tx, userID string) ([]string, error) {
	// Both tables, because they do not always hold the same games and a purge
	// that left the archive copy would leave the name in it too.
	rows, err := transaction.QueryContext(ctx, `
SELECT game_id FROM game_history WHERE red_player_id = ?1 OR blue_player_id = ?1
UNION
SELECT game_id FROM game_pgn WHERE red_player_id = ?1 OR blue_player_id = ?1
`, userID)
	if err != nil {
		return nil, fmt.Errorf("purge account: read games: %w", err)
	}
	defer rows.Close()
	var gameIDs []string
	for rows.Next() {
		var gameID string
		if err := rows.Scan(&gameID); err != nil {
			return nil, fmt.Errorf("purge account: read game: %w", err)
		}
		gameIDs = append(gameIDs, gameID)
	}
	return gameIDs, rows.Err()
}

// SearchGames lists recorded games for the admin browser, newest first.
//
// It reads the history rather than the archive because the history is what the
// screens the host is trying to clean up are built from. An archive-only game —
// one interrupted by a restart — is still deletable by id; it simply has no row
// here to be listed from.
func (store *Store) SearchGames(
	ctx context.Context,
	query string,
	limit int,
	offset int,
) ([]GameRecord, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	query = strings.TrimSpace(query)
	pattern := "%" + strings.ToLower(query) + "%"
	rows, err := store.db.QueryContext(ctx, gameRecordSelect+`
WHERE ? = ''
   OR game_id = ?
   OR red_player_id = ?
   OR blue_player_id = ?
   OR LOWER(red_username) LIKE ?
   OR LOWER(blue_username) LIKE ?
ORDER BY finished_at_unix_ms DESC, game_id DESC
LIMIT ? OFFSET ?
`, query, query, query, query, pattern, pattern, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("search games: %w", err)
	}
	defer rows.Close()

	records := make([]GameRecord, 0, limit)
	for rows.Next() {
		record, err := scanGameRecord(rows)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	return records, rows.Err()
}
