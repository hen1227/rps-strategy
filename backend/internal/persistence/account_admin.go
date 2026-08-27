package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"rps-strategy/backend/internal/notation"
)

// Administration of accounts.
//
// The hard constraint here is that a played game is a shared object. Two
// people were in it, it is in both their histories, and `game_history` holds
// foreign keys to `accounts(user_id)` with no ON DELETE clause and
// `PRAGMA foreign_keys = ON`. So deleting an account that has ever played is
// not something the database will do, and pretending otherwise would only
// produce a confusing error at the worst moment.
//
// What happens instead is anonymization: the person disappears, the games
// stay. That is also what PRIVACY.md already promises — "the bare result with
// your name removed" — so the code and the published policy agree.

// ErrLastAdministrator guards against locking everyone out.
var ErrLastAdministrator = errors.New("refusing to remove the last administrator")

// AccountSummary is one row of the admin account list. It is a projection
// rather than a full Account: the list wants counts and flags, and loading
// every mode rating for a page of fifty accounts is wasted work.
type AccountSummary struct {
	UserID   string `json:"userId"`
	Kind     string `json:"kind"`
	Username string `json:"username"`
	Discord  string `json:"discord"`
	// Title is the tag this account wears, so the list reads the way the
	// account does everywhere else. The collection behind it is not here: the
	// admin browser loads that with the account it expands.
	Title      string `json:"title,omitempty"`
	Registered bool   `json:"registered"`
	IsAdmin    bool   `json:"isAdmin"`
	Disabled   bool   `json:"disabled"`
	// Elo is the strongest of this account's mode ratings, which is the same
	// summary the combined leaderboard publishes and for the same reason:
	// ranked play moves `account_mode_ratings`, and `accounts.elo` is only the
	// seed a new mode starts from, so a list built on that column would show
	// every account — engines included — at DefaultElo for ever.
	Elo         int   `json:"elo"`
	GamesPlayed int   `json:"gamesPlayed"`
	BotCount    int   `json:"botCount"`
	CreatedAtMs int64 `json:"createdAtUnixMs"`
}

// SearchAccounts lists accounts, newest first, optionally filtered by a
// substring of the username or an exact user id.
func (store *Store) SearchAccounts(
	ctx context.Context,
	query string,
	limit int,
	offset int,
) ([]AccountSummary, error) {
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	if offset < 0 {
		offset = 0
	}
	pattern := "%" + strings.ToLower(strings.TrimSpace(query)) + "%"
	rows, err := store.db.QueryContext(ctx, `
SELECT a.user_id, a.kind, a.username, a.discord, a.title, `+registeredSQL("a")+`,
       a.is_admin, a.disabled,
       COALESCE((SELECT MAX(r.elo) FROM account_mode_ratings r
                  WHERE r.user_id = a.user_id), a.elo),
       a.games_played, a.created_at_unix_ms,
       (SELECT COUNT(*) FROM bots b
         WHERE b.owner_user_id = a.user_id AND b.retired_at_unix_ms IS NULL)
FROM accounts a
WHERE ? = '%%' OR LOWER(a.username) LIKE ? OR a.user_id = ?
ORDER BY a.created_at_unix_ms DESC
LIMIT ? OFFSET ?
`, pattern, pattern, strings.TrimSpace(query), limit, offset)
	if err != nil {
		return nil, fmt.Errorf("search accounts: %w", err)
	}
	defer rows.Close()

	summaries := make([]AccountSummary, 0, limit)
	for rows.Next() {
		var summary AccountSummary
		if err := rows.Scan(
			&summary.UserID, &summary.Kind, &summary.Username, &summary.Discord,
			&summary.Title, &summary.Registered, &summary.IsAdmin, &summary.Disabled,
			&summary.Elo, &summary.GamesPlayed, &summary.CreatedAtMs, &summary.BotCount,
		); err != nil {
			return nil, fmt.Errorf("read account row: %w", err)
		}
		summaries = append(summaries, summary)
	}
	return summaries, rows.Err()
}

