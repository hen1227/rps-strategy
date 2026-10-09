package persistence

import (
	"math"
	"testing"
	"time"
)

// Glickman's worked example: a 1500 player with deviation 200 beats a 1400,
// then loses to a 1550 and a 1700, all in one rating period. Steps 3 to 5 are
// exactly the paper's, so the variance, the improvement and the new volatility
// have to match it to the digits printed there.
func TestRatingMatchesGlickmansWorkedExample(t *testing.T) {
	subject := glickoRating{strength: 1500, deviation: 200, volatility: 0.06}
	results := []glickoResult{
		{opponent: glickoRating{strength: 1400, deviation: 30}, score: 1},
		{opponent: glickoRating{strength: 1550, deviation: 100}, score: 0},
		{opponent: glickoRating{strength: 1700, deviation: 300}, score: 0},
	}

	mu, phi := 0.0, subject.deviation/glickoScale
	information, surprise := 0.0, 0.0
	for _, result := range results {
		weight := glickoWeight(result.opponent.deviation / glickoScale)
		expected := glickoExpected(
			mu, (result.opponent.strength-ratingStartStrength)/glickoScale, weight,
		)
		information += weight * weight * expected * (1 - expected)
		surprise += weight * (result.score - expected)
	}
	variance := 1 / information
	improvement := variance * surprise
	// The paper prints 1.7785 and -0.4834, worked from intermediates rounded to
	// three places; unrounded they are 1.7790 and -0.4839.
	if math.Abs(variance-1.7790) > 5e-4 {
		t.Fatalf("v = %.4f, want 1.7790", variance)
	}
	if math.Abs(improvement-(-0.4839)) > 5e-4 {
		t.Fatalf("Δ = %.4f, want -0.4839", improvement)
	}
	if volatility := glickoVolatility(0.06, phi, variance, improvement); math.Abs(volatility-0.05999) > 1e-5 {
		t.Fatalf("σ' = %.6f, want 0.05999", volatility)
	}

	// The paper then widens the deviation by the new volatility before the
	// update, which this file does through idle time instead (see rated), so
	// its last two numbers come out a fraction different: 151.4 against 151.52,
	// and 1464.1 against 1464.06.
	after := subject.rated(results, 1)
	if math.Abs(after.deviation-151.4) > 0.1 {
		t.Fatalf("deviation %.2f, want about 151.4", after.deviation)
	}
	if math.Abs(after.strength-1464.1) > 0.1 {
		t.Fatalf("strength %.2f, want about 1464.1", after.strength)
	}
	if after.games != 3 || after.lastGameAt != 1 {
		t.Fatalf("games %d at %d, want 3 at 1", after.games, after.lastGameAt)
	}
}

// Everybody starts in the same place: a strength in the middle of the scale and
// the widest deviation there is, which publishes as 1150.
func TestANewPlayerStartsAtElevenFifty(t *testing.T) {
	fresh := newGlickoRating()
	if RatingStart != 1150 {
		t.Fatalf("the starting rating is %d, want 1150", RatingStart)
	}
	if got := fresh.shown(time.Now().UnixMilli()); got != 1150 {
		t.Fatalf("a player with no games shows %d, want 1150", got)
	}
	if state := fresh.state(time.Now().UnixMilli()); state != RatingStateUnrated {
		t.Fatalf("a player with no games is %q, want unrated", state)
	}
}

// Playing is rewarded: an average player who wins as often as they lose still
// climbs, because every game narrows the deviation the shown number is
// discounted by. And the climb stops under the strength, so nobody is shown
// above what they have demonstrated.
func TestAnEvenRecordClimbsAndSettlesUnderTheStrength(t *testing.T) {
	opponent := glickoRating{strength: 1500, deviation: 50, volatility: ratingStartVolatility, games: 100}
	player := newGlickoRating()
	at := int64(1_000_000_000_000)
	previous := player.shown(at)
	for game := range 120 {
		at += time.Hour.Milliseconds()
		opponent.lastGameAt = at
		score := 1.0
		if game%2 == 1 {
			score = 0
		}
		player, _ = rateGame(player, opponent, score, at)
		if game%2 == 1 {
			// Compared over a pair, a win and a loss, so the swing of a single
			// result does not hide the trend.
			shown := player.shown(at)
			if shown < previous && game < 30 {
				t.Fatalf("after game %d an even record went down: %d after %d", game+1, shown, previous)
			}
			previous = shown
		}
	}
	shown := player.shown(at)
	if shown >= int(math.Round(player.strength)) {
		t.Fatalf("shown %d is not under the strength %.0f", shown, player.strength)
	}
	if shown < 1420 || shown > 1480 {
		t.Fatalf("an even player settled at %d, want about 1455", shown)
	}
	if player.state(at) != RatingStateRated {
		t.Fatalf("after 120 games the rating is %q, want rated", player.state(at))
	}
}

