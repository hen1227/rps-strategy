package persistence

import (
	"math"
	"testing"
	"time"
)

// A rating is earned, so somebody who has played nothing has the lowest one
// there is. The old scale handed a new account the middle of the board, which
// is both a claim nobody had evidence for and the reason beating a new account
// used to pay.
func TestANewPlayerPublishesAtTheFloor(t *testing.T) {
	fresh := humanRating{variance: humanInitialVariance}
	if got := fresh.published(); got != RatingFloor {
		t.Fatalf("a player with no games published %d, not %d", got, RatingFloor)
	}
}

// The property that makes an anchored scale possible at all: a game is not a
// transfer. There is no reservoir of points on a scale everybody starts at the
// bottom of, so the winner's gain cannot be funded by the loser's loss.
func TestAGameIsNotATransfer(t *testing.T) {
	settled := func() humanRating {
		return humanRating{theta: 2, variance: 0.2}
	}
	newcomer := func() humanRating {
		return humanRating{theta: 2, variance: humanInitialVariance}
	}
	now := time.Now().UnixMilli()

	// The newcomer beats the settled player. Both have the same strength on
	// paper, and the result says far more about the newcomer than about the
	// veteran, because one of them was already measured and the other was not.
	after, before := updateHumanRatings(newcomer(), settled(), 1, now)
	gained := after.theta - newcomer().theta
	lost := settled().theta - before.theta
	if gained <= 0 || lost <= 0 {
		t.Fatalf("the result moved nobody: gained %.4f, lost %.4f", gained, lost)
	}
	if math.Abs(gained-lost) < 1e-6 {
		t.Fatalf("the winner took exactly what the loser lost: %.4f and %.4f", gained, lost)
	}
	if gained <= lost {
		t.Fatalf("an unmeasured winner should move further than a measured loser: "+
			"%.4f against %.4f", gained, lost)
	}
}

// Beating somebody nobody has placed teaches less than beating somebody with a
// long record, and that alone is most of what makes this hard to farm: an
// opponent you registered this morning is worth almost nothing to beat.
func TestBeatingAnUnmeasuredOpponentTeachesLess(t *testing.T) {
	subject := humanRating{theta: 1, variance: 1}
	now := time.Now().UnixMilli()

	measured, _ := updateHumanRatings(
		subject, humanRating{theta: 1, variance: 0.05}, 1, now)
	unmeasured, _ := updateHumanRatings(
		subject, humanRating{theta: 1, variance: humanInitialVariance}, 1, now)

	if unmeasured.theta >= measured.theta {
		t.Fatalf("beating a stranger paid at least as much as beating a known player: "+
			"%.4f against %.4f", unmeasured.theta, measured.theta)
	}
}

// A calibration game against a yardstick is worth the most of all, because the
// engine's own position is not in doubt. This is the mechanism that anchors the
// human board to the same zero the engine board uses.
func TestACalibrationGameCountsInFull(t *testing.T) {
	subject := humanRating{theta: 0, variance: 1}
	now := time.Now().UnixMilli()

	against := anchoredRating(RatingFloor)
	if against.theta != 0 || against.variance != 0 {
		t.Fatalf("the anchor is not at the origin: %#v", against)
	}
	beat, _ := updateHumanRatings(subject, against, 1, now)
	if beat.theta <= subject.theta {
		t.Fatalf("beating the anchor did not raise the player: %.4f", beat.theta)
	}
	// And a rung above the anchor is worth more to beat than the anchor itself.
	rung, _ := updateHumanRatings(subject, anchoredRating(80), 1, now)
	if rung.theta <= beat.theta {
		t.Fatalf("beating a stronger yardstick paid less: %.4f against %.4f",
			rung.theta, beat.theta)
	}
}

// Time away costs certainty, not strength, and the published number follows the
// certainty down. The same story as an idle engine, and deliberately so: one
// rule to explain for both boards.
func TestAnIdlePlayerDriftsBackTowardsTheFloor(t *testing.T) {
	settled := humanRating{
		theta:     2.5,
		variance:  0.1,
		updatedAt: time.Now().Add(-time.Hour).UnixMilli(),
	}
	now := time.Now().UnixMilli()
	if settled.aged(now).published() != settled.published() {
		t.Fatal("an hour away moved a rating")
	}

	away := settled
	away.updatedAt = time.Now().Add(-300 * 24 * time.Hour).UnixMilli()
	drifted := away.aged(now)
	if drifted.theta != settled.theta {
		t.Fatalf("time away changed a strength: %.4f then %.4f",
			settled.theta, drifted.theta)
	}
	if drifted.published() >= settled.published() {
		t.Fatalf("ten months away did not cost anything: %d then %d",
			settled.published(), drifted.published())
	}
	// And it comes straight back with one game, because nothing was taken away.
	returned, _ := updateHumanRatings(drifted, anchoredRating(120), 1, now)
	if returned.published() <= drifted.published() {
		t.Fatalf("playing again did not help: %d then %d",
			drifted.published(), returned.published())
	}
}

// The uncertainty floor, without which a settled rating slowly freezes and
// somebody who improved would take a year to show it.
func TestASettledRatingCanStillMove(t *testing.T) {
	rating := humanRating{theta: 1, variance: humanInitialVariance}
	now := time.Now().UnixMilli()
	for range 500 {
		rating, _ = updateHumanRatings(rating, anchoredRating(60), 1, now)
	}
	if rating.variance < humanMinimumVariance {
		t.Fatalf("variance fell below the floor: %.6f", rating.variance)
	}
	before := rating.theta
	rating, _ = updateHumanRatings(rating, anchoredRating(60), 1, now)
	if rating.theta <= before {
		t.Fatalf("a settled rating stopped moving: %.6f then %.6f", before, rating.theta)
	}
}

// Which seat somebody sat in must not change the result.
func TestTheUpdateDoesNotDependOnWhoIsRed(t *testing.T) {
	one := humanRating{theta: 1.5, variance: 0.4}
	other := humanRating{theta: 0.3, variance: 2.0}
	now := time.Now().UnixMilli()

	asRed, asBlue := updateHumanRatings(one, other, 1, now)
	swappedBlue, swappedRed := updateHumanRatings(other, one, 0, now)
	if math.Abs(asRed.theta-swappedRed.theta) > 1e-12 ||
		math.Abs(asBlue.theta-swappedBlue.theta) > 1e-12 {
		t.Fatalf("the seats disagreed: %.6f/%.6f against %.6f/%.6f",
			asRed.theta, asBlue.theta, swappedRed.theta, swappedBlue.theta)
	}
}

// People and engines are on one scale, so the same strength publishes as the
// same number whichever system produced it.
func TestAPersonAndAnEngineOfEqualStrengthPublishTheSame(t *testing.T) {
	// Two doublings above the anchor, established.
	strength := 2 * math.Ln2
	person := humanRating{theta: strength, variance: 0}
	if person.published() != ratingFromLogOdds(strength) {
		t.Fatalf("a person at %.4f published %d, an engine at the same publishes %d",
			strength, person.published(), ratingFromLogOdds(strength))
	}
	if person.published() != RatingFloor+2*RatingPointsPerDoubling {
		t.Fatalf("two doublings above the anchor is not two units: %d",
			person.published())
	}
}