// SetAccountDisabled switches an account off or back on.
//
// Disabling also drops every session and closes the browser-key door, because
// a ban that only stops the half of the players who registered is not a ban.
func (store *Store) SetAccountDisabled(ctx context.Context, userID string, disabled bool) error {
	userID = strings.TrimSpace(userID)
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("set account disabled: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	if disabled {
		var isAdmin int
		if err := transaction.QueryRowContext(ctx,
			`SELECT is_admin FROM accounts WHERE user_id = ?`, userID,
		).Scan(&isAdmin); errors.Is(err, sql.ErrNoRows) {
			return ErrAccountNotFound
		} else if err != nil {
			return fmt.Errorf("set account disabled: %w", err)
		}
		if isAdmin == 1 {
			var remaining int
			if err := transaction.QueryRowContext(ctx, `
SELECT COUNT(*) FROM accounts WHERE is_admin = 1 AND disabled = 0 AND user_id <> ?
`, userID).Scan(&remaining); err != nil {
				return fmt.Errorf("set account disabled: count admins: %w", err)
			}
			if remaining == 0 {
				return ErrLastAdministrator
			}
		}
	}

	result, err := transaction.ExecContext(ctx, `
UPDATE accounts SET disabled = ?, updated_at_unix_ms = ? WHERE user_id = ?
`, boolToInt(disabled), time.Now().UnixMilli(), userID)
	if err != nil {
		return fmt.Errorf("set account disabled: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return ErrAccountNotFound
	}
	if disabled {
		if _, err := transaction.ExecContext(ctx,
			`DELETE FROM account_sessions WHERE user_id = ?`, userID,
		); err != nil {
			return fmt.Errorf("set account disabled: revoke sessions: %w", err)
		}
	}
	return transaction.Commit()
}

// AnonymizeAccount removes a person from the record while leaving the games.
//
// It hard-deletes only when the account appears nowhere — no history, no
// archived game, no tournament signup — which is the case for an account that
// registered and never played. Otherwise it strips the identity in place and
// rewrites the denormalised names, including the copies inside the stored PGN
// text, and returns how many records it touched.
func (store *Store) AnonymizeAccount(ctx context.Context, userID string) (int, error) {
	userID = strings.TrimSpace(userID)
	const anonymousName = "Deleted player"

	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("anonymize account: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var kind string
	var isAdmin int
	if err := transaction.QueryRowContext(ctx,
		`SELECT kind, is_admin FROM accounts WHERE user_id = ?`, userID,
	).Scan(&kind, &isAdmin); errors.Is(err, sql.ErrNoRows) {
		return 0, ErrAccountNotFound
	} else if err != nil {
		return 0, fmt.Errorf("anonymize account: %w", err)
	}
	if isAdmin == 1 {
		var remaining int
		if err := transaction.QueryRowContext(ctx, `
SELECT COUNT(*) FROM accounts WHERE is_admin = 1 AND disabled = 0 AND user_id <> ?
`, userID).Scan(&remaining); err != nil {
			return 0, fmt.Errorf("anonymize account: count admins: %w", err)
		}
		if remaining == 0 {
			return 0, ErrLastAdministrator
		}
	}
	// Bots reference their owner, and a bot with no owner has nobody to
	// answer for it. Retire them first rather than surfacing a foreign-key
	// error the caller cannot interpret.
	var liveBots int
	if err := transaction.QueryRowContext(ctx, `
SELECT COUNT(*) FROM bots WHERE owner_user_id = ? AND retired_at_unix_ms IS NULL
`, userID).Scan(&liveBots); err != nil {
		return 0, fmt.Errorf("anonymize account: count bots: %w", err)
	}
	if liveBots > 0 {
		return 0, fmt.Errorf("retire this account's %d bot(s) first", liveBots)
	}

	var appearances int
	if err := transaction.QueryRowContext(ctx, `
SELECT (SELECT COUNT(*) FROM game_history WHERE red_player_id = ?1 OR blue_player_id = ?1)
     + (SELECT COUNT(*) FROM game_pgn     WHERE red_player_id = ?1 OR blue_player_id = ?1)
     + (SELECT COUNT(*) FROM tournament_players WHERE user_id = ?1)
`, userID).Scan(&appearances); err != nil {
		return 0, fmt.Errorf("anonymize account: count appearances: %w", err)
	}

	if appearances == 0 {
		// Nothing refers to this account, so it can go entirely. The mode
		// ratings and sessions cascade.
		if _, err := transaction.ExecContext(ctx,
			`DELETE FROM accounts WHERE user_id = ?`, userID,
		); err != nil {
			return 0, fmt.Errorf("anonymize account: delete: %w", err)
		}
		return 0, transaction.Commit()
	}

	now := time.Now().UnixMilli()
	// A fresh, discarded profile key rather than an empty one: an empty hash
	// is the "unclaimed, adopt me" marker, and leaving it would reopen the
	// account to whoever asked next.
	sealed, err := randomToken(32)
	if err != nil {
		return 0, err
	}
	sealedHash, err := hashProfileKey(sealed)
	if err != nil {
		return 0, fmt.Errorf("anonymize account: seal: %w", err)
	}
	if _, err := transaction.ExecContext(ctx, `
UPDATE accounts
SET username = ?, username_lower = '', discord = '', title = '',
    profile_key_hash = ?, password_hash = '', password_salt = '',
    password_algorithm = '', password_iterations = 0,
    discord_user_id = '', discord_linked_at_unix_ms = 0, disabled = 1,
    is_admin = 0, updated_at_unix_ms = ?
WHERE user_id = ?
`, anonymousName, sealedHash, now, userID); err != nil {
		return 0, fmt.Errorf("anonymize account: strip identity: %w", err)
	}
	for _, statement := range []string{
		`DELETE FROM account_sessions WHERE user_id = ?`,
		// Titles go with the name. A "Deleted player" still wearing GM, or
		// still listing a Tournament Champion award, is the person this is
		// supposed to have removed — recognisable to anyone who was there.
		`DELETE FROM account_titles WHERE user_id = ?`,
		`UPDATE game_history SET red_username = '` + anonymousName + `' WHERE red_player_id = ?`,
		`UPDATE game_history SET blue_username = '` + anonymousName + `' WHERE blue_player_id = ?`,
		`UPDATE game_pgn SET red_username = '` + anonymousName + `' WHERE red_player_id = ?`,
		`UPDATE game_pgn SET blue_username = '` + anonymousName + `' WHERE blue_player_id = ?`,
		`UPDATE tournament_players SET ign = '` + anonymousName + `', discord = 'redacted' WHERE user_id = ?`,
	} {
		if _, err := transaction.ExecContext(ctx, statement, userID); err != nil {
			return 0, fmt.Errorf("anonymize account: %w", err)
		}
	}

	// The name also sits inside the PGN text itself, which is the copy the
	// policy is actually about: an exported archive would otherwise still
	// carry it.
	rows, err := transaction.QueryContext(ctx, `
SELECT game_id, pgn FROM game_pgn WHERE red_player_id = ?1 OR blue_player_id = ?1
`, userID)
	if err != nil {
		return 0, fmt.Errorf("anonymize account: read records: %w", err)
	}
	rewrites := make(map[string]string)
	for rows.Next() {
		var gameID, pgn string
		if err := rows.Scan(&gameID, &pgn); err != nil {
			rows.Close()
			return 0, fmt.Errorf("anonymize account: read record: %w", err)
		}
		rewrites[gameID] = notation.RenameParticipant(pgn, userID, anonymousName)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()
	for gameID, pgn := range rewrites {
		if _, err := transaction.ExecContext(ctx,
			`UPDATE game_pgn SET pgn = ? WHERE game_id = ?`, pgn, gameID,
		); err != nil {
			return 0, fmt.Errorf("anonymize account: rewrite record: %w", err)
		}
	}
	return len(rewrites), transaction.Commit()
}
