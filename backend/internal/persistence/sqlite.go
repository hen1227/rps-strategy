package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"math"
	"strings"
	"sync/atomic"
	"time"

	_ "modernc.org/sqlite"

	"rps-strategy/backend/internal/game"
)

const (
	// AccountKindHuman and AccountKindBot are the two values of accounts.kind.
	// A bot is a full account so that ratings, history, the archive, and
	// spectating all work through the paths they already work through; this
	// column is the only thing that tells the two apart.
	AccountKindHuman = "human"
	AccountKindBot   = "bot"
)

var (
	ErrAccountNotFound       = errors.New("account not found")
	ErrInvalidProfileKey     = errors.New("invalid profile key")
	ErrInvalidAccountProfile = errors.New("invalid account profile")
	memoryDatabaseID         atomic.Uint64
)

type Store struct {
	db *sql.DB
}

// Account holds one player's identity and lifetime totals across every mode.
// Ranked play moves ModeRatings; Elo is the account's headline rating, its best
// rated mode or RatingStart before it has one (see headlineRatingSQL).
// Account is serialized straight to JSON on GET /api/accounts/{userID} and
// inside connection_ready, so no credential may ever become a field here.
// Password material and bot keys live in their own unexported structs, read by
// their own queries.
type Account struct {
	UserID string `json:"userId"`
	// Kind is "human" or "bot". A bot has an ordinary account so that ratings,
	// history, spectating, and the archive all work without a parallel code
	// path; this is the only thing that distinguishes it.
	Kind     string `json:"kind"`
	Username string `json:"username"`
	// Registered reports whether this account can sign in: a linked Discord or
	// Apple ID, or one of the remaining passwords. An unregistered account is
	// the anonymous browser identity the game has always had, and remains fully
	// playable. Which of those it is stays with its owner — see SignInMethods.
	Registered bool   `json:"registered"`
	IsAdmin    bool   `json:"isAdmin"`
	Disabled   bool   `json:"disabled"`
	Discord    string `json:"discord"`
	// DiscordVerified reports whether Discord vouched for the handle above,
	// rather than the player having typed it. Only a verified handle is proof
	// of anything, and only a verified one is read-only in the profile editor.
	DiscordVerified bool `json:"discordVerified"`
	// Title is the tag worn in front of the name — "GM", "DEV" — and empty for
	// the great majority of accounts, which wear none. Titles is everything
	// this account has collected, in catalogue order, which is what the picker
	// on the account page chooses from. See titles.go.
	Title  TitleID      `json:"title,omitempty"`
	Titles []TitleAward `json:"titles,omitempty"`
	// Appearance is the look this player chose — theme, board, piece set and
	// sound pack — as the JSON object the client sent, verbatim. Empty for an
	// account that has never chosen, which is the great majority. The server
	// does not know what any of these ids mean and must not: see
	// SetAccountAppearance.
	Appearance      string                     `json:"appearance,omitempty"`
	Elo             int                        `json:"elo"`
	Wins            int                        `json:"wins"`
	Losses          int                        `json:"losses"`
	Draws           int                        `json:"draws"`
	GamesPlayed     int                        `json:"gamesPlayed"`
	ModeRatings     map[game.ModeID]ModeRating `json:"modeRatings"`
	CreatedAtUnixMs int64                      `json:"createdAtUnixMs"`
	UpdatedAtUnixMs int64                      `json:"updatedAtUnixMs"`
}

// ModeRating is an account's rating and record inside a single game mode. Every
// mode rates independently, so a strong Total War player entering Infiltration
// starts there as a newcomer.
type ModeRating struct {
	ModeID game.ModeID `json:"modeId"`
	// Elo is the published rating: Strength less Deviation, the number every
	// board sorts on. See rating.go.
	Elo             int   `json:"elo"`
	Wins            int   `json:"wins"`
	Losses          int   `json:"losses"`
	Draws           int   `json:"draws"`
	GamesPlayed     int   `json:"gamesPlayed"`
	UpdatedAtUnixMs int64 `json:"updatedAtUnixMs"`
	// RatedGames is how many ranked games the rating is built from, and State is
	// how far it can be trusted. GamesPlayed above counts casual games too.
	RatedGames int         `json:"ratedGames"`
	State      RatingState `json:"ratingState"`
	// Strength and Deviation are the Glicko-2 estimate behind Elo, rounded.
	// Matchmaking pairs on Strength, so a newcomer meets players of the strength
	// they are assumed to have rather than of the number they start on.
	Strength  int `json:"strength"`
	Deviation int `json:"deviation"`
}

// ModeElo is the published rating in one mode, and RatingStart for a mode this
// account has never played.
func (account Account) ModeElo(modeID game.ModeID) int {
	if rating, found := account.ModeRatings[modeID]; found {
		return rating.Elo
	}
	return RatingStart
}

// ModeStrength is the strength matchmaking pairs on in one mode: the estimate
// behind the published number, and the middle of the scale for a mode this
// account has never played.
func (account Account) ModeStrength(modeID game.ModeID) int {
	if rating, found := account.ModeRatings[modeID]; found && rating.Strength > 0 {
		return rating.Strength
	}
	return int(ratingStartStrength)
}

// SetModeRating restates one mode on an in-memory account copy, so a
// connection that stays in the lobby keeps queueing, and keeps being listed, at
// its current rating without reloading the account. The headline rating moves
// with it.
func (account *Account) SetModeRating(rating ModeRating) {
	if account.ModeRatings == nil {
		account.ModeRatings = make(map[game.ModeID]ModeRating)
	}
	account.ModeRatings[rating.ModeID] = rating
	headline := RatingStart
	rated := false
	for _, mode := range account.ModeRatings {
		if mode.RatedGames > 0 && (!rated || mode.Elo > headline) {
			headline, rated = mode.Elo, true
		}
	}
	account.Elo = headline
}

