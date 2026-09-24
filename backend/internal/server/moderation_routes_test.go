package server

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// The routes a player reaches for when somebody else is the problem, and the
// one they reach for when they want to leave.
//
// Every test here is about a promise made to somebody outside the room: a block
// that holds, a report that is filed, an account that is really gone. Those are
// the three that have to keep working, so they are pinned at the route rather
// than at the store — a store method nothing calls is not a feature.

func moderationServer(t *testing.T) (*Server, *persistence.Store, http.Handler) {
	t.Helper()
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = data.Close() })
	server := NewWithStore(data, nil)
	return server, data, server.Routes()
}

/* --------------------------------------------------------------- blocking -- */

func TestBlockingRequiresASession(t *testing.T) {
	_, _, handler := moderationServer(t)
	response := tournamentRequest(
		t, handler, http.MethodPost, "/api/blocks",
		map[string]any{"userId": "somebody"}, "",
	)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("expected an unauthenticated block to be refused, got %d: %s",
			response.Code, response.Body)
	}
}

func TestBlockAndUnblockRoundTrip(t *testing.T) {
	server, data, handler := moderationServer(t)
	token := registeredSession(t, data, "blocker", "Blocker")
	if _, err := data.EnsureAccountWithProfileKey(
		t.Context(), "nuisance", "Nuisance", routeTestProfileKey,
	); err != nil {
		t.Fatal(err)
	}

	blocked := tournamentRequest(
		t, handler, http.MethodPost, "/api/blocks",
		map[string]any{"userId": "nuisance"}, token,
	)
	if blocked.Code != http.StatusOK {
		t.Fatalf("blocking failed: %d %s", blocked.Code, blocked.Body)
	}
	// The cache is what every enforcement path reads. A route that wrote the
	// row and left the cache alone would look like this test passing and like
	// blocking doing nothing until the next restart.
	if !server.blockedBetween("blocker", "nuisance") {
		t.Fatal("the block was stored but not cached")
	}
	if !server.blockedBetween("nuisance", "blocker") {
		t.Fatal("a block must be answered symmetrically")
	}

	var page struct {
		Blocked []persistence.BlockedAccount `json:"blocked"`
	}
	if err := json.Unmarshal(blocked.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if len(page.Blocked) != 1 || page.Blocked[0].UserID != "nuisance" {
		t.Fatalf("the list did not come back with the block in it: %#v", page.Blocked)
	}

	// Twice is once. The button is pressable from two tabs and after a reply
	// that never arrived.
	again := tournamentRequest(
		t, handler, http.MethodPost, "/api/blocks",
		map[string]any{"userId": "nuisance"}, token,
	)
	if again.Code != http.StatusOK {
		t.Fatalf("blocking twice failed: %d %s", again.Code, again.Body)
	}

	lifted := tournamentRequest(
		t, handler, http.MethodDelete, "/api/blocks/nuisance", nil, token,
	)
	if lifted.Code != http.StatusOK {
		t.Fatalf("unblocking failed: %d %s", lifted.Code, lifted.Body)
	}
	if server.blockedBetween("blocker", "nuisance") {
		t.Fatal("the block was lifted but not uncached")
	}
}

func TestBlockingByUsername(t *testing.T) {
	server, data, handler := moderationServer(t)
	token := registeredSession(t, data, "namer", "Namer")
	registeredSession(t, data, "target", "TargetPlayer")

	// The case the player page needs: a profile reached by handle knows the
	// name and not the id.
	response := tournamentRequest(
		t, handler, http.MethodPost, "/api/blocks",
		map[string]any{"username": "targetplayer"}, token,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("blocking by name failed: %d %s", response.Code, response.Body)
	}
	if !server.blockedBetween("namer", "target") {
		t.Fatal("a name did not resolve to the account behind it")
	}
}

func TestBlockingYourselfIsRefused(t *testing.T) {
	_, data, handler := moderationServer(t)
	token := registeredSession(t, data, "solo", "Solo")
	response := tournamentRequest(
		t, handler, http.MethodPost, "/api/blocks",
		map[string]any{"userId": "solo"}, token,
	)
	if response.Code != http.StatusBadRequest {
		t.Fatalf("expected blocking yourself to be refused, got %d: %s",
			response.Code, response.Body)
	}
}

// The two things a block actually does, asked of the helpers the game paths
// call rather than of a socket: chat is hidden both ways, and nothing else in
// the room is touched.
func TestBlockedChatIsHiddenBothWays(t *testing.T) {
	server, _, _ := moderationServer(t)
	// Straight into the cache, which is what the route writes after the store
	// accepts it and what every enforcement path reads. The round trip through
	// the database is TestBlockAndUnblockRoundTrip's job; this is about what a
	// block does once it is in force.
	server.cacheBlock("reader", "writer")
	history := []ChatMessage{
		{ID: "1", SenderUserID: "writer", Text: "hidden"},
		{ID: "2", SenderUserID: "bystander", Text: "shown"},
		{ID: "3", SenderUserID: "reader", Text: "mine"},
	}

	reader := &Client{profile: game.PlayerProfile{UserID: "reader"}}
	visible := server.visibleChat(reader, history)
	if len(visible) != 2 {
		t.Fatalf("expected the blocked sender's line to be dropped, got %#v", visible)
	}
	for _, message := range visible {
		if message.SenderUserID == "writer" {
			t.Error("a blocked player's message reached the person who blocked them")
		}
	}

	// The other direction. Neither sees the other, so the blocked player is not
	// left replying into a void.
	writer := &Client{profile: game.PlayerProfile{UserID: "writer"}}
	fromWriter := server.visibleChat(writer, history)
	for _, message := range fromWriter {
		if message.SenderUserID == "reader" {
			t.Error("a block was enforced in only one direction")
		}
	}

	// Everybody else's room is unchanged, which is what makes this a
	// preference rather than a sanction.
	other := &Client{profile: game.PlayerProfile{UserID: "bystander"}}
	if len(server.visibleChat(other, history)) != len(history) {
		t.Error("a block between two people changed what a third saw")
	}
}

// The ordinary path must not copy a room's worth of messages per join.
func TestVisibleChatReturnsTheSameSliceWhenNothingIsBlocked(t *testing.T) {
	server, _, _ := moderationServer(t)
	history := []ChatMessage{{ID: "1", SenderUserID: "somebody"}}
	client := &Client{profile: game.PlayerProfile{UserID: "viewer"}}
	visible := server.visibleChat(client, history)
	if len(visible) != 1 || &visible[0] != &history[0] {
		t.Error("an unblocked history was copied rather than passed through")
	}
}

func TestForgettingBlocksClearsBothDirections(t *testing.T) {
	server, _, _ := moderationServer(t)
	server.cacheBlock("leaver", "other")
	server.cacheBlock("someone", "leaver")

	server.forgetBlocksOf("leaver")

	if server.blockedBetween("leaver", "other") {
		t.Error("a departed account's own list survived it")
	}
	if server.blockedBetween("someone", "leaver") {
		t.Error("a block against a departed account survived it")
	}
}

/* -------------------------------------------------------------- reporting -- */

func TestReportingWorksWithoutSigningIn(t *testing.T) {
	_, data, handler := moderationServer(t)
	// A guest: the browser's own account and the local key that opens it, which
	// is every first visit to this site.
	if _, err := data.EnsureAccountWithProfileKey(
		t.Context(), "guest-reporter", "Guest", routeTestProfileKey,
	); err != nil {
		t.Fatal(err)
	}
	registeredSession(t, data, "offender", "Offender")

	response := tournamentRequest(
		t, handler, http.MethodPost,
		"/api/reports?userId=guest-reporter",
		map[string]any{
			"targetUsername": "Offender",
			"category":       "harassment",
			"details":        "said something vile in chat",
			"context":        "Offender: something vile",
		},
		routeTestProfileKey,
	)
	if response.Code != http.StatusCreated {
		t.Fatalf("a guest could not file a report: %d %s", response.Code, response.Body)
	}

	page, err := data.Reports(t.Context(), persistence.ReportFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 {
		t.Fatalf("expected one report, got %d", page.Total)
	}
	report := page.Reports[0]
	if report.TargetUserID != "offender" {
		t.Errorf("the name did not resolve to an account: %#v", report)
	}
	// The evidence is the point. A report that stored the category and threw
	// away what was said is one nobody can act on.
	if report.Context == "" || report.Details == "" {
		t.Errorf("the report kept no evidence: %#v", report)
	}
}

func TestReportsAreRateLimited(t *testing.T) {
	_, data, handler := moderationServer(t)
	token := registeredSession(t, data, "prolific", "Prolific")

	file := func() int {
		return tournamentRequest(
			t, handler, http.MethodPost, "/api/reports",
			map[string]any{"targetUsername": "Nobody", "category": "spam"},
			token,
		).Code
	}
	for attempt := range reportsPerWindow {
		if code := file(); code != http.StatusCreated {
			t.Fatalf("report %d was refused with %d", attempt+1, code)
		}
	}
	if code := file(); code != http.StatusTooManyRequests {
		t.Fatalf("expected the %dth report to be throttled, got %d",
			reportsPerWindow+1, code)
	}
}

// A report about somebody who cannot be resolved is still worth filing: they
// may have been renamed or removed since. Only the id is lost.
func TestReportingAnUnknownNameStillFiles(t *testing.T) {
	_, data, handler := moderationServer(t)
	token := registeredSession(t, data, "witness", "Witness")

	response := tournamentRequest(
		t, handler, http.MethodPost, "/api/reports",
		map[string]any{"targetUsername": "GoneAlready", "category": "hate"},
		token,
	)
	if response.Code != http.StatusCreated {
		t.Fatalf("expected the report to be filed anyway: %d %s",
			response.Code, response.Body)
	}
	page, err := data.Reports(t.Context(), persistence.ReportFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if page.Reports[0].TargetName != "GoneAlready" {
		t.Errorf("the reported name was lost: %#v", page.Reports[0])
	}
}

func TestReportQueueIsAdminOnly(t *testing.T) {
	_, data, handler := moderationServer(t)
	token := registeredSession(t, data, "curious", "Curious")
	response := tournamentRequest(t, handler, http.MethodGet, "/api/admin/reports", nil, token)
	if response.Code == http.StatusOK {
		t.Fatal("an ordinary account could read the report queue")
	}
}

func TestReportCategoriesArePublished(t *testing.T) {
	_, _, handler := moderationServer(t)
	response := tournamentRequest(t, handler, http.MethodGet, "/api/reports/categories", nil, "")
	if response.Code != http.StatusOK {
		t.Fatalf("the report form could not read its own options: %d", response.Code)
	}
	var published struct {
		Categories []struct {
			ID    string `json:"id"`
			Label string `json:"label"`
		} `json:"categories"`
		ContactName string `json:"contactName"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &published); err != nil {
		t.Fatal(err)
	}
	if len(published.Categories) != len(persistence.ReportCategories) {
		t.Errorf("the published list does not match the server's own: %#v", published.Categories)
	}
	// The published contact is the other half of the same guideline: an app
	// carrying user content has to say how to reach whoever is responsible.
	if published.ContactName == "" {
		t.Error("no contact was published for reports the queue cannot handle")
	}
	for _, category := range published.Categories {
		if category.Label == "" {
			t.Errorf("%q has no label for the form to show", category.ID)
		}
	}
}

/* ------------------------------------------------------- account deletion -- */

func TestDeletingYourOwnAccountNeedsTheUsernameTypedBack(t *testing.T) {
	_, data, handler := moderationServer(t)
	token := registeredSession(t, data, "leaver", "Leaver")

	wrong := tournamentRequest(
		t, handler, http.MethodDelete, "/api/accounts/leaver",
		map[string]any{"confirm": "Leever"}, token,
	)
	if wrong.Code != http.StatusBadRequest {
		t.Fatalf("a mistyped confirmation deleted the account: %d %s", wrong.Code, wrong.Body)
	}
	if _, err := data.Account(t.Context(), "leaver"); err != nil {
		t.Fatalf("the account was removed by a refused request: %v", err)
	}
}

func TestDeletingSomebodyElsesAccountIsRefused(t *testing.T) {
	_, data, handler := moderationServer(t)
	token := registeredSession(t, data, "mine", "Mine")
	registeredSession(t, data, "yours", "Yours")

	response := tournamentRequest(
		t, handler, http.MethodDelete, "/api/accounts/yours",
		map[string]any{"confirm": "Yours"}, token,
	)
	if response.Code != http.StatusForbidden {
		t.Fatalf("expected a cross-account deletion to be refused, got %d: %s",
			response.Code, response.Body)
	}
	if _, err := data.Account(t.Context(), "yours"); err != nil {
		t.Fatalf("somebody else's account was deleted: %v", err)
	}
}

// The whole promise, end to end: what the player is told happens, happens.
func TestDeletingYourOwnAccountRemovesTheIdentity(t *testing.T) {
	server, data, handler := moderationServer(t)
	token := registeredSession(t, data, "goodbye", "Goodbye")
	server.cacheBlock("goodbye", "somebody")

	response := tournamentRequest(
		t, handler, http.MethodDelete, "/api/accounts/goodbye",
		map[string]any{"confirm": "goodbye"}, token,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("deletion failed: %d %s", response.Code, response.Body)
	}

	// An account that never played is removed outright rather than stripped.
	if _, err := data.Account(t.Context(), "goodbye"); err == nil {
		t.Error("an account that had never played was kept")
	}
	// The session has to be dead, or "deleted" means "hidden until the next
	// request".
	if _, err := data.SessionAccount(t.Context(), token); err == nil {
		t.Error("the session outlived the account it belonged to")
	}
	if server.blockedBetween("goodbye", "somebody") {
		t.Error("the block cache kept a departed account's list")
	}
}

// A guest owns an account too, and it holds their games and their name. Being
// told to sign up before they may delete it is not an answer.
func TestAGuestMayDeleteTheirOwnAccount(t *testing.T) {
	_, data, handler := moderationServer(t)
	if _, err := data.EnsureAccountWithProfileKey(
		t.Context(), "passing-through", "Guest", routeTestProfileKey,
	); err != nil {
		t.Fatal(err)
	}
	response := tournamentRequest(
		t, handler, http.MethodDelete,
		"/api/accounts/passing-through?userId=passing-through",
		map[string]any{"confirm": "Guest"}, routeTestProfileKey,
	)
	if response.Code != http.StatusOK {
		t.Fatalf("a guest could not delete their own account: %d %s",
			response.Code, response.Body)
	}
	if _, err := data.Account(t.Context(), "passing-through"); err == nil {
		t.Error("the guest account survived its own deletion")
	}
}

// The block cache is what every enforcement path reads, and the block *rows*
// cascade away with the account they name. So every path that removes an
// account has to tell the cache — not just the player's own deletion.
//
// Missing this leaves the account screen's list (which reads the store) out of
// step with what the client believes it is hiding, and leaves a departed id
// hiding whoever holds it next.
func TestAdminAccountRemovalClearsTheBlockCache(t *testing.T) {
	for _, removal := range []struct {
		name   string
		method string
		path   string
	}{
		{"anonymize", http.MethodDelete, "/api/admin/accounts/departing"},
		{"purge", http.MethodDelete, "/api/admin/accounts/departing/purge"},
	} {
		t.Run(removal.name, func(t *testing.T) {
			data, err := persistence.Open(":memory:")
			if err != nil {
				t.Fatal(err)
			}
			defer func() { _ = data.Close() }()
			const adminToken = "an-admin-token-long-enough-to-be-accepted"
			server := NewWithStoreAndAdminToken(data, nil, adminToken)
			handler := server.Routes()

			registeredSession(t, data, "departing", "Departing")
			registeredSession(t, data, "staying", "Staying")
			if err := data.BlockAccount(t.Context(), "staying", "departing"); err != nil {
				t.Fatal(err)
			}
			server.cacheBlock("staying", "departing")

			response := tournamentRequest(t, handler, removal.method, removal.path, nil, adminToken)
			if response.Code != http.StatusOK {
				t.Fatalf("removal failed: %d %s", response.Code, response.Body)
			}
			if server.blockedBetween("staying", "departing") {
				t.Error("the cache still holds a block against a removed account")
			}
		})
	}
}

// postSeek refuses to create one and blocking withdraws what was on the board,
// but a seek can outlive its socket — so a challenge posted by somebody who was
// offline when the block landed can still be sitting in an inbox.
func TestABlockedPlayersChallengeDoesNotReachTheInbox(t *testing.T) {
	server, data, _ := moderationServer(t)
	registeredSession(t, data, "recipient", "Recipient")
	registeredSession(t, data, "sender", "Sender")
	server.cacheBlock("recipient", "sender")

	sender := &Client{profile: game.PlayerProfile{UserID: "sender", Username: "Sender"}}
	recipient := &Client{profile: game.PlayerProfile{UserID: "recipient", Username: "Recipient"}}
	seek := &Seek{
		ID:             "pending",
		Owner:          seekOwnerKey(sender),
		Poster:         sender.profile,
		TargetUsername: "Recipient",
		JoinedAt:       time.Now(),
		ExpiresAt:      time.Now().Add(time.Hour),
	}
	seek.bind(sender)
	server.seeks.Post(seek)

	if pending := server.pendingChallengesFor(recipient, time.Now()); len(pending) != 0 {
		t.Fatalf("a blocked player's challenge reached the inbox: %#v", pending)
	}
	// And the same seek reaches anybody else's inbox unchanged, which is what
	// makes this a preference rather than a withdrawal.
	seek.TargetUsername = "Bystander"
	bystander := &Client{profile: game.PlayerProfile{UserID: "bystander", Username: "Bystander"}}
	if pending := server.pendingChallengesFor(bystander, time.Now()); len(pending) != 1 {
		t.Fatalf("a third party's inbox was changed by somebody else's block: %#v", pending)
	}
}

// A report's target id is the client's word for who this is about. Storing an
// unverified one would let anybody inflate the "other open reports" count the
// admin queue shows against a name — the number a host leans on when deciding.
func TestAnUnverifiedReportTargetIsNotStored(t *testing.T) {
	_, data, handler := moderationServer(t)
	token := registeredSession(t, data, "reporter", "Reporter")

	response := tournamentRequest(
		t, handler, http.MethodPost, "/api/reports",
		map[string]any{
			"targetUserId":   "somebody-elses-account",
			"targetUsername": "NoSuchPlayer",
			"category":       "spam",
		},
		token,
	)
	if response.Code != http.StatusCreated {
		t.Fatalf("the report was not filed: %d %s", response.Code, response.Body)
	}
	page, err := data.Reports(t.Context(), persistence.ReportFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if got := page.Reports[0].TargetUserID; got != "" {
		t.Errorf("an unverified target id was stored: %q", got)
	}
	if page.Reports[0].TargetName != "NoSuchPlayer" {
		t.Errorf("the reported name was lost: %#v", page.Reports[0])
	}
}
