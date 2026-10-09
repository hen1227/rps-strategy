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

// Moving a finished game between ranked and casual, after the fact.
//
// A host's correction, for the two mistakes the seating rules cannot see coming:
// a ranked game that should not stand — an engine that crashed its way through a
// pairing, a build its author says was broken — and a casual run that should
// have counted, such as fifty pairs between two engines the host set up for
// exactly that.
//
// Changing which games are ranked and replaying the record (see
// rating_replay.go) gives exactly the board that would stand had the game been
// seated the other way from the start. That would be as true of a person's game
// as of an engine's; this is limited to engine games because it is a tool for
// hosts correcting engine runs, and a person chose ranked or casual themselves.
//
// Every copy of the flag moves together, in one transaction with the replay:
// the history row ratings are read from, and the archive's column and the file
// itself, which is what a review, a download and an export read. The bot series
// row is the caller's to move, when there is one; see SetBotSeriesRanked.

var (
	// ErrReclassifyNotEngineGame is a game with a person in it.
	ErrReclassifyNotEngineGame = errors.New(
		"only a game between two engines can be moved between ranked and casual",
	)
	// ErrReclassifySameOwner is ranked asked for a pair the ladder never rates.
	// Refused rather than done, because the replay skips the pair whatever the
	// flag says (see sameOwner), and a game that reads ranked while moving
	// nothing is the confusion the flag exists to prevent.
	ErrReclassifySameOwner = errors.New(
		"one person registered both engines, and the ladder does not rate their games",
	)
)

// Reclassification reports what moving one game, or one run, did.
type Reclassification struct {
	Ranked bool `json:"ranked"`
	// Changed is how many games changed their flag. Zero is a real answer —
	// asking for what the record already says — and nothing is replayed for it.
	Changed int         `json:"changed"`
	ModeID  game.ModeID `json:"modeId"`
}

