package persistence

import (
	"errors"
	"testing"

	"rps-strategy/backend/internal/game"
)

func TestTournamentSignupRoundRobinAndStandings(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()

	tournament := openTournament(
		t, store, "summer-cup", "Summer Cup", game.ModeTotalWar, "Total War",
	)
	if tournament.Status != TournamentRegistration || len(tournament.Players) != 0 {
		t.Fatalf("unexpected new tournament: %#v", tournament)
	}

	players := []struct {
		userID  string
		ign     string
		discord string
	}{
		{"user-a", "Ada", "ada.dev"},
		{"user-b", "Babbage", "babbage"},
		{"user-c", "Curie", "curie_rps"},
		{"user-d", "Dirac", "dirac"},
	}
	for _, player := range players {
		// Every entrant is a verified account now, and the handle stored on the
		// signup is the verified one rather than the typed one — so the account
		// is claimed under the same handle this test expects to read back.
		registeredOwner(t, store, player.userID, player.discord)
		if _, err := store.SignupForTournament(
			t.Context(),
			tournament.TournamentID,
			player.userID,
			player.ign,
			player.discord,
			true,
		); err != nil {
			t.Fatal(err)
		}
	}

	tournament, err = store.StartTournament(t.Context(), tournament.TournamentID)
	if err != nil {
		t.Fatal(err)
	}
	if tournament.Status != TournamentInProgress || tournament.StartedAtUnixMs == nil {
		t.Fatalf("tournament did not start: %#v", tournament)
	}
	if len(tournament.Matches) != 6 {
		t.Fatalf("four players should produce six matches, got %d", len(tournament.Matches))
	}
	pairings := make(map[[2]int64]bool)
	roundCounts := make(map[int]int)
	for index, match := range tournament.Matches {
		if match.MatchOrder != index+1 || match.Result != MatchPending {
			t.Fatalf("unexpected ordered match: %#v", match)
		}
		first, second := match.Player1.PlayerID, match.Player2.PlayerID
		if first > second {
			first, second = second, first
		}
		pair := [2]int64{first, second}
		if pairings[pair] {
			t.Fatalf("duplicate pairing: %#v", match)
		}
		pairings[pair] = true
		roundCounts[match.RoundNumber]++
	}
	if len(roundCounts) != 3 || roundCounts[1] != 2 ||
		roundCounts[2] != 2 || roundCounts[3] != 2 {
		t.Fatalf("unexpected rounds: %#v", roundCounts)
	}

	for index, match := range tournament.Matches {
		result := MatchPlayer1Win
		if index == 0 {
			result = MatchDraw
		}
		tournament, err = store.SetTournamentMatchResult(
			t.Context(), tournament.TournamentID, match.MatchID, result,
		)
		if err != nil {
			t.Fatal(err)
		}
	}
	if tournament.Status != TournamentCompleted || tournament.CompletedAtUnixMs == nil {
		t.Fatalf("last result should complete the tournament: %#v", tournament)
	}
	if len(tournament.Standings) != 4 || tournament.Standings[0].Points < tournament.Standings[1].Points {
		t.Fatalf("standings were not ranked: %#v", tournament.Standings)
	}
	played := 0
	for _, standing := range tournament.Standings {
		if standing.Played != 3 {
			t.Fatalf("every player should play three matches: %#v", standing)
		}
		played += standing.Played
	}
	if played != 12 {
		t.Fatalf("six matches should count twelve appearances, got %d", played)
	}

	tournament, err = store.SetTournamentMatchResult(
		t.Context(), tournament.TournamentID, tournament.Matches[0].MatchID, MatchPending,
	)
	if err != nil {
		t.Fatal(err)
	}
	if tournament.Status != TournamentInProgress || tournament.CompletedAtUnixMs != nil {
		t.Fatalf("clearing a result should reopen scoring: %#v", tournament)
	}
}

func TestOddTournamentGivesEachPlayerOneMatchPerRound(t *testing.T) {
	rounds := roundRobinPairs([]int64{1, 2, 3})
	if len(rounds) != 3 {
		t.Fatalf("expected three rounds, got %#v", rounds)
	}
	seen := make(map[[2]int64]bool)
	for _, round := range rounds {
		if len(round) != 1 {
			t.Fatalf("three players should have one match and one bye per round: %#v", round)
		}
		pair := round[0]
		if pair[0] > pair[1] {
			pair[0], pair[1] = pair[1], pair[0]
		}
		seen[pair] = true
	}
	if len(seen) != 3 {
		t.Fatalf("expected all three unique pairings, got %#v", seen)
	}
}

func TestTournamentSignupValidationAndClosedRegistration(t *testing.T) {
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	tournament := openTournament(
		t, store, "validation-cup", "Validation Cup", game.ModeTotalWar, "Total War",
	)
	// Verified accounts, because this test is about the doors *after* that one.
	verifiedField(t, store, "user-a", "user-b", "user-c")

	if _, err := store.SignupForTournament(
		t.Context(), tournament.TournamentID, "user-a", "Ada", "ada", false,
	); !errors.Is(err, ErrInvalidTournament) ||
		err.Error() != "invalid tournament data: unfiltered chat agreement is required" {
		t.Fatalf("expected consent validation, got %v", err)
	}
	if _, err := store.SignupForTournament(
		t.Context(), tournament.TournamentID, "user-a", "Ada", "ada", true,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SignupForTournament(
		t.Context(), tournament.TournamentID, "user-b", "ada", "another", true,
	); !errors.Is(err, ErrTournamentSignupExists) {
		t.Fatalf("expected case-insensitive IGN collision, got %v", err)
	}
	if _, err := store.SignupForTournament(
		t.Context(), tournament.TournamentID, "user-b", "Babbage", "babbage", true,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := store.StartTournament(t.Context(), tournament.TournamentID); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SignupForTournament(
		t.Context(), tournament.TournamentID, "user-c", "Curie", "curie", true,
	); !errors.Is(err, ErrTournamentClosed) {
		t.Fatalf("expected closed registration, got %v", err)
	}
}