// There is no ceiling. A player who keeps beating the same strong opponent
// keeps climbing, by less each time as the result stops being a surprise.
func TestWinningKeepsClimbing(t *testing.T) {
	opponent := glickoRating{strength: 1800, deviation: 50, volatility: ratingStartVolatility, games: 100}
	player := newGlickoRating()
	at := int64(1_000_000_000_000)
	last := player.strength
	for game := range 200 {
		at += time.Hour.Milliseconds()
		opponent.lastGameAt = at
		player, _ = rateGame(player, opponent, 1, at)
		if player.strength <= last {
			t.Fatalf("win %d did not raise the strength: %.1f after %.1f", game+1, player.strength, last)
		}
		last = player.strength
	}
	if player.strength < 2300 {
		t.Fatalf("two hundred straight wins over an 1800 left the strength at %.0f", player.strength)
	}
}

// Losing still costs. The climb from a narrowing deviation is never enough to
// carry a player who loses every game, not even at the start.
func TestLosingEveryGameGoesDown(t *testing.T) {
	opponent := glickoRating{strength: 1500, deviation: 50, volatility: ratingStartVolatility, games: 100}
	player := newGlickoRating()
	at := int64(1_000_000_000_000)
	previous := player.shown(at)
	for game := range 10 {
		at += time.Hour.Milliseconds()
		opponent.lastGameAt = at
		player, _ = rateGame(player, opponent, 0, at)
		if shown := player.shown(at); shown >= previous {
			t.Fatalf("loss %d went from %d to %d", game+1, previous, shown)
		} else {
			previous = shown
		}
	}
}

// The rule the shown rating cannot break, checked across every combination
// that matters: a loss never raises it and a win never lowers it, however
// uncertain either player is and however lopsided the match. This is what
// fixes ratingShownDeviations at one; at two a newcomer's first loss to an
// equal player gained thirty points.
func TestALossNeverRaisesTheShownRating(t *testing.T) {
	at := int64(1_000_000)
	for _, deviation := range []float64{350, 300, 250, 200, 150, 110, 80, 60, 45} {
		for _, strength := range []float64{900, 1200, 1500, 1800, 2100} {
			for opponentStrength := 400.0; opponentStrength <= 3000; opponentStrength += 25 {
				for _, opponentDeviation := range []float64{45, 60, 100, 200, 350} {
					subject := glickoRating{
						strength: strength, deviation: deviation,
						volatility: ratingStartVolatility, lastGameAt: at,
					}
					opponent := glickoRating{
						strength: opponentStrength, deviation: opponentDeviation,
						volatility: ratingStartVolatility, lastGameAt: at,
					}
					before := subject.strength - ratingShownDeviations*subject.deviation
					lost, _ := rateGame(subject, opponent, 0, at)
					won, _ := rateGame(subject, opponent, 1, at)
					if after := lost.strength - ratingShownDeviations*lost.deviation; after > before+1e-9 {
						t.Fatalf("%.0f±%.0f losing to %.0f±%.0f rose from %.2f to %.2f",
							strength, deviation, opponentStrength, opponentDeviation, before, after)
					}
					if after := won.strength - ratingShownDeviations*won.deviation; after < before-1e-9 {
						t.Fatalf("%.0f±%.0f beating %.0f±%.0f fell from %.2f to %.2f",
							strength, deviation, opponentStrength, opponentDeviation, before, after)
					}
				}
			}
		}
	}
}

// Beating a much weaker player teaches almost nothing, which is what makes a
// rating hard to farm: the hundredth win over somebody you were always going to
// beat is worth a fraction of a point.
func TestBeatingAMuchWeakerPlayerIsWorthAlmostNothing(t *testing.T) {
	strong := glickoRating{strength: 2000, deviation: 50, volatility: ratingStartVolatility, games: 500, lastGameAt: 1}
	weak := glickoRating{strength: 1300, deviation: 50, volatility: ratingStartVolatility, games: 500, lastGameAt: 1}
	after, _ := rateGame(strong, weak, 1, 1)
	if gained := after.strength - strong.strength; gained <= 0 || gained > 1 {
		t.Fatalf("beating a player 700 below gained %.2f, want under a point", gained)
	}
}

