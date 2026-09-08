package persistence

import (
	"context"
	"fmt"
	"time"

	"rps-strategy/backend/internal/game"
)

// The numbers behind the admin screen's overview.
//
// The brief was "some basic analytics", and the word doing the work there is
// basic. What a host of a game server actually wants to know, in order, is: is
// anybody here, are they playing, and is anything broken. Everything below
// answers one of those three, and nothing below is a metric that exists because
// it was easy to compute.
//
// Two constraints shaped this:
//
//   - **One query per figure, over one SQLite connection.** The whole payload is
//     assembled with a handful of aggregates against `game_history` and
//     `accounts`, on the same connection the game loop uses. So the queries are
//     indexed ones over `finished_at_unix_ms` and nothing scans a table twice.
//   - **No time series longer than it is useful.** The daily counts go back
//     thirty days, which is the window in which a host is deciding whether
//     something they changed helped. A year of daily buckets is a chart nobody
//     reads and a payload nobody needs.
//
// What is deliberately *not* here: anything per-person beyond the leaderboard
// the site already publishes. This is a health dashboard, not a surveillance
// tool, and a host wanting to know about one player has the account browser.

// AdminAnalytics is the whole overview payload.
type AdminAnalytics struct {
	// GeneratedAtUnixMs is when this was computed, so a screen holding it can
	// say how stale it is rather than implying it is live.
	GeneratedAtUnixMs int64 `json:"generatedAtUnixMs"`

	Accounts AccountTotals `json:"accounts"`
	Games    GameTotals    `json:"games"`
	// ByMode is where the play actually is, which is the figure that decides
	// whether a mode is worth keeping in the catalogue.
	ByMode []ModeActivity `json:"byMode"`
	// Daily is the last thirty days, oldest first, with no gaps: a day nobody
	// played is present with zeroes rather than missing, because a chart that
	// skips empty days draws a busy week and a quiet week the same width.
	Daily []DailyActivity `json:"daily"`
	// Tournaments is the state of the events board.
	Tournaments TournamentTotals `json:"tournaments"`
	// Moderation is how many sanctions are in force, which is the number that
	// should be small and is worth noticing when it is not.
	Moderation ModerationTotals `json:"moderation"`
}

// AccountTotals counts who has an account here.
type AccountTotals struct {
	Total int `json:"total"`
	// Registered is accounts that can sign in — a linked Discord, or one of the
	// remaining password accounts. See registeredSQL.
	Registered int `json:"registered"`
	// DiscordLinked is the subset Discord has vouched for, which is the number
	// that matters for anything ranked and is the population with a profile
	// page. See PublicProfile.
	DiscordLinked int `json:"discordLinked"`
	Bots          int `json:"bots"`
	Disabled      int `json:"disabled"`
	Admins        int `json:"admins"`
	// NewLast7Days and NewLast30Days are arrivals, which is the only growth
	// figure a server this size needs.
	NewLast7Days  int `json:"newLast7Days"`
	NewLast30Days int `json:"newLast30Days"`
	// ActiveLast7Days is accounts that finished a game in the last week —
	// the honest denominator for everything else, since a registration that
	// never played is not a player.
	ActiveLast7Days int `json:"activeLast7Days"`
}

// GameTotals counts what has been played.
type GameTotals struct {
	Total  int `json:"total"`
	Ranked int `json:"ranked"`
	Last24 int `json:"last24Hours"`
	Last7  int `json:"last7Days"`
	Last30 int `json:"last30Days"`
	// Draws, and decisive games by colour. The colour split is the one number
	// here that is about the game rather than the server: a first-move
	// advantage shows up as a persistent gap, and this is where it would be
	// visible.
	Draws    int `json:"draws"`
	RedWins  int `json:"redWins"`
	BlueWins int `json:"blueWins"`
	// MedianMoves and MedianSeconds describe a typical game. Medians rather
	// than means because both distributions have a long tail — one abandoned
	// four-hour game moves a mean and does not move a median.
	MedianMoves   int `json:"medianMoves"`
	MedianSeconds int `json:"medianSeconds"`
}

// ModeActivity is one mode's share of the play.
type ModeActivity struct {
	ModeID   game.ModeID `json:"modeId"`
	ModeName string      `json:"modeName"`
	Games    int         `json:"games"`
	Last7    int         `json:"last7Days"`
	Ranked   int         `json:"ranked"`
	Players  int         `json:"players"`
}

