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
	// DiscordVerified is whether Discord vouched for this account, which is a
	// narrower thing than Registered: that also admits the password accounts
	// still on the books. It is here because it is one of the filters, and a
	// filtered list should show the property it was filtered on.
	DiscordVerified bool `json:"discordVerified"`
	// LastPlayedAtMs is when they last finished a game, and nil for an account
	// that never has — which is the great majority of them. The honest version
	// of "last seen" on a site whose whole purpose is playing, and what makes
	// the activity filters readable rather than mysterious.
	LastPlayedAtMs *int64 `json:"lastPlayedAtUnixMs,omitempty"`
}

// AccountFilter narrows the account browser.
//
// The browser needs this because of a fact about how identity works here: every
// browser that has ever loaded the site owns an account, called Guest, created
// the moment it arrived. They vastly outnumber everybody else, they are
// indistinguishable from one another, and the list used to be ordered
// newest-first — so "search accounts" reliably returned fifty Guests and
// nothing a host was looking for.
//
// Every field is a *widening* zero: an unset filter matches everything, so the
// zero value is the old unfiltered behaviour. That is what lets the caller
// express "registered only" and "any" without a sentinel for each, and the
// tri-state pointers below are the same idea — nil for "do not care", which is
// genuinely different from false.
type AccountFilter struct {
	// Query matches a substring of the username or an exact user id.
	Query string
	// Registered restricts to accounts that can sign in, or to the ones that
	// cannot. Nil for either. This is the one that hides the Guests.
	Registered *bool
	// DiscordLinked restricts to accounts Discord has vouched for. Narrower than
	// Registered, which also admits the remaining password accounts.
	DiscordLinked *bool
	Disabled      *bool
	IsAdmin       *bool
	// Kind is AccountKindHuman or AccountKindBot; empty for both.
	Kind string
	// ActiveSinceUnixMs restricts to accounts that finished a game since an
	// instant. Zero for any.
	//
	// An instant rather than a duration, so the caller decides what "the last
	// hour" means and the same filter can be replayed. See the note in the
	// query about why this is two EXISTS rather than a comparison on the
	// last-played column it sits beside.
	ActiveSinceUnixMs int64
	// MinGames restricts to accounts that have played at least this many. Cheap,
	// indexless, and on its own enough to clear out most of the Guests — which
	// is why it is applied before anything that touches game_history.
	MinGames int
	Sort     AccountSort
	Limit    int
	Offset   int
}

// AccountSort is the order the browser lists accounts in.
type AccountSort string

const (
	// SortAccountsNewest is by signup, newest first. The original behaviour, and
	// the only one that is actively unhelpful when Guests are included.
	SortAccountsNewest AccountSort = "newest"
	// SortAccountsActive is by when they last finished a game, most recent
	// first. Accounts that have never played come last.
	SortAccountsActive AccountSort = "active"
	// SortAccountsRating is strongest first.
	SortAccountsRating AccountSort = "rating"
	// SortAccountsGames is busiest first.
	SortAccountsGames AccountSort = "games"
	// SortAccountsName is alphabetical, for finding somebody whose name you know
	// but cannot spell well enough to search for.
	SortAccountsName AccountSort = "name"
)

// orderClause is the SQL for a sort. Never interpolates anything the caller
// supplied: an unrecognised sort falls back rather than reaching the query.
func (sort AccountSort) orderClause() string {
	switch sort {
	case SortAccountsActive:
		// NULLs last, so the accounts that have never played do not head a list
		// ordered by when people were last here.
		return "last_played_at IS NULL, last_played_at DESC, created_at_unix_ms DESC"
	case SortAccountsRating:
		return "elo DESC, games_played DESC"
	case SortAccountsGames:
		return "games_played DESC, elo DESC"
	case SortAccountsName:
		return "username COLLATE NOCASE ASC"
	default:
		return "created_at_unix_ms DESC"
	}
}

// AccountPage is a page of the browser, plus how many rows the filter matched.
//
// The count is what makes a filter honest: "24 accounts" is a different thing
// to read than "24 of 8,431", and a host who has just hidden the Guests wants
// to see how much was hidden.
type AccountPage struct {
	Accounts []AccountSummary `json:"accounts"`
	Total    int              `json:"total"`
}

