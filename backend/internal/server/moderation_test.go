package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// mute places a mute directly, the way the admin route does, without going
// through HTTP. The routes are tested separately; these are about the gates.
func mute(t *testing.T, server *Server, userID string, seconds int64) {
	t.Helper()
	var expires *int64
	if seconds > 0 {
		deadline := time.Now().Add(time.Duration(seconds) * time.Second).UnixMilli()
		expires = &deadline
	}
	restriction, err := server.data.SetRestriction(
		t.Context(), userID, persistence.RestrictMute, "spamming", "admin", expires,
	)
	if err != nil {
		t.Fatalf("mute %s: %v", userID, err)
	}
	server.cacheRestriction(userID, restriction)
}

// A mute stops chat, and says why and for how long.
func TestAMuteRefusesChatWithAReason(t *testing.T) {
	server := New(nil)
	if _, err := server.data.EnsureAccount(t.Context(), "loud", "Loud"); err != nil {
		t.Fatal(err)
	}
	client := challengeTestClient("loud", "Loud")
	mute(t, server, "loud", 3600)

	server.sendChat(client, "hello")
	message := readChallengeTestMessage(t, client)
	if message.Type != "chat_rejected" {
		t.Fatalf("expected a refusal, got %q", message.Type)
	}
	// Both halves of the explanation: the deadline and the reason. A refusal
	// with neither is the one that generates a support request.
	if !strings.Contains(message.Message, "muted") ||
		!strings.Contains(message.Message, "spamming") ||
		!strings.Contains(message.Message, "left") {
		t.Fatalf("unhelpful refusal: %q", message.Message)
	}
}

// The other half of a mute: challenges. A challenge carries a username
// somebody typed, which is the second way to put words in front of a person.
func TestAMuteRefusesChallenges(t *testing.T) {
	server := New(nil)
	if _, err := server.data.EnsureAccount(t.Context(), "loud", "Loud"); err != nil {
		t.Fatal(err)
	}
	client := challengeTestClient("loud", "Loud")
	mute(t, server, "loud", 3600)

	server.postSeek(client, "Target", game.GameSetup{ModeID: game.ModeTotalWar}, false)
	message := awaitMessage(t, client, "challenge_rejected")
	if !strings.Contains(message.Message, "muted") {
		t.Fatalf("unexpected refusal: %q", message.Message)
	}
}

// A lapsed mute is not a mute. Nothing has to run for it to lapse.
func TestALapsedMuteIsNotEnforced(t *testing.T) {
	server := New(nil)
	if _, err := server.data.EnsureAccount(t.Context(), "loud", "Loud"); err != nil {
		t.Fatal(err)
	}
	client := challengeTestClient("loud", "Loud")
	// A deadline in the past, which is what a mute looks like a second after it
	// expires and before any sweep has touched it.
	past := time.Now().Add(-time.Minute).UnixMilli()
	restriction, err := server.data.SetRestriction(
		t.Context(), "loud", persistence.RestrictMute, "spamming", "admin", &past,
	)
	if err != nil {
		t.Fatal(err)
	}
	server.cacheRestriction("loud", restriction)

	if refusal := server.muteRefusal(client, "chat"); refusal != "" {
		t.Fatalf("an expired mute was still enforced: %q", refusal)
	}
}