// DailyActivity is one day's play.
type DailyActivity struct {
	// DayUnixMs is midnight UTC at the start of the day. UTC rather than local
	// because the server has no opinion about where its players are, and a
	// bucket boundary that moves with a timezone is a bucket that double-counts
	// twice a year.
	DayUnixMs int64 `json:"dayUnixMs"`
	Games     int   `json:"games"`
	Ranked    int   `json:"ranked"`
	// Players is distinct accounts that finished a game that day.
	Players int `json:"players"`
}

// TournamentTotals is the events board at a glance.
type TournamentTotals struct {
	Drafts       int `json:"drafts"`
	Registration int `json:"registration"`
	InProgress   int `json:"inProgress"`
	Completed    int `json:"completed"`
	Cancelled    int `json:"cancelled"`
	// Entrants is signups across every event that has not finished, which is
	// the number a host is watching in the days before one starts.
	Entrants int `json:"entrants"`
}

// ModerationTotals is how many sanctions are in force right now.
type ModerationTotals struct {
	Muted            int `json:"muted"`
	RankedBanned     int `json:"rankedBanned"`
	TournamentBanned int `json:"tournamentBanned"`
}

// Analytics computes the overview.
func (store *Store) Analytics(ctx context.Context) (AdminAnalytics, error) {
	now := time.Now()
	analytics := AdminAnalytics{GeneratedAtUnixMs: now.UnixMilli()}

	day := now.Add(-24 * time.Hour).UnixMilli()
	week := now.Add(-7 * 24 * time.Hour).UnixMilli()
	month := now.Add(-30 * 24 * time.Hour).UnixMilli()

	if err := store.db.QueryRowContext(ctx, `
SELECT COUNT(*),
       COALESCE(SUM(CASE WHEN `+registeredSQL("")+` THEN 1 ELSE 0 END), 0),
       COALESCE(SUM(CASE WHEN discord_user_id <> '' THEN 1 ELSE 0 END), 0),
       COALESCE(SUM(CASE WHEN kind = ? THEN 1 ELSE 0 END), 0),
       COALESCE(SUM(CASE WHEN disabled = 1 THEN 1 ELSE 0 END), 0),
       COALESCE(SUM(CASE WHEN is_admin = 1 THEN 1 ELSE 0 END), 0),
       COALESCE(SUM(CASE WHEN created_at_unix_ms >= ? THEN 1 ELSE 0 END), 0),
       COALESCE(SUM(CASE WHEN created_at_unix_ms >= ? THEN 1 ELSE 0 END), 0)
FROM accounts
`, AccountKindBot, week, month).Scan(
		&analytics.Accounts.Total,
		&analytics.Accounts.Registered,
		&analytics.Accounts.DiscordLinked,
		&analytics.Accounts.Bots,
		&analytics.Accounts.Disabled,
		&analytics.Accounts.Admins,
		&analytics.Accounts.NewLast7Days,
		&analytics.Accounts.NewLast30Days,
	); err != nil {
		return analytics, fmt.Errorf("analytics: accounts: %w", err)
	}

	// Distinct accounts on either side of a game in the last week. A union of
	// the two seats rather than an OR over one column, so both indexes on
	// `game_history` are usable.
	if err := store.db.QueryRowContext(ctx, `
SELECT COUNT(*) FROM (
    SELECT red_player_id AS id FROM game_history WHERE finished_at_unix_ms >= ?
    UNION
    SELECT blue_player_id AS id FROM game_history WHERE finished_at_unix_ms >= ?
)
`, week, week).Scan(&analytics.Accounts.ActiveLast7Days); err != nil {
		return analytics, fmt.Errorf("analytics: active accounts: %w", err)
	}

	if err := store.db.QueryRowContext(ctx, `
SELECT COUNT(*),
       COALESCE(SUM(ranked), 0),
       COALESCE(SUM(CASE WHEN finished_at_unix_ms >= ? THEN 1 ELSE 0 END), 0),
       COALESCE(SUM(CASE WHEN finished_at_unix_ms >= ? THEN 1 ELSE 0 END), 0),
       COALESCE(SUM(CASE WHEN finished_at_unix_ms >= ? THEN 1 ELSE 0 END), 0),
       COALESCE(SUM(CASE WHEN outcome = 'draw' THEN 1 ELSE 0 END), 0),
       COALESCE(SUM(CASE WHEN outcome = 'red_win' THEN 1 ELSE 0 END), 0),
       COALESCE(SUM(CASE WHEN outcome = 'blue_win' THEN 1 ELSE 0 END), 0)
FROM game_history
`, day, week, month).Scan(
		&analytics.Games.Total,
		&analytics.Games.Ranked,
		&analytics.Games.Last24,
		&analytics.Games.Last7,
		&analytics.Games.Last30,
		&analytics.Games.Draws,
		&analytics.Games.RedWins,
		&analytics.Games.BlueWins,
	); err != nil {
		return analytics, fmt.Errorf("analytics: games: %w", err)
	}

	// The medians, over the last thirty days rather than all time: "how long is
	// a game here" is a question about the game as it is played now, and a
	// median over three months of a mode that has since been retired is not an
	// answer to it.
	if analytics.Games.Last30 > 0 {
		moves, seconds, err := store.medianGameShape(ctx, month, analytics.Games.Last30)
		if err != nil {
			return analytics, err
		}
		analytics.Games.MedianMoves = moves
		analytics.Games.MedianSeconds = seconds
	}

	byMode, err := store.modeActivity(ctx, week)
	if err != nil {
		return analytics, err
	}
	analytics.ByMode = byMode

	daily, err := store.dailyActivity(ctx, now, 30)
	if err != nil {
		return analytics, err
	}
	analytics.Daily = daily

	if err := store.db.QueryRowContext(ctx, `
SELECT
    COALESCE(SUM(CASE WHEN cancelled_at_unix_ms IS NULL AND status = 'registration'
                       AND published_at_unix_ms IS NULL THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN cancelled_at_unix_ms IS NULL AND status = 'registration'
                       AND published_at_unix_ms IS NOT NULL THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN cancelled_at_unix_ms IS NULL AND status = 'in_progress'
                      THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN cancelled_at_unix_ms IS NULL AND status = 'completed'
                      THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN cancelled_at_unix_ms IS NOT NULL THEN 1 ELSE 0 END), 0)
FROM tournaments
`).Scan(
		&analytics.Tournaments.Drafts,
		&analytics.Tournaments.Registration,
		&analytics.Tournaments.InProgress,
		&analytics.Tournaments.Completed,
		&analytics.Tournaments.Cancelled,
	); err != nil {
		return analytics, fmt.Errorf("analytics: tournaments: %w", err)
	}
	if err := store.db.QueryRowContext(ctx, `
SELECT COUNT(*)
FROM tournament_players p
JOIN tournaments t ON t.tournament_id = p.tournament_id
WHERE t.cancelled_at_unix_ms IS NULL AND t.status <> 'completed'
`).Scan(&analytics.Tournaments.Entrants); err != nil {
		return analytics, fmt.Errorf("analytics: tournament entrants: %w", err)
	}

	// In force, not on record: an expired mute is not a moderation problem, and
	// counting it would make the figure only ever grow.
	if err := store.db.QueryRowContext(ctx, `
SELECT
    COALESCE(SUM(CASE WHEN kind = 'mute' THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN kind = 'ranked' THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN kind = 'tournament' THEN 1 ELSE 0 END), 0)
FROM account_restrictions
WHERE expires_at_unix_ms IS NULL OR expires_at_unix_ms > ?
`, now.UnixMilli()).Scan(
		&analytics.Moderation.Muted,
		&analytics.Moderation.RankedBanned,
		&analytics.Moderation.TournamentBanned,
	); err != nil {
		return analytics, fmt.Errorf("analytics: moderation: %w", err)
	}

	return analytics, nil
}

