package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/notation"
)

var ErrGamePGNNotFound = errors.New("game record not found")

// ArchivedGame is one finished game kept in full. The PGN column is the whole
// game — moves, clocks, proposals, and ending — so the remaining columns exist
// only to select games without parsing every record.
//
// This table deliberately has no foreign keys onto accounts. Every game that
// finishes is archived, including unranked, private, and tournament games, and
// including games whose rating transaction could not be committed.
type ArchivedGame struct {
	GameID           string             `json:"gameId"`
	ModeID           game.ModeID        `json:"modeId"`
	ModeName         string             `json:"modeName"`
	RedPlayerID      string             `json:"redPlayerId"`
	RedUsername      string             `json:"redUsername"`
	BluePlayerID     string             `json:"bluePlayerId"`
	BlueUsername     string             `json:"blueUsername"`
	WinnerColor      game.PlayerColor   `json:"winnerColor"`
	Outcome          string             `json:"outcome"`
	EndReason        game.GameEndReason `json:"endReason"`
	Ranked           bool               `json:"ranked"`
	TournamentID     string             `json:"tournamentId,omitempty"`
	PlyCount         int                `json:"plyCount"`
	InitialTimeMs    int64              `json:"initialTimeMs"`
	IncrementMs      int64              `json:"incrementMs"`
	StartedAtUnixMs  int64              `json:"startedAtUnixMs"`
	FinishedAtUnixMs int64              `json:"finishedAtUnixMs"`
	RecordedAtUnixMs int64              `json:"recordedAtUnixMs"`
	PGN              string             `json:"pgn"`
}

// ArchiveFilter selects a slice of the archive for export. Zero values mean
// "no bound", and the ordering is stable — oldest first, game ID breaking
// ties — so a training pipeline can page through with an offset and see every
// game exactly once.
type ArchiveFilter struct {
	SinceUnixMs int64
	UntilUnixMs int64
	ModeID      game.ModeID
	Ranked      *bool
	Limit       int
	Offset      int
}

const archivedGameSelect = `
SELECT game_id, mode_id, mode_name,
       red_player_id, red_username, blue_player_id, blue_username,
       winner_color, outcome, end_reason, ranked, tournament_id,
       ply_count, initial_time_ms, increment_ms,
       started_at_unix_ms, finished_at_unix_ms, recorded_at_unix_ms, pgn
FROM game_pgn
`

func (store *Store) ensureArchiveSchema(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS game_pgn (
    game_id TEXT PRIMARY KEY,
    mode_id TEXT NOT NULL,
    mode_name TEXT NOT NULL DEFAULT '',
    red_player_id TEXT NOT NULL,
    red_username TEXT NOT NULL,
    blue_player_id TEXT NOT NULL,
    blue_username TEXT NOT NULL,
    winner_color TEXT NOT NULL CHECK (winner_color IN ('Red', 'Blue', 'Neutral')),
    outcome TEXT NOT NULL CHECK (outcome IN ('red_win', 'blue_win', 'draw', 'unfinished')),
    end_reason TEXT NOT NULL,
    ranked INTEGER NOT NULL CHECK (ranked IN (0, 1)),
    tournament_id TEXT NOT NULL DEFAULT '',
    ply_count INTEGER NOT NULL,
    initial_time_ms INTEGER NOT NULL,
    increment_ms INTEGER NOT NULL,
    started_at_unix_ms INTEGER NOT NULL,
    finished_at_unix_ms INTEGER NOT NULL,
    recorded_at_unix_ms INTEGER NOT NULL,
    pgn TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS game_pgn_finished_idx
    ON game_pgn(finished_at_unix_ms, game_id);
CREATE INDEX IF NOT EXISTS game_pgn_red_idx
    ON game_pgn(red_player_id, finished_at_unix_ms DESC);
CREATE INDEX IF NOT EXISTS game_pgn_blue_idx
    ON game_pgn(blue_player_id, finished_at_unix_ms DESC);
CREATE INDEX IF NOT EXISTS game_pgn_mode_idx
    ON game_pgn(mode_id, finished_at_unix_ms DESC);
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate game archive: %w", err)
	}
	return nil
}