// A ranked bar downgrades rather than refuses: they can still play.
func TestARankedBarDowngradesInsteadOfRefusing(t *testing.T) {
	server := New(nil)
	client := challengeTestClient("sandbagger", "Sandbagger")
	client.account.Registered = true
	if server.restrictionOn("sandbagger", persistence.RestrictRanked) != nil {
		t.Fatal("unexpected restriction before one was placed")
	}
	if !server.rankedAllowed(client) {
		t.Fatal("a registered account was refused ranked play")
	}

	if _, err := server.data.EnsureAccount(t.Context(), "sandbagger", "Sandbagger"); err != nil {
		t.Fatal(err)
	}
	restriction, err := server.data.SetRestriction(
		t.Context(), "sandbagger", persistence.RestrictRanked, "manipulating the ladder",
		"admin", nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	server.cacheRestriction("sandbagger", restriction)

	if server.rankedAllowed(client) {
		t.Fatal("a barred account was still allowed ranked play")
	}
	// The advisory has to name the real reason. Telling somebody who has
	// already linked Discord to link Discord is the message that makes a
	// moderation decision look like a bug.
	refusal := server.rankedRefusal(client)
	if strings.Contains(refusal, "Discord") ||
		!strings.Contains(refusal, "manipulating the ladder") {
		t.Fatalf("unexpected explanation: %q", refusal)
	}
}

// A tournament bar is enforced at the signup route, not after the fact.
func TestATournamentBarRefusesSignups(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	server := NewWithStoreAndAdminToken(data, nil, "test-secret")
	if _, err := data.EnsureAccount(t.Context(), "banned", "Banned"); err != nil {
		t.Fatal(err)
	}
	restriction, err := data.SetRestriction(
		t.Context(), "banned", persistence.RestrictTournament, "no-showed twice", "admin", nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	server.cacheRestriction("banned", restriction)

	tournament := openTournament(t, data, "cup", "Cup", game.ModeTotalWar, "Total War")
	response := tournamentRequest(
		t,
		server.Routes(),
		http.MethodPost,
		"/api/tournaments/"+tournament.TournamentID+"/signups",
		map[string]any{
			"userId": "banned", "ign": "Banned", "discord": "banned.discord",
			"agreedToUnfilteredChat": true,
		},
		"",
	)
	if response.Code != http.StatusForbidden {
		t.Fatalf("expected the signup to be refused, got %d: %s", response.Code, response.Body)
	}
	if !strings.Contains(response.Body.String(), "no-showed twice") {
		t.Fatalf("the refusal did not say why: %s", response.Body)
	}
}

// Placing the same sanction twice extends it rather than stacking two.
func TestReMutingExtendsRatherThanStacks(t *testing.T) {
	store, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer store.Close()
	if _, err := store.EnsureAccount(t.Context(), "loud", "Loud"); err != nil {
		t.Fatal(err)
	}
	for _, reason := range []string{"first", "second"} {
		if _, err := store.SetRestriction(
			t.Context(), "loud", persistence.RestrictMute, reason, "admin", nil,
		); err != nil {
			t.Fatal(err)
		}
	}
	restrictions, err := store.Restrictions(t.Context(), "loud")
	if err != nil {
		t.Fatal(err)
	}
	if len(restrictions) != 1 {
		t.Fatalf("expected one mute, got %d: %#v", len(restrictions), restrictions)
	}
	if restrictions[0].Reason != "second" {
		t.Fatalf("expected the newer reason to stand, got %q", restrictions[0].Reason)
	}
}

// The admin routes place and lift sanctions, and refuse a kind nobody enforces.
func TestModerationRoutes(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	server := NewWithStoreAndAdminToken(data, nil, "test-secret")
	handler := server.Routes()
	if _, err := data.EnsureAccount(t.Context(), "loud", "Loud"); err != nil {
		t.Fatal(err)
	}

	placed := tournamentRequest(
		t, handler, http.MethodPost, "/api/admin/accounts/loud/restrictions",
		map[string]any{"kind": "mute", "reason": "spamming", "durationSeconds": 600},
		"test-secret",
	)
	if placed.Code != http.StatusOK {
		t.Fatalf("expected the mute to be placed, got %d: %s", placed.Code, placed.Body)
	}
	// Enforced immediately, without a restart: the cache and the table are
	// written together. See the note at the top of moderation.go.
	if server.restrictionOn("loud", persistence.RestrictMute) == nil {
		t.Fatal("the mute was stored but is not being enforced")
	}

	listed := tournamentRequest(
		t, handler, http.MethodGet, "/api/admin/accounts/loud/restrictions", nil, "test-secret",
	)
	var restrictions []persistence.Restriction
	if err := json.NewDecoder(listed.Body).Decode(&restrictions); err != nil {
		t.Fatal(err)
	}
	if len(restrictions) != 1 || restrictions[0].ExpiresAtUnixMs == nil {
		t.Fatalf("unexpected restriction list: %#v", restrictions)
	}

	bad := tournamentRequest(
		t, handler, http.MethodPost, "/api/admin/accounts/loud/restrictions",
		map[string]any{"kind": "shadowban", "reason": "", "durationSeconds": 0},
		"test-secret",
	)
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("expected an unknown kind to be refused, got %d: %s", bad.Code, bad.Body)
	}

	lifted := tournamentRequest(
		t, handler, http.MethodDelete, "/api/admin/accounts/loud/restrictions/mute",
		nil, "test-secret",
	)
	if lifted.Code != http.StatusOK {
		t.Fatalf("expected the mute to be lifted, got %d: %s", lifted.Code, lifted.Body)
	}
	if server.restrictionOn("loud", persistence.RestrictMute) != nil {
		t.Fatal("the mute is still being enforced after being lifted")
	}

	// Everything here is private.
	unauthorized := tournamentRequest(
		t, handler, http.MethodPost, "/api/admin/accounts/loud/restrictions",
		map[string]any{"kind": "mute", "reason": "", "durationSeconds": 0}, "",
	)
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without the token, got %d", unauthorized.Code)
	}
}

