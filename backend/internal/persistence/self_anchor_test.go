package persistence

import "testing"

// The scale when nothing is declared: the board measured from its own weakest
// engine. See ladderZero.
//
// These are the properties of that branch rather than of the fit underneath it,
// which bot_rating_test.go already covers. What is being pinned here is mostly
// what the branch *costs*, because the costs are the part a later reader is
// likely to mistake for bugs.

// Whoever the fit places lowest is the floor, exactly, and everybody else is a
// measured distance above them.
func TestSelfAnchoredBoardStartsAtTheFloor(t *testing.T) {
	ratings := fit(graded(20, "best", "middle", "worst")...)
	if ratings["worst"] != RatingFloor {
		t.Errorf("the weakest engine read %d, want %d", ratings["worst"], RatingFloor)
	}
	if !(ratings["best"] > ratings["middle"] && ratings["middle"] > ratings["worst"]) {
		t.Errorf("out of order: %#v", ratings)
	}
}

// Two runs of the same binary over the same record have to agree.
//
// More load-bearing without the rungs than with them. A declared scale is fixed
// from outside, so a fit that wobbled would still land on the same numbers; a
// self-anchored one takes its zero from whichever bot the iteration puts lowest,
// so an unstable fit would republish the whole board on every refit.
func TestSelfAnchoredFitIsDeterministic(t *testing.T) {
	pairs := headToHead(graded(20, "a", "b", "c", "d", "e")...)
	first, firstConfidence := fitBotRatings(pairs, BotYardsticks{})
	second, secondConfidence := fitBotRatings(pairs, BotYardsticks{})
	for name, rating := range first {
		if second[name] != rating {
			t.Errorf("%s fitted to %d and then to %d", name, rating, second[name])
		}
		if firstConfidence[name] != secondConfidence[name] {
			t.Errorf("%s kept %v and then %v", name, firstConfidence[name], secondConfidence[name])
		}
	}
}

// The cost of a moving zero, pinned so that nobody later reads it as a bug.
//
// A weaker engine joining the core pushes the floor down, so every rating above
// it climbs without anybody having played differently. The board stays correctly
// ordered — the gaps between the incumbents do not move, only where they are
// measured from — and that is exactly the property a declared anchor buys and
// this branch does not have.
func TestAWeakerEngineJoiningLiftsTheBoard(t *testing.T) {
	before := fit(graded(20, "top", "middle", "bottom")...)
	after := fit(append(
		graded(20, "top", "middle", "bottom"),
		record{first: "bottom", second: "weakling", games: 20, firstScore: 18},
		record{first: "middle", second: "weakling", games: 20, firstScore: 19},
	)...)

	if after["weakling"] != RatingFloor {
		t.Fatalf("the new weakest engine read %d, want the floor", after["weakling"])
	}
	if after["bottom"] <= before["bottom"] {
		t.Errorf("the old floor did not rise: %d then %d", before["bottom"], after["bottom"])
	}
	// The gap between two engines that played nobody new is what must not move.
	wasGap := before["top"] - before["middle"]
	nowGap := after["top"] - after["middle"]
	if difference := wasGap - nowGap; difference > 4 || difference < -4 {
		t.Errorf("a gap between two unaffected engines moved from %d to %d", wasGap, nowGap)
	}
}

// A private league is still not ranked against the field, with no yardstick to
// decide which group is the field: the larger one wins.
func TestWithoutYardsticksTheLargestGroupIsTheLadder(t *testing.T) {
	entries := append(
		graded(20, "field-1", "field-2", "field-3", "field-4"),
		graded(20, "clique-1", "clique-2", "clique-3")...,
	)
	ratings := fit(entries...)
	for _, name := range []string{"field-1", "field-4"} {
		if _, rated := ratings[name]; !rated {
			t.Errorf("%s is in the larger group and was not rated", name)
		}
	}
	for _, name := range []string{"clique-1", "clique-2", "clique-3"} {
		if _, rated := ratings[name]; rated {
			t.Errorf("%s is in a group of its own and was rated anyway", name)
		}
	}
}

