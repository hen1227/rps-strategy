package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"

	"rps-strategy/backend/internal/game"
)

// What the ranked pool needs from the database, and what it remembers between
// rounds.
//
// The pool itself lives in the server package, because pairing needs to know who
// is connected and this package has never heard of a socket. What is here is the
// two things pairing cannot work out from memory: which engines have consented,
// and how much the ladder already knows about each candidate matchup.

// ensureLadderPoolSchema creates the pool's one row.
//
// A singleton config row for the same reason the weekend event has one: the
// round has to be idempotent across a restart. The pool seats its round at the
// top of the hour, with a few minutes' grace for a tick that arrives late —
// so without this row a deploy that brought a process up two minutes past would
// run the round its predecessor had already run, and an hour would carry as many
// rounds as somebody did deploys.
func (store *Store) ensureLadderPoolSchema(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS ladder_pool (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_round_at_unix_ms INTEGER NOT NULL DEFAULT 0,
    rounds_run INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO ladder_pool (id, last_round_at_unix_ms, rounds_run) VALUES (1, 0, 0);
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate ladder pool schema: %w", err)
	}
	return nil
}

// LadderPoolState is when the last round ran and how many there have been.
type LadderPoolState struct {
	LastRoundAtUnixMs int64 `json:"lastRoundAtUnixMs"`
	RoundsRun         int   `json:"roundsRun"`
}

// LadderPool reads the pool's memory.
func (store *Store) LadderPool(ctx context.Context) (LadderPoolState, error) {
	var state LadderPoolState
	err := store.db.QueryRowContext(ctx,
		"SELECT last_round_at_unix_ms, rounds_run FROM ladder_pool WHERE id = 1",
	).Scan(&state.LastRoundAtUnixMs, &state.RoundsRun)
	if errors.Is(err, sql.ErrNoRows) {
		return LadderPoolState{}, nil
	}
	if err != nil {
		return LadderPoolState{}, fmt.Errorf("read ladder pool: %w", err)
	}
	return state, nil
}

// MarkLadderRound records that a round has been run.
func (store *Store) MarkLadderRound(ctx context.Context, at int64) error {
	if _, err := store.db.ExecContext(ctx, `
UPDATE ladder_pool SET last_round_at_unix_ms = ?, rounds_run = rounds_run + 1 WHERE id = 1
`, at); err != nil {
		return fmt.Errorf("mark ladder round: %w", err)
	}
	return nil
}

// LadderCandidate is one engine as the pairer sees it.
type LadderCandidate struct {
	BotID       string
	UserID      string
	OwnerUserID string
	// Rating is what the engine publishes in the mode, and State how far it can
	// be trusted. Strength and Deviation are the estimate behind it, aged to
	// now, which is what the pairer weighs a matchup by: see ExpectedScore.
	Rating    int
	State     RatingState
	Strength  float64
	Deviation float64

	// The rest is nothing the pairer reads. It is here because the page that
	// publishes the field reads the same rows, and the alternative was a second
	// query over the same joins that could answer with a different set: the
	// question "who is entered" has one owner, and this is it.

	// Name is the engine's own, and Owner is whoever registered it. An
	// unclaimed slot has no name, and an anonymized owner leaves no name
	// behind; both arrive empty rather than absent.
	Name       string
	Owner      string
	IconSHA256 string
}

