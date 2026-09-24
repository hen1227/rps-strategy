package persistence

import (
	"math"
	"testing"
)

// The catalogue has to be usable as a scale before anything else is worth
// checking: distinct slots, strictly increasing ratings, and every one of them
// printable.
func TestTheBenchmarkLadderIsAUsableScale(t *testing.T) {
	ladder := Benchmarks()
	if len(ladder) < 2 {
		t.Fatalf("a scale needs more than one fixed point, got %d", len(ladder))
	}
	if ladder[0].Slot != BenchmarkRandom || ladder[0].Rating != RatingFloor {
		t.Errorf("the ladder must open at chance: got %q at %d",
			ladder[0].Slot, ladder[0].Rating)
	}
	seen := make(map[string]bool, len(ladder))
	for index, benchmark := range ladder {
		if benchmark.Slot == "" || benchmark.Name == "" || benchmark.Engine == "" {
			t.Errorf("rung %d is not fully described: %+v", index, benchmark)
		}
		if seen[benchmark.Slot] {
			t.Errorf("two rungs share the slot %q", benchmark.Slot)
		}
		seen[benchmark.Slot] = true
		if benchmark.Rating < RatingFloor || benchmark.Rating > RatingCeiling {
			t.Errorf("%s is declared at %d, outside the publishable range %d..%d",
				benchmark.Slot, benchmark.Rating, RatingFloor, RatingCeiling)
		}
		if index > 0 && benchmark.Rating <= ladder[index-1].Rating {
			t.Errorf("%s (%d) does not stand above %s (%d); the ladder is declared weakest first",
				benchmark.Slot, benchmark.Rating,
				ladder[index-1].Slot, ladder[index-1].Rating)
		}
	}
}

// The ceiling has to leave room above the top rung, which is the thing it is
// for. The rungs are the bottom of a real board rather than the middle of it, so
// a ceiling at the top declaration would flatten the whole field into one
// number.
func TestTheCeilingLeavesRoomAboveTheTopRung(t *testing.T) {
	ladder := Benchmarks()
	top := ladder[len(ladder)-1].Rating
	if RatingCeiling <= top {
		t.Fatalf("the ceiling %d is not above the top rung %d", RatingCeiling, top)
	}
	// Doublings rather than points, because points are a unit and doublings are
	// the claim. Ten of them is a thousand to one past the strongest engine the
	// scale is anchored to, which is enough headroom that the clamp stays a guard.
	if headroom := float64(RatingCeiling-top) / RatingPointsPerDoubling; headroom < 10 {
		t.Errorf("only %.1f doublings of headroom above the top rung; the ceiling will bind",
			headroom)
	}
}

// The strengths the fit works in have to be representable, which is the
// constraint that stops the ceiling being set to any number at all. A rating of
// R is a strength of 2^(R/20), and the information matrix squares it.
func TestTheDeclaredScaleFitsInTheNumbersTheFitUses(t *testing.T) {
	if math.IsInf(strengthCeiling, 0) || strengthCeiling <= 0 {
		t.Fatalf("the strength ceiling is not a usable number: %v", strengthCeiling)
	}
	if squared := strengthCeiling * strengthCeiling; math.IsInf(squared, 0) {
		t.Fatalf("the information matrix overflows at the top of the scale: %v", squared)
	}
	for _, benchmark := range Benchmarks() {
		strength := math.Exp(logOddsFromRating(benchmark.Rating))
		if strength > strengthCeiling {
			t.Errorf("%s is declared at %d, which the fit cannot hold: %v past %v",
				benchmark.Slot, benchmark.Rating, strength, strengthCeiling)
		}
	}
}

// A rung is published at its declaration and nothing in the record moves it.
// That is the whole contract, so it is asserted directly rather than inferred
// from a board that happens to come out right.
func TestADeclaredRungIsPublishedAtItsDeclaration(t *testing.T) {
	ladder := Benchmarks()
	yardsticks := BotYardsticks{Anchor: "anchor", Slots: map[string]string{}}
	names := make([]string, 0, len(ladder))
	for index, benchmark := range ladder {
		name := "rung-" + benchmark.Slot
		if index == 0 {
			name = "anchor"
		}
		yardsticks.Slots[name] = benchmark.Slot
		names = append(names, name)
	}

	// A record that argues with every declaration at once: the weakest rung beats
	// all the others, and the strongest loses to all of them.
	entries := make([]record, 0, len(names)*len(names))
	for first := range names {
		for second := first + 1; second < len(names); second++ {
			entries = append(entries, record{
				first: names[first], second: names[second],
				games: 40, firstScore: 38,
			})
		}
	}
	ratings, _ := fitBotRatings(headToHead(entries...), yardsticks)

	for index, benchmark := range ladder {
		if got := ratings[names[index]]; got != benchmark.Rating {
			t.Errorf("%s is declared at %d and was published at %d; a record cannot move a declaration",
				benchmark.Slot, benchmark.Rating, got)
		}
	}
}

// Freeing a rung is how the declarations get checked, so the diagnostic has to
// be able to see a rung that is playing above what it was declared to be.
func TestDriftSeesARungPlayingAboveItsDeclaration(t *testing.T) {
	ladder := Benchmarks()
	if len(ladder) < 3 {
		t.Skip("needs at least three rungs to free one and keep a scale")
	}
	yardsticks := BotYardsticks{Anchor: "anchor", Slots: map[string]string{}}
	truth := map[string]int{}
	names := make([]string, 0, len(ladder))
	for index, benchmark := range ladder {
		name := "rung-" + benchmark.Slot
		if index == 0 {
			name = "anchor"
		}
		yardsticks.Slots[name] = benchmark.Slot
		truth[name] = benchmark.Rating
		names = append(names, name)
	}
	// The rung under test is really playing two hundred points above its
	// declaration, and a field around it gives the fit something to see that
	// through.
	overperforming := names[len(names)-1]
	truth[overperforming] += 200
	for offset, name := range []string{"field-low", "field-mid", "field-high"} {
		truth[name] = ladder[len(ladder)-1].Rating + 60*offset
		names = append(names, name)
	}

	pairs := make(map[botPairKey]botPairRecord)
	for first := range names {
		for second := first + 1; second < len(names); second++ {
			one, other := names[first], names[second]
			chance := RatingWinProbability(truth[one], truth[other])
			addBotResult2(pairs, one, other, chance*60, 60)
		}
	}

	fitted, measured := fitOneBenchmark(pairs, yardsticks, overperforming)
	if !measured {
		t.Fatal("the released rung could not be placed at all")
	}
	declared := truth[overperforming] - 200
	if fitted <= declared {
		t.Errorf("the rung is playing at %d, declared at %d, and read back at %d",
			truth[overperforming], declared, fitted)
	}
}

// addBotResult2 files a whole matchup at once: `score` out of `games` to the
// first name. The fractional score is what lets a test state an expected result
// exactly instead of sampling one.
func addBotResult2(
	pairs map[botPairKey]botPairRecord,
	first string,
	second string,
	score float64,
	games float64,
) {
	key, firstIsLow := botPair(first, second)
	pair := pairs[key]
	pair.games += games
	if firstIsLow {
		pair.lowScore += score
	} else {
		pair.lowScore += games - score
	}
	pairs[key] = pair
}
