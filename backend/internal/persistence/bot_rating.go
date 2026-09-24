package persistence

import (
	"context"
	"database/sql"
	"fmt"
	"math"
	"sort"
	"time"

	"rps-strategy/backend/internal/game"
)

// The bot ladder: every pair's record, solved all at once.
//
// Bots are not rated the way people are, and this file is the difference. A
// person's Elo is nudged one game at a time: you take points off whoever you
// beat, and the number you end up holding depends on the order things happened
// in. That is a reasonable system for people, who play whoever the queue hands
// them.
//
// It is the wrong system for engines, because an engine's author picks its
// opponents. Under a scale with a middle, a new bot arrives believed to be
// average, so beating one pays real points; register a throwaway, beat it,
// retire it, register another, and the ladder pays out again every time.
// Per-game Elo cannot see that happening. It only ever looks at two numbers and
// one result, and by that standard a farm and a title match are the same event.
//
// So the bot ladder is not a running total at all. It is the head-to-head
// record — how each bot has done against each other bot — solved for the set of
// strengths that best explains the whole of it. Nothing is awarded and nothing
// is spent. Beating a weak bot a thousand times adds one lopsided pair to that
// record, and a pair only says so much however long it runs.
//
// The model is Bradley-Terry, which is Elo's own: bot i beats bot j with
// probability yi/(yi+yj), and a rating is that strength written on the scale in
// rating_scale.go, where RatingPointsPerDoubling points is twice the odds.
// Fitting it is Hunter's MM iteration, a few dozen passes of one division per
// pair.
//
// # Where the zero is
//
// Bradley-Terry identifies the gaps between bots and never the level, so the fit
// has to be told what a rating is a distance *from*. There are two answers here
// and the record decides which applies — see ladderZero.
//
// The default, and the one that needs nothing standing up, is the board's own
// weakest engine. Whoever the fit places lowest reads RatingFloor and everybody
// else reads their measured distance above them. Every gap on that scale is real
// and the ordering is exactly the fit's, which is most of what a ladder is for;
// nothing can publish below the floor, because the floor is the minimum and a
// distance from a minimum cannot be negative.
//
// What that scale cannot do is hold still. Its zero is a bot, so a weaker engine
// joining the core lifts everybody and one leaving drops them, with nobody
// having played differently — and 1 means "the weakest engine here", which is
// not a claim about anything in particular and is not comparable across time,
// across modes, or against the human board.
//
// The other answer fixes that, and it is what benchmarks.go is for: a short list
// of server-run engines whose ratings are *declared* rather than fitted,
// starting with one that plays a uniformly random legal move and is RatingFloor
// by definition. Then 1 means "no better than chance" today and in a year, and
// the board stops moving under itself. It earns its keep three more times over:
//
//   - It gives an unproven rating somewhere honest to be. See the shrinkage
//     below: on a centred scale, uncertainty has no direction, so the only
//     defensible thing to do with a bot the record cannot place is leave it in
//     the middle — where it is indistinguishable from a genuinely average one.
//     Anchored, uncertainty points one way. Unproven means unproven, and
//     unproven is 1.
//
//   - It kills the incentive to swap engines. A fresh registration used to
//     arrive at the middle of the board, which for a below-average engine is a
//     promotion. It now arrives at the bottom, which is the worst state there
//     is, so there is no record bad enough that clearing it helps.
//
//   - It removes the last heuristic from the error bars. The information matrix
//     is singular because the record fixes gaps and not the level; dropping the
//     reference's row and column removes the singularity and leaves a covariance
//     already written as distance from it. Self-anchored, that reference is the
//     weakest bot, which is a choice the data made; declared, it is a set nobody
//     nominates.
//
// Switching between the two needs no migration in either direction. A bot rating
// is not a running total, it is the whole record solved again, so designating a
// rung restates every number in the game on the next refit — which is also why
// the numbers on the self-anchored scale should not be treated as durable.
//
// What makes the ladder hard to farm is then four rules, each closing what the
// one before it leaves open, and each written up where it lives:
//
//  1. A matchup is worth at most botRatingPairCap games, so grinding one
//     opponent stops paying.
//  2. A bot needs botRatingMinimumOpponents of them, pruned repeatedly, so
//     minting more throwaways does not get around (1) — see botLadderCore.
//  3. Only one group is published — the one holding the yardsticks, or the
//     largest one when there are none — so a league of engines that only play
//     each other is not ranked against anybody else. Also botLadderCore.
//  4. Nothing is assumed about a bot nobody has played. There is no prior in
//     this file, and the long note in the constants below is about why.
//
// And what is published is the fit shrunk by how much of it the record actually
// establishes, so a board that cannot tell its engines apart says so instead of
// ranking them by accident.
//
// Humans are rated by a different mechanism for a different reason — they want a
// number that moves when the game ends, and a whole-board refit cannot give them
// that — but on this same scale and from this same anchor. See human_rating.go.

const (
	// botRatingPairCap is how many games between one pair of bots the fit will
	// look at. Past it only the ratio counts: two hundred games at sixty per
	// cent and twenty games at sixty per cent say the same thing about which of
	// the two is better, and letting the longer run speak louder is precisely
	// the lever an author would lean on. The cap rescales the pair rather than
	// discarding games from the end of it, so a long run keeps its ratio and
	// loses only its volume.
	botRatingPairCap = 20.0

	// botRatingMinimumOpponents is how many distinct opponents a bot needs
	// before the ladder will speak about it, applied by repeatedly pruning
	// whoever falls short until nobody does.
	//
	// The pair cap alone is not enough, because an author who cannot get value
	// out of one throwaway can mint a second. Twenty throwaways beaten ten times
	// each is two hundred wins over twenty accounts that each arrived unmeasured,
	// and the fit having to invent a strength for each of them is what pays out.
	// The prune is the answer: a bot whose only opponent is the bot farming it
	// has a record about nobody, so it is not on the ladder, so the games against
	// it are not games the ladder has heard of. Removing it can drop its opponent
	// below the bar in turn, which is why this repeats — a farm collapses from
	// the outside in, and what is left standing is bots with a schedule.
	//
	// A yardstick opponent is exempt from the count, and that exemption is the
	// on-ramp rather than a hole. The rule exists because an unmeasured opponent
	// is worthless to measure yourself against; a yardstick is the opposite of
	// unmeasured, being the thing the scale is defined by. A record consisting of
	// nothing but games against the server's own engines is a complete and honest
	// rating, and it is what a bot's first hour in the pool produces.
	botRatingMinimumOpponents = 2

	// No prior. Nothing here assumes an unrated bot is probably average, and
	// that omission is load-bearing rather than an oversight.
	//
	// The obvious way to keep a fit like this well behaved is to give every bot
	// a token drawn record against an average opponent, which pins the scale and
	// stops an undefeated record meaning an infinite rating. It also hands every
	// account that has ever connected a small pile of "this one is probably
	// average", and *that* is the farm, in one sentence: an author who can
	// register bots can mint that belief and then beat it out of them. Ten wins
	// over each of twenty throwaways is two hundred wins over twenty accounts
	// nobody has any reason to think are average.
	//
	// So an unknown bot's strength is left unknown — a free parameter, with no
	// opinion attached. Beating a bot whose only games are losses to you moves
	// that parameter and tells the ladder nothing about you, which is the truth.
	// What replaces the prior's other two jobs is the anchor, which pins the
	// scale without asserting anything about anybody, and the two ceilings below,
	// which keep a hopeless or a perfect record finite.

	// What is published is not the fit but the fit shrunk towards the anchor, by
	// how much of it the record actually establishes. There is no constant for
	// this: the amount is estimated from the ladder itself, in fitBotRatings, by
	// comparing how far the board stands above the anchor against how uncertain
	// each of those distances is. A board whose spread is mostly real is barely
	// moved; a board whose spread is mostly noise collapses to RatingFloor, which
	// is the honest thing for it to do.
	//
	// The direction is the whole point and it is the opposite of what this did
	// before. Shrinking towards the middle of the board is right for a centred
	// scale, where "down" is no more meaningful than "up" and pushing an
	// uncertain bot either way is an assertion the record does not support. On an
	// anchored scale there is a meaningful zero, the distance from it is a claim,
	// and shrinking is simply declining to make a claim the games do not carry.
	//
	// The cost, which is real: the bias is now one-directional. Every published
	// rating understates the fit, and a thin board understates its best engine
	// along with everybody else. That is the price of a ladder where the number
	// in front of a bot is something it demonstrated rather than something it was
	// given, and it is the right price to pay.

	// botRatingRidge keeps the information matrix invertible. It is not a prior:
	// it is a billionth of a game, it appears only in the error bars and never
	// in the fit, and no record could be built that profits from it.
	botRatingRidge = 1e-9

	// botRatingExactVarianceLimit is the ladder size above which the error bars
	// come off the diagonal of the information matrix rather than the diagonal
	// of its inverse. The inverse is the honest number — it knows that a farmer
	// and their throwaway are uncertain *together* — and it costs a cubic, so
	// past a few hundred bots the approximation takes over. Nothing near that
	// has ever connected to this server; the branch is here so that the ladder
	// degrades instead of stalling if it does.
	botRatingExactVarianceLimit = 250

	// botRatingIterations and botRatingTolerance stop the solver. MM converges
	// monotonically and a ladder this size settles in a few dozen passes; the
	// cap is only so that a pathological record cannot spin.
	botRatingIterations = 500
	botRatingTolerance  = 1e-9
)

