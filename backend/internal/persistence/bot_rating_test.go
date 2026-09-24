package persistence

import (
	"fmt"
	"math/rand"
	"sort"
	"strings"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
)

// record builds a head-to-head record the way the database would report it, so
// the tests below read as the matchups they are about rather than as map keys.
type record struct {
	first  string
	second string
	games  float64
	// firstScore is what `first` took out of those games, a draw counting half.
	firstScore float64
}

func headToHead(entries ...record) map[botPairKey]botPairRecord {
	pairs := make(map[botPairKey]botPairRecord, len(entries))
	for _, entry := range entries {
		key, firstIsLow := botPair(entry.first, entry.second)
		pair := pairs[key]
		pair.games += entry.games
		if firstIsLow {
			pair.lowScore += entry.firstScore
		} else {
			pair.lowScore += entry.games - entry.firstScore
		}
		pairs[key] = pair
	}
	return pairs
}

// testYardsticks is the anchor these boards are measured from.
//
// Named and wired up by hand rather than folded into headToHead, because half
// the tests in this file are about a farm that must *not* touch it. A yardstick
// opponent exempts a bot from the opponent-count prune — see botLadderCore — so
// a board where the anchor plays everybody is a board where nothing is ever
// pruned, and the rules under test would never fire.
var testYardsticks = BotYardsticks{
	Anchor: "anchor",
	Slots:  map[string]string{"anchor": BenchmarkRandom},
}

// fit solves a record the way the server does.
func fit(entries ...record) map[string]int {
	ratings, _ := fitBotRatings(headToHead(entries...), testYardsticks)
	return ratings
}

// anchored puts the anchor underneath a field: it plays each of them and takes
// a quarter of the games, which is roughly the record a random mover leaves
// against engines close enough for the results to mean anything.
//
// Every board that expects to be rated needs this. The fit publishes distances
// from the anchor, so a component the anchor is not in has no distances to
// publish and comes back empty.
func anchored(games float64, bots ...string) []record {
	entries := make([]record, 0, len(bots))
	for _, bot := range bots {
		entries = append(entries, record{
			first: "anchor", second: bot, games: games, firstScore: games / 4,
		})
	}
	return entries
}

// addBotResult folds one more game into a head-to-head record.
//
// A test helper rather than production code: the server builds records with one
// grouped query, and nothing outside these tests plays games one at a time.
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

// roundRobin is every pairing among these bots, split evenly, which is the
// shape an all-bot tournament leaves behind.
func roundRobin(games float64, bots ...string) []record {
	entries := make([]record, 0, len(bots)*len(bots))
	for first := range bots {
		for second := first + 1; second < len(bots); second++ {
			entries = append(entries, record{
				first: bots[first], second: bots[second],
				games: games, firstScore: games / 2,
			})
		}
	}
	return entries
}

// graded is every pairing among these bots with the earlier one winning three
// in four, so the board comes out in the order it was written in.
func graded(games float64, bots ...string) []record {
	entries := make([]record, 0, len(bots)*len(bots))
	for first := range bots {
		for second := first + 1; second < len(bots); second++ {
			entries = append(entries, record{
				first: bots[first], second: bots[second],
				games: games, firstScore: games * 0.75,
			})
		}
	}
	return entries
}

// The anchor is the scale, so it reads RatingFloor whatever it did, and it is
// the one number on the board that is a definition rather than a measurement.
func TestTheAnchorIsAlwaysTheFloor(t *testing.T) {
	field := []string{"field-1", "field-2", "field-3"}
	// Once where it is crushed, and once where it is winning most of its games:
	// neither is allowed to move it.
	for _, share := range []float64{0, 5, 16} {
		entries := roundRobin(20, field...)
		for _, bot := range field {
			entries = append(entries, record{
				first: "anchor", second: bot, games: 20, firstScore: share,
			})
		}
		ratings := fit(entries...)
		if ratings["anchor"] != RatingFloor {
			t.Fatalf("the anchor scoring %v of 20 rated %d, not %d",
				share, ratings["anchor"], RatingFloor)
		}
	}
}

// A board with a known shape, played out and recovered. This is the test that
// notices if the unit, the declarations or the shrinkage drifts: everything else
// here asserts an ordering, and an ordering survives a scale being wrong.
//
// Built on the real benchmark ladder rather than on invented rungs, because the
// declarations are now part of the fit rather than data fed to it — and because
// the interesting question about a declared ladder is whether its own spacing is
// measurable. A rung is only useful if the engines around it can lose to it
// often enough for the games to carry information; this test fails if the gaps
// in benchmarks.go are ever opened up far enough that they cannot.
func TestTheFitRecoversStrengthsItWasBuiltFrom(t *testing.T) {
	truth := map[string]int{}
	yardsticks := BotYardsticks{Anchor: "anchor", Slots: map[string]string{}}
	names := []string{}
	for index, benchmark := range Benchmarks() {
		name := fmt.Sprintf("rung-%d", index)
		if benchmark.Slot == BenchmarkRandom {
			name = "anchor"
		}
		truth[name] = benchmark.Rating
		yardsticks.Slots[name] = benchmark.Slot
		names = append(names, name)
	}
	// A field around and above the top rung, which is where this board's engines
	// actually live: the yardsticks are the bottom of the ladder, not the middle
	// of it. See the note in benchmarks.go about the chain.
	for name, rating := range map[string]int{
		"carol": 320, "alice": 520, "bob": 660, "dave": 760,
	} {
		truth[name] = rating
		names = append(names, name)
	}
	sort.Strings(names)

	// Deterministic: a rating suite that fails one run in twenty is one nobody
	// will trust the twentieth time.
	random := rand.New(rand.NewSource(7))
	pairs := make(map[botPairKey]botPairRecord)
	for first := range names {
		for second := first + 1; second < len(names); second++ {
			chance := RatingWinProbability(truth[names[first]], truth[names[second]])
			for range 60 {
				score := 0.0
				if random.Float64() < chance {
					score = 1
				}
				addBotResult(pairs, names[first], names[second], score)
			}
		}
	}

	ratings, _ := fitBotRatings(pairs, yardsticks)
	for _, name := range names {
		// The declared rungs are held exactly; only the free bots are being
		// recovered, and they are allowed the width of two doublings.
		tolerance := 40
		if _, declared := yardsticks.Slots[name]; declared {
			tolerance = 0
		}
		if missed := ratings[name] - truth[name]; missed > tolerance || missed < -tolerance {
			t.Fatalf("%s was built at %d and fitted at %d (%+d): %#v",
				name, truth[name], ratings[name], missed, ratings)
		}
	}
}

// The question a declared ladder invites: the yardsticks stop at the top rung,
// and the field does not. An engine well above the strongest declaration has to
// be placed by chaining through the board rather than by beating a yardstick it
// cannot lose to, and the ladder has to keep its order while doing it.
//
// What is asserted is the order and the direction, not a value. Extrapolating
// above the last rung is the weakest measurement this file makes — a matchup at
// p ≈ 1 carries almost nothing, which is the whole reason the rungs exist — so
// pinning an exact number here would be asserting a precision the record does
// not have. See the note in benchmarks.go about adding a rung above the field.
func TestTheBoardStaysOrderedAboveTheTopRung(t *testing.T) {
	top := 0
	yardsticks := BotYardsticks{Anchor: "anchor", Slots: map[string]string{}}
	truth := map[string]int{}
	names := []string{}
	for index, benchmark := range Benchmarks() {
		name := fmt.Sprintf("rung-%d", index)
		if benchmark.Slot == BenchmarkRandom {
			name = "anchor"
		}
		truth[name] = benchmark.Rating
		yardsticks.Slots[name] = benchmark.Slot
		names = append(names, name)
		top = max(top, benchmark.Rating)
	}
	// A ladder of engines climbing away from the strongest rung, each a couple of
	// doublings above the last, which is about as sparse as a real field gets.
	climbing := []string{"above-1", "above-2", "above-3", "above-4"}
	for step, name := range climbing {
		truth[name] = top + 50*(step+1)
		names = append(names, name)
	}
	sort.Strings(names)

	random := rand.New(rand.NewSource(11))
	pairs := make(map[botPairKey]botPairRecord)
	for first := range names {
		for second := first + 1; second < len(names); second++ {
			chance := RatingWinProbability(truth[names[first]], truth[names[second]])
			for range 60 {
				score := 0.0
				if random.Float64() < chance {
					score = 1
				}
				addBotResult(pairs, names[first], names[second], score)
			}
		}
	}
	ratings, _ := fitBotRatings(pairs, yardsticks)

	for step, name := range climbing {
		if ratings[name] <= top {
			t.Errorf("%s was built %d above the top rung and fitted at %d",
				name, truth[name]-top, ratings[name])
		}
		if step > 0 {
			if previous := climbing[step-1]; ratings[name] <= ratings[previous] {
				t.Errorf("%s (%d) did not out-rate %s (%d), and was built above it",
					name, ratings[name], previous, ratings[previous])
			}
		}
	}
	// And the ceiling is a guard, not a grade: nothing here should be near it.
	for _, name := range climbing {
		if ratings[name] >= RatingCeiling {
			t.Errorf("%s hit the ceiling at %d; the ceiling is meant to be unreachable",
				name, ratings[name])
		}
	}
}

