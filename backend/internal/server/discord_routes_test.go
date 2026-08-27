package server

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"rps-strategy/backend/internal/persistence"
)

// A fake Discord, so the whole OAuth conversation is testable without leaving
// the process.
//
// It has to be an httptest *TLS* server reached through endpoint.Client():
// macOS ignores SSL_CERT_FILE, so the self-signed certificate is only trusted
// by the client httptest hands back. That is the reason discordAuth takes an
// injectable client and overridable endpoint URLs at all — retrofitting the
// seam later would have meant rewriting the handler.
type fakeDiscord struct {
	server   *httptest.Server
	identity discordIdentity
	// Recorded so the tests can assert the request was well formed rather than
	// merely successful.
	lastCode     string
	lastVerifier string
	lastRedirect string
	tokenCalls   int
	refuseToken  bool
}

func newFakeDiscord(t *testing.T) *fakeDiscord {
	t.Helper()
	fake := &fakeDiscord{
		identity: discordIdentity{
			ID: "80351110224678912", Username: "yuki", GlobalName: "Yuki",
		},
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /oauth2/token", func(writer http.ResponseWriter, request *http.Request) {
		fake.tokenCalls++
		if err := request.ParseForm(); err != nil {
			http.Error(writer, "bad form", http.StatusBadRequest)
			return
		}
		if _, _, ok := request.BasicAuth(); !ok {
			http.Error(writer, "no client credentials", http.StatusUnauthorized)
			return
		}
		fake.lastCode = request.Form.Get("code")
		fake.lastVerifier = request.Form.Get("code_verifier")
		fake.lastRedirect = request.Form.Get("redirect_uri")
		if fake.refuseToken {
			http.Error(writer, "invalid_grant", http.StatusBadRequest)
			return
		}
		writeJSON(writer, http.StatusOK, map[string]string{"access_token": "discord-access"})
	})
	mux.HandleFunc("GET /users/@me", func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer discord-access" {
			http.Error(writer, "unauthorized", http.StatusUnauthorized)
			return
		}
		writeJSON(writer, http.StatusOK, fake.identity)
	})
	fake.server = httptest.NewTLSServer(mux)
	t.Cleanup(fake.server.Close)
	return fake
}

const (
	discordTestReturn   = "https://rps.henhen1227.com"
	discordTestCallback = "https://api-rps.example/api/auth/discord/callback"
)

// discordTestServer wires a Server to the fake, the way production wires it to
// Discord. Poked directly rather than through a constructor, matching how the
// push tests reach their own sender.
func discordTestServer(t *testing.T) (*Server, *persistence.Store, *fakeDiscord) {
	t.Helper()
	return discordTestServerAt(t, ":memory:")
}

func discordTestServerAt(
	t *testing.T,
	databasePath string,
) (*Server, *persistence.Store, *fakeDiscord) {
	t.Helper()
	data, err := persistence.Open(databasePath)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = data.Close() })

	server := NewWithStoreAndAdminToken(data, nil, adminRouteToken)
	fake := newFakeDiscord(t)
	server.discord = &discordAuth{
		enabled:      true,
		clientID:     "client-id",
		clientSecret: "client-secret",
		redirectURL:  discordTestCallback,
		returnURLs:   []string{discordTestReturn},
		authorizeURL: fake.server.URL + "/oauth2/authorize",
		tokenURL:     fake.server.URL + "/oauth2/token",
		userURL:      fake.server.URL + "/users/@me",
		client:       fake.server.Client(),
	}
	return server, data, fake
}

