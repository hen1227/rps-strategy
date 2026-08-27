package persistence

import (
	"context"
	"fmt"
	"strings"
)

// The public ladder.
//
// This is deliberately not `SearchAccounts` with a different ORDER BY. That one
// is the administrator's view: it lists everybody, newest first, including the
// accounts an administrator exists to deal with. A leaderboard is the opposite
// kind of list — it is a public claim about who is good at this game — so it
// filters on its own terms and says why in each case below.

// LeaderboardKindHuman and LeaderboardKindBot are the two ladders. They are
// separate boards rather than one mixed board because a bot's rating comes from
// a different set of games: bot-versus-bot series are ranked and bot-versus-human
// is not, so the two numbers are not measuring the same competition.
const (
	LeaderboardKindHuman = "human"
	LeaderboardKindBot   = "bot"
)

const (
	leaderboardDefaultLimit        = 50
	leaderboardMaximumLimit        = 200
	leaderboardDefaultMinimumGames = 1
)

// LeaderboardEntry is one row of the ladder.
//
// A projection, for the same reason AccountSummary is one: a page of fifty rows
// does not want fifty accounts' worth of every mode rating.
type LeaderboardEntry struct {
	// Rank counts from 1 across the whole filtered board, so page two starts at
	// 51 rather than at 1 again.
	Rank     int    `json:"rank"`
	UserID   string `json:"userId"`
	Kind     string `json:"kind"`
	Username string `json:"username"`
	Discord  string `json:"discord"`
	// Title is the tag worn in front of the name, empty for most rows. Carried
	// on the entry so a page of fifty is one query rather than fifty-one.
	Title       string `json:"title,omitempty"`
	Elo         int    `json:"elo"`
	Wins        int    `json:"wins"`
	Losses      int    `json:"losses"`
	Draws       int    `json:"draws"`
	GamesPlayed int    `json:"gamesPlayed"`
	// ModeID names the mode this row's rating belongs to: the requested mode on a
	// mode board, and on the combined board the mode this player is strongest in.
	// Never empty for a listed account, because every rating in this game belongs
	// to some mode.
	ModeID string `json:"modeId,omitempty"`
	// IconSHA256 is a bot's picture, so the bot board can draw the engines it
	// ranks rather than their initials. Always empty on the human board: people
	// have no portrait here. See persistence.Bot.IconSHA256.
	IconSHA256 string `json:"iconSha256,omitempty"`
}

// LeaderboardFilter is a page of one ladder.
type LeaderboardFilter struct {
	// ModeID selects a per-mode ladder. Empty means the combined board, which
	// ranks each account by its strongest mode.
	ModeID string
	// Kind is LeaderboardKindHuman or LeaderboardKindBot; empty means human.
	Kind string
	// MinimumGames keeps accounts that have never finished a game off a board
	// about who wins. Zero takes the default of one.
	MinimumGames int
	Limit        int
	Offset       int
}

func (filter LeaderboardFilter) normalized() LeaderboardFilter {
	filter.ModeID = strings.TrimSpace(filter.ModeID)
	filter.Kind = strings.ToLower(strings.TrimSpace(filter.Kind))
	if filter.Kind != LeaderboardKindBot {
		filter.Kind = LeaderboardKindHuman
	}
	if filter.MinimumGames <= 0 {
		filter.MinimumGames = leaderboardDefaultMinimumGames
	}
	if filter.Limit <= 0 || filter.Limit > leaderboardMaximumLimit {
		filter.Limit = leaderboardDefaultLimit
	}
	if filter.Offset < 0 {
		filter.Offset = 0
	}
	return filter
}