// The whole point of the file. A bot that beat one throwaway two hundred times
// has demonstrated nothing, and the ladder says so by not ranking it at all:
// the throwaway has one opponent, so it is pruned, which leaves the farmer with
// none, so it goes too.
//
// Under the per-game Elo this replaced, the farm won outright. Every one of
// those two hundred wins took points off an account that started at the middle
// of the board, and no amount of real play could keep up with a loop that never
// has to lose.
func TestFarmingOneWeakBotLeavesYouUnrated(t *testing.T) {
	field := []string{"field-1", "field-2", "field-3", "field-4"}
	entries := append(roundRobin(20, field...), anchored(20, field...)...)
	for _, opponent := range field {
		entries = append(entries, record{
			first: "contender", second: opponent, games: 20, firstScore: 15,
		})
	}
	entries = append(entries, record{
		first: "farmer", second: "throwaway", games: 200, firstScore: 200,
	})

	ratings := fit(entries...)
	if _, found := ratings["farmer"]; found {
		t.Fatalf("200-0 against one throwaway earned a rating: %#v", ratings)
	}
	if _, found := ratings["throwaway"]; found {
		t.Fatalf("a bot with one opponent was ranked: %#v", ratings)
	}
	// And the farm has not touched the ladder it was run alongside.
	if ratings["contender"] <= ratings["field-1"] {
		t.Fatalf("the real schedule should still rank: %#v", ratings)
	}
}

// Minting more throwaways is the obvious way around a per-pair limit, so the
// prune repeats until nothing is left short of the bar. Twenty accounts that
// have each played one opponent take that opponent down with them.
func TestFarmingManyThrowawaysLeavesYouUnrated(t *testing.T) {
	field := []string{"field-1", "field-2", "field-3", "field-4"}
	entries := append(roundRobin(20, field...), anchored(20, field...)...)
	for index := range 20 {
		entries = append(entries, record{
			first:  "farmer",
			second: fmt.Sprintf("throwaway-%d", index),
			games:  10, firstScore: 10,
		})
	}

	ratings := fit(entries...)
	if _, found := ratings["farmer"]; found {
		t.Fatalf("two hundred wins over twenty throwaways earned a rating: %#v", ratings)
	}
	if len(ratings) != len(field)+1 {
		t.Fatalf("expected only the real field and the anchor, got %#v", ratings)
	}
}

// A farm built to survive the prune — bots that play each other enough to clear
// the bar — is still a private league, and a private league says nothing about
// where its members stand against the anchor, which is the only thing a rating
// on this scale claims. It is not connected to the ladder, so it is not ranked.
func TestAPrivateLeagueIsNotTheLadder(t *testing.T) {
	field := []string{"field-1", "field-2", "field-3", "field-4", "field-5"}
	entries := append(roundRobin(20, field...), anchored(20, field...)...)
	entries = append(entries,
		record{first: "farmer", second: "mine-1", games: 20, firstScore: 20},
		record{first: "farmer", second: "mine-2", games: 20, firstScore: 20},
		record{first: "mine-1", second: "mine-2", games: 20, firstScore: 10},
	)

	ratings := fit(entries...)
	if _, found := ratings["farmer"]; found {
		t.Fatalf("a private league earned a rating: %#v", ratings)
	}
	if len(ratings) != len(field)+1 {
		t.Fatalf("expected only the real field and the anchor, got %#v", ratings)
	}
}

// Two hundred games and twenty games at the same ratio are the same claim about
// which bot is better, so they have to rate the same. This is botRatingPairCap,
// and it is what stops a farm from simply being run for longer.
func TestGamesPastThePairCapChangeNothing(t *testing.T) {
	// field-1 and field-2 are deliberately left out of the round robin and
	// given their matchup by hand, so that the two calls below differ in the
	// length of one run and in nothing else. Merged into a round-robin pairing
	// they would also differ in ratio, and the test would be asking a question
	// it does not mean to ask.
	ladder := func(games float64, score float64) map[string]int {
		entries := append(
			graded(20, "field-1", "field-3", "field-4", "field-5"),
			anchored(20, "field-1", "field-2", "field-3", "field-4", "field-5")...,
		)
		entries = append(entries,
			graded(20, "field-2", "field-3", "field-4", "field-5")...,
		)
		entries = append(entries, record{
			first: "field-1", second: "field-2", games: games, firstScore: score,
		})
		return fit(entries...)
	}
	short := ladder(botRatingPairCap, botRatingPairCap*0.75)
	long := ladder(400, 300)
	if len(short) == 0 {
		t.Fatal("the ladder under test came back empty")
	}
	// A board this graded must actually separate, or the assertion below holds
	// for the wrong reason.
	if short["field-1"] <= short["field-5"] {
		t.Fatalf("the graded field did not separate: %#v", short)
	}
	for bot, rating := range short {
		if long[bot] != rating {
			t.Fatalf("the pair cap did not hold: %s is %d over %d games and %d over 400",
				bot, rating, int(botRatingPairCap), long[bot])
		}
	}
}

// Strength of schedule. Two challengers with identical scorelines, one against
// the top of the board and one against the bottom, do not rate the same. This is
// what makes the ladder worth climbing honestly: the way up is to play the bots
// the rest of the board rates highly.
func TestBeatingStrongBotsIsWorthMoreThanBeatingWeakOnes(t *testing.T) {
	field := []string{"field-1", "field-2", "field-3", "field-4"}
	entries := append(graded(20, field...), anchored(20, field...)...)
	entries = append(entries,
		record{first: "honest", second: "field-1", games: 20, firstScore: 15},
		record{first: "honest", second: "field-2", games: 20, firstScore: 15},
		record{first: "farmer", second: "field-3", games: 20, firstScore: 15},
		record{first: "farmer", second: "field-4", games: 20, firstScore: 15},
	)

	ratings := fit(entries...)
	if ratings["honest"] <= ratings["farmer"] {
		t.Fatalf(
			"the same scoreline against a stronger schedule rated no higher: honest %d, farmer %d",
			ratings["honest"], ratings["farmer"],
		)
	}
}

// A bot that has never played the bot above it still ranks below it, as long as
// the rest of the board joins their records up. A ladder that could only compare
// bots that had actually met would be a pile of unrelated pairs.
func TestRatingsAreTransitiveThroughSharedOpponents(t *testing.T) {
	// top and bottom never meet. Both play the two middle bots, who play each
	// other, so everybody clears the two-opponent bar without the one matchup
	// the assertion is about ever being played.
	entries := append(anchored(20, "middle-1", "middle-2"),
		record{first: "middle-1", second: "middle-2", games: 20, firstScore: 10},
		record{first: "top", second: "middle-1", games: 20, firstScore: 15},
		record{first: "top", second: "middle-2", games: 20, firstScore: 15},
		record{first: "bottom", second: "middle-1", games: 20, firstScore: 5},
		record{first: "bottom", second: "middle-2", games: 20, firstScore: 5},
	)
	ratings := fit(entries...)
	if !(ratings["top"] > ratings["middle-1"] && ratings["middle-1"] > ratings["bottom"]) {
		t.Fatalf("expected top > middle > bottom, got %#v", ratings)
	}
}

// A bot needs opponents, not games. One matchup played to death is a record
// about one matchup, and the ladder has nothing to say about it.
func TestABotWithOneOpponentIsNotRanked(t *testing.T) {
	field := []string{"field-1", "field-2", "field-3", "field-4"}
	entries := append(roundRobin(20, field...), anchored(20, field...)...)
	entries = append(entries, record{
		first: "newcomer", second: "field-1", games: 500, firstScore: 300,
	})
	ratings := fit(entries...)
	if _, found := ratings["newcomer"]; found {
		t.Fatalf("a bot with a single opponent was ranked: %#v", ratings)
	}
}