// beginDiscordSignIn runs /start and returns the state Discord would echo back.
func beginDiscordSignIn(t *testing.T, server *Server, credential, userID string) string {
	t.Helper()
	body, err := json.Marshal(discordStartRequest{ReturnTo: discordTestReturn, UserID: userID})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(
		http.MethodPost, "/api/auth/discord/start", strings.NewReader(string(body)))
	if credential != "" {
		request.Header.Set("Authorization", "Bearer "+credential)
	}
	recorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("start: %d %s", recorder.Code, recorder.Body.String())
	}
	var reply discordStartReply
	if err := json.Unmarshal(recorder.Body.Bytes(), &reply); err != nil {
		t.Fatalf("decode start reply: %v", err)
	}
	parsed, err := url.Parse(reply.AuthorizeURL)
	if err != nil {
		t.Fatalf("authorize url: %v", err)
	}
	return parsed.Query().Get("state")
}

// followDiscordCallback plays Discord's redirect back and returns the ticket.
func followDiscordCallback(t *testing.T, server *Server, state string) (string, string) {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet,
		"/api/auth/discord/callback?code=the-code&state="+url.QueryEscape(state), nil)
	recorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusSeeOther {
		t.Fatalf("callback: %d %s", recorder.Code, recorder.Body.String())
	}
	location, err := url.Parse(recorder.Header().Get("Location"))
	if err != nil {
		t.Fatalf("callback location: %v", err)
	}
	if !strings.HasPrefix(recorder.Header().Get("Location"), discordTestReturn) {
		t.Fatalf("callback left the allowlist: %s", recorder.Header().Get("Location"))
	}
	query := location.Query()
	return query.Get("ticket"), query.Get("error")
}

func redeemDiscordTicket(t *testing.T, server *Server, ticket string) (discordExchangeReply, int) {
	t.Helper()
	body, err := json.Marshal(discordTicketRequest{Ticket: ticket})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(
		http.MethodPost, "/api/auth/discord/exchange", strings.NewReader(string(body)))
	recorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, request)
	var reply discordExchangeReply
	_ = json.Unmarshal(recorder.Body.Bytes(), &reply)
	return reply, recorder.Code
}

func completeDiscordSignup(
	t *testing.T, server *Server, ticket, username, reservation string,
) (discordExchangeReply, int) {
	t.Helper()
	body, err := json.Marshal(discordCompleteRequest{
		Ticket: ticket, Username: username, ReservationToken: reservation,
	})
	if err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(
		http.MethodPost, "/api/auth/discord/complete", strings.NewReader(string(body)))
	recorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, request)
	var reply discordExchangeReply
	_ = json.Unmarshal(recorder.Body.Bytes(), &reply)
	return reply, recorder.Code
}

func TestDiscordSignInCreatesAnAccountAndSession(t *testing.T) {
	server, data, fake := discordTestServer(t)

	state := beginDiscordSignIn(t, server, "", "")
	ticket, refusal := followDiscordCallback(t, server, state)
	if refusal != "" || ticket == "" {
		t.Fatalf("callback returned error=%q ticket=%q", refusal, ticket)
	}
	// The exchange must have been a proper PKCE one against our own redirect
	// URI, not merely something that returned 200.
	if fake.lastCode != "the-code" || fake.lastVerifier == "" {
		t.Fatalf("token exchange was malformed: code=%q verifier=%q",
			fake.lastCode, fake.lastVerifier)
	}
	if fake.lastRedirect != discordTestCallback {
		t.Fatalf("redirect_uri was %q, want the configured one", fake.lastRedirect)
	}

	reply, status := redeemDiscordTicket(t, server, ticket)
	if status != http.StatusOK {
		t.Fatalf("exchange: %d", status)
	}
	if !reply.NeedsUsername {
		t.Fatal("a first sign-in must ask for a username before an account exists")
	}
	if reply.SuggestedUsername != "Yuki" {
		t.Fatalf("suggestion was %q, want it derived from the Discord name", reply.SuggestedUsername)
	}
	// Nothing is written until the name is agreed, so an abandoned signup
	// leaves no half-built account and no squatted username.
	if _, err := data.AccountForDiscordIdentity(t.Context(), fake.identity.ID); err == nil {
		t.Fatal("an account existed before the username was chosen")
	}

	done, status := completeDiscordSignup(t, server, ticket, "Yuki", "")
	if status != http.StatusOK {
		t.Fatalf("complete: %d", status)
	}
	if done.Token == "" || done.Account == nil {
		t.Fatalf("complete returned no session: %+v", done)
	}
	if !strings.HasPrefix(done.Token, persistence.SessionTokenPrefix) {
		t.Fatalf("session token has the wrong shape: %q", done.Token)
	}
	if !done.Account.Registered || !done.Account.DiscordVerified {
		t.Fatalf("new account is not fully registered: %+v", done.Account)
	}
	if done.Account.Discord != "yuki" {
		t.Fatalf("stored handle is %q, want the Discord username", done.Account.Discord)
	}
}

