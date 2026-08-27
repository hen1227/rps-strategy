package server

import (
	"encoding/json"
	"net/http"
	"testing"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

func decodeAccount(t *testing.T, body []byte) persistence.Account {
	t.Helper()
	var account persistence.Account
	if err := json.Unmarshal(body, &account); err != nil {
		t.Fatalf("decode account: %v (%s)", err, body)
	}
	return account
}

func heldTitles(account persistence.Account) []persistence.TitleID {
	ids := make([]persistence.TitleID, 0, len(account.Titles))
	for _, award := range account.Titles {
		ids = append(ids, award.ID)
	}
	return ids
}

// The catalogue is public. A title nobody can look up is a private joke rather
// than something to collect, and the requirement text is what makes an unearned
// one worth chasing.
func TestTheTitleCatalogueIsPublic(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	handler := NewWithStore(data, nil).Routes()

	response := tournamentRequest(t, handler, http.MethodGet, "/api/titles", nil, "")
	if response.Code != http.StatusOK {
		t.Fatalf("expected the catalogue, got %d: %s", response.Code, response.Body)
	}
	var catalogue []persistence.Title
	if err := json.Unmarshal(response.Body.Bytes(), &catalogue); err != nil {
		t.Fatalf("decode catalogue: %v", err)
	}
	if len(catalogue) != len(persistence.TitleCatalogue()) {
		t.Fatalf("expected the whole catalogue, got %d entries", len(catalogue))
	}
	if catalogue[0].ID != persistence.TitleGrandmaster {
		t.Fatalf("the catalogue is ordered best first, got %q", catalogue[0].ID)
	}
}

func TestWearingATitleTakesYourOwnSessionAndAnOwnedTitle(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	token := registeredSession(t, data, "titled", "Titled")
	stranger := registeredSession(t, data, "stranger", "Stranger")
	if err := data.GrantTitle(t.Context(), "titled", persistence.TitleDeveloper); err != nil {
		t.Fatal(err)
	}
	handler := NewWithStore(data, nil).Routes()
	const path = "/api/accounts/titled/title"
	body := map[string]any{"title": persistence.TitleDeveloper}

	if anonymous := tournamentRequest(
		t, handler, http.MethodPut, path, body, "",
	); anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("expected a session to be required, got %d", anonymous.Code)
	}
	if borrowed := tournamentRequest(
		t, handler, http.MethodPut, path, body, stranger,
	); borrowed.Code != http.StatusForbidden {
		t.Fatalf("expected another account's session to be refused, got %d", borrowed.Code)
	}
	// The one guard that matters: a tag is a claim about what you have done,
	// so asking for one you do not hold is refused rather than granted.
	if unowned := tournamentRequest(
		t, handler, http.MethodPut, path,
		map[string]any{"title": persistence.TitleGrandmaster}, token,
	); unowned.Code != http.StatusForbidden {
		t.Fatalf("expected an unowned title to be refused, got %d: %s", unowned.Code, unowned.Body)
	}

	worn := tournamentRequest(t, handler, http.MethodPut, path, body, token)
	if worn.Code != http.StatusOK {
		t.Fatalf("expected the title to be worn, got %d: %s", worn.Code, worn.Body)
	}
	if account := decodeAccount(t, worn.Body.Bytes()); account.Title != persistence.TitleDeveloper {
		t.Fatalf("title was not worn: %#v", account.Title)
	}

	bare := tournamentRequest(t, handler, http.MethodPut, path, map[string]any{"title": ""}, token)
	if bare.Code != http.StatusOK {
		t.Fatalf("expected wearing none to be allowed, got %d: %s", bare.Code, bare.Body)
	}
	if account := decodeAccount(t, bare.Body.Bytes()); account.Title != "" {
		t.Fatalf("title was not cleared: %#v", account.Title)
	}
}

func TestGrantingAndRevokingTitlesIsAdministratorsOnly(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	registeredSession(t, data, "player", "Player")
	handler := NewWithStoreAndAdminToken(data, nil, adminRouteToken).Routes()
	const path = "/api/admin/accounts/player/titles/MOD"

	if anonymous := tournamentRequest(
		t, handler, http.MethodPut, path, nil, "",
	); anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("expected the grant to require an admin, got %d", anonymous.Code)
	}
	if anonymous := tournamentRequest(
		t, handler, http.MethodDelete, path, nil, "",
	); anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("expected the revoke to require an admin, got %d", anonymous.Code)
	}

	granted := tournamentRequest(t, handler, http.MethodPut, path, nil, adminRouteToken)
	if granted.Code != http.StatusOK {
		t.Fatalf("expected the grant to succeed, got %d: %s", granted.Code, granted.Body)
	}
	account := decodeAccount(t, granted.Body.Bytes())
	if held := heldTitles(account); len(held) != 1 || held[0] != persistence.TitleModerator {
		t.Fatalf("expected MOD to be held, got %v", held)
	}

	// A title the catalogue does not know is a typo in the URL, not a new title.
	if unknown := tournamentRequest(
		t, handler, http.MethodPut, "/api/admin/accounts/player/titles/ZZZ", nil, adminRouteToken,
	); unknown.Code != http.StatusBadRequest {
		t.Fatalf("expected an unknown title to be refused, got %d: %s", unknown.Code, unknown.Body)
	}
	if missing := tournamentRequest(
		t, handler, http.MethodPut, "/api/admin/accounts/nobody/titles/MOD", nil, adminRouteToken,
	); missing.Code != http.StatusNotFound {
		t.Fatalf("expected a missing account to be refused, got %d: %s", missing.Code, missing.Body)
	}

	revoked := tournamentRequest(t, handler, http.MethodDelete, path, nil, adminRouteToken)
	if revoked.Code != http.StatusOK {
		t.Fatalf("expected the revoke to succeed, got %d: %s", revoked.Code, revoked.Body)
	}
	if held := heldTitles(decodeAccount(t, revoked.Body.Bytes())); len(held) != 0 {
		t.Fatalf("expected the collection to be empty, got %v", held)
	}
}

