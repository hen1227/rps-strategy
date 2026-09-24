package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
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
// Ranked play moves ModeRatings; Elo is only the shared seed a mode inherits
// the first time this account finishes a game in it.
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
	// Registered reports whether this account has claimed a username and set a
	// password. An unregistered account is the anonymous browser identity the
	// game has always had, and remains fully playable.
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
// is not seeded by Total War results beyond the shared starting rating.
type ModeRating struct {
	ModeID          game.ModeID `json:"modeId"`
	Elo             int         `json:"elo"`
	Wins            int         `json:"wins"`
	Losses          int         `json:"losses"`
	Draws           int         `json:"draws"`
	GamesPlayed     int         `json:"gamesPlayed"`
	UpdatedAtUnixMs int64       `json:"updatedAtUnixMs"`
	// State is whether Elo is worth reading, and Confidence is the share of the
	// measurement it kept. See RatingState.
	State      RatingState `json:"ratingState"`
	Confidence float64     `json:"ratingConfidence"`
}

// ModeElo is the rating that decides ranked play in one mode.
//
// A mode this account has never finished a game in reads the account-level
// number beside it, which for a person is what their strongest other mode
// published as. What actually carries over when they first play the new mode is
// the strength behind that, with the uncertainty of somebody who has proved
// nothing here — see ensureModeRatingTx — so the number shown before the first
// game and the number after it are talking about the same player rather than
// about two different scales.
func (account Account) ModeElo(modeID game.ModeID) int {
	if rating, found := account.ModeRatings[modeID]; found {
		return rating.Elo
	}
	if account.Elo <= 0 {
		return RatingFloor
	}
	return account.Elo
}

// RecordRatedGame applies a finished game to an in-memory account copy, so a
// connection that stays in the lobby keeps queueing at its new mode rating
// without reloading the account.
func (account *Account) RecordRatedGame(modeID game.ModeID, elo int) {
	account.GamesPlayed++
	if account.ModeRatings == nil {
		account.ModeRatings = make(map[game.ModeID]ModeRating)
	}
	rating := account.ModeRatings[modeID]
	rating.ModeID = modeID
	rating.Elo = elo
	rating.GamesPlayed++
	account.ModeRatings[modeID] = rating
}

// SetModeElo restates one mode's rating on an in-memory account copy, leaving
// the record beside it alone.
//
// The bot ladder's counterpart to RecordRatedGame above. A refit moves the
// rating of engines that did not play, so their games and their record are
// exactly what they were and only the number in front of them is new.
func (account *Account) SetModeElo(modeID game.ModeID, elo int) {
	if account.ModeRatings == nil {
		account.ModeRatings = make(map[game.ModeID]ModeRating)
	}
	rating := account.ModeRatings[modeID]
	rating.ModeID = modeID
	rating.Elo = elo
	account.ModeRatings[modeID] = rating
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
	// The bot ladder is derived, so it is rebuilt here rather than migrated. A
	// database written by the old per-game system holds bot Elos that are a
	// different function of the same games; one pass replaces them with the fit,
	// and the same pass is the repair for any drift.
	if err := store.RefitBotLadders(context.Background()); err != nil {
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
    elo INTEGER NOT NULL DEFAULT 1 CHECK (elo >= 0),
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
    -- A person's strength and how sure of it we are, in the natural log units
    -- the rating scale is defined in. The elo column beside them is what those
    -- two publish as, stored rather than derived because it is read on every
    -- leaderboard row and an index cannot help with an expression. Unused for a
    -- bot, whose rating is a fit over the whole board rather than a state it
    -- carries -- see bot_rating.go.
    theta REAL NOT NULL DEFAULT 0,
    theta_variance REAL NOT NULL DEFAULT 0,
    -- Whether the number in the elo column is a measurement, and how much of one.
    --
    -- Both systems computed these in order to publish and then dropped them,
    -- which left RatingFloor standing for "we have not measured this" and for
    -- "we measured this and it plays no better than chance" at once. See
    -- RatingState in rating_scale.go.
    rating_placed INTEGER NOT NULL DEFAULT 0 CHECK (rating_placed IN (0, 1)),
    rating_confidence REAL NOT NULL DEFAULT 0,
    created_at_unix_ms INTEGER NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, mode_id)
);

-- Where a rating has been, as opposed to what moved it.
--
-- game_history's four Elo columns cannot answer this any more. They record what
-- a rating was when a game was played, and an engine's rating now also moves
-- when nothing is played at all: evidence decays, so a bot that stops playing
-- drifts back towards the floor with no game to hang the movement on. A series
-- of its own is the only place that drift can be seen.
--
-- One row per bot per mode per change, written by the refit when a number
-- actually moves. Not per refit: with decay the ladder is refitted on a clock,
-- and a row per pass would be a row per bot per hour for ever.
CREATE TABLE IF NOT EXISTS rating_history (
    user_id TEXT NOT NULL REFERENCES accounts(user_id) ON DELETE CASCADE,
    mode_id TEXT NOT NULL,
    rating INTEGER NOT NULL CHECK (rating >= 0),
    at_unix_ms INTEGER NOT NULL,
    PRIMARY KEY (user_id, mode_id, at_unix_ms)
);