// Standing a yardstick up later switches the branch and needs no migration.
//
// The same record, read twice: self-anchored it starts at the floor and climbs,
// and with the anchor declared it is measured from chance instead. The ordering
// is the fit's either way — only the zero moved — which is what makes it safe to
// run without the rungs and designate them afterwards.
func TestDesignatingAYardstickRestatesTheSameOrder(t *testing.T) {
	entries := []record{
		{first: "strong", second: "middle", games: 20, firstScore: 14},
		{first: "middle", second: "weak", games: 20, firstScore: 14},
		{first: "strong", second: "weak", games: 20, firstScore: 18},
		{first: "weak", second: "anchor", games: 20, firstScore: 15},
		{first: "middle", second: "anchor", games: 20, firstScore: 18},
	}
	pairs := headToHead(entries...)
	relative, _ := fitBotRatings(pairs, BotYardsticks{})
	absolute, _ := fitBotRatings(pairs, testYardsticks)

	if relative["anchor"] != RatingFloor {
		t.Errorf("self-anchored, the weakest engine should be the floor: %#v", relative)
	}
	if absolute["anchor"] != RatingFloor {
		t.Errorf("declared, the anchor is the floor by definition: %#v", absolute)
	}
	for _, pair := range [][2]string{{"strong", "middle"}, {"middle", "weak"}, {"weak", "anchor"}} {
		if relative[pair[0]] <= relative[pair[1]] {
			t.Errorf("self-anchored has %s below %s: %#v", pair[0], pair[1], relative)
		}
		if absolute[pair[0]] <= absolute[pair[1]] {
			t.Errorf("declared has %s below %s: %#v", pair[0], pair[1], absolute)
		}
	}
}

// A winless engine must not become the zero.
//
// The bug this pins, found by replaying the live V6 record: an engine that has
// not won a game against the core has no finite Bradley-Terry strength, so the
// iteration parks it on strengthFloor — the whole publishable range below the
// real board. Self-anchored, that engine was then the minimum, so it became the
// zero, and every other bot was measured as twenty-four log units above a
// position no game had decided. The fit read every pair as lopsided at those
// strengths, every variance hit the ceiling, and the shrinkage took the entire
// board to RatingFloor. Five of forty-five live engines were winless, which was
// enough to flatten all of them.
//
// A declared anchor cannot hit this, because the bottom of the scale is a
// declaration rather than whoever the iteration pushed lowest.
func TestAWinlessEngineDoesNotBecomeTheZero(t *testing.T) {
	entries := append(
		graded(20, "top", "upper", "middle", "lower"),
		// Beaten by everyone, every game, which is what the live board had five of.
		record{first: "top", second: "winless", games: 20, firstScore: 20},
		record{first: "upper", second: "winless", games: 20, firstScore: 20},
		record{first: "middle", second: "winless", games: 20, firstScore: 20},
		record{first: "lower", second: "winless", games: 20, firstScore: 20},
	)
	ratings, confidence := fitBotRatings(headToHead(entries...), BotYardsticks{})

	if ratings["lower"] != RatingFloor {
		t.Errorf("the weakest *measured* engine should be the zero, and read %d",
			ratings["lower"])
	}
	if ratings["winless"] != RatingFloor {
		t.Errorf("a winless engine reads %d, want the floor", ratings["winless"])
	}
	// The board has to still be a board: if the winless engine had set the zero
	// the shrinkage would have taken everything to 1.
	if ratings["top"] <= ratings["middle"] || ratings["middle"] <= ratings["lower"] {
		t.Fatalf("the board flattened: %#v", ratings)
	}
	// And the two engines at the floor are told apart by their error bars rather
	// than by their number, which is what RatingState is for.
	if RatingStateOf(true, confidence["winless"]) != RatingStateUnrated {
		t.Errorf("a winless engine reads as rated, at confidence %v", confidence["winless"])
	}
	if RatingStateOf(true, confidence["lower"]) == RatingStateUnrated {
		t.Errorf("the weakest measured engine reads as unrated, at confidence %v",
			confidence["lower"])
	}
}

// A board the fit cannot speak about at all is still empty rather than a board
// of ones. Without the rungs there is no "no anchor, no board" refusal left, so
// the only thing standing between an unrateable record and a published board is
// the prune — and it has to keep holding.
func TestSelfAnchoringDoesNotRateAFarm(t *testing.T) {
	// One bot and twenty throwaways it has beaten, and nothing else. Every
	// throwaway has a single opponent, so the prune takes them and then takes the
	// bot that farmed them.
	entries := make([]record, 0, 20)
	for _, name := range []string{
		"t01", "t02", "t03", "t04", "t05", "t06", "t07", "t08", "t09", "t10",
		"t11", "t12", "t13", "t14", "t15", "t16", "t17", "t18", "t19", "t20",
	} {
		entries = append(entries, record{
			first: "farmer", second: name, games: 20, firstScore: 20,
		})
	}
	if ratings := fit(entries...); len(ratings) != 0 {
		t.Fatalf("a farm was rated on the self-anchored scale: %#v", ratings)
	}
}
