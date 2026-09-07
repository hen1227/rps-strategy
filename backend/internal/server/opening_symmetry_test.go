package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// Intransitive's board is unchanged by reflecting it about the a1-i9 diagonal,
// so `e3-f3` and `c5-c6` are one opening move played two ways: the same piece
// type steps the same way, and the boards they reach are each other's mirror.
// Named rather than repeated because every test below is about this one pair.
var (
	diagonalOpening     = "e3-f3"
	diagonalOpeningTwin = "c5-c6"
	diagonalReply       = "e7-d7"
	diagonalReplyTwin   = "g5-g4"
	// A move the reflection maps onto itself: both its squares are on the
	// diagonal. There are exactly two of these among the opening position's
	// thirty-six legal moves, and they are the case where folding must produce
	// one spelling rather than two.
	diagonalFixedOpening = "d4-e5"
)

func exploreIntransitive(
	t *testing.T,
	server *Server,
	query string,
) (persistence.OpeningStatsExplored, int) {
	t.Helper()
	recorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, httptest.NewRequest(
		"GET", "/api/openings/V6/explore"+query, nil,
	))
	var explored persistence.OpeningStatsExplored
	if recorder.Code == 200 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &explored); err != nil {
			t.Fatalf("%s: %v (%s)", query, err, recorder.Body)
		}
	}
	return explored, recorder.Code
}

func archiveIntransitiveOpenings(t *testing.T, server *Server, lines ...[]string) {
	t.Helper()
	red := game.PlayerProfile{UserID: "human-red", Username: "Red"}
	blue := game.PlayerProfile{UserID: "human-blue", Username: "Blue"}
	for index, line := range lines {
		archiveOpening(t, server.data, playOpening(
			t, fmt.Sprintf("reflected-%d", index), game.ModeIntransitive,
			red, blue, line, game.Blue,
		), time.Now())
	}
	if err := server.compileOpeningStats(
		context.Background(), game.ModeIntransitive,
	); err != nil {
		t.Fatal(err)
	}
}

// A position and its reflection are one position, counted once.
//
// Two games open with the two spellings of one move. Whichever of the two
// boards a visitor walks to, the explorer must say two games have been here --
// and the two questions must get the same answer, because they are the same
// question.
func TestTheExplorerCountsAPositionAndItsReflectionTogether(t *testing.T) {
	server := statsTestServer(t)
	archiveIntransitiveOpenings(t,
		server,
		[]string{diagonalOpening},
		[]string{diagonalOpeningTwin},
	)

	walked, status := exploreIntransitive(t, server, "?line="+diagonalOpening)
	if status != 200 {
		t.Fatalf("status %d", status)
	}
	if walked.Games != 2 {
		t.Fatalf("%d games reached the board, want both", walked.Games)
	}
	reflected, status := exploreIntransitive(t, server, "?line="+diagonalOpeningTwin)
	if status != 200 {
		t.Fatalf("status %d", status)
	}
	if reflected.Games != walked.Games {
		t.Fatalf("a board and its reflection disagree: %d and %d",
			walked.Games, reflected.Games)
	}
	if reflected.Ply != walked.Ply {
		t.Fatalf("a board and its reflection are %d and %d moves in",
			walked.Ply, reflected.Ply)
	}
}

// Two moves that reach the same position are one row, not two.
//
// The failure this exists to prevent is quiet: two rows of one game each, where
// the truth is one move played by both games, so every share on the page is
// halved and the most played continuation can be the wrong one.
func TestTheExplorerListsReflectedMovesAsOneContinuation(t *testing.T) {
	server := statsTestServer(t)
	archiveIntransitiveOpenings(t,
		server,
		[]string{diagonalOpening},
		[]string{diagonalOpeningTwin},
		[]string{diagonalFixedOpening},
	)

	explored, status := exploreIntransitive(t, server, "")
	if status != 200 {
		t.Fatalf("status %d", status)
	}
	if len(explored.Moves) != 2 {
		t.Fatalf("continuations from the opening position: %#v", explored.Moves)
	}
	leading := explored.Moves[0]
	if leading.Games != 2 {
		t.Fatalf("the reflected pair was played by %d games, want 2", leading.Games)
	}
	// Both spellings come back, and both are moves the visitor can play on the
	// board in front of them. Which one leads is alphabetical and arbitrary.
	spellings := append([]string{leading.Move}, leading.Twins...)
	if len(spellings) != 2 {
		t.Fatalf("spellings of the reflected move: %v", spellings)
	}
	for _, want := range []string{diagonalOpening, diagonalOpeningTwin} {
		if !containsMove(spellings, want) {
			t.Fatalf("%s is missing from %v", want, spellings)
		}
	}
	// Two thirds of the games that reached the opening position, which is the
	// number that would have read as one third twice without the fold.
	if leading.Share != 2.0/3.0 {
		t.Fatalf("share %v, want 2/3", leading.Share)
	}
	// A move the reflection maps onto itself has one spelling, not the same
	// spelling twice: d4 and e5 are both on the diagonal, so this move is its
	// own twin and the row says so by having none.
	fixed := explored.Moves[1]
	if fixed.Move != diagonalFixedOpening || len(fixed.Twins) != 0 {
		t.Fatalf("a self-reflecting move came back as %#v", fixed)
	}
}