type RecordedPlayer struct {
	UserID    string `json:"userId"`
	Username  string `json:"username"`
	EloBefore int    `json:"eloBefore"`
	EloAfter  int    `json:"eloAfter"`
}

type GameRecord struct {
	GameID           string             `json:"gameId"`
	ModeID           game.ModeID        `json:"modeId"`
	ModeName         string             `json:"modeName"`
	RedPlayer        RecordedPlayer     `json:"redPlayer"`
	BluePlayer       RecordedPlayer     `json:"bluePlayer"`
	WinnerUserID     *string            `json:"winnerUserId"`
	WinnerColor      game.PlayerColor   `json:"winnerColor"`
	Outcome          string             `json:"outcome"`
	EndReason        game.GameEndReason `json:"endReason"`
	Ranked           bool               `json:"ranked"`
	MoveNumber       int                `json:"moveNumber"`
	InitialTimeMs    int64              `json:"initialTimeMs"`
	IncrementMs      int64              `json:"incrementMs"`
	StartedAtUnixMs  int64              `json:"startedAtUnixMs"`
	FinishedAtUnixMs int64              `json:"finishedAtUnixMs"`
}

type HeadToHeadRecord struct {
	Player1     Account `json:"player1"`
	Player2     Account `json:"player2"`
	Player1Wins int     `json:"player1Wins"`
	Player2Wins int     `json:"player2Wins"`
	Draws       int     `json:"draws"`
	GamesPlayed int     `json:"gamesPlayed"`
}

type RatingUpdate struct {
	Recorded      bool        `json:"recorded"`
	Ranked        bool        `json:"ranked"`
	ModeID        game.ModeID `json:"modeId"`
	RedEloBefore  int         `json:"redEloBefore"`
	RedEloAfter   int         `json:"redEloAfter"`
	BlueEloBefore int         `json:"blueEloBefore"`
	BlueEloAfter  int         `json:"blueEloAfter"`
	// RedRating and BlueRating are each seat's whole mode row after the game,
	// for the server to patch the accounts it holds in memory. Not sent: the
	// four numbers above are what a client is told.
	RedRating  ModeRating `json:"-"`
	BlueRating ModeRating `json:"-"`
}

func Open(path string) (*Store, error) {
	path = strings.TrimSpace(path)
	if path == "" {
		return nil, errors.New("open sqlite database: path is required")
	}
	if path == ":memory:" {
		path = fmt.Sprintf(
			"file:rps-strategy-memory-%d?mode=memory&cache=shared",
			memoryDatabaseID.Add(1),
		)
	}

	database, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite database: %w", err)
	}
	// A single connection avoids surprising in-memory database boundaries and
	// serializes rating transactions, which must be applied exactly once.
	database.SetMaxOpenConns(1)
	database.SetMaxIdleConns(1)

	store := &Store{db: database}
	if err := store.initialize(context.Background()); err != nil {
		_ = database.Close()
		return nil, err
	}
	// Every rating is a function of the games on record, so it is rebuilt here
	// rather than migrated: a database written under an older rating system
	// holds numbers that are a different function of the same games, and one
	// replay replaces them. The same pass is the repair for any drift.
	if err := store.RebuildRatings(context.Background()); err != nil {
		_ = database.Close()
		return nil, err
	}
	return store, nil
}

func (store *Store) Close() error {
	if store == nil || store.db == nil {
		return nil
	}
	return store.db.Close()
}