// The other half of that: two opponents is enough to be ranked, and a bot that
// beats established engines ranks above them.
func TestTwoOpponentsIsEnoughToBeRanked(t *testing.T) {
	field := []string{"field-1", "field-2", "field-3", "field-4"}
	entries := append(roundRobin(20, field...), anchored(20, field...)...)
	entries = append(entries,
		record{first: "newcomer", second: "field-1", games: 20, firstScore: 16},
		record{first: "newcomer", second: "field-2", games: 20, firstScore: 16},
	)
	ratings := fit(entries...)
	if ratings["newcomer"] <= ratings["field-1"] {
		t.Fatalf("beating two established bots should rank above them: %#v", ratings)
	}
}

// One opponent is enough when it is a yardstick, and this is the exemption that
// makes the ladder something a new bot can join in an afternoon rather than a
// club it has to be let into.
//
// The prune exists because measuring yourself against an unmeasured opponent
// establishes nothing. A yardstick is the opposite case — it is what the scale
// is defined by — so a record made entirely of games against the server's own
// engines is complete, and a newcomer that has only ever played the anchor has a
// real rating on its first day.
func TestOneYardstickOpponentIsEnoughToBeRanked(t *testing.T) {
	ratings, _ := fitBotRatings(headToHead(
		record{first: "anchor", second: "rung-1", games: 20, firstScore: 6},
		record{first: "newcomer", second: "anchor", games: 20, firstScore: 18},
	), BotYardsticks{
		Anchor: "anchor",
		Slots:  map[string]string{"anchor": BenchmarkRandom, "rung-1": BenchmarkGreedy},
	})

	if _, found := ratings["newcomer"]; !found {
		t.Fatalf("a bot whose only opponent is the anchor was not ranked: %#v", ratings)
	}
	if ratings["newcomer"] <= RatingFloor {
		t.Fatalf("beating the anchor 18-2 should rank above it: %#v", ratings)
	}
}

// A board level with the anchor is a board of bots that play like chance, and
// the floor is where they belong. There is no middle to sit at any more: the old
// scale published this at 1200, alongside every bot it had no evidence about,
// which is two opposite claims printed the same way.
func TestABoardLevelWithTheAnchorSitsAtTheFloor(t *testing.T) {
	field := []string{"field-1", "field-2", "field-3", "field-4"}
	entries := append(roundRobin(20, field...), roundRobin(20, "anchor", "field-1")...)
	for _, bot := range field[1:] {
		entries = append(entries, record{
			first: "anchor", second: bot, games: 20, firstScore: 10,
		})
	}
	for bot, rating := range fit(entries...) {
		if rating != RatingFloor {
			t.Fatalf("a board level with the anchor should sit at %d: %s is %d",
				RatingFloor, bot, rating)
		}
	}
}

// Go randomises map order and the fit is floating point, so the same record has
// to be sorted into a fixed order before it is solved. Without that, a ladder
// could come out different on two runs of the same binary over the same games.
func TestTheFitIsDeterministic(t *testing.T) {
	entries := append(roundRobin(7, "a", "b", "c", "d", "e"),
		anchored(7, "a", "b", "c", "d", "e")...)
	entries = append(entries, record{first: "a", second: "c", games: 9, firstScore: 8})
	first := fit(entries...)
	if len(first) != 6 {
		t.Fatalf("expected the whole round robin and the anchor, got %#v", first)
	}
	for range 20 {
		again := fit(entries...)
		for bot, rating := range first {
			if again[bot] != rating {
				t.Fatalf("fit is not deterministic: %s was %d then %d", bot, rating, again[bot])
			}
		}
	}
}

// Bots are identified by random UUIDs, so anything in the fit that varied with
// their order would be a ladder that shuffled itself every restart. This caught
// a real one: the weights deciding where the middle of the board sat were being
// read off a variance measured from whichever bot happened to sort first.
func TestRenamingBotsDoesNotChangeTheLadder(t *testing.T) {
	entries := append(anchored(20, "alpha", "bravo", "charlie", "delta"),
		record{first: "alpha", second: "bravo", games: 20, firstScore: 13},
		record{first: "alpha", second: "charlie", games: 12, firstScore: 9},
		record{first: "bravo", second: "charlie", games: 20, firstScore: 11},
		record{first: "charlie", second: "delta", games: 8, firstScore: 6},
		record{first: "alpha", second: "delta", games: 20, firstScore: 17},
	)
	original := fit(entries...)
	if len(original) != 5 {
		t.Fatalf("expected all four bots and the anchor ranked, got %#v", original)
	}

	// The same record with the names permuted. Every rating has to follow its
	// bot exactly. The anchor keeps its name, because it is the one identity in
	// the record that means something.
	renamed := map[string]string{
		"alpha": "zulu", "bravo": "yankee", "charlie": "xray", "delta": "whiskey",
		"anchor": "anchor",
	}
	moved := make([]record, 0, len(entries))
	for _, entry := range entries {
		moved = append(moved, record{
			first:  renamed[entry.first],
			second: renamed[entry.second],
			games:  entry.games, firstScore: entry.firstScore,
		})
	}
	after := fit(moved...)
	for bot, rating := range original {
		if after[renamed[bot]] != rating {
			t.Fatalf("%s rated %d, but %s rated %d over the same record",
				bot, rating, renamed[bot], after[renamed[bot]])
		}
	}
}

// Winning must never cost a bot rating. It is not automatic for a fit — the
// whole board is solved again from scratch every time, so a rating is free to
// move in either direction — and a ladder that took points off the winner would
// be indefensible whatever its other properties.
func TestABetterResultNeverLowersARating(t *testing.T) {
	field := []string{"field-1", "field-2", "field-3", "field-4", "field-5", "field-6"}
	ladder := func(scoreAgainstTop float64) int {
		entries := append(roundRobin(12, field...), anchored(12, field...)...)
		entries = append(entries,
			record{first: "climber", second: "field-1", games: 12, firstScore: scoreAgainstTop},
			record{first: "climber", second: "field-2", games: 12, firstScore: 6},
			record{first: "climber", second: "field-3", games: 12, firstScore: 6},
		)
		return fit(entries...)["climber"]
	}
	previous := ladder(0)
	for won := 1; won <= 12; won++ {
		current := ladder(float64(won))
		if current < previous {
			t.Fatalf("winning %d of 12 rated %d, below the %d for winning %d",
				won, current, previous, won-1)
		}
		previous = current
	}
}

// An empty ladder is a real state — a fresh database, or a mode no bot has been
// ranked in yet — and it has to come back empty rather than panicking on the
// matrix that has no rows.
func TestFittingAnEmptyRecordIsEmpty(t *testing.T) {
	if ratings, _ := fitBotRatings(nil, testYardsticks); len(ratings) != 0 {
		t.Fatalf("expected no ratings, got %#v", ratings)
	}
}

// A board with no yardstick rates itself, from its own weakest engine up.
//
// This used to publish nothing at all, on the grounds that a scale-free fit has
// no zero to be measured from. It now takes its zero from the record: the
// weakest bot the fit can speak about sits at RatingFloor and everybody else is
// their measured distance above it. The gaps are the same gaps either way — what
// the rungs add is that the zero stops moving. See ladderZero.
func TestABoardWithNoYardstickRatesFromItsWeakestEngine(t *testing.T) {
	entries := graded(20, "a", "b", "c", "d")
	for label, ratings := range map[string]map[string]int{
		"no yardstick on the record": fit(entries...),
		"no yardstick in the database": func() map[string]int {
			ratings, _ := fitBotRatings(headToHead(entries...), BotYardsticks{})
			return ratings
		}(),
	} {
		if len(ratings) != 4 {
			t.Fatalf("%s: rated %d of 4 bots: %#v", label, len(ratings), ratings)
		}
		// graded builds a in front of b in front of c in front of d.
		if !(ratings["a"] > ratings["b"] &&
			ratings["b"] > ratings["c"] &&
			ratings["c"] > ratings["d"]) {
			t.Errorf("%s: out of order: %#v", label, ratings)
		}
		if ratings["d"] != RatingFloor {
			t.Errorf("%s: the weakest engine read %d, want %d",
				label, ratings["d"], RatingFloor)
		}
	}
}