// medianGameShape is the middle game's move count and duration.
//
// Two OFFSET queries rather than a window function, because the median of an
// even-sized set is not needed to that precision and `LIMIT 1 OFFSET n/2` is
// exact enough for a dashboard and works on every SQLite build.
func (store *Store) medianGameShape(
	ctx context.Context,
	since int64,
	count int,
) (int, int, error) {
	middle := count / 2
	var moves int
	if err := store.db.QueryRowContext(ctx, `
SELECT move_number FROM game_history
WHERE finished_at_unix_ms >= ?
ORDER BY move_number
LIMIT 1 OFFSET ?
`, since, middle).Scan(&moves); err != nil {
		return 0, 0, fmt.Errorf("analytics: median moves: %w", err)
	}
	var milliseconds int64
	if err := store.db.QueryRowContext(ctx, `
SELECT finished_at_unix_ms - started_at_unix_ms FROM game_history
WHERE finished_at_unix_ms >= ?
ORDER BY finished_at_unix_ms - started_at_unix_ms
LIMIT 1 OFFSET ?
`, since, middle).Scan(&milliseconds); err != nil {
		return 0, 0, fmt.Errorf("analytics: median duration: %w", err)
	}
	if milliseconds < 0 {
		milliseconds = 0
	}
	return moves, int(milliseconds / 1000), nil
}

