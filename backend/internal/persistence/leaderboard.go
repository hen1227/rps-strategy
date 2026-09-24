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
	Title string `json:"title,omitempty"`
	Elo   int    `json:"elo"`
	// State says whether Elo is worth reading at all, and Confidence is the share
	// of the measurement behind it. A row that is RatingStateUnrated has no
	// meaningful Elo — it is not a bad rating, it is the absence of one — and the
	// board is ordered accordingly. See RatingState.
	State       RatingState `json:"ratingState"`
	Confidence  float64     `json:"ratingConfidence"`
	Wins        int         `json:"wins"`
	Losses      int         `json:"losses"`
	Draws       int         `json:"draws"`
	GamesPlayed int         `json:"gamesPlayed"`
	// ModeID names the mode this row's rating belongs to: the requested mode on a
	// mode board, and on the combined board the mode this player is strongest in.
	// Never empty for a listed account, because every rating in this game belongs
	// to some mode.
	ModeID string `json:"modeId,omitempty"`
	// IconSHA256 is a bot's picture, so the bot board can draw the engines it
	// ranks rather than their initials. Always empty on the human board: people
	// have no portrait here. See persistence.Bot.IconSHA256.
	IconSHA256 string `json:"iconSha256,omitempty"`
	// OwnerUsername is the person who entered this engine, and EngineName is what
	// the engine calls itself when it connects. Both empty on the human board,
	// which has no bot row to read them from.
	//
	// Neither is a disclosure. The public bot directory already serves every
	// field of persistence.Bot, owner id included, and a person's own profile
	// page lists the engines they wrote — so the owner of a given bot is already
	// public, one lookup away. Carrying it here is the same join done once for a
	// page of fifty rather than fifty times by the client.
	OwnerUsername string `json:"ownerUsername,omitempty"`
	EngineName    string `json:"engineName,omitempty"`
	// LeadingSinceUnixMs is when this engine took the top of this row's mode,
	// and zero for everybody who is not holding it. Only the leader has one, so
	// a row carrying it is the row in front.
	//
	// A timestamp rather than a count of days, because the client is the only
	// side that knows what today is on the reader's machine, and a number of
	// days computed here would be wrong for half the world and stale the moment
	// it was cached.
	LeadingSinceUnixMs int64 `json:"leadingSinceUnixMs,omitempty"`
	// HeldTopSeat says this engine has led its mode at some point, which is
	// true of the current leader too. Reigns are only recorded from the day the
	// ledger shipped, so a false here means "not since then" rather than
	// "never". See bot_reigns.go.
	HeldTopSeat bool `json:"heldTopSeat,omitempty"`
}

// rankedSQL is RatingState.Ranked as a SQL expression, over one alias of
// account_mode_ratings.
//
// Written once and used three times — the row's own flag, the board's order, and
// the choice of which mode represents an account on the combined board — because
// a board that sorted on one definition of "has a rating" and labelled rows with
// another would disagree with itself in the middle of a page. The Go side of the
// same rule is RatingStateOf; the thresholds are formatted in rather than
// duplicated as literals so that moving one moves both.
func rankedSQL(alias string) string {
	return fmt.Sprintf(
		"%[1]s.rating_placed = 1 AND %[1]s.rating_confidence >= %[2]v",
		alias, RatingConfidenceGuess,
	)
}

// boardOrder is the order the ladder is read in, written once because three
// things have to agree on it: the page, which one of an owner's engines gets
// listed, and — through modeBoardLeaders — who the record says is top of a
// mode. Measured first, and only then by the number.
//
// Without the first term a board on which nothing has been placed — no
// yardstick designated, so the fit publishes nothing — ranks every engine at
// the floor in order of how many games it has played, and calls the busiest one
// the best. Ordering the unranked last says the true thing instead: these are
// not in an order, because there is nothing to order them by.
const boardOrder = `ranked DESC, rating DESC, played DESC, username ASC`

// boardLeader is the engine in front of one mode, and who entered it.
//
// The owner travels with it because the two callers want different halves: the
// reign ledger records the engine, and the Bot Architect title is awarded to
// the person. Reading it here rather than joining `bots` again afterwards keeps
// both answers on the board's own owner_key, which falls back to the account
// itself for an engine whose registry row has gone — so an unclaimed engine is
// its own owner rather than nobody's.
type boardLeader struct {
	UserID      string
	OwnerUserID string
}

