package persistence

import "math"

// The scale every rating in this game is published on.
//
// One file, shared by the bot ladder and by people, because a number that means
// two things depending on who is holding it is not a scale. What both systems
// have underneath is the same quantity — a Bradley-Terry strength, which is a
// log-odds — and all that is decided here is how to write it down.
//
// Three properties, and the rest of the design follows from them:
//
//  1. A rating starts at RatingFloor and is earned upwards. There is no middle
//     of the board to sit at and nothing is handed out on arrival, so an account
//     nobody has any evidence about reads as exactly that. The old scale put an
//     unplaced bot at 1200 alongside a genuinely average one, which is two
//     opposite claims printed the same way.
//
//  2. RatingFloor is the bottom, and what sits there depends on whether the
//     yardsticks are standing. Bradley-Terry identifies the gaps between players
//     and never the level, so something has to hold the zero.
//
//     With a declared anchor — an engine that plays a uniformly random legal
//     move, see benchmarks.go — 1 means "no better than chance" today and in a
//     year, and the board cannot move under itself.
//
//     Without one, the bot ladder falls back to its own weakest engine, so 1
//     means "the weakest engine on the board" and the level drifts as the field
//     changes. The ordering and the gaps are the same either way; what is lost
//     is that the number means the same thing tomorrow. See ladderZero.
//
//     A person's rating is measured from chance either way, because a Glicko
//     prior has to start somewhere and zero is the only defensible place — which
//     means that while the yardsticks are down the two boards are not on one
//     scale, however alike the numbers look.
//
//  3. RatingPointsPerDoubling points is twice the odds. Twenty apart is a
//     two-to-one favourite, forty is four-to-one, sixty is eight-to-one. The
//     scale is logarithmic because a strength is; what is new is the size of the
//     unit, which is small enough that a strong engine lands in the low hundreds
//     rather than in the thousands, and that nobody reads it as an Elo.
const (
	// RatingFloor is the anchor's rating, and the lowest number publishable.
	// Playing worse than chance is a real thing to do and the scale has no room
	// below it, on the grounds that there is nothing worth measuring down there.
	RatingFloor = 1

	// RatingPointsPerDoubling is the unit: this many points is a doubling of the
	// odds of winning.
	//
	// Twenty is a judgement about resolution rather than a derivation. The gap
	// between two well-tuned engines is often under a tenth of a doubling, which
	// at this size is still two points and therefore still visible; the gap
	// between a first submission and chance is a handful of doublings, which is
	// a satisfying hundred-odd points to climb. A larger unit makes the top of
	// the board twitchy and a smaller one flattens it.
	RatingPointsPerDoubling = 20

	// RatingCeiling stops a perfect record from being published as infinity.
	//
	// Twelve hundred is sixty doublings, which is around 10^18 to one against
	// chance: far past anything a record could establish, so it is a guard rather
	// than a grade — if it ever binds, something else is wrong.
	//
	// It has to be read against the benchmark ladder rather than on its own,
	// because the two are the same decision seen twice. The strongest declared
	// rung is the top of what the scale can *measure*; this is the top of what it
	// can *print*, and the gap between them is the room the board has to grow
	// above its own yardsticks. A ceiling at or near the top rung would quietly
	// flatten everything above it into one number, which is the failure this
	// constant exists to avoid rather than to cause. See benchmarks.go.
	//
	// The other constraint is numerical and is why this is not simply enormous.
	// The fit works in strengths rather than log-odds, so a rating of R is a
	// strength of about 2^(R/20); at twelve hundred that is 10^18, and the
	// information matrix squares it. Float64 carries that with room to spare and
	// would not carry an arbitrary choice.
	RatingCeiling = 1200
)