// Beating a newcomer counts for less than beating somebody established at the
// same strength, because the newcomer's strength is a guess.
func TestBeatingAnUnmeasuredOpponentTeachesLess(t *testing.T) {
	subject := glickoRating{strength: 1500, deviation: 80, volatility: ratingStartVolatility, games: 50, lastGameAt: 1}
	measured := glickoRating{strength: 1500, deviation: 50, volatility: ratingStartVolatility, games: 200, lastGameAt: 1}
	beatMeasured, _ := rateGame(subject, measured, 1, 1)
	beatNewcomer, _ := rateGame(subject, newGlickoRating(), 1, 1)
	if beatNewcomer.strength >= beatMeasured.strength {
		t.Fatalf("beating a newcomer paid %.2f, at least the %.2f for beating an established player",
			beatNewcomer.strength-subject.strength, beatMeasured.strength-subject.strength)
	}
}

// Both seats are worked out from the other's state before the game, so which
// one is Red changes nothing.
func TestRatingAGameDoesNotDependOnTheSeats(t *testing.T) {
	first := glickoRating{strength: 1620, deviation: 90, volatility: 0.061, games: 20, lastGameAt: 1}
	second := glickoRating{strength: 1480, deviation: 140, volatility: 0.058, games: 6, lastGameAt: 1}
	at := 7 * 24 * time.Hour.Milliseconds()

	firstAsRed, secondAsBlue := rateGame(first, second, 1, at)
	secondAsRed, firstAsBlue := rateGame(second, first, 0, at)
	if firstAsRed != firstAsBlue || secondAsBlue != secondAsRed {
		t.Fatalf("the seats changed the result:\n%+v\n%+v\n%+v\n%+v",
			firstAsRed, firstAsBlue, secondAsBlue, secondAsRed)
	}
}

// Time away widens the deviation, so an idle rating drifts down, and it never
// widens past a newcomer's. The strength is untouched.
func TestAnIdleRatingDriftsDownWithoutLosingStrength(t *testing.T) {
	day := 24 * time.Hour.Milliseconds()
	settled := glickoRating{
		strength: 1700, deviation: ratingMinimumDeviation,
		volatility: ratingStartVolatility, games: 300, lastGameAt: day,
	}
	now := settled.shown(day)
	month := settled.shown(31 * day)
	year := settled.shown(366 * day)
	if !(now > month && month > year) {
		t.Fatalf("idle shown ratings did not fall: %d, then %d, then %d", now, month, year)
	}
	if drop := now - month; drop < 15 || drop > 45 {
		t.Fatalf("a month away cost %d points, want about thirty", drop)
	}
	if aged := settled.aged(1000 * 366 * day); aged.deviation != ratingStartDeviation ||
		aged.strength != settled.strength {
		t.Fatalf("a long absence aged to %+v", aged)
	}
	if state := settled.state(366 * day); state != RatingStateProvisional {
		t.Fatalf("a year away reads %q, want provisional", state)
	}
}

// A settled rating can still move. The deviation floor is what keeps an engine
// with thousands of games able to show an upgrade.
func TestTheDeviationNeverFallsBelowItsFloor(t *testing.T) {
	player := newGlickoRating()
	opponent := glickoRating{strength: 1500, deviation: 50, volatility: ratingStartVolatility, games: 100}
	at := int64(1)
	for game := range 2000 {
		at += time.Minute.Milliseconds()
		opponent.lastGameAt = at
		score := float64(game % 2)
		player, _ = rateGame(player, opponent, score, at)
	}
	if player.deviation < ratingMinimumDeviation-1e-9 {
		t.Fatalf("deviation %.2f is under the floor", player.deviation)
	}
	before := player.strength
	after, _ := rateGame(player, opponent, 1, at+1)
	if gained := after.strength - before; gained < 4 {
		t.Fatalf("an even win after 2000 games moved %.2f points, want about six", gained)
	}
}

// The ladder pool's notion of an even match.
func TestExpectedScoreIsEvenBetweenEqualsAndSymmetric(t *testing.T) {
	one := glickoRating{strength: 1600, deviation: 60}
	other := glickoRating{strength: 1450, deviation: 120}
	if got := expectedScore(one, one); math.Abs(got-0.5) > 1e-12 {
		t.Fatalf("a player against themselves expects %.4f", got)
	}
	if sum := expectedScore(one, other) + expectedScore(other, one); math.Abs(sum-1) > 1e-12 {
		t.Fatalf("the two expectations sum to %.6f", sum)
	}
	if expectedScore(one, other) <= 0.5 {
		t.Fatalf("the stronger player expects %.4f", expectedScore(one, other))
	}
}