// strengthFloor and strengthCeiling stop the iteration from chasing a hopeless
// record to zero or a perfect one to infinity.
//
// Derived from the publishable range rather than picked, and they have to be:
// the benchmark ladder pins engines at declared strengths, and a bound tighter
// than the strongest declaration would clamp a yardstick away from the number
// the scale says it is. Tying both to the deviation ceiling makes that
// impossible by construction — anything publishable is representable — and
// leaves them doing the job they were picked for, which is keeping a record
// nobody could learn anything from out of the infinities.
var (
	strengthCeiling = math.Exp(botRatingDeviationCeiling)
	strengthFloor   = 1 / strengthCeiling

	// botRatingDeviationCeiling is how far from chance the ladder will place
	// anybody, in the natural log units the fit works in: the width of the entire
	// publishable range. Past it the published number is clamped anyway, so a
	// larger distance says nothing this one does not.
	//
	// It used to be carrying a second job, and the job it has lost is worth
	// recording because it is what declaring the rungs bought. When the anchor
	// was fitted like everybody else, a record in which it never won a game left
	// its strength unidentified — MM drove it to strengthFloor, the numerical
	// clamp caught it there, and every other bot then measured some twenty log
	// units above a position no game had decided, which uncapped published the
	// whole board at the ceiling. Capping turned that into a collapse to
	// RatingFloor, which was the honest answer for a ladder whose zero nobody had
	// managed to measure, and it left the yardsticks with an awkward constraint:
	// the rung above the anchor had to be weak enough to lose to it sometimes.
	//
	// A declared anchor has no unidentified strength to clamp, so none of that
	// applies and the constraint is gone. The anchor is free to lose every game
	// it ever plays, which against a board of real engines is exactly what it is
	// going to do.
	botRatingDeviationCeiling = math.Ln2 *
		float64(RatingCeiling-RatingFloor) / RatingPointsPerDoubling

	// botRatingVarianceCeiling is how uncertain the ladder will admit to being
	// about one bot, in squared log units — the deviation ceiling squared, for
	// the same reason and with the same effect.
	//
	// It is here because a bot that has lost every game it has played against
	// the core has no finite Bradley-Terry strength, so it has no finite variance
	// either — the fit pins it to strengthFloor and the information matrix
	// reports it as known to within about a billion. That is a true statement
	// about an unidentified parameter and a catastrophic one to leave in a
	// weighted average: unbounded, it dominates every sum it appears in, and the
	// shrinkage in fitBotRatings is a comparison between two such sums. One
	// hopeless record on the board was once enough to make the whole ladder read
	// as noise.
	botRatingVarianceCeiling = botRatingDeviationCeiling * botRatingDeviationCeiling
)

// botPairKey names one pair of bots, lower user id first, so that the two
// seatings of the same matchup land on one record instead of two.
type botPairKey struct {
	low  string
	high string
}

// botPairRecord is what one pair has done to each other: how many games they
// have played, and how many of them the low-id bot won, a draw counting half.
//
// Floats rather than integers, for three reasons that all arrive at the same
// place: a draw is half a game to this model, both fields are scaled by the pair
// cap before the fit reads them, and every game is worth less than one to begin
// with once its age is taken off. "Games" here means evidence, not a count.
type botPairRecord struct {
	games    float64
	lowScore float64
}

// botPair orders two user ids and reports whether the first came out low, which
// is what a caller needs to know to file a result on the right side.
func botPair(first string, second string) (botPairKey, bool) {
	if first < second {
		return botPairKey{low: first, high: second}, true
	}
	return botPairKey{low: second, high: first}, false
}

// Decay: how the ladder forgets.
//
// A rating that never expires is a claim about an engine that stopped playing in
// March, made in September, on the strength of games nobody has repeated since.
// The obvious fix is to subtract points from an idle bot, and it is the wrong
// one twice over — it cannot be done to a rating that is refit from the record
// every time, because the next refit puts it straight back, and it is a
// punishment for something that is not an offence.
//
// So the games decay instead of the number. A result is worth
// 0.5^(age/botRatingHalfLife) of a game, and everything downstream follows on
// its own: an idle bot's evidence thins, its error bar widens, and the shrinkage
// in fitBotRatings — which pulls a bot towards the anchor in proportion to how
// little the record establishes about it — walks it back down. Nothing is taken
// away from it. It is simply no longer proven, which is the true statement, and
// it climbs straight back with one afternoon's play.
//
// The nice consequence is that decay and the anti-farm shrinkage turn out to be
// the same mechanism seen from two sides, so there is one rule to explain rather
// than two, and no new way to game either of them.
//
// The awkward consequence is that ratings now move with no games played, so the
// fit has to run on a clock. See RefitBotLadder and the ladder pool's tick.
const (
	// botRatingHalfLife is how long a game takes to be worth half of one.
	//
	// A quarter, which is a guess with a shape to it rather than a measurement:
	// engines here are rewritten over weeks, so a season-old result is about a
	// different program, and at this half-life a bot that stops playing has lost
	// three quarters of its evidence within six months and effectively all of it
	// within a year. Short enough that the board tracks the field, long enough
	// that missing a fortnight costs nothing worth noticing.
	botRatingHalfLife = 90 * 24 * time.Hour

	// botRatingAgeBucket is the resolution the decay is computed at.
	//
	// Games are grouped by pair and by which week they fall in, and the weight is
	// applied once per bucket in Go rather than per row in SQL. Two reasons, and
	// the second is the real one: modernc.org/sqlite does not reliably carry the
	// math extension, so `exp` in a query is a portability bet; and a grouped
	// scan returning one row per pair per week is the same shape of query the
	// ladder already ran, where a per-row weight would mean reading every game
	// this server has ever recorded into memory to add them up again.
	//
	// A week's resolution against a quarter's half-life is a worst-case error of
	// about half a per cent in a game's weight, which is far below anything the
	// published integer can show.
	botRatingAgeBucket = 7 * 24 * time.Hour

	// botRatingMinimumPairWeight is how much of a game a matchup must still be
	// worth for the ladder to count it as an opponent.
	//
	// Without it the opponent-count prune reads a decayed record wrongly: a bot
	// that played two engines three years ago has two opponents by the letter of
	// the rule and no evidence at all by the spirit of it, and would be
	// published on the strength of games worth a thousandth of a game each. One
	// whole game's worth is the bar, which a single fresh result clears and a
	// long-dead record does not.
	botRatingMinimumPairWeight = 1.0
)