// LadderEntrants is every engine that has consented to the pool, with the
// rating each currently holds in one mode.
//
// Read from the database rather than from the connected roster because the
// roster carries a copy of an account taken when it connected, and consent can
// be changed from the website in between. Who is actually online is then
// intersected with this by the caller, which is the half only the server knows.
func (store *Store) LadderEntrants(
	ctx context.Context,
	modeID game.ModeID,
) ([]LadderCandidate, error) {
	fresh := newGlickoRating()
	rows, err := store.db.QueryContext(ctx, `
SELECT b.bot_id, b.user_id, b.owner_user_id,
       COALESCE(a.username, ''), COALESCE(o.username, ''), COALESCE(i.sha256, ''),
       COALESCE(r.elo, ?), COALESCE(r.strength, ?), COALESCE(r.deviation, ?),
       COALESCE(r.volatility, ?), COALESCE(r.rated_games, 0),
       COALESCE(r.last_rated_at_unix_ms, 0)
FROM bots b
JOIN accounts a ON a.user_id = b.user_id AND a.kind = ?
LEFT JOIN accounts o ON o.user_id = b.owner_user_id
LEFT JOIN bot_icons i ON i.bot_id = b.bot_id
LEFT JOIN account_mode_ratings r ON r.user_id = b.user_id AND r.mode_id = ?
WHERE b.user_id IS NOT NULL
  AND b.retired_at_unix_ms IS NULL
  AND b.disabled = 0
  AND a.disabled = 0
  AND b.enter_ladder = 1
ORDER BY b.bot_id
`, RatingStart, fresh.strength, fresh.deviation, fresh.volatility, AccountKindBot, modeID)
	if err != nil {
		return nil, fmt.Errorf("read ladder entrants: %w", err)
	}
	defer rows.Close()

	now := time.Now().UnixMilli()
	entrants := make([]LadderCandidate, 0, 32)
	for rows.Next() {
		var entrant LadderCandidate
		var rating glickoRating
		if err := rows.Scan(
			&entrant.BotID, &entrant.UserID, &entrant.OwnerUserID,
			&entrant.Name, &entrant.Owner, &entrant.IconSHA256,
			&entrant.Rating, &rating.strength, &rating.deviation,
			&rating.volatility, &rating.games, &rating.lastGameAt,
		); err != nil {
			return nil, fmt.Errorf("read ladder entrant: %w", err)
		}
		entrant.State = rating.state(now)
		entrant.Strength = rating.strength
		entrant.Deviation = rating.aged(now).deviation
		entrants = append(entrants, entrant)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read ladder entrants: %w", err)
	}
	return entrants, nil
}

// LadderPairWeights is how many ranked games each pair of engines has played in
// one mode over the last ladderPairWindow, keyed lower user id first so the
// caller can ask about a pairing without caring which way round it seats it.
//
// The pairer wants it in order to prefer a matchup it has not seen lately. A
// pair that has played LadderPairCap games inside the window is played out for
// now; one whose games have aged out of it is worth seating again.
func (store *Store) LadderPairWeights(
	ctx context.Context,
	modeID game.ModeID,
	now int64,
) (map[[2]string]float64, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT MIN(h.red_player_id, h.blue_player_id), MAX(h.red_player_id, h.blue_player_id),
       COUNT(*)
FROM game_history h
JOIN accounts red ON red.user_id = h.red_player_id AND red.kind = ?
JOIN accounts blue ON blue.user_id = h.blue_player_id AND blue.kind = ?
WHERE h.mode_id = ? AND h.ranked = 1 AND h.finished_at_unix_ms >= ?
GROUP BY 1, 2
`, AccountKindBot, AccountKindBot, modeID, now-ladderPairWindow.Milliseconds())
	if err != nil {
		return nil, fmt.Errorf("read ladder pair weights: %w", err)
	}
	defer rows.Close()
	weights := make(map[[2]string]float64)
	for rows.Next() {
		var low, high string
		var games float64
		if err := rows.Scan(&low, &high, &games); err != nil {
			return nil, fmt.Errorf("read ladder pair weight: %w", err)
		}
		weights[[2]string{low, high}] = games
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read ladder pair weights: %w", err)
	}
	return weights, nil
}

const (
	// LadderPairCap is how many recent ranked games make a pairing played out:
	// past it the pairer looks elsewhere first.
	LadderPairCap = 20.0

	// ladderPairWindow is how far back LadderPairWeights counts.
	ladderPairWindow = 28 * 24 * time.Hour
)
