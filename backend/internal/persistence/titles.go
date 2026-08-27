package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"
)

// Player titles: the short tag that sits in front of a name, the way GM sits in
// front of a chess player's.
//
// Two halves that must not be confused with each other:
//
//   - *Owning* a title. A row in `account_titles`. Permanent once written, like
//     a chess title, which is what makes them worth collecting: a Grandmaster
//     who has a bad month is still a Grandmaster. Nothing here ever deletes an
//     earned row on its own — only an administrator can, and only deliberately.
//   - *Wearing* one. A single column on `accounts`, naming which owned title
//     goes in front of the name. Everybody with several picks one, and picking
//     none is allowed and is the default.
//
// The catalogue below is code rather than data. Every title is earned by a rule
// somebody has to write anyway, so a titles *table* would be a second place to
// say the same thing and a way for the two to disagree. Administrators grant
// out of the same catalogue; there is no such thing here as a title nobody can
// look up.

// TitleID is a title's identity *and* the three letters it displays as.
//
// One string rather than a slug plus an abbreviation, because a second field
// would be a second name for the same thing and every read would have to carry
// both. The cost is that renaming an abbreviation orphans the rows that hold
// the old one — so reads resolve through the catalogue and silently drop what
// they cannot find, which turns a rename into a title quietly disappearing
// rather than into a crash or a blank tag on somebody's name.
type TitleID string

// TitleKind says where a title comes from, which is the only thing a client
// needs in order to explain one: earned titles have a rule to state, granted
// ones have nothing to state but the fact of the grant.
type TitleKind string

const (
	// TitleKindRating is the ladder: a rating reached in any one mode.
	TitleKindRating TitleKind = "rating"
	// TitleKindAchievement is something done rather than something reached.
	TitleKindAchievement TitleKind = "achievement"
	// TitleKindGranted cannot be earned at all. An administrator hands it out.
	TitleKindGranted TitleKind = "granted"
)

// TitleSourceEarned and TitleSourceGranted record *how* a particular account
// came by a title, which is not the same as the title's kind: an administrator
// may grant GM to somebody who never reached the rating, and that row is a
// grant of a rating-kind title.
//
// The distinction earns its keep in exactly one place — revocation. Re-running
// the evaluator must not resurrect a title an administrator has taken away, and
// must not leave a granted title dependent on a rule it was deliberately handed
// out in spite of.
const (
	TitleSourceEarned  = "earned"
	TitleSourceGranted = "granted"
)

const (
	// TitleCandidateMaster and the three above it are the rating ladder.
	TitleCandidateMaster     TitleID = "CM"
	TitleMaster              TitleID = "FM"
	TitleInternationalMaster TitleID = "IM"
	TitleGrandmaster         TitleID = "GM"

	// TitleTournamentChampion is won at the table.
	TitleTournamentChampion TitleID = "TC"
	// TitleBotSlayer is for beating an engine that is not your own.
	TitleBotSlayer TitleID = "BSL"
	// TitleBotMaster and TitleBotArchitect belong to bot *owners*, not to the
	// bots: an engine does not collect anything, and the person who wrote it
	// is the one who turns up in chat.
	TitleBotMaster    TitleID = "BM"
	TitleBotArchitect TitleID = "ARC"

	// TitleDeveloper and TitleModerator exist only to be granted.
	TitleDeveloper TitleID = "DEV"
	TitleModerator TitleID = "MOD"
)

// MaximumTitleLength is the promise the tag makes to every layout that renders
// one: three characters, so a name row can budget for it. Enforced over the
// catalogue by a test rather than at runtime, because the catalogue is a
// constant and a title too long is a bug in this file, not bad input.
const MaximumTitleLength = 3

// Title is one entry of the catalogue.
type Title struct {
	ID   TitleID   `json:"id"`
	Name string    `json:"name"`
	Kind TitleKind `json:"kind"`
	// Requirement is how it is earned, in the words shown to the player.
	Requirement string `json:"requirement"`
}

