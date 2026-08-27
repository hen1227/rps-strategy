package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"rps-strategy/backend/internal/game"
)

var (
	ErrAccuracyNotAPlayer  = errors.New("that account did not play this game as that colour")
	ErrInvalidAccuracy     = errors.New("invalid accuracy report")
	ErrAccuracyGameUnknown = ErrGamePGNNotFound
)

// GameAccuracy is one player's move accuracy for one archived game.
//
// The numbers are measured in the browser, by the same engine build the player
// was watching, and this table records that claim rather than adjudicating it.
// That is defensible only because nothing depends on it: no rating, no
// matchmaking, no ranking reads this. `ReportedBy` and the engine settings are
// stored so a later server-side recomputation can be compared with what the
// client said, and so a report made with a shallow search is never mistaken
// for one made with a deep one.
type GameAccuracy struct {
	GameID                string           `json:"gameId"`
	Color                 game.PlayerColor `json:"color"`
	UserID                string           `json:"userId"`
	Accuracy              float64          `json:"accuracy"`
	AverageLossPercent    float64          `json:"averageLossPercent"`
	AverageLossCentipawns float64          `json:"averageLossCentipawns"`
	MoveCount             int              `json:"moveCount"`
	BestMoves             int              `json:"bestMoves"`
	ExcellentMoves        int              `json:"excellentMoves"`
	GoodMoves             int              `json:"goodMoves"`
	Inaccuracies          int              `json:"inaccuracies"`
	Mistakes              int              `json:"mistakes"`
	Blunders              int              `json:"blunders"`
	EnginePreset          string           `json:"enginePreset"`
	EngineMaxDepth        int              `json:"engineMaxDepth"`
	EngineMaxNodes        int64            `json:"engineMaxNodes"`
	EngineMaxTimeMs       int64            `json:"engineMaxTimeMs"`
	EngineVariations      int              `json:"engineVariations"`
	ReportedBy            string           `json:"reportedBy"`
	RecordedAtUnixMs      int64            `json:"recordedAtUnixMs"`
}

const gameAccuracySelect = `
SELECT game_id, color, user_id, accuracy,
       average_loss_percent, average_loss_centipawns, move_count,
       best_moves, excellent_moves, good_moves, inaccuracies, mistakes, blunders,
       engine_preset, engine_max_depth, engine_max_nodes, engine_max_time_ms,
       engine_variations, reported_by, recorded_at_unix_ms
FROM game_accuracy
`

func (store *Store) ensureAccuracySchema(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS game_accuracy (
    game_id TEXT NOT NULL,
    color TEXT NOT NULL CHECK (color IN ('Red', 'Blue')),
    user_id TEXT NOT NULL,
    accuracy REAL NOT NULL,
    average_loss_percent REAL NOT NULL,
    average_loss_centipawns REAL NOT NULL,
    move_count INTEGER NOT NULL,
    best_moves INTEGER NOT NULL DEFAULT 0,
    excellent_moves INTEGER NOT NULL DEFAULT 0,
    good_moves INTEGER NOT NULL DEFAULT 0,
    inaccuracies INTEGER NOT NULL DEFAULT 0,
    mistakes INTEGER NOT NULL DEFAULT 0,
    blunders INTEGER NOT NULL DEFAULT 0,
    engine_preset TEXT NOT NULL DEFAULT '',
    engine_max_depth INTEGER NOT NULL DEFAULT 0,
    engine_max_nodes INTEGER NOT NULL DEFAULT 0,
    engine_max_time_ms INTEGER NOT NULL DEFAULT 0,
    engine_variations INTEGER NOT NULL DEFAULT 0,
    reported_by TEXT NOT NULL DEFAULT '',
    recorded_at_unix_ms INTEGER NOT NULL,
    PRIMARY KEY (game_id, color)
);

CREATE INDEX IF NOT EXISTS game_accuracy_user_idx
    ON game_accuracy(user_id, recorded_at_unix_ms DESC);
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate game accuracy: %w", err)
	}
	return nil
}

