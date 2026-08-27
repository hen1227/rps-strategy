package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

func leaderboardTestStore(t *testing.T) *persistence.Store {
	t.Helper()
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = data.Close() })
	return data
}

// winFor plays a game to a resignation so the winner has a tested rating. The
// ladder reads records, and a record has to come from somewhere.
func winFor(t *testing.T, winnerID string, winnerName string) game.GameState {
	t.Helper()
	played, err := game.NewGame(
		"lb-"+winnerID,
		game.ModeTotalWar,
		game.PlayerProfile{UserID: winnerID, Username: winnerName},
		game.PlayerProfile{UserID: "rival-" + winnerID, Username: "Rival"},
	)
	if err != nil {
		t.Fatal(err)
	}
	state, err := played.Resign(game.Blue)
	if err != nil {
		t.Fatal(err)
	}
	return state
}

func getLeaderboardRows(t *testing.T, handler http.Handler, target string) []persistence.LeaderboardEntry {
	t.Helper()
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, target, nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("GET %s: %d %s", target, recorder.Code, recorder.Body.String())
	}
	var rows []persistence.LeaderboardEntry
	if err := json.Unmarshal(recorder.Body.Bytes(), &rows); err != nil {
		t.Fatalf("decode leaderboard: %v", err)
	}
	return rows
}

func TestLeaderboardRouteServesBothBoards(t *testing.T) {
	data := leaderboardTestStore(t)
	handler := NewWithStore(data, nil).Routes()
	registeredSession(t, data, "ada", "Ada")

	// A registered player with a tested rating belongs on the board.
	finishedAt := time.Date(2026, time.August, 23, 12, 0, 0, 0, time.UTC)
	if _, err := data.RecordCompletedGame(
		t.Context(), winFor(t, "ada", "Ada"), finishedAt.Add(-time.Minute), finishedAt, true,
	); err != nil {
		t.Fatalf("record game: %v", err)
	}

	rows := getLeaderboardRows(t, handler, "/api/leaderboard")
	if len(rows) == 0 {
		t.Fatal("expected the winner on the board")
	}
	if rows[0].Username != "Ada" || rows[0].Rank != 1 {
		t.Fatalf("expected Ada first: %#v", rows)
	}
	// Rival was created by the game record itself and never registered, so it is
	// a Guest as far as the ladder is concerned.
	for _, row := range rows {
		if row.Username == "Rival" {
			t.Fatalf("an unregistered account must not be on the human board: %#v", rows)
		}
	}

	// The bot board is a different population, not a filter on the same rows.
	if rows := getLeaderboardRows(t, handler, "/api/leaderboard?kind=bot"); len(rows) != 0 {
		t.Fatalf("no bots have played: %#v", rows)
	}
}

func TestLeaderboardRouteRejectsNonsenseFilters(t *testing.T) {
	handler := NewWithStore(leaderboardTestStore(t), nil).Routes()

	for _, target := range []string{
		"/api/leaderboard?mode=NOPE",
		"/api/leaderboard?kind=wizard",
		"/api/leaderboard?limit=-1",
	} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, target, nil))
		// An unknown mode must not answer with an empty board: an empty board
		// reads as "nobody has played this yet", and a typo should not be able
		// to say that.
		if recorder.Code != http.StatusBadRequest {
			t.Fatalf("GET %s: expected 400, got %d", target, recorder.Code)
		}
	}

	// A real mode with no games is a legitimately empty board.
	rows := getLeaderboardRows(t, handler, "/api/leaderboard?mode="+string(game.ModeTotalWar))
	if len(rows) != 0 {
		t.Fatalf("expected an empty board: %#v", rows)
	}
}

func TestAdminSessionWorksWithoutAHostToken(t *testing.T) {
	data := leaderboardTestStore(t)
	server := NewWithStore(data, nil)
	handler := server.Routes()
	// No SetAdminToken call: this is a deployment with RPS_ADMIN_TOKEN unset,
	// which used to answer 503 to everybody including real administrators.
	token := registeredSession(t, data, "root", "Root")
	if err := data.SetAccountAdmin(t.Context(), "root", true); err != nil {
		t.Fatalf("promote: %v", err)
	}

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/api/admin/session", nil)
	request.Header.Set("Authorization", "Bearer "+token)
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("an isAdmin session must reach admin routes: %d %s",
			recorder.Code, recorder.Body.String())
	}

	// Everyone else still gets the honest answer that no shared token exists.
	plain := registeredSession(t, data, "player", "Player")
	recorder = httptest.NewRecorder()
	request = httptest.NewRequest(http.MethodGet, "/api/admin/session", nil)
	request.Header.Set("Authorization", "Bearer "+plain)
	handler.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 for a non-administrator on an unconfigured server, got %d",
			recorder.Code)
	}
}