// SearchAccounts lists accounts matching a filter.
func (store *Store) SearchAccounts(
	ctx context.Context,
	filter AccountFilter,
) (AccountPage, error) {
	limit := filter.Limit
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	offset := filter.Offset
	if offset < 0 {
		offset = 0
	}

	where, arguments := filter.conditions()
	var page AccountPage
	if err := store.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM accounts a WHERE `+where, arguments...,
	).Scan(&page.Total); err != nil {
		return AccountPage{}, fmt.Errorf("count accounts: %w", err)
	}

	// The last-played column is computed in an inner select so it can be
	// ordered by. It is not *filtered* on there — see conditions() for why the
	// activity filter is a pair of EXISTS instead.
	query := `
SELECT user_id, kind, username, discord, title, registered, is_admin, disabled,
       elo, games_played, created_at_unix_ms, bot_count, discord_verified,
       last_played_at
FROM (
    SELECT a.user_id, a.kind, a.username, a.discord, a.title,
           ` + registeredSQL("a") + ` AS registered,
           a.is_admin, a.disabled,
           COALESCE((SELECT MAX(r.elo) FROM account_mode_ratings r
                      WHERE r.user_id = a.user_id), a.elo) AS elo,
           a.games_played, a.created_at_unix_ms,
           (SELECT COUNT(*) FROM bots b
             WHERE b.owner_user_id = a.user_id AND b.retired_at_unix_ms IS NULL)
             AS bot_count,
           a.discord_user_id <> '' AS discord_verified,
           (SELECT MAX(played) FROM (
               SELECT MAX(g.finished_at_unix_ms) AS played FROM game_history g
                WHERE g.red_player_id = a.user_id
               UNION ALL
               SELECT MAX(g.finished_at_unix_ms) FROM game_history g
                WHERE g.blue_player_id = a.user_id
           )) AS last_played_at
    FROM accounts a
    WHERE ` + where + `
)
ORDER BY ` + filter.Sort.orderClause() + `
LIMIT ? OFFSET ?
`
	rows, err := store.db.QueryContext(ctx, query, append(arguments, limit, offset)...)
	if err != nil {
		return AccountPage{}, fmt.Errorf("search accounts: %w", err)
	}
	defer rows.Close()

	page.Accounts = make([]AccountSummary, 0, limit)
	for rows.Next() {
		var summary AccountSummary
		var lastPlayed sql.NullInt64
		if err := rows.Scan(
			&summary.UserID, &summary.Kind, &summary.Username, &summary.Discord,
			&summary.Title, &summary.Registered, &summary.IsAdmin, &summary.Disabled,
			&summary.Elo, &summary.GamesPlayed, &summary.CreatedAtMs, &summary.BotCount,
			&summary.DiscordVerified, &lastPlayed,
		); err != nil {
			return AccountPage{}, fmt.Errorf("read account row: %w", err)
		}
		if lastPlayed.Valid {
			summary.LastPlayedAtMs = &lastPlayed.Int64
		}
		page.Accounts = append(page.Accounts, summary)
	}
	return page, rows.Err()
}

// conditions builds the WHERE for a filter, and the arguments for it.
//
// One function for the count and the page, because two copies of a filter is
// how a browser ends up reporting a total that does not match the rows under
// it.
func (filter AccountFilter) conditions() (string, []any) {
	clauses := []string{"1 = 1"}
	arguments := make([]any, 0, 8)

	if query := strings.TrimSpace(filter.Query); query != "" {
		pattern := "%" + strings.ToLower(query) + "%"
		clauses = append(clauses, "(LOWER(a.username) LIKE ? OR a.user_id = ?)")
		arguments = append(arguments, pattern, query)
	}
	if filter.Registered != nil {
		if *filter.Registered {
			clauses = append(clauses, registeredSQL("a"))
		} else {
			clauses = append(clauses, "NOT "+registeredSQL("a"))
		}
	}
	if filter.DiscordLinked != nil {
		if *filter.DiscordLinked {
			clauses = append(clauses, "a.discord_user_id <> ''")
		} else {
			clauses = append(clauses, "a.discord_user_id = ''")
		}
	}
	if filter.Disabled != nil {
		clauses = append(clauses, "a.disabled = ?")
		arguments = append(arguments, boolToInt(*filter.Disabled))
	}
	if filter.IsAdmin != nil {
		clauses = append(clauses, "a.is_admin = ?")
		arguments = append(arguments, boolToInt(*filter.IsAdmin))
	}
	if filter.Kind != "" {
		clauses = append(clauses, "a.kind = ?")
		arguments = append(arguments, filter.Kind)
	}
	if filter.MinGames > 0 {
		clauses = append(clauses, "a.games_played >= ?")
		arguments = append(arguments, filter.MinGames)
	}
	if filter.ActiveSinceUnixMs > 0 {
		// Two EXISTS rather than a comparison against the last_played_at column
		// beside it, and rather than one EXISTS with an OR inside. Both of the
		// alternatives lose the indexes: `game_history` is indexed on
		// (red_player_id, finished_at_unix_ms DESC) and on the blue pair, and an
		// OR across two columns cannot use either. This way each half is an
		// index seek, which is what keeps "played in the last hour" cheap on a
		// table of every game ever played.
		clauses = append(clauses, `(
            EXISTS (SELECT 1 FROM game_history g
                     WHERE g.red_player_id = a.user_id
                       AND g.finished_at_unix_ms >= ?)
         OR EXISTS (SELECT 1 FROM game_history g
                     WHERE g.blue_player_id = a.user_id
                       AND g.finished_at_unix_ms >= ?)
        )`)
		arguments = append(arguments, filter.ActiveSinceUnixMs, filter.ActiveSinceUnixMs)
	}
	return strings.Join(clauses, " AND "), arguments
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