// titleCatalogue is every title there is, most prestigious first.
//
// The order is the display order everywhere: a player's tags, the picker on the
// account page, the admin list. Sorting by it rather than by award date means a
// collection reads as a ranking instead of as a diary.
var titleCatalogue = []Title{
	{
		ID:          TitleGrandmaster,
		Name:        "Grandmaster",
		Kind:        TitleKindRating,
		Requirement: "Reach 2000 in any mode.",
	},
	{
		ID:          TitleInternationalMaster,
		Name:        "International Master",
		Kind:        TitleKindRating,
		Requirement: "Reach 1800 in any mode.",
	},
	{
		ID:          TitleMaster,
		Name:        "Master",
		Kind:        TitleKindRating,
		Requirement: "Reach 1600 in any mode.",
	},
	{
		ID:          TitleCandidateMaster,
		Name:        "Candidate Master",
		Kind:        TitleKindRating,
		Requirement: "Reach 1400 in any mode.",
	},
	{
		ID:          TitleTournamentChampion,
		Name:        "Tournament Champion",
		Kind:        TitleKindAchievement,
		Requirement: "Finish a tournament on the most points.",
	},
	{
		ID:          TitleBotArchitect,
		Name:        "Bot Architect",
		Kind:        TitleKindAchievement,
		Requirement: "Own the top-rated engine on a mode's bot ladder.",
	},
	{
		ID:          TitleBotMaster,
		Name:        "Bot Master",
		Kind:        TitleKindAchievement,
		Requirement: "Own an engine that has won a tournament.",
	},
	{
		ID:          TitleBotSlayer,
		Name:        "Bot Slayer",
		Kind:        TitleKindAchievement,
		Requirement: "Beat a registered engine somebody else owns.",
	},
	{
		ID:          TitleDeveloper,
		Name:        "Developer",
		Kind:        TitleKindGranted,
		Requirement: "Granted by the host.",
	},
	{
		ID:          TitleModerator,
		Name:        "Moderator",
		Kind:        TitleKindGranted,
		Requirement: "Granted by the host.",
	},
}

// titleIndex is the catalogue by id, plus each title's place in the order, so a
// read can both resolve and sort without scanning the slice.
var titleIndex = func() map[TitleID]struct {
	title Title
	order int
} {
	index := make(map[TitleID]struct {
		title Title
		order int
	}, len(titleCatalogue))
	for order, title := range titleCatalogue {
		index[title.ID] = struct {
			title Title
			order int
		}{title: title, order: order}
	}
	return index
}()

// ratingRung is one step of the ladder.
type ratingRung struct {
	id         TitleID
	minimumElo int
}

// ratingLadder is checked in order, and every rung a player clears is awarded —
// not only the highest. A Grandmaster owns CM, FM and IM as well, which is what
// makes the ladder a collection rather than a single slot, and what lets a
// player who prefers the modest tag wear it.
var ratingLadder = []ratingRung{
	{id: TitleGrandmaster, minimumElo: 2000},
	{id: TitleInternationalMaster, minimumElo: 1800},
	{id: TitleMaster, minimumElo: 1600},
	{id: TitleCandidateMaster, minimumElo: 1400},
}

// titleLadderMinimumGames is how much play a mode rating must have behind it
// before it can earn anything. The same reasoning as the leaderboard's minimum:
// a rating nobody has tested is a starting value, not an achievement. Lower
// than the leaderboard's, because a title is permanent and the bar that matters
// is "this was not a fluke of two games", not "this is a settled rating".
const titleLadderMinimumGames = 10

var (
	// ErrUnknownTitle is an id that is not in the catalogue.
	ErrUnknownTitle = errors.New("unknown title")
	// ErrTitleNotOwned is returned when an account tries to wear a title it
	// does not hold.
	ErrTitleNotOwned = errors.New("this account does not hold that title")
)

// TitleAward is one title an account holds, flattened with its catalogue entry
// so that a client rendering somebody's collection needs nothing else.
type TitleAward struct {
	ID              TitleID   `json:"id"`
	Name            string    `json:"name"`
	Kind            TitleKind `json:"kind"`
	Requirement     string    `json:"requirement"`
	Source          string    `json:"source"`
	AwardedAtUnixMs int64     `json:"awardedAtUnixMs"`
}

// TitleCatalogue is every title that exists, in display order. Copied on the
// way out so a caller cannot edit the catalogue by editing what it was handed.
func TitleCatalogue() []Title {
	return append([]Title(nil), titleCatalogue...)
}

// LookupTitle resolves an id against the catalogue.
func LookupTitle(id TitleID) (Title, bool) {
	entry, found := titleIndex[id]
	return entry.title, found
}

