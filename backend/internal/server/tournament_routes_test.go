package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

func TestTournamentHTTPFlowAndAdminAuthentication(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	server := NewWithStoreAndAdminToken(data, []string{"https://rps.example"}, "test-secret")
	handler := server.Routes()

	unauthorized := tournamentRequest(
		t,
		handler,
		http.MethodPost,
		"/api/admin/tournaments",
		map[string]any{"name": "Autumn Open", "modeId": game.ModeTotalWar},
		"",
	)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized create, got %d: %s", unauthorized.Code, unauthorized.Body)
	}

	session := tournamentRequest(
		t, handler, http.MethodGet, "/api/admin/session", nil, "test-secret",
	)
	if session.Code != http.StatusOK {
		t.Fatalf("expected valid admin session, got %d: %s", session.Code, session.Body)
	}

	created := tournamentRequest(
		t,
		handler,
		http.MethodPost,
		"/api/admin/tournaments",
		map[string]any{"name": "Autumn Open", "modeId": game.ModeTotalWar},
		"test-secret",
	)
	if created.Code != http.StatusCreated {
		t.Fatalf("expected tournament creation, got %d: %s", created.Code, created.Body)
	}
	var tournament persistence.Tournament
	if err := json.NewDecoder(created.Body).Decode(&tournament); err != nil {
		t.Fatal(err)
	}
	if tournament.Name != "Autumn Open" || tournament.ModeID != game.ModeTotalWar {
		t.Fatalf("unexpected tournament: %#v", tournament)
	}

	for _, signup := range []map[string]any{
		{
			"userId": "first-user", "ign": "First", "discord": "first.discord",
			"agreedToUnfilteredChat": true,
		},
		{
			"userId": "second-user", "ign": "Second", "discord": "second.discord",
			"agreedToUnfilteredChat": true,
		},
	} {
		response := tournamentRequest(
			t,
			handler,
			http.MethodPost,
			"/api/tournaments/"+tournament.TournamentID+"/signups",
			signup,
			"",
		)
		if response.Code != http.StatusCreated {
			t.Fatalf("expected signup, got %d: %s", response.Code, response.Body)
		}
	}

	started := tournamentRequest(
		t,
		handler,
		http.MethodPost,
		"/api/admin/tournaments/"+tournament.TournamentID+"/start",
		nil,
		"test-secret",
	)
	if started.Code != http.StatusOK {
		t.Fatalf("expected start, got %d: %s", started.Code, started.Body)
	}
	if err := json.NewDecoder(started.Body).Decode(&tournament); err != nil {
		t.Fatal(err)
	}
	if tournament.Status != persistence.TournamentInProgress || len(tournament.Matches) != 1 {
		t.Fatalf("unexpected started tournament: %#v", tournament)
	}

	result := tournamentRequest(
		t,
		handler,
		http.MethodPatch,
		"/api/admin/tournaments/"+tournament.TournamentID+"/matches/"+
			strconv.FormatInt(tournament.Matches[0].MatchID, 10),
		map[string]any{"result": persistence.MatchPlayer1Win},
		"test-secret",
	)
	if result.Code != http.StatusOK {
		t.Fatalf("expected result update, got %d: %s", result.Code, result.Body)
	}
	if err := json.NewDecoder(result.Body).Decode(&tournament); err != nil {
		t.Fatal(err)
	}
	if tournament.Status != persistence.TournamentCompleted ||
		tournament.Standings[0].Wins != 1 || tournament.Standings[0].Points != 3 {
		t.Fatalf("unexpected completed tournament: %#v", tournament)
	}
}

func TestTournamentSignupReservedIdentitiesRequireSpecialToken(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	server := NewWithStoreAndAdminToken(data, nil, "special-secret")
	tournament, err := data.CreateTournament(
		t.Context(), "reserved-open", "Reserved Open", game.ModeAnnihilation, "Annihilation",
	)
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/tournaments/" + tournament.TournamentID + "/signups"
	body := map[string]any{
		"userId": "reserved-user", "ign": "WEBGOATGUY", "discord": "someone",
		"agreedToUnfilteredChat": true,
	}

	response := tournamentRequest(t, server.Routes(), http.MethodPost, path, body, "")
	if response.Code != http.StatusForbidden {
		t.Fatalf("expected reserved IGN to be rejected, got %d: %s", response.Code, response.Body)
	}
	body["reservationToken"] = "special-secret"
	response = tournamentRequest(t, server.Routes(), http.MethodPost, path, body, "")
	if response.Code != http.StatusCreated {
		t.Fatalf("expected special token to allow reserved IGN, got %d: %s", response.Code, response.Body)
	}
}

func TestTournamentCORSPreflightUsesConfiguredOrigins(t *testing.T) {
	data := mustTournamentStore(t)
	defer data.Close()
	server := NewWithStoreAndAdminToken(
		data,
		[]string{"https://rps.example"},
		"test-secret",
	)
	request := httptest.NewRequest(http.MethodOptions, "/api/tournaments", nil)
	request.Header.Set("Origin", "https://rps.example")
	recorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusNoContent ||
		recorder.Header().Get("Access-Control-Allow-Origin") != "https://rps.example" ||
		recorder.Header().Get("Access-Control-Allow-Headers") != "Authorization, Content-Type" {
		t.Fatalf("unexpected preflight response: code=%d headers=%v", recorder.Code, recorder.Header())
	}
}

func TestTournamentSignupRequiresChatAgreement(t *testing.T) {
	data := mustTournamentStore(t)
	defer data.Close()
	server := NewWithStoreAndAdminToken(data, nil, "test-secret")
	tournament, err := data.CreateTournament(
		t.Context(), "consent-cup", "Consent Cup", game.ModeTotalWar, "Total War",
	)
	if err != nil {
		t.Fatal(err)
	}
	response := tournamentRequest(
		t,
		server.Routes(),
		http.MethodPost,
		"/api/tournaments/"+tournament.TournamentID+"/signups",
		map[string]any{
			"userId": "no-consent", "ign": "NoConsent", "discord": "no.consent",
			"agreedToUnfilteredChat": false,
		},
		"",
	)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("expected consent validation, got %d: %s", response.Code, response.Body)
	}
}

func tournamentRequest(
	t *testing.T,
	handler http.Handler,
	method string,
	path string,
	body any,
	adminToken string,
) *httptest.ResponseRecorder {
	t.Helper()
	var encoded bytes.Buffer
	if body != nil {
		if err := json.NewEncoder(&encoded).Encode(body); err != nil {
			t.Fatal(err)
		}
	}
	request := httptest.NewRequest(method, path, &encoded)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if adminToken != "" {
		request.Header.Set("Authorization", "Bearer "+adminToken)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func mustTournamentStore(t *testing.T) *persistence.Store {
	t.Helper()
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	return data
}
