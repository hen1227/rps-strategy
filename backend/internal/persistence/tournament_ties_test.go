package persistence

import (
	"math/rand/v2"
	"strconv"
	"testing"
)

// A tie in the table, and the weekend arena's length.
//
// Both came from one screenshot: a nine-engine arena played four rounds of
// Swiss and ended with two engines on ten points ranked first and second by
// the order they signed up in.

// ranksOf is the table as "name:rank", top to bottom.
func ranksOf(tournament Tournament) []string {
	ranks := make([]string, 0, len(tournament.Standings))
	for _, standing := range tournament.Standings {
		ranks = append(ranks, standing.IGN+":"+strconv.Itoa(standing.Rank))
	}
	return ranks
}

func sameRanks(got []string, want ...string) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}

// Entrants level on points share a rank, and the next one down skips the places
// they took.
func TestEntrantsLevelOnPointsShareARank(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	draft(t, store, "level", TournamentConfig{})
	if _, err := store.PublishTournament(t.Context(), "level"); err != nil {
		t.Fatal(err)
	}
	enter(t, store, "level", "Ada", "Grace", "Kay", "Lin")
	tournament, err := store.StartTournament(t.Context(), "level")
	if err != nil {
		t.Fatal(err)
	}

	// Ada and Grace draw each other and beat the rest; Kay and Lin draw each
	// other and lose the rest. Seven points each at the top, one each below.
	strong := map[string]bool{"Ada": true, "Grace": true}
	for _, match := range tournament.Matches {
		first, second := strong[match.Player1.IGN], strong[match.Player2.IGN]
		result := MatchDraw
		switch {
		case first && !second:
			result = MatchPlayer1Win
		case second && !first:
			result = MatchPlayer2Win
		}
		tournament = win(t, store, "level", match.MatchID, result)
	}
	if tournament.Status != TournamentCompleted {
		t.Fatalf("expected the event to finish, got %q", tournament.Status)
	}
	// Signup order still decides who is printed first within a tie, so the
	// table reads the same every time. It no longer decides the rank.
	if got := ranksOf(tournament); !sameRanks(got, "Ada:1", "Grace:1", "Kay:3", "Lin:3") {
		t.Fatalf("expected two shared places, got %v", got)
	}

	// The title rule and the table agree on who won.
	champions := tournamentChampions(tournament)
	if len(champions) != 2 {
		t.Fatalf("expected both leaders crowned, got %v", champions)
	}
	for _, userID := range []string{"user-Ada", "user-Grace"} {
		if _, ok := champions[userID]; !ok {
			t.Fatalf("%s tied for first and was not crowned: %v", userID, champions)
		}
	}

	// And a profile says the place was shared.
	for name, want := range map[string]int{"Grace": 1, "Lin": 3} {
		entries, err := store.profileTournaments(t.Context(), "user-"+name)
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) != 1 || entries[0].Placement == nil {
			t.Fatalf("expected %s to have one placed event, got %#v", name, entries)
		}
		if *entries[0].Placement != want || !entries[0].Tied {
			t.Fatalf("expected %s tied at %d, got %d (tied %v)",
				name, want, *entries[0].Placement, entries[0].Tied)
		}
	}
}

// A clear table is unchanged: one entrant to a place, and nobody marked tied.
func TestAClearTableKeepsOneEntrantToAPlace(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	draft(t, store, "clear", TournamentConfig{})
	if _, err := store.PublishTournament(t.Context(), "clear"); err != nil {
		t.Fatal(err)
	}
	enter(t, store, "clear", "Ada", "Grace", "Kay")
	tournament, err := store.StartTournament(t.Context(), "clear")
	if err != nil {
		t.Fatal(err)
	}
	// Strength in the order they are named: Ada beats both, Grace beats Kay.
	order := map[string]int{"Ada": 0, "Grace": 1, "Kay": 2}
	for _, match := range tournament.Matches {
		result := MatchPlayer1Win
		if order[match.Player2.IGN] < order[match.Player1.IGN] {
			result = MatchPlayer2Win
		}
		tournament = win(t, store, "clear", match.MatchID, result)
	}
	if got := ranksOf(tournament); !sameRanks(got, "Ada:1", "Grace:2", "Kay:3") {
		t.Fatalf("expected a clear table, got %v", got)
	}
	entries, err := store.profileTournaments(t.Context(), "user-Ada")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Tied {
		t.Fatalf("an outright winner should not read as tied: %#v", entries)
	}
}

