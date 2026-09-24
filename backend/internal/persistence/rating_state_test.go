package persistence

import (
	"testing"

	"rps-strategy/backend/internal/game"
)

// The floor used to mean three things at once. These are about it meaning one.

func TestRatingStateSeparatesUnmeasuredFromMeasuredAtTheFloor(t *testing.T) {
	for _, testCase := range []struct {
		name       string
		placed     bool
		confidence float64
		want       RatingState
	}{
		{"never measured", false, 0, RatingStateUnrated},
		{"measured but mostly prior", true, 0.2, RatingStateUnrated},
		{"exactly at the guess line", true, RatingConfidenceGuess, RatingStateProvisional},
		{"held back but real", true, 0.7, RatingStateProvisional},
		{"stands on its own", true, 0.95, RatingStateRated},
		{"declared, so nothing to fall short of", true, 1, RatingStateRated},
		// A bot at the floor that the record *did* place is the case the whole
		// change exists for: it plays no better than chance, and the board is now
		// able to say so rather than filing it with the unmeasured.
		{"placed at chance level", true, 0.99, RatingStateRated},
	} {
		if got := RatingStateOf(testCase.placed, testCase.confidence); got != testCase.want {
			t.Errorf("%s: got %q, want %q", testCase.name, got, testCase.want)
		}
	}
}

// A bot the fit will not speak about must not be recorded as one it placed at
// the floor. The distinction exists inside fitBotRatings and used to be thrown
// away by botRatingOr one line before it was stored.
func TestAnUnplacedBotIsStoredAsUnrated(t *testing.T) {
	// A private league: two engines that have played each other and nobody the
	// scale is defined by. botLadderCore refuses to rank them.
	ratings, confidence := fitBotRatings(headToHead(
		record{first: "anchor", second: "rung-1", games: 20, firstScore: 6},
		record{first: "clique-a", second: "clique-b", games: 20, firstScore: 12},
	), BotYardsticks{
		Anchor: "anchor",
		Slots:  map[string]string{"anchor": BenchmarkRandom, "rung-1": BenchmarkGreedy},
	})

	for _, name := range []string{"clique-a", "clique-b"} {
		if _, placed := ratings[name]; placed {
			t.Errorf("%s is in a group with no yardstick and was placed anyway", name)
		}
		if state := RatingStateOf(false, confidence[name]); state != RatingStateUnrated {
			t.Errorf("%s reads %q, want %q", name, state, RatingStateUnrated)
		}
	}
	// And the rung the anchor actually played is placed, at its declaration.
	if _, placed := ratings["rung-1"]; !placed {
		t.Fatal("a declared rung on the record was not placed")
	}
	if confidence["rung-1"] != 1 {
		t.Errorf("a declared rung kept %v of its rating, want 1", confidence["rung-1"])
	}
}

// The confidence the fit publishes is the same ratio it shrank by, so a bot with
// a real record keeps almost all of it and one resting on a single lopsided pair
// does not.
func TestConfidenceTracksHowMuchTheRecordEstablishes(t *testing.T) {
	yardsticks := BotYardsticks{
		Anchor: "anchor",
		Slots: map[string]string{
			"anchor": BenchmarkRandom, "greedy": BenchmarkGreedy, "fish5": BenchmarkFish5,
		},
	}
	_, confidence := fitBotRatings(headToHead(
		record{first: "anchor", second: "greedy", games: 20, firstScore: 1},
		record{first: "greedy", second: "solid", games: 20, firstScore: 6},
		record{first: "solid", second: "fish5", games: 20, firstScore: 9},
		record{first: "greedy", second: "thin", games: 20, firstScore: 10},
	), yardsticks)

	if got := confidence["solid"]; got < RatingConfidenceRanked {
		t.Errorf("an engine with two even matchups kept only %.3f of its rating", got)
	}
	if _, found := confidence["thin"]; !found {
		t.Fatal("an engine that played a rung was not placed at all")
	}
}

// A board on which nothing has been placed must not be presented as an order.
// This is the state production is in today: no yardstick, so the fit publishes
// nothing, and every engine sits at the floor.
func TestUnratedRowsSortBelowMeasuredOnes(t *testing.T) {
	store := authTestStore(t)
	registeredOwner(t, store, "measured", "Measured")
	registeredOwner(t, store, "busy", "Busy")

	// The unplaced one has played far more games and holds the same floor
	// rating, which is exactly how the old board put it first.
	seedRecord(t, store, "measured", 40, 3)
	seedUnplacedRating(t, store, "busy", game.ModeTotalWar, RatingFloor, 900)
	if _, err := store.db.ExecContext(t.Context(),
		"UPDATE accounts SET games_played = ? WHERE user_id = ?", 900, "busy",
	); err != nil {
		t.Fatalf("seed busy record: %v", err)
	}

	entries, err := store.Leaderboard(t.Context(), LeaderboardFilter{
		ModeID: string(game.ModeTotalWar),
	})
	if err != nil {
		t.Fatalf("leaderboard: %v", err)
	}
	if names := usernames(entries); len(names) != 2 || names[0] != "Measured" {
		t.Fatalf("board ordered %v, want the measured account first", names)
	}
	if entries[0].State != RatingStateRated {
		t.Errorf("the measured row reads %q", entries[0].State)
	}
	if entries[1].State != RatingStateUnrated {
		t.Errorf("the unplaced row reads %q, want %q", entries[1].State, RatingStateUnrated)
	}
}

// A person who has never played a mode is not a person rated 1 in it.
func TestAFreshPlayerIsUnratedRatherThanRatedAtTheFloor(t *testing.T) {
	fresh := humanRating{variance: humanInitialVariance}
	if state := RatingStateOf(false, fresh.confidence()); state != RatingStateUnrated {
		t.Errorf("a player who has played nothing reads %q", state)
	}
	// And a settled one is not held back by the same rule.
	settled := humanRating{theta: 6, variance: humanMinimumVariance}
	if state := RatingStateOf(true, settled.confidence()); state != RatingStateRated {
		t.Errorf("a settled player reads %q, want %q", state, RatingStateRated)
	}
	// Half a dozen games in, the shrinkage is still visibly holding the number
	// back, and saying so is the point of the middle state.
	early := humanRating{theta: 3, variance: 1.0}
	if state := RatingStateOf(true, early.confidence()); state != RatingStateProvisional {
		t.Errorf("an early record reads %q, want %q", state, RatingStateProvisional)
	}
}