// ArchiveGame writes a game's PGN. Like the rating transaction it is keyed on
// the game ID and ignores a repeat, so a game cannot be archived twice and a
// retry is harmless.
//
// A game that has not finished is archived as it stands, with the "*" result
// PGN uses for an unterminated game. Shutting the server down mid-game is the
// case that matters: the moves that were played are still data.
func (store *Store) ArchiveGame(
	ctx context.Context,
	record game.Record,
	metadata notation.Metadata,
	tournamentID string,
) (ArchivedGame, error) {
	if strings.TrimSpace(record.GameID) == "" {
		return ArchivedGame{}, errors.New("archive game: game id is required")
	}
	finishedAt := metadata.FinishedAt
	if finishedAt.IsZero() {
		finishedAt = time.Now()
		metadata.FinishedAt = finishedAt
	}
	metadata.TournamentID = tournamentID

	archived := ArchivedGame{
		GameID:           record.GameID,
		ModeID:           record.Mode.ID,
		ModeName:         record.Mode.Name,
		RedPlayerID:      record.RedPlayer.UserID,
		RedUsername:      record.RedPlayer.Username,
		BluePlayerID:     record.BluePlayer.UserID,
		BlueUsername:     record.BluePlayer.Username,
		WinnerColor:      record.Final.Winner,
		Outcome:          outcomeFor(record.Final),
		EndReason:        record.Final.EndReason,
		Ranked:           metadata.Ranked,
		TournamentID:     tournamentID,
		PlyCount:         record.PlyCount(),
		InitialTimeMs:    record.TimeControl.InitialTimeMs,
		IncrementMs:      record.TimeControl.IncrementMs,
		StartedAtUnixMs:  record.StartedAtUnixMs,
		FinishedAtUnixMs: finishedAt.UnixMilli(),
		RecordedAtUnixMs: time.Now().UnixMilli(),
		PGN:              notation.Encode(record, metadata),
	}

	rankedInteger := 0
	if archived.Ranked {
		rankedInteger = 1
	}
	_, err := store.db.ExecContext(ctx, `
INSERT INTO game_pgn (
    game_id, mode_id, mode_name,
    red_player_id, red_username, blue_player_id, blue_username,
    winner_color, outcome, end_reason, ranked, tournament_id,
    ply_count, initial_time_ms, increment_ms,
    started_at_unix_ms, finished_at_unix_ms, recorded_at_unix_ms, pgn
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(game_id) DO NOTHING
`,
		archived.GameID, archived.ModeID, archived.ModeName,
		archived.RedPlayerID, archived.RedUsername,
		archived.BluePlayerID, archived.BlueUsername,
		archived.WinnerColor, archived.Outcome, archived.EndReason,
		rankedInteger, archived.TournamentID,
		archived.PlyCount, archived.InitialTimeMs, archived.IncrementMs,
		archived.StartedAtUnixMs, archived.FinishedAtUnixMs,
		archived.RecordedAtUnixMs, archived.PGN,
	)
	if err != nil {
		return ArchivedGame{}, fmt.Errorf("archive game: %w", err)
	}
	return archived, nil
}

func outcomeFor(state game.GameState) string {
	if state.Status != game.Finished {
		return "unfinished"
	}
	switch state.Winner {
	case game.Red:
		return "red_win"
	case game.Blue:
		return "blue_win"
	default:
		return "draw"
	}
}

func (store *Store) ArchivedGame(ctx context.Context, gameID string) (ArchivedGame, error) {
	gameID = strings.TrimSpace(gameID)
	row := store.db.QueryRowContext(ctx, archivedGameSelect+"WHERE game_id = ?", gameID)
	archived, err := scanArchivedGame(row)
	if errors.Is(err, sql.ErrNoRows) {
		return ArchivedGame{}, fmt.Errorf("%w: %s", ErrGamePGNNotFound, gameID)
	}
	return archived, err
}

// AccountArchivedGames returns one player's games, newest first.
func (store *Store) AccountArchivedGames(
	ctx context.Context,
	userID string,
	limit int,
	offset int,
) ([]ArchivedGame, error) {
	userID = strings.TrimSpace(userID)
	limit, offset = boundedPage(limit, offset, 20, 200)
	rows, err := store.db.QueryContext(ctx, archivedGameSelect+`
WHERE red_player_id = ? OR blue_player_id = ?
ORDER BY finished_at_unix_ms DESC, game_id DESC
LIMIT ? OFFSET ?
`, userID, userID, limit, offset)
	if err != nil {
		return nil, fmt.Errorf("query archived games: %w", err)
	}
	return collectArchivedGames(rows)
}