// The tag is a copy taken when the player connected, so the seat they play
// under has to carry it — this is what puts it on the board and in chat.
func TestAProfileCarriesTheTitleItsAccountWears(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	registeredSession(t, data, "titled", "Titled")
	if err := data.GrantTitle(t.Context(), "titled", persistence.TitleDeveloper); err != nil {
		t.Fatal(err)
	}
	account, err := data.SetAccountTitle(t.Context(), "titled", persistence.TitleDeveloper)
	if err != nil {
		t.Fatal(err)
	}

	profile := playerProfile(account)
	if profile.Title != string(persistence.TitleDeveloper) {
		t.Fatalf("the seat did not carry the title: %#v", profile)
	}
	if profile.Username != "Titled" || profile.UserID != "titled" {
		t.Fatalf("the seat lost the rest of the profile: %#v", profile)
	}
}

// The two places the user actually sees a title: on the board and in the room.
//
// Both read it off the seat rather than looking it up, so this is the test that
// the seat carries it all the way through a real match.
func TestTitlesReachTheBoardAndTheChatRoom(t *testing.T) {
	server := New(nil)
	redClient := &Client{
		send: make(chan []byte, 8),
		done: make(chan struct{}),
		profile: game.PlayerProfile{
			UserID:   "titled-red",
			Username: "Ada",
			Title:    string(persistence.TitleInternationalMaster),
		},
		account: persistence.Account{UserID: "titled-red", Elo: 1200},
	}
	// Untitled, which is what most players are: the tag has to be absent
	// rather than empty-but-present, or every name row pays for it.
	blueClient := &Client{
		send:    make(chan []byte, 8),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "plain-blue", Username: "Bob"},
		account: persistence.Account{UserID: "plain-blue", Elo: 1200},
	}
	server.startConfiguredMatch(
		QueueEntry{Client: redClient, Setup: game.GameSetup{ModeID: game.ModeInfiltration}, Elo: 1200},
		QueueEntry{Client: blueClient, Setup: game.GameSetup{ModeID: game.ModeInfiltration}, Elo: 1200},
		matchSetup{},
	)
	redMatch := readClientMessage(t, redClient)
	_ = readClientMessage(t, blueClient)
	if redMatch.GameState == nil {
		t.Fatalf("no game state in the match: %#v", redMatch)
	}
	if redMatch.GameState.RedPlayer.Title != string(persistence.TitleInternationalMaster) {
		t.Fatalf("the board did not carry the title: %#v", redMatch.GameState.RedPlayer)
	}
	if redMatch.GameState.BluePlayer.Title != "" {
		t.Fatalf("an untitled player must carry no tag: %#v", redMatch.GameState.BluePlayer)
	}

	// The lobby row is the same profile, so a spectator picking a game to watch
	// sees the same names the board will show them.
	live := server.liveGames()
	if len(live) != 1 || live[0].RedPlayer.Title != string(persistence.TitleInternationalMaster) {
		t.Fatalf("the live-game row did not carry the title: %#v", live)
	}

	server.handleMessage(redClient, ClientMessage{Type: "send_chat", Text: "hello"})
	chat := awaitMessageOfType(t, redClient, "chat_message")
	awaitMessageOfType(t, blueClient, "chat_message")
	if chat.ChatMessage == nil ||
		chat.ChatMessage.SenderTitle != string(persistence.TitleInternationalMaster) {
		t.Fatalf("the message did not carry the sender's title: %#v", chat.ChatMessage)
	}

	server.handleMessage(blueClient, ClientMessage{Type: "send_chat", Text: "hi"})
	awaitMessageOfType(t, redClient, "chat_message")
	plain := awaitMessageOfType(t, blueClient, "chat_message")
	if plain.ChatMessage == nil || plain.ChatMessage.SenderTitle != "" {
		t.Fatalf("an untitled sender must carry no tag: %#v", plain.ChatMessage)
	}
}