// Nothing publishes below the floor, whichever branch set the zero.
//
// With rungs it is a clamp in ratingFromLogOdds; without them it is arithmetic —
// the zero *is* the minimum, so no distance from it can be negative. Worth a
// test of its own because the second is the property a reader would assume is a
// clamp and would be free to break.
func TestNoBotIsPublishedBelowTheFloor(t *testing.T) {
	// A board with one engine that loses everything, which is the case that
	// would go negative if the zero were anywhere but the bottom.
	entries := append(graded(20, "a", "b", "c"),
		record{first: "a", second: "hopeless", games: 20, firstScore: 20},
		record{first: "b", second: "hopeless", games: 20, firstScore: 20},
		record{first: "c", second: "hopeless", games: 20, firstScore: 20},
	)
	for _, ratings := range []map[string]int{
		fit(entries...),
		func() map[string]int {
			ratings, _ := fitBotRatings(headToHead(entries...), BotYardsticks{})
			return ratings
		}(),
	} {
		for name, rating := range ratings {
			if rating < RatingFloor {
				t.Errorf("%s published at %d, below the floor", name, rating)
			}
		}
	}
}

// An anchor that never wins a game, which is what the anchor is actually going
// to do against a board of real engines.
//
// This used to take the whole board down with it, and the collapse was correct
// at the time. The anchor's strength was fitted like everybody else's, so a
// record of nothing but losses left it unidentified: MM drove it to
// strengthFloor, the numerical clamp caught it there, and every other bot then
// measured some twenty log units above a position no game had decided. The
// deviation and variance ceilings turned that into a board at the floor, which
// was the honest answer — the scale's zero point could not be measured, so there
// was nothing to publish distances from.
//
// Declaring the anchor deletes the whole problem rather than handling it. Its
// strength is held at the declaration and no record can move it, so there is no
// unidentified parameter to clamp and no false ceiling to protect against. What
// is published instead is what the games actually support: clearly above chance,
// ordered, and well short of the ceiling, because the shrinkage still knows that
// a matchup nobody could lose says little about how much better the winner is.
//
// Worth keeping as a test rather than deleting with the failure, because this is
// the ordinary state of a live board and not an edge case. The random mover is
// going to lose every game it ever plays against the top of the ladder.
func TestAnAnchorThatWinsNothingNoLongerCollapsesTheBoard(t *testing.T) {
	entries := graded(20, "a", "b", "c")
	for _, bot := range []string{"a", "b", "c"} {
		entries = append(entries, record{
			first: "anchor", second: bot, games: 30, firstScore: 0,
		})
	}
	ratings := fit(entries...)
	if len(ratings) == 0 {
		t.Fatal("the board came back empty rather than rated")
	}
	if ratings["anchor"] != RatingFloor {
		t.Errorf("the anchor is declared, so it reads %d whatever it did: got %d",
			RatingFloor, ratings["anchor"])
	}
	for _, bot := range []string{"a", "b", "c"} {
		if ratings[bot] <= RatingFloor {
			t.Errorf("%s beat the anchor thirty times and was published at %d",
				bot, ratings[bot])
		}
		if ratings[bot] >= RatingCeiling {
			t.Errorf("%s only beat a random mover; %d is not a claim the record carries",
				bot, ratings[bot])
		}
	}
	// graded builds a descending field, and the order has to survive.
	if !(ratings["a"] > ratings["b"] && ratings["b"] > ratings["c"]) {
		t.Errorf("the board lost its order: %#v", ratings)
	}
}

// A bot that has lost every game it has played is an ordinary thing to find on
// a real ladder and it used to take the whole board down with it.
//
// Such a bot has no finite Bradley-Terry strength: the fit drives it to
// strengthFloor and the information matrix reports its variance as about a
// billion, which is a true statement about an unidentified parameter. The
// shrinkage is a comparison between the board's spread and its noise, both
// weighted averages, and an unbounded term in either of them wins. One such bot
// among fourteen was once enough to make the fit conclude that none of the
// board's spread was real and flatten every engine onto one number.
//
// The synthetic ladders elsewhere in this file all have every bot winning
// something, which is why they never caught it.
func TestOneHopelessRecordDoesNotFlattenTheBoard(t *testing.T) {
	field := []string{"field-1", "field-2", "field-3", "field-4"}
	entries := append(graded(20, field...), anchored(20, field...)...)
	before := fit(entries...)

	for _, opponent := range field {
		entries = append(entries, record{
			first: "hopeless", second: opponent, games: 12, firstScore: 0,
		})
	}
	ratings := fit(entries...)

	if len(ratings) != len(field)+2 {
		t.Fatalf("expected the field, the anchor and the hopeless bot, got %#v", ratings)
	}
	if ratings["field-1"] == ratings["field-4"] {
		t.Fatalf("one unrateable bot flattened the board onto %d: %#v",
			ratings["field-1"], ratings)
	}
	if !(ratings["field-1"] > ratings["field-2"] &&
		ratings["field-2"] > ratings["field-3"] &&
		ratings["field-3"] > ratings["field-4"]) {
		t.Fatalf("the graded field did not come out in order: %#v", ratings)
	}
	// And the field's own ratings are barely disturbed by its arrival: the games
	// against it carry almost no information about anybody, so they should not
	// be reordering or rescaling the bots that do have records.
	for _, bot := range field {
		if moved := ratings[bot] - before[bot]; moved > 15 || moved < -15 {
			t.Fatalf("%s moved %d points because a hopeless bot joined the board",
				bot, moved)
		}
	}
	// The floor, and this is the one assertion in the file that the anchored
	// scale reverses outright. An all-loss record is consistent with any strength
	// below the field's, so what it establishes is a one-sided bound and not a
	// rating — and on a scale where every number is a distance earned above the
	// anchor, a bot that has demonstrated nothing belongs at the bottom of it.
	//
	// The old centred scale published such a bot near the middle, and argued for
	// it: pushing uncertainty downwards there meant driving honest bots to the
	// floor and leaving whoever the arithmetic favoured on top, because "down"
	// was an arbitrary direction. Here it is not arbitrary. The floor means "has
	// not shown me anything", which is exactly what this record is.
	if ratings["hopeless"] != RatingFloor {
		t.Fatalf("a bot that has never won rated above the floor: %#v", ratings)
	}
}

// The same pathology at the other end of the board: an unbeaten record over two
// opponents is unidentified in exactly the way an all-loss record is, and
// publishing the ceiling for it would hand the top of the ladder to whoever
// played two games and won them.
func TestAnUnbeatenNewcomerDoesNotTakeTheBoard(t *testing.T) {
	field := []string{"field-1", "field-2", "field-3", "field-4", "field-5"}
	entries := append(graded(20, field...), anchored(20, field...)...)
	entries = append(entries,
		record{first: "newcomer", second: "field-4", games: 2, firstScore: 2},
		record{first: "newcomer", second: "field-5", games: 2, firstScore: 2},
	)

	ratings := fit(entries...)
	if _, found := ratings["newcomer"]; !found {
		t.Fatalf("two opponents is enough to be ranked: %#v", ratings)
	}
	if ratings["newcomer"] >= ratings["field-1"] {
		t.Fatalf("four wins over the bottom of the board took the top of it: %#v", ratings)
	}
	if ratings["newcomer"] == RatingCeiling {
		t.Fatalf("an unidentified strength was published as the ceiling: %#v", ratings)
	}
}

// The shrinkage has to be able to say "this board establishes nothing" — that is
// what it is for — and a record of nothing but coin flips is that board. It is
// the property the fix for the flattening above must not have thrown away.
func TestABoardThatEstablishesNothingCollapsesToTheFloor(t *testing.T) {
	// Two games per pair, split down the middle: connected, past the opponent
	// bar, and carrying no evidence that anybody is better than anybody.
	entries := append(roundRobin(2, "a", "b", "c", "d", "e"),
		record{first: "anchor", second: "a", games: 2, firstScore: 1},
		record{first: "anchor", second: "b", games: 2, firstScore: 1},
	)
	ratings := fit(entries...)
	if len(ratings) != 6 {
		t.Fatalf("expected the whole round robin and the anchor, got %#v", ratings)
	}
	for bot, rating := range ratings {
		if rating != RatingFloor {
			t.Fatalf("a board with no evidence in it should sit at %d: %s is %d",
				RatingFloor, bot, rating)
		}
	}
}

// botLadderStore builds a store with a registered owner, so a test can mint
// bots without repeating the setup.
func botLadderStore(t *testing.T) *Store {
	t.Helper()
	store := authTestStore(t)
	registeredOwner(t, store, "owner", "Owner")
	return store
}

// rivalBot claims an engine under an owner of its own.
//
// Separate owners on purpose. The ladder does not count a pair of engines one
// person registered — see botHeadToHeadTx — so a board minted under a single
// owner fits to nothing at all, and every test that wants a graded board wants
// rivals. The one test that wants the other thing says so by name.
func rivalBot(t *testing.T, store *Store, name string) Bot {
	t.Helper()
	owner := "owner-" + strings.ToLower(name)
	registeredOwner(t, store, owner, "Owner_"+name)
	return claimedBot(t, store, owner, name)
}