// modeActivity is the play, split by mode.
func (store *Store) modeActivity(ctx context.Context, week int64) ([]ModeActivity, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT mode_id,
       MAX(mode_name),
       COUNT(*),
       COALESCE(SUM(CASE WHEN finished_at_unix_ms >= ? THEN 1 ELSE 0 END), 0),
       COALESCE(SUM(ranked), 0)
FROM game_history
GROUP BY mode_id
ORDER BY COUNT(*) DESC
`, week)
	if err != nil {
		return nil, fmt.Errorf("analytics: modes: %w", err)
	}
	defer rows.Close()
	activity := make([]ModeActivity, 0)
	for rows.Next() {
		var mode ModeActivity
		if err := rows.Scan(
			&mode.ModeID, &mode.ModeName, &mode.Games, &mode.Last7, &mode.Ranked,
		); err != nil {
			return nil, fmt.Errorf("analytics: mode row: %w", err)
		}
		activity = append(activity, mode)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("analytics: modes: %w", err)
	}
	// The distinct-player count per mode is a second pass rather than a
	// correlated subquery in the aggregate above, which would run the union
	// once per mode inside the group-by.
	for index := range activity {
		if err := store.db.QueryRowContext(ctx, `
SELECT COUNT(*) FROM (
    SELECT red_player_id AS id FROM game_history WHERE mode_id = ?
    UNION
    SELECT blue_player_id AS id FROM game_history WHERE mode_id = ?
)
`, activity[index].ModeID, activity[index].ModeID).Scan(&activity[index].Players); err != nil {
			return nil, fmt.Errorf("analytics: mode players: %w", err)
		}
	}
	return activity, nil
}

// dailyActivity is the last `days` days of play, oldest first and gap-free.
//
// The buckets are built in Go and filled from one grouped query, rather than
// generated in SQL. SQLite can do it with a recursive CTE; doing it here is
// shorter, and it is also the only way to guarantee an empty day is present,
// since a query over the games cannot return a day that has none.
func (store *Store) dailyActivity(
	ctx context.Context,
	now time.Time,
	days int,
) ([]DailyActivity, error) {
	midnight := now.UTC().Truncate(24 * time.Hour)
	start := midnight.AddDate(0, 0, -(days - 1))

	buckets := make([]DailyActivity, days)
	index := make(map[int64]int, days)
	for offset := range buckets {
		day := start.AddDate(0, 0, offset).UnixMilli()
		buckets[offset] = DailyActivity{DayUnixMs: day}
		index[day] = offset
	}

	// 86_400_000 milliseconds a day. Integer division to the bucket, which is
	// the same arithmetic the Go side did above, so the two agree exactly.
	rows, err := store.db.QueryContext(ctx, `
SELECT (finished_at_unix_ms / 86400000) * 86400000 AS day,
       COUNT(*),
       COALESCE(SUM(ranked), 0)
FROM game_history
WHERE finished_at_unix_ms >= ?
GROUP BY day
`, start.UnixMilli())
	if err != nil {
		return nil, fmt.Errorf("analytics: daily: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var day int64
		var games, ranked int
		if err := rows.Scan(&day, &games, &ranked); err != nil {
			return nil, fmt.Errorf("analytics: daily row: %w", err)
		}
		if offset, ok := index[day]; ok {
			buckets[offset].Games = games
			buckets[offset].Ranked = ranked
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("analytics: daily: %w", err)
	}

	// Distinct players per day, same shape as the totals above.
	playerRows, err := store.db.QueryContext(ctx, `
SELECT day, COUNT(*) FROM (
    SELECT (finished_at_unix_ms / 86400000) * 86400000 AS day,
           red_player_id AS id
    FROM game_history WHERE finished_at_unix_ms >= ?
    UNION
    SELECT (finished_at_unix_ms / 86400000) * 86400000 AS day,
           blue_player_id AS id
    FROM game_history WHERE finished_at_unix_ms >= ?
)
GROUP BY day
`, start.UnixMilli(), start.UnixMilli())
	if err != nil {
		return nil, fmt.Errorf("analytics: daily players: %w", err)
	}
	defer playerRows.Close()
	for playerRows.Next() {
		var day int64
		var players int
		if err := playerRows.Scan(&day, &players); err != nil {
			return nil, fmt.Errorf("analytics: daily player row: %w", err)
		}
		if offset, ok := index[day]; ok {
			buckets[offset].Players = players
		}
	}
	return buckets, playerRows.Err()
}