func (store *Store) initialize(ctx context.Context) error {
	for _, statement := range []string{
		"PRAGMA foreign_keys = ON",
		"PRAGMA busy_timeout = 5000",
		"PRAGMA journal_mode = WAL",
	} {
		if _, err := store.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("configure sqlite database: %w", err)
		}
	}

	const schema = `
CREATE TABLE IF NOT EXISTS accounts (
    user_id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    discord TEXT NOT NULL DEFAULT '',
    profile_key_hash TEXT NOT NULL DEFAULT '',
    elo INTEGER NOT NULL DEFAULT 1150 CHECK (elo >= 0),
    wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
    losses INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
    draws INTEGER NOT NULL DEFAULT 0 CHECK (draws >= 0),
    games_played INTEGER NOT NULL DEFAULT 0 CHECK (games_played >= 0),
    created_at_unix_ms INTEGER NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS game_history (
    game_id TEXT PRIMARY KEY,
    mode_id TEXT NOT NULL,
    mode_name TEXT NOT NULL,
    red_player_id TEXT NOT NULL REFERENCES accounts(user_id),
    red_username TEXT NOT NULL,
    blue_player_id TEXT NOT NULL REFERENCES accounts(user_id),
    blue_username TEXT NOT NULL,
    winner_player_id TEXT REFERENCES accounts(user_id),
    winner_color TEXT NOT NULL CHECK (winner_color IN ('Red', 'Blue', 'Neutral')),
    outcome TEXT NOT NULL CHECK (outcome IN ('red_win', 'blue_win', 'draw')),
    end_reason TEXT NOT NULL,
    ranked INTEGER NOT NULL CHECK (ranked IN (0, 1)),
    red_elo_before INTEGER NOT NULL,
    red_elo_after INTEGER NOT NULL,
    blue_elo_before INTEGER NOT NULL,
    blue_elo_after INTEGER NOT NULL,
    move_number INTEGER NOT NULL,
    initial_time_ms INTEGER NOT NULL,
    increment_ms INTEGER NOT NULL,
    started_at_unix_ms INTEGER NOT NULL,
    finished_at_unix_ms INTEGER NOT NULL,
    CHECK (red_player_id <> blue_player_id),
    CHECK (winner_player_id IS NULL OR winner_player_id IN (red_player_id, blue_player_id))
);

CREATE INDEX IF NOT EXISTS game_history_red_finished_idx
    ON game_history(red_player_id, finished_at_unix_ms DESC);
CREATE INDEX IF NOT EXISTS game_history_blue_finished_idx
    ON game_history(blue_player_id, finished_at_unix_ms DESC);
CREATE INDEX IF NOT EXISTS game_history_head_to_head_idx
    ON game_history(red_player_id, blue_player_id, finished_at_unix_ms DESC);

CREATE TABLE IF NOT EXISTS account_mode_ratings (
    user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    mode_id TEXT NOT NULL,
    elo INTEGER NOT NULL CHECK (elo >= 0),
    wins INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
    losses INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
    draws INTEGER NOT NULL DEFAULT 0 CHECK (draws >= 0),
    games_played INTEGER NOT NULL DEFAULT 0 CHECK (games_played >= 0),
    -- The rating: Glicko-2's strength, deviation and volatility on the 1500
    -- scale, how many ranked games built it, and when the last one finished.
    -- The elo column above is the number those publish as, stored because
    -- every board sorts on it. See rating.go.
    strength REAL NOT NULL DEFAULT 1500,
    deviation REAL NOT NULL DEFAULT 350,
    volatility REAL NOT NULL DEFAULT 0.06,
    rated_games INTEGER NOT NULL DEFAULT 0 CHECK (rated_games >= 0),
    last_rated_at_unix_ms INTEGER NOT NULL DEFAULT 0,
    created_at_unix_ms INTEGER NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, mode_id)
);

CREATE TABLE IF NOT EXISTS tournaments (
    tournament_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mode_id TEXT NOT NULL,
    mode_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'registration'
        CHECK (status IN ('registration', 'in_progress', 'completed')),
    created_at_unix_ms INTEGER NOT NULL,
    started_at_unix_ms INTEGER,
    completed_at_unix_ms INTEGER
);

CREATE TABLE IF NOT EXISTS tournament_players (
    player_id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id TEXT NOT NULL REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    ign TEXT NOT NULL COLLATE NOCASE,
    discord TEXT NOT NULL,
    agreed_to_unfiltered_chat INTEGER NOT NULL
        CHECK (agreed_to_unfiltered_chat = 1),
    signup_order INTEGER NOT NULL,
    joined_at_unix_ms INTEGER NOT NULL,
    UNIQUE (tournament_id, user_id),
    UNIQUE (tournament_id, ign),
    UNIQUE (tournament_id, signup_order)
);

CREATE TABLE IF NOT EXISTS tournament_matches (
    match_id INTEGER PRIMARY KEY AUTOINCREMENT,
    tournament_id TEXT NOT NULL REFERENCES tournaments(tournament_id) ON DELETE CASCADE,
    round_number INTEGER NOT NULL CHECK (round_number > 0),
    match_order INTEGER NOT NULL CHECK (match_order > 0),
    player1_id INTEGER NOT NULL REFERENCES tournament_players(player_id),
    player2_id INTEGER NOT NULL REFERENCES tournament_players(player_id),
    result TEXT NOT NULL DEFAULT 'pending'
        CHECK (result IN ('pending', 'player1_win', 'player2_win', 'draw')),
    winner_player_id INTEGER REFERENCES tournament_players(player_id),
    game_id TEXT,
    updated_at_unix_ms INTEGER NOT NULL,
    CHECK (player1_id <> player2_id),
    CHECK (winner_player_id IS NULL OR winner_player_id IN (player1_id, player2_id)),
    UNIQUE (tournament_id, match_order)
);

CREATE INDEX IF NOT EXISTS tournament_players_tournament_idx
    ON tournament_players(tournament_id, signup_order);
CREATE INDEX IF NOT EXISTS tournament_matches_tournament_idx
    ON tournament_matches(tournament_id, match_order);
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate sqlite database: %w", err)
	}
	if err := store.ensureAccountProfileColumns(ctx); err != nil {
		return err
	}
	// Must follow ensureAccountProfileColumns: both migrate `accounts`, and
	// the auth step's partial unique index depends on a column it adds.
	if err := store.ensureAccountAuthColumns(ctx); err != nil {
		return err
	}
	// Straight after the auth columns, which hold the Discord links it copies
	// in, and before anything reads an account: registeredSQL, and with it every
	// account read, asks this table. See account_identity.go.
	if err := store.ensureIdentitySchema(ctx); err != nil {
		return err
	}
	// After it, because its trigger watches that table.
	if err := store.ensureIdentityRevocationSchema(ctx); err != nil {
		return err
	}
	// Before anything asks awaitingIdentityLinkSQL, which reads this table — the
	// count at the end of this function among them. See store_review.go.
	if err := store.ensureStoreReviewSchema(ctx); err != nil {
		return err
	}
	// After ensureAccountProfileColumns, which adds the `title` column this
	// table's rows are chosen into.
	if err := store.ensureTitleSchema(ctx); err != nil {
		return err
	}
	if err := store.ensureTournamentMatchColumns(ctx); err != nil {
		return err
	}
	// After the match columns, and before anything reads a tournament: this is
	// what adds the configuration the builder writes and backfills publication
	// onto the events that predate it.
	if err := store.ensureTournamentConfigSchema(ctx); err != nil {
		return err
	}
	if err := store.ensureArchiveSchema(ctx); err != nil {
		return err
	}
	if err := store.ensureAccuracySchema(ctx); err != nil {
		return err
	}
	if err := store.ensureOpeningBookSchema(ctx); err != nil {
		return err
	}
	if err := store.ensureOpeningGraphSchema(ctx); err != nil {
		return err
	}
	if err := store.ensureOpeningStatsSchema(ctx); err != nil {
		return err
	}
	if err := store.ensurePushSchema(ctx); err != nil {
		return err
	}
	// Last, because bots reference accounts and the auth migration is what
	// gives accounts the columns a bot account needs.
	if err := store.ensureBotSchema(ctx); err != nil {
		return err
	}
	// After the account and rating tables exist, and before anything reads a
	// rating. The numbers in the new columns are written by the replay that
	// Open runs once this returns.
	if err := store.ensureRatingColumns(ctx); err != nil {
		return err
	}
	if err := store.ensureRatingSystemSchema(ctx); err != nil {
		return err
	}
	if err := store.ensureLadderPoolSchema(ctx); err != nil {
		return err
	}
	// After ensureBotSchema, whose `accounts` rows the ledger's foreign key
	// points at, and beside the pool because both are the ranked ladder's own
	// memory. See bot_reigns.go.
	if err := store.ensureBotReignSchema(ctx); err != nil {
		return err
	}
	if err := store.ensureBotSeriesSchema(ctx); err != nil {
		return err
	}
	// Anywhere at all: the bench schedule references nothing and nothing
	// references it. See bot_bench.go.
	if err := store.ensureBotBenchSchema(ctx); err != nil {
		return err
	}
	// After the tournament config migration, which is what adds the `kind`
	// column the weekend arena writes into.
	if err := store.ensureWeekendSchema(ctx); err != nil {
		return err
	}
	// After the auth migration, which is what creates `is_admin`.
	if err := store.ensureOwnerIsAdmin(ctx); err != nil {
		return err
	}
	// Anywhere after `accounts` exists, which is the only table it references.
	if err := store.ensureModerationSchema(ctx); err != nil {
		return err
	}
	// Beside it, and for the same reason: both ends of a block are accounts.
	if err := store.ensureBlockSchema(ctx); err != nil {
		return err
	}
	// Anywhere at all. A report references nobody — deliberately, so that a
	// report about an account somebody later purges survives the purge. See
	// ensureReportSchema.
	if err := store.ensureReportSchema(ctx); err != nil {
		return err
	}
	// Beside the report queue, and for the same reason: the feedback board
	// references nobody either. A deleted account's posts stay and are
	// rewritten to "Deleted player" — see AnonymizeFeedbackAuthorshipTx — so a
	// cascade here would remove half of every conversation that account was in.
	if err := store.ensureFeedbackSchema(ctx); err != nil {
		return err
	}
	store.reportPasswordAccountsRemaining(ctx)
	return nil
}

// reportPasswordAccountsRemaining logs how much of the password era is left.
//
// Printing it at boot makes the moment the last legacy account links an
// identity something somebody notices, rather than a date guessed at in advance
// and then either missed or acted on too early.
//
// That moment no longer means password sign-in can go. The store review
// accounts sign in with one too, for as long as the app is in the stores — see
// store_review.go. What reaching zero frees is what exists only for the legacy
// accounts: the paths that link an identity to a password account, and the
// prompt that asks for it. The login route, AuthenticateAccount and password.go
// stay.
func (store *Store) reportPasswordAccountsRemaining(ctx context.Context) {
	legacy, review, err := store.passwordAccountCounts(ctx)
	if err != nil {
		// Not worth failing a boot over a status line.
		return
	}
	switch {
	case legacy > 0:
		log.Printf(
			"%d account(s) still sign in with a password and have not linked Discord or Apple; "+
				"the legacy link paths can be removed once this reaches zero",
			legacy,
		)
	case review > 0:
		log.Printf(
			"password sign-in is only used by the %d store review account(s) now; "+
				"the legacy link paths can be removed",
			review,
		)
	}
}

// passwordAccountCounts splits the accounts that sign in with a password by why
// they do: a legacy account that has not linked an identity yet, or a store
// review account that never will.
func (store *Store) passwordAccountCounts(ctx context.Context) (int, int, error) {
	var legacy, review int
	if err := store.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM accounts WHERE `+awaitingIdentityLinkSQL(""),
	).Scan(&legacy); err != nil {
		return 0, 0, fmt.Errorf("count legacy password accounts: %w", err)
	}
	// Joined rather than counted off the label table alone, because a label
	// still points at the row a reviewer's deletion anonymized, and that row
	// signs in with nothing.
	if err := store.db.QueryRowContext(ctx, `
SELECT COUNT(*) FROM store_review_accounts r
JOIN accounts a ON a.user_id = r.user_id
WHERE a.username_lower <> ''
`).Scan(&review); err != nil {
		return 0, 0, fmt.Errorf("count store review accounts: %w", err)
	}
	return legacy, review, nil
}