// Whether a published number is a measurement or a placeholder.
//
// RatingFloor used to carry both jobs and could not do them at once. Every
// account the system cannot place — a bot with too few opponents, a bot in a
// group with no yardstick in it, a bot on a board with nothing declared, a
// person who has never played the mode — was published at the floor, which is
// also the one value on this scale that *means* something specific: no better
// than chance. So the board could not distinguish "we have not measured this"
// from "we measured this and it is terrible", and spending the floor as the
// null value meant the scale could never make its own strongest statement.
//
// Two facts are now carried beside the number, and both already existed and were
// being thrown away one line before they were stored:
//
//   - placed: whether there is a measurement at all. For a bot that is whether
//     the fit's output contains it — fitBotRatings already answers this by
//     omission, and botRatingOr flattened it. For a person it is whether they
//     have finished a ranked game in the mode.
//   - confidence: how much of the measured strength survived the shrinkage,
//     between nothing and all of it. Both rating systems compute exactly this
//     ratio in order to publish, and neither used to keep it.
//
// What is *not* here is a fourth state for "rated but at the floor". A bot the
// record places at chance level is placed and confident, and reads 1, which is
// now an honest and unambiguous thing for it to read.
const (
	// RatingConfidenceRanked is the share of the fit a number has to keep before
	// it is published without qualification.
	//
	// Nine tenths, which is a statement about how much distortion is tolerable
	// rather than a statistical threshold: below it the shrinkage is removing
	// more than a tenth of the distance the record actually established, and a
	// number understated by that much should say so.
	RatingConfidenceRanked = 0.9

	// RatingConfidenceGuess is where a number stops being worth printing at all.
	//
	// A half, and this one is principled rather than chosen. The shrinkage is a
	// weighting between what the record established and a prior sitting at the
	// floor, so below a half the published figure is more prior than evidence —
	// it is mostly a restatement of "we assume nothing", dressed as a
	// measurement. There is no reading of that number that is about the player.
	RatingConfidenceGuess = 0.5
)

// RatingState is how much a published rating should be trusted, in the one
// vocabulary the leaderboard, the profile and the lobby all spell it in.
//
// Derived on the server and served, rather than each client re-deriving it from
// the two thresholds above: a front end that disagreed with the board about
// whether a number was a guess would be worse than either answer.
type RatingState string

const (
	// RatingStateUnrated is not enough data to rank: no measurement, or one so
	// thin the published number is mostly the prior. Show the words, not the
	// number.
	RatingStateUnrated RatingState = "unrated"
	// RatingStateProvisional is a real measurement that the shrinkage is still
	// visibly holding back. Show the number, and say it is provisional.
	RatingStateProvisional RatingState = "provisional"
	// RatingStateRated is a number that stands on its own.
	RatingStateRated RatingState = "rated"
)

// RatingStateOf reads the two stored facts as one answer.
func RatingStateOf(placed bool, confidence float64) RatingState {
	if !placed || math.IsNaN(confidence) || confidence < RatingConfidenceGuess {
		return RatingStateUnrated
	}
	if confidence < RatingConfidenceRanked {
		return RatingStateProvisional
	}
	return RatingStateRated
}

// Ranked reports whether this state has a number worth putting in an order.
//
// The leaderboard sorts on it: a board that ranked "not enough data to rank"
// above a measured engine because both happen to print 1 would be making
// exactly the claim the state exists to withdraw.
func (state RatingState) Ranked() bool {
	return state == RatingStateProvisional || state == RatingStateRated
}

// ratingConfidence is the shrinkage both systems apply, as a share.
//
// One function because it is one idea: the weight given to a measurement whose
// error bar is `variance`, against a prior of width `spread` sitting at the
// floor. The bot ladder estimates `spread` from the board on every fit and a
// person's is the constant humanPopulationVariance, and that difference is the
// only thing separating the two.
func ratingConfidence(spread float64, variance float64) float64 {
	if variance <= 0 {
		return 1
	}
	if spread <= 0 || math.IsNaN(spread) || math.IsNaN(variance) {
		return 0
	}
	return spread / (spread + variance)
}

// ratingFromLogOdds writes a strength on the published scale.
//
// The argument is in natural log units and already measured from the anchor:
// zero is the anchor itself, and positive is better than it. Callers hand over a
// number that has already been shrunk by how much of it the record establishes,
// because the shrinkage belongs to the system doing the measuring and not to the
// scale doing the writing.
func ratingFromLogOdds(logOdds float64) int {
	if math.IsNaN(logOdds) {
		return RatingFloor
	}
	rating := int(math.Round(RatingFloor + RatingPointsPerDoubling*logOdds/math.Ln2))
	return min(max(rating, RatingFloor), RatingCeiling)
}

// logOddsFromRating reads a published rating back as a strength, which is what a
// caller reasoning about a matchup needs.
//
// Not an exact inverse of the above, and cannot be: the published number is
// rounded to an integer and clamped at both ends. Everything that uses this is
// asking about an expected result rather than reconstructing a fit.
func logOddsFromRating(rating int) float64 {
	return float64(rating-RatingFloor) * math.Ln2 / RatingPointsPerDoubling
}

// RatingWinProbability is the model's chance that a player rated `rating` beats
// one rated `against`, ignoring colour and the draw.
//
// Exported because two callers outside this package need it and neither should
// be rederiving the scale: the ladder pool weights a candidate pairing by how
// much the game would teach, which is p(1-p) and peaks where this is a half, and
// the front end explains a matchup with it.
func RatingWinProbability(rating int, against int) float64 {
	return 1 / (1 + math.Exp(logOddsFromRating(against)-logOddsFromRating(rating)))
}
