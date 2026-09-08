package persistence

import (
	"fmt"
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

// The whole point of the file. A bot that beat one throwaway two hundred times
// has demonstrated nothing, and the ladder says so by not ranking it at all:
// the throwaway has one opponent, so it is pruned, which leaves the farmer with
// none, so it goes too.
//
// Under the per-game Elo this replaced, the farm won outright. Every one of
// those two hundred wins took points off an account that started at DefaultElo,
// and no amount of real play could keep up with a loop that never has to lose.
func TestFarmingOneWeakBotLeavesYouUnrated(t *testing.T) {
	field := []string{"field-1", "field-2", "field-3", "field-4"}
	entries := roundRobin(20, field...)
	for _, opponent := range field {
		entries = append(entries, record{
			first: "contender", second: opponent, games: 20, firstScore: 15,
		})
	}
	entries = append(entries, record{
		first: "farmer", second: "throwaway", games: 200, firstScore: 200,
	})

	ratings := fitBotRatings(headToHead(entries...))
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
	entries := roundRobin(20, field...)
	for index := range 20 {
		entries = append(entries, record{
			first:  "farmer",
			second: fmt.Sprintf("throwaway-%d", index),
			games:  10, firstScore: 10,
		})
	}

	ratings := fitBotRatings(headToHead(entries...))
	if _, found := ratings["farmer"]; found {
		t.Fatalf("two hundred wins over twenty throwaways earned a rating: %#v", ratings)
	}
	if len(ratings) != len(field) {
		t.Fatalf("expected only the real field to be ranked, got %#v", ratings)
	}
}

// A farm built to survive the prune — bots that play each other enough to clear
// the bar — is still a private league, and a private league says nothing about
// where its members stand against anybody else. It is not the ladder, so it is
// not ranked.
func TestAPrivateLeagueIsNotTheLadder(t *testing.T) {
	field := []string{"field-1", "field-2", "field-3", "field-4", "field-5"}
	entries := roundRobin(20, field...)
	entries = append(entries,
		record{first: "farmer", second: "mine-1", games: 20, firstScore: 20},
		record{first: "farmer", second: "mine-2", games: 20, firstScore: 20},
		record{first: "mine-1", second: "mine-2", games: 20, firstScore: 10},
	)

	ratings := fitBotRatings(headToHead(entries...))
	if _, found := ratings["farmer"]; found {
		t.Fatalf("a private league earned a rating: %#v", ratings)
	}
	if len(ratings) != len(field) {
		t.Fatalf("expected only the real field to be ranked, got %#v", ratings)
	}
}

// Two hundred games and twenty games at the same ratio are the same claim about
// which bot is better, so they have to rate the same. This is botRatingPairCap,
// and it is what stops a farm from simply being run for longer.
func TestGamesPastThePairCapChangeNothing(t *testing.T) {
	ladder := func(games float64, score float64) map[string]int {
		field := []string{"field-1", "field-2", "field-3", "field-4"}
		entries := roundRobin(20, field...)
		entries = append(entries, record{
			first: "field-1", second: "field-2", games: games, firstScore: score,
		})
		return fitBotRatings(headToHead(entries...))
	}
	short := ladder(botRatingPairCap, botRatingPairCap*0.75)
	long := ladder(400, 300)
	if len(short) == 0 {
		t.Fatal("the ladder under test came back empty")
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
	// A graded field: field-1 beats everyone below it, field-4 loses to
	// everyone above.
	field := []string{"field-1", "field-2", "field-3", "field-4"}
	entries := []record{}
	for first := range field {
		for second := first + 1; second < len(field); second++ {
			entries = append(entries, record{
				first: field[first], second: field[second], games: 20, firstScore: 15,
			})
		}
	}
	entries = append(entries,
		record{first: "honest", second: "field-1", games: 20, firstScore: 15},
		record{first: "honest", second: "field-2", games: 20, firstScore: 15},
		record{first: "farmer", second: "field-3", games: 20, firstScore: 15},
		record{first: "farmer", second: "field-4", games: 20, firstScore: 15},
	)

	ratings := fitBotRatings(headToHead(entries...))
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
	ratings := fitBotRatings(headToHead(
		record{first: "middle-1", second: "middle-2", games: 20, firstScore: 10},
		record{first: "top", second: "middle-1", games: 20, firstScore: 15},
		record{first: "top", second: "middle-2", games: 20, firstScore: 15},
		record{first: "bottom", second: "middle-1", games: 20, firstScore: 5},
		record{first: "bottom", second: "middle-2", games: 20, firstScore: 5},
	))
	if !(ratings["top"] > ratings["middle-1"] && ratings["middle-1"] > ratings["bottom"]) {
		t.Fatalf("expected top > middle > bottom, got %#v", ratings)
	}
}

// A bot needs opponents, not games. One matchup played to death is a record
// about one matchup, and the ladder has nothing to say about it.
func TestABotWithOneOpponentIsNotRanked(t *testing.T) {
	field := []string{"field-1", "field-2", "field-3", "field-4"}
	entries := append(roundRobin(20, field...), record{
		first: "newcomer", second: "field-1", games: 500, firstScore: 300,
	})
	ratings := fitBotRatings(headToHead(entries...))
	if _, found := ratings["newcomer"]; found {
		t.Fatalf("a bot with a single opponent was ranked: %#v", ratings)
	}
}

// The other half of that: two opponents is enough to be ranked, and a bot that
// beats established engines ranks above them.
func TestTwoOpponentsIsEnoughToBeRanked(t *testing.T) {
	field := []string{"field-1", "field-2", "field-3", "field-4"}
	entries := append(roundRobin(20, field...),
		record{first: "newcomer", second: "field-1", games: 20, firstScore: 16},
		record{first: "newcomer", second: "field-2", games: 20, firstScore: 16},
	)
	ratings := fitBotRatings(headToHead(entries...))
	if ratings["newcomer"] <= ratings["field-1"] {
		t.Fatalf("beating two established bots should rank above them: %#v", ratings)
	}
}

// An even record against the whole board is the definition of average, and
// average is where DefaultElo is pinned.
func TestAnEvenRecordAgainstTheBoardIsTheDefault(t *testing.T) {
	field := []string{"field-1", "field-2", "field-3", "field-4", "field-5"}
	ratings := fitBotRatings(headToHead(roundRobin(20, field...)...))
	for bot, rating := range ratings {
		if rating != DefaultElo {
			t.Fatalf("an evenly matched board should sit at %d: %s is %d",
				DefaultElo, bot, rating)
		}
	}
}

// Go randomises map order and the fit is floating point, so the same record has
// to be sorted into a fixed order before it is solved. Without that, a ladder
// could come out different on two runs of the same binary over the same games.
func TestTheFitIsDeterministic(t *testing.T) {
	entries := roundRobin(7, "a", "b", "c", "d", "e")
	entries = append(entries, record{first: "a", second: "c", games: 9, firstScore: 8})
	first := fitBotRatings(headToHead(entries...))
	if len(first) != 5 {
		t.Fatalf("expected the whole round robin to be ranked, got %#v", first)
	}
	for range 20 {
		again := fitBotRatings(headToHead(entries...))
		for bot, rating := range first {
			if again[bot] != rating {
				t.Fatalf("fit is not deterministic: %s was %d then %d", bot, rating, again[bot])
			}
		}
	}
}

// Bots are identified by random UUIDs, so anything in the fit that varied with
// their order would be a ladder that shuffled itself every restart. This caught
// a real one: the weights deciding where the middle of the board sits were being
// read off a variance measured from whichever bot happened to sort first.
func TestRenamingBotsDoesNotChangeTheLadder(t *testing.T) {
	entries := []record{
		{first: "alpha", second: "bravo", games: 20, firstScore: 13},
		{first: "alpha", second: "charlie", games: 12, firstScore: 9},
		{first: "bravo", second: "charlie", games: 20, firstScore: 11},
		{first: "charlie", second: "delta", games: 8, firstScore: 6},
		{first: "alpha", second: "delta", games: 20, firstScore: 17},
	}
	original := fitBotRatings(headToHead(entries...))
	if len(original) != 4 {
		t.Fatalf("expected all four bots ranked, got %#v", original)
	}

	// The same record with the names permuted. Every rating has to follow its
	// bot exactly.
	renamed := map[string]string{
		"alpha": "zulu", "bravo": "yankee", "charlie": "xray", "delta": "whiskey",
	}
	moved := make([]record, 0, len(entries))
	for _, entry := range entries {
		moved = append(moved, record{
			first:  renamed[entry.first],
			second: renamed[entry.second],
			games:  entry.games, firstScore: entry.firstScore,
		})
	}
	after := fitBotRatings(headToHead(moved...))
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
		entries := roundRobin(12, field...)
		entries = append(entries,
			record{first: "climber", second: "field-1", games: 12, firstScore: scoreAgainstTop},
			record{first: "climber", second: "field-2", games: 12, firstScore: 6},
			record{first: "climber", second: "field-3", games: 12, firstScore: 6},
		)
		return fitBotRatings(headToHead(entries...))["climber"]
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
	if ratings := fitBotRatings(nil); len(ratings) != 0 {
		t.Fatalf("expected no ratings, got %#v", ratings)
	}
}

// A bot that has lost every game it has played is an ordinary thing to find on
// a real ladder and it used to take the whole board down with it.
//
// Such a bot has no finite Bradley-Terry strength: the fit drives it to
// strengthFloor and the information matrix reports its variance as about a
// billion, which is a true statement about an unidentified parameter. The
// shrinkage in fitBotRatings is a comparison between the board's spread and its
// noise, both weighted averages, and an unbounded term in either of them wins.
// One such bot among fourteen was enough to make the fit conclude that none of
// the board's spread was real and publish every engine, including a 131-21
// leader, at DefaultElo.
//
// The synthetic ladders elsewhere in this file all have every bot winning
// something, which is why they never caught it.
func TestOneHopelessRecordDoesNotFlattenTheBoard(t *testing.T) {
	// A graded field that the fit can certainly separate, plus one bot that has
	// never scored against any of it.
	field := []string{"field-1", "field-2", "field-3", "field-4"}
	entries := []record{}
	for first := range field {
		for second := first + 1; second < len(field); second++ {
			entries = append(entries, record{
				first: field[first], second: field[second], games: 20, firstScore: 15,
			})
		}
	}
	graded := fitBotRatings(headToHead(entries...))

	for _, opponent := range field {
		entries = append(entries, record{
			first: "hopeless", second: opponent, games: 12, firstScore: 0,
		})
	}
	ratings := fitBotRatings(headToHead(entries...))

	if len(ratings) != len(field)+1 {
		t.Fatalf("expected the field and the hopeless bot to be ranked, got %#v", ratings)
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
		if moved := ratings[bot] - graded[bot]; moved > 60 || moved < -60 {
			t.Fatalf("%s moved %d points because a hopeless bot joined the board",
				bot, moved)
		}
	}
	// Below average, and below every bot the record places above average — but
	// deliberately *not* below the bottom of the field, and that is worth being
	// explicit about because it looks wrong on a board.
	//
	// This bot's strength is unidentified: an all-loss record is consistent with
	// any strength below the field's, so what it has earned is a one-sided bound
	// and not a rating. The constants above choose what to publish for such a
	// bot, and they choose the middle: pushing uncertainty *down* was considered
	// and rejected there, because it drives the bots nobody has placed to the
	// floor and leaves whoever the arithmetic favoured on top. So a bot with no
	// record to speak of sits near DefaultElo, and a bot the record measures as
	// weak — field-4, which has played twelve games against each of three
	// opponents and lost most of them — can sit below it. That is the ladder
	// declining to rank by accident, not the flattening this test is about.
	if ratings["hopeless"] >= DefaultElo {
		t.Fatalf("a bot that has never won rated at or above average: %#v", ratings)
	}
	if ratings["hopeless"] >= ratings["field-2"] {
		t.Fatalf("a bot that has never won outranked a measured winning record: %#v", ratings)
	}
	if ratings["hopeless"] == botRatingFloor {
		t.Fatalf("an unidentified strength was published as the floor: %#v", ratings)
	}
}

// The same pathology at the other end of the board, and the reason a bot with
// no finite strength is pulled towards the middle rather than clamped to
// botRatingCeiling: an unbeaten record over two opponents is unidentified in
// exactly the way an all-loss record is, and publishing the ceiling for it
// would hand the top of the ladder to whoever played two games and won them.
func TestAnUnbeatenNewcomerDoesNotTakeTheBoard(t *testing.T) {
	field := []string{"field-1", "field-2", "field-3", "field-4", "field-5"}
	entries := []record{}
	for first := range field {
		for second := first + 1; second < len(field); second++ {
			entries = append(entries, record{
				first: field[first], second: field[second], games: 20, firstScore: 15,
			})
		}
	}
	entries = append(entries,
		record{first: "newcomer", second: "field-4", games: 2, firstScore: 2},
		record{first: "newcomer", second: "field-5", games: 2, firstScore: 2},
	)

	ratings := fitBotRatings(headToHead(entries...))
	if _, found := ratings["newcomer"]; !found {
		t.Fatalf("two opponents is enough to be ranked: %#v", ratings)
	}
	if ratings["newcomer"] >= ratings["field-1"] {
		t.Fatalf("four wins over the bottom of the board took the top of it: %#v", ratings)
	}
	if ratings["newcomer"] == botRatingCeiling {
		t.Fatalf("an unidentified strength was published as the ceiling: %#v", ratings)
	}
}

// The shrinkage has to be able to say "this board establishes nothing" — that is
// what it is for — and a record of nothing but coin flips is that board. It is
// the property the fix for the flattening above must not have thrown away.
func TestABoardThatEstablishesNothingCollapsesToTheDefault(t *testing.T) {
	// Two games per pair, split down the middle: connected, past the opponent
	// bar, and carrying no evidence that anybody is better than anybody.
	ratings := fitBotRatings(headToHead(roundRobin(2, "a", "b", "c", "d", "e")...))
	if len(ratings) != 5 {
		t.Fatalf("expected the whole round robin to be ranked, got %#v", ratings)
	}
	for bot, rating := range ratings {
		if rating != DefaultElo {
			t.Fatalf("a board with no evidence in it should sit at %d: %s is %d",
				DefaultElo, bot, rating)
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
          1200, 1200, 1200, 1200, 30, 60000, 0, 1000, 1000)
`,
		gameID, game.ModeTotalWar, "Total War",
		red.UserID, red.Username, blue.UserID, blue.Username,
		winner, colour, outcome,
	); err != nil {
		t.Fatalf("seed bot game %s: %v", gameID, err)
	}
	for _, player := range []Account{red, blue} {
		if _, err := store.db.ExecContext(t.Context(), `
INSERT OR IGNORE INTO account_mode_ratings (
    user_id, mode_id, elo, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, 1000, 1000)
`, player.UserID, game.ModeTotalWar, DefaultElo); err != nil {
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
// nobody has tested — it is a bot with no rating, and DefaultElo is how this
// ladder says so. Otherwise a number won under the old system, or before its
// games were deleted, would sit there claiming evidence that is gone.
func TestABotWithNoRankedGamesGoesBackToDefault(t *testing.T) {
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
	if got := botRating(t, store, lonely.UserID); got != DefaultElo {
		t.Fatalf("expected an untested bot at %d, got %d", DefaultElo, got)
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

// The wiring: a real game recorded through the ordinary path has to move the
// bot ladder rather than trade Elo, and the before and after written onto its
// history row have to be the fit's own numbers.
func TestRecordingABotGameMovesTheLadderRatherThanTradingElo(t *testing.T) {
	store := botLadderStore(t)
	winner, loser, third := threeBots(t, store)
	// A board for the two to be rated against. A pair on its own is below the
	// two-opponent bar, so without the third bot there would be no ladder for
	// this game to move.
	seedBotRoundRobin(t, store, []Account{winner, loser, third}, 8, 6)
	if err := store.RefitBotLadders(t.Context()); err != nil {
		t.Fatalf("refit: %v", err)
	}
	wasWinner := botRating(t, store, winner.UserID)
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
	if update.RedEloBefore != wasWinner {
		t.Fatalf("the game recorded a before-rating of %d, ladder held %d",
			update.RedEloBefore, wasWinner)
	}
	if update.RedEloAfter <= update.RedEloBefore {
		t.Fatalf("another win should not have cost the winner: %#v", update)
	}
	if update.BlueEloAfter >= update.BlueEloBefore {
		t.Fatalf("another loss should not have paid the loser: %#v", update)
	}
	if got := botRating(t, store, winner.UserID); got != update.RedEloAfter {
		t.Fatalf("history row says %d, ladder says %d", update.RedEloAfter, got)
	}
	// And the bot that was not playing has been re-rated too, because the fit is
	// over the whole board rather than the two seats. A per-game transfer could
	// not do this, and it is the reason the ladder cannot be farmed: a result is
	// read against everything else on record, not just against the opponent.
	if got := botRating(t, store, third.UserID); got == wasThird {
		t.Fatal("the bot that did not play was left where it was")
	}
}

// A bot's games against people are unranked and must stay out of the fit, or an
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
	if before == DefaultElo {
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
	if botRating(t, store, kept.UserID) == DefaultElo {
		t.Fatal("expected the board to have placed Kept first")
	}

	if _, err := store.DeleteBot(t.Context(), doomedBot.BotID); err != nil {
		t.Fatalf("delete bot: %v", err)
	}
	// Kept and Other now have one opponent each, which is below the bar, so
	// neither holds a rating won over a bot that has been erased.
	for _, bot := range []Account{kept, other} {
		if got := botRating(t, store, bot.UserID); got != DefaultElo {
			t.Fatalf("expected %s back at %d once the board was cut to a pair, got %d",
				bot.Username, DefaultElo, got)
		}
	}
}

// The registry row a directory or an owner's list is drawn from carries the
// bot's rating, and it has to be the one the ladder holds. `accounts.elo` is
// the seed a mode starts from and nothing ever moves it, so a row built on that
// column reports every engine at DefaultElo however it has been playing.
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
	if listed.Elo != DefaultElo {
		t.Fatalf("expected an unplayed engine at %d, got %d", DefaultElo, listed.Elo)
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
	if seen != 3 {
		t.Fatalf("expected three engines in the list, saw %d", seen)
	}
}
