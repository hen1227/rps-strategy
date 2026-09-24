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
//
// Engines collect too, out of a catalogue of their own that shares this table
// and nothing else. Both pools are declared below, so the whole of what exists
// is in one list; the rules that hand the engine ones out, and the one way they
// behave differently from everything described above, are in bot_titles.go.

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

// TitlePool says who a title is for. People and engines collect from separate
// catalogues that never overlap, because almost nothing means the same thing to
// both: a rating rung measured on the human ladder is not the number an engine
// is fitted to, and "won the arena that only engines enter" is not something a
// person can go and do.
//
// The two pools share this table, this tag and these routes. What they do not
// share is a single entry — which is what stops an engine wearing GM, and what
// lets the bot rules be written without every one of them having to say "unless
// this is a person".
type TitlePool string

const (
	// TitlePoolPlayer is the catalogue people collect from, and the default: a
	// title with no pool named is a player's.
	TitlePoolPlayer TitlePool = "player"
	// TitlePoolBot is the engine catalogue. See bot_titles.go for the rules,
	// and for the one way it behaves differently from this file's — a bot's
	// tags are a reflection of the record rather than a collection.
	TitlePoolBot TitlePool = "bot"
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
	// TitleCandidateMaster and the four above it are the rating ladder.
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
	// TitleHotStreak is a run of wins with nothing in between.
	TitleHotStreak TitleID = "STK"

	// TitleDiscordVerified is the one title with no bar to clear: Discord has
	// vouched that the account is somebody's, and everybody it vouches for
	// holds it. Earned rather than granted, because linking is something the
	// player did — and a single letter because it will be the commonest tag on
	// the site, sitting in front of a name that has nothing else to say.
	TitleDiscordVerified TitleID = "D"

	// The last eight cannot be earned at all. An administrator hands them out.
	// TitleVeteran is among them by choice rather than for want of a rule: how
	// much play deserves it is a judgement, and one a query would get wrong in
	// both directions.
	TitleVeteran     TitleID = "VET"
	TitleDeveloper   TitleID = "DEV"
	TitleModerator   TitleID = "MOD"
	TitleContributor TitleID = "CON"
	// TitleBotPioneer is for the engine work itself, which is the thing the two
	// bot titles above miss: Bot Architect and Bot Master are both read off a
	// record, and a record only ever notices the engine that won — never the
	// person who first worked out how to make one play. A judgement with no
	// query behind it, like Veteran, and grantable more than once, because a
	// breakthrough is not something only one person is allowed to have.
	TitleBotPioneer TitleID = "PIO"
	TitleFounder    TitleID = "FND"
	// TitleWebGoatGuy belongs to one person: the one who invented this game.
	// Not "an award for game design" with a rule somebody could satisfy — the
	// requirement is being him, which is why there is exactly one of these and
	// no evaluator that could ever hand out a second.
	TitleWebGoatGuy TitleID = "WGG"
	// TitleIrishPizza is the same shape as the one above, and here for the same
	// reason rather than as the start of a habit: it is one person's, being him
	// is the whole of the requirement, and no rule could hand out a second.
	TitleIrishPizza TitleID = "PIZ"
)

// The engine catalogue. Two, and deliberately not more: a pool where every
// engine wears something distinguishes nobody, and these are the two facts
// about an engine that are worth a tag in front of its name.
//
// Letters, like every other tag on the site. The crown below was once the glyph
// itself, drawn oversized, with a second crown beside it — which put a pair of
// small gold squares in front of a name rather than an abbreviation of
// anything. See the note on TitleID about the id being what it displays as.
const (
	// TitleReigningChampion is the arena crown, and there is at most one
	// weekend's worth of them at a time: whoever won the most recent arena,
	// until the next one is played.
	//
	// The only thing a weekend win earns. A second tag for a win inside the last
	// ninety days stood beside it and is gone: two gold tags differing only in
	// shade, where the quieter one made a claim the weekend page already makes
	// in its own words and at more length. A champion that has been succeeded
	// has CUP left to wear, and the archive still says what it won.
	TitleReigningChampion TitleID = "RC"
	// TitleCupWinner is a tournament somebody organised, which is the engine's
	// counterpart to the owner's Bot Master. Weekend arenas do not count; they
	// have the crown above.
	TitleCupWinner TitleID = "CUP"
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
	// Pool is who the title is for. Sent on every entry rather than only on the
	// engine ones, so a client can group the catalogue by it instead of
	// knowing which ids are which.
	Pool TitlePool `json:"pool"`
	// Requirement is how it is earned, in the words shown to the player.
	Requirement string `json:"requirement"`
}

