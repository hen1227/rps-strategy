package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

const (
	routeTestProfileKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	routeTestPassword   = "a-good-long-password"
)

// registeredSession is the state most account routes now require: a real
// account, upgraded from an anonymous one exactly as a player's would be, and
// signed in.
func registeredSession(
	t *testing.T,
	data *persistence.Store,
	userID string,
	username string,
) string {
	t.Helper()
	if _, err := data.EnsureAccountWithProfileKey(
		t.Context(), userID, "Guest", routeTestProfileKey,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := data.ClaimAccountWithDiscord(
		t.Context(), userID, username, "discord-"+userID, username,
	); err != nil {
		t.Fatal(err)
	}
	token, err := data.CreateSession(t.Context(), userID)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

func TestAccountProfileUpdateRequiresYourOwnSession(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	token := registeredSession(t, data, "settings-user", "SettingsUser")
	handler := NewWithStore(data, nil).Routes()
	body := map[string]any{"username": "SettingsPlayer", "discord": "settings.player"}
	const path = "/api/accounts/settings-user"

	missing := tournamentRequest(t, handler, http.MethodPatch, path, body, "")
	if missing.Code != http.StatusUnauthorized {
		t.Fatalf("expected an unauthenticated edit to be rejected, got %d: %s", missing.Code, missing.Body)
	}

	// The browser's local key still opens a game socket. It no longer opens a
	// profile, because an unregistered account has no name to edit.
	key := tournamentRequest(t, handler, http.MethodPatch, path, body, routeTestProfileKey)
	if key.Code != http.StatusUnauthorized {
		t.Fatalf("expected a profile key to be rejected, got %d: %s", key.Code, key.Body)
	}

	stranger := registeredSession(t, data, "other-user", "OtherUser")
	borrowed := tournamentRequest(t, handler, http.MethodPatch, path, body, stranger)
	if borrowed.Code != http.StatusForbidden {
		t.Fatalf("expected another account's session to be rejected, got %d: %s", borrowed.Code, borrowed.Body)
	}

	updated := tournamentRequest(t, handler, http.MethodPatch, path, body, token)
	if updated.Code != http.StatusOK {
		t.Fatalf("expected profile update, got %d: %s", updated.Code, updated.Body)
	}
	var account persistence.Account
	if err := json.NewDecoder(updated.Body).Decode(&account); err != nil {
		t.Fatal(err)
	}
	// The username, not the handle: this account signed in with Discord, so its
	// handle came from there and the route ignores what the body says about it.
	// That rule has its own test — TestAVerifiedDiscordHandleIsNotEditable.
	if account.Username != "SettingsPlayer" {
		t.Fatalf("unexpected profile response: %#v", account)
	}
}

func TestAccountProfileReservedIdentitiesRequireSpecialToken(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	handler := NewWithStoreAndAdminToken(data, nil, "special-secret").Routes()

	// One account per case. Claiming the owner handle makes that account an
	// administrator, and an administrator is allowed reserved names without the
	// token — so a second case run on the same account would be testing the
	// wrong door.
	//
	// Only usernames appear here now. The Discord handle used to be checked by
	// the same rule, back when it was free text; a verified one cannot be
	// forged, so reserving it would prevent nothing while locking out any real
	// Discord user whose handle happened to match. The typed handle is still
	// reserved where it is still typed — tournament signup.
	for index, body := range []map[string]any{
		{"username": "hEnHeN1227", "discord": "someone"},
		{"username": "WebGoatGuy", "discord": "someone"},
	} {
		userID := fmt.Sprintf("reserved-user-%d", index)
		token := registeredSession(t, data, userID, fmt.Sprintf("ReservedUser%d", index))
		path := "/api/accounts/" + userID

		response := tournamentRequest(t, handler, http.MethodPatch, path, body, token)
		if response.Code != http.StatusForbidden {
			t.Fatalf("expected reserved identity to be rejected, got %d: %s", response.Code, response.Body)
		}
		body["reservationToken"] = "special-secret"
		response = tournamentRequest(t, handler, http.MethodPatch, path, body, token)
		if response.Code != http.StatusOK {
			t.Fatalf("expected special token to allow reserved identity, got %d: %s", response.Code, response.Body)
		}
	}
}

// A handle Discord vouched for belongs to Discord, so the profile route may not
// take a new one from the request body. Ignored rather than refused: a client
// that read the account and PATCHed it back unchanged would otherwise fail on a
// field it never touched.
func TestAVerifiedDiscordHandleIsNotEditable(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	handler := NewWithStore(data, nil).Routes()

	token := registeredSession(t, data, "linked-user", "Yuki")
	response := tournamentRequest(t, handler, http.MethodPatch, "/api/accounts/linked-user",
		map[string]any{"username": "YukiRenamed", "discord": "not-my-handle"}, token)
	if response.Code != http.StatusOK {
		t.Fatalf("the rename was refused: %d %s", response.Code, response.Body)
	}
	account, err := data.Account(t.Context(), "linked-user")
	if err != nil {
		t.Fatal(err)
	}
	if account.Username != "YukiRenamed" {
		t.Fatalf("the username should still be editable: %q", account.Username)
	}
	if account.Discord == "not-my-handle" {
		t.Fatal("a verified Discord handle was overwritten from the request body")
	}
}

// The owner handle is only claimable with the host token, so claiming it is
// already proof of being the host. Having to then be granted admin by a second
// route was a step that could be forgotten, leaving the owner locked out of
// their own tools.
func TestClaimingTheOwnerHandleGrantsAdmin(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	token := registeredSession(t, data, "owner-user", "Ordinary")
	handler := NewWithStoreAndAdminToken(data, nil, "special-secret").Routes()

	before := tournamentRequest(t, handler, http.MethodGet, "/api/admin/accounts", nil, token)
	if before.Code == http.StatusOK {
		t.Fatal("an ordinary account should not reach the admin routes")
	}

	renamed := tournamentRequest(t, handler, http.MethodPatch, "/api/accounts/owner-user",
		map[string]any{
			"username":         persistence.OwnerUsername,
			"discord":          "",
			"reservationToken": "special-secret",
		}, token)
	if renamed.Code != http.StatusOK {
		t.Fatalf("claim the owner handle: %d: %s", renamed.Code, renamed.Body)
	}
	var account persistence.Account
	if err := json.NewDecoder(renamed.Body).Decode(&account); err != nil {
		t.Fatal(err)
	}
	if !account.IsAdmin {
		t.Fatalf("expected the owner handle to carry admin: %#v", account)
	}
	// The flag is only worth anything if the routes honour it, and they read
	// the session rather than the response body.
	after := tournamentRequest(t, handler, http.MethodGet, "/api/admin/accounts", nil, token)
	if after.Code != http.StatusOK {
		t.Fatalf("expected the owner to reach the admin routes, got %d: %s", after.Code, after.Body)
	}
}

// Signing in on a second browser has to mean playing as yourself there, not as
// whatever anonymous identity that browser happens to have generated.
func TestWebSocketAuthenticatesWithASessionToken(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	token := registeredSession(t, data, "session-player", "SessionPlayer")
	httpServer := httptest.NewServer(NewWithStore(data, nil).Routes())
	defer httpServer.Close()
	websocketURL := "ws" + strings.TrimPrefix(httpServer.URL, "http") + "/ws"

	authenticate := func(sessionToken string) ServerMessage {
		t.Helper()
		connection, _, err := websocket.DefaultDialer.Dial(websocketURL, nil)
		if err != nil {
			t.Fatal(err)
		}
		defer connection.Close()
		if err := connection.WriteJSON(ClientMessage{
			Type:         "authenticate",
			UserID:       "a-second-browser",
			ProfileKey:   "cdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd",
			SessionToken: sessionToken,
		}); err != nil {
			t.Fatal(err)
		}
		var reply ServerMessage
		if err := connection.ReadJSON(&reply); err != nil {
			t.Fatal(err)
		}
		return reply
	}

	ready := authenticate(token)
	if ready.Type != "connection_ready" || ready.Account == nil {
		t.Fatalf("expected a signed-in connection, got %#v", ready)
	}
	if ready.Account.UserID != "session-player" || ready.Account.Username != "SessionPlayer" {
		t.Fatalf("the second browser did not connect as the account: %#v", ready.Account)
	}

	// A revoked or expired session is told so, rather than being quietly let in
	// as a stranger with the same screen in front of them.
	if err := data.RevokeSession(t.Context(), token); err != nil {
		t.Fatal(err)
	}
	if refused := authenticate(token); refused.Type != "authentication_failed" {
		t.Fatalf("expected a revoked session to be refused, got %#v", refused)
	}
}

func TestOnlineGameProfileIncludesDiscord(t *testing.T) {
	server := New(nil)
	first := &Client{
		send:    make(chan []byte, 1),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "first", Username: "First Player", Discord: "first.discord"},
	}
	second := &Client{
		send:    make(chan []byte, 1),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "second", Username: "Second Player", Discord: "second.discord"},
	}
	server.startConfiguredMatch(
		QueueEntry{Client: first, Setup: game.GameSetup{ModeID: game.ModeTotalWar}},
		QueueEntry{Client: second, Setup: game.GameSetup{ModeID: game.ModeTotalWar}},
		matchSetup{},
	)

	var message ServerMessage
	if err := json.Unmarshal(<-first.send, &message); err != nil {
		t.Fatal(err)
	}
	if message.GameState == nil || message.GameState.RedPlayer.Discord != "first.discord" ||
		message.GameState.BluePlayer.Discord != "second.discord" {
		t.Fatalf("online profiles omitted Discord: %#v", message.GameState)
	}
}