// An engine entered in a running event is held in reserve: not available for a
// challenge, and named as such rather than described as broken.
func TestAnEngineInARunningEventIsHeldInReserve(t *testing.T) {
	server := New(nil)
	data := server.data
	for _, name := range []string{"engine", "rival"} {
		if _, err := data.EnsureAccount(t.Context(), name, name); err != nil {
			t.Fatal(err)
		}
	}
	openTournament(t, data, "cup", "Engine Cup", game.ModeTotalWar, "Total War")
	verifiedEntrants(t, data, "engine", "rival")
	for _, name := range []string{"engine", "rival"} {
		if _, err := data.SignupForTournament(
			t.Context(), "cup", name, name, "bot."+name, true,
		); err != nil {
			t.Fatal(err)
		}
	}

	// Registration is not a reservation: an event that has not started does not
	// tie up the field.
	server.refreshBotReservations()
	if held := server.botReservation("engine"); held != "" {
		t.Fatalf("an engine was reserved before the event started: %q", held)
	}

	if _, err := data.StartTournament(t.Context(), "cup"); err != nil {
		t.Fatal(err)
	}
	server.refreshBotReservations()
	if held := server.botReservation("engine"); held != "Engine Cup" {
		t.Fatalf("expected the engine to be reserved for Engine Cup, got %q", held)
	}
	// The refusal names the event and does not imply the engine is unhealthy.
	refusal := botReserveRefusal("Fishy", "Engine Cup")
	if !strings.Contains(refusal, "Engine Cup") || strings.Contains(refusal, "shutting down") {
		t.Fatalf("unexpected refusal: %q", refusal)
	}

	// And the reservation lifts when the event finishes, not when the engine's
	// own matches run out.
	tournament, err := data.Tournament(t.Context(), "cup")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := data.SetTournamentMatchResult(
		t.Context(), "cup", tournament.Matches[0].MatchID, persistence.MatchPlayer1Win,
	); err != nil {
		t.Fatal(err)
	}
	server.refreshBotReservations()
	if held := server.botReservation("engine"); held != "" {
		t.Fatalf("the reservation outlived the event: %q", held)
	}
}

// A player page exists for a linked account and not for an anonymous one.
func TestPlayerProfilesAreForLinkedAccounts(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	server := NewWithStore(data, nil)
	handler := server.Routes()

	if _, err := data.EnsureAccount(t.Context(), "guest-1", "Guest"); err != nil {
		t.Fatal(err)
	}
	linkAccountForTest(t, data, "yuki", "Yuki", "discord-snowflake-1")

	// Addressed by name, case-insensitively, which is the whole point of
	// addressing it by name.
	found := httptest.NewRecorder()
	handler.ServeHTTP(found, httptest.NewRequest(http.MethodGet, "/api/players/YUKI", nil))
	if found.Code != http.StatusOK {
		t.Fatalf("expected Yuki to have a page, got %d: %s", found.Code, found.Body)
	}
	var profile persistence.PublicProfile
	if err := json.NewDecoder(found.Body).Decode(&profile); err != nil {
		t.Fatal(err)
	}
	if profile.Username != "Yuki" || profile.UserID != "yuki" {
		t.Fatalf("unexpected profile: %#v", profile)
	}

	// The same page by id, since a link built from a game record has one.
	byID := httptest.NewRecorder()
	handler.ServeHTTP(byID, httptest.NewRequest(http.MethodGet, "/api/players/yuki", nil))
	if byID.Code != http.StatusOK {
		t.Fatalf("expected the id to resolve too, got %d", byID.Code)
	}

	missing := httptest.NewRecorder()
	handler.ServeHTTP(missing, httptest.NewRequest(http.MethodGet, "/api/players/guest-1", nil))
	if missing.Code != http.StatusNotFound {
		t.Fatalf("an unlinked account has no page; got %d: %s", missing.Code, missing.Body)
	}
}

// linkAccountForTest gives an account a Discord identity, which is what makes
// it eligible for a public page.
func linkAccountForTest(
	t *testing.T,
	data *persistence.Store,
	userID string,
	username string,
	snowflake string,
) {
	t.Helper()
	if _, err := data.EnsureAccount(t.Context(), userID, username); err != nil {
		t.Fatal(err)
	}
	if _, err := data.ClaimAccountWithDiscord(
		t.Context(), userID, username, snowflake, username,
	); err != nil {
		t.Fatalf("link %s: %v", userID, err)
	}
}
