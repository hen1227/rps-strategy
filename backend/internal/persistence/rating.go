package persistence

import (
	"math"
	"time"
)

// How everybody is rated.
//
// Glicko-2 (Glickman, "Example of the Glicko-2 system", 2013), applied one game
// at a time, to people and engines alike. Each account carries three numbers in
// each mode: a strength, how unsure of it the system is (the deviation), and how
// erratic its results have been (the volatility). A ranked game moves both
// players' strengths by how surprising the result was and narrows both
// deviations by how much the game taught. Nothing is fitted after the fact, so a
// rating moves the moment a game ends and has no ceiling: an engine that keeps
// beating the field keeps climbing until the field stops losing to it.
//
// The number on screen is not the strength. It is the strength less one
// deviation, a rating the record backs with about five-to-one confidence.
// Everybody starts at 1150 (1500 less 350) and climbs as they play, because
// every game narrows the deviation, and a player settles about forty-five points
// under their strength once it reaches its floor. That is how playing more is
// rewarded without being bought: the climb is uncertainty being paid off, so
// nobody is shown above what they have demonstrated.
//
// One deviation and not two, because two breaks the one rule a rating cannot
// break: at two, a newcomer's first loss to an equal player raises their number,
// since the deviation shrinks by more than the strength falls. One is the most
// that keeps every loss a loss — checked across the whole range in
// TestALossNeverRaisesTheShownRating.
//
// Time away works the other way. A deviation grows by one volatility for every
// ratingPeriod without a ranked game, so an idle rating drifts down by a few
// points a week and comes back with play. The strength itself is never touched.
//
// Every result is in game_history, so the same games in the same order always
// give the same ratings, and a correction anywhere in the record is applied by
// replaying it. See rating_replay.go.
const (
	// ratingStartStrength is where every strength begins: a player nothing is
	// known about.
	ratingStartStrength = 1500.0

	// ratingStartDeviation is how unsure the system is of somebody with no
	// games, wide enough to cover almost any strength. It is also as far as a
	// deviation can grow back while its owner is away.
	ratingStartDeviation = 350.0

	// ratingMinimumDeviation keeps a settled rating able to move. Without it an
	// engine with thousands of games would take weeks to show an upgrade. Forty
	// five is Lichess's floor, and is worth about six points for an even win.
	ratingMinimumDeviation = 45.0

	// ratingStartVolatility and ratingMaximumVolatility bound how erratic a
	// player is assumed to be. The cap stops a run of upsets from inflating the
	// deviation without limit.
	ratingStartVolatility   = 0.06
	ratingMaximumVolatility = 0.1

	// ratingTau constrains how fast volatility itself can change. Glickman
	// suggests 0.3 to 1.2; the middle of the low end suits games one at a time.
	ratingTau = 0.5

	// ratingPeriod is how long it takes a deviation to grow by one volatility.
	// A settled player away for a month loses about thirty shown points, and a
	// year away is most of the way back to a newcomer's uncertainty.
	ratingPeriod = 24 * time.Hour

	// ratingShownDeviations is how far the shown rating sits under the
	// strength, in deviations. See the note at the top for why it is one.
	ratingShownDeviations = 1.0

	// RatingProvisionalDeviation is where a rating counts as settled, the same
	// line Lichess draws. Above it, roughly a player's first dozen games or a
	// long absence, the shown number is still climbing towards the strength.
	RatingProvisionalDeviation = 110.0

	// glickoScale converts between the 1500 scale and Glicko-2's internal
	// units. It is 400/ln 10, which is what makes 400 points ten-to-one odds.
	glickoScale = 400 / math.Ln10

	// ratingVolatilityTolerance is when the volatility iteration has converged.
	ratingVolatilityTolerance = 1e-6
)

// RatingStart is the shown rating of somebody with no ranked games.
var RatingStart = shownRating(ratingStartStrength, ratingStartDeviation)

// RatingState is how far a rating can be trusted, in the one vocabulary the
// leaderboard, the profile and the lobby all spell it in.
type RatingState string

const (
	// RatingStateUnrated is no ranked game in the mode yet: there is a starting
	// point and nothing else, so show a dash rather than a number.
	RatingStateUnrated RatingState = "unrated"
	// RatingStateProvisional is a rating whose deviation is still above
	// RatingProvisionalDeviation, so the number is still settling.
	RatingStateProvisional RatingState = "provisional"
	// RatingStateRated is a settled rating.
	RatingStateRated RatingState = "rated"
)

