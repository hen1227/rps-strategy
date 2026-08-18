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
	ErrAccountNotFound = errors.New("account not found")
	memoryDatabaseID   atomic.Uint64
)

type Store struct {
	db *sql.DB
}

type Account struct {
	UserID          string `json:"userId"`
	Username        string `json:"username"`
	Elo             int    `json:"elo"`
	Wins            int    `json:"wins"`
	Losses          int    `json:"losses"`
	Draws           int    `json:"draws"`
	GamesPlayed     int    `json:"gamesPlayed"`
	CreatedAtUnixMs int64  `json:"createdAtUnixMs"`
	UpdatedAtUnixMs int64  `json:"updatedAtUnixMs"`
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
	Recorded      bool `json:"recorded"`
	Ranked        bool `json:"ranked"`
	RedEloBefore  int  `json:"redEloBefore"`
	RedEloAfter   int  `json:"redEloAfter"`
	BlueEloBefore int  `json:"blueEloBefore"`
	BlueEloAfter  int  `json:"blueEloAfter"`
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
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate sqlite database: %w", err)
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
	row := store.db.QueryRowContext(ctx, `
SELECT user_id, username, elo, wins, losses, draws, games_played,
       created_at_unix_ms, updated_at_unix_ms
FROM accounts
WHERE user_id = ?
`, strings.TrimSpace(userID))
	return scanAccount(row)
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

	redElo, err := accountEloTx(ctx, transaction, redID)
	if err != nil {
		return RatingUpdate{}, err
	}
	blueElo, err := accountEloTx(ctx, transaction, blueID)
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

	if err := updateAccountResult(
		ctx, transaction, redID, redAfter, redWins, redLosses, redDraws, finishedAt.UnixMilli(),
	); err != nil {
		return RatingUpdate{}, err
	}
	if err := updateAccountResult(
		ctx, transaction, blueID, blueAfter, blueWins, blueLosses, blueDraws, finishedAt.UnixMilli(),
	); err != nil {
		return RatingUpdate{}, err
	}
	if err := transaction.Commit(); err != nil {
		return RatingUpdate{}, fmt.Errorf("record game: commit transaction: %w", err)
	}

	return RatingUpdate{
		Recorded:      true,
		Ranked:        ranked,
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

func accountEloTx(ctx context.Context, transaction *sql.Tx, userID string) (int, error) {
	var elo int
	if err := transaction.QueryRowContext(
		ctx, "SELECT elo FROM accounts WHERE user_id = ?", userID,
	).Scan(&elo); err != nil {
		return 0, fmt.Errorf("record game: read Elo: %w", err)
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
SELECT ranked, red_elo_before, red_elo_after, blue_elo_before, blue_elo_after
FROM game_history
WHERE game_id = ?
`, gameID).Scan(
		&ranked,
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
	elo int,
	wins int,
	losses int,
	draws int,
	now int64,
) error {
	_, err := transaction.ExecContext(ctx, `
UPDATE accounts
SET elo = ?,
    wins = wins + ?,
    losses = losses + ?,
    draws = draws + ?,
    games_played = games_played + 1,
    updated_at_unix_ms = ?
WHERE user_id = ?
`, elo, wins, losses, draws, now, userID)
	if err != nil {
		return fmt.Errorf("record game: update account: %w", err)
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