// botPairAgeWeight is what a game of this age is worth.
//
// Measured from the middle of its bucket rather than the near edge, so the
// approximation neither systematically favours nor penalises old games. A game
// dated in the future — a clock that went backwards, a row written by a test —
// is worth a whole game rather than more than one.
func botPairAgeWeight(bucket int64) float64 {
	if bucket < 0 {
		bucket = 0
	}
	age := (float64(bucket) + 0.5) * float64(botRatingAgeBucket)
	return math.Pow(0.5, age/float64(botRatingHalfLife))
}

// botHeadToHeadTx reads every ranked bot-versus-bot pair in one mode, with each
// game weighted by its age.
//
// Derived from game_history rather than kept in a table of its own. The games
// are already there and already indexed by the two player columns, so a second
// store would be a second thing to keep in step — and the reason to want one,
// avoiding a recount, does not apply: the recount is a grouped scan of a table
// only bots write to. Decay settles the question for good, since a stored total
// would be wrong again by tomorrow whatever was played.
//
// Deriving it also makes deletion exact. A head-to-head record has no history
// to unwind, so removing a game and fitting again gives the ladder that would
// have existed had the game never been played, which is more than the per-game
// reversal in admin_delete.go can promise for a human.
func botHeadToHeadTx(
	ctx context.Context,
	transaction *sql.Tx,
	modeID game.ModeID,
	now int64,
) (map[botPairKey]botPairRecord, error) {
	// MIN and MAX of two arguments are SQLite's scalar functions, not the
	// aggregates of the same name, so this groups the two seatings together and
	// scores each row from the low-id bot's side. The third grouping column is
	// the age bucket, so one pair comes back as one row per week it was played
	// in and the weight is applied to each.
	//
	// The two LEFT JOINs onto `bots` are the same-owner rule: a pair of engines
	// registered to one account is dropped, however their games were flagged
	// when they were played. LEFT rather than inner because the join is asking a
	// question, not filtering — a bot whose registry row is gone still has an
	// account and still has games, and an unknown owner is not a shared one.
	// `bots.user_id` is UNIQUE, so neither join can multiply a game row.
	const query = `
SELECT MIN(h.red_player_id, h.blue_player_id) AS low_id,
       MAX(h.red_player_id, h.blue_player_id) AS high_id,
       (? - h.finished_at_unix_ms) / ? AS age_bucket,
       COUNT(*) AS games,
       SUM(CASE
             WHEN h.outcome = 'draw' THEN 0.5
             WHEN h.winner_player_id = MIN(h.red_player_id, h.blue_player_id) THEN 1.0
             ELSE 0.0
           END) AS low_score
FROM game_history h
JOIN accounts red ON red.user_id = h.red_player_id AND red.kind = ?
JOIN accounts blue ON blue.user_id = h.blue_player_id AND blue.kind = ?
LEFT JOIN bots red_bot ON red_bot.user_id = h.red_player_id
LEFT JOIN bots blue_bot ON blue_bot.user_id = h.blue_player_id
WHERE h.mode_id = ? AND h.ranked = 1
  AND (red_bot.owner_user_id IS NULL
       OR blue_bot.owner_user_id IS NULL
       OR red_bot.owner_user_id <> blue_bot.owner_user_id)
GROUP BY low_id, high_id, age_bucket
`
	rows, err := transaction.QueryContext(
		ctx, query,
		now, botRatingAgeBucket.Milliseconds(),
		AccountKindBot, AccountKindBot, modeID,
	)
	if err != nil {
		return nil, fmt.Errorf("bot ladder: read head to head: %w", err)
	}
	defer rows.Close()

	pairs := make(map[botPairKey]botPairRecord)
	for rows.Next() {
		var key botPairKey
		var bucket int64
		var games, lowScore float64
		if err := rows.Scan(&key.low, &key.high, &bucket, &games, &lowScore); err != nil {
			return nil, fmt.Errorf("bot ladder: read head to head row: %w", err)
		}
		weight := botPairAgeWeight(bucket)
		record := pairs[key]
		record.games += games * weight
		record.lowScore += lowScore * weight
		pairs[key] = record
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("bot ladder: read head to head: %w", err)
	}
	return pairs, nil
}

// botPairEdge is one pair of the record as the solver sees it: two positions in
// the bot list, and the pair's games and score after the cap has been applied.
type botPairEdge struct {
	low      int
	high     int
	games    float64
	lowScore float64
}

