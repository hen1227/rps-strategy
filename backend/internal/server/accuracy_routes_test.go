package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

const testProfileKey = "0123456789abcdef0123456789abcdef0123456789abcdef"

// claimAccount gives an account the key its browser would have created, the
// way connecting or editing the profile does.
func claimAccount(t *testing.T, data *persistence.Store, userID string) {
	t.Helper()
	if _, err := data.EnsureAccountWithProfileKey(t.Context(), userID, userID, testProfileKey); err != nil {
		t.Fatal(err)
	}
}

// archiveOneGame plays a one-move game to completion so there is a stored
// record for a review to attach itself to.
func archiveOneGame(t *testing.T, server *Server, data *persistence.Store) string {
	t.Helper()
	clients := archiveTestClients(t, data, "accuracy-red", "accuracy-blue")
	redClient, blueClient := clients[0], clients[1]
	startArchiveTestMatch(server, redClient, blueClient, game.ModeInfiltration)
	_ = readClientMessage(t, redClient)
	_ = readClientMessage(t, blueClient)
	gameID := server.participantFor(redClient).session.gameID
	server.resign(blueClient)
	return gameID
}

func accuracyBody(color game.PlayerColor, accuracy float64) string {
	return `{"color":"` + string(color) + `","accuracy":` +
		strings.TrimRight(strings.TrimRight(formatFloat(accuracy), "0"), ".") +
		`,"averageLossPercent":4.2,"averageLossCentipawns":31,"moveCount":12,` +
		`"grades":{"best":5,"excellent":3,"good":2,"inaccuracy":1,"mistake":1,"blunder":0},` +
		`"engine":{"preset":"standard","maxDepth":9,"maxNodes":700000,"maxTimeMs":2000,"variations":3}}`
}

func formatFloat(value float64) string {
	return strings.TrimSuffix(strings.TrimSpace(jsonNumber(value)), "\n")
}

func jsonNumber(value float64) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func putAccuracy(t *testing.T, server *Server, gameID, key, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(
		http.MethodPut,
		"/api/games/"+gameID+"/accuracy",
		strings.NewReader(body),
	)
	if key != "" {
		request.Header.Set("Authorization", "Bearer "+key)
	}
	recorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, request)
	return recorder
}

func TestAccuracyIsStoredWithTheGameAndReadBack(t *testing.T) {
	server, data := archiveTestServer(t)
	gameID := archiveOneGame(t, server, data)
	claimAccount(t, data, "accuracy-red")

	recorder := putAccuracy(t, server, gameID, testProfileKey, accuracyBody(game.Red, 87.5))
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body)
	}

	stored, err := data.GameAccuracies(t.Context(), gameID)
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 1 {
		t.Fatalf("expected one stored review, got %d", len(stored))
	}
	if stored[0].Color != game.Red || stored[0].UserID != "accuracy-red" {
		t.Fatalf("the review was attributed to the wrong player: %#v", stored[0])
	}
	if stored[0].Accuracy != 87.5 || stored[0].MoveCount != 12 || stored[0].EngineMaxDepth != 9 {
		t.Fatalf("the review did not survive the round trip: %#v", stored[0])
	}

	// The game carries its reviews, so a client that already has the record
	// does not need a second request to know it was reviewed.
	recorder = httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, httptest.NewRequest(
		http.MethodGet, "/api/games/"+gameID+"/pgn?format=json", nil,
	))
	var archived persistence.ArchivedGame
	if err := json.NewDecoder(recorder.Body).Decode(&archived); err != nil {
		t.Fatal(err)
	}
	if len(archived.Accuracy) != 1 || archived.Accuracy[0].Accuracy != 87.5 {
		t.Fatalf("the archived game does not carry its review: %#v", archived.Accuracy)
	}

	recorder = httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, httptest.NewRequest(
		http.MethodGet, "/api/games/"+gameID+"/accuracy", nil,
	))
	var listed []persistence.GameAccuracy
	if err := json.NewDecoder(recorder.Body).Decode(&listed); err != nil {
		t.Fatal(err)
	}
	if len(listed) != 1 || listed[0].GameID != gameID {
		t.Fatalf("unexpected accuracy list: %#v", listed)
	}
}

// Reviewing again replaces the previous number rather than being ignored: a
// deeper review of the same game should be able to correct a shallower one.
func TestReviewingAgainReplacesTheStoredAccuracy(t *testing.T) {
	server, data := archiveTestServer(t)
	gameID := archiveOneGame(t, server, data)
	claimAccount(t, data, "accuracy-red")

	putAccuracy(t, server, gameID, testProfileKey, accuracyBody(game.Red, 61))
	putAccuracy(t, server, gameID, testProfileKey, accuracyBody(game.Red, 74.25))

	stored, err := data.GameAccuracies(t.Context(), gameID)
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 1 || stored[0].Accuracy != 74.25 {
		t.Fatalf("expected the later review to win: %#v", stored)
	}
}

func TestOnlyThatPlayerCanRecordTheirAccuracy(t *testing.T) {
	server, data := archiveTestServer(t)
	gameID := archiveOneGame(t, server, data)
	claimAccount(t, data, "accuracy-red")

	if recorder := putAccuracy(t, server, gameID, "", accuracyBody(game.Red, 90)); recorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without a key, got %d", recorder.Code)
	}

	// Red's key cannot report Blue's accuracy, which is the whole point of
	// deriving the account from the game rather than from the request.
	claimAccount(t, data, "accuracy-blue")
	if recorder := putAccuracy(t, server, gameID, strings.Repeat("f", len(testProfileKey)), accuracyBody(game.Blue, 90)); recorder.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for the wrong key, got %d", recorder.Code)
	}

	if recorder := putAccuracy(t, server, "no-such-game", testProfileKey, accuracyBody(game.Red, 90)); recorder.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for an unknown game, got %d", recorder.Code)
	}

	body := `{"color":"Neutral","accuracy":50,"moveCount":3}`
	if recorder := putAccuracy(t, server, gameID, testProfileKey, body); recorder.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for a colour nobody played, got %d", recorder.Code)
	}

	stored, err := data.GameAccuracies(t.Context(), gameID)
	if err != nil {
		t.Fatal(err)
	}
	if len(stored) != 0 {
		t.Fatalf("a rejected report was stored anyway: %#v", stored)
	}
}

func TestAccuracyRejectsImpossibleNumbers(t *testing.T) {
	server, data := archiveTestServer(t)
	gameID := archiveOneGame(t, server, data)
	claimAccount(t, data, "accuracy-red")
	for _, body := range []string{
		`{"color":"Red","accuracy":140,"moveCount":4}`,
		`{"color":"Red","accuracy":-1,"moveCount":4}`,
		`{"color":"Red","accuracy":50,"moveCount":0}`,
	} {
		if recorder := putAccuracy(t, server, gameID, testProfileKey, body); recorder.Code != http.StatusBadRequest {
			t.Fatalf("expected 400 for %s, got %d", body, recorder.Code)
		}
	}
}