func (store *Store) EnsureAccount(
	ctx context.Context,
	userID string,
	username string,
) (Account, error) {
	userID, username, err := normalizeIdentity(userID, username)
	if err != nil {
		return Account{}, err
	}
	now := time.Now().UnixMilli()
	_, err = store.db.ExecContext(ctx, `
INSERT INTO accounts (
    user_id, username, elo, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(user_id) DO UPDATE SET
    username = CASE
        WHEN excluded.username = 'Guest' THEN accounts.username
        ELSE excluded.username
    END,
    updated_at_unix_ms = excluded.updated_at_unix_ms
`, userID, username, RatingStart, now, now)
	if err != nil {
		return Account{}, fmt.Errorf("ensure account: %w", err)
	}
	return store.Account(ctx, userID)
}

func (store *Store) Account(ctx context.Context, userID string) (Account, error) {
	userID = strings.TrimSpace(userID)
	account, err := scanAccount(store.db.QueryRowContext(ctx, accountSelect+`
WHERE user_id = ?
`, userID))
	if err != nil {
		return Account{}, err
	}
	account.ModeRatings, err = store.modeRatings(ctx, userID)
	if err != nil {
		return Account{}, err
	}
	// Loaded with the account rather than fetched separately, because every
	// place that shows a title already has an Account in hand: the lobby
	// handshake, the profile page, the admin browser. A player with no titles
	// gets a nil slice, which is omitted from the wire entirely.
	account.Titles, err = store.AccountTitles(ctx, userID)
	if err != nil {
		return Account{}, err
	}
	return account, nil
}

