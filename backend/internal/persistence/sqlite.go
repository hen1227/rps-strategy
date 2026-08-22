package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"math"
	"strings"
	"sync/atomic"
	"time"

	_ "modernc.org/sqlite"

	"rps-strategy/backend/internal/game"
)

const (
	DefaultElo = 1200
	EloKFactor = 32
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
type Account struct {
	UserID          string                     `json:"userId"`
	Username        string                     `json:"username"`
	Discord         string                     `json:"discord"`
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
}

// ModeElo is the rating that decides ranked play in one mode. A mode this
// account has never finished a game in inherits the shared seed rating, so a
// player's first game in a new mode starts where the rest of their play left
// off instead of at the default.
func (account Account) ModeElo(modeID game.ModeID) int {
	if rating, found := account.ModeRatings[modeID]; found {
		return rating.Elo
	}
	if account.Elo <= 0 {
		return DefaultElo
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
    elo INTEGER NOT NULL DEFAULT 1200 CHECK (elo >= 0),
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
	if err := store.ensureTournamentMatchColumns(ctx); err != nil {
		return err
	}
	if err := store.ensureArchiveSchema(ctx); err != nil {
		return err
	}
	return nil
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
`, userID, username, DefaultElo, now, now)
	if err != nil {
		return Account{}, fmt.Errorf("ensure account: %w", err)
	}
	return store.Account(ctx, userID)
}

func (store *Store) Account(ctx context.Context, userID string) (Account, error) {
	userID = strings.TrimSpace(userID)
	account, err := scanAccount(store.db.QueryRowContext(ctx, `
SELECT user_id, username, discord, elo, wins, losses, draws, games_played,
       created_at_unix_ms, updated_at_unix_ms
FROM accounts
WHERE user_id = ?
`, userID))
	if err != nil {
		return Account{}, err
	}
	account.ModeRatings, err = store.modeRatings(ctx, userID)
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
SELECT mode_id, elo, wins, losses, draws, games_played, updated_at_unix_ms
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
		if err := rows.Scan(
			&rating.ModeID,
			&rating.Elo,
			&rating.Wins,
			&rating.Losses,
			&rating.Draws,
			&rating.GamesPlayed,
			&rating.UpdatedAtUnixMs,
		); err != nil {
			return nil, fmt.Errorf("read account mode ratings: %w", err)
		}
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

	redAfter, blueAfter := redElo, blueElo
	if ranked {
		redAfter, blueAfter = calculateElo(redElo, blueElo, redScore)
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

func scanAccount(scanner interface{ Scan(...any) error }) (Account, error) {
	var account Account
	err := scanner.Scan(
		&account.UserID,
		&account.Username,
		&account.Discord,
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
`, userID, username, DefaultElo, now, now)
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
	_, err := transaction.ExecContext(ctx, `
INSERT INTO account_mode_ratings (
    user_id, mode_id, elo, created_at_unix_ms, updated_at_unix_ms
)
SELECT user_id, ?, elo, ?, ?
FROM accounts
WHERE user_id = ?
ON CONFLICT(user_id, mode_id) DO NOTHING
`, modeID, now, now, userID)
	if err != nil {
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

func calculateElo(redElo int, blueElo int, redScore float64) (int, int) {
	expectedRed := 1 / (1 + math.Pow(10, float64(blueElo-redElo)/400))
	delta := int(math.Round(EloKFactor * (redScore - expectedRed)))
	if delta > blueElo {
		delta = blueElo
	}
	if -delta > redElo {
		delta = -redElo
	}
	return redElo + delta, blueElo - delta
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

const gameRecordSelect = `
SELECT game_id, mode_id, mode_name,
       red_player_id, red_username, blue_player_id, blue_username,
       winner_player_id, winner_color, outcome, end_reason, ranked,
       red_elo_before, red_elo_after, blue_elo_before, blue_elo_after,
       move_number, initial_time_ms, increment_ms,
       started_at_unix_ms, finished_at_unix_ms
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
