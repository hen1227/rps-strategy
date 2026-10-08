package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"rps-strategy/backend/internal/persistence"
)

func putStoreReview(
	t *testing.T,
	handler http.Handler,
	label string,
	body any,
) (persistence.StoreReviewReset, *httptest.ResponseRecorder) {
	t.Helper()
	recorder := tournamentRequest(
		t, handler, http.MethodPut, "/api/admin/store-review-accounts/"+label, body, adminRouteToken,
	)
	var reset persistence.StoreReviewReset
	if recorder.Code == http.StatusOK {
		if err := json.Unmarshal(recorder.Body.Bytes(), &reset); err != nil {
			t.Fatalf("decode reset: %v", err)
		}
	}
	return reset, recorder
}

func sessionRequest(
	t *testing.T,
	handler http.Handler,
	method string,
	path string,
	body string,
	token string,
) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		request.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder
}

func TestStoreReviewRoutesAreForAdministratorsOnly(t *testing.T) {
	server, _, _ := discordTestServer(t)
	handler := server.Routes()
	if listed := tournamentRequest(
		t, handler, http.MethodGet, "/api/admin/store-review-accounts", nil, "",
	); listed.Code != http.StatusUnauthorized {
		t.Fatalf("list without a token: %d", listed.Code)
	}
	if reset := tournamentRequest(
		t, handler, http.MethodPut, "/api/admin/store-review-accounts/apple",
		map[string]string{"username": "ReviewAda"}, "",
	); reset.Code != http.StatusUnauthorized {
		t.Fatalf("reset without a token: %d", reset.Code)
	}
}

// The whole of what a reviewer does with the account, through the routes they
// would reach: sign in with the password the store holds, press the Discord
// button, and be told no before they are sent anywhere.
func TestAStoreReviewAccountSignsInButCannotStartADiscordLink(t *testing.T) {
	server, _, _ := discordTestServer(t)
	handler := server.Routes()

	made, recorder := putStoreReview(t, handler, "apple", map[string]string{"username": "ReviewAda"})
	if recorder.Code != http.StatusOK {
		t.Fatalf("reset: %d %s", recorder.Code, recorder.Body)
	}
	if !made.Created || made.Password == "" {
		t.Fatalf("the first reset should hand back a password: %#v", made)
	}

	login := sessionRequest(t, handler, http.MethodPost, "/api/auth/login",
		`{"username":"ReviewAda","password":"`+made.Password+`"}`, "")
	if login.Code != http.StatusOK {
		t.Fatalf("login: %d %s", login.Code, login.Body)
	}
	var signedIn authResponse
	if err := json.Unmarshal(login.Body.Bytes(), &signedIn); err != nil {
		t.Fatal(err)
	}
	if signedIn.Token == "" || signedIn.Account.UserID != made.UserID {
		t.Fatalf("login reply: %#v", signedIn)
	}

	start := sessionRequest(t, handler, http.MethodPost, "/api/auth/discord/start",
		`{"returnTo":"`+discordTestReturn+`"}`, signedIn.Token)
	if start.Code != http.StatusForbidden {
		t.Fatalf("starting a Discord link should be refused, got %d %s", start.Code, start.Body)
	}
	if !strings.Contains(start.Body.String(),
		persistence.StoreReviewLinkRefusal(persistence.ProviderDiscord).Error()) {
		t.Fatalf("the refusal should say why: %s", start.Body)
	}
	if me := sessionRequest(
		t, handler, http.MethodGet, "/api/auth/me", "", signedIn.Token,
	); me.Code != http.StatusOK {
		t.Fatalf("the refusal should leave the session alone, got %d", me.Code)
	}

	// The reset before the next submission: same password, old device out.
	again, recorder := putStoreReview(t, handler, "apple", map[string]string{})
	if recorder.Code != http.StatusOK {
		t.Fatalf("second reset: %d %s", recorder.Code, recorder.Body)
	}
	if again.Password != "" || again.SessionsRevoked != 1 {
		t.Fatalf("second reset: %#v", again)
	}
	if me := sessionRequest(
		t, handler, http.MethodGet, "/api/auth/me", "", signedIn.Token,
	); me.Code != http.StatusUnauthorized {
		t.Fatalf("the reset should sign the old device out, got %d", me.Code)
	}

	listed := tournamentRequest(
		t, handler, http.MethodGet, "/api/admin/store-review-accounts", nil, adminRouteToken,
	)
	if listed.Code != http.StatusOK {
		t.Fatalf("list: %d %s", listed.Code, listed.Body)
	}
	var page struct {
		Accounts []persistence.StoreReviewAccount `json:"accounts"`
	}
	if err := json.Unmarshal(listed.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Accounts) != 1 || !page.Accounts[0].SignsIn ||
		page.Accounts[0].Username != "ReviewAda" {
		t.Fatalf("listing: %#v", page.Accounts)
	}
	if strings.Contains(listed.Body.String(), made.Password) {
		t.Fatal("the listing must never carry a password")
	}
}