// playerTitleCatalogue is every title a person can hold, most prestigious first.
//
// The order is the display order everywhere: a player's tags, the picker on the
// account page, the admin list. Sorting by it rather than by award date means a
// collection reads as a ranking instead of as a diary.
//
// The pool is stamped on where the two halves are joined rather than repeated
// on every entry, so a title added here cannot end up in the engine catalogue
// by having a field left off.
var playerTitleCatalogue = []Title{
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
		ID:          TitleHotStreak,
		Name:        "Hot Streak",
		Kind:        TitleKindAchievement,
		Requirement: "Win 8 rated games in a row.",
	},
	{
		ID:          TitleBotSlayer,
		Name:        "Bot Slayer",
		Kind:        TitleKindAchievement,
		Requirement: "Beat a registered engine somebody else owns.",
	},
	{
		ID:          TitleDiscordVerified,
		Name:        "Discord Verified",
		Kind:        TitleKindAchievement,
		Requirement: "Sign in with Discord, or link a Discord account to this one.",
	},
	{
		ID:          TitleVeteran,
		Name:        "Veteran",
		Kind:        TitleKindGranted,
		Requirement: "Granted by the admin.",
	},
	{
		ID:          TitleDeveloper,
		Name:        "Developer",
		Kind:        TitleKindGranted,
		Requirement: "Granted by the admin.",
	},
	{
		ID:          TitleModerator,
		Name:        "Moderator",
		Kind:        TitleKindGranted,
		Requirement: "Granted by the admin.",
	},
	{
		ID:          TitleContributor,
		Name:        "Contributor",
		Kind:        TitleKindGranted,
		Requirement: "Granted by the admin, for work on the game itself.",
	},
	{
		ID:          TitleBotPioneer,
		Name:        "Bot Pioneer",
		Kind:        TitleKindGranted,
		Requirement: "Granted by the admin, for a breakthrough in engine development.",
	},
	{
		ID:          TitleFounder,
		Name:        "Founder",
		Kind:        TitleKindGranted,
		Requirement: "Granted by the admin, for being here at the start.",
	},
	{
		ID:   TitleWebGoatGuy,
		Name: "WebGoatGuy",
		Kind: TitleKindGranted,
		// Stated as a fact about one person rather than as a bar to clear, so
		// that the account page reads honestly to everybody else looking at it:
		// there is nothing here to work towards.
		Requirement: "Be WebGoatGuy, who invented this game.",
	},
	{
		ID:   TitleIrishPizza,
		Name: "IrishPizza",
		Kind: TitleKindGranted,
		// A fact about one person, in the same words as the one above, and just
		// as short: anything longer would be this list explaining a joke.
		Requirement: "Be IrishPizza.",
	},
}

// botTitleCatalogue is every title an engine can hold, most prestigious first.
//
// Read the requirements as being about *now* rather than about ever. The rules
// are in bot_titles.go and so is the argument for that; the short version is
// that one of these two is a superlative, and a superlative that is kept after
// it stops being true is a lie on somebody's name.
var botTitleCatalogue = []Title{
	{
		ID:          TitleReigningChampion,
		Name:        "Reigning Champion",
		Kind:        TitleKindAchievement,
		Requirement: "Win the most recent weekend arena.",
	},
	{
		ID:          TitleCupWinner,
		Name:        "Cup Winner",
		Kind:        TitleKindAchievement,
		Requirement: "Win a tournament outside the weekend arena.",
	},
}

// titleCatalogue is both pools, one after the other, with each entry stamped
// with the pool it came from.
//
// People first, because the catalogue route is read by the account page far
// more often than by anything looking at engines, and because a list that opens
// with two titles nobody reading it can earn reads as the wrong list.
var titleCatalogue = func() []Title {
	catalogue := make([]Title, 0, len(playerTitleCatalogue)+len(botTitleCatalogue))
	for _, pool := range []struct {
		id      TitlePool
		entries []Title
	}{
		{id: TitlePoolPlayer, entries: playerTitleCatalogue},
		{id: TitlePoolBot, entries: botTitleCatalogue},
	} {
		for _, title := range pool.entries {
			title.Pool = pool.id
			catalogue = append(catalogue, title)
		}
	}
	return catalogue
}()

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
//
// Restated for the anchored scale, and the numbers are a judgement rather than
// a conversion. The old rungs sat 200 points apart on a scale where 120 points
// was a doubling of the odds, so each was about one and two-thirds doublings
// above the last; these sit 40 apart on a scale where 20 is a doubling, which is
// two doublings a rung — a slightly steeper climb, chosen because the bottom of
// this scale is a real opponent rather than an arbitrary constant and the first
// rung should mean something specific. Candidate Master is 60: eight games in
// nine against an engine that plays at random.
//
// The old thresholds cannot simply be divided down. 1400 meant "two hundred
// above average" and average was wherever the field happened to sit; 60 means a
// fixed thing about how you play, and the two are not the same kind of claim.
var ratingLadder = []ratingRung{
	{id: TitleGrandmaster, minimumElo: 180},
	{id: TitleInternationalMaster, minimumElo: 140},
	{id: TitleMaster, minimumElo: 100},
	{id: TitleCandidateMaster, minimumElo: 60},
}