func (store *Store) modeRatings(
	ctx context.Context,
	userID string,
) (map[game.ModeID]ModeRating, error) {
	rows, err := store.db.QueryContext(ctx,
		"SELECT "+modeRatingColumns+" FROM account_mode_ratings WHERE user_id = ?", userID,
	)
	if err != nil {
		return nil, fmt.Errorf("read account mode ratings: %w", err)
	}
	defer rows.Close()

	now := time.Now().UnixMilli()
	ratings := make(map[game.ModeID]ModeRating)
	for rows.Next() {
		rating, err := scanModeRating(rows, now)
		if err != nil {
			return nil, fmt.Errorf("read account mode ratings: %w", err)
		}
		ratings[rating.ModeID] = rating
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read account mode ratings: %w", err)
	}
	return ratings, nil
}

// modeRatingColumns is the column list scanModeRating reads, in its order.
const modeRatingColumns = `mode_id, elo, wins, losses, draws, games_played, updated_at_unix_ms,
       strength, deviation, volatility, rated_games, last_rated_at_unix_ms`

// scanModeRating reads one rating row, working out what it publishes as at
// `now` from the rating behind it.
func scanModeRating(scanner interface{ Scan(...any) error }, now int64) (ModeRating, error) {
	var rating ModeRating
	var glicko glickoRating
	if err := scanner.Scan(
		&rating.ModeID, &rating.Elo,
		&rating.Wins, &rating.Losses, &rating.Draws, &rating.GamesPlayed,
		&rating.UpdatedAtUnixMs,
		&glicko.strength, &glicko.deviation, &glicko.volatility,
		&glicko.games, &glicko.lastGameAt,
	); err != nil {
		return ModeRating{}, err
	}
	rating.RatedGames = glicko.games
	rating.State = glicko.state(now)
	rating.Strength = int(math.Round(glicko.strength))
	rating.Deviation = int(math.Round(glicko.aged(now).deviation))
	return rating, nil
}

// modeRatingTx reads one account's row in one mode.
func modeRatingTx(
	ctx context.Context,
	transaction *sql.Tx,
	userID string,
	modeID game.ModeID,
	now int64,
) (ModeRating, error) {
	rating, err := scanModeRating(transaction.QueryRowContext(ctx,
		"SELECT "+modeRatingColumns+" FROM account_mode_ratings WHERE user_id = ? AND mode_id = ?",
		userID, modeID,
	), now)
	if err != nil {
		return ModeRating{}, fmt.Errorf("read mode rating: %w", err)
	}
	return rating, nil
}

// ModeRatings is every account's row in one mode, by user id, for a caller that
// holds accounts in memory and needs to bring them up to date.
func (store *Store) ModeRatings(
	ctx context.Context,
	modeID game.ModeID,
) (map[string]ModeRating, error) {
	rows, err := store.db.QueryContext(ctx,
		"SELECT user_id, "+modeRatingColumns+" FROM account_mode_ratings WHERE mode_id = ?",
		modeID,
	)
	if err != nil {
		return nil, fmt.Errorf("read mode ratings: %w", err)
	}
	defer rows.Close()
	now := time.Now().UnixMilli()
	ratings := make(map[string]ModeRating)
	for rows.Next() {
		var userID string
		rating, err := scanModeRating(scanFunc(func(destinations ...any) error {
			return rows.Scan(append([]any{&userID}, destinations...)...)
		}), now)
		if err != nil {
			return nil, fmt.Errorf("read mode rating: %w", err)
		}
		ratings[userID] = rating
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read mode ratings: %w", err)
	}
	return ratings, nil
}

// scanFunc adapts a function to the Scan method the row readers take, for a
// query with a column in front of the ones a reader expects.
type scanFunc func(...any) error

func (scan scanFunc) Scan(destinations ...any) error { return scan(destinations...) }