// seedBotGame files a finished bot-versus-bot game straight into the history,
// and makes sure both bots are rated in the mode.
//
// Directly rather than through RecordCompletedGame for the reason seedGame
// gives: the ladder reads rows, so building a finished GameState per game would
// put a board engine between these tests and the fit they are about. One test
// below does go the long way round, to check the wiring.
func seedBotGame(
	t *testing.T,
	store *Store,
	gameID string,
	red Account,
	blue Account,
	outcome string,
) {
	t.Helper()
	seedAgedBotGame(t, store, gameID, red, blue, outcome, 0)
}

// seedAgedBotGame is the same, dated `age` into the past.
//
// Every seeded game needs a real timestamp now that evidence decays, and this
// is the trap that made every test in the file fail at once when it did not: the
// old fixture dated its games to 1970, which under a ninety-day half-life is
// worth about 2^-227 of a game. The board fitted perfectly and published every
// bot at the floor, which is the correct answer to "what do you know about games
// played fifty-six years ago".
func seedAgedBotGame(
	t *testing.T,
	store *Store,
	gameID string,
	red Account,
	blue Account,
	outcome string,
	age time.Duration,
) {
	t.Helper()
	at := time.Now().Add(-age).UnixMilli()
	var winner any
	switch outcome {
	case "red_win":
		winner = red.UserID
	case "blue_win":
		winner = blue.UserID
	}
	colour := map[string]string{"red_win": "Red", "blue_win": "Blue", "draw": "Neutral"}[outcome]
	if _, err := store.db.ExecContext(t.Context(), `
INSERT INTO game_history (
    game_id, mode_id, mode_name,
    red_player_id, red_username, blue_player_id, blue_username,
    winner_player_id, winner_color, outcome, end_reason, ranked,
    red_elo_before, red_elo_after, blue_elo_before, blue_elo_after,
    move_number, initial_time_ms, increment_ms,
    started_at_unix_ms, finished_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'resignation', 1,
          ?, ?, ?, ?, 30, 60000, 0, ?, ?)
`,
		gameID, game.ModeTotalWar, "Total War",
		red.UserID, red.Username, blue.UserID, blue.Username,
		winner, colour, outcome,
		RatingFloor, RatingFloor, RatingFloor, RatingFloor,
		at, at,
	); err != nil {
		t.Fatalf("seed bot game %s: %v", gameID, err)
	}
	for _, player := range []Account{red, blue} {
		if _, err := store.db.ExecContext(t.Context(), `
INSERT OR IGNORE INTO account_mode_ratings (
    user_id, mode_id, elo, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?)
`, player.UserID, game.ModeTotalWar, RatingFloor, at, at); err != nil {
			t.Fatalf("seed mode rating: %v", err)
		}
	}
}

func botRating(t *testing.T, store *Store, userID string) int {
	t.Helper()
	var elo int
	if err := store.db.QueryRowContext(t.Context(),
		`SELECT elo FROM account_mode_ratings WHERE user_id = ? AND mode_id = ?`,
		userID, game.ModeTotalWar,
	).Scan(&elo); err != nil {
		t.Fatalf("read rating for %s: %v", userID, err)
	}
	return elo
}

// ladderAnchor is the yardstick every board in this file is measured from,
// minted once per store.
//
// An ordinary bot under an owner of its own, with one column set. That is all a
// yardstick is to the database — the server runs the engine behind it, and
// nothing in the rating code cares which engine that is.
func ladderAnchor(t *testing.T, store *Store) Account {
	t.Helper()
	var userID string
	err := store.db.QueryRowContext(t.Context(),
		"SELECT COALESCE(user_id, '') FROM bots WHERE reference_kind = ?", BenchmarkRandom,
	).Scan(&userID)
	if err == nil && userID != "" {
		return account(t, store, userID)
	}
	bot := rivalBot(t, store, "Anchor")
	if _, err := store.db.ExecContext(t.Context(),
		"UPDATE bots SET reference_kind = ? WHERE bot_id = ?", BenchmarkRandom, bot.BotID,
	); err != nil {
		t.Fatalf("mark anchor: %v", err)
	}
	return account(t, store, bot.UserID)
}

// seedAnchor puts the yardstick underneath a board: it plays each of these bots
// and takes two games in eight.
//
// Called from seedBotRoundRobin rather than by each test, because "a board that
// actually rates" now means "a board connected to the anchor", and that is the
// helper's job rather than something every test should have to remember.
// Idempotent per pair, so overlapping boards get one set of anchor games instead
// of a primary key violation.
func seedAnchor(t *testing.T, store *Store, bots []Account) {
	t.Helper()
	anchor := ladderAnchor(t, store)
	for _, bot := range bots {
		if bot.UserID == anchor.UserID {
			continue
		}
		var seeded int
		if err := store.db.QueryRowContext(t.Context(), `
SELECT COUNT(*) FROM game_history
WHERE (red_player_id = ? AND blue_player_id = ?)
   OR (red_player_id = ? AND blue_player_id = ?)
`, anchor.UserID, bot.UserID, bot.UserID, anchor.UserID).Scan(&seeded); err != nil {
			t.Fatalf("check anchor games: %v", err)
		}
		if seeded > 0 {
			continue
		}
		for index := range 8 {
			outcome := "blue_win"
			if index < 2 {
				outcome = "red_win"
			}
			seedBotGame(t, store,
				fmt.Sprintf("anchor-%s-%d", bot.UserID, index), anchor, bot, outcome)
		}
	}
}

// seedBotRoundRobin gives every pair of these bots `games` games, the earlier
// bot in the slice winning `firstScore` of each pairing.
//
// A round robin rather than a single matchup because a pair is not a ladder: two
// bots that have only played each other have one opponent apiece, which is below
// the bar, so a fit over them is empty. Every store-level test below needs a
// board that actually rates.
func seedBotRoundRobin(
	t *testing.T,
	store *Store,
	bots []Account,
	games int,
	firstScore int,
) {
	t.Helper()
	seedAnchor(t, store, bots)
	counter := 0
	for first := range bots {
		for second := first + 1; second < len(bots); second++ {
			for index := range games {
				outcome := "blue_win"
				if index < firstScore {
					outcome = "red_win"
				}
				counter++
				seedBotGame(t, store,
					fmt.Sprintf("rr-%d", counter), bots[first], bots[second], outcome)
			}
		}
	}
}

// threeBots mints a rateable board: three engines, every pair played.
func threeBots(t *testing.T, store *Store) (Account, Account, Account) {
	t.Helper()
	first := account(t, store, rivalBot(t, store, "First").UserID)
	second := account(t, store, rivalBot(t, store, "Second").UserID)
	third := account(t, store, rivalBot(t, store, "Third").UserID)
	return first, second, third
}

// seedMatchup files one pair's games under a tag of its own, for a test that
// builds a board out of several matchups rather than one round robin —
// seedBotRoundRobin numbers its games from zero every time it is called.
func seedMatchup(
	t *testing.T,
	store *Store,
	tag string,
	red Account,
	blue Account,
	games int,
	redWins int,
) {
	t.Helper()
	for index := range games {
		outcome := "blue_win"
		if index < redWins {
			outcome = "red_win"
		}
		seedBotGame(t, store, fmt.Sprintf("%s-%d", tag, index), red, blue, outcome)
	}
}

// stablemate claims an engine under the same owner as one already minted: the
// pair the ladder will not count.
func stablemate(t *testing.T, store *Store, sibling Bot, name string) Bot {
	t.Helper()
	return claimedBot(t, store, sibling.OwnerUserID, name)
}