func TestDiscordSignInReturnsTheSameAccountNextTime(t *testing.T) {
	server, _, _ := discordTestServer(t)

	state := beginDiscordSignIn(t, server, "", "")
	ticket, _ := followDiscordCallback(t, server, state)
	redeemDiscordTicket(t, server, ticket)
	first, _ := completeDiscordSignup(t, server, ticket, "Yuki", "")

	// Second time round there is no username step: the identity is known.
	state = beginDiscordSignIn(t, server, "", "")
	ticket, _ = followDiscordCallback(t, server, state)
	second, status := redeemDiscordTicket(t, server, ticket)
	if status != http.StatusOK {
		t.Fatalf("second exchange: %d", status)
	}
	if second.NeedsUsername {
		t.Fatal("a returning player was asked to pick a username again")
	}
	if second.Account == nil || second.Account.UserID != first.Account.UserID {
		t.Fatalf("signed into a different account: %+v vs %+v", second.Account, first.Account)
	}
}

func TestDiscordSignInUpgradesTheAnonymousAccountThatProvedItself(t *testing.T) {
	server, data, _ := discordTestServer(t)

	// A guest with history worth keeping.
	if _, err := data.EnsureAccountWithProfileKey(
		t.Context(), "guest-1", "Guest", routeTestProfileKey,
	); err != nil {
		t.Fatal(err)
	}

	state := beginDiscordSignIn(t, server, routeTestProfileKey, "guest-1")
	ticket, _ := followDiscordCallback(t, server, state)
	redeemDiscordTicket(t, server, ticket)
	done, status := completeDiscordSignup(t, server, ticket, "Yuki", "")
	if status != http.StatusOK {
		t.Fatalf("complete: %d", status)
	}
	if done.Account.UserID != "guest-1" {
		t.Fatalf("the guest account was abandoned rather than upgraded: %q", done.Account.UserID)
	}
}

func TestDiscordSignInIgnoresAProfileKeyThatDoesNotMatch(t *testing.T) {
	server, data, _ := discordTestServer(t)
	if _, err := data.EnsureAccountWithProfileKey(
		t.Context(), "victim", "Guest", routeTestProfileKey,
	); err != nil {
		t.Fatal(err)
	}

	// Somebody who read the user ID off a live-game listing and guessed a key.
	const attackerKey = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
	body := `{"returnTo":"` + discordTestReturn + `","userId":"victim"}`
	request := httptest.NewRequest(
		http.MethodPost, "/api/auth/discord/start", strings.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+attackerKey)
	recorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, request)

	// Refused outright rather than quietly downgraded to "make a new account":
	// silently handing somebody a second account is how a player loses their
	// history without ever being told anything went wrong.
	if recorder.Code != http.StatusUnauthorized {
		t.Fatalf("a bad profile key was accepted: %d %s", recorder.Code, recorder.Body.String())
	}
}