// Ranked reports whether this state has a number worth putting in an order.
func (state RatingState) Ranked() bool {
	return state == RatingStateProvisional || state == RatingStateRated
}

// glickoRating is one account's rating in one mode.
type glickoRating struct {
	// strength is the estimate of how good the player is, on the 1500 scale.
	strength float64
	// deviation is how unsure that estimate is, in the same points, as it stood
	// after the last game. See aged for what it is now.
	deviation float64
	// volatility is how erratic the player's results have been.
	volatility float64
	// games is how many ranked games have been applied in this mode.
	games int
	// lastGameAt is when the last of them finished, which is what idle time is
	// measured from. Zero for somebody who has not played.
	lastGameAt int64
}

// newGlickoRating is the rating of somebody with no ranked games.
func newGlickoRating() glickoRating {
	return glickoRating{
		strength:   ratingStartStrength,
		deviation:  ratingStartDeviation,
		volatility: ratingStartVolatility,
	}
}

// aged is the rating as it stands at `now` rather than after the last game:
// the same strength, known less well for every period since.
func (rating glickoRating) aged(now int64) glickoRating {
	if rating.lastGameAt <= 0 || now <= rating.lastGameAt {
		return rating
	}
	periods := float64(now-rating.lastGameAt) / float64(ratingPeriod.Milliseconds())
	grown := math.Sqrt(
		rating.deviation*rating.deviation +
			rating.volatility*rating.volatility*glickoScale*glickoScale*periods,
	)
	rating.deviation = min(grown, ratingStartDeviation)
	return rating
}

// shown is the number published for this rating at `now`.
func (rating glickoRating) shown(now int64) int {
	aged := rating.aged(now)
	return shownRating(aged.strength, aged.deviation)
}

// shownRating is a strength less ratingShownDeviations of its deviation,
// rounded, and never below zero.
func shownRating(strength float64, deviation float64) int {
	shown := math.Round(strength - ratingShownDeviations*deviation)
	if math.IsNaN(shown) || shown < 0 {
		return 0
	}
	return int(shown)
}

// state is how far this rating can be trusted at `now`.
func (rating glickoRating) state(now int64) RatingState {
	if rating.games == 0 {
		return RatingStateUnrated
	}
	if rating.aged(now).deviation > RatingProvisionalDeviation {
		return RatingStateProvisional
	}
	return RatingStateRated
}

// rateGame applies one ranked game to both players.
//
// Both sides are computed from the other's state as it stood when the game
// ended, so the result does not depend on which seat is evaluated first.
func rateGame(
	red glickoRating,
	blue glickoRating,
	redScore float64,
	at int64,
) (glickoRating, glickoRating) {
	red, blue = red.aged(at), blue.aged(at)
	updatedRed := red.rated([]glickoResult{{opponent: blue, score: redScore}}, at)
	updatedBlue := blue.rated([]glickoResult{{opponent: red, score: 1 - redScore}}, at)
	return updatedRed, updatedBlue
}

// glickoResult is one game from one side: who it was against, and the score,
// one for a win, a half for a draw.
type glickoResult struct {
	opponent glickoRating
	score    float64
}

// rated applies a set of results to a rating that has already been aged to the
// time they were played: steps 2 to 8 of Glickman's procedure.
//
// The one departure is step 6. The textbook widens the deviation by a whole
// period's volatility before every update; here that widening has already
// happened in aged, in proportion to the time that actually passed. A player
// who plays twenty games in an afternoon is not twenty days less certain for
// it, which is what keeps an engine on the ranked ladder from jittering.
//
// The deviation floor is applied before the strength moves rather than after,
// so the step a game takes always matches the deviation the rating reports.
func (rating glickoRating) rated(results []glickoResult, at int64) glickoRating {
	if len(results) == 0 {
		return rating
	}
	mu := (rating.strength - ratingStartStrength) / glickoScale
	phi := rating.deviation / glickoScale

	information, surprise := 0.0, 0.0
	for _, result := range results {
		opponentMu := (result.opponent.strength - ratingStartStrength) / glickoScale
		weight := glickoWeight(result.opponent.deviation / glickoScale)
		expected := glickoExpected(mu, opponentMu, weight)
		information += weight * weight * expected * (1 - expected)
		surprise += weight * (result.score - expected)
	}
	variance := 1 / information
	improvement := variance * surprise

	volatility := min(
		glickoVolatility(rating.volatility, phi, variance, improvement),
		ratingMaximumVolatility,
	)
	phi = max(1/math.Sqrt(1/(phi*phi)+information), ratingMinimumDeviation/glickoScale)
	mu += phi * phi * surprise

	rating.strength = ratingStartStrength + mu*glickoScale
	rating.deviation = phi * glickoScale
	rating.volatility = volatility
	rating.games += len(results)
	rating.lastGameAt = at
	return rating
}