// ExportArchivedGames pages through the archive oldest first, which is the
// order a training set is built in.
func (store *Store) ExportArchivedGames(
	ctx context.Context,
	filter ArchiveFilter,
) ([]ArchivedGame, error) {
	conditions := make([]string, 0, 4)
	arguments := make([]any, 0, 6)
	if filter.SinceUnixMs > 0 {
		conditions = append(conditions, "finished_at_unix_ms >= ?")
		arguments = append(arguments, filter.SinceUnixMs)
	}
	if filter.UntilUnixMs > 0 {
		conditions = append(conditions, "finished_at_unix_ms < ?")
		arguments = append(arguments, filter.UntilUnixMs)
	}
	if filter.ModeID != "" {
		conditions = append(conditions, "mode_id = ?")
		arguments = append(arguments, string(filter.ModeID))
	}
	if filter.Ranked != nil {
		ranked := 0
		if *filter.Ranked {
			ranked = 1
		}
		conditions = append(conditions, "ranked = ?")
		arguments = append(arguments, ranked)
	}
	query := archivedGameSelect
	if len(conditions) > 0 {
		query += "WHERE " + strings.Join(conditions, " AND ") + "\n"
	}
	limit, offset := boundedPage(filter.Limit, filter.Offset, 100, 1000)
	query += "ORDER BY finished_at_unix_ms ASC, game_id ASC\nLIMIT ? OFFSET ?"
	arguments = append(arguments, limit, offset)

	rows, err := store.db.QueryContext(ctx, query, arguments...)
	if err != nil {
		return nil, fmt.Errorf("export archived games: %w", err)
	}
	return collectArchivedGames(rows)
}

// CountArchivedGames reports how many games are stored, so an export client
// knows how far it has to page.
func (store *Store) CountArchivedGames(ctx context.Context) (int, error) {
	var total int
	err := store.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM game_pgn").Scan(&total)
	if err != nil {
		return 0, fmt.Errorf("count archived games: %w", err)
	}
	return total, nil
}

func boundedPage(limit, offset, fallback, maximum int) (int, int) {
	if limit <= 0 {
		limit = fallback
	}
	if limit > maximum {
		limit = maximum
	}
	if offset < 0 {
		offset = 0
	}
	return limit, offset
}

type rowScanner interface {
	Scan(destination ...any) error
}

func scanArchivedGame(scanner rowScanner) (ArchivedGame, error) {
	var archived ArchivedGame
	var ranked int
	err := scanner.Scan(
		&archived.GameID, &archived.ModeID, &archived.ModeName,
		&archived.RedPlayerID, &archived.RedUsername,
		&archived.BluePlayerID, &archived.BlueUsername,
		&archived.WinnerColor, &archived.Outcome, &archived.EndReason,
		&ranked, &archived.TournamentID,
		&archived.PlyCount, &archived.InitialTimeMs, &archived.IncrementMs,
		&archived.StartedAtUnixMs, &archived.FinishedAtUnixMs,
		&archived.RecordedAtUnixMs, &archived.PGN,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return ArchivedGame{}, err
		}
		return ArchivedGame{}, fmt.Errorf("read archived game: %w", err)
	}
	archived.Ranked = ranked == 1
	return archived, nil
}

func collectArchivedGames(rows *sql.Rows) ([]ArchivedGame, error) {
	defer rows.Close()
	archived := make([]ArchivedGame, 0)
	for rows.Next() {
		record, err := scanArchivedGame(rows)
		if err != nil {
			return nil, err
		}
		archived = append(archived, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read archived games: %w", err)
	}
	return archived, nil
}

// ArchiveFile concatenates records into one PGN file, which is the form every
// PGN reader expects an archive in.
func ArchiveFile(games []ArchivedGame) string {
	builder := strings.Builder{}
	for _, archived := range games {
		builder.WriteString(archived.PGN)
		builder.WriteString("\n")
	}
	return builder.String()
}