// Two engines one person registered do not rate each other, however their games
// were flagged when they were played.
//
// New games are seated casual (bot_series.go), so what this is really about is
// the rows written before that rule existed — they say ranked = 1, and the
// record still has to drop them. That is what deriving the head-to-head from
// game_history buys: one refit and the ladder is the one the honest games
// describe, with nothing to unwind.
//
// The board is built so the prune cannot be what does the work. The stablemate
// has three distinct opponents and would sit comfortably on the ladder if the
// only rules were the ones that came before this one; the assertion is that a
// lopsided run against its own sibling still moves nothing.
func TestOneOwnersBotsDoNotRateEachOther(t *testing.T) {
	// Same board, same games, twice. The stores differ in one thing — whether
	// the pair playing the lopsided run shares an owner — so anything that
	// comes out different is that rule and cannot be anything else.
	fit := func(t *testing.T, shareAnOwner bool) map[string]int {
		t.Helper()
		store := botLadderStore(t)
		firstBot := rivalBot(t, store, "First")
		secondBot := rivalBot(t, store, "Second")
		thirdBot := rivalBot(t, store, "Third")
		var fourthBot Bot
		if shareAnOwner {
			fourthBot = stablemate(t, store, firstBot, "Fourth")
		} else {
			fourthBot = rivalBot(t, store, "Fourth")
		}
		first := account(t, store, firstBot.UserID)
		second := account(t, store, secondBot.UserID)
		third := account(t, store, thirdBot.UserID)
		fourth := account(t, store, fourthBot.UserID)

		// A graded board of rivals, and a fourth engine with a real schedule
		// against two of them.
		seedBotRoundRobin(t, store, []Account{first, second, third}, 8, 6)
		seedMatchup(t, store, "second-fourth", second, fourth, 8, 4)
		seedMatchup(t, store, "third-fourth", third, fourth, 8, 4)

		// The run that is only worth something if the ladder counts it: First
		// beats Fourth twenty times without reply.
		seedMatchup(t, store, "private", first, fourth, 20, 20)

		if err := store.RefitBotLadders(t.Context()); err != nil {
			t.Fatalf("refit: %v", err)
		}
		return map[string]int{
			"First":  botRating(t, store, first.UserID),
			"Second": botRating(t, store, second.UserID),
			"Third":  botRating(t, store, third.UserID),
			"Fourth": botRating(t, store, fourth.UserID),
		}
	}

	rivals := fit(t, false)
	stable := fit(t, true)

	// The control: between rivals that run is worth something, or the test
	// below is comparing two ladders that were never going to differ.
	if rivals["First"] <= stable["First"] {
		t.Fatalf("beating a rival twenty times should pay: rival fit %d, stablemate fit %d",
			rivals["First"], stable["First"])
	}
	if rivals["Fourth"] >= stable["Fourth"] {
		t.Fatalf("losing twenty to a rival should cost: rival fit %d, stablemate fit %d",
			rivals["Fourth"], stable["Fourth"])
	}

	// And the rule: with one owner behind both, the ladder is the one the other
	// games describe on their own.
	clean := func(t *testing.T) map[string]int {
		t.Helper()
		store := botLadderStore(t)
		firstBot := rivalBot(t, store, "First")
		secondBot := rivalBot(t, store, "Second")
		thirdBot := rivalBot(t, store, "Third")
		fourthBot := rivalBot(t, store, "Fourth")
		first := account(t, store, firstBot.UserID)
		second := account(t, store, secondBot.UserID)
		third := account(t, store, thirdBot.UserID)
		fourth := account(t, store, fourthBot.UserID)
		seedBotRoundRobin(t, store, []Account{first, second, third}, 8, 6)
		seedMatchup(t, store, "second-fourth", second, fourth, 8, 4)
		seedMatchup(t, store, "third-fourth", third, fourth, 8, 4)
		if err := store.RefitBotLadders(t.Context()); err != nil {
			t.Fatalf("refit: %v", err)
		}
		return map[string]int{
			"First":  botRating(t, store, first.UserID),
			"Second": botRating(t, store, second.UserID),
			"Third":  botRating(t, store, third.UserID),
			"Fourth": botRating(t, store, fourth.UserID),
		}
	}
	without := clean(t)
	for _, name := range []string{"First", "Second", "Third", "Fourth"} {
		if stable[name] != without[name] {
			t.Errorf("%s: a private run against a stablemate moved the ladder, %d with it and %d without",
				name, stable[name], without[name])
		}
	}
}

// The ladder is derived, so a refit has to be able to rebuild it from nothing
// but the games — including replacing whatever a previous system wrote.
func TestRefitRebuildsTheLadderFromTheGamesOnRecord(t *testing.T) {
	store := botLadderStore(t)
	strong, middle, weak := threeBots(t, store)
	// Strong beats both, middle beats weak, so the board is ordered.
	seedBotRoundRobin(t, store, []Account{strong, middle, weak}, 8, 6)

	// A number no fit would produce, standing in for the per-game Elo a database
	// written by the old system holds.
	if _, err := store.db.ExecContext(t.Context(),
		`UPDATE account_mode_ratings SET elo = 2500 WHERE user_id = ?`, weak.UserID,
	); err != nil {
		t.Fatalf("plant a stale rating: %v", err)
	}

	if err := store.RefitBotLadders(t.Context()); err != nil {
		t.Fatalf("refit: %v", err)
	}
	if botRating(t, store, weak.UserID) >= botRating(t, store, strong.UserID) {
		t.Fatalf("refit did not replace the stale rating: strong %d, weak %d",
			botRating(t, store, strong.UserID), botRating(t, store, weak.UserID))
	}
	if botRating(t, store, middle.UserID) >= botRating(t, store, strong.UserID) ||
		botRating(t, store, middle.UserID) <= botRating(t, store, weak.UserID) {
		t.Fatalf("a graded board should come back ordered: %d, %d, %d",
			botRating(t, store, strong.UserID),
			botRating(t, store, middle.UserID),
			botRating(t, store, weak.UserID))
	}
}

// A bot with no ranked bot-versus-bot games left is not a bot with a rating
// nobody has tested — it is a bot with no rating, and RatingFloor is how this
// ladder says so. Otherwise a number won under the old system, or before its
// games were deleted, would sit there claiming evidence that is gone.
//
// 1900 is the seed on purpose: it is a plausible number under the scale this
// replaced, and the refit has to take it away rather than leave it standing.
func TestABotWithNoRankedGamesGoesBackToTheFloor(t *testing.T) {
	store := botLadderStore(t)
	lonely := account(t, store, rivalBot(t, store, "Lonely").UserID)
	if _, err := store.db.ExecContext(t.Context(), `
INSERT INTO account_mode_ratings (user_id, mode_id, elo, created_at_unix_ms, updated_at_unix_ms)
VALUES (?, ?, 1900, 1000, 1000)
`, lonely.UserID, game.ModeTotalWar); err != nil {
		t.Fatalf("seed rating: %v", err)
	}

	if err := store.RefitBotLadders(t.Context()); err != nil {
		t.Fatalf("refit: %v", err)
	}
	if got := botRating(t, store, lonely.UserID); got != RatingFloor {
		t.Fatalf("expected an untested bot at %d, got %d", RatingFloor, got)
	}
}

// Deleting a bot game is exact, which is the thing a running total cannot
// promise: the ladder afterwards is the ladder that would have stood had the
// game never been played, whatever has happened since.
func TestDeletingABotGameLeavesTheLadderTheGameNeverHappenedWould(t *testing.T) {
	store := botLadderStore(t)
	first, second, third := threeBots(t, store)
	board := []Account{first, second, third}
	seedBotRoundRobin(t, store, board, 6, 4)
	if err := store.RefitBotLadders(t.Context()); err != nil {
		t.Fatalf("refit: %v", err)
	}
	wanted := map[string]int{}
	for _, bot := range board {
		wanted[bot.UserID] = botRating(t, store, bot.UserID)
	}

	// A game, and then six more after it, so the deleted one is nowhere near the
	// end of the record.
	seedBotGame(t, store, "doomed", first, second, "red_win")
	for index := range 6 {
		seedBotGame(t, store, "after-"+string(rune('a'+index)), first, third, "red_win")
	}
	if err := store.RefitBotLadders(t.Context()); err != nil {
		t.Fatalf("refit: %v", err)
	}
	if got := botRating(t, store, first.UserID); got == wanted[first.UserID] {
		t.Fatal("the extra games should have moved the ladder first")
	}

	for _, gameID := range []string{
		"doomed", "after-a", "after-b", "after-c", "after-d", "after-e", "after-f",
	} {
		if _, err := store.DeleteGame(t.Context(), gameID, true); err != nil {
			t.Fatalf("delete %s: %v", gameID, err)
		}
	}
	for userID, expected := range wanted {
		if got := botRating(t, store, userID); got != expected {
			t.Fatalf("deleting games did not restore the ladder: %s is %d, expected %d",
				userID, got, expected)
		}
	}
}