// SetGameRanked moves one finished engine game to ranked or to casual.
func (store *Store) SetGameRanked(
	ctx context.Context,
	gameID string,
	ranked bool,
) (Reclassification, error) {
	gameID = strings.TrimSpace(gameID)
	if gameID == "" {
		return Reclassification{}, ErrGameNotFound
	}
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return Reclassification{}, fmt.Errorf("reclassify game: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var modeID game.ModeID
	var redID, blueID string
	var current int
	err = transaction.QueryRowContext(ctx, `
SELECT mode_id, red_player_id, blue_player_id, ranked FROM game_history WHERE game_id = ?
`, gameID).Scan(&modeID, &redID, &blueID, &current)
	if errors.Is(err, sql.ErrNoRows) {
		// Archive-only games included: one interrupted by a restart never
		// reached the history, so it has no result for the ladder to count.
		return Reclassification{}, ErrGameNotFound
	}
	if err != nil {
		return Reclassification{}, fmt.Errorf("reclassify game: read history: %w", err)
	}
	bothBots, err := bothBotsTx(ctx, transaction, redID, blueID)
	if err != nil {
		return Reclassification{}, err
	}
	if !bothBots {
		return Reclassification{}, ErrReclassifyNotEngineGame
	}
	if ranked {
		shared, err := sameBotOwnerTx(ctx, transaction, redID, blueID)
		if err != nil {
			return Reclassification{}, err
		}
		if shared {
			return Reclassification{}, ErrReclassifySameOwner
		}
	}

	result := Reclassification{Ranked: ranked, ModeID: modeID}
	if (current == 1) != ranked {
		if err := setGameRankedTx(ctx, transaction, gameID, ranked); err != nil {
			return Reclassification{}, err
		}
		result.Changed = 1
		if _, err := replayRatingsTx(ctx, transaction, time.Now().UnixMilli()); err != nil {
			return Reclassification{}, err
		}
	}
	if err := transaction.Commit(); err != nil {
		return Reclassification{}, fmt.Errorf("reclassify game: commit: %w", err)
	}
	return result, nil
}

// SetBotSeriesRanked moves a run, and every game it filed, to ranked or casual.
//
// The run's own flag moves as well as its games, so its card and its page say
// what its games now are. Every game follows, whatever it said before — which
// includes the runs whose flag and games already disagree: a run started by
// hand before the pool existed reads casual, and its games were filed ranked
// under the rule of the day.
//
// The caller refuses a run that is still being played. A game seated after this
// would be seated with the flag the run started with, and the run holds that in
// memory rather than here.
func (store *Store) SetBotSeriesRanked(
	ctx context.Context,
	seriesID string,
	ranked bool,
) (Reclassification, error) {
	seriesID = strings.TrimSpace(seriesID)
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return Reclassification{}, fmt.Errorf("reclassify series: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	var modeID game.ModeID
	var shared int
	err = transaction.QueryRowContext(ctx, `
SELECT s.mode_id,
       COALESCE(fb.owner_user_id IS NOT NULL AND fb.owner_user_id = sb.owner_user_id, 0)
FROM bot_series s
LEFT JOIN bots fb ON fb.bot_id = s.first_bot_id
LEFT JOIN bots sb ON sb.bot_id = s.second_bot_id
WHERE s.series_id = ?
`, seriesID).Scan(&modeID, &shared)
	if errors.Is(err, sql.ErrNoRows) {
		return Reclassification{}, ErrBotSeriesNotFound
	}
	if err != nil {
		return Reclassification{}, fmt.Errorf("reclassify series: read series: %w", err)
	}
	if ranked && shared == 1 {
		return Reclassification{}, ErrReclassifySameOwner
	}
	if _, err := transaction.ExecContext(ctx,
		`UPDATE bot_series SET ranked = ? WHERE series_id = ?`, boolToInt(ranked), seriesID,
	); err != nil {
		return Reclassification{}, fmt.Errorf("reclassify series: %w", err)
	}

	// Read to the end and closed before anything is written: the database is one
	// connection, and a write issued with these rows still open waits on itself.
	rows, err := transaction.QueryContext(ctx, `
SELECT h.game_id
FROM bot_series_games g
JOIN game_history h ON h.game_id = g.game_id
WHERE g.series_id = ? AND h.ranked <> ?
ORDER BY g.game_number
`, seriesID, boolToInt(ranked))
	if err != nil {
		return Reclassification{}, fmt.Errorf("reclassify series: read games: %w", err)
	}
	var moving []string
	for rows.Next() {
		var gameID string
		if err := rows.Scan(&gameID); err != nil {
			rows.Close()
			return Reclassification{}, fmt.Errorf("reclassify series: read game: %w", err)
		}
		moving = append(moving, gameID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return Reclassification{}, fmt.Errorf("reclassify series: read games: %w", err)
	}
	rows.Close()

	for _, gameID := range moving {
		if err := setGameRankedTx(ctx, transaction, gameID, ranked); err != nil {
			return Reclassification{}, err
		}
	}
	if len(moving) > 0 {
		if _, err := replayRatingsTx(ctx, transaction, time.Now().UnixMilli()); err != nil {
			return Reclassification{}, err
		}
	}
	if err := transaction.Commit(); err != nil {
		return Reclassification{}, fmt.Errorf("reclassify series: commit: %w", err)
	}
	return Reclassification{Ranked: ranked, Changed: len(moving), ModeID: modeID}, nil
}

// setGameRankedTx rewrites every copy of one game's flag.
//
// A game with no archive row is still moved: the history is what ratings are
// read from, and a game whose archive write failed is the reverse of the
// archive-only case the delete path allows for.
func setGameRankedTx(
	ctx context.Context,
	transaction *sql.Tx,
	gameID string,
	ranked bool,
) error {
	if _, err := transaction.ExecContext(ctx,
		`UPDATE game_history SET ranked = ? WHERE game_id = ?`, boolToInt(ranked), gameID,
	); err != nil {
		return fmt.Errorf("reclassify game: history: %w", err)
	}
	var pgn string
	err := transaction.QueryRowContext(ctx,
		`SELECT pgn FROM game_pgn WHERE game_id = ?`, gameID,
	).Scan(&pgn)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("reclassify game: read archive: %w", err)
	}
	if _, err := transaction.ExecContext(ctx,
		`UPDATE game_pgn SET ranked = ?, pgn = ? WHERE game_id = ?`,
		boolToInt(ranked), notation.SetRanked(pgn, ranked), gameID,
	); err != nil {
		return fmt.Errorf("reclassify game: archive: %w", err)
	}
	return nil
}

// sameBotOwnerTx reports whether one account registered both engines.
//
// The rule sameOwner applies to the whole record, asked of one pair: two bots
// whose owner is unknown are not two bots with the same owner.
func sameBotOwnerTx(
	ctx context.Context,
	transaction *sql.Tx,
	redID string,
	blueID string,
) (bool, error) {
	var shared int
	if err := transaction.QueryRowContext(ctx, `
SELECT COUNT(*) FROM bots red
JOIN bots blue ON blue.owner_user_id = red.owner_user_id
WHERE red.user_id = ? AND blue.user_id = ?
`, redID, blueID).Scan(&shared); err != nil {
		return false, fmt.Errorf("reclassify game: read owners: %w", err)
	}
	return shared > 0, nil
}

// bothBotsTx reports whether a game was between two engines, which is what
// moving one between ranked and casual is limited to.
func bothBotsTx(
	ctx context.Context,
	transaction *sql.Tx,
	redID string,
	blueID string,
) (bool, error) {
	var bots int
	if err := transaction.QueryRowContext(ctx, `
SELECT COUNT(*) FROM accounts WHERE user_id IN (?, ?) AND kind = ?
`, redID, blueID, AccountKindBot).Scan(&bots); err != nil {
		return false, fmt.Errorf("bot ladder: read account kinds: %w", err)
	}
	return bots == 2, nil
}