// Leaderboard returns one page of the ladder, best first.
//
// Three exclusions, each for its own reason:
//
//   - Disabled accounts. A ban that leaves someone at the top of the front page
//     is not much of a ban.
//   - Unregistered accounts, but only on the human board. Every browser that
//     has ever loaded the site owns a real, playable account called "Guest", so
//     without this the ladder would mostly be a list of strangers all called
//     the same thing. Bots never have a password, so the rule cannot apply to
//     them.
//   - Accounts below MinimumGames. A rating nobody has tested is a starting
//     value, not an achievement.
func (store *Store) Leaderboard(
	ctx context.Context,
	filter LeaderboardFilter,
) ([]LeaderboardEntry, error) {
	filter = filter.normalized()

	registered := ""
	if filter.Kind == LeaderboardKindHuman {
		registered = " AND " + registeredSQL("a")
	}

	// A correlated subquery rather than a join: the icon is per *account* and
	// both boards below already group by one, so joining would mean saying so
	// twice in two different shapes.
	const iconColumn = `,
       COALESCE((SELECT i.sha256 FROM bot_icons i
                   JOIN bots b ON b.bot_id = i.bot_id
                  WHERE b.user_id = a.user_id), '') AS icon_sha256`

	// Two shapes, because there are two questions.
	//
	// A mode board is the mode's own rating row, joined inner on purpose: being
	// on a mode's ladder means having played that mode, not having inherited the
	// shared seed into it.
	//
	// The combined board cannot use `accounts.elo`, which looks like the obvious
	// column and is not: ranked play moves `account_mode_ratings` and leaves
	// `accounts.elo` as the seed a new mode starts from, so ordering by it would
	// put every player on 1200 for ever. There is no single number for "how good
	// is this player" in a game with per-mode ratings, so the honest summary is
	// their strongest mode — reported with the mode it was set in, so the number
	// says what it means. The counters beside it are lifetime totals, which do
	// move on every game.
	var query string
	arguments := []any{}
	if filter.ModeID != "" {
		query = fmt.Sprintf(`
SELECT a.user_id, a.kind, a.username, a.discord, a.title,
       r.elo AS rating, r.wins, r.losses, r.draws, r.games_played AS played,
       r.mode_id%s
FROM accounts a
JOIN account_mode_ratings r ON r.user_id = a.user_id AND r.mode_id = ?
WHERE a.kind = ? AND a.disabled = 0%s AND r.games_played >= ?
ORDER BY rating DESC, played DESC, a.username ASC
LIMIT ? OFFSET ?
`, iconColumn, registered)
		arguments = append(arguments, filter.ModeID, filter.Kind, filter.MinimumGames)
	} else {
		query = fmt.Sprintf(`
SELECT * FROM (
  SELECT a.user_id, a.kind, a.username, a.discord, a.title,
         (SELECT MAX(r.elo) FROM account_mode_ratings r WHERE r.user_id = a.user_id) AS rating,
         a.wins, a.losses, a.draws, a.games_played AS played,
         (SELECT r.mode_id FROM account_mode_ratings r
           WHERE r.user_id = a.user_id ORDER BY r.elo DESC, r.mode_id LIMIT 1) AS mode_id%s
  FROM accounts a
  WHERE a.kind = ? AND a.disabled = 0%s
)
WHERE rating IS NOT NULL AND played >= ?
ORDER BY rating DESC, played DESC, username ASC
LIMIT ? OFFSET ?
`, iconColumn, registered)
		arguments = append(arguments, filter.Kind, filter.MinimumGames)
	}
	arguments = append(arguments, filter.Limit, filter.Offset)

	rows, err := store.db.QueryContext(ctx, query, arguments...)
	if err != nil {
		return nil, fmt.Errorf("leaderboard: %w", err)
	}
	defer rows.Close()

	entries := make([]LeaderboardEntry, 0, filter.Limit)
	for rows.Next() {
		var entry LeaderboardEntry
		if err := rows.Scan(
			&entry.UserID, &entry.Kind, &entry.Username, &entry.Discord, &entry.Title,
			&entry.Elo, &entry.Wins, &entry.Losses, &entry.Draws, &entry.GamesPlayed,
			&entry.ModeID, &entry.IconSHA256,
		); err != nil {
			return nil, fmt.Errorf("read leaderboard row: %w", err)
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("leaderboard: %w", err)
	}
	for index := range entries {
		entries[index].Rank = filter.Offset + index + 1
	}
	return entries, nil
}