func (store *Store) RecordCompletedGame(
	ctx context.Context,
	state game.GameState,
	startedAt time.Time,
	finishedAt time.Time,
	ranked bool,
) (RatingUpdate, error) {
	if state.Status != game.Finished {
		return RatingUpdate{}, errors.New("record game: game is not finished")
	}
	if state.RedPlayer.UserID == state.BluePlayer.UserID {
		return RatingUpdate{}, errors.New("record game: players must have different accounts")
	}
	if startedAt.IsZero() {
		startedAt = finishedAt
	}
	if finishedAt.IsZero() {
		finishedAt = time.Now()
	}

	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return RatingUpdate{}, fmt.Errorf("record game: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	if existing, found, err := existingRatingUpdate(ctx, transaction, state.GameID); err != nil {
		return RatingUpdate{}, err
	} else if found {
		return existing, nil
	}

	redID, redName, err := normalizeIdentity(state.RedPlayer.UserID, state.RedPlayer.Username)
	if err != nil {
		return RatingUpdate{}, fmt.Errorf("record game: red player: %w", err)
	}
	blueID, blueName, err := normalizeIdentity(state.BluePlayer.UserID, state.BluePlayer.Username)
	if err != nil {
		return RatingUpdate{}, fmt.Errorf("record game: blue player: %w", err)
	}
	if err := ensureAccountTx(ctx, transaction, redID, redName, finishedAt.UnixMilli()); err != nil {
		return RatingUpdate{}, err
	}
	if err := ensureAccountTx(ctx, transaction, blueID, blueName, finishedAt.UnixMilli()); err != nil {
		return RatingUpdate{}, err
	}

	at := finishedAt.UnixMilli()
	for _, userID := range []string{redID, blueID} {
		if err := ensureModeRatingTx(ctx, transaction, userID, state.Mode.ID, at); err != nil {
			return RatingUpdate{}, err
		}
	}
	red, err := ratingTx(ctx, transaction, redID, state.Mode.ID)
	if err != nil {
		return RatingUpdate{}, err
	}
	blue, err := ratingTx(ctx, transaction, blueID, state.Mode.ID)
	if err != nil {
		return RatingUpdate{}, err
	}
	redScore, redWins, redLosses, redDraws, blueWins, blueLosses, blueDraws,
		winnerID, outcome, err := gameOutcome(state, redID, blueID)
	if err != nil {
		return RatingUpdate{}, err
	}

	// One rating system for everybody. A ranked game moves both seats, by the
	// same rule the replay applies (see rateRecordedGame), so recording a game
	// and replaying the record cannot disagree. The one ranked game that moves
	// nothing is between two engines one person registered.
	shared := false
	if ranked {
		if shared, err = sameBotOwnerTx(ctx, transaction, redID, blueID); err != nil {
			return RatingUpdate{}, err
		}
	}
	red, blue, recorded := rateRecordedGame(red, blue, recordedGame{
		gameID: state.GameID, modeID: state.Mode.ID,
		redID: redID, blueID: blueID, finishedAt: at,
		rated: ranked && !shared, redScore: redScore,
	})
	rankedInteger := 0
	if ranked {
		rankedInteger = 1
	}

	_, err = transaction.ExecContext(ctx, `
INSERT INTO game_history (
    game_id, mode_id, mode_name,
    red_player_id, red_username, blue_player_id, blue_username,
    winner_player_id, winner_color, outcome, end_reason, ranked,
    red_elo_before, red_elo_after, blue_elo_before, blue_elo_after,
    move_number, initial_time_ms, increment_ms,
    started_at_unix_ms, finished_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`,
		state.GameID, state.Mode.ID, state.Mode.Name,
		redID, redName, blueID, blueName,
		winnerID, state.Winner, outcome, state.EndReason, rankedInteger,
		recorded.redBefore, recorded.redAfter, recorded.blueBefore, recorded.blueAfter,
		state.MoveNumber, state.TimeControl.InitialTimeMs, state.TimeControl.IncrementMs,
		startedAt.UnixMilli(), at,
	)
	if err != nil {
		return RatingUpdate{}, fmt.Errorf("record game: insert history: %w", err)
	}

	for _, result := range []struct {
		userID string
		rating glickoRating
		wins   int
		losses int
		draws  int
	}{
		{userID: redID, rating: red, wins: redWins, losses: redLosses, draws: redDraws},
		{userID: blueID, rating: blue, wins: blueWins, losses: blueLosses, draws: blueDraws},
	} {
		if err := updateAccountResult(
			ctx, transaction, result.userID,
			result.wins, result.losses, result.draws, at,
		); err != nil {
			return RatingUpdate{}, err
		}
		if err := updateModeRecord(
			ctx, transaction, result.userID, state.Mode.ID,
			result.wins, result.losses, result.draws, at,
		); err != nil {
			return RatingUpdate{}, err
		}
		if err := writeRatingTx(ctx, transaction,
			ratingKey{userID: result.userID, modeID: state.Mode.ID}, result.rating, at,
		); err != nil {
			return RatingUpdate{}, err
		}
	}
	if err := refreshHeadlineRatingsTx(ctx, transaction, redID, blueID); err != nil {
		return RatingUpdate{}, err
	}
	redRating, err := modeRatingTx(ctx, transaction, redID, state.Mode.ID, at)
	if err != nil {
		return RatingUpdate{}, err
	}
	blueRating, err := modeRatingTx(ctx, transaction, blueID, state.Mode.ID, at)
	if err != nil {
		return RatingUpdate{}, err
	}
	if err := transaction.Commit(); err != nil {
		return RatingUpdate{}, fmt.Errorf("record game: commit transaction: %w", err)
	}

	return RatingUpdate{
		Recorded:      true,
		Ranked:        ranked,
		ModeID:        state.Mode.ID,
		RedEloBefore:  recorded.redBefore,
		RedEloAfter:   recorded.redAfter,
		BlueEloBefore: recorded.blueBefore,
		BlueEloAfter:  recorded.blueAfter,
		RedRating:     redRating,
		BlueRating:    blueRating,
	}, nil
}

func (store *Store) GameHistory(
	ctx context.Context,
	userID string,
	limit int,
	offset int,
) ([]GameRecord, error) {
	userID = strings.TrimSpace(userID)
	if _, err := store.Account(ctx, userID); err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 20
	}
	if limit > 100 {
		limit = 100
	}
	if offset < 0 {
		offset = 0
	}

	rows, err := store.db.QueryContext(ctx, gameRecordSelect+`
WHERE red_player_id = ? OR blue_player_id = ?
ORDER BY finished_at_unix_ms DESC, game_id DESC
LIMIT ? OFFSET ?
`, userID, userID, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("query game history: %w", err)
	}
	defer rows.Close()

	records := make([]GameRecord, 0)
	for rows.Next() {
		record, err := scanGameRecord(rows)
		if err != nil {
			return nil, err
		}
		records = append(records, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("query game history: %w", err)
	}
	return records, nil
}