// seedLegacyPasswordAccount makes the one thing nothing can make any more: an
// account whose only credential is a password.
//
// Written through a second connection to the same file rather than through the
// store, because there is deliberately no exported way to create one. Keeping
// a production function alive purely so a test could call it would leave the
// door this change exists to close standing open. The hash is a placeholder —
// this test never signs in with it, it only needs the account to read as
// registered-without-an-identity, which is the shape the link path is for.
// Whether the password actually stops working is settled in the persistence
// suite, where a real derivation is available.
func seedLegacyPasswordAccount(t *testing.T, databasePath, userID, username string) {
	t.Helper()
	database, err := sql.Open("sqlite", databasePath)
	if err != nil {
		t.Fatalf("open database directly: %v", err)
	}
	defer func() { _ = database.Close() }()
	if _, err := database.ExecContext(t.Context(), `
UPDATE accounts
SET username = ?, username_lower = ?, password_hash = 'legacy-placeholder-hash',
    password_algorithm = 'pbkdf2-sha256', password_iterations = 1
WHERE user_id = ?
`, username, strings.ToLower(username), userID); err != nil {
		t.Fatalf("seed legacy account: %v", err)
	}
}

func TestLinkingDiscordFromASessionKeepsTheAccountAndItsName(t *testing.T) {
	databasePath := filepath.Join(t.TempDir(), "legacy.sqlite")
	server, data, _ := discordTestServerAt(t, databasePath)

	if _, err := data.EnsureAccountWithProfileKey(
		t.Context(), "legacy", "Guest", routeTestProfileKey,
	); err != nil {
		t.Fatal(err)
	}
	seedLegacyPasswordAccount(t, databasePath, "legacy", "Ada")
	token, err := data.CreateSession(t.Context(), "legacy")
	if err != nil {
		t.Fatal(err)
	}

	state := beginDiscordSignIn(t, server, token, "")
	ticket, _ := followDiscordCallback(t, server, state)
	reply, status := redeemDiscordTicket(t, server, ticket)
	if status != http.StatusOK {
		t.Fatalf("exchange: %d", status)
	}
	// A legacy account already has a name, so linking never asks for one.
	if reply.NeedsUsername {
		t.Fatal("linking asked an established account to pick a new username")
	}
	if reply.Account == nil || reply.Account.Username != "Ada" {
		t.Fatalf("linking changed the account: %+v", reply.Account)
	}
	if !reply.Account.DiscordVerified {
		t.Fatal("linking did not record the identity")
	}
	if reply.Account.UserID != "legacy" {
		t.Fatalf("linking moved the player to a different account: %q", reply.Account.UserID)
	}
	if reply.Token == "" {
		t.Fatal("linking did not hand back a session")
	}
}

func TestDiscordTicketIsSingleUse(t *testing.T) {
	server, _, _ := discordTestServer(t)

	state := beginDiscordSignIn(t, server, "", "")
	ticket, _ := followDiscordCallback(t, server, state)
	redeemDiscordTicket(t, server, ticket)
	if _, status := completeDiscordSignup(t, server, ticket, "Yuki", ""); status != http.StatusOK {
		t.Fatalf("first completion: %d", status)
	}
	// Replaying it must not mint a second session.
	if _, status := completeDiscordSignup(t, server, ticket, "Yuki", ""); status != http.StatusUnauthorized {
		t.Fatalf("a spent ticket was accepted again: %d", status)
	}
}

func TestDiscordStateIsSingleUse(t *testing.T) {
	server, _, _ := discordTestServer(t)

	state := beginDiscordSignIn(t, server, "", "")
	if _, refusal := followDiscordCallback(t, server, state); refusal != "" {
		t.Fatalf("first callback failed: %s", refusal)
	}
	request := httptest.NewRequest(http.MethodGet,
		"/api/auth/discord/callback?code=the-code&state="+url.QueryEscape(state), nil)
	recorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, request)
	if !strings.Contains(recorder.Header().Get("Location"), "error=expired") {
		t.Fatalf("a replayed state was accepted: %s", recorder.Header().Get("Location"))
	}
}

