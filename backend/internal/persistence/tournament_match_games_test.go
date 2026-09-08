package persistence

import (
	"testing"
)

// A pairing that plays more than one game.
//
// The unit that matters here is the *match*, not the game: the standings take
// one result from a pairing however many boards it took to reach, and the games
// underneath it are the record of how.

// playGame files one game of a match and reports whether that closed it.
func playGame(
	t *testing.T,
	store *Store,
	matchID int64,
	gameID string,
	player1PointsX2 int,
) (Tournament, bool) {
	t.Helper()
	tournament, complete, err := store.RecordTournamentMatchGame(
		t.Context(), "cup", matchID, gameID, player1PointsX2,
	)
	if err != nil {
		t.Fatalf("record %s: %v", gameID, err)
	}
	return tournament, complete
}

func TestAMultiGameMatchResolvesOnlyOnItsAggregate(t *testing.T) {
	store := authTestStore(t)

	draft(t, store, "cup", TournamentConfig{Name: "Match Cup", GamesPerMatch: 4})
	if _, err := store.PublishTournament(t.Context(), "cup"); err != nil {
		t.Fatal(err)
	}
	enter(t, store, "cup", "Ada", "Grace")
	started, err := store.StartTournament(t.Context(), "cup")
	if err != nil {
		t.Fatal(err)
	}
	if started.GamesPerMatch != 4 {
		t.Fatalf("the setting should survive the start, got %d", started.GamesPerMatch)
	}
	matchID := started.Matches[0].MatchID

	// A win, then a loss. The match is level and, crucially, still pending: a
	// single game is not a result when the pairing is four.
	for index, points := range []int{2, 0} {
		tournament, complete := playGame(t, store, matchID, "game-"+string(rune('a'+index)), points)
		if complete {
			t.Fatalf("the match closed after %d games of 4", index+1)
		}
		match := tournament.Matches[0]
		if match.Result != MatchPending {
			t.Fatalf("expected a pending match, got %q", match.Result)
		}
		if match.GamesPlayed != index+1 {
			t.Fatalf("expected %d games played, got %d", index+1, match.GamesPlayed)
		}
	}
	if levelled := started.Matches[0]; levelled.Player1Points != 0 {
		t.Fatalf("the started snapshot should predate any game, got %#v", levelled)
	}

	// Two draws leave it level, so the match is drawn on the aggregate even
	// though two of its four games had a winner.
	if _, complete := playGame(t, store, matchID, "game-c", 1); complete {
		t.Fatal("the match closed after 3 games of 4")
	}
	finished, complete := playGame(t, store, matchID, "game-d", 1)
	if !complete {
		t.Fatal("the fourth game should have closed the match")
	}
	match := finished.Matches[0]
	if match.Result != MatchDraw {
		t.Fatalf("expected a drawn match on 2-2, got %q", match.Result)
	}
	if match.GamesPlayed != 4 || match.Player1Points != 2 || match.Player2Points != 2 {
		t.Fatalf("expected 2-2 over four games, got %#v", match)
	}

	// A fifth game is not taken: the match has played what it was for.
	if _, complete := playGame(t, store, matchID, "game-e", 2); !complete {
		t.Fatal("a match past its games should report itself finished")
	}
	after, err := store.Tournament(t.Context(), "cup")
	if err != nil {
		t.Fatal(err)
	}
	if after.Matches[0].GamesPlayed != 4 {
		t.Fatalf("a replayed game was appended, got %d", after.Matches[0].GamesPlayed)
	}
}

// The ordinary event is one game per pairing, and it must behave exactly as it
// did before matches could be longer.
func TestASingleGameMatchResolvesOnItsFirstGame(t *testing.T) {
	store := authTestStore(t)

	draft(t, store, "cup", TournamentConfig{Name: "Plain Cup"})
	if _, err := store.PublishTournament(t.Context(), "cup"); err != nil {
		t.Fatal(err)
	}
	enter(t, store, "cup", "Ada", "Grace")
	started, err := store.StartTournament(t.Context(), "cup")
	if err != nil {
		t.Fatal(err)
	}
	if started.GamesPerMatch != 1 {
		t.Fatalf("an event that said nothing should play one game, got %d", started.GamesPerMatch)
	}

	tournament, complete := playGame(t, store, started.Matches[0].MatchID, "only", 2)
	if !complete {
		t.Fatal("a one-game match should close on its first game")
	}
	if tournament.Matches[0].Result != MatchPlayer1Win {
		t.Fatalf("expected the first player to win, got %q", tournament.Matches[0].Result)
	}
}

// A host who asks for something silly gets something legal.
func TestGamesPerMatchIsClampedRatherThanRefused(t *testing.T) {
	store := authTestStore(t)

	tournament := draft(t, store, "big", TournamentConfig{GamesPerMatch: 400})
	if tournament.GamesPerMatch != MaximumGamesPerMatch {
		t.Fatalf("expected the cap, got %d", tournament.GamesPerMatch)
	}
	negative := draft(t, store, "odd", TournamentConfig{GamesPerMatch: -3})
	if negative.GamesPerMatch != 1 {
		t.Fatalf("expected one game, got %d", negative.GamesPerMatch)
	}
}