func (store *Store) HeadToHead(
	ctx context.Context,
	player1ID string,
	player2ID string,
) (HeadToHeadRecord, error) {
	player1, err := store.Account(ctx, player1ID)
	if err != nil {
		return HeadToHeadRecord{}, err
	}
	player2, err := store.Account(ctx, player2ID)
	if err != nil {
		return HeadToHeadRecord{}, err
	}

	record := HeadToHeadRecord{Player1: player1, Player2: player2}
	err = store.db.QueryRowContext(ctx, `
SELECT
    COALESCE(SUM(CASE WHEN winner_player_id = ? THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN winner_player_id = ? THEN 1 ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN winner_player_id IS NULL THEN 1 ELSE 0 END), 0),
    COUNT(*)
FROM game_history
WHERE (red_player_id = ? AND blue_player_id = ?)
   OR (red_player_id = ? AND blue_player_id = ?)
`, player1.UserID, player2.UserID,
		player1.UserID, player2.UserID, player2.UserID, player1.UserID,
	).Scan(&record.Player1Wins, &record.Player2Wins, &record.Draws, &record.GamesPlayed)
	if err != nil {
		return HeadToHeadRecord{}, fmt.Errorf("query head-to-head record: %w", err)
	}
	return record, nil
}

func normalizeIdentity(userID string, username string) (string, string, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" || len(userID) > 128 {
		return "", "", errors.New("user ID must be between 1 and 128 characters")
	}
	username = strings.TrimSpace(username)
	if username == "" {
		username = "Guest"
	}
	characters := []rune(username)
	if len(characters) > 40 {
		username = string(characters[:40])
	}
	return userID, username, nil
}

// accountSelect is the one column list every account read uses, so a new
// column cannot be added to some reads and forgotten in others. `registered`
// is derived here rather than stored, because a second column saying so could
// disagree with the first — and what it means lives in registeredSQL rather
// than being spelled out here, because the same rule is asked in four other
// places and they have already drifted apart once.
var accountSelect = `
SELECT user_id, kind, username, ` + registeredSQL("") + `, is_admin, disabled,
       discord, ` + discordVerifiedSQL("") + `, title, appearance, elo, wins, losses,
       draws, games_played, created_at_unix_ms, updated_at_unix_ms
FROM accounts`

func scanAccount(scanner interface{ Scan(...any) error }) (Account, error) {
	var account Account
	err := scanner.Scan(
		&account.UserID,
		&account.Kind,
		&account.Username,
		&account.Registered,
		&account.IsAdmin,
		&account.Disabled,
		&account.Discord,
		&account.DiscordVerified,
		&account.Title,
		&account.Appearance,
		&account.Elo,
		&account.Wins,
		&account.Losses,
		&account.Draws,
		&account.GamesPlayed,
		&account.CreatedAtUnixMs,
		&account.UpdatedAtUnixMs,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Account{}, ErrAccountNotFound
	}
	if err != nil {
		return Account{}, fmt.Errorf("read account: %w", err)
	}
	return account, nil
}

func ensureAccountTx(
	ctx context.Context,
	transaction *sql.Tx,
	userID string,
	username string,
	now int64,
) error {
	_, err := transaction.ExecContext(ctx, `
INSERT INTO accounts (
    user_id, username, elo, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?)
ON CONFLICT(user_id) DO NOTHING
`, userID, username, RatingStart, now, now)
	if err != nil {
		return fmt.Errorf("record game: ensure account: %w", err)
	}
	return nil
}

// ensureModeRatingTx creates the rating row for one account and mode, at a
// newcomer's rating: modes rate independently, so nothing carries over.
func ensureModeRatingTx(
	ctx context.Context,
	transaction *sql.Tx,
	userID string,
	modeID game.ModeID,
	now int64,
) error {
	fresh := newGlickoRating()
	if _, err := transaction.ExecContext(ctx, `
INSERT INTO account_mode_ratings (
    user_id, mode_id, elo, strength, deviation, volatility,
    created_at_unix_ms, updated_at_unix_ms
)
SELECT a.user_id, ?, ?, ?, ?, ?, ?, ?
FROM accounts a
WHERE a.user_id = ?
ON CONFLICT(user_id, mode_id) DO NOTHING
`, modeID, fresh.shown(now), fresh.strength, fresh.deviation, fresh.volatility,
		now, now, userID,
	); err != nil {
		return fmt.Errorf("record game: ensure mode rating: %w", err)
	}
	return nil
}

// ratingTx reads the rating behind one account's row in one mode.
func ratingTx(
	ctx context.Context,
	transaction *sql.Tx,
	userID string,
	modeID game.ModeID,
) (glickoRating, error) {
	var rating glickoRating
	if err := transaction.QueryRowContext(ctx, `
SELECT strength, deviation, volatility, rated_games, last_rated_at_unix_ms
FROM account_mode_ratings WHERE user_id = ? AND mode_id = ?
`, userID, modeID).Scan(
		&rating.strength, &rating.deviation, &rating.volatility,
		&rating.games, &rating.lastGameAt,
	); err != nil {
		return glickoRating{}, fmt.Errorf("record game: read rating: %w", err)
	}
	return rating, nil
}

