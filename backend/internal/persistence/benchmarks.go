package persistence

import "fmt"

// The benchmark ladder: the fixed points the published scale is built on.
//
// rating_scale.go says a rating is a Bradley-Terry strength written in log-odds
// from a fixed opponent. This file is the list of those opponents and the number
// each of them is worth, and it is the only place in the codebase where a rating
// is *declared* rather than measured.
//
// Nothing here has to exist. A database with no yardstick still publishes a
// board: the fit falls back to measuring from its own weakest engine, which
// orders and spaces the field correctly and needs nobody to stand anything up.
// What the rungs buy is that the zero stops moving — see ladderZero, which is
// where the two branches meet, and the note on the self-anchored scale there for
// what it costs to go without. Designating a rung later needs no migration; the
// next refit restates every rating in the game.
//
// # Why more than one
//
// The scale used to be pinned at a single point: the random mover, at
// RatingFloor, with every other yardstick fitted like an ordinary bot. That is
// enough to fix the scale in principle — Bradley-Terry identifies gaps, so one
// known point turns every gap into a position — and it is not enough in
// practice, for a reason the fit itself makes precise. A matchup contributes
// n·p(1-p) to the information matrix, so a game nobody could lose teaches
// nothing. Everything on this board beats a random mover essentially always, so
// measured *directly* against the anchor, the entire field is one lopsided pair
// carrying no information, and its position comes instead from a chain of
// bot-versus-bot games back down to it. The chain works, and it is long, and
// every link in it is a thing that can be thin.
//
// Declaring the intermediate rungs instead shortens the chain to one link for
// most of the board. An engine that plays the depth-5 yardstick is being
// measured against a known 400 in games it can actually lose, and its rating is
// that one comparison rather than a path through six strangers.
//
// # What a declared number means, and what it costs
//
// It means the fit holds that engine's strength fixed and fits everybody else
// around it — see fitBotStrengths. The declared value is not a starting guess
// and not a prior; it does not move, and no record can move it.
//
// The cost is that a wrong declaration is a wrong board. If the depth-8
// yardstick is declared at 600 and is really playing at 800, then every engine
// measured through it reads two hundred points light, and nothing in the fit
// will say so, because the fit has been told that 600 is what 600 means. The
// defence is that the fit still has an opinion and can be asked for it:
// BenchmarkDrift reports what each rung *would* have fitted to if it were free,
// so the declarations can be checked against the record and corrected.
//
// # Correcting one
//
// Edit the Rating on the row below and restart. Nothing else is needed and
// nothing needs migrating: a bot rating is not a running total, it is the whole
// record solved again from scratch, so the next refit — one runs on every start,
// see RefitBotLadders — republishes every rating in the game on the new scale.
// A rung moving is therefore retroactive by construction, which is the reason
// the numbers are safe to adjust at all.
//
// A rung is *not* safe to redefine in place. Changing which engine holds a slot,
// or changing what that engine does, restates the board without changing a
// number here to show it. Add a slot instead and retire the old one; the games
// stay on record either way.

// The benchmark slots, by id. These are stored in `bots.reference_kind`, so they
// are database values: renaming one orphans the row that holds it, in the same
// way TitleID says about titles.
const (
	// BenchmarkRandom is the anchor — the engine that plays a uniformly random
	// legal move, and the definition of "no better than chance".
	//
	// It is the one slot that cannot be retired and the one whose number cannot
	// be adjusted, because it is not a measurement to be corrected. Every other
	// row here is a claim about an engine somebody wrote, and claims rot; this
	// one is a claim about chance. See yardstick_random.py, which says the same
	// thing to whoever opens it.
	BenchmarkRandom = "random"
	// BenchmarkGreedy is the first rung an engine can lose to: it captures when
	// it can and plays at random when it cannot.
	BenchmarkGreedy = "greedy"
	// BenchmarkFish5 and BenchmarkFish8 are RPSFish at a fixed search depth,
	// with the clock ignored. Fixed depth rather than fixed time because a
	// yardstick that searched for a tenth of a second would be a yardstick whose
	// strength depended on how busy the server was, which is the same objection
	// yardstick_random.py raises about thinking at all.
	BenchmarkFish5 = "fish5"
	BenchmarkFish8 = "fish8"
)

// Benchmark is one fixed rung of the scale.
type Benchmark struct {
	// Slot is the id stored against the bot that holds this rung.
	Slot string `json:"slot"`
	// Name is what the rung is called on screen.
	Name string `json:"name"`
	// Rating is the published rating of whoever holds this slot, by declaration.
	// Adjusting it here restates the whole board on the next refit.
	Rating int `json:"rating"`
	// Engine is how the rung is run, for the operator who has to stand it up and
	// for the page that explains what a rating is measured against.
	Engine string `json:"engine"`
}

// benchmarkLadder is every fixed point on the scale, weakest first.
//
// Weakest first is not decoration: BenchmarkDrift reports in this order, and the
// registration check below reads the neighbouring rungs to decide whether a
// declaration is spaced widely enough to be measurable.
var benchmarkLadder = []Benchmark{
	{
		Slot:   BenchmarkRandom,
		Name:   "Random",
		Rating: RatingFloor,
		Engine: "python3 yardstick_random.py",
	},
	{
		Slot:   BenchmarkGreedy,
		Name:   "Greedy",
		Rating: 100,
		Engine: "python3 yardstick_greedy.py",
	},
	{
		Slot:   BenchmarkFish5,
		Name:   "RPSFish depth 5",
		Rating: 400,
		Engine: "rpsfish rpsi --force-depth 5",
	},
	{
		Slot:   BenchmarkFish8,
		Name:   "RPSFish depth 8",
		Rating: 600,
		Engine: "rpsfish rpsi --force-depth 8",
	},
}

// benchmarkBySlot is the catalogue keyed for lookup, built once.
var benchmarkBySlot = func() map[string]Benchmark {
	bySlot := make(map[string]Benchmark, len(benchmarkLadder))
	for _, benchmark := range benchmarkLadder {
		bySlot[benchmark.Slot] = benchmark
	}
	return bySlot
}()

// Benchmarks is the declared ladder, weakest first.
//
// A copy, because this is a package-level slice and a caller that sorted it
// would be editing the scale.
func Benchmarks() []Benchmark {
	return append([]Benchmark(nil), benchmarkLadder...)
}

// LookupBenchmark reads one slot out of the catalogue.
func LookupBenchmark(slot string) (Benchmark, bool) {
	benchmark, found := benchmarkBySlot[slot]
	return benchmark, found
}

// ValidateBenchmarkSlot reports whether a string names a rung, with "" meaning
// "not a yardstick at all", which is what almost every row in `bots` holds.
func ValidateBenchmarkSlot(slot string) error {
	if slot == "" {
		return nil
	}
	if _, found := benchmarkBySlot[slot]; !found {
		return fmt.Errorf("%w: no benchmark slot called %q", ErrInvalidBotReference, slot)
	}
	return nil
}

// benchmarkRating is the declared rating for a slot, and RatingFloor for a slot
// that is not in the catalogue.
//
// The fallback is for a row written by a newer binary and read by an older one,
// or by a build where a slot was removed: an unknown rung is treated as the
// bottom of the scale rather than as an error, because refusing to publish the
// board over one stale row would be a worse failure than placing that row low.
func benchmarkRating(slot string) int {
	if benchmark, found := benchmarkBySlot[slot]; found {
		return benchmark.Rating
	}
	return RatingFloor
}
