package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

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
	Rating      int
	// Reference marks the server's own yardsticks, which are always in the pool
	// whatever their owner's settings say. Consent is a question for a person who
	// is lending their machine, and these run on ours.
	Reference bool

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
	// Entered is the owner's switch on its own, which is not the same question
	// as being in the round: a reference engine is seated whatever this says.
	// Published apart from Reference so a page can explain which of the two
	// reasons an engine is in the field, rather than flattening them into one
	// word that is true for different reasons.
	Entered bool
	// State is what the rating above is worth. A number at the floor is either
	// a measured engine that is genuinely that weak or one nobody has placed,
	// and those print identically. See RatingState.
	State RatingState
}

// LadderEntrants is every engine that has consented to the pool, plus every
// yardstick, with the rating each currently holds in one mode.
//
// Read from the database rather than from the connected roster because the
// roster carries a copy of an account taken when it connected, and consent can
// be changed from the website in between. Who is actually online is then
// intersected with this by the caller, which is the half only the server knows.
func (store *Store) LadderEntrants(
	ctx context.Context,
	modeID game.ModeID,
) ([]LadderCandidate, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT b.bot_id, b.user_id, b.owner_user_id, b.reference_kind, b.enter_ladder,
       COALESCE(a.username, ''), COALESCE(o.username, ''), COALESCE(i.sha256, ''),
       COALESCE(r.elo, ?), COALESCE(r.rating_placed, 0), COALESCE(r.rating_confidence, 0)
FROM bots b
JOIN accounts a ON a.user_id = b.user_id AND a.kind = ?
LEFT JOIN accounts o ON o.user_id = b.owner_user_id
LEFT JOIN bot_icons i ON i.bot_id = b.bot_id
LEFT JOIN account_mode_ratings r ON r.user_id = b.user_id AND r.mode_id = ?
WHERE b.user_id IS NOT NULL
  AND b.retired_at_unix_ms IS NULL
  AND b.disabled = 0
  AND a.disabled = 0
  AND (b.enter_ladder = 1 OR b.reference_kind <> '')
ORDER BY b.bot_id
`, RatingFloor, AccountKindBot, modeID)
	if err != nil {
		return nil, fmt.Errorf("read ladder entrants: %w", err)
	}
	defer rows.Close()

	entrants := make([]LadderCandidate, 0, 32)
	for rows.Next() {
		var entrant LadderCandidate
		var kind string
		var entered, placed int
		var confidence float64
		if err := rows.Scan(
			&entrant.BotID, &entrant.UserID, &entrant.OwnerUserID, &kind, &entered,
			&entrant.Name, &entrant.Owner, &entrant.IconSHA256,
			&entrant.Rating, &placed, &confidence,
		); err != nil {
			return nil, fmt.Errorf("read ladder entrant: %w", err)
		}
		entrant.Reference = kind != ""
		entrant.Entered = entered == 1
		entrant.State = RatingStateOf(placed == 1, confidence)
		entrants = append(entrants, entrant)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read ladder entrants: %w", err)
	}
	return entrants, nil
}

// LadderPairWeights is how much evidence the ladder already holds about each
// matchup, by the same age-decayed count the fit reads.
//
// The pairer wants it in order to prefer a matchup it has not seen. Deliberately
// the *decayed* weight rather than a game count: a pair that ran to the cap two
// years ago is worth playing again, and a raw count would say it was finished
// with for ever.
//
// Keyed the way botPairKey is — lower user id first — so the caller can ask
// about a pairing without caring which way round it seats it.
func (store *Store) LadderPairWeights(
	ctx context.Context,
	modeID game.ModeID,
	now int64,
) (map[[2]string]float64, error) {
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("read ladder pair weights: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	pairs, err := botHeadToHeadTx(ctx, transaction, modeID, now)
	if err != nil {
		return nil, err
	}
	weights := make(map[[2]string]float64, len(pairs))
	for key, record := range pairs {
		weights[[2]string{key.low, key.high}] = record.games
	}
	return weights, nil
}

// LadderPairCap is how much evidence one matchup is worth to the fit.
//
// Exported so the pairer can ask "is there anything left to learn from these
// two" against the same number the rating uses, rather than against a second
// copy of it that could drift.
const LadderPairCap = botRatingPairCap