// RecordGameAccuracy stores one player's review of one archived game.
//
// The colour decides whose report this is, and the game decides who that
// colour was: a caller cannot claim an accuracy for a game they did not play.
// Verifying the reporter is the route's job, because only it has the key.
//
// A repeat replaces the previous report rather than being ignored. Reviewing
// again — at a greater depth, or after the engine improves — should be able to
// correct a number, and the stored engine settings say which review a stored
// number came from.
func (store *Store) RecordGameAccuracy(
	ctx context.Context,
	report GameAccuracy,
) (GameAccuracy, error) {
	report.GameID = strings.TrimSpace(report.GameID)
	if report.GameID == "" {
		return GameAccuracy{}, fmt.Errorf("%w: game id is required", ErrInvalidAccuracy)
	}
	if report.Color != game.Red && report.Color != game.Blue {
		return GameAccuracy{}, fmt.Errorf("%w: colour must be Red or Blue", ErrInvalidAccuracy)
	}
	if report.Accuracy < 0 || report.Accuracy > 100 {
		return GameAccuracy{}, fmt.Errorf("%w: accuracy must be between 0 and 100", ErrInvalidAccuracy)
	}
	if report.MoveCount <= 0 {
		return GameAccuracy{}, fmt.Errorf("%w: a review covers at least one move", ErrInvalidAccuracy)
	}
	report.RecordedAtUnixMs = time.Now().UnixMilli()

	if _, err := store.db.ExecContext(ctx, `
INSERT INTO game_accuracy (
    game_id, color, user_id, accuracy,
    average_loss_percent, average_loss_centipawns, move_count,
    best_moves, excellent_moves, good_moves, inaccuracies, mistakes, blunders,
    engine_preset, engine_max_depth, engine_max_nodes, engine_max_time_ms,
    engine_variations, reported_by, recorded_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(game_id, color) DO UPDATE SET
    user_id = excluded.user_id,
    accuracy = excluded.accuracy,
    average_loss_percent = excluded.average_loss_percent,
    average_loss_centipawns = excluded.average_loss_centipawns,
    move_count = excluded.move_count,
    best_moves = excluded.best_moves,
    excellent_moves = excluded.excellent_moves,
    good_moves = excluded.good_moves,
    inaccuracies = excluded.inaccuracies,
    mistakes = excluded.mistakes,
    blunders = excluded.blunders,
    engine_preset = excluded.engine_preset,
    engine_max_depth = excluded.engine_max_depth,
    engine_max_nodes = excluded.engine_max_nodes,
    engine_max_time_ms = excluded.engine_max_time_ms,
    engine_variations = excluded.engine_variations,
    reported_by = excluded.reported_by,
    recorded_at_unix_ms = excluded.recorded_at_unix_ms
`,
		report.GameID, report.Color, report.UserID, report.Accuracy,
		report.AverageLossPercent, report.AverageLossCentipawns, report.MoveCount,
		report.BestMoves, report.ExcellentMoves, report.GoodMoves,
		report.Inaccuracies, report.Mistakes, report.Blunders,
		report.EnginePreset, report.EngineMaxDepth, report.EngineMaxNodes,
		report.EngineMaxTimeMs, report.EngineVariations,
		report.ReportedBy, report.RecordedAtUnixMs,
	); err != nil {
		return GameAccuracy{}, fmt.Errorf("record game accuracy: %w", err)
	}
	return report, nil
}

// GameAccuracies returns whatever has been reviewed for a game, in colour
// order, which is normally nothing, one side, or both.
func (store *Store) GameAccuracies(ctx context.Context, gameID string) ([]GameAccuracy, error) {
	rows, err := store.db.QueryContext(
		ctx,
		gameAccuracySelect+"WHERE game_id = ? ORDER BY color",
		strings.TrimSpace(gameID),
	)
	if err != nil {
		return nil, fmt.Errorf("query game accuracy: %w", err)
	}
	return collectGameAccuracies(rows)
}

// GameAccuraciesFor returns the reviews attached to a set of games, so a list
// of games can be answered with one extra query rather than one per game.
func (store *Store) GameAccuraciesFor(
	ctx context.Context,
	gameIDs []string,
) (map[string][]GameAccuracy, error) {
	byGame := make(map[string][]GameAccuracy, len(gameIDs))
	if len(gameIDs) == 0 {
		return byGame, nil
	}
	placeholders := strings.TrimSuffix(strings.Repeat("?,", len(gameIDs)), ",")
	arguments := make([]any, 0, len(gameIDs))
	for _, gameID := range gameIDs {
		arguments = append(arguments, gameID)
	}
	rows, err := store.db.QueryContext(
		ctx,
		gameAccuracySelect+"WHERE game_id IN ("+placeholders+") ORDER BY game_id, color",
		arguments...,
	)
	if err != nil {
		return nil, fmt.Errorf("query game accuracies: %w", err)
	}
	accuracies, err := collectGameAccuracies(rows)
	if err != nil {
		return nil, err
	}
	for _, accuracy := range accuracies {
		byGame[accuracy.GameID] = append(byGame[accuracy.GameID], accuracy)
	}
	return byGame, nil
}

func collectGameAccuracies(rows *sql.Rows) ([]GameAccuracy, error) {
	defer rows.Close()
	accuracies := make([]GameAccuracy, 0, 2)
	for rows.Next() {
		var accuracy GameAccuracy
		if err := rows.Scan(
			&accuracy.GameID, &accuracy.Color, &accuracy.UserID, &accuracy.Accuracy,
			&accuracy.AverageLossPercent, &accuracy.AverageLossCentipawns, &accuracy.MoveCount,
			&accuracy.BestMoves, &accuracy.ExcellentMoves, &accuracy.GoodMoves,
			&accuracy.Inaccuracies, &accuracy.Mistakes, &accuracy.Blunders,
			&accuracy.EnginePreset, &accuracy.EngineMaxDepth, &accuracy.EngineMaxNodes,
			&accuracy.EngineMaxTimeMs, &accuracy.EngineVariations,
			&accuracy.ReportedBy, &accuracy.RecordedAtUnixMs,
		); err != nil {
			return nil, fmt.Errorf("read game accuracy: %w", err)
		}
		accuracies = append(accuracies, accuracy)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read game accuracies: %w", err)
	}
	return accuracies, nil
}

// VerifyProfileKey reports whether a key already belongs to an account.
//
// Deliberately not a claiming operation. Connecting and editing a profile both
// claim an unowned account, because that is a person saying "this is mine";
// storing a review is not, and letting it claim would mean the first passer-by
// to review somebody's game took their account with it. An account with no key
// therefore authorizes nothing here.
func (store *Store) VerifyProfileKey(ctx context.Context, userID, profileKey string) error {
	profileKeyHash, err := hashProfileKey(profileKey)
	if err != nil {
		return err
	}
	var storedHash string
	err = store.db.QueryRowContext(
		ctx,
		"SELECT profile_key_hash FROM accounts WHERE user_id = ?",
		strings.TrimSpace(userID),
	).Scan(&storedHash)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrAccountNotFound
	}
	if err != nil {
		return fmt.Errorf("verify profile key: %w", err)
	}
	if storedHash == "" || !profileKeyHashesMatch(storedHash, profileKeyHash) {
		return ErrInvalidProfileKey
	}
	return nil
}