// The wiring: a real game recorded through the ordinary path must not trade Elo
// between two engines, and the refit that follows it has to move the ladder.
//
// Two halves, because the two used to be one statement and are not any more. The
// recording path once ran the fit inline and wrote its answer onto the history
// row as a before-and-after. It records the rating as it stood on both sides
// now, for the reasons in RecordCompletedGame — a fit is a function of the clock
// as well as of the games, and it costs a matrix inverse on a one-connection
// database — and the ladder moves when the refit runs, which the server
// schedules within seconds.
//
// What must never happen either way is the third possibility: two engines
// trading points the way two people do.
func TestRecordingABotGameMovesTheLadderRatherThanTradingElo(t *testing.T) {
	store := botLadderStore(t)
	winner, loser, third := threeBots(t, store)
	// Four games a pair, so that one more game is a quarter again as much
	// evidence about the matchup and the shift it causes elsewhere on the board
	// is bigger than a point. A doubling of the odds is twenty points on this
	// scale and was a hundred and twenty on the last one, so a restatement that
	// used to round to a visible number now needs a board small enough for one
	// game to matter.
	seedBotRoundRobin(t, store, []Account{winner, loser, third}, 4, 3)
	if err := store.RefitBotLadders(t.Context()); err != nil {
		t.Fatalf("refit: %v", err)
	}
	wasWinner := botRating(t, store, winner.UserID)
	wasLoser := botRating(t, store, loser.UserID)
	wasThird := botRating(t, store, third.UserID)

	played, err := game.NewGame(
		"bot-versus-bot", game.ModeTotalWar,
		game.PlayerProfile{UserID: winner.UserID, Username: winner.Username},
		game.PlayerProfile{UserID: loser.UserID, Username: loser.Username},
	)
	if err != nil {
		t.Fatalf("new game: %v", err)
	}
	state, err := played.Resign(game.Blue)
	if err != nil {
		t.Fatalf("resign: %v", err)
	}
	finishedAt := time.Now()
	update, err := store.RecordCompletedGame(
		t.Context(), state, finishedAt.Add(-time.Minute), finishedAt, true,
	)
	if err != nil {
		t.Fatalf("record game: %v", err)
	}
	if !update.Recorded || !update.Ranked {
		t.Fatalf("expected a ranked recorded game: %#v", update)
	}
	// No transfer. Not a small one, not a rounded-away one: the winner does not
	// take points off the loser, because there are no points to take.
	if update.RedEloAfter != update.RedEloBefore ||
		update.BlueEloAfter != update.BlueEloBefore {
		t.Fatalf("an engine game traded Elo: %#v", update)
	}
	if update.RedEloBefore != wasWinner || update.BlueEloBefore != wasLoser {
		t.Fatalf("the game recorded %d and %d, ladder held %d and %d",
			update.RedEloBefore, update.BlueEloBefore, wasWinner, wasLoser)
	}
	if got := botRating(t, store, winner.UserID); got != wasWinner {
		t.Fatalf("the ladder moved before the refit: %d then %d", wasWinner, got)
	}

	if err := store.RefitBotLadder(t.Context(), game.ModeTotalWar); err != nil {
		t.Fatalf("refit: %v", err)
	}
	if got := botRating(t, store, winner.UserID); got <= wasWinner {
		t.Fatalf("another win should not have cost the winner: %d then %d",
			wasWinner, got)
	}
	if got := botRating(t, store, loser.UserID); got >= wasLoser {
		t.Fatalf("another loss should not have paid the loser: %d then %d",
			wasLoser, got)
	}
	// And the bot that was not playing has been re-rated too, because the fit is
	// over the whole board rather than the two seats. A per-game transfer could
	// not do this, and it is the reason the ladder cannot be farmed: a result is
	// read against everything else on record, not just against the opponent.
	// And the bots that were not playing are re-rated too, because the fit is
	// over the whole board rather than over the two seats. A per-game transfer
	// could not do this, and it is the reason the ladder cannot be farmed: a
	// result is read against everything else on record, not just against the
	// opponent.
	//
	// It takes a handful of games rather than one to show, and that is a fact
	// about the unit rather than about the fit. Twenty points is a doubling of
	// the odds here where a hundred and twenty was on the scale this replaced, so
	// the published integer is six times coarser and a restatement worth a third
	// of a point rounds to nothing. That coarseness is deliberate — the pair cap
	// is twenty games, and twenty games cannot resolve a matchup to better than
	// about a point anyway, so the scale shows exactly as much as the record can
	// establish and no more.
	for index := range 5 {
		more, err := game.NewGame(
			fmt.Sprintf("bot-versus-bot-%d", index), game.ModeTotalWar,
			game.PlayerProfile{UserID: winner.UserID, Username: winner.Username},
			game.PlayerProfile{UserID: loser.UserID, Username: loser.Username},
		)
		if err != nil {
			t.Fatalf("new game: %v", err)
		}
		resigned, err := more.Resign(game.Blue)
		if err != nil {
			t.Fatalf("resign: %v", err)
		}
		if _, err := store.RecordCompletedGame(
			t.Context(), resigned, finishedAt.Add(-time.Minute), finishedAt, true,
		); err != nil {
			t.Fatalf("record game: %v", err)
		}
	}
	if err := store.RefitBotLadder(t.Context(), game.ModeTotalWar); err != nil {
		t.Fatalf("refit: %v", err)
	}
	if got := botRating(t, store, third.UserID); got == wasThird {
		t.Fatalf("the bot that did not play was left where it was: %d", wasThird)
	}
}

// An engine that stops playing is not punished, it stops being proven. Its
// evidence decays, its error bar widens, and the shrinkage walks it back towards
// the anchor — with nothing at all having happened.
//
// The same games, dated differently, is the whole test. A ladder that answered
// the same both ways would be one that had forgotten to read the clock.
func TestAnIdleBotDriftsBackTowardsTheFloor(t *testing.T) {
	ladder := func(age time.Duration) (int, int) {
		store := botLadderStore(t)
		strong, middle, weak := threeBots(t, store)
		anchor := ladderAnchor(t, store)
		board := []Account{strong, middle, weak, anchor}
		counter := 0
		for first := range board {
			for second := first + 1; second < len(board); second++ {
				for index := range 12 {
					outcome := "blue_win"
					if index < 9 {
						outcome = "red_win"
					}
					counter++
					seedAgedBotGame(t, store, fmt.Sprintf("aged-%d", counter),
						board[first], board[second], outcome, age)
				}
			}
		}
		if err := store.RefitBotLadders(t.Context()); err != nil {
			t.Fatalf("refit: %v", err)
		}
		return botRating(t, store, strong.UserID), botRating(t, store, weak.UserID)
	}

	freshTop, freshBottom := ladder(0)
	if freshTop <= freshBottom {
		t.Fatalf("a fresh graded board should separate: %d and %d", freshTop, freshBottom)
	}
	staleTop, _ := ladder(3 * botRatingHalfLife)
	if staleTop >= freshTop {
		t.Fatalf("three half-lives should have cost the leader something: %d then %d",
			freshTop, staleTop)
	}
	// Old enough and there is nothing left to be sure of, so nobody is placed
	// above the anchor at all.
	ancientTop, _ := ladder(20 * botRatingHalfLife)
	if ancientTop != RatingFloor {
		t.Fatalf("a record twenty half-lives old still rated %d", ancientTop)
	}
}

// A rating that moves is filed, and one that does not is not.
//
// The second half matters more than it looks. The ladder is refitted on a clock
// now, so a series that logged every pass would carry a row per bot per hour for
// ever, and the graph it exists to draw would be a flat line at enormous cost.
func TestTheRatingSeriesRecordsMovesRatherThanRefits(t *testing.T) {
	store := botLadderStore(t)
	strong, middle, weak := threeBots(t, store)
	seedBotRoundRobin(t, store, []Account{strong, middle, weak}, 8, 6)
	if err := store.RefitBotLadders(t.Context()); err != nil {
		t.Fatalf("refit: %v", err)
	}

	points := func(userID string) int {
		var count int
		if err := store.db.QueryRowContext(t.Context(),
			"SELECT COUNT(*) FROM rating_history WHERE user_id = ? AND mode_id = ?",
			userID, game.ModeTotalWar,
		).Scan(&count); err != nil {
			t.Fatalf("count rating history: %v", err)
		}
		return count
	}
	filed := points(strong.UserID)
	if filed == 0 {
		t.Fatal("the first refit filed no point on the graph")
	}
	for range 5 {
		if err := store.RefitBotLadders(t.Context()); err != nil {
			t.Fatalf("refit: %v", err)
		}
	}
	if again := points(strong.UserID); again != filed {
		t.Fatalf("five refits over the same games filed %d more points", again-filed)
	}
}