func TestStoreReviewRoutesRefuseWhatTheStoreRefuses(t *testing.T) {
	server, data, _ := discordTestServer(t)
	handler := server.Routes()
	registeredSession(t, data, "real-player", "Taken")

	for _, refusal := range []struct {
		name  string
		label string
		body  any
		want  int
	}{
		{"a label that is not a word", "Apple", map[string]string{"username": "ReviewAda"}, http.StatusBadRequest},
		{"a first reset with no name", "apple", map[string]string{}, http.StatusBadRequest},
		{"a reserved name", "apple", map[string]string{"username": persistence.OwnerUsername}, http.StatusBadRequest},
		{"a field it does not know", "apple", map[string]any{"username": "ReviewAda", "password": "mine"}, http.StatusBadRequest},
		{"a player's name", "apple", map[string]string{"username": "Taken"}, http.StatusConflict},
	} {
		if _, recorder := putStoreReview(t, handler, refusal.label, refusal.body); recorder.Code != refusal.want {
			t.Errorf("%s: want %d, got %d %s", refusal.name, refusal.want, recorder.Code, recorder.Body)
		}
	}

	made, recorder := putStoreReview(t, handler, "apple", map[string]string{"username": "ReviewAda"})
	if recorder.Code != http.StatusOK {
		t.Fatalf("reset: %d %s", recorder.Code, recorder.Body)
	}
	promote := tournamentRequest(
		t, handler, http.MethodPatch, "/api/admin/accounts/"+made.UserID,
		map[string]bool{"isAdmin": true}, adminRouteToken,
	)
	if promote.Code != http.StatusConflict {
		t.Fatalf("promoting a review account should be refused, got %d %s", promote.Code, promote.Body)
	}
}

// The Account screen's "Link your Discord" prompt follows this route, and a
// store review account is the one it has to stay off: a reviewer would
// otherwise open the app to an ACTION NEEDED panel offering a link the server
// refuses. A legacy password account is the one the prompt is for.
func TestSignInMethodsKeepsTheLinkPromptOffAReviewAccount(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "methods.sqlite")
	server, data, _ := discordTestServerAt(t, databasePath)
	handler := server.Routes()

	methodsFor := func(token string) persistence.SignInMethods {
		t.Helper()
		recorder := sessionRequest(t, handler, http.MethodGet, "/api/auth/sign-in-methods", "", token)
		if recorder.Code != http.StatusOK {
			t.Fatalf("sign-in methods: %d %s", recorder.Code, recorder.Body)
		}
		var methods persistence.SignInMethods
		if err := json.Unmarshal(recorder.Body.Bytes(), &methods); err != nil {
			t.Fatal(err)
		}
		return methods
	}

	if unsigned := sessionRequest(
		t, handler, http.MethodGet, "/api/auth/sign-in-methods", "", "",
	); unsigned.Code != http.StatusUnauthorized {
		t.Fatalf("without a session: %d", unsigned.Code)
	}

	made, recorder := putStoreReview(t, handler, "apple", map[string]string{"username": "ReviewAda"})
	if recorder.Code != http.StatusOK {
		t.Fatalf("reset: %d %s", recorder.Code, recorder.Body)
	}
	reviewToken, err := data.CreateSession(t.Context(), made.UserID)
	if err != nil {
		t.Fatal(err)
	}
	if got := methodsFor(reviewToken); got.AwaitingLink || len(got.Methods) != 0 {
		t.Fatalf("a review account must not be asked to link: %#v", got)
	}

	if _, err := data.EnsureAccountWithProfileKey(
		t.Context(), "legacy", "Guest", routeTestProfileKey,
	); err != nil {
		t.Fatal(err)
	}
	seedLegacyPasswordAccount(t, databasePath, "legacy", "Ada")
	legacyToken, err := data.CreateSession(t.Context(), "legacy")
	if err != nil {
		t.Fatal(err)
	}
	if got := methodsFor(legacyToken); !got.AwaitingLink {
		t.Fatalf("a legacy password account should be asked to link: %#v", got)
	}
}