// titleLadderMinimumGames is how much play a mode rating must have behind it
// before it can earn anything. The same reasoning as the leaderboard's minimum:
// a rating nobody has tested is a starting value, not an achievement. Lower
// than the leaderboard's, because a title is permanent and the bar that matters
// is "this was not a fluke of two games", not "this is a settled rating".
const titleLadderMinimumGames = 10

// titleWinStreakLength is Hot Streak: eight in a row, counting every rated game
// rather than only the ones against people. A game that moved your rating is a
// game, and a rule that quietly skipped some of them would make a streak
// something other than what the player watched happen.
const titleWinStreakLength = 8

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
	Pool            TitlePool `json:"pool"`
	Requirement     string    `json:"requirement"`
	Source          string    `json:"source"`
	AwardedAtUnixMs int64     `json:"awardedAtUnixMs"`
}

// awardOf flattens a catalogue entry with how and when an account came by it,
// so the three places that build one cannot describe the same title
// differently.
func awardOf(title Title, source string, awardedAtUnixMs int64) TitleAward {
	return TitleAward{
		ID:              title.ID,
		Name:            title.Name,
		Kind:            title.Kind,
		Pool:            title.Pool,
		Requirement:     title.Requirement,
		Source:          source,
		AwardedAtUnixMs: awardedAtUnixMs,
	}
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
	if err := store.renameTitles(ctx); err != nil {
		return err
	}
	return store.retireWithdrawnTitles(ctx)
}

// titleRenames is every id this catalogue has spelled differently in the past,
// and what it is spelled now.
//
// A rename is not a withdrawal, and that is the whole reason this exists: the
// rows below hold the award they always held, so they are carried across rather
// than left for retireWithdrawnTitles to strand. One entry, and there is no
// reason to expect a second — the reigning champion's tag used to be the crown
// glyph itself, from when two of the engine tags were symbols.
var titleRenames = []struct{ from, to TitleID }{
	{from: "♛", to: TitleReigningChampion},
}

// renameTitles carries the rows above onto the current spelling.
//
// Before retireWithdrawnTitles rather than after, so that an engine wearing the
// old id ends up wearing the new one instead of wearing nothing until the next
// sweep comes round a quarter of an hour later.
func (store *Store) renameTitles(ctx context.Context) error {
	for _, rename := range titleRenames {
		// OR IGNORE is for an account that somehow holds both: the old row
		// loses and is thereafter invisible, for the reason TitleID gives. It
		// cannot arise for the one rename there is, since RC was a new id the
		// day the glyph stopped being one — but a primary key conflict here
		// would fail every start-up after it.
		if _, err := store.db.ExecContext(ctx, `
UPDATE OR IGNORE account_titles SET title_id = ? WHERE title_id = ?
`, rename.to, rename.from); err != nil {
			return fmt.Errorf("rename title %q: %w", rename.from, err)
		}
		if _, err := store.db.ExecContext(ctx, `
UPDATE accounts SET title = ?, updated_at_unix_ms = ? WHERE title = ?
`, rename.to, time.Now().UnixMilli(), rename.from); err != nil {
			return fmt.Errorf("rename worn title %q: %w", rename.from, err)
		}
	}
	return nil
}

