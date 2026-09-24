package persistence

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"time"

	"rps-strategy/backend/internal/game"
)

// How people are rated.
//
// The same unit and the same anchor as the bot ladder — see rating_scale.go —
// and a different mechanism, for one reason: a person wants the number to move
// when the game ends. An engine does not read its own rating and can wait an
// hour for a fit over the whole board; a person watching a result appear is
// owed an answer immediately, and a whole-board refit cannot give them one.
//
// What it cannot be is the fixed-K transfer this replaces. A transfer conserves
// points, so it needs somewhere for the points to come from, and on a scale
// where everybody starts at the bottom and climbs there is no reservoir: the
// first thousand players would be dividing up nothing. So the update is Bayesian
// rather than zero-sum. Each player carries a strength and an uncertainty, a
// game is evidence about both of them, and nothing is taken from anybody —
// beating a stronger player raises you without lowering them by the same amount,
// because the game said something different about each of you.
//
// This is Glicko, written in the natural log units the Bradley-Terry fit works
// in rather than in the 400-per-decade of chess. Three things fall out of that
// choice, and all three are the reason for it:
//
//   - theta = 0 means the anchor. A person's strength is measured from the same
//     random-mover engine an engine's is, so the two boards are the same board
//     with different populations on it, and "about as strong as a 90-rated
//     engine" is a true statement rather than an analogy.
//
//   - The published rating is shrunk towards the floor by how little is known,
//     exactly as a bot's is. A new player reads 1 and climbs, which is what the
//     scale promises, rather than being handed the middle of the board on
//     arrival.
//
//   - Uncertainty grows while you are away, so an inactive person drifts back
//     down for the same reason and by the same mechanism as an inactive engine.
//     One rule, one explanation, two boards.
const (
	// humanInitialVariance is what is assumed about somebody who has played
	// nothing: almost nothing.
	//
	// Twelve squared-log-units is a standard deviation of about three and a half
	// doublings, which covers the whole plausible range of human strength and
	// then some. Deliberately generous — a wide prior means the first few games
	// move a new player a long way, which is both accurate and what it should
	// feel like.
	humanInitialVariance = 12.0

	// humanPopulationVariance is how spread out people actually are, and it is
	// what decides how much of a thin record gets published.
	//
	// The counterpart to the bot ladder's `established`, which is estimated from
	// the board on every fit. A per-game update has no board in front of it, so
	// this is a constant: about two doublings of standard deviation, which is
	// what the human field looked like on the old scale once its ratings were
	// converted. Worth re-measuring once the new board has a season on it.
	humanPopulationVariance = 4.0

	// humanMinimumVariance stops a settled rating from freezing.
	//
	// Every Bayesian rating has this problem: enough games and the update step
	// goes to nothing, so a player who improved would take a year to show it.
	// A floor of a twentieth is about a third of a doubling of standard
	// deviation — small enough that a settled rating is stable, large enough
	// that it can still move.
	humanMinimumVariance = 0.05

	// humanVariancePerDay is how fast certainty leaks away while somebody is not
	// playing.
	//
	// Set so that a settled player is back to knowing almost nothing after about
	// a year away, which is the same statement the bot ladder's ninety-day
	// half-life makes in its own terms. It is not a penalty: an idle rating is
	// not reduced, it is un-established, and the shrinkage below is what walks
	// the published number down.
	humanVariancePerDay = 0.032
)

// humanRating is one person's strength in one mode.
type humanRating struct {
	// theta is log-odds against the anchor. Zero is the anchor itself.
	theta float64
	// variance is how unsure of theta we are, in the same squared units.
	variance float64
	// updatedAt is when the last game was, which is what the idle growth below
	// is measured from.
	updatedAt int64
}

// published is the rating to show, shrunk towards the floor by how little the
// record establishes.
//
// The same shape as the bot ladder's shrinkage and for the same reason, with a
// population constant standing in for the board-wide estimate a fit can make and
// a single game cannot. A player who has proved nothing reads 1; one who has
// proved something reads most of it.
func (rating humanRating) published() int {
	if rating.variance <= 0 {
		return ratingFromLogOdds(rating.theta)
	}
	shrink := humanPopulationVariance / (humanPopulationVariance + rating.variance)
	return ratingFromLogOdds(rating.theta * shrink)
}