// The open-redirect guard. Without it, an authenticated endpoint on this
// server becomes a way to bounce somebody anywhere.
func TestDiscordStartRefusesAReturnAddressOffTheAllowlist(t *testing.T) {
	server, _, _ := discordTestServer(t)

	for _, hostile := range []string{
		"https://evil.test",
		// The reason the allowlist match requires a separator rather than a
		// bare prefix.
		discordTestReturn + ".evil.test",
		"",
	} {
		body, err := json.Marshal(discordStartRequest{ReturnTo: hostile})
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(
			http.MethodPost, "/api/auth/discord/start", strings.NewReader(string(body)))
		recorder := httptest.NewRecorder()
		server.Routes().ServeHTTP(recorder, request)
		if recorder.Code != http.StatusBadRequest {
			t.Errorf("return address %q was accepted: %d", hostile, recorder.Code)
		}
	}
}

func TestDiscordCompleteRefusesAReservedUsernameWithoutTheHostToken(t *testing.T) {
	server, _, _ := discordTestServer(t)

	state := beginDiscordSignIn(t, server, "", "")
	ticket, _ := followDiscordCallback(t, server, state)
	redeemDiscordTicket(t, server, ticket)

	// Holding the owner handle *is* the admin check, so the door that grants it
	// has to keep asking for the host token — registration used to, and this is
	// the door that replaced it.
	if _, status := completeDiscordSignup(
		t, server, ticket, persistence.OwnerUsername, "",
	); status != http.StatusForbidden {
		t.Fatalf("the owner handle was claimable without the host token: %d", status)
	}
	done, status := completeDiscordSignup(
		t, server, ticket, persistence.OwnerUsername, adminRouteToken)
	if status != http.StatusOK {
		t.Fatalf("the host token should claim the owner handle: %d", status)
	}
	if !done.Account.IsAdmin {
		t.Fatal("claiming the owner handle through Discord did not grant admin")
	}
}

func TestDiscordStartIsRefusedWhenUnconfigured(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = data.Close() })

	// A fresh checkout with no Discord application: the route says so plainly
	// rather than failing somewhere further in.
	body := `{"returnTo":"https://rps.henhen1227.com"}`
	request := httptest.NewRequest(
		http.MethodPost, "/api/auth/discord/start", strings.NewReader(body))
	recorder := httptest.NewRecorder()
	NewWithStore(data, nil).Routes().ServeHTTP(recorder, request)
	if recorder.Code != http.StatusServiceUnavailable {
		t.Fatalf("unconfigured start returned %d, want 503", recorder.Code)
	}
}

func TestDiscordCallbackSurvivesDiscordRefusingTheCode(t *testing.T) {
	server, _, fake := discordTestServer(t)
	fake.refuseToken = true

	state := beginDiscordSignIn(t, server, "", "")
	request := httptest.NewRequest(http.MethodGet,
		"/api/auth/discord/callback?code=the-code&state="+url.QueryEscape(state), nil)
	recorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, request)

	// A browser is on the other end of this, so even a failure has to land
	// somewhere a person can read.
	location := recorder.Header().Get("Location")
	if !strings.HasPrefix(location, discordTestReturn) ||
		!strings.Contains(location, "error=") {
		t.Fatalf("a failed exchange did not redirect home with an error: %q", location)
	}
}

func TestDiscordCallbackReportsACancelledConsent(t *testing.T) {
	server, _, _ := discordTestServer(t)

	state := beginDiscordSignIn(t, server, "", "")
	request := httptest.NewRequest(http.MethodGet,
		"/api/auth/discord/callback?error=access_denied&state="+url.QueryEscape(state), nil)
	recorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, request)
	if !strings.Contains(recorder.Header().Get("Location"), "error=access_denied") {
		t.Fatalf("pressing Cancel was not reported: %q", recorder.Header().Get("Location"))
	}
}