// A knockout ranks by the round somebody went out in, so the two beaten
// semi-finalists share third and the final's two players do not share anything.
func TestBeatenSemiFinalistsShareThird(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	draft(t, store, "knockout", TournamentConfig{Format: FormatSingleElimination})
	if _, err := store.PublishTournament(t.Context(), "knockout"); err != nil {
		t.Fatal(err)
	}
	enter(t, store, "knockout", "Ada", "Grace", "Kay", "Lin")
	tournament, err := store.StartTournament(t.Context(), "knockout")
	if err != nil {
		t.Fatal(err)
	}
	for round := 1; round <= 2; round++ {
		for _, match := range roundOf(tournament, round) {
			tournament = win(t, store, "knockout", match.MatchID, MatchPlayer1Win)
		}
	}
	if tournament.Status != TournamentCompleted {
		t.Fatalf("expected the bracket to finish, got %q", tournament.Status)
	}
	ranks := make([]int, 0, 4)
	for _, standing := range tournament.Standings {
		ranks = append(ranks, standing.Rank)
	}
	if len(ranks) != 4 || ranks[0] != 1 || ranks[1] != 2 || ranks[2] != 3 || ranks[3] != 3 {
		t.Fatalf("expected 1, 2, 3, 3, got %v", ranks)
	}
}

// A drawn final knocks out the lower seed and scores both finalists a point, so
// the two finish level on points: a semi-final win and a draw each. Only the
// survivor won the event, for the lifetime title and a deletion's report alike.
func TestADrawnFinalCrownsOnlyTheSurvivor(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	draft(t, store, "drawn", TournamentConfig{Format: FormatSingleElimination})
	if _, err := store.PublishTournament(t.Context(), "drawn"); err != nil {
		t.Fatal(err)
	}
	enter(t, store, "drawn", "Ada", "Grace", "Kay", "Lin")
	tournament, err := store.StartTournament(t.Context(), "drawn")
	if err != nil {
		t.Fatal(err)
	}
	// The higher seed takes each semi-final, which puts Ada and Grace in the
	// final on three points each.
	for _, match := range roundOf(tournament, 1) {
		result := MatchPlayer1Win
		if match.Player2.Seed < match.Player1.Seed {
			result = MatchPlayer2Win
		}
		tournament = win(t, store, "drawn", match.MatchID, result)
	}
	final := roundOf(tournament, 2)
	if len(final) != 1 {
		t.Fatalf("expected one final, got %d", len(final))
	}
	tournament = win(t, store, "drawn", final[0].MatchID, MatchDraw)
	if tournament.Status != TournamentCompleted {
		t.Fatalf("expected the bracket to finish, got %q", tournament.Status)
	}
	// Ada goes through on seed. The finalists being level on points is the case
	// under test, so check the bracket still produces it.
	if got := ranksOf(tournament); !sameRanks(got, "Ada:1", "Grace:2", "Kay:3", "Lin:3") {
		t.Fatalf("expected Ada through on seed, got %v", got)
	}
	if ada, grace := tournament.Standings[0], tournament.Standings[1]; ada.Points != grace.Points {
		t.Fatalf("expected the finalists level on points, got %d and %d", ada.Points, grace.Points)
	}

	champions := tournamentChampions(tournament)
	if _, crowned := champions["user-Ada"]; !crowned || len(champions) != 1 {
		t.Fatalf("expected Ada alone crowned, got %v", champions)
	}
	// The lifetime title reads the same rule.
	evaluate(t, store, "user-Ada")
	evaluate(t, store, "user-Grace")
	if !holds(t, store, "user-Ada", TitleTournamentChampion) {
		t.Fatal("the survivor was not made Tournament Champion")
	}
	if holds(t, store, "user-Grace", TitleTournamentChampion) {
		t.Fatal("the finalist knocked out on seed was made Tournament Champion")
	}
	// And so does the champion a deletion reports.
	deletion, err := store.DeleteTournament(t.Context(), "drawn")
	if err != nil {
		t.Fatal(err)
	}
	if len(deletion.ChampionUserIDs) != 1 || deletion.ChampionUserIDs[0] != "user-Ada" {
		t.Fatalf("expected the deletion to name Ada alone, got %v", deletion.ChampionUserIDs)
	}
}