// A bot's games against people are unranked and must stay out of the fit// A bot's games against people are unranked and must stay out of the fit, or an
// engine's rating would depend on how many visitors it happened to beat.
func TestGamesAgainstPeopleDoNotMoveTheBotLadder(t *testing.T) {
	store := botLadderStore(t)
	registeredOwner(t, store, "ada", "Ada")
	engine, rival, third := threeBots(t, store)
	ada := account(t, store, "ada")

	seedBotRoundRobin(t, store, []Account{engine, rival, third}, 8, 6)
	if err := store.RefitBotLadders(t.Context()); err != nil {
		t.Fatalf("refit: %v", err)
	}
	before := botRating(t, store, engine.UserID)
	if before == RatingFloor {
		t.Fatal("the board should have separated the engines first")
	}

	for index := range 30 {
		seedBotGame(t, store, "human-"+string(rune('a'+index)), engine, ada, "red_win")
	}
	if err := store.RefitBotLadders(t.Context()); err != nil {
		t.Fatalf("refit: %v", err)
	}
	if got := botRating(t, store, engine.UserID); got != before {
		t.Fatalf("thirty wins over a person moved the bot ladder: %d to %d", before, got)
	}
}

// revertRatings=false says "remove the record, let the result stand". A derived
// ladder cannot do that — the record is the result — so a bot game refits
// anyway. What the flag still buys is the win counters, which are a tally of
// games played rather than a claim about strength.
func TestDeletingABotGameRefitsEvenWhenRatingsAreNotReverted(t *testing.T) {
	store := botLadderStore(t)
	strong, middle, weak := threeBots(t, store)
	seedBotRoundRobin(t, store, []Account{strong, middle, weak}, 6, 4)
	seedBotGame(t, store, "doomed", strong, weak, "red_win")
	if err := store.RefitBotLadders(t.Context()); err != nil {
		t.Fatalf("refit: %v", err)
	}
	before := botRating(t, store, strong.UserID)

	if _, err := store.DeleteGame(t.Context(), "doomed", false); err != nil {
		t.Fatalf("delete game: %v", err)
	}
	after := botRating(t, store, strong.UserID)
	if after >= before {
		t.Fatalf("one fewer win should not leave a higher rating: %d then %d", before, after)
	}
	// And the ladder must match a fit over what is actually left, rather than
	// sitting on a number only the next bot game would correct.
	if err := store.RefitBotLadders(t.Context()); err != nil {
		t.Fatalf("refit: %v", err)
	}
	if got := botRating(t, store, strong.UserID); got != after {
		t.Fatalf("the ladder was stale after the delete: %d, refit gives %d", after, got)
	}
}

// Hard-deleting a bot takes its games with it, so every opponent it ever beat
// has to stop carrying a win over something the database no longer contains.
// This is the case the admin delete exists for — a broken engine that lost four
// hundred games in an afternoon — and it is the one a running total handles
// worst.
func TestDeletingABotRefitsEveryLadderItPlayedIn(t *testing.T) {
	store := botLadderStore(t)
	keptBot := rivalBot(t, store, "Kept")
	otherBot := rivalBot(t, store, "Other")
	doomedBot := rivalBot(t, store, "Doomed")
	kept := account(t, store, keptBot.UserID)
	other := account(t, store, otherBot.UserID)
	doomed := account(t, store, doomedBot.UserID)

	seedBotRoundRobin(t, store, []Account{kept, other, doomed}, 8, 6)
	if err := store.RefitBotLadders(t.Context()); err != nil {
		t.Fatalf("refit: %v", err)
	}
	before := map[string]int{
		kept.UserID:  botRating(t, store, kept.UserID),
		other.UserID: botRating(t, store, other.UserID),
	}
	if before[kept.UserID] == RatingFloor {
		t.Fatal("expected the board to have placed Kept above the floor")
	}

	if _, err := store.DeleteBot(t.Context(), doomedBot.BotID); err != nil {
		t.Fatalf("delete bot: %v", err)
	}
	// Both still hold a rating, because both still have the anchor, and a record
	// against the anchor is a complete one. What they must not still hold is a
	// number won over a bot the database no longer contains: Kept beat Doomed
	// six times in eight, and with those games erased it has to come down.
	for _, bot := range []Account{kept, other} {
		got := botRating(t, store, bot.UserID)
		if got == before[bot.UserID] {
			t.Fatalf("%s kept the %d it won over an erased bot", bot.Username, got)
		}
	}
	// And what is left is exactly the ladder the surviving games describe.
	pairs := map[string]int{}
	for _, bot := range []Account{kept, other} {
		pairs[bot.UserID] = botRating(t, store, bot.UserID)
	}
	if err := store.RefitBotLadders(t.Context()); err != nil {
		t.Fatalf("refit: %v", err)
	}
	for userID, expected := range pairs {
		if got := botRating(t, store, userID); got != expected {
			t.Fatalf("the ladder was stale after the delete: %d, refit gives %d",
				expected, got)
		}
	}
}

// The registry row a directory or an owner's list is drawn from carries the
// bot's rating, and it has to be the one the ladder holds. `accounts.elo` is
// the seed a mode starts from and nothing ever moves it, so a row built on that
// column reports every engine at RatingFloor however it has been playing.
func TestABotsRegistryRowCarriesItsLadderRating(t *testing.T) {
	store := botLadderStore(t)
	strongBot := rivalBot(t, store, "Strong")
	middleBot := rivalBot(t, store, "Middle")
	weakBot := rivalBot(t, store, "Weak")
	strong := account(t, store, strongBot.UserID)
	middle := account(t, store, middleBot.UserID)
	weak := account(t, store, weakBot.UserID)
	// Six of every eight to the earlier bot, which grades the board. A sweep
	// has no finite fit and collapses to the default.
	seedBotRoundRobin(t, store, []Account{strong, middle, weak}, 8, 6)
	if err := store.RefitBotLadders(t.Context()); err != nil {
		t.Fatalf("refit: %v", err)
	}

	// The board has to be graded, or the assertion below passes on a ladder
	// that never moved.
	if botRating(t, store, strong.UserID) <= botRating(t, store, weak.UserID) {
		t.Fatalf("expected a graded board, got strong %d and weak %d",
			botRating(t, store, strong.UserID), botRating(t, store, weak.UserID))
	}

	for _, expected := range []Bot{strongBot, middleBot, weakBot} {
		listed, err := store.Bot(t.Context(), expected.BotID)
		if err != nil {
			t.Fatalf("read bot %s: %v", expected.Name, err)
		}
		if rated := botRating(t, store, listed.UserID); listed.Elo != rated {
			t.Errorf("%s: the registry says %d, the ladder says %d",
				expected.Name, listed.Elo, rated)
		}
	}
}

// An engine that has never finished a ranked game has no ladder rating to
// report, and reports the shared seed rather than nothing — the same answer
// Account.ModeElo gives for a mode with no row.
func TestAnUnplayedBotsRegistryRowIsTheSeed(t *testing.T) {
	store := botLadderStore(t)
	fresh := rivalBot(t, store, "Fresh")
	listed, err := store.Bot(t.Context(), fresh.BotID)
	if err != nil {
		t.Fatalf("read bot: %v", err)
	}
	if listed.Elo != RatingFloor {
		t.Fatalf("expected an unplayed engine at %d, got %d", RatingFloor, listed.Elo)
	}
}

// The administrator's list is the other place an engine's rating is read off an
// account row, and it has the same reason not to read `accounts.elo`.
func TestTheAdminAccountListShowsABotsLadderRating(t *testing.T) {
	store := botLadderStore(t)
	strongBot := rivalBot(t, store, "Strong")
	middleBot := rivalBot(t, store, "Middle")
	weakBot := rivalBot(t, store, "Weak")
	strong := account(t, store, strongBot.UserID)
	middle := account(t, store, middleBot.UserID)
	weak := account(t, store, weakBot.UserID)
	seedBotRoundRobin(t, store, []Account{strong, middle, weak}, 8, 6)
	if err := store.RefitBotLadders(t.Context()); err != nil {
		t.Fatalf("refit: %v", err)
	}

	page, err := store.SearchAccounts(t.Context(), AccountFilter{})
	if err != nil {
		t.Fatalf("search accounts: %v", err)
	}
	seen := 0
	for _, summary := range page.Accounts {
		if summary.Kind != AccountKindBot {
			continue
		}
		seen++
		if rated := botRating(t, store, summary.UserID); summary.Elo != rated {
			t.Errorf("%s: the admin list says %d, the ladder says %d",
				summary.Username, summary.Elo, rated)
		}
	}
	// Four, not three: the anchor is an ordinary bot account and shows up in
	// the administrator's list like any other.
	if seen != 4 {
		t.Fatalf("expected three engines and the anchor in the list, saw %d", seen)
	}
}