CREATE INDEX IF NOT EXISTS rating_history_series_idx
    ON rating_history(user_id, mode_id, at_unix_ms DESC);

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
	// rating: this is what moves people off the 1200-centred scale.
	if err := store.ensureRatingScaleColumns(ctx); err != nil {
		return err
	}
	// After it, and for the same reason it runs before anything reads a rating:
	// this is what lets a rating say it is not one.
	if err := store.ensureRatingStateColumns(ctx); err != nil {
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
// Everything that still exists to serve password sign-in — the login route,
// AuthenticateAccount, the whole of password.go, and half of registeredSQL —
// can go when this reaches zero. Printing it at boot makes that moment
// something somebody notices, rather than a date guessed at in advance and
// then either missed or acted on too early.
func (store *Store) reportPasswordAccountsRemaining(ctx context.Context) {
	var remaining int
	if err := store.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM accounts WHERE `+awaitingDiscordLinkSQL(""),
	).Scan(&remaining); err != nil {
		// Not worth failing a boot over a status line.
		return
	}
	if remaining > 0 {
		log.Printf(
			"%d account(s) still sign in with a password and have not linked Discord; "+
				"password sign-in can be removed once this reaches zero",
			remaining,
		)
	}
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
`, userID, username, RatingFloor, now, now)
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
	rows, err := store.db.QueryContext(ctx, `
SELECT mode_id, elo, wins, losses, draws, games_played, updated_at_unix_ms,
       rating_placed, rating_confidence
FROM account_mode_ratings
WHERE user_id = ?
`, userID)
	if err != nil {
		return nil, fmt.Errorf("read account mode ratings: %w", err)
	}
	defer rows.Close()

	ratings := make(map[game.ModeID]ModeRating)
	for rows.Next() {
		var rating ModeRating
		var placed bool
		if err := rows.Scan(
			&rating.ModeID,
			&rating.Elo,
			&rating.Wins,
			&rating.Losses,
			&rating.Draws,
			&rating.GamesPlayed,
			&rating.UpdatedAtUnixMs,
			&placed,
			&rating.Confidence,
		); err != nil {
			return nil, fmt.Errorf("read account mode ratings: %w", err)
		}
		rating.State = RatingStateOf(placed, rating.Confidence)
		ratings[rating.ModeID] = rating
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read account mode ratings: %w", err)
	}
	return ratings, nil
}

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

	for _, userID := range []string{redID, blueID} {
		if err := ensureModeRatingTx(
			ctx, transaction, userID, state.Mode.ID, finishedAt.UnixMilli(),
		); err != nil {
			return RatingUpdate{}, err
		}
	}
	redElo, err := modeEloTx(ctx, transaction, redID, state.Mode.ID)
	if err != nil {
		return RatingUpdate{}, err
	}
	blueElo, err := modeEloTx(ctx, transaction, blueID, state.Mode.ID)
	if err != nil {
		return RatingUpdate{}, err
	}
	redScore, redWins, redLosses, redDraws, blueWins, blueLosses, blueDraws,
		winnerID, outcome, err := gameOutcome(state, redID, blueID)
	if err != nil {
		return RatingUpdate{}, err
	}

	// Two rating systems, and who played decides which one applies.
	//
	// A person's rating is a transfer between the two seats, applied here, in the
	// order games finish. An engine's is not a per-game quantity at all: it is a
	// fit over every pair's head-to-head record, so one game restates the whole
	// mode and there is no delta belonging to these two seats to write down.
	//
	// This used to run that fit inline and record its answer as the game's
	// before-and-after. It does not any more, for two reasons. The fit is now a
	// function of the clock as well as of the games — evidence decays, see
	// bot_rating.go — so a number computed at the moment a game ended is already
	// slightly wrong by the time anybody reads it, and refitting on a clock is
	// the honest model. And the fit costs a Cholesky inverse, on a database
	// pinned to one connection, which is a thing to do on a schedule rather than
	// while holding the transaction every finished game goes through.
	//
	// So an engine's row records the rating as it stood, the same number on both
	// sides, and the ladder moves when RefitBotLadder next runs — which the
	// server schedules within seconds of this returning. The alternative was to
	// keep manufacturing a per-game delta for a system that does not have one.
	redAfter, blueAfter := redElo, blueElo
	var redStrength, blueStrength *humanRating
	if ranked {
		bothBots, err := bothBotsTx(ctx, transaction, redID, blueID)
		if err != nil {
			return RatingUpdate{}, err
		}
		if !bothBots {
			redStrength, blueStrength, err = rateHumanGameTx(
				ctx, transaction, redID, blueID, state.Mode.ID,
				redScore, finishedAt.UnixMilli(),
			)
			if err != nil {
				return RatingUpdate{}, err
			}
			if redStrength != nil {
				redAfter = redStrength.published()
			}
			if blueStrength != nil {
				blueAfter = blueStrength.published()
			}
		}
	}
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
		redElo, redAfter, blueElo, blueAfter,
		state.MoveNumber, state.TimeControl.InitialTimeMs, state.TimeControl.IncrementMs,
		startedAt.UnixMilli(), finishedAt.UnixMilli(),
	)
	if err != nil {
		return RatingUpdate{}, fmt.Errorf("record game: insert history: %w", err)
	}

	for _, result := range []struct {
		userID string
		elo    int
		wins   int
		losses int
		draws  int
	}{
		{userID: redID, elo: redAfter, wins: redWins, losses: redLosses, draws: redDraws},
		{userID: blueID, elo: blueAfter, wins: blueWins, losses: blueLosses, draws: blueDraws},
	} {
		if err := updateAccountResult(
			ctx, transaction, result.userID,
			result.wins, result.losses, result.draws, finishedAt.UnixMilli(),
		); err != nil {
			return RatingUpdate{}, err
		}
		if err := updateModeRating(
			ctx, transaction, result.userID, state.Mode.ID, result.elo,
			result.wins, result.losses, result.draws, finishedAt.UnixMilli(),
		); err != nil {
			return RatingUpdate{}, err
		}
	}
	// And the strength behind the number, for whichever seats were people. The
	// loop above writes what a rating publishes as; this writes what it is.
	for _, side := range []struct {
		userID   string
		strength *humanRating
	}{
		{userID: redID, strength: redStrength},
		{userID: blueID, strength: blueStrength},
	} {
		if side.strength == nil {
			continue
		}
		if err := writeHumanRatingTx(
			ctx, transaction, side.userID, state.Mode.ID, *side.strength,
		); err != nil {
			return RatingUpdate{}, err
		}
	}
	if err := transaction.Commit(); err != nil {
		return RatingUpdate{}, fmt.Errorf("record game: commit transaction: %w", err)
	}

	return RatingUpdate{
		Recorded:      true,
		Ranked:        ranked,
		ModeID:        state.Mode.ID,
		RedEloBefore:  redElo,
		RedEloAfter:   redAfter,
		BlueEloBefore: blueElo,
		BlueEloAfter:  blueAfter,
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
       discord, discord_user_id <> '', title, appearance, elo, wins, losses,
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
`, userID, username, RatingFloor, now, now)
	if err != nil {
		return fmt.Errorf("record game: ensure account: %w", err)
	}
	return nil
}

// ensureModeRatingTx creates the rating row for one account and mode. A mode a
// player has never finished copies the account's shared rating, so switching
// modes does not reset a player to the default.
func ensureModeRatingTx(
	ctx context.Context,
	transaction *sql.Tx,
	userID string,
	modeID game.ModeID,
	now int64,
) error {
	// The new row starts from whichever mode this account is best established
	// in, with the uncertainty of somebody who has proved nothing here.
	//
	// Both halves matter. Carrying the strength over is the existing intent —
	// a player's first game in a new mode should start where the rest of their
	// play left off rather than from scratch — and it is a good guess, because
	// somebody strong at one mode is rarely hopeless at another. Carrying the
	// full initial variance with it is what stops that guess from being a claim:
	// the shrinkage publishes the new mode near the floor until it has been
	// played, so what actually transfers is a head start on converging rather
	// than a rating.
	//
	// Best established rather than highest, deliberately. Seeding from the
	// player's best number would let somebody manufacture a flattering start in
	// every mode by getting lucky in one, which is the same farm this whole
	// system exists to close, just wearing a different hat.
	// The strength carried over from whichever mode this account is best
	// established in.
	//
	// Read first and inserted second rather than done in one statement, because
	// what goes in the published column has to be the shrunk value of what goes
	// in the strength column, and that shrink is a formula this package owns
	// rather than something to restate in SQL. It used to copy `accounts.elo`
	// straight across, which on this scale would put a number in front of a
	// player that no strength of theirs backs — the first game in the mode would
	// then appear to move them from 130 to 18 for winning.
	var carried float64
	err := transaction.QueryRowContext(ctx, `
SELECT COALESCE((SELECT r.theta FROM account_mode_ratings r
                  WHERE r.user_id = ? AND r.theta_variance > 0
                  ORDER BY r.theta_variance ASC, r.mode_id ASC
                  LIMIT 1), 0)
`, userID).Scan(&carried)
	if err != nil {
		return fmt.Errorf("record game: read carried strength: %w", err)
	}
	seeded := humanRating{theta: carried, variance: humanInitialVariance}

	if _, err := transaction.ExecContext(ctx, `
INSERT INTO account_mode_ratings (
    user_id, mode_id, elo, theta, theta_variance, created_at_unix_ms, updated_at_unix_ms
)
SELECT a.user_id, ?, ?, ?, ?, ?, ?
FROM accounts a
WHERE a.user_id = ?
ON CONFLICT(user_id, mode_id) DO NOTHING
`, modeID, seeded.published(), seeded.theta, seeded.variance, now, now, userID,
	); err != nil {
		return fmt.Errorf("record game: ensure mode rating: %w", err)
	}
	return nil
}

func modeEloTx(
	ctx context.Context,
	transaction *sql.Tx,
	userID string,
	modeID game.ModeID,
) (int, error) {
	var elo int
	if err := transaction.QueryRowContext(
		ctx,
		"SELECT elo FROM account_mode_ratings WHERE user_id = ? AND mode_id = ?",
		userID, modeID,
	).Scan(&elo); err != nil {
		return 0, fmt.Errorf("record game: read mode Elo: %w", err)
	}
	return elo, nil
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

// rateHumanGameTx applies a ranked game that had at least one person in it,
// returning the new strength of each seat that was one.
//
// Three shapes reach this, and the third is the interesting one.
//
// Two people is the ordinary case: a mutual Bayesian update, both sides computed
// from the other's pre-game state. See human_rating.go for why it is not the
// fixed-K transfer this replaced — briefly, a transfer needs a reservoir of
// points and a scale everybody starts at the bottom of does not have one.
//
// A person against one of the server's yardstick engines is the case that makes
// the two boards comparable at all. The engine's rating is a fixed point that
// also fixes every bot rating, so a person measured against it is measured on
// the same scale as the engines without any human-versus-community-bot ranked
// play having to exist. Only the person moves: a yardstick is frozen by
// definition, and a bot's rating comes from the ladder fit rather than from
// anything that happens here.
//
// A person against somebody else's engine does not reach this at all — those
// games are casual, because an author can tune an engine to lose and a rating
// that could be handed out by its owner is not one.
func rateHumanGameTx(
	ctx context.Context,
	transaction *sql.Tx,
	redID string,
	blueID string,
	modeID game.ModeID,
	redScore float64,
	now int64,
) (*humanRating, *humanRating, error) {
	redIsBot, err := accountIsBotTx(ctx, transaction, redID)
	if err != nil {
		return nil, nil, err
	}
	blueIsBot, err := accountIsBotTx(ctx, transaction, blueID)
	if err != nil {
		return nil, nil, err
	}

	side := func(userID string, isBot bool) (humanRating, error) {
		if !isBot {
			return humanRatingTx(ctx, transaction, userID, modeID)
		}
		// The engine's side of a calibration game: exactly where the ladder puts
		// it, with no uncertainty. See anchoredRating.
		rating, err := modeEloTx(ctx, transaction, userID, modeID)
		if err != nil {
			return humanRating{}, err
		}
		return anchoredRating(rating), nil
	}
	red, err := side(redID, redIsBot)
	if err != nil {
		return nil, nil, err
	}
	blue, err := side(blueID, blueIsBot)
	if err != nil {
		return nil, nil, err
	}

	updatedRed, updatedBlue := updateHumanRatings(red, blue, redScore, now)
	var redResult, blueResult *humanRating
	if !redIsBot {
		redResult = &updatedRed
	}
	if !blueIsBot {
		blueResult = &updatedBlue
	}
	return redResult, blueResult, nil
}

// accountIsBotTx reports whether one account is an engine.
func accountIsBotTx(
	ctx context.Context,
	transaction *sql.Tx,
	userID string,
) (bool, error) {
	var kind string
	if err := transaction.QueryRowContext(ctx,
		"SELECT kind FROM accounts WHERE user_id = ?", userID,
	).Scan(&kind); err != nil {
		return false, fmt.Errorf("record game: read account kind: %w", err)
	}
	return kind == AccountKindBot, nil
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

func updateModeRating(
	ctx context.Context,
	transaction *sql.Tx,
	userID string,
	modeID game.ModeID,
	elo int,
	wins int,
	losses int,
	draws int,
	now int64,
) error {
	_, err := transaction.ExecContext(ctx, `
UPDATE account_mode_ratings
SET elo = ?,
    wins = wins + ?,
    losses = losses + ?,
    draws = draws + ?,
    games_played = games_played + 1,
    updated_at_unix_ms = ?
WHERE user_id = ? AND mode_id = ?
`, elo, wins, losses, draws, now, userID, modeID)
	if err != nil {
		return fmt.Errorf("record game: update mode rating: %w", err)
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