// modeBoardLeaders is the engine sitting first on each mode's bot ladder, by
// mode id, and it is the one definition of "top of a mode" in this package.
//
// It exists because three things used to answer that question separately and
// were entitled to disagree: the board itself, the Bot Architect title, and now
// the reign ledger. A title in front of somebody's name that contradicts the
// page it was won on is worse than either answer alone, so all of them read
// this.
//
// It is the same board Leaderboard draws, pinned to its first row: the same
// exclusions, the same "one owner, one row" collapse, and boardOrder — which is
// why that is a package constant. The one difference is that every mode is
// answered in one pass, because every caller wants the whole fleet: a leader
// changing is a fact about two engines, and asking per mode would be a query
// per mode on a tick.
//
// A mode nobody qualifies in is absent rather than present and empty. There is
// no leader of an empty board, and saying so as a missing key means a caller
// cannot mistake "" for an engine.
func (store *Store) modeBoardLeaders(
	ctx context.Context,
) (map[string]boardLeader, error) {
	// Mirrors Leaderboard's mode-board shape. Kept as its own statement rather
	// than threaded through that one with a flag, because the two want opposite
	// things — a page of fifty for one mode, one row for every mode — and the
	// parameter that chose between them would have to be read in four places.
	query := fmt.Sprintf(`
SELECT mode_id, user_id, owner_key FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY mode_id ORDER BY %[1]s) AS place
  FROM (
    SELECT *, ROW_NUMBER() OVER (
             PARTITION BY mode_id, owner_key ORDER BY %[1]s
           ) AS owner_place
    FROM (
      SELECT a.user_id, a.username,
             r.mode_id,
             r.elo AS rating, (%[2]s) AS ranked,
             r.games_played AS played,
             COALESCE((SELECT b.owner_user_id FROM bots b
                        WHERE b.user_id = a.user_id), a.user_id) AS owner_key
      FROM accounts a
      JOIN account_mode_ratings r ON r.user_id = a.user_id
      WHERE a.kind = ? AND a.disabled = 0
    )
    WHERE rating IS NOT NULL AND played >= ?
  )
  WHERE owner_place = 1
)
WHERE place = 1
`, boardOrder, rankedSQL("r"))

	rows, err := store.db.QueryContext(
		ctx, query, AccountKindBot, leaderboardDefaultMinimumGames,
	)
	if err != nil {
		return nil, fmt.Errorf("mode board leaders: %w", err)
	}
	defer rows.Close()

	leaders := make(map[string]boardLeader)
	for rows.Next() {
		var modeID string
		var leader boardLeader
		if err := rows.Scan(&modeID, &leader.UserID, &leader.OwnerUserID); err != nil {
			return nil, fmt.Errorf("read mode board leader: %w", err)
		}
		leaders[modeID] = leader
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("mode board leaders: %w", err)
	}
	return leaders, nil
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
// Four exclusions, each for its own reason:
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
//   - Every engine but their owner's best, on the bot board. See "one owner,
//     one row" below.
func (store *Store) Leaderboard(
	ctx context.Context,
	filter LeaderboardFilter,
) ([]LeaderboardEntry, error) {
	filter = filter.normalized()

	registered := ""
	if filter.Kind == LeaderboardKindHuman {
		registered = " AND " + registeredSQL("a")
	}

	// Correlated subqueries rather than a join: all four are per *account* and
	// both boards below already group by one, so joining would mean saying so
	// twice in two different shapes. They resolve to the empty string on the
	// human board, where no account has a bot row — which is the right answer
	// rather than a special case, so neither board has to ask for its own
	// columns.
	//
	// owner_key is the one that falls back to the account itself instead of to
	// '', because it is what "one owner, one row" groups on below and an unknown
	// owner is not a shared one — the same reading botHeadToHeadTx takes of an
	// engine whose registry row has gone. Every person, and every engine nobody
	// has claimed, is thereby its own owner, and only engines that genuinely
	// answer to one account compete for one slot.
	const botColumns = `,
       COALESCE((SELECT i.sha256 FROM bot_icons i
                   JOIN bots b ON b.bot_id = i.bot_id
                  WHERE b.user_id = a.user_id), '') AS icon_sha256,
       COALESCE((SELECT o.username FROM bots b
                   JOIN accounts o ON o.user_id = b.owner_user_id
                  WHERE b.user_id = a.user_id), '') AS owner_username,
       COALESCE((SELECT b.engine_name FROM bots b
                  WHERE b.user_id = a.user_id), '') AS engine_name,
       COALESCE((SELECT b.owner_user_id FROM bots b
                  WHERE b.user_id = a.user_id), a.user_id) AS owner_key`

	// A row of the board as the scan at the bottom reads it, named rather than
	// `*` because the layers in between carry working columns — owner_key, and
	// the place a row takes within its owner — that stop at the last SELECT.
	const entryColumns = `user_id, kind, username, discord, title,
       rating, placed, confidence, ranked, wins, losses, draws, played, mode_id,
       icon_sha256, owner_username, engine_name`

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
	var board string
	arguments := []any{}
	if filter.ModeID != "" {
		board = fmt.Sprintf(`
SELECT a.user_id, a.kind, a.username, a.discord, a.title,
       r.elo AS rating, r.rating_placed AS placed,
       r.rating_confidence AS confidence,
       (%s) AS ranked,
       r.wins, r.losses, r.draws, r.games_played AS played,
       r.mode_id%s
FROM accounts a
JOIN account_mode_ratings r ON r.user_id = a.user_id AND r.mode_id = ?
WHERE a.kind = ? AND a.disabled = 0%s
`, rankedSQL("r"), botColumns, registered)
		arguments = append(arguments, filter.ModeID, filter.Kind)
	} else {
		board = fmt.Sprintf(`
SELECT a.user_id, a.kind, a.username, a.discord, a.title,
       best.elo AS rating, best.rating_placed AS placed,
       best.rating_confidence AS confidence,
       (%s) AS ranked,
       a.wins, a.losses, a.draws, a.games_played AS played,
       best.mode_id%s
FROM accounts a
LEFT JOIN account_mode_ratings best ON best.rowid = (
    SELECT r.rowid FROM account_mode_ratings r
     WHERE r.user_id = a.user_id
     ORDER BY (%s) DESC, r.elo DESC, r.mode_id LIMIT 1
)
WHERE a.kind = ? AND a.disabled = 0%s
`, rankedSQL("best"), botColumns, rankedSQL("r"), registered)
		arguments = append(arguments, filter.Kind)
	}

	// The games floor is the same sentence about either shape, so it is said
	// once out here. `rating IS NOT NULL` is what the combined board's MAX
	// returns for an account that has never been rated in any mode; on a mode
	// board the join has already ruled that out.
	listed := fmt.Sprintf(`
SELECT * FROM (%s)
WHERE rating IS NOT NULL AND played >= ?
`, board)
	arguments = append(arguments, filter.MinimumGames)

	// One owner, one row.
	//
	// The same engine entered five times is one result reported five times, and
	// a board that lists all five is ranking who registered the most bots. So an
	// owner holds one slot, for their best engine, and their others are left off
	// — left off rather than merged, because a row is one engine's record and an
	// owner's five engines do not have a combined one. The others keep their
	// ratings, their profiles, and their place in the public bot directory; what
	// they lose is a second seat on a page of fifty.
	//
	// Best means first in the board's own order, so the engine that holds the
	// slot is the one that would have led the group anyway, and a tie is broken
	// the same way it is broken everywhere else on the page.
	//
	// Applied here rather than to the rows once they arrive, because rank and
	// paging count the board that is left: filtering a page of fifty would hand
	// back forty-one rows for page one and open page two at rank fifty-one.
	if filter.Kind == LeaderboardKindBot {
		listed = fmt.Sprintf(`
SELECT %s FROM (
  SELECT *, ROW_NUMBER() OVER (PARTITION BY owner_key ORDER BY %s) AS owner_place
  FROM (%s)
)
WHERE owner_place = 1
`, entryColumns, boardOrder, listed)
	}

	query := fmt.Sprintf(`
SELECT %s FROM (%s)
ORDER BY %s
LIMIT ? OFFSET ?
`, entryColumns, listed, boardOrder)
	arguments = append(arguments, filter.Limit, filter.Offset)

	rows, err := store.db.QueryContext(ctx, query, arguments...)
	if err != nil {
		return nil, fmt.Errorf("leaderboard: %w", err)
	}
	defer rows.Close()

	entries := make([]LeaderboardEntry, 0, filter.Limit)
	for rows.Next() {
		var entry LeaderboardEntry
		var placed, ranked bool
		if err := rows.Scan(
			&entry.UserID, &entry.Kind, &entry.Username, &entry.Discord, &entry.Title,
			&entry.Elo, &placed, &entry.Confidence, &ranked,
			&entry.Wins, &entry.Losses, &entry.Draws, &entry.GamesPlayed,
			&entry.ModeID, &entry.IconSHA256, &entry.OwnerUsername, &entry.EngineName,
		); err != nil {
			return nil, fmt.Errorf("read leaderboard row: %w", err)
		}
		entry.State = RatingStateOf(placed, entry.Confidence)
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("leaderboard: %w", err)
	}
	for index := range entries {
		entries[index].Rank = filter.Offset + index + 1
	}
	// Only the bot board. People do not have reigns: the ledger is about the
	// engine ladder, and asking would be a query that always comes back empty.
	if filter.Kind == LeaderboardKindBot {
		if err := store.annotateReigns(ctx, entries); err != nil {
			return nil, err
		}
	}
	return entries, nil
}
