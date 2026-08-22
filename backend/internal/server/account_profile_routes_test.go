package server

import (
	"encoding/json"
	"net/http"
	"testing"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

const routeTestProfileKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestAccountProfileUpdateRequiresMatchingLocalKey(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	if _, err := data.EnsureAccountWithProfileKey(
		t.Context(), "settings-user", "Guest", routeTestProfileKey,
	); err != nil {
		t.Fatal(err)
	}
	handler := NewWithStore(data, nil).Routes()
	body := map[string]any{"displayName": "Settings Player", "discord": "settings.player"}

	missing := tournamentRequest(
		t, handler, http.MethodPatch, "/api/accounts/settings-user", body, "",
	)
	if missing.Code != http.StatusUnauthorized {
		t.Fatalf("expected missing key to be rejected, got %d: %s", missing.Code, missing.Body)
	}

	wrong := tournamentRequest(
		t,
		handler,
		http.MethodPatch,
		"/api/accounts/settings-user",
		body,
		"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
	)
	if wrong.Code != http.StatusUnauthorized {
		t.Fatalf("expected wrong key to be rejected, got %d: %s", wrong.Code, wrong.Body)
	}

	updated := tournamentRequest(
		t,
		handler,
		http.MethodPatch,
		"/api/accounts/settings-user",
		body,
		routeTestProfileKey,
	)
	if updated.Code != http.StatusOK {
		t.Fatalf("expected profile update, got %d: %s", updated.Code, updated.Body)
	}
	var account persistence.Account
	if err := json.NewDecoder(updated.Body).Decode(&account); err != nil {
		t.Fatal(err)
	}
	if account.Username != "Settings Player" || account.Discord != "settings.player" {
		t.Fatalf("unexpected profile response: %#v", account)
	}
}

func TestAccountProfileReservedIdentitiesRequireSpecialToken(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	if _, err := data.EnsureAccountWithProfileKey(
		t.Context(), "reserved-user", "Guest", routeTestProfileKey,
	); err != nil {
		t.Fatal(err)
	}
	handler := NewWithStoreAndAdminToken(data, nil, "special-secret").Routes()
	path := "/api/accounts/reserved-user"

	for _, body := range []map[string]any{
		{"displayName": "hEnHeN1227", "discord": "someone"},
		{"displayName": "Someone", "discord": "@WEBGOATGUY"},
	} {
		response := tournamentRequest(t, handler, http.MethodPatch, path, body, routeTestProfileKey)
		if response.Code != http.StatusForbidden {
			t.Fatalf("expected reserved identity to be rejected, got %d: %s", response.Code, response.Body)
		}
		body["reservationToken"] = "special-secret"
		response = tournamentRequest(t, handler, http.MethodPatch, path, body, routeTestProfileKey)
		if response.Code != http.StatusOK {
			t.Fatalf("expected special token to allow reserved identity, got %d: %s", response.Code, response.Body)
		}
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
	server.startMatch(
		QueueEntry{Client: first, ModeID: game.ModeAnnihilation, TimeControl: game.DefaultTimeControl()},
		QueueEntry{Client: second, ModeID: game.ModeAnnihilation, TimeControl: game.DefaultTimeControl()},
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