// glickoWeight is g(φ): how much an opponent's own uncertainty discounts a
// result against them. Beating somebody nobody has measured teaches less.
func glickoWeight(phi float64) float64 {
	return 1 / math.Sqrt(1+3*phi*phi/(math.Pi*math.Pi))
}

// glickoExpected is E(μ, μj, φj), held clear of exactly nought and one so a
// mismatch nobody could lose cannot divide by zero.
func glickoExpected(mu float64, opponentMu float64, weight float64) float64 {
	expected := 1 / (1 + math.Exp(-weight*(mu-opponentMu)))
	return min(max(expected, 1e-12), 1-1e-12)
}

// glickoVolatility is step 5, the new volatility, by the Illinois algorithm
// exactly as Glickman gives it.
func glickoVolatility(
	volatility float64,
	phi float64,
	variance float64,
	improvement float64,
) float64 {
	start := math.Log(volatility * volatility)
	tauSquared := ratingTau * ratingTau
	objective := func(x float64) float64 {
		exp := math.Exp(x)
		spread := phi*phi + variance + exp
		return exp*(improvement*improvement-phi*phi-variance-exp)/(2*spread*spread) -
			(x-start)/tauSquared
	}

	low := start
	var high float64
	if improvement*improvement > phi*phi+variance {
		high = math.Log(improvement*improvement - phi*phi - variance)
	} else {
		step := 1.0
		for objective(start-step*ratingTau) < 0 && step < 1000 {
			step++
		}
		high = start - step*ratingTau
	}

	objectiveLow, objectiveHigh := objective(low), objective(high)
	for range 100 {
		if math.Abs(high-low) <= ratingVolatilityTolerance {
			break
		}
		next := low + (low-high)*objectiveLow/(objectiveHigh-objectiveLow)
		objectiveNext := objective(next)
		if objectiveNext*objectiveHigh <= 0 {
			low, objectiveLow = high, objectiveHigh
		} else {
			objectiveLow /= 2
		}
		high, objectiveHigh = next, objectiveNext
	}
	volatility = math.Exp(low / 2)
	if math.IsNaN(volatility) || volatility <= 0 {
		return ratingStartVolatility
	}
	return volatility
}

// expectedScore is the model's expected score for one player against another,
// counting both deviations: a half for an even match, near one for a mismatch.
func expectedScore(subject glickoRating, opponent glickoRating) float64 {
	combined := math.Hypot(subject.deviation, opponent.deviation) / glickoScale
	return glickoExpected(
		(subject.strength-ratingStartStrength)/glickoScale,
		(opponent.strength-ratingStartStrength)/glickoScale,
		glickoWeight(combined),
	)
}

// ExpectedScore is expectedScore for a caller holding the numbers rather than a
// rating: one player's expected score against another, a half for an even
// match and near one for a mismatch. The ladder pool pairs on it.
func ExpectedScore(
	strength float64,
	deviation float64,
	opponentStrength float64,
	opponentDeviation float64,
) float64 {
	return expectedScore(
		glickoRating{strength: strength, deviation: deviation},
		glickoRating{strength: opponentStrength, deviation: opponentDeviation},
	)
}

// UncertaintyReduction is how much one game against an opponent would narrow a
// player's deviation, as a fall in its square: the information Glicko-2 says
// the game carries about them. It is largest for an even match against a
// well-measured opponent, and for a player the system is least sure of. The
// ladder pool seats the pairings that would teach the board the most.
func UncertaintyReduction(
	strength float64,
	deviation float64,
	opponentStrength float64,
	opponentDeviation float64,
) float64 {
	phi := deviation / glickoScale
	weight := glickoWeight(opponentDeviation / glickoScale)
	expected := glickoExpected(
		(strength-ratingStartStrength)/glickoScale,
		(opponentStrength-ratingStartStrength)/glickoScale,
		weight,
	)
	after := 1 / (1/(phi*phi) + weight*weight*expected*(1-expected))
	return (phi*phi - after) * glickoScale * glickoScale
}
