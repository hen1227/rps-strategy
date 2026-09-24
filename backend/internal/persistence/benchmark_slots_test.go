package persistence

import (
	"errors"
	"fmt"
	"testing"

	"rps-strategy/backend/internal/game"
)

// Designating the yardsticks, through the store rather than through the fit:
// the path an administrator actually takes, and the one that has to work before
// a single rating is published.

// designate puts a fresh engine in a slot and returns it.
func designate(t *testing.T, store *Store, name string, slot string) Bot {
	t.Helper()
	bot := rivalBot(t, store, name)
	if err := store.SetBotBenchmarkSlot(t.Context(), bot.BotID, slot); err != nil {
		t.Fatalf("designate %s as %s: %v", name, slot, err)
	}
	return bot
}

// A slot names one engine. Two would pin two different bots to the same number,
// and the board would then be measured against whichever the query returned
// first.
func TestASlotHoldsOneEngine(t *testing.T) {
	store := authTestStore(t)
	first := designate(t, store, "First", BenchmarkGreedy)
	second := rivalBot(t, store, "Second")

	err := store.SetBotBenchmarkSlot(t.Context(), second.BotID, BenchmarkGreedy)
	if !errors.Is(err, ErrInvalidBotReference) {
		t.Fatalf("a second engine took an occupied slot: %v", err)
	}

	// Re-designating the engine that already holds it is not a conflict: an
	// administrator setting the same value twice has changed nothing.
	if err := store.SetBotBenchmarkSlot(t.Context(), first.BotID, BenchmarkGreedy); err != nil {
		t.Errorf("re-designating the current holder was refused: %v", err)
	}

	// Clearing the slot releases it.
	if err := store.SetBotBenchmarkSlot(t.Context(), first.BotID, ""); err != nil {
		t.Fatalf("clear the slot: %v", err)
	}
	if err := store.SetBotBenchmarkSlot(t.Context(), second.BotID, BenchmarkGreedy); err != nil {
		t.Errorf("the slot was not released: %v", err)
	}
}

// A slot that is not in the catalogue is refused rather than stored. The column
// is free text, so without this a typo would be a yardstick that exists in the
// database, holds no declared rating and pins the board to RatingFloor.
func TestAnUnknownSlotIsRefused(t *testing.T) {
	store := authTestStore(t)
	bot := rivalBot(t, store, "Typo")
	err := store.SetBotBenchmarkSlot(t.Context(), bot.BotID, "fsih8")
	if !errors.Is(err, ErrInvalidBotReference) {
		t.Fatalf("an unknown slot was accepted: %v", err)
	}
}

// The whole ladder is reported, including the slots nobody holds, because
// standing the yardsticks up is a checklist and a screen that only listed what
// exists could not show what is missing.
func TestTheYardstickReadShowsTheGapsInTheLadder(t *testing.T) {
	store := authTestStore(t)
	anchor := designate(t, store, "Anchor", BenchmarkRandom)

	yardsticks, err := store.BotYardsticks(t.Context())
	if err != nil {
		t.Fatalf("read the yardsticks: %v", err)
	}
	if yardsticks.AnchorBotID != anchor.BotID {
		t.Errorf("the anchor was not reported: %+v", yardsticks)
	}
	if len(yardsticks.Held) != len(Benchmarks()) {
		t.Fatalf("the ladder has %d rungs and %d were reported",
			len(Benchmarks()), len(yardsticks.Held))
	}
	for _, held := range yardsticks.Held {
		switch held.Slot {
		case BenchmarkRandom:
			if held.BotID != anchor.BotID {
				t.Errorf("the anchor slot reported %q", held.BotID)
			}
		default:
			if held.BotID != "" {
				t.Errorf("%s is unfilled and reported %q", held.Slot, held.BotID)
			}
		}
		if held.Rating < RatingFloor {
			t.Errorf("%s came back without its declaration: %+v", held.Slot, held)
		}
	}
}