// Once a game has left the diagonal, the fold stops: the board is no longer its
// own reflection, so each move has exactly one spelling again.
//
// This is the half of the rule that is easy to get wrong in the generous
// direction. Merging every pair of reflected moves everywhere would merge moves
// that reach genuinely different positions, and the page would then be unable
// to tell two real continuations apart.
func TestReflectedMovesStopMergingOnceTheBoardIsAsymmetric(t *testing.T) {
	server := statsTestServer(t)
	archiveIntransitiveOpenings(t,
		server,
		[]string{diagonalOpening, diagonalReply},
		[]string{diagonalOpening, diagonalReplyTwin},
	)

	explored, status := exploreIntransitive(t, server, "?line="+diagonalOpening)
	if status != 200 {
		t.Fatalf("status %d", status)
	}
	if len(explored.Moves) != 2 {
		t.Fatalf("two replies to an asymmetric board merged: %#v", explored.Moves)
	}
	for _, move := range explored.Moves {
		if len(move.Twins) != 0 {
			t.Fatalf("%s came back with twins %v", move.Move, move.Twins)
		}
		if move.Games != 1 {
			t.Fatalf("%s was played by %d games, want 1", move.Move, move.Games)
		}
	}
}

// Every move the explorer offers has to be a move the visitor can actually
// play from the board they walked to.
//
// The statistics are kept on a canonical board and the visitor is standing on
// whichever image of it their own moves produced, so a fold that forgot to map
// its answers back would hand out names of squares nobody is looking at. That
// failure is invisible in a count and obvious the moment somebody taps a row,
// which is the worst place to find it -- so it is checked here, by playing
// every move that comes back.
func TestEveryMoveTheExplorerOffersIsLegalOnTheCallersBoard(t *testing.T) {
	server := statsTestServer(t)
	archiveIntransitiveOpenings(t,
		server,
		[]string{diagonalOpening, diagonalReply},
		[]string{diagonalOpeningTwin, diagonalReplyTwin},
		[]string{diagonalFixedOpening},
	)

	for _, walked := range [][]string{
		{},
		{diagonalOpening},
		{diagonalOpeningTwin},
		{diagonalOpening, diagonalReply},
		{diagonalFixedOpening},
	} {
		query := ""
		if len(walked) > 0 {
			query = "?line=" + joinMoves(walked)
		}
		explored, status := exploreIntransitive(t, server, query)
		if status != 200 {
			t.Fatalf("%v: status %d", walked, status)
		}
		for _, move := range explored.Moves {
			for _, spelling := range append([]string{move.Move}, move.Twins...) {
				playOpening(
					t, "legality", game.ModeIntransitive,
					game.PlayerProfile{UserID: "red"},
					game.PlayerProfile{UserID: "blue"},
					append(append([]string{}, walked...), spelling), game.Blue,
				)
			}
		}
	}
}

// The line-keyed statistics are deliberately left alone.
//
// A position is a picture and a line is a path somebody walked, and the
// "most played openings" list answers the second question. Folding it here
// would be answering the first one twice.
func TestTheFoldDoesNotReachTheLineStatistics(t *testing.T) {
	server := statsTestServer(t)
	archiveIntransitiveOpenings(t,
		server,
		[]string{diagonalOpening},
		[]string{diagonalOpeningTwin},
	)
	node, err := server.data.OpeningStatsAt(
		context.Background(), string(game.ModeIntransitive),
		[]string{persistence.OpeningSegmentHuman}, nil, 0,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(node.Continuations) != 2 {
		t.Fatalf("the line statistics folded two openings into %#v", node.Continuations)
	}
}

// Total War and Infiltration are raced across the ranks, so their symmetry is
// the file mirror rather than the diagonal, and the same fold applies there.
func TestTheExplorerFoldsMirroredFilesInTheRankRacedModes(t *testing.T) {
	server := statsTestServer(t)
	red := game.PlayerProfile{UserID: "human-red", Username: "Red"}
	blue := game.PlayerProfile{UserID: "human-blue", Username: "Blue"}
	// d2-c3 and f2-g3 are each other's reflection across the middle file.
	for index, line := range [][]string{{"d2-c3"}, {"f2-g3"}} {
		archiveOpening(t, server.data, playOpening(
			t, fmt.Sprintf("mirrored-%d", index), game.ModeInfiltration,
			red, blue, line, game.Blue,
		), time.Now())
	}
	if err := server.compileOpeningStats(
		context.Background(), game.ModeInfiltration,
	); err != nil {
		t.Fatal(err)
	}

	explored, status := exploreStats(t, server, "")
	if status != 200 {
		t.Fatalf("status %d", status)
	}
	if len(explored.Moves) != 1 {
		t.Fatalf("mirrored first moves: %#v", explored.Moves)
	}
	if explored.Moves[0].Games != 2 || len(explored.Moves[0].Twins) != 1 {
		t.Fatalf("the mirrored pair came back as %#v", explored.Moves[0])
	}
	both, status := exploreStats(t, server, "?line=d2-c3")
	if status != 200 {
		t.Fatalf("status %d", status)
	}
	if both.Games != 2 {
		t.Fatalf("%d games reached the mirrored board, want both", both.Games)
	}
}

func containsMove(moves []string, want string) bool {
	for _, move := range moves {
		if move == want {
			return true
		}
	}
	return false
}

func joinMoves(line []string) string {
	joined := ""
	for index, move := range line {
		if index > 0 {
			joined += ","
		}
		joined += move
	}
	return joined
}