// botLadderCore is the set of bots the record can actually speak about: those
// connected to the anchor, directly or through somebody, once everyone short of
// botRatingMinimumOpponents has been pruned away.
//
// Two rules, and between them they are what a farm cannot get around.
//
// The prune removes bots with too few distinct opponents, and repeats, because
// removing a throwaway can leave the bot that farmed it with nothing. Twenty
// accounts that have each played one opponent collapse in two passes and take
// that opponent with them. Yardsticks are exempt, and so is anyone who has
// played one — a server-run engine is not an unknown to be measured against, it
// is the measure.
//
// Keeping the anchor's component then handles the farm built to survive the
// prune. Three bots you own that play each other enough to clear the bar are
// still a private league, and a private league's results say where its members
// stand relative to each other and nothing at all about where they stand on this
// scale, because this scale is a distance from one particular engine. There is
// no honest rating to publish for one. Play something that plays the anchor and
// the whole record comes with you.
//
// The anchor's component rather than the largest one, which is what this used to
// choose. Size was a proxy for "the real ladder" and it was a poor one: it could
// be beaten by a big enough clique, and on a tie it had to fall back to game
// counts and sort order to stop the whole board flipping between refits. Asking
// which component contains the thing the scale is defined by needs no tiebreak
// and cannot be outvoted.
func botLadderCore(
	pairs map[botPairKey]botPairRecord,
	yardsticks BotYardsticks,
) map[string]bool {
	opponents := make(map[string]map[string]bool)
	link := func(one string, other string) {
		if opponents[one] == nil {
			opponents[one] = make(map[string]bool)
		}
		opponents[one][other] = true
	}
	// A pair worth less than one whole game is not an opponent. It stays in the
	// fit below — a tenth of a game is still a tenth of a game's worth of
	// evidence, and throwing it away would be inventing a cliff — but it does not
	// clear the bar for the prune and it does not join two components together.
	// A three-year-old matchup should not be what keeps a bot on the ladder, nor
	// what keeps a private league attached to it.
	for key, record := range pairs {
		if record.games < botRatingMinimumPairWeight {
			continue
		}
		link(key.low, key.high)
		link(key.high, key.low)
	}

	// Exempt from the prune: the server's own engines, and anyone who has played
	// one. Stable under the loop below because a yardstick is never removed, so
	// an exemption granted on the first pass still holds on the last.
	exempt := func(bot string, seen map[string]bool) bool {
		if yardsticks.known(bot) {
			return true
		}
		for other := range seen {
			if yardsticks.known(other) {
				return true
			}
		}
		return false
	}

	for pruned := true; pruned; {
		pruned = false
		for bot, seen := range opponents {
			if len(seen) >= botRatingMinimumOpponents || exempt(bot, seen) {
				continue
			}
			for other := range seen {
				delete(opponents[other], bot)
			}
			delete(opponents, bot)
			pruned = true
		}
	}

	// Everything reachable from a declared rung, over every rung that has played
	// anybody, in a fixed order so two runs of the same binary agree.
	//
	// Rooted at the yardsticks rather than at the anchor alone, which is what
	// this used to be. The reason was never the anchor as such: it was that the
	// anchor was the only fixed point, so a component without it had no scale to
	// be published on. Every rung is a fixed point now, and a component holding
	// one of them is as measurable as a component holding the anchor. What is
	// unchanged is the thing the rule is for — a private league that has played
	// none of the server's engines is still not on the ladder, however many games
	// its members have played each other.
	roots := make([]string, 0, len(yardsticks.Slots))
	for userID := range yardsticks.Slots {
		if opponents[userID] != nil {
			roots = append(roots, userID)
		}
	}
	sort.Strings(roots)
	if len(roots) == 0 {
		// No yardstick on the record, so the question "which of these groups is
		// the real ladder" has to be answered from the record itself: the biggest
		// one. See the note on self-anchoring in fitBotRatings for what is lost.
		//
		// This is what the file used to do before the rungs existed, and the
		// objection to it stands: a clique large enough to outnumber the field
		// would take the board with it. The defence is the same as it was — the
		// prune above has already removed anyone without a schedule, and the pool
		// rather than an author decides who plays whom — and it is weaker than a
		// declared rung, which is the trade being made.
		return largestComponentOf(opponents)
	}

	component := make(map[string]bool, len(opponents))
	queue := make([]string, 0, len(opponents))
	for _, root := range roots {
		if component[root] {
			continue
		}
		component[root] = true
		queue = append(queue, root)
		for len(queue) > 0 {
			bot := queue[0]
			queue = queue[1:]
			for other := range opponents[bot] {
				if component[other] {
					continue
				}
				component[other] = true
				queue = append(queue, other)
			}
		}
	}
	return component
}

// largestComponentOf is the biggest group of bots that have played each other,
// with ties broken so that two runs of the same binary cannot disagree.
//
// Size first, then the lowest member id. The tiebreak is not decoration: two
// groups of equal size on a small board is an ordinary situation, and without a
// rule the answer would follow Go's map iteration order and the whole published
// board would flip between refits.
func largestComponentOf(opponents map[string]map[string]bool) map[string]bool {
	members := make([]string, 0, len(opponents))
	for userID := range opponents {
		members = append(members, userID)
	}
	sort.Strings(members)

	seen := make(map[string]bool, len(opponents))
	var best map[string]bool
	var bestLow string
	for _, start := range members {
		if seen[start] {
			continue
		}
		component := map[string]bool{start: true}
		seen[start] = true
		queue := []string{start}
		for len(queue) > 0 {
			bot := queue[0]
			queue = queue[1:]
			for other := range opponents[bot] {
				if component[other] {
					continue
				}
				component[other] = true
				seen[other] = true
				queue = append(queue, other)
			}
		}
		// `start` walks the sorted ids, so it is the lowest id in its own
		// component and comparing the two starts is comparing the two groups.
		if len(component) > len(best) || (len(component) == len(best) && start < bestLow) {
			best, bestLow = component, start
		}
	}
	return best
}