// ensureRatingColumns adds the rating columns to a database from before them.
// Their defaults are a newcomer's rating, and the replay Open runs next writes
// the real ones.
func (store *Store) ensureRatingColumns(ctx context.Context) error {
	columns, err := tableColumns(ctx, store.db, "account_mode_ratings")
	if err != nil {
		return fmt.Errorf("inspect rating schema: %w", err)
	}
	for _, column := range []struct{ name, definition string }{
		{"strength", "REAL NOT NULL DEFAULT 1500"},
		{"deviation", "REAL NOT NULL DEFAULT 350"},
		{"volatility", "REAL NOT NULL DEFAULT 0.06"},
		{"rated_games", "INTEGER NOT NULL DEFAULT 0 CHECK (rated_games >= 0)"},
		{"last_rated_at_unix_ms", "INTEGER NOT NULL DEFAULT 0"},
	} {
		if columns[column.name] {
			continue
		}
		if _, err := store.db.ExecContext(ctx,
			"ALTER TABLE account_mode_ratings ADD COLUMN "+column.name+" "+column.definition,
		); err != nil {
			return fmt.Errorf("add rating column %s: %w", column.name, err)
		}
	}
	return nil
}

func existingRatingUpdate(
	ctx context.Context,
	transaction *sql.Tx,
	gameID string,
) (RatingUpdate, bool, error) {
	var update RatingUpdate
	var ranked int
	err := transaction.QueryRowContext(ctx, `
SELECT ranked, mode_id, red_elo_before, red_elo_after, blue_elo_before, blue_elo_after
FROM game_history
WHERE game_id = ?
`, gameID).Scan(
		&ranked,
		&update.ModeID,
		&update.RedEloBefore,
		&update.RedEloAfter,
		&update.BlueEloBefore,
		&update.BlueEloAfter,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return RatingUpdate{}, false, nil
	}
	if err != nil {
		return RatingUpdate{}, false, fmt.Errorf("record game: check existing history: %w", err)
	}
	update.Ranked = ranked == 1
	return update, true, nil
}

func gameOutcome(
	state game.GameState,
	redID string,
	blueID string,
) (
	redScore float64,
	redWins int,
	redLosses int,
	redDraws int,
	blueWins int,
	blueLosses int,
	blueDraws int,
	winnerID any,
	outcome string,
	err error,
) {
	switch state.Winner {
	case game.Red:
		return 1, 1, 0, 0, 0, 1, 0, redID, "red_win", nil
	case game.Blue:
		return 0, 0, 1, 0, 1, 0, 0, blueID, "blue_win", nil
	case game.Neutral:
		return 0.5, 0, 0, 1, 0, 0, 1, nil, "draw", nil
	default:
		return 0, 0, 0, 0, 0, 0, 0, nil, "", errors.New("record game: invalid winner")
	}
}

func updateAccountResult(
	ctx context.Context,
	transaction *sql.Tx,
	userID string,
	wins int,
	losses int,
	draws int,
	now int64,
) error {
	_, err := transaction.ExecContext(ctx, `
UPDATE accounts
SET wins = wins + ?,
    losses = losses + ?,
    draws = draws + ?,
    games_played = games_played + 1,
    updated_at_unix_ms = ?
WHERE user_id = ?
`, wins, losses, draws, now, userID)
	if err != nil {
		return fmt.Errorf("record game: update account: %w", err)
	}
	return nil
}

// updateModeRecord adds one game to an account's record in one mode. The
// rating beside it is written by writeRatingTx.
func updateModeRecord(
	ctx context.Context,
	transaction *sql.Tx,
	userID string,
	modeID game.ModeID,
	wins int,
	losses int,
	draws int,
	now int64,
) error {
	_, err := transaction.ExecContext(ctx, `
UPDATE account_mode_ratings
SET wins = wins + ?,
    losses = losses + ?,
    draws = draws + ?,
    games_played = games_played + 1,
    updated_at_unix_ms = ?
WHERE user_id = ? AND mode_id = ?
`, wins, losses, draws, now, userID, modeID)
	if err != nil {
		return fmt.Errorf("record game: update mode record: %w", err)
	}
	return nil
}

// gameRecordColumns is the column list scanGameRecord expects, in its order.
//
// Named separately from the query below because one other caller needs these
// same columns out of a *joined* select — BotMatches, which filters on both
// players being bots — and reading them in a different order would misfile
// every field without failing. Sharing the list is what stops that.
const gameRecordColumns = `game_id, mode_id, mode_name,
       red_player_id, red_username, blue_player_id, blue_username,
       winner_player_id, winner_color, outcome, end_reason, ranked,
       red_elo_before, red_elo_after, blue_elo_before, blue_elo_after,
       move_number, initial_time_ms, increment_ms,
       started_at_unix_ms, finished_at_unix_ms`

const gameRecordSelect = `
SELECT ` + gameRecordColumns + `
FROM game_history
`

func scanGameRecord(scanner interface{ Scan(...any) error }) (GameRecord, error) {
	var record GameRecord
	var winnerID sql.NullString
	var ranked int
	err := scanner.Scan(
		&record.GameID,
		&record.ModeID,
		&record.ModeName,
		&record.RedPlayer.UserID,
		&record.RedPlayer.Username,
		&record.BluePlayer.UserID,
		&record.BluePlayer.Username,
		&winnerID,
		&record.WinnerColor,
		&record.Outcome,
		&record.EndReason,
		&ranked,
		&record.RedPlayer.EloBefore,
		&record.RedPlayer.EloAfter,
		&record.BluePlayer.EloBefore,
		&record.BluePlayer.EloAfter,
		&record.MoveNumber,
		&record.InitialTimeMs,
		&record.IncrementMs,
		&record.StartedAtUnixMs,
		&record.FinishedAtUnixMs,
	)
	if err != nil {
		return GameRecord{}, fmt.Errorf("read game history: %w", err)
	}
	if winnerID.Valid {
		record.WinnerUserID = &winnerID.String
	}
	record.Ranked = ranked == 1
	return record, nil
}
