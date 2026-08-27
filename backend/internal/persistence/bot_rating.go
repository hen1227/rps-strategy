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
// in. That is the right system for people, who play whoever the queue hands
// them.
//
// It is the wrong system for engines, because an engine's author picks its
// opponents. A new bot starts at DefaultElo, so beating one pays real points;
// register a throwaway, beat it, retire it, register another, and the ladder
// pays out again every time. Per-game Elo cannot see that happening. It only
// ever looks at two numbers and one result, and by that standard a farm and a
// title match are the same event.
//
// So the bot ladder is not a running total at all. It is the head-to-head
// record — how each bot has done against each other bot — solved for the set of
// strengths that best explains the whole of it. Nothing is awarded and nothing
// is spent. Beating a weak bot a thousand times adds one lopsided pair to that
// record, and a pair only says so much however long it runs.
//
// The model is Bradley–Terry, which is Elo's own: bot i beats bot j with
// probability γi/(γi+γj), and a rating is that strength written on the scale
// people already read, where 400 points is ten-to-one odds. Fitting it is
// Hunter's MM iteration, a few dozen passes of one division per pair.
//
// What makes it hard to farm is not the model. It is four rules, each closing
// what the one before it leaves open, and each written up where it lives:
//
//  1. A matchup is worth at most botRatingPairCap games, so grinding one
//     opponent stops paying.
//  2. A bot needs botRatingMinimumOpponents of them, pruned repeatedly, so
//     minting more throwaways does not get around (1) — see botLadderCore.
//  3. Only one connected group of bots is published, so a league of engines
//     that only play each other is not ranked against everybody else — also
//     botLadderCore.
//  4. Nothing is assumed about a bot nobody has played. There is no prior in
//     this file, and the long note in the constants below is about why.
//
// And what is published is the fit shrunk by how much of it the record actually
// establishes, so a board that cannot tell its engines apart says so instead of
// ranking them by accident.
//
// Humans keep per-game Elo (calculateElo, in sqlite.go). Their opponents come
// from a queue, so the exploit this file exists to close is not open to them,
// and a rating that moves the moment a game ends is worth more to a person than
// one that is exactly right.

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
	// each is two hundred wins over twenty accounts that each arrived believed
	// to be average, and believing that is what pays out. The prune is the
	// answer: a bot whose only opponent is the bot farming it has a record about
	// nobody, so it is not on the ladder, so the games against it are not games
	// the ladder has heard of. Removing it can drop its opponent below the bar
	// in turn, which is why this repeats — a farm collapses from the outside in,
	// and what is left standing is bots with a schedule.
	botRatingMinimumOpponents = 2

	// No prior. Nothing here assumes an unrated bot is probably average, and
	// that omission is load-bearing rather than an oversight.
	//
	// The obvious way to keep a fit like this well behaved is to give every bot
	// a token drawn record against a DefaultElo opponent, which pins the scale
	// and stops an undefeated record meaning an infinite rating. It also hands
	// every account that has ever connected a small pile of "this one is
	// probably average", and *that* is the farm, in one sentence: an author who
	// can register bots can mint that belief and then beat it out of them. Ten
	// wins over each of twenty throwaways is two hundred wins over twenty
	// accounts nobody has any reason to think are average.
	//
	// So an unknown bot's strength is left unknown — a free parameter, with no
	// opinion attached. Beating a bot whose only games are losses to you moves
	// that parameter and tells the ladder nothing about you, which is the
	// truth. What replaces the prior's other two jobs is botLadderCore, which
	// hands the fit a connected graph so the scale is identified without one,
	// and botRatingStrengthFloor below, which keeps a hopeless record finite.

	// What is published is not the fit but the fit shrunk towards the middle of
	// the board, by how much of it the record actually establishes. There is no
	// constant for this: the amount is estimated from the ladder itself, in
	// fitBotRatings, by comparing how spread out the fitted ratings are against
	// how uncertain they each are. A board whose spread is mostly real is barely
	// moved; a board whose spread is mostly noise collapses towards DefaultElo,
	// which is the honest thing for it to do.
	//
	// The alternative was publishing the bottom of each confidence interval,
	// which sounds more conservative and is worse. Subtracting an error bar
	// punishes uncertainty by pushing a bot *down*, so a ladder that cannot
	// place anybody does not go quiet — it drives its honest members to the
	// floor and leaves whoever the arithmetic happened to favour on top. Pulling
	// towards the middle fails the other way: when the record cannot tell bots
	// apart it stops trying, and nobody is ranked by an accident.

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

	// botRatingFloor and botRatingCeiling bound the published number, and with
	// no prior holding the middle they bound the fit itself: a bot that has lost
	// every game it played would otherwise run off to negative infinity and take
	// the iteration with it. Clamping there rather than pulling it towards the
	// centre is the difference that matters — once an opponent is on the floor,
	// beating it again moves nothing, which is exactly what beating it again is
	// worth. The floor also honours the column's CHECK (elo >= 0).
	botRatingFloor   = 100
	botRatingCeiling = 3000

	// botRatingIterations and botRatingTolerance stop the solver. MM converges
	// monotonically and a ladder this size settles in a few dozen passes; the
	// cap is only so that a pathological record cannot spin.
	botRatingIterations = 500
	botRatingTolerance  = 1e-9
)