// fitBotRatings solves a head-to-head record for one rating per bot.
//
// Four steps, and each of them is answering a different question:
//
//  1. Which bots does the record place at all? That is botLadderCore.
//  2. How much stronger than the anchor is each of them? Bradley-Terry, fitted
//     by Hunter's MM iteration, read as a distance from the anchor's own fitted
//     strength.
//  3. How sure is each of those distances? The information matrix with the
//     anchor's row and column removed, inverted.
//  4. How much of the board's height above the anchor is real rather than noise?
//     The comparison in the shrinkage below.
//
// Only bots the core admits come back. A bot that is absent is one the record
// cannot place, not one placed at RatingFloor — and that distinction is now
// carried out of here rather than flattened by the caller: see RatingState.
//
// The second return is how much of each bot's fitted distance survived the
// shrinkage, which is the same ratio the first return is multiplied by and used
// to be discarded the moment it had been. Two parallel maps rather than one map
// of pairs, for the reason botStrengthVariance returns two parallel slices: the
// rating is what almost every caller wants, and making all of them unwrap a
// struct to get at it would be paying for the rare case everywhere.
//
// A declared rung comes back at confidence 1. Its number was not measured, so
// there is no evidence for it to fall short of — the same reason it is exempt
// from the shrinkage itself.
func fitBotRatings(
	pairs map[botPairKey]botPairRecord,
	yardsticks BotYardsticks,
) (map[string]int, map[string]float64) {
	core := botLadderCore(pairs, yardsticks)
	if len(core) == 0 {
		return map[string]int{}, map[string]float64{}
	}

	// Sorted first. The sums below are floating point, so they are not
	// associative, and Go randomises map order — without this the same record
	// could fit to different numbers on two runs of the same binary, which is
	// not a thing anybody should have to debug.
	keys := make([]botPairKey, 0, len(pairs))
	for key := range pairs {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(first, second int) bool {
		if keys[first].low != keys[second].low {
			return keys[first].low < keys[second].low
		}
		return keys[first].high < keys[second].high
	})

	// The record as a graph: bots are nodes in first-seen order, pairs are edges
	// carrying their capped weight.
	order := make([]string, 0, 2*len(keys))
	position := make(map[string]int, 2*len(keys))
	indexOf := func(userID string) int {
		if at, found := position[userID]; found {
			return at
		}
		position[userID] = len(order)
		order = append(order, userID)
		return len(order) - 1
	}

	edges := make([]botPairEdge, 0, len(keys))
	for _, key := range keys {
		record := pairs[key]
		if record.games <= 0 || !core[key.low] || !core[key.high] {
			continue
		}
		weight := 1.0
		if record.games > botRatingPairCap {
			weight = botRatingPairCap / record.games
		}
		edges = append(edges, botPairEdge{
			low:      indexOf(key.low),
			high:     indexOf(key.high),
			games:    record.games * weight,
			lowScore: record.lowScore * weight,
		})
	}
	count := len(order)

	// The benchmark ladder, in the fit's own indices. A declared engine that has
	// not played anybody on the core is simply absent, which is the right answer
	// rather than a special case: a rung nobody has played is not yet part of the
	// record, and the scale is defined by the ones that are.
	pinned := make(map[int]float64, len(yardsticks.Slots))
	for userID, rating := range yardsticks.pinned() {
		if at, rated := position[userID]; rated {
			pinned[at] = logOddsFromRating(rating)
		}
	}
	strength := fitBotStrengths(edges, count, pinned)

	// Where the scale's zero is, and therefore what a rating is a distance from.
	//
	// Two answers, and which one applies is decided by whether anything on the
	// record is declared.
	//
	// With rungs, zero is where they say it is. The anchor is pinned at
	// RatingFloor, whose log-odds are zero by construction, so a fit including it
	// is already measured from chance — and a fit that includes only the higher
	// rungs is measured from the same scale by a shorter road. Nothing is
	// subtracted here.
	//
	// Without them, zero is the weakest bot the record can speak about. That is a
	// real scale and an honest one — every gap on it is measured, and the board
	// is ordered and spaced correctly — and it is a *different* scale from the
	// anchored one, in a way worth being blunt about:
	//
	//   - It moves. The floor is a bot, so when a weaker engine joins the core
	//     everything above it climbs, and when one leaves everything falls, with
	//     nobody having played differently. An anchored scale cannot do this,
	//     which is the whole reason the rungs exist.
	//   - It cannot say "no better than chance". 1 now means "the weakest engine
	//     here", which may be very strong. The two readings print the same and are
	//     not the same claim.
	//   - It is not comparable across time or against the human board.
	//
	// What it does do is work with nothing standing up, which the anchored scale
	// does not: before this, a database with no yardstick published no board at
	// all. Designating a rung later switches the branch and restates everything
	// retroactively, because a bot rating is the whole record solved again — so
	// nothing here has to be migrated when that happens.
	reference, floor := ladderZero(strength, pinned)
	variance, evidence := botStrengthVariance(edges, strength, reference)

	selfAnchored := len(pinned) == 0
	deviation := make([]float64, count)
	for index := range count {
		distance := math.Log(strength[index]) - floor
		if selfAnchored {
			// Nothing publishes below the floor. Almost always this is arithmetic
			// rather than a clamp — the zero is the weakest measured bot, so the
			// subtraction has nowhere lower to go — and it bites only for the
			// engines skipped above, the ones with no finite strength. Those are
			// the worst on the board and read as such, and their error bars say
			// the record cannot tell how much worse. See RatingState.
			distance = max(distance, 0)
		}
		deviation[index] = capDeviation(distance)
	}

	// A declared engine gets no vote in the two sums below. Its deviation is not
	// a measurement and its variance is zero by construction, so it has nothing
	// to contribute to a comparison between how far the board stands from chance
	// and how sure the record is of that — but weights are normalised to sum to
	// one, so holding a share would still scale both sums down. The yardsticks
	// play everybody and would hold large ones between them.
	for index := range pinned {
		evidence[index] = 0
	}
	normalizeWeights(evidence)

	// How much of the board's height above the anchor is real. The fitted
	// distances scatter for two reasons — because bots genuinely differ from the
	// anchor by different amounts, and because a finite record is noisy — and the
	// second is measured, so subtracting it leaves the first. That ratio is what
	// each bot's distance gets multiplied by: a well-played ladder keeps almost
	// all of it, and a rating resting on nothing keeps none of it and sits at
	// RatingFloor.
	spread, noise := 0.0, 0.0
	for index := range count {
		spread += evidence[index] * deviation[index] * deviation[index]
		noise += evidence[index] * variance[index]
	}
	established := max(spread-noise, 0)

	ratings := make(map[string]int, count)
	confidence := make(map[string]float64, count)
	for index, userID := range order {
		// A declared rung is published at its declaration, with no shrinkage
		// applied. Shrinkage is the fit declining to claim more than the record
		// carries, and there is no claim here to decline: the number was not
		// measured, so there is nothing for the evidence to fall short of.
		if logOdds, declared := pinned[index]; declared {
			ratings[userID] = ratingFromLogOdds(logOdds)
			confidence[userID] = 1
			continue
		}
		kept := ratingConfidence(established, variance[index])
		ratings[userID] = ratingFromLogOdds(deviation[index] * kept)
		confidence[userID] = kept
	}
	return ratings, confidence
}

// ladderZero decides what a rating is a distance from: which indices the
// covariance is written against, and how much to subtract from every fitted
// strength.
//
// With rungs it is the declared set, and nothing is subtracted — they are
// already on the published scale. Without them it is the single weakest bot on
// the core, and its strength is subtracted from everybody.
//
// The weakest rather than the best-measured, which was the other candidate. The
// covariance that comes back is Var(theta_i - theta_reference), and the number
// being published is the distance from the floor, so picking the floor is what
// makes the error bar the error bar of the quantity it is used to shrink. The
// cost is that a badly measured weakest bot widens everybody — which is the
// correct thing for it to do, since a board whose bottom nobody can place cannot
// say how far above it anyone is, and RatingState now reports that instead of
// hiding it.
func ladderZero(strength []float64, pinned map[int]float64) (map[int]bool, float64) {
	if len(pinned) > 0 {
		fixed := make(map[int]bool, len(pinned))
		for index := range pinned {
			fixed[index] = true
		}
		return fixed, 0
	}
	weakest := -1
	for index := range strength {
		// A strength sitting on a numerical clamp is not a measurement. A bot
		// that has not won a game against the core has no finite Bradley-Terry
		// strength at all, and the iteration parks it at strengthFloor — which is
		// the whole publishable range below the real board. Letting one of those
		// define the zero puts every other engine an arbitrary twenty-four log
		// units above a position no game decided, and then the fit reads every
		// pair on the board as lopsided and reports the lot as unmeasurable.
		//
		// Measured on the live V6 record: five of forty-five engines were winless,
		// one of them became the zero, and the entire board collapsed to the
		// floor. With a declared anchor this could not happen, because the bottom
		// of the scale was a declaration rather than whoever the iteration pushed
		// lowest — which is the sharpest single reason to stand the rungs up.
		if clampedStrength(strength[index]) {
			continue
		}
		if weakest < 0 || strength[index] < strength[weakest] {
			weakest = index
		}
	}
	if weakest < 0 {
		// Nothing on the board has a finite strength, so there is no zero to be
		// found and no board to publish. Returning the raw minimum keeps the
		// caller's arithmetic total; the shrinkage below will take it to the floor
		// on its own, which is the right answer for a record like that.
		for index := range strength {
			if weakest < 0 || strength[index] < strength[weakest] {
				weakest = index
			}
		}
	}
	floor := math.Log(strength[weakest])
	if math.IsNaN(floor) || math.IsInf(floor, 0) {
		floor = 0
	}
	return map[int]bool{weakest: true}, floor
}

// clampedStrength reports whether the iteration parked this bot on a bound
// rather than fitting it, which is what happens to a record with no finite
// maximum likelihood: unbeaten against the core, or winless against it.
func clampedStrength(strength float64) bool {
	return strength <= strengthFloor*(1+1e-9) || strength >= strengthCeiling*(1-1e-9)
}

