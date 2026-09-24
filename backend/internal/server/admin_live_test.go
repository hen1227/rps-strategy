package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// liveTestServer is a server with an admin token and two seated players.
func liveTestServer(t *testing.T) (*Server, http.Handler, *GameSession) {
	t.Helper()
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { data.Close() })
	server := NewWithStoreAndAdminToken(data, nil, "test-secret")
	first := fakeClient(t, server, "one", false)
	second := fakeClient(t, server, "two", false)
	session := server.startConfiguredMatch(testEntry(first), testEntry(second), matchSetup{})
	if session == nil {
		t.Fatal("expected a session")
	}
	return server, server.Routes(), session
}

// liveGameCount is how many boards the admin route reports.
func liveGameCount(t *testing.T, handler http.Handler) int {
	t.Helper()
	response := tournamentRequest(t, handler, http.MethodGet, "/api/admin/live-games", nil, "test-secret")
	if response.Code != http.StatusOK {
		t.Fatalf("expected the live list, got %d: %s", response.Code, response.Body)
	}
	var games []AdminLiveGame
	if err := json.NewDecoder(response.Body).Decode(&games); err != nil {
		t.Fatal(err)
	}
	return len(games)
}

// Voiding takes the board away and files nothing.
func TestVoidingAGameRecordsNothing(t *testing.T) {
	server, handler, session := liveTestServer(t)
	if liveGameCount(t, handler) != 1 {
		t.Fatal("expected one live game to start with")
	}

	response := tournamentRequest(
		t, handler, http.MethodPost,
		"/api/admin/live-games/"+session.gameID+"/stop",
		map[string]any{"outcome": "void", "reason": "stuck in a loop"},
		"test-secret",
	)
	if response.Code != http.StatusOK {
		t.Fatalf("expected the game to be stopped, got %d: %s", response.Code, response.Body)
	}
	if strings.Contains(response.Body.String(), `"recorded":true`) {
		t.Fatalf("a voided game claimed to be recorded: %s", response.Body)
	}
	if liveGameCount(t, handler) != 0 {
		t.Fatal("the board is still live after being voided")
	}
	// Nothing filed, which is the whole difference between void and a declared
	// result. Asked of the archive rather than of the response, because the
	// response is what this route *says* and the history is what happened.
	history, err := server.data.SearchGames(t.Context(), "", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 0 {
		t.Fatalf("a voided game was filed anyway: %#v", history)
	}
}

// Declaring a result files the game like any other.
func TestStoppingWithAResultFilesTheGame(t *testing.T) {
	server, handler, session := liveTestServer(t)
	// A move, so the game has begun: an unstarted one takes a different path
	// entirely — see the test below.
	from, to := firstLegalMove(t, session, game.FirstToMove)
	if _, err := session.game.Move(game.FirstToMove, from, to); err != nil {
		t.Fatalf("open the game: %v", err)
	}

	response := tournamentRequest(
		t, handler, http.MethodPost,
		"/api/admin/live-games/"+session.gameID+"/stop",
		map[string]any{"outcome": "red", "reason": "opponent walked away"},
		"test-secret",
	)
	if response.Code != http.StatusOK {
		t.Fatalf("expected the game to be stopped, got %d: %s", response.Code, response.Body)
	}
	history, err := server.data.SearchGames(t.Context(), "", 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	if len(history) != 1 {
		t.Fatalf("expected one filed game, got %d", len(history))
	}
	if history[0].Outcome != "red_win" {
		t.Fatalf("expected a red win on record, got %q", history[0].Outcome)
	}
	// The reason it ended is its own, rather than borrowed from resignation:
	// nobody resigned, and the archive should say what happened.
	if history[0].EndReason != game.EndReasonAdjudication {
		t.Fatalf("expected an adjudication on record, got %q", history[0].EndReason)
	}
}

// A game that has not begun is holding both players' seeks in escrow, so it can
// only be voided — and voiding it has to give those seeks back.
func TestStoppingAnUnstartedGame(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	server := NewWithStoreAndAdminToken(data, nil, "test-secret")
	handler := server.Routes()

	// Seated through the pairing path, which is what creates the escrow.
	first := fakeClient(t, server, "one", false)
	second := fakeClient(t, server, "two", false)
	server.seatMatch(
		&startSeat{seek: seekForTest(first), requeue: true},
		&startSeat{seek: seekForTest(second), requeue: true},
	)
	server.mu.RLock()
	var session *GameSession
	for _, candidate := range server.games {
		session = candidate
	}
	server.mu.RUnlock()
	if session == nil {
		t.Fatal("expected a seated game")
	}

	// A declared result is refused: there are no moves to adjudicate, and
	// filing a rated win for a game nobody played would be worse than saying no.
	refused := tournamentRequest(
		t, handler, http.MethodPost,
		"/api/admin/live-games/"+session.gameID+"/stop",
		map[string]any{"outcome": "red", "reason": ""},
		"test-secret",
	)
	if refused.Code != http.StatusConflict {
		t.Fatalf("expected a result to be refused, got %d: %s", refused.Code, refused.Body)
	}

	voided := tournamentRequest(
		t, handler, http.MethodPost,
		"/api/admin/live-games/"+session.gameID+"/stop",
		map[string]any{"outcome": "void", "reason": ""},
		"test-secret",
	)
	if voided.Code != http.StatusOK {
		t.Fatalf("expected the void to succeed, got %d: %s", voided.Code, voided.Body)
	}
	if liveGameCount(t, handler) != 0 {
		t.Fatal("the unstarted board is still live")
	}
	// Both searches are back on the board. This is the assertion the whole
	// special case exists for: ending an unstarted game any other way loses two
	// people their place in the queue.
	if waiting := server.seeks.CountsByMode()[game.ModeTotalWar]; waiting != 2 {
		t.Fatalf("expected both seeks back in the queue, found %d", waiting)
	}
}

// Everything on this route is private.
func TestStoppingAGameNeedsTheAdminToken(t *testing.T) {
	_, handler, session := liveTestServer(t)
	response := tournamentRequest(
		t, handler, http.MethodPost,
		"/api/admin/live-games/"+session.gameID+"/stop",
		map[string]any{"outcome": "void", "reason": ""},
		"",
	)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without the token, got %d", response.Code)
	}
	if liveGameCount(t, handler) != 1 {
		t.Fatal("the game was stopped by an unauthorized request")
	}
}

// seekForTest is a matchmaking search, for the paths that need a real escrow
// rather than a directly seated game.
func seekForTest(client *Client) *Seek {
	seek := &Seek{
		ID:       "seek-" + client.profile.UserID,
		Owner:    seekOwnerKey(client),
		Poster:   client.profile,
		Setup:    game.GameSetup{ModeID: game.ModeTotalWar},
		ModeName: "Total War",
		Elo:      persistence.RatingFloor,
		Queued:   true,
	}
	seek.bind(client)
	return seek
}
