package persistence

import (
	"context"
	"fmt"
	"math"
	"time"

	"rps-strategy/backend/internal/game"
)

// Checking the declarations against the record.
//
// benchmarks.go declares what each rung is worth and the fit then holds it
// there, which is the point and is also the one thing that can go quietly wrong:
// a rung declared at 600 that is really playing at 800 makes every engine
// measured through it read two hundred points light, and nothing downstream
// looks odd. The fit has been told what 600 means and has no way to disagree.
//
// So it is asked separately. BenchmarkDrift frees one rung at a time, leaves the
// rest of the ladder pinned, and reports where the record puts the one it let
// go. That is the number to compare against the declaration, and the amount of
// daylight between them is the answer to "is this rung still worth what we said
// it was".
//
// Leave-one-out rather than freeing the whole ladder at once, and the difference
// matters more than it sounds. A fit with nothing pinned but the anchor has to
// place the top of the board through a chain of games against an engine that
// loses to everything, which is the badly-conditioned measurement the rungs were
// introduced to avoid — asking it for a verdict on the rungs would be asking the
// question the rungs are the answer to. Holding the rest of the ladder still
// puts the freed rung among opponents it can actually lose to, which is where a
// comparison carries information.
//
// Two consequences worth stating. Each rung is read on the assumption that the
// others are right, so a ladder that is wrong in several places will not point
// cleanly at any one of them; correct the widest gap, refit, and read it again.
// And a rung with nothing on its record comes back unmeasured rather than at the
// floor, because "nobody has played this engine" and "this engine is playing at
// chance" are opposite findings and must not print the same.

// BenchmarkReading is one rung's declaration beside what the record makes of it.
type BenchmarkReading struct {
	Benchmark
	// UserID is the engine holding the slot, empty when nobody does.
	UserID string `json:"userId,omitempty"`
	// Fitted is where the record puts this rung with every other rung held at its
	// declared value. Meaningless unless Measured.
	Fitted int `json:"fitted"`
	// Drift is Fitted minus the declared Rating: positive means the engine is
	// playing above its declaration and the rest of the board is reading light.
	Drift int `json:"drift"`
	// Measured says whether the record could place this rung at all. False for a
	// slot nobody holds, for an engine that has not played, and for one whose
	// games are all against opponents the ladder does not speak about.
	Measured bool `json:"measured"`
	// Games is how much evidence stands behind the reading, in the decayed,
	// pair-capped units the fit counts in rather than in games played. A reading
	// resting on a fraction of a game is not one to act on.
	Games float64 `json:"games"`
}

// BenchmarkDrift reads every declared rung against one mode's record.
//
// One mode at a time, because a rung is a different engine in each of them —
// the same search depth is not the same strength in Infiltration as it is in
// Intransitive — and an average over the three would hide exactly the case worth
// finding, which is a rung that is right in two modes and wrong in the third.
func (store *Store) BenchmarkDrift(
	ctx context.Context,
	modeID game.ModeID,
) ([]BenchmarkReading, error) {
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, fmt.Errorf("benchmark drift: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	yardsticks, err := botYardsticksTx(ctx, transaction)
	if err != nil {
		return nil, err
	}
	pairs, err := botHeadToHeadTx(ctx, transaction, modeID, time.Now().UnixMilli())
	if err != nil {
		return nil, err
	}
	// Everything below is arithmetic over what was just read, so the deferred
	// rollback can keep the transaction open across it. Nothing here goes back to
	// the store — on a single connection that would be a deadlock rather than an
	// error, and this is one of the places it would be easy to introduce.
	holder := make(map[string]string, len(yardsticks.Slots))
	for userID, slot := range yardsticks.Slots {
		holder[slot] = userID
	}

	readings := make([]BenchmarkReading, 0, len(benchmarkLadder))
	for _, benchmark := range benchmarkLadder {
		reading := BenchmarkReading{Benchmark: benchmark, UserID: holder[benchmark.Slot]}
		if reading.UserID != "" {
			reading.Games = benchmarkEvidence(pairs, reading.UserID)
			if fitted, measured := fitOneBenchmark(pairs, yardsticks, reading.UserID); measured {
				reading.Fitted, reading.Measured = fitted, true
				reading.Drift = fitted - benchmark.Rating
			}
		}
		readings = append(readings, reading)
	}
	return readings, nil
}

// fitOneBenchmark refits the ladder with one rung released and reports where it
// lands, or false if the record cannot place it.
//
// The release is done by hiding the slot rather than by editing the catalogue:
// the freed engine is dropped from the yardstick set the fit is handed, so it
// keeps its games and loses its declaration. It also loses its exemption from
// the opponent prune while it is released, which is correct — an engine being
// measured rather than declared has to clear the same bar as anybody else.
func fitOneBenchmark(
	pairs map[botPairKey]botPairRecord,
	yardsticks BotYardsticks,
	released string,
) (int, bool) {
	freed := BotYardsticks{Anchor: yardsticks.Anchor, Slots: make(map[string]string)}
	for userID, slot := range yardsticks.Slots {
		if userID == released {
			continue
		}
		freed.Slots[userID] = slot
	}
	if freed.Anchor == released {
		freed.Anchor = ""
	}
	if len(freed.Slots) == 0 {
		return 0, false
	}
	ratings, _ := fitBotRatings(pairs, freed)
	rating, placed := ratings[released]
	return rating, placed
}

// benchmarkEvidence is how much of a record a bot has, in the units the fit
// counts in: decayed games, with each pair capped the way the fit caps it.
//
// Capped per pair rather than summed raw, because that is what the fit will
// actually read. Twelve hundred games against one opponent is twenty games'
// worth of evidence, and reporting it as twelve hundred beside a reading the fit
// based on twenty would be the number most likely to be trusted and least worth
// trusting.
func benchmarkEvidence(pairs map[botPairKey]botPairRecord, userID string) float64 {
	total := 0.0
	for key, record := range pairs {
		if key.low != userID && key.high != userID {
			continue
		}
		total += math.Min(record.games, botRatingPairCap)
	}
	return total
}