// aged is the rating as it stands now rather than as it stood at the last game:
// the same strength, known less well.
func (rating humanRating) aged(now int64) humanRating {
	if rating.updatedAt <= 0 || now <= rating.updatedAt {
		return rating
	}
	days := float64(now-rating.updatedAt) / float64(24*time.Hour/time.Millisecond)
	rating.variance = min(rating.variance+humanVariancePerDay*days, humanInitialVariance)
	return rating
}

// updateHumanRatings applies one game to both players.
//
// Both sides are computed from the pre-game values of the other, which is what
// makes the result independent of which seat is evaluated first. Doing it in
// place, one after the other, would make a game between two people a slightly
// different game depending on who was Red.
//
// The mathematics is Glicko-1 with q = 1, which is what writing it in natural
// logs buys: `g` discounts a result by how unsure we were of the opponent —
// beating somebody nobody has placed teaches less than beating somebody with a
// long record, and that alone is most of what makes a rating hard to farm.
func updateHumanRatings(
	red humanRating,
	blue humanRating,
	redScore float64,
	now int64,
) (humanRating, humanRating) {
	red, blue = red.aged(now), blue.aged(now)
	updatedRed := updateOneHumanRating(red, blue, redScore, now)
	updatedBlue := updateOneHumanRating(blue, red, 1-redScore, now)
	return updatedRed, updatedBlue
}

// updateOneHumanRating is one side of the above.
func updateOneHumanRating(
	subject humanRating,
	opponent humanRating,
	score float64,
	now int64,
) humanRating {
	// How much the opponent's own uncertainty flattens the result. At zero it is
	// one and the game counts in full, which is exactly the case that matters:
	// the yardstick engines have no uncertainty, so a calibration game against
	// one is worth more than a game against a stranger.
	discount := 1 / math.Sqrt(1+3*opponent.variance/(math.Pi*math.Pi))
	expected := 1 / (1 + math.Exp(-discount*(subject.theta-opponent.theta)))

	information := discount * discount * expected * (1 - expected)
	if subject.variance <= 0 {
		subject.variance = humanInitialVariance
	}
	variance := 1 / (1/subject.variance + information)
	subject.theta += variance * discount * (score - expected)
	subject.variance = max(variance, humanMinimumVariance)
	subject.updatedAt = now
	return subject
}

// anchoredRating is a yardstick engine as the human update sees it: exactly
// where the ladder says it is, with no uncertainty.
//
// This is the join between the two boards, and it is the whole of it. A person
// who plays one of the server's reference engines is measured against a fixed
// point that also fixes every bot rating, so the two sets of numbers mean the
// same thing without any human-versus-community-bot ranked play ever existing.
//
// No uncertainty rather than a little: a yardstick is frozen and plays
// constantly, so its own rating is the best-established number on the server,
// and treating it as exact is closer to true than any figure that could be put
// here instead.
func anchoredRating(rating int) humanRating {
	return humanRating{theta: logOddsFromRating(rating), variance: 0}
}

// humanRatingTx reads one player's strength in one mode.
func humanRatingTx(
	ctx context.Context,
	transaction *sql.Tx,
	userID string,
	modeID game.ModeID,
) (humanRating, error) {
	var rating humanRating
	err := transaction.QueryRowContext(ctx, `
SELECT theta, theta_variance, updated_at_unix_ms
FROM account_mode_ratings WHERE user_id = ? AND mode_id = ?
`, userID, modeID).Scan(&rating.theta, &rating.variance, &rating.updatedAt)
	if err != nil {
		return humanRating{}, fmt.Errorf("record game: read strength: %w", err)
	}
	if rating.variance <= 0 {
		rating.variance = humanInitialVariance
	}
	return rating, nil
}