// The end of the road: designate the yardsticks, play the games, and see real
// ratings come out. Everything else in these files tests a piece of this.
//
// It is also the test that would have caught the state the server was actually
// in — a complete rating system with nothing designated, publishing RatingFloor
// for every engine on the board and looking for all the world like a bug in the
// fit.
func TestDesignatingTheYardsticksIsWhatMakesRatingsAppear(t *testing.T) {
	store := authTestStore(t)
	anchorBot := designate(t, store, "Anchor", BenchmarkRandom)
	greedyBot := designate(t, store, "Greedy", BenchmarkGreedy)
	anchor := account(t, store, anchorBot.UserID)
	greedy := account(t, store, greedyBot.UserID)

	challengerBot := rivalBot(t, store, "Challenger")
	challenger := account(t, store, challengerBot.UserID)

	// The challenger beats the greedy rung most of the time, and the greedy rung
	// beats the anchor most of the time: a chain the fit can actually walk.
	for index := range 20 {
		outcome := "red_win"
		if index%5 == 0 {
			outcome = "blue_win"
		}
		seedBotGame(t, store,
			fmt.Sprintf("cg-%d", index), challenger, greedy, outcome)
		seedBotGame(t, store,
			fmt.Sprintf("ga-%d", index), greedy, anchor, outcome)
	}
	if err := store.RefitBotLadder(t.Context(), game.ModeTotalWar); err != nil {
		t.Fatalf("refit: %v", err)
	}

	rated := func(who Account) int {
		t.Helper()
		return account(t, store, who.UserID).ModeElo(game.ModeTotalWar)
	}
	if got := rated(anchor); got != RatingFloor {
		t.Errorf("the anchor is declared at %d and reads %d", RatingFloor, got)
	}
	declaredGreedy, _ := LookupBenchmark(BenchmarkGreedy)
	if got := rated(greedy); got != declaredGreedy.Rating {
		t.Errorf("the greedy rung is declared at %d and reads %d",
			declaredGreedy.Rating, got)
	}
	if got := rated(challenger); got <= declaredGreedy.Rating {
		t.Errorf("the challenger beat the %d rung four games in five and reads %d",
			declaredGreedy.Rating, got)
	}
}

// With nothing designated the board publishes nothing, which is the state the
// server shipped in and the reason every engine on it read 1.
//
// Asserted as a *pair* with the test above rather than on its own, because the
// finding that matters is the difference between them: the same games and the
// same code produce a real board or a flat one depending only on whether the
// With nothing designated the board rates itself, from its own weakest engine
// up. This used to publish RatingFloor for everybody, which was the deliberate
// refusal of a scale-free fit to guess at a zero; the fit now takes its zero
// from the record instead. See ladderZero.
func TestWithoutYardsticksTheBoardRatesItself(t *testing.T) {
	store := authTestStore(t)
	// Three, not two. Nothing is exempt from the opponent prune without a
	// yardstick on the board, so a pair that has only ever played each other has
	// one opponent apiece and is pruned away — which is the rule working, and is
	// why a small self-anchored board needs a third engine before it says
	// anything at all.
	bots := map[string]Account{}
	for _, name := range []string{"Strong", "Middle", "Weak"} {
		bots[name] = account(t, store, rivalBot(t, store, name).UserID)
	}
	// Strong beats Middle four in five, Middle beats Weak four in five, and
	// Strong beats Weak outright.
	seed := func(prefix string, winner, loser Account, everyFifth bool) {
		for index := range 20 {
			outcome := "red_win"
			if everyFifth && index%5 == 0 {
				outcome = "blue_win"
			}
			seedBotGame(t, store, fmt.Sprintf("%s-%d", prefix, index), winner, loser, outcome)
		}
	}
	seed("sm", bots["Strong"], bots["Middle"], true)
	seed("mw", bots["Middle"], bots["Weak"], true)
	seed("sw", bots["Strong"], bots["Weak"], false)

	if err := store.RefitBotLadder(t.Context(), game.ModeTotalWar); err != nil {
		t.Fatalf("refit: %v", err)
	}
	rated := func(name string) int {
		t.Helper()
		return account(t, store, bots[name].UserID).ModeElo(game.ModeTotalWar)
	}
	if got := rated("Weak"); got != RatingFloor {
		t.Errorf("the weakest engine reads %d, want the floor at %d", got, RatingFloor)
	}
	if rated("Strong") <= rated("Middle") || rated("Middle") <= rated("Weak") {
		t.Errorf("out of order: Strong %d, Middle %d, Weak %d",
			rated("Strong"), rated("Middle"), rated("Weak"))
	}
	// And the board says it is a real board, rather than the placeholder it
	// would have been before. See RatingState.
	for _, name := range []string{"Strong", "Middle", "Weak"} {
		rating := account(t, store, bots[name].UserID).ModeRatings[game.ModeTotalWar]
		if rating.State == RatingStateUnrated {
			t.Errorf("%s was rated at %d but reads as unrated", name, rating.Elo)
		}
	}
}