// fitBotStrengths is the Bradley–Terry maximum likelihood fit, by Hunter's MM
// iteration: each bot's next strength is its wins over the sum, across its
// opponents, of that matchup's games divided by the two strengths.
//
// `pinned` is the benchmark ladder: indices whose strength is declared rather
// than fitted, given as log-odds from chance. They are set once and never
// updated, and every free bot is fitted around them. The likelihood is the same
// function it always was — this maximises it over the free coordinates with the
// rest held at known values, which is the standard fixed-reference form of MM
// and converges the same way.
//
// Pinning anything is also what removes the rescale that used to be here. The
// unconstrained fit is scale-free — the record says who beat whom and never how
// good anybody is in the abstract — so each pass had to be divided by its own
// median to stop the numbers wandering off, and the caller decided where the
// ladder sat afterwards by subtracting the anchor. With a declared strength in
// the mix the scale is no longer free, and rescaling would drag the pinned
// values off the numbers they were declared to be, which is the one thing they
// exist not to do. So the pass no longer rescales, and the strengths that come
// out are already in the units the caller publishes.
//
// The bounds remain numerical, not a judgement: a bot that lost every game it
// played has no finite strength, and something has to stop the iteration chasing
// it to zero for five hundred passes.
func fitBotStrengths(edges []botPairEdge, count int, pinned map[int]float64) []float64 {
	score := make([]float64, count)
	for _, edge := range edges {
		score[edge.low] += edge.lowScore
		score[edge.high] += edge.games - edge.lowScore
	}

	strength := make([]float64, count)
	updated := make([]float64, count)
	for index := range strength {
		strength[index] = 1
	}
	// The declarations, in the units the iteration works in. Clamped like
	// anything else, which cannot bind while the bounds are derived from the
	// publishable range — see strengthCeiling — and is here so that a slot
	// declared past the end of the scale is a flattened rung rather than an
	// infinity loose in the fit.
	for index, logOdds := range pinned {
		strength[index] = min(max(math.Exp(logOdds), strengthFloor), strengthCeiling)
	}

	for range botRatingIterations {
		// updated holds the denominator first and the new strength after, which
		// is safe because every share below is read off strength.
		for index := range updated {
			updated[index] = 0
		}
		for _, edge := range edges {
			share := edge.games / (strength[edge.low] + strength[edge.high])
			updated[edge.low] += share
			updated[edge.high] += share
		}
		for index := range updated {
			if _, declared := pinned[index]; declared {
				updated[index] = strength[index]
				continue
			}
			if updated[index] > 0 {
				updated[index] = score[index] / updated[index]
			} else {
				updated[index] = strength[index]
			}
		}
		// With nothing pinned the likelihood is scale-free, so the iteration has
		// no reason to stay in range and will wander until the clamps below start
		// biting on numbers that are only large in absolute terms. Dividing each
		// pass by its own median holds it still. The median rather than the mean
		// because a real ladder carries a tail of bots being driven to the floor,
		// and a mean would follow them down. See middleOf.
		//
		// Not done when something is pinned: rescaling would drag the declared
		// values off the numbers they exist to hold.
		if len(pinned) == 0 {
			scale := middleOf(updated)
			for index := range updated {
				updated[index] /= scale
			}
		}
		change := 0.0
		for index := range updated {
			next := min(max(updated[index], strengthFloor), strengthCeiling)
			if moved := math.Abs(next-strength[index]) / (strength[index] + next); moved > change {
				change = moved
			}
			updated[index] = next
		}
		copy(strength, updated)
		if change < botRatingTolerance {
			break
		}
	}
	return strength
}

// normalizeWeights rescales a set of weights to sum to one, in place, falling
// back to equal shares for a set that cannot be.
//
// Every use of these weights below — the centre, and the spread and noise the
// shrinkage compares — is a weighted average written without a divisor, so they
// have to arrive summing to one. Normalising here rather than at each of the
// places botStrengthVariance can return from is what makes that hard to forget.
func normalizeWeights(weights []float64) {
	total := 0.0
	for _, weight := range weights {
		if weight > 0 && !math.IsInf(weight, 0) {
			total += weight
		}
	}
	if total <= 0 || math.IsNaN(total) {
		for index := range weights {
			weights[index] = 1 / float64(len(weights))
		}
		return
	}
	for index := range weights {
		if weights[index] > 0 && !math.IsInf(weights[index], 0) {
			weights[index] /= total
		} else {
			weights[index] = 0
		}
	}
}

// middleOf is the median of a set of the fit's numbers, or one if that is not a
// usable answer.
//
// The median rather than the mean, and both callers need it for the same
// reason: a real ladder carries a tail of bots the fit is driving to the
// strength floor, whose strengths go to zero and whose variances go to
// infinity, and a mean would follow them in either direction. Used to keep the
// iteration's numbers in range, and to set the floor under the inverse-variance
// weights in botStrengthVariance — a floor taken from the mean would be set by
// the very bots it exists to hold down.
func middleOf(values []float64) float64 {
	if len(values) == 0 {
		return 1
	}
	sorted := append([]float64(nil), values...)
	sort.Float64s(sorted)
	middle := sorted[len(sorted)/2]
	if len(sorted)%2 == 0 {
		middle = (middle + sorted[len(sorted)/2-1]) / 2
	}
	if middle <= 0 || math.IsNaN(middle) || math.IsInf(middle, 0) {
		return 1
	}
	return middle
}

// capVariances holds each error bar to botRatingVarianceCeiling, in place.
//
// Applied at every point botStrengthVariance returns from, for the reason
// normalizeWeights is: an uncapped variance from one of its fallback branches
// would be the same bug in a rarer shape.
func capVariances(variance []float64) {
	for index := range variance {
		if variance[index] > botRatingVarianceCeiling || math.IsInf(variance[index], 1) {
			variance[index] = botRatingVarianceCeiling
		}
	}
}

// capDeviation holds one distance from the anchor to botRatingDeviationCeiling.
//
// The partner to capVariances, and the two have to saturate together or the
// shrinkage compares a bounded noise against an unbounded spread and concludes
// that a board it cannot measure at all is entirely real. The long note on
// botRatingDeviationCeiling is the case that makes this load-bearing.
func capDeviation(deviation float64) float64 {
	if math.IsNaN(deviation) {
		return 0
	}
	return min(max(deviation, -botRatingDeviationCeiling), botRatingDeviationCeiling)
}