// The arena's length: nine engines get seven rounds, with no rematches.
//
// The pairing search avoids a rematch whenever one can be avoided, and seven of
// a possible eight rounds is the late-event corner where a small field starts
// running out of opponents it has not met. So this plays it many times over,
// with results drawn at random, rather than once with results that happen to be
// kind to the pairing.
func TestNineEnginesPlaySevenSwissRoundsWithoutARematch(t *testing.T) {
	names := []string{
		"Ada", "Grace", "Kay", "Lin", "Mary", "Noether", "Olga", "Petra", "Quinn",
	}
	outcomes := []TournamentMatchResult{MatchPlayer1Win, MatchPlayer2Win, MatchDraw}
	for seed := uint64(1); seed <= 40; seed++ {
		store, err := Open(":memory:")
		if err != nil {
			t.Fatal(err)
		}
		random := rand.New(rand.NewPCG(seed, 7))
		draft(t, store, "arena", TournamentConfig{
			Format:      FormatSwiss,
			SwissRounds: DefaultWeekendConfig().SwissRounds,
		})
		if _, err := store.PublishTournament(t.Context(), "arena"); err != nil {
			t.Fatal(err)
		}
		enter(t, store, "arena", names...)
		tournament, err := store.StartTournament(t.Context(), "arena")
		if err != nil {
			t.Fatal(err)
		}
		if tournament.Rounds != 7 {
			t.Fatalf("expected seven rounds for nine engines, got %d", tournament.Rounds)
		}
		met := make(map[[2]int64]bool)
		for round := 1; round <= 7; round++ {
			matches := roundOf(tournament, round)
			if len(matches) != 4 {
				t.Fatalf("seed %d round %d has %d matches, expected 4",
					seed, round, len(matches))
			}
			for _, match := range matches {
				key := pairKey(match.Player1.PlayerID, match.Player2.PlayerID)
				if met[key] {
					t.Fatalf("seed %d round %d repeated %s v %s",
						seed, round, match.Player1.IGN, match.Player2.IGN)
				}
				met[key] = true
				tournament = win(t, store, "arena", match.MatchID,
					outcomes[random.IntN(len(outcomes))])
			}
		}
		if tournament.Status != TournamentCompleted {
			t.Fatalf("seed %d: expected the event to end after seven rounds, got %q",
				seed, tournament.Status)
		}
		if err := store.Close(); err != nil {
			t.Fatal(err)
		}
	}
}

// A smaller field is capped at meeting everybody once.
func TestTheArenaLengthIsCappedByTheField(t *testing.T) {
	rounds := DefaultWeekendConfig().SwissRounds
	for field, want := range map[int]int{4: 3, 6: 5, 8: 7, 9: 7, 16: 7, 40: 7} {
		if got := plannedRounds(FormatSwiss, field, rounds); got != want {
			t.Fatalf("a Swiss of %d engines should play %d rounds, got %d", field, want, got)
		}
	}
}

// The row a server already has takes the longer event on its first boot, and a
// host's own answer, zero included, survives a save.
func TestAnExistingArenaTakesTheLongerSwiss(t *testing.T) {
	store, err := Open(legacyNightlyDatabase(t, nil))
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	ctx := t.Context()

	config, err := store.WeekendConfiguration(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if config.SwissRounds != 7 {
		t.Fatalf("expected the existing row to take seven rounds, got %d", config.SwissRounds)
	}
	for asked, want := range map[int]int{0: 0, 5: 5, 99: 32, -3: 0} {
		config.SwissRounds = asked
		saved, err := store.SaveWeekendConfiguration(ctx, config)
		if err != nil {
			t.Fatal(err)
		}
		if saved.SwissRounds != want {
			t.Fatalf("saving %d rounds should store %d, got %d", asked, want, saved.SwissRounds)
		}
	}
}
