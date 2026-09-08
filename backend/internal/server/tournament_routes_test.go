package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
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
	// A new event is a draft, so it is not on the public board and takes no
	// signups until it is published. Both halves are asserted here because this
	// test is the one that walks the whole lifecycle.
	if tournament.Status != persistence.TournamentDraft {
		t.Fatalf("a new tournament should be a draft, got %q", tournament.Status)
	}
	board := tournamentRequest(t, handler, http.MethodGet, "/api/tournaments", nil, "")
	if strings.Contains(board.Body.String(), tournament.TournamentID) {
		t.Fatalf("a draft appeared on the public board: %s", board.Body)
	}
	early := tournamentRequest(
		t,
		handler,
		http.MethodPost,
		"/api/tournaments/"+tournament.TournamentID+"/signups",
		map[string]any{
			"userId": "eager", "ign": "Eager", "discord": "eager.discord",
			"agreedToUnfilteredChat": true,
		},
		"",
	)
	if early.Code != http.StatusConflict {
		t.Fatalf("expected a draft to refuse signups, got %d: %s", early.Code, early.Body)
	}

	published := tournamentRequest(
		t,
		handler,
		http.MethodPost,
		"/api/admin/tournaments/"+tournament.TournamentID+"/publish",
		nil,
		"test-secret",
	)
	if published.Code != http.StatusOK {
		t.Fatalf("expected publication, got %d: %s", published.Code, published.Body)
	}
	if err := json.NewDecoder(published.Body).Decode(&tournament); err != nil {
		t.Fatal(err)
	}
	if tournament.Status != persistence.TournamentRegistration {
		t.Fatalf("expected registration after publishing, got %q", tournament.Status)
	}

	verifiedEntrants(t, data, "first-user", "second-user")
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
	tournament := openTournament(
		t, data, "reserved-open", "Reserved Open", game.ModeTotalWar, "Total War",
	)
	verifiedEntrants(t, data, "reserved-user")
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
	tournament := openTournament(
		t, data, "consent-cup", "Consent Cup", game.ModeTotalWar, "Total War",
	)
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

// Verification is unconditional, and the refusal comes back as a forbidden
// rather than as a validation failure — the caller has to be able to tell "link
// your Discord" from "you typed something wrong".
func TestAnUnverifiedSignupIsForbidden(t *testing.T) {
	data := mustTournamentStore(t)
	defer data.Close()
	server := NewWithStoreAndAdminToken(data, nil, "test-secret")
	handler := server.Routes()

	created := tournamentRequest(
		t, handler, http.MethodPost, "/api/admin/tournaments",
		map[string]any{"name": "Autumn Open", "modeId": game.ModeTotalWar},
		"test-secret",
	)
	if created.Code != http.StatusCreated {
		t.Fatalf("expected creation, got %d: %s", created.Code, created.Body)
	}
	var tournament persistence.Tournament
	if err := json.NewDecoder(created.Body).Decode(&tournament); err != nil {
		t.Fatal(err)
	}
	if published := tournamentRequest(
		t, handler, http.MethodPost,
		"/api/admin/tournaments/"+tournament.TournamentID+"/publish", nil, "test-secret",
	); published.Code != http.StatusOK {
		t.Fatalf("expected publication, got %d: %s", published.Code, published.Body)
	}

	signup := func(userID string, ign string) *httptest.ResponseRecorder {
		return tournamentRequest(
			t, handler, http.MethodPost,
			"/api/tournaments/"+tournament.TournamentID+"/signups",
			map[string]any{
				"userId": userID, "ign": ign, "discord": "typed.handle",
				"agreedToUnfilteredChat": true,
			},
			"",
		)
	}

	if refused := signup("unverified", "Ada"); refused.Code != http.StatusForbidden {
		t.Fatalf("expected an unverified signup to be forbidden, got %d: %s",
			refused.Code, refused.Body)
	}

	registeredSession(t, data, "verified", "Babbage")
	entered := signup("verified", "Babbage")
	if entered.Code != http.StatusCreated {
		t.Fatalf("expected a verified signup to be admitted, got %d: %s",
			entered.Code, entered.Body)
	}
	// And the stored handle is the one Discord vouched for, not the typed one.
	if err := json.NewDecoder(entered.Body).Decode(&tournament); err != nil {
		t.Fatal(err)
	}
	if len(tournament.Players) != 1 || tournament.Players[0].Discord != "Babbage" {
		t.Fatalf("expected the verified handle on the entry, got %#v", tournament.Players)
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