// writeHumanRatingTx stores a strength and the number it publishes as.
//
// Both, rather than deriving the published number on read. It is read on every
// leaderboard row, every profile, every roster broadcast and every matchmaking
// decision, and a column is one indexed scan where a computed shrink is an
// expression the query planner cannot use an index on.
func writeHumanRatingTx(
	ctx context.Context,
	transaction *sql.Tx,
	userID string,
	modeID game.ModeID,
	rating humanRating,
) error {
	// Placed unconditionally, because reaching here *is* the measurement: this
	// runs once a ranked game has been applied to this person in this mode, and
	// nothing else writes it. Whether the number is worth printing is then the
	// confidence's question rather than this one's.
	if _, err := transaction.ExecContext(ctx, `
UPDATE account_mode_ratings
SET elo = ?, theta = ?, theta_variance = ?,
    rating_placed = 1, rating_confidence = ?
WHERE user_id = ? AND mode_id = ?
`, rating.published(), rating.theta, rating.variance, rating.confidence(),
		userID, modeID); err != nil {
		return fmt.Errorf("record game: write strength: %w", err)
	}
	return nil
}

// ensureRatingScaleColumns adds the two strength columns and seeds them from
// whatever the old scale left behind.
//
// The one real data migration in the move off Elo. A bot needs none — its rating
// is derived, so one refit at startup replaces every number with the same
// function of the same games — but a person's rating *is* state, and there is
// nothing to recompute it from.
//
// The seed keeps the shape of the old board and throws away its level. Ordering
// and gaps carry over, because they were measured from real games and are the
// best guess anybody has; the level does not, because the old scale's 1200 was
// an arbitrary constant and the new scale's zero is a specific engine, and no
// arithmetic can convert between the two. So the old human median is placed at
// the anchor and everyone is spread around it by their old distance from it,
// with the initial uncertainty on top.
//
// That uncertainty is what makes it honest rather than a guess dressed up: with
// a full prior variance the shrinkage publishes almost everybody near the floor
// on the first day, and the board separates over the following weeks as people
// play — including against the yardsticks, which is what actually establishes
// where the human field sits relative to the engines. An import that claimed to
// know the answer on day one would be claiming to know something nobody has
// measured.
func (store *Store) ensureRatingScaleColumns(ctx context.Context) error {
	columns, err := tableColumns(ctx, store.db, "account_mode_ratings")
	if err != nil {
		return fmt.Errorf("inspect rating schema: %w", err)
	}
	if columns["theta"] {
		return nil
	}
	for _, statement := range []string{
		"ALTER TABLE account_mode_ratings ADD COLUMN theta REAL NOT NULL DEFAULT 0",
		"ALTER TABLE account_mode_ratings ADD COLUMN theta_variance REAL NOT NULL DEFAULT 0",
	} {
		if _, err := store.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("add rating scale columns: %w", err)
		}
	}

	// The old scale's units, restated: 400 points was ten to one, so a point was
	// ln(10)/400 of a log-odd.
	const oldPointsPerLogOdd = 400 / math.Ln10
	var median sql.NullFloat64
	if err := store.db.QueryRowContext(ctx, `
SELECT AVG(elo) FROM (
    SELECT r.elo FROM account_mode_ratings r
    JOIN accounts a ON a.user_id = r.user_id AND a.kind = ?
    ORDER BY r.elo
    LIMIT 2 - (SELECT COUNT(*) FROM account_mode_ratings r2
               JOIN accounts a2 ON a2.user_id = r2.user_id AND a2.kind = ?) % 2
    OFFSET (SELECT (COUNT(*) - 1) / 2 FROM account_mode_ratings r3
            JOIN accounts a3 ON a3.user_id = r3.user_id AND a3.kind = ?)
)
`, AccountKindHuman, AccountKindHuman, AccountKindHuman).Scan(&median); err != nil {
		return fmt.Errorf("read old rating median: %w", err)
	}
	if !median.Valid {
		// No human ratings to carry over, which is a fresh database. The column
		// defaults are already the right answer.
		return nil
	}

	if _, err := store.db.ExecContext(ctx, `
UPDATE account_mode_ratings
SET theta = (elo - ?) / ?,
    theta_variance = ?
WHERE user_id IN (SELECT user_id FROM accounts WHERE kind = ?)
`, median.Float64, oldPointsPerLogOdd, humanInitialVariance, AccountKindHuman); err != nil {
		return fmt.Errorf("seed strengths from old ratings: %w", err)
	}

	// And the published column, which until this line still holds four-figure
	// numbers on a scale whose ceiling is now four hundred.
	rows, err := store.db.QueryContext(ctx, `
SELECT r.user_id, r.mode_id, r.theta, r.theta_variance
FROM account_mode_ratings r
JOIN accounts a ON a.user_id = r.user_id AND a.kind = ?
`, AccountKindHuman)
	if err != nil {
		return fmt.Errorf("read seeded strengths: %w", err)
	}
	type seeded struct {
		userID string
		modeID game.ModeID
		rating humanRating
	}
	pending := make([]seeded, 0, 128)
	for rows.Next() {
		var row seeded
		if err := rows.Scan(
			&row.userID, &row.modeID, &row.rating.theta, &row.rating.variance,
		); err != nil {
			rows.Close()
			return fmt.Errorf("read seeded strength: %w", err)
		}
		pending = append(pending, row)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("read seeded strengths: %w", err)
	}
	rows.Close()

	for _, row := range pending {
		if _, err := store.db.ExecContext(ctx, `
UPDATE account_mode_ratings SET elo = ? WHERE user_id = ? AND mode_id = ?
`, row.rating.published(), row.userID, row.modeID); err != nil {
			return fmt.Errorf("restate seeded rating: %w", err)
		}
	}
	// The seed column on `accounts` is the shared starting point a mode with no
	// row of its own inherits, and on the old scale it was 1200. Nothing derives
	// it, so it is simply reset: a mode somebody has never played is a mode they
	// have proved nothing in.
	if _, err := store.db.ExecContext(ctx,
		"UPDATE accounts SET elo = ? WHERE kind = ?", RatingFloor, AccountKindHuman,
	); err != nil {
		return fmt.Errorf("reset account seed rating: %w", err)
	}
	return nil
}