// botStrengthVariance is how uncertain each bot's distance from the anchor is,
// in the natural log units the fit works in, along with how much evidence the
// record holds about each of them.
//
// The Bradley-Terry log-likelihood's information matrix is
//
//	H[i][i] = sum of n*p*(1-p) over i's matchups
//	H[i][j] = -n*p*(1-p) for the matchup between i and j
//
// where p is the model's chance that i beats j. It is the intuition about
// evidence written down: a lopsided matchup contributes almost nothing, because
// a game whose result was a foregone conclusion tells you nothing you did not
// already believe, while an even one contributes a full quarter per game. It is
// also, with no prior anywhere, exactly why a manufactured opponent is
// worthless — the fit drops that opponent towards zero, p goes to one, and the
// matchup carries no information about the bot that farmed it, however many
// games it was run to.
//
// H is singular, because the record fixes the gaps between bots and not where
// the ladder sits. Dropping the anchor's row and column is what removes that,
// and it is the whole of the method: the inverse of what is left is a covariance
// written in distances from the anchor, so its diagonal is Var(theta_i -
// theta_anchor) directly — the variance of precisely the number this file
// publishes. The anchor's own entry is zero, because it is measured from itself.
//
// This used to be three times longer. With the level pinned only by a weighted
// mean of the board, there was no bot the covariance could honestly be written
// from: dropping somebody was still necessary to invert, but the answer then
// meant "relative to whoever got dropped", so it had to be turned into a
// reference-free contrast against a weighted middle, and the weights for that
// middle wanted to be inverse-variance, which meant running the whole thing
// twice. Every line of that existed to work around not having a fixed point, and
// having one deleted all of it.
//
// The second return is the raw information diagonal — how much the record holds
// about each bot on its own, and nothing about anybody else. fitBotRatings
// weights its two sums by it. It is finite whatever the fit did with a bot, it
// is about zero for exactly the bots that must not vote, and unlike anything
// derived from the covariance it cannot be pushed around by a lopsided corner of
// the board.
func botStrengthVariance(
	edges []botPairEdge,
	strength []float64,
	fixed map[int]bool,
) ([]float64, []float64) {
	count := len(strength)
	variance := make([]float64, count)
	evidence := make([]float64, count)
	for index := range evidence {
		evidence[index] = 1
	}
	if count < 2 {
		return variance, evidence
	}

	information := make([][]float64, count)
	for index := range information {
		information[index] = make([]float64, count)
		// A ridge, and emphatically not a prior: it is far too small to be
		// evidence about anybody, it never touches the fit itself, and it exists
		// so that a ladder whose weakest corner has gone lopsided enough to
		// disconnect numerically still inverts. Its effect is to cap how
		// uncertain the answer is allowed to admit to being.
		information[index][index] = botRatingRidge
	}
	for _, edge := range edges {
		total := strength[edge.low] + strength[edge.high]
		weight := edge.games * strength[edge.low] * strength[edge.high] / (total * total)
		information[edge.low][edge.low] += weight
		information[edge.high][edge.high] += weight
		information[edge.low][edge.high] -= weight
		information[edge.high][edge.low] -= weight
	}
	for index := range count {
		evidence[index] = information[index][index]
	}

	// The approximation, and the failure branch, are the same answer: each bot's
	// own diagonal, inverted. It ignores that a farmer and their throwaway are
	// uncertain together, which is the thing the full inverse knows and the
	// reason it is worth a cubic below.
	approximate := func() ([]float64, []float64) {
		for index := range variance {
			variance[index] = 1 / information[index][index]
		}
		for index := range fixed {
			variance[index] = 0
		}
		capVariances(variance)
		return variance, evidence
	}
	if count > botRatingExactVarianceLimit {
		return approximate()
	}

	free := count - len(fixed)
	if free < 1 {
		return approximate()
	}
	reduced := make([][]float64, 0, free)
	mapping := make([]int, 0, free)
	for row := range count {
		if fixed[row] {
			continue
		}
		line := make([]float64, 0, free)
		for column := range count {
			if fixed[column] {
				continue
			}
			line = append(line, information[row][column])
		}
		reduced = append(reduced, line)
		mapping = append(mapping, row)
	}
	reducedCovariance := inverseOf(reduced)
	if reducedCovariance == nil {
		return approximate()
	}
	for row, full := range mapping {
		variance[full] = reducedCovariance[row][row]
		if variance[full] < 0 || math.IsNaN(variance[full]) {
			variance[full] = botRatingVarianceCeiling
		}
	}
	for index := range fixed {
		variance[index] = 0
	}
	capVariances(variance)
	return variance, evidence
}

// inverseOf inverts a symmetric, positive-definite matrix, or returns nil if it
// turns out not to be one.
//
// By Cholesky: H = LLᵀ makes H⁻¹ = L⁻ᵀL⁻¹, and L⁻¹ is one forward substitution
// away, so the whole inverse is two triangular passes and a product. A general
// inverse would be the same cubic with pivoting to worry about.
func inverseOf(matrix [][]float64) [][]float64 {
	count := len(matrix)
	lower := make([][]float64, count)
	for index := range lower {
		lower[index] = make([]float64, count)
	}
	for row := range count {
		for column := 0; column <= row; column++ {
			sum := matrix[row][column]
			for step := range column {
				sum -= lower[row][step] * lower[column][step]
			}
			if row != column {
				lower[row][column] = sum / lower[column][column]
				continue
			}
			if sum <= 0 || math.IsNaN(sum) {
				return nil
			}
			lower[row][row] = math.Sqrt(sum)
		}
	}

	forward := make([][]float64, count)
	for index := range forward {
		forward[index] = make([]float64, count)
	}
	for column := range count {
		forward[column][column] = 1 / lower[column][column]
		for row := column + 1; row < count; row++ {
			sum := 0.0
			for step := column; step < row; step++ {
				sum += lower[row][step] * forward[step][column]
			}
			forward[row][column] = -sum / lower[row][row]
		}
	}

	inverse := make([][]float64, count)
	for index := range inverse {
		inverse[index] = make([]float64, count)
	}
	for row := range count {
		for column := row; column < count; column++ {
			sum := 0.0
			for step := max(row, column); step < count; step++ {
				sum += forward[step][row] * forward[step][column]
			}
			inverse[row][column] = sum
			inverse[column][row] = sum
		}
	}
	return inverse
}

// storeBotRatingsTx writes a fit over one mode's bot rating rows, and records
// every number that moved.
//
// Every bot rated in the mode is written, not only those in the fit: a bot with
// no ranked bot-versus-bot games left — because they were deleted, or because
// its only opponent was a person — goes back to RatingFloor. Holding a number
// won under the old system would be claiming evidence that no longer exists.
//
// Only rows whose rating actually changed are touched, which is what keeps
// updated_at_unix_ms honest: a refit runs on a clock and touches the whole mode,
// so without the comparison a bot that has not played since May would look like
// it moved this afternoon. The same comparison decides what goes into
// rating_history, so that series is a list of moves rather than a list of
// refits — with decay, a ladder that logged every pass would log every bot every
// hour for ever.
func storeBotRatingsTx(
	ctx context.Context,
	transaction *sql.Tx,
	modeID game.ModeID,
	ratings map[string]int,
	confidence map[string]float64,
	now int64,
) error {
	rows, err := transaction.QueryContext(ctx, `
SELECT r.user_id, r.elo, r.rating_placed, r.rating_confidence
FROM account_mode_ratings r
JOIN accounts a ON a.user_id = r.user_id AND a.kind = ?
WHERE r.mode_id = ?
`, AccountKindBot, modeID)
	if err != nil {
		return fmt.Errorf("bot ladder: list rated bots: %w", err)
	}
	type held struct {
		userID     string
		rating     int
		placed     bool
		confidence float64
	}
	rated := make([]held, 0, len(ratings))
	for rows.Next() {
		var row held
		if err := rows.Scan(
			&row.userID, &row.rating, &row.placed, &row.confidence,
		); err != nil {
			rows.Close()
			return fmt.Errorf("bot ladder: list rated bots: %w", err)
		}
		rated = append(rated, row)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("bot ladder: list rated bots: %w", err)
	}
	rows.Close()

	for _, row := range rated {
		rating := botRatingOr(ratings, row.userID)
		// Placement is presence in the fit's output and nothing else. A bot the
		// core would not admit — too few opponents, or a group with no yardstick
		// in it — is absent, and absent is the whole of what "not enough data to
		// rank" means for an engine.
		_, placed := ratings[row.userID]
		kept := confidence[row.userID]
		if rating == row.rating && placed == row.placed && kept == row.confidence {
			continue
		}
		if _, err := transaction.ExecContext(ctx, `
UPDATE account_mode_ratings
SET elo = ?, rating_placed = ?, rating_confidence = ?, updated_at_unix_ms = ?
WHERE user_id = ? AND mode_id = ?
`, rating, boolToInt(placed), kept, now, row.userID, modeID); err != nil {
			return fmt.Errorf("bot ladder: write rating: %w", err)
		}
		// Only a moved *number* is a point on the graph. Confidence drifting while
		// a bot sits idle is real and is why the row was touched, but plotting it
		// would turn the series back into the list of refits recordRatingHistoryTx
		// exists to avoid.
		if rating == row.rating {
			continue
		}
		if err := recordRatingHistoryTx(
			ctx, transaction, row.userID, modeID, rating, now,
		); err != nil {
			return err
		}
	}
	return nil
}