func (store *Store) ensureTitleSchema(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS account_titles (
    user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    title_id TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('earned', 'granted')),
    awarded_at_unix_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, title_id)
);

CREATE INDEX IF NOT EXISTS account_titles_user_idx ON account_titles(user_id);
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate account titles: %w", err)
	}
	return nil
}

// AccountTitles is everything an account holds, in catalogue order.
//
// A stored id the catalogue no longer knows is skipped rather than reported.
// See TitleID for why that is the behaviour worth having.
func (store *Store) AccountTitles(ctx context.Context, userID string) ([]TitleAward, error) {
	return accountTitlesTx(ctx, store.db, strings.TrimSpace(userID))
}

type titleQueryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func accountTitlesTx(
	ctx context.Context,
	queryer titleQueryer,
	userID string,
) ([]TitleAward, error) {
	rows, err := queryer.QueryContext(ctx, `
SELECT title_id, source, awarded_at_unix_ms FROM account_titles WHERE user_id = ?
`, userID)
	if err != nil {
		return nil, fmt.Errorf("read account titles: %w", err)
	}
	defer rows.Close()

	awards := make([]TitleAward, 0, 4)
	for rows.Next() {
		var id TitleID
		var source string
		var awardedAt int64
		if err := rows.Scan(&id, &source, &awardedAt); err != nil {
			return nil, fmt.Errorf("read account titles: %w", err)
		}
		title, known := LookupTitle(id)
		if !known {
			continue
		}
		awards = append(awards, TitleAward{
			ID:              title.ID,
			Name:            title.Name,
			Kind:            title.Kind,
			Requirement:     title.Requirement,
			Source:          source,
			AwardedAtUnixMs: awardedAt,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read account titles: %w", err)
	}
	sort.SliceStable(awards, func(first, second int) bool {
		return titleIndex[awards[first].ID].order < titleIndex[awards[second].ID].order
	})
	return awards, nil
}

// GrantTitle gives an account a title an administrator has decided it should
// have, whether or not any rule would award it.
//
// A grant over an already-earned row upgrades the source to `granted`, which is
// what stops a later re-evaluation from being able to claim the row back — the
// grant outlives the rule.
func (store *Store) GrantTitle(ctx context.Context, userID string, id TitleID) error {
	userID = strings.TrimSpace(userID)
	if _, known := LookupTitle(id); !known {
		return fmt.Errorf("%w: %q", ErrUnknownTitle, id)
	}
	// The foreign key would catch a missing account too, but as a constraint
	// violation rather than as the error an administrator can read.
	var exists int
	if err := store.db.QueryRowContext(ctx, `
SELECT 1 FROM accounts WHERE user_id = ?
`, userID).Scan(&exists); errors.Is(err, sql.ErrNoRows) {
		return ErrAccountNotFound
	} else if err != nil {
		return fmt.Errorf("grant title: read account: %w", err)
	}
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO account_titles (user_id, title_id, source, awarded_at_unix_ms)
VALUES (?, ?, ?, ?)
ON CONFLICT(user_id, title_id) DO UPDATE SET source = excluded.source
`, userID, id, TitleSourceGranted, time.Now().UnixMilli()); err != nil {
		return fmt.Errorf("grant title: %w", err)
	}
	return nil
}

// RevokeTitle takes a title away, and takes it off the name if it was being
// worn. The only thing here that removes a row.
//
// It is not a ban on the title. EvaluateTitles awards whatever the rules
// currently justify, so revoking one somebody still qualifies for lasts until
// their next finished game. That is the honest behaviour rather than a missing
// feature: an administrator taking a title off a cheat is dealing with the
// games that earned it, and deleting those (which hands the rating back) is
// what stops the rules awarding it again. A granted title, which no rule
// awards, is gone for good.
func (store *Store) RevokeTitle(ctx context.Context, userID string, id TitleID) error {
	userID = strings.TrimSpace(userID)
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("revoke title: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()
	if _, err := transaction.ExecContext(ctx, `
DELETE FROM account_titles WHERE user_id = ? AND title_id = ?
`, userID, id); err != nil {
		return fmt.Errorf("revoke title: %w", err)
	}
	if _, err := transaction.ExecContext(ctx, `
UPDATE accounts SET title = '', updated_at_unix_ms = ?
WHERE user_id = ? AND title = ?
`, time.Now().UnixMilli(), userID, id); err != nil {
		return fmt.Errorf("revoke title: clear selection: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("revoke title: commit: %w", err)
	}
	return nil
}

// SetAccountTitle chooses which owned title goes in front of the name. The
// empty string wears none, which is always allowed and is the default.
func (store *Store) SetAccountTitle(
	ctx context.Context,
	userID string,
	id TitleID,
) (Account, error) {
	userID = strings.TrimSpace(userID)
	if id != "" {
		if _, known := LookupTitle(id); !known {
			return Account{}, fmt.Errorf("%w: %q", ErrUnknownTitle, id)
		}
		var owned int
		if err := store.db.QueryRowContext(ctx, `
SELECT COUNT(*) FROM account_titles WHERE user_id = ? AND title_id = ?
`, userID, id).Scan(&owned); err != nil {
			return Account{}, fmt.Errorf("set account title: read ownership: %w", err)
		}
		if owned == 0 {
			return Account{}, ErrTitleNotOwned
		}
	}
	result, err := store.db.ExecContext(ctx, `
UPDATE accounts SET title = ?, updated_at_unix_ms = ? WHERE user_id = ?
`, id, time.Now().UnixMilli(), userID)
	if err != nil {
		return Account{}, fmt.Errorf("set account title: %w", err)
	}
	if affected, err := result.RowsAffected(); err == nil && affected == 0 {
		return Account{}, ErrAccountNotFound
	}
	return store.Account(ctx, userID)
}

// EvaluateTitles awards every earned title this account now qualifies for, and
// reports the ones it did not already hold.
//
// Idempotent and additive: it never removes anything, so a rating that falls
// back below a rung keeps the title, and an administrator's revocation is only
// undone by an administrator's grant. The returned slice is what is *new*,
// which is what a caller needs in order to tell somebody they have earned
// something.
//
// Bot accounts are skipped. An engine's rating comes from a fit across every
// pair's head-to-head record rather than from per-game Elo (see bot_rating.go),
// so the numbers are not on the same scale as a person's and a bot wearing GM
// would be claiming something the ladder never measured. The achievements its
// games produce belong to its owner instead, which is who turns up in chat.
// An administrator can still grant a bot a title.
func (store *Store) EvaluateTitles(ctx context.Context, userID string) ([]TitleAward, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return nil, nil
	}
	var kind string
	err := store.db.QueryRowContext(ctx, `
SELECT kind FROM accounts WHERE user_id = ?
`, userID).Scan(&kind)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("evaluate titles: read account: %w", err)
	}
	if kind == AccountKindBot {
		return nil, nil
	}

	earned, err := store.earnedTitles(ctx, userID)
	if err != nil {
		return nil, err
	}
	if len(earned) == 0 {
		return nil, nil
	}

	held, err := store.AccountTitles(ctx, userID)
	if err != nil {
		return nil, err
	}
	alreadyHeld := make(map[TitleID]struct{}, len(held))
	for _, award := range held {
		alreadyHeld[award.ID] = struct{}{}
	}

	now := time.Now().UnixMilli()
	awarded := make([]TitleAward, 0, len(earned))
	for _, id := range earned {
		if _, have := alreadyHeld[id]; have {
			continue
		}
		title, known := LookupTitle(id)
		if !known {
			continue
		}
		// DO NOTHING rather than an upsert: a title an administrator granted
		// and this evaluation also earns must keep its `granted` source, or a
		// revocation could be undone by the next finished game.
		if _, err := store.db.ExecContext(ctx, `
INSERT INTO account_titles (user_id, title_id, source, awarded_at_unix_ms)
VALUES (?, ?, ?, ?)
ON CONFLICT(user_id, title_id) DO NOTHING
`, userID, id, TitleSourceEarned, now); err != nil {
			return nil, fmt.Errorf("evaluate titles: award %s: %w", id, err)
		}
		awarded = append(awarded, TitleAward{
			ID:              title.ID,
			Name:            title.Name,
			Kind:            title.Kind,
			Requirement:     title.Requirement,
			Source:          TitleSourceEarned,
			AwardedAtUnixMs: now,
		})
	}
	sort.SliceStable(awarded, func(first, second int) bool {
		return titleIndex[awarded[first].ID].order < titleIndex[awarded[second].ID].order
	})
	return awarded, nil
}

// earnedTitles is the whole rulebook: every title this account's record
// currently justifies, whether or not it already holds it.
func (store *Store) earnedTitles(ctx context.Context, userID string) ([]TitleID, error) {
	earned := make([]TitleID, 0, 4)

	// The ladder. One number decides it: the best rating held in any single
	// mode that has been played enough to mean anything. Modes rate
	// independently, so a player strong in one mode is titled for it — the
	// alternative, requiring the bar in every mode, would title nobody who
	// specialises.
	var bestElo sql.NullInt64
	if err := store.db.QueryRowContext(ctx, `
SELECT MAX(elo) FROM account_mode_ratings WHERE user_id = ? AND games_played >= ?
`, userID, titleLadderMinimumGames).Scan(&bestElo); err != nil {
		return nil, fmt.Errorf("evaluate titles: read mode ratings: %w", err)
	}
	if bestElo.Valid {
		for _, rung := range ratingLadder {
			if int(bestElo.Int64) >= rung.minimumElo {
				earned = append(earned, rung.id)
			}
		}
	}

	// Beating an engine, which has to be somebody else's engine. Without that
	// clause the title is bought rather than won: register a bot, tell it to
	// resign, and the tag is yours. An unclaimed or deleted bot slot leaves an
	// account with kind 'bot' and no `bots` row, which is nobody's engine and
	// so counts.
	won, err := store.exists(ctx, `
SELECT 1
FROM game_history h
JOIN accounts opponent
  ON opponent.user_id = CASE
       WHEN h.red_player_id = ?1 THEN h.blue_player_id ELSE h.red_player_id
     END
LEFT JOIN bots b ON b.user_id = opponent.user_id
WHERE h.winner_player_id = ?1
  AND (h.red_player_id = ?1 OR h.blue_player_id = ?1)
  AND opponent.kind = ?2
  AND (b.owner_user_id IS NULL OR b.owner_user_id <> ?1)
LIMIT 1
`, userID, AccountKindBot)
	if err != nil {
		return nil, fmt.Errorf("evaluate titles: read bot wins: %w", err)
	}
	if won {
		earned = append(earned, TitleBotSlayer)
	}

	// Owning the best engine on some mode's bot ladder. Read against the same
	// rows the bot leaderboard ranks, and with its minimum-games rule, so the
	// title and the board cannot disagree about who is top.
	topBot, err := store.exists(ctx, `
SELECT 1
FROM bots b
JOIN account_mode_ratings r ON r.user_id = b.user_id
JOIN accounts a ON a.user_id = b.user_id
WHERE b.owner_user_id = ?1
  AND a.disabled = 0
  AND r.games_played >= ?2
  AND r.elo = (
    SELECT MAX(peer.elo)
    FROM account_mode_ratings peer
    JOIN accounts peer_account ON peer_account.user_id = peer.user_id
    WHERE peer.mode_id = r.mode_id
      AND peer_account.kind = ?3
      AND peer_account.disabled = 0
      AND peer.games_played >= ?2
  )
LIMIT 1
`, userID, leaderboardDefaultMinimumGames, AccountKindBot)
	if err != nil {
		return nil, fmt.Errorf("evaluate titles: read bot ladder: %w", err)
	}
	if topBot {
		earned = append(earned, TitleBotArchitect)
	}

	// Tournaments, for the player and for their engines in one pass: the
	// champions of a finished tournament are read once and matched against both
	// this account and the accounts of the bots it owns.
	own, bots, err := store.tournamentTitles(ctx, userID)
	if err != nil {
		return nil, err
	}
	if own {
		earned = append(earned, TitleTournamentChampion)
	}
	if bots {
		earned = append(earned, TitleBotMaster)
	}
	return earned, nil
}

// exists runs a query that selects at most one row and reports whether it found
// one.
func (store *Store) exists(ctx context.Context, query string, arguments ...any) (bool, error) {
	var found int
	err := store.db.QueryRowContext(ctx, query, arguments...).Scan(&found)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

// tournamentTitles reports whether this account has won a tournament, and
// whether one of its engines has.
//
// The standings are recomputed through tournamentStandings rather than queried,
// because the points and the tie-breaks live there and a second copy in SQL
// would be a second answer to "who won". Only tournaments this account or one
// of its engines actually entered are loaded.
func (store *Store) tournamentTitles(
	ctx context.Context,
	userID string,
) (own bool, bots bool, err error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT DISTINCT p.tournament_id, p.user_id
FROM tournament_players p
JOIN tournaments t ON t.tournament_id = p.tournament_id
LEFT JOIN bots b ON b.user_id = p.user_id
WHERE t.status = ?
  AND (p.user_id = ? OR b.owner_user_id = ?)
`, TournamentCompleted, userID, userID)
	if err != nil {
		return false, false, fmt.Errorf("evaluate titles: read tournaments: %w", err)
	}
	defer rows.Close()

	// Which of this account's identities entered which tournament. A person and
	// their engines can be in the same one, so a tournament maps to a set.
	entrants := make(map[string][]string)
	for rows.Next() {
		var tournamentID, entrantID string
		if err := rows.Scan(&tournamentID, &entrantID); err != nil {
			return false, false, fmt.Errorf("evaluate titles: read tournaments: %w", err)
		}
		entrants[tournamentID] = append(entrants[tournamentID], entrantID)
	}
	if err := rows.Err(); err != nil {
		return false, false, fmt.Errorf("evaluate titles: read tournaments: %w", err)
	}

	for tournamentID, ids := range entrants {
		tournament, err := store.Tournament(ctx, tournamentID)
		if errors.Is(err, ErrTournamentNotFound) {
			continue
		}
		if err != nil {
			return false, false, err
		}
		champions := tournamentChampions(tournament)
		for _, entrantID := range ids {
			if _, won := champions[entrantID]; !won {
				continue
			}
			if entrantID == userID {
				own = true
			} else {
				bots = true
			}
		}
	}
	return own, bots, nil
}

// tournamentChampions is everybody who finished a completed tournament on the
// most points, by user id.
//
// A set rather than the single rank-1 row, because the standings break a tie on
// signup order and a lifetime title should not turn on who registered first.
// Everyone level at the top won it.
func tournamentChampions(tournament Tournament) map[string]struct{} {
	champions := make(map[string]struct{})
	if tournament.Status != TournamentCompleted || len(tournament.Standings) == 0 {
		return champions
	}
	best := tournament.Standings[0].Points
	if best <= 0 {
		return champions
	}
	userIDs := make(map[int64]string, len(tournament.Players))
	for _, player := range tournament.Players {
		userIDs[player.PlayerID] = player.UserID
	}
	for _, standing := range tournament.Standings {
		if standing.Points != best {
			continue
		}
		if userID, found := userIDs[standing.PlayerID]; found && userID != "" {
			champions[userID] = struct{}{}
		}
	}
	return champions
}

// EvaluateTitlesFor evaluates everyone whose collection the named accounts
// could have changed, and reports only those who gained something.
//
// The list it is handed is the accounts that just did something — the two
// players of a finished game, the entrants of a tournament that just ended.
// What it evaluates is not quite that list: an engine collects nothing itself,
// so a bot account is replaced by the account that owns it. That substitution
// belongs here beside the rules that depend on it, rather than at each of the
// call sites that would otherwise each have to remember it.
func (store *Store) EvaluateTitlesFor(
	ctx context.Context,
	userIDs ...string,
) (map[string][]TitleAward, error) {
	subjects := make(map[string]struct{}, len(userIDs))
	for _, userID := range userIDs {
		userID = strings.TrimSpace(userID)
		if userID == "" {
			continue
		}
		var owner sql.NullString
		err := store.db.QueryRowContext(ctx, `
SELECT b.owner_user_id
FROM accounts a
JOIN bots b ON b.user_id = a.user_id
WHERE a.user_id = ? AND a.kind = ?
`, userID, AccountKindBot).Scan(&owner)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			subjects[userID] = struct{}{}
		case err != nil:
			return nil, fmt.Errorf("evaluate titles: resolve bot owner: %w", err)
		case owner.Valid && owner.String != "":
			subjects[owner.String] = struct{}{}
		}
	}

	awarded := make(map[string][]TitleAward, len(subjects))
	for userID := range subjects {
		gained, err := store.EvaluateTitles(ctx, userID)
		if err != nil {
			return nil, err
		}
		if len(gained) > 0 {
			awarded[userID] = gained
		}
	}
	return awarded, nil
}