// confidence is the share of this person's measured strength that survives the
// shrinkage — the same ratio published() multiplies by, kept rather than thrown
// away. See RatingState.
func (rating humanRating) confidence() float64 {
	return ratingConfidence(humanPopulationVariance, rating.variance)
}

// ensureRatingStateColumns adds the two columns that let a rating say it is not
// one, and backfills what can be known without replaying anything.
//
// A bot needs no backfill: its rating is derived, so the refit that runs on
// every start writes both columns for the whole fleet a moment later. The
// defaults are the right answer in the meantime, and they are the cautious one —
// an unplaced row reads as "not enough data to rank", which is exactly what a
// board that has not been fitted yet should say.
//
// A person is backfilled from the uncertainty already stored against them, which
// is the only evidence there is. The rule is that somebody who has played has
// had their variance reduced below the starting one; somebody carried over by
// ensureRatingScaleColumns has it set to exactly that value and has therefore
// proved nothing here. That is deliberately the same verdict the migration's own
// comment reaches — "an import that claimed to know the answer on day one would
// be claiming to know something nobody has measured" — and this is the first
// release in which the board can actually say so instead of printing a number.
func (store *Store) ensureRatingStateColumns(ctx context.Context) error {
	columns, err := tableColumns(ctx, store.db, "account_mode_ratings")
	if err != nil {
		return fmt.Errorf("inspect rating state schema: %w", err)
	}
	if columns["rating_placed"] {
		return nil
	}
	for _, statement := range []string{
		"ALTER TABLE account_mode_ratings ADD COLUMN rating_placed INTEGER NOT NULL" +
			" DEFAULT 0 CHECK (rating_placed IN (0, 1))",
		"ALTER TABLE account_mode_ratings ADD COLUMN rating_confidence REAL NOT NULL DEFAULT 0",
	} {
		if _, err := store.db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("add rating state columns: %w", err)
		}
	}

	// theta_variance is zero on a row written before the scale columns existed
	// and never touched since; treat that as unmeasured too rather than as
	// perfect certainty, which is what a naive read of the column would give.
	if _, err := store.db.ExecContext(ctx, `
UPDATE account_mode_ratings
SET rating_placed = 1,
    rating_confidence = ? / (? + theta_variance)
WHERE theta_variance > 0 AND theta_variance < ?
  AND user_id IN (SELECT user_id FROM accounts WHERE kind = ?)
`, humanPopulationVariance, humanPopulationVariance, humanInitialVariance,
		AccountKindHuman); err != nil {
		return fmt.Errorf("backfill rating state: %w", err)
	}
	return nil
}