// recordRatingHistoryTx files one point on a rating's graph.
//
// A separate table because the number is now a function of time as well as of
// results: with decay a rating drifts while nobody plays, and game_history's
// four Elo columns cannot show that — there is no game to hang the movement on.
// It is also what makes decay legible rather than mysterious, which matters more
// than the graph does: a rating that fell needs to be able to show that it fell
// slowly and why.
//
// INSERT OR REPLACE on the timestamp so that two refits inside the same
// millisecond leave one point rather than failing.
func recordRatingHistoryTx(
	ctx context.Context,
	transaction *sql.Tx,
	userID string,
	modeID game.ModeID,
	rating int,
	now int64,
) error {
	if _, err := transaction.ExecContext(ctx, `
INSERT OR REPLACE INTO rating_history (user_id, mode_id, rating, at_unix_ms)
VALUES (?, ?, ?, ?)
`, userID, modeID, rating, now); err != nil {
		return fmt.Errorf("bot ladder: write rating history: %w", err)
	}
	return nil
}

// BotModeRatings is where one mode's ladder currently stands: every rated bot
// in it, against the number the last fit wrote.
//
// For a caller that holds ratings of its own. The server keeps one account per
// connected engine so that pairing and the roster do not each go to the
// database, and a per-game system lets it patch that copy from the result it
// just recorded. This one does not: the ladder is a fit over the whole board,
// so a single game restates every bot in the mode and there is nothing in one
// result to patch the rest of the roster from. Re-reading is the only honest
// answer, and it is one indexed scan of a table with a row per bot per mode.
func (store *Store) BotModeRatings(
	ctx context.Context,
	modeID game.ModeID,
) (map[string]int, error) {
	rows, err := store.db.QueryContext(ctx, `
SELECT r.user_id, r.elo FROM account_mode_ratings r
JOIN accounts a ON a.user_id = r.user_id AND a.kind = ?
WHERE r.mode_id = ?
`, AccountKindBot, modeID)
	if err != nil {
		return nil, fmt.Errorf("bot ladder: read mode ratings: %w", err)
	}
	defer rows.Close()

	ratings := make(map[string]int)
	for rows.Next() {
		var userID string
		var elo int
		if err := rows.Scan(&userID, &elo); err != nil {
			return nil, fmt.Errorf("bot ladder: read mode rating row: %w", err)
		}
		ratings[userID] = elo
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("bot ladder: read mode ratings: %w", err)
	}
	return ratings, nil
}

// botRatingOr reads a fit, giving RatingFloor for a bot it does not place.
//
// The distinction the zero value would lose: a bot missing from the fit is one
// the record cannot rank — too few opponents, or a group of its own away from
// the anchor — not a bot rated nothing. On this scale those two answers print
// the same number, and that is by design rather than by accident: the floor is
// where a bot nobody has managed to measure belongs, and it is where a bot the
// fit placed but could not establish would have been shrunk to anyway.
func botRatingOr(ratings map[string]int, userID string) int {
	if rating, found := ratings[userID]; found {
		return rating
	}
	return RatingFloor
}

// refitBotLadderTx rebuilds one mode's bot ladder from the games on record.
func refitBotLadderTx(
	ctx context.Context,
	transaction *sql.Tx,
	modeID game.ModeID,
	now int64,
) error {
	yardsticks, err := botYardsticksTx(ctx, transaction)
	if err != nil {
		return err
	}
	pairs, err := botHeadToHeadTx(ctx, transaction, modeID, now)
	if err != nil {
		return err
	}
	ratings, confidence := fitBotRatings(pairs, yardsticks)
	return storeBotRatingsTx(ctx, transaction, modeID, ratings, confidence, now)
}

// refitAllBotLaddersTx rebuilds every mode a bot is rated in.
//
// Reached from the deletion paths, where what went is a whole bot or a whole
// account and the modes it touched are not worth working out separately.
func refitAllBotLaddersTx(ctx context.Context, transaction *sql.Tx, now int64) error {
	rows, err := transaction.QueryContext(ctx, `
SELECT DISTINCT r.mode_id FROM account_mode_ratings r
JOIN accounts a ON a.user_id = r.user_id AND a.kind = ?
`, AccountKindBot)
	if err != nil {
		return fmt.Errorf("bot ladder: list modes: %w", err)
	}
	modes := make([]game.ModeID, 0, 4)
	for rows.Next() {
		var modeID game.ModeID
		if err := rows.Scan(&modeID); err != nil {
			rows.Close()
			return fmt.Errorf("bot ladder: list modes: %w", err)
		}
		modes = append(modes, modeID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("bot ladder: list modes: %w", err)
	}
	rows.Close()

	for _, modeID := range modes {
		if err := refitBotLadderTx(ctx, transaction, modeID, now); err != nil {
			return err
		}
	}
	return nil
}

// bothBotsTx reports whether a game was between two engines, which is the only
// thing that decides which rating system applies to it.
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

// RefitBotLadder rebuilds one mode's ladder from the games on record.
//
// The single-mode entry point, for the two callers that know which mode moved:
// the debounce that follows a finished engine game, and the ladder pool's own
// tick. Refitting every mode when one of them had a game is three times the work
// for the same answer.
func (store *Store) RefitBotLadder(ctx context.Context, modeID game.ModeID) error {
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("bot ladder: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	if err := refitBotLadderTx(ctx, transaction, modeID, time.Now().UnixMilli()); err != nil {
		return err
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("bot ladder: commit: %w", err)
	}
	return nil
}

// RefitBotLadders rebuilds every bot ladder from the games on record.
//
// Called once at startup, which is what a derived rating buys instead of a
// migration: a database written by any earlier version of this file holds
// numbers that are simply a different function of the same games, and one pass
// replaces them. That is how the move off the 1200-centred scale lands — there
// is nothing to convert, only a refit. It is also the repair for any drift — there should be none,
// since every path that writes a bot game refits inside the same transaction,
// but a ladder that can be recomputed from scratch should be.
func (store *Store) RefitBotLadders(ctx context.Context) error {
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("bot ladder: begin transaction: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	if err := refitAllBotLaddersTx(ctx, transaction, time.Now().UnixMilli()); err != nil {
		return err
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("bot ladder: commit: %w", err)
	}
	return nil
}