// strengthFloor and strengthCeiling stop the iteration from chasing a hopeless
// record to zero or a perfect one to infinity. They are numerical bounds, wide
// enough that no real ladder approaches them; the published range is set by
// botRatingFloor and botRatingCeiling, once, at the end.
var (
	strengthFloor   = 1e-9
	strengthCeiling = 1e9
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
// Floats rather than integers because both fields are scaled by the pair cap
// before the fit reads them, and because a draw is half a game to this model.
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

// botHeadToHeadTx reads every ranked bot-versus-bot pair in one mode.
//
// Derived from game_history rather than kept in a table of its own. The games
// are already there and already indexed by the two player columns, so a second
// store would be a second thing to keep in step — and the reason to want one,
// avoiding a recount, does not apply: the recount is a grouped scan of a table
// only bots write to.
//
// Deriving it also makes deletion exact. A head-to-head record has no history
// to unwind, so removing a game and fitting again gives the ladder that would
// have existed had the game never been played, which is more than the per-game
// reversal in admin_delete.go can promise for a human.
func botHeadToHeadTx(
	ctx context.Context,
	transaction *sql.Tx,
	modeID game.ModeID,
) (map[botPairKey]botPairRecord, error) {
	// MIN and MAX of two arguments are SQLite's scalar functions, not the
	// aggregates of the same name, so this groups the two seatings together and
	// scores each row from the low-id bot's side.
	const query = `
SELECT MIN(h.red_player_id, h.blue_player_id) AS low_id,
       MAX(h.red_player_id, h.blue_player_id) AS high_id,
       COUNT(*) AS games,
       SUM(CASE
             WHEN h.outcome = 'draw' THEN 0.5
             WHEN h.winner_player_id = MIN(h.red_player_id, h.blue_player_id) THEN 1.0
             ELSE 0.0
           END) AS low_score
FROM game_history h
JOIN accounts red ON red.user_id = h.red_player_id AND red.kind = ?
JOIN accounts blue ON blue.user_id = h.blue_player_id AND blue.kind = ?
WHERE h.mode_id = ? AND h.ranked = 1
GROUP BY low_id, high_id
`
	rows, err := transaction.QueryContext(ctx, query, AccountKindBot, AccountKindBot, modeID)
	if err != nil {
		return nil, fmt.Errorf("bot ladder: read head to head: %w", err)
	}
	defer rows.Close()

	pairs := make(map[botPairKey]botPairRecord)
	for rows.Next() {
		var key botPairKey
		var record botPairRecord
		if err := rows.Scan(&key.low, &key.high, &record.games, &record.lowScore); err != nil {
			return nil, fmt.Errorf("bot ladder: read head to head row: %w", err)
		}
		pairs[key] = record
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("bot ladder: read head to head: %w", err)
	}
	return pairs, nil
}

// addBotResult folds one more game into a head-to-head record.
//
// It exists so that a game being recorded right now can be fitted before its
// history row is written: the alternative is inserting the row, refitting, and
// going back to fill in the two after-ratings, which is the same work in three
// statements instead of one.
func addBotResult(
	pairs map[botPairKey]botPairRecord,
	redID string,
	blueID string,
	redScore float64,
) {
	key, redIsLow := botPair(redID, blueID)
	record := pairs[key]
	record.games++
	if redIsLow {
		record.lowScore += redScore
	} else {
		record.lowScore += 1 - redScore
	}
	pairs[key] = record
}

// botPairEdge is one pair of the record as the solver sees it: two positions in
// the bot list, and the pair's games and score after the cap has been applied.
type botPairEdge struct {
	low      int
	high     int
	games    float64
	lowScore float64
}

// botLadderCore is the set of bots the record can actually speak about: the
// largest group that all play each other, directly or through somebody, once
// everyone short of botRatingMinimumOpponents has been pruned away.
//
// Two rules, and between them they are what a farm cannot get around.
//
// The prune removes bots with too few distinct opponents, and repeats, because
// removing a throwaway can leave the bot that farmed it with nothing. Twenty
// accounts that have each played one opponent collapse in two passes and take
// that opponent with them.
//
// Keeping one component then handles the farm built to survive the prune. Three
// bots you own that play each other enough to clear the bar are still a private
// league, and a private league's results say where its members stand relative to
// each other and nothing at all about where they stand relative to anybody else.
// There is no honest rating to publish for one. Play the bots that play each
// other and the whole record comes with you.
//
// The component is chosen by size, ties broken by total games and then by the
// walk's sorted order, so that two equal halves cannot flip the whole ladder
// between one refit and the next.
func botLadderCore(pairs map[botPairKey]botPairRecord) map[string]bool {
	opponents := make(map[string]map[string]bool)
	link := func(one string, other string) {
		if opponents[one] == nil {
			opponents[one] = make(map[string]bool)
		}
		opponents[one][other] = true
	}
	for key, record := range pairs {
		if record.games <= 0 {
			continue
		}
		link(key.low, key.high)
		link(key.high, key.low)
	}

	for pruned := true; pruned; {
		pruned = false
		for bot, seen := range opponents {
			if len(seen) >= botRatingMinimumOpponents {
				continue
			}
			for other := range seen {
				delete(opponents[other], bot)
			}
			delete(opponents, bot)
			pruned = true
		}
	}

	remaining := make([]string, 0, len(opponents))
	for bot := range opponents {
		remaining = append(remaining, bot)
	}
	sort.Strings(remaining)

	var best map[string]bool
	var bestGames float64
	visited := make(map[string]bool, len(remaining))
	for _, start := range remaining {
		if visited[start] {
			continue
		}
		component := map[string]bool{start: true}
		visited[start] = true
		for queue := []string{start}; len(queue) > 0; {
			bot := queue[0]
			queue = queue[1:]
			for other := range opponents[bot] {
				if visited[other] {
					continue
				}
				visited[other] = true
				component[other] = true
				queue = append(queue, other)
			}
		}
		games := 0.0
		for key, record := range pairs {
			if component[key.low] && component[key.high] {
				games += record.games
			}
		}
		if len(component) > len(best) ||
			(len(component) == len(best) && games > bestGames) {
			best, bestGames = component, games
		}
	}
	return best
}

// fitBotRatings solves a head-to-head record for one rating per bot.
//
// Four steps, and each of them is answering a different question:
//
//  1. Which bots does the record place at all? That is botLadderCore.
//  2. How strong is each of them, relative to the others? Bradley–Terry, fitted
//     by Hunter's MM iteration.
//  3. How sure is each of those, relative to the middle of the board? The
//     information matrix, inverted.
//  4. Where is the middle? The bots the answer to (3) says we are surest about.
//
// Only bots the core admits come back. A bot that is absent is one the record
// cannot place, not one placed at DefaultElo; saying which is the caller's job.
func fitBotRatings(pairs map[botPairKey]botPairRecord) map[string]int {
	core := botLadderCore(pairs)
	if len(core) == 0 {
		return map[string]int{}
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
	if count == 0 {
		return map[string]int{}
	}

	strength := fitBotStrengths(edges, count)
	variance, weights := botStrengthVariance(edges, strength)
	normalizeWeights(weights)

	// Where the middle of the board is: the weighted mean of the fitted
	// strengths, in log units, with each bot weighted by how sure of it we are.
	// A bot the record barely places has almost no say in where DefaultElo
	// falls, which is what keeps a pile of manufactured accounts from moving the
	// whole ladder underneath everybody else.
	centre := 0.0
	for index := range count {
		centre += weights[index] * math.Log(strength[index])
	}

	// How much of the board's spread is real. The fitted ratings scatter for two
	// reasons — because bots genuinely differ, and because a finite record is
	// noisy — and the second is measured, so subtracting it leaves the first.
	// That ratio is what each bot's distance from the middle gets multiplied by:
	// a well-played ladder keeps almost all of it, and a rating resting on
	// nothing keeps none of it and sits at DefaultElo.
	spread, noise := 0.0, 0.0
	for index := range count {
		deviation := math.Log(strength[index]) - centre
		spread += weights[index] * deviation * deviation
		noise += weights[index] * variance[index]
	}
	real := max(spread-noise, 0)

	ratings := make(map[string]int, count)
	for index, userID := range order {
		deviation := math.Log(strength[index]) - centre
		if real+variance[index] > 0 {
			deviation *= real / (real + variance[index])
		} else {
			deviation = 0
		}
		ratings[userID] = eloFromStrength(deviation)
	}
	return ratings
}

// fitBotStrengths is the Bradley–Terry maximum likelihood fit, by Hunter's MM
// iteration: each bot's next strength is its wins over the sum, across its
// opponents, of that matchup's games divided by the two strengths.
//
// Scale-free, because the record only ever says who beat whom and never how
// good anybody is in the abstract. Each pass is re-scaled on the median purely
// to stop the numbers wandering off; where the ladder actually sits is decided
// once, at the end, by the caller. The bounds are similarly numerical, not a
// judgement: a bot that lost every game it played has no finite strength, and
// something has to stop the iteration chasing it to zero for five hundred
// passes.
func fitBotStrengths(edges []botPairEdge, count int) []float64 {
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
			if updated[index] > 0 {
				updated[index] = score[index] / updated[index]
			} else {
				updated[index] = strength[index]
			}
		}
		middle := medianStrength(updated)
		change := 0.0
		for index := range updated {
			next := min(max(updated[index]/middle, strengthFloor), strengthCeiling)
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

// medianStrength is the middle of a fit, used to keep the iteration's numbers in
// range. The median rather than the mean, because a ladder can carry a tail of
// bots the fit is driving towards zero, and the mean would follow them down.
func medianStrength(strengths []float64) float64 {
	if len(strengths) == 0 {
		return 1
	}
	sorted := append([]float64(nil), strengths...)
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

// botStrengthVariance is how uncertain each fitted rating is relative to the
// middle of the board, in the natural log units the fit works in, along with how
// much say each bot should have in where that middle is.
//
// The Bradley–Terry log-likelihood's information matrix is
//
//	H[i][i] = Σ n·p(1-p) over i's matchups
//	H[i][j] = −n·p(1-p) for the matchup between i and j
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
// the ladder sits, so this takes three steps.
//
// Dropping the best-established bot's row and column removes the singularity and
// leaves a covariance written in gaps from that one bot. Contrasting against a
// flat average of the board then turns those gaps into distances from a middle,
// which is reference-free and rough enough to say which bots the record barely
// places. Contrasting again, this time against a middle weighted towards the
// bots it does place, is the answer: a poorly placed bot no longer gets an equal
// vote on where the middle is, so it cannot make everybody else look uncertain
// by association.
func botStrengthVariance(edges []botPairEdge, strength []float64) ([]float64, []float64) {
	count := len(strength)
	variance := make([]float64, count)
	weights := make([]float64, count)
	for index := range weights {
		weights[index] = 1
	}
	if count < 2 {
		return variance, weights
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
	played := make([]float64, count)
	opponents := make([]int, count)
	for _, edge := range edges {
		total := strength[edge.low] + strength[edge.high]
		weight := edge.games * strength[edge.low] * strength[edge.high] / (total * total)
		information[edge.low][edge.low] += weight
		information[edge.high][edge.high] += weight
		information[edge.low][edge.high] -= weight
		information[edge.high][edge.low] -= weight
		played[edge.low] += edge.games
		played[edge.high] += edge.games
		opponents[edge.low]++
		opponents[edge.high]++
	}

	if count > botRatingExactVarianceLimit {
		for index := range variance {
			variance[index] = 1 / information[index][index]
			weights[index] = information[index][index]
		}
		normalizeWeights(weights)
		return variance, weights
	}

	// The reference is the bot with the most distinct opponents, ties broken by
	// games played and then by the sorted pair order, which makes it
	// deterministic.
	//
	// Distinct opponents rather than games, and the difference is the whole
	// point. Everything below is measured from this bot, so a farm that could
	// nominate the reference could make the honest ladder look uncertain
	// relative to itself and take the board. Games are cheap — a private clique
	// can play a hundred of them in an afternoon — but an opponent is another
	// bot, and five bots per account is a real cost. The bot that has played the
	// most different opponents is the hardest position on the board to buy.
	reference := 0
	for index := range played {
		if opponents[index] > opponents[reference] ||
			(opponents[index] == opponents[reference] && played[index] > played[reference]) {
			reference = index
		}
	}
	reduced := make([][]float64, 0, count-1)
	mapping := make([]int, 0, count-1)
	for row := range count {
		if row == reference {
			continue
		}
		line := make([]float64, 0, count-1)
		for column := range count {
			if column != reference {
				line = append(line, information[row][column])
			}
		}
		reduced = append(reduced, line)
		mapping = append(mapping, row)
	}
	reducedCovariance := inverseOf(reduced)
	if reducedCovariance == nil {
		for index := range variance {
			variance[index] = 1 / information[index][index]
			weights[index] = information[index][index]
		}
		normalizeWeights(weights)
		return variance, weights
	}

	// Back to full size, with the reference as a row of zeros: everything is
	// measured from it, so it is measured from itself exactly.
	covariance := make([][]float64, count)
	for index := range covariance {
		covariance[index] = make([]float64, count)
	}
	for row, fullRow := range mapping {
		for column, fullColumn := range mapping {
			covariance[fullRow][fullColumn] = reducedCovariance[row][column]
		}
	}

	// Var(θi − Σ w·θ) for a covariance written in gaps from the reference: the
	// variance of a bot's distance from a weighted middle of the board.
	//
	// Reference-free for any fixed w, which is why it is worth writing out.
	// covariance[i][i] on its own means "relative to the reference bot", and
	// that answer changes with which bot got picked; this contrast does not,
	// because it is orthogonal to the one direction the record leaves
	// undetermined. Two runs over the same games have to agree, and bots are
	// identified by random UUIDs, so anything that varied with their order would
	// be a ladder that shuffled itself on restart.
	contrast := func(weights []float64) []float64 {
		weighted := make([]float64, count)
		middle := 0.0
		for row := range count {
			for column := range count {
				weighted[row] += weights[column] * covariance[row][column]
			}
		}
		for index := range count {
			middle += weights[index] * weighted[index]
		}
		spread := make([]float64, count)
		for index := range count {
			spread[index] = covariance[index][index] - 2*weighted[index] + middle
			if spread[index] < 0 || math.IsNaN(spread[index]) {
				spread[index] = 0
			}
		}
		return spread
	}

	// Twice, because the weights want to be inverse-variance and the variance
	// depends on the weights. The first pass gives every bot an equal say, which
	// is enough to find out which of them the record barely places; the second
	// takes their say away in proportion.
	uniform := make([]float64, count)
	for index := range uniform {
		uniform[index] = 1 / float64(count)
	}
	rough := contrast(uniform)

	typical := 0.0
	for index := range rough {
		typical += rough[index]
	}
	typical /= float64(count)
	if typical <= 0 || math.IsNaN(typical) {
		typical = 1
	}
	for index := range weights {
		weights[index] = 1 / (rough[index] + typical)
	}
	normalizeWeights(weights)
	return contrast(weights), weights
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

// eloFromStrength writes a fitted strength on the scale the rest of the game
// uses. It arrives already measured from the middle of the board and already
// shrunk, in the fit's natural log units, so DefaultElo is where an average bot
// lands and 400 points is the ten-to-one odds it means everywhere else.
func eloFromStrength(centred float64) int {
	if math.IsNaN(centred) {
		return DefaultElo
	}
	rating := int(math.Round(DefaultElo + 400*centred/math.Ln10))
	return min(max(rating, botRatingFloor), botRatingCeiling)
}

// storeBotRatingsTx writes a fit over one mode's bot rating rows.
//
// Every bot rated in the mode is written, not only those in the fit: a bot with
// no ranked bot-versus-bot games left — because they were deleted, or because
// its only opponent was a person — goes back to DefaultElo. Holding a number
// won under the old system would be claiming evidence that no longer exists.
//
// The `elo <> ?` is what keeps updated_at_unix_ms honest. A refit runs after
// every ranked bot game and touches the whole mode, so without it a bot that
// has not played since May would look like it moved this afternoon.
func storeBotRatingsTx(
	ctx context.Context,
	transaction *sql.Tx,
	modeID game.ModeID,
	ratings map[string]int,
	now int64,
) error {
	rows, err := transaction.QueryContext(ctx, `
SELECT r.user_id FROM account_mode_ratings r
JOIN accounts a ON a.user_id = r.user_id AND a.kind = ?
WHERE r.mode_id = ?
`, AccountKindBot, modeID)
	if err != nil {
		return fmt.Errorf("bot ladder: list rated bots: %w", err)
	}
	rated := make([]string, 0, len(ratings))
	for rows.Next() {
		var userID string
		if err := rows.Scan(&userID); err != nil {
			rows.Close()
			return fmt.Errorf("bot ladder: list rated bots: %w", err)
		}
		rated = append(rated, userID)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("bot ladder: list rated bots: %w", err)
	}
	rows.Close()

	for _, userID := range rated {
		rating := botRatingOr(ratings, userID)
		if _, err := transaction.ExecContext(ctx, `
UPDATE account_mode_ratings
SET elo = ?, updated_at_unix_ms = ?
WHERE user_id = ? AND mode_id = ? AND elo <> ?
`, rating, now, userID, modeID, rating); err != nil {
			return fmt.Errorf("bot ladder: write rating: %w", err)
		}
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

// botRatingOr reads a fit, giving DefaultElo for a bot it does not place.
//
// The distinction the zero value would lose: a bot missing from the fit is one
// the record cannot rank — too few opponents, or a group of its own away from
// the ladder — not a bot rated nothing.
func botRatingOr(ratings map[string]int, userID string) int {
	if rating, found := ratings[userID]; found {
		return rating
	}
	return DefaultElo
}

// refitBotLadderTx rebuilds one mode's bot ladder from the games on record.
func refitBotLadderTx(
	ctx context.Context,
	transaction *sql.Tx,
	modeID game.ModeID,
	now int64,
) error {
	pairs, err := botHeadToHeadTx(ctx, transaction, modeID)
	if err != nil {
		return err
	}
	return storeBotRatingsTx(ctx, transaction, modeID, fitBotRatings(pairs), now)
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

// RefitBotLadders rebuilds every bot ladder from the games on record.
//
// Called once at startup, which is what a derived rating buys instead of a
// migration: a database written by the old per-game system holds bot Elos that
// are simply a different function of the same games, and one pass replaces them
// with the fit. It is also the repair for any drift — there should be none,
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