// retireWithdrawnTitles takes a title that has left the catalogue off the names
// still wearing it.
//
// The owned rows are left where they are. Reads resolve those through the
// catalogue and drop what they cannot find (see TitleID), so a withdrawn title
// stops appearing in a collection on its own — and if it is ever reinstated, so
// is everybody who earned it. The worn column is the one that is not read that
// way: a dozen queries select `accounts.title` straight into a tag, so an id
// left there after the catalogue has dropped it is a mark on somebody's name
// that nothing on the site can explain.
func (store *Store) retireWithdrawnTitles(ctx context.Context) error {
	placeholders := make([]string, 0, len(titleCatalogue))
	arguments := make([]any, 0, len(titleCatalogue)+1)
	arguments = append(arguments, time.Now().UnixMilli())
	for _, title := range titleCatalogue {
		placeholders = append(placeholders, "?")
		arguments = append(arguments, title.ID)
	}
	if _, err := store.db.ExecContext(ctx, `
UPDATE accounts SET title = '', updated_at_unix_ms = ?
WHERE title <> '' AND title NOT IN (`+strings.Join(placeholders, ", ")+`)
`, arguments...); err != nil {
		return fmt.Errorf("retire withdrawn titles: %w", err)
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
		awards = append(awards, awardOf(title, source, awardedAt))
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
		awarded = append(awarded, awardOf(title, TitleSourceEarned, now))
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

	// Discord has vouched for this account. The only rule in this file that
	// reads a column rather than a record: what it asks about happened at the
	// sign-in page rather than at a board, so there is nothing to count.
	verified, err := store.exists(ctx, `
SELECT 1 FROM accounts WHERE user_id = ? AND discord_user_id <> '' LIMIT 1
`, userID)
	if err != nil {
		return nil, fmt.Errorf("evaluate titles: read discord link: %w", err)
	}
	if verified {
		earned = append(earned, TitleDiscordVerified)
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

	// Owning the best engine on some mode's bot ladder, read through the board's
	// own idea of who leads a mode so that the title and the page cannot
	// disagree.
	//
	// This used to be a query of its own that matched `r.elo = (SELECT MAX(...))`
	// and it was wrong in two ways that only show up on a real board. A tie
	// against the maximum is not a rank: every engine level at the top earned
	// this, and on a board where nothing has been placed that is the whole
	// fleet. And it read raw `elo` without the placement the board sorts on
	// first, so an engine the fit could not place could out-rank the engine
	// actually listed in front. modeBoardLeaders answers the question the board
	// answers, once, for every mode.
	leaders, err := store.modeBoardLeaders(ctx)
	if err != nil {
		return nil, fmt.Errorf("evaluate titles: read bot ladder: %w", err)
	}
	for _, leader := range leaders {
		if leader.OwnerUserID == userID {
			earned = append(earned, TitleBotArchitect)
			break
		}
	}

	streak, err := store.longestWinStreak(ctx, userID)
	if err != nil {
		return nil, err
	}
	if streak >= titleWinStreakLength {
		earned = append(earned, TitleHotStreak)
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

// longestWinStreak is the longest run of wins in this account's rated games
// with nothing in between. A loss or a draw ends a run.
//
// The longest ever rather than the current one, and so a scan of the whole
// history rather than a look at the last few games. The cheaper version would
// only ever award this to a streak that finishes while the evaluator is
// watching — which would mean every run played before this title existed never
// happened, and a player who reconnects after eight straight wins is told
// nothing. Every other rule in this file is retroactive; this one costs an
// indexed scan of one player's games to be.
func (store *Store) longestWinStreak(ctx context.Context, userID string) (int, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT CASE WHEN winner_player_id = ?1 THEN 1 ELSE 0 END AS won
FROM game_history
WHERE ranked = 1 AND (red_player_id = ?1 OR blue_player_id = ?1)
ORDER BY finished_at_unix_ms, game_id
`, userID)
	if err != nil {
		return 0, fmt.Errorf("evaluate titles: read win streak: %w", err)
	}
	defer rows.Close()

	longest, current := 0, 0
	for rows.Next() {
		var won int
		if err := rows.Scan(&won); err != nil {
			return 0, fmt.Errorf("evaluate titles: read win streak: %w", err)
		}
		if won == 0 {
			current = 0
			continue
		}
		current++
		if current > longest {
			longest = current
		}
	}
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("evaluate titles: read win streak: %w", err)
	}
	return longest, nil
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
  AND t.kind <> ?
  AND (p.user_id = ? OR b.owner_user_id = ?)
`, TournamentCompleted, string(TournamentWeekend), userID, userID)
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

// Weekend arenas are excluded on purpose. Tournament Champion is a lifetime
// title for winning an event somebody organised and announced; a series that
// crowns somebody every week would hand it to every active engine inside a
// season and it would stop distinguishing anybody. The weekend arena has its
// own marker instead — see WeekendWins and the rolling crown that reads it.

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
