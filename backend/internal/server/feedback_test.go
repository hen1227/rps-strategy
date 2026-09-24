package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"rps-strategy/backend/internal/persistence"
)

// The board's doors, tested from the outside.
//
// The rules worth pinning here are the ones about *who*: reading is open to a
// visitor with no account at all, writing takes Discord, and removing takes
// either authorship or the host. persistence/feedback_test.go covers what the
// board does once somebody is through the door.

// unverifiedSession is an account that has signed in and has no Discord link —
// the case between a guest and a verified player, and the one the board's
// refusal has to name properly.
func unverifiedSession(t *testing.T, data *persistence.Store, userID string) string {
	t.Helper()
	if _, err := data.EnsureAccountWithProfileKey(
		t.Context(), userID, "Guest", routeTestProfileKey,
	); err != nil {
		t.Fatal(err)
	}
	token, err := data.CreateSession(t.Context(), userID)
	if err != nil {
		t.Fatal(err)
	}
	return token
}

// hostSession is a verified account with the admin flag, which is how the host
// posts known issues and answers them.
func hostSession(t *testing.T, data *persistence.Store, userID string) string {
	t.Helper()
	token := registeredSession(t, data, userID, "Host"+userID)
	if err := data.SetAccountAdmin(t.Context(), userID, true); err != nil {
		t.Fatal(err)
	}
	return token
}

func postItem(
	t *testing.T,
	handler http.Handler,
	token string,
	body map[string]any,
) persistence.FeedbackItem {
	t.Helper()
	response := tournamentRequest(t, handler, http.MethodPost, "/api/feedback", body, token)
	if response.Code != http.StatusCreated {
		t.Fatalf("expected the post to be accepted, got %d: %s", response.Code, response.Body)
	}
	var item persistence.FeedbackItem
	if err := json.NewDecoder(response.Body).Decode(&item); err != nil {
		t.Fatal(err)
	}
	return item
}

func decodePage(t *testing.T, response *httptest.ResponseRecorder) persistence.FeedbackPage {
	t.Helper()
	var page persistence.FeedbackPage
	if err := json.NewDecoder(response.Body).Decode(&page); err != nil {
		t.Fatal(err)
	}
	return page
}

func TestTheBoardIsReadableWithoutAnAccountAndWritableOnlyWithDiscord(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	verified := registeredSession(t, data, "verified-user", "Verified")
	unverified := unverifiedSession(t, data, "guest-user")
	handler := NewWithStore(data, nil).Routes()

	post := map[string]any{
		"kind":  "bug",
		"title": "The clock keeps running after a resign",
		"body":  "Resigned on move 4 and the clock kept ticking.",
	}

	// Signed out. 401 rather than 403: there is a credential that would work,
	// and the client's job is to offer sign-in rather than to give up.
	anonymous := tournamentRequest(t, handler, http.MethodPost, "/api/feedback", post, "")
	if anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("expected a signed-out post to be refused, got %d: %s",
			anonymous.Code, anonymous.Body)
	}

	// Signed in, not verified. 403, and the message has to name the thing they
	// must do — they are already signed in, so "sign in" would be nonsense.
	unclaimed := tournamentRequest(t, handler, http.MethodPost, "/api/feedback", post, unverified)
	if unclaimed.Code != http.StatusForbidden {
		t.Fatalf("expected an unverified post to be refused, got %d: %s",
			unclaimed.Code, unclaimed.Body)
	}
	if !containsFold(unclaimed.Body.String(), "Discord") {
		t.Fatalf("the refusal should name Discord, got %s", unclaimed.Body)
	}

	item := postItem(t, handler, verified, post)
	if item.Votes != 1 || !item.YouVoted {
		t.Fatalf("expected the author's own vote, got %d (yours: %t)", item.Votes, item.YouVoted)
	}

	// And reading it takes nothing at all, which is the whole point of a public
	// board.
	board := tournamentRequest(t, handler, http.MethodGet, "/api/feedback", nil, "")
	if board.Code != http.StatusOK {
		t.Fatalf("expected the board to be public, got %d: %s", board.Code, board.Body)
	}
	page := decodePage(t, board)
	if len(page.Items) != 1 || page.Items[0].ItemID != item.ItemID {
		t.Fatalf("expected the posted item on the board, got %+v", page.Items)
	}
	if page.Items[0].YouVoted {
		t.Fatal("a signed-out reader should see no vote of their own")
	}
	if page.OpenBugs != 1 {
		t.Fatalf("expected one open bug beside the tabs, got %d", page.OpenBugs)
	}

	single := tournamentRequest(
		t, handler, http.MethodGet, "/api/feedback/"+item.ItemID, nil, "")
	if single.Code != http.StatusOK {
		t.Fatalf("expected one item to be readable, got %d: %s", single.Code, single.Body)
	}
	missing := tournamentRequest(
		t, handler, http.MethodGet, "/api/feedback/no-such-item", nil, "")
	if missing.Code != http.StatusNotFound {
		t.Fatalf("expected a missing item to be 404, got %d", missing.Code)
	}
}

func TestAKindIsRequiredAndMustBeOneOfTheTwo(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	token := registeredSession(t, data, "verified-user", "Verified")
	handler := NewWithStore(data, nil).Routes()

	for _, kind := range []any{"", "complaint", nil} {
		body := map[string]any{"title": "Something", "body": "words"}
		if kind != nil {
			body["kind"] = kind
		}
		response := tournamentRequest(t, handler, http.MethodPost, "/api/feedback", body, token)
		if response.Code != http.StatusBadRequest {
			t.Fatalf("expected %v to be refused, got %d: %s", kind, response.Code, response.Body)
		}
	}
	// A bug with no body is the other refusal the form has to handle, and it
	// comes from the store rather than the route.
	thin := tournamentRequest(t, handler, http.MethodPost, "/api/feedback",
		map[string]any{"kind": "bug", "title": "It broke"}, token)
	if thin.Code != http.StatusBadRequest {
		t.Fatalf("expected a bug with no details to be refused, got %d: %s",
			thin.Code, thin.Body)
	}
}

func TestVotingTakesAVerifiedAccountAndAnswersWithTheTally(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	author := registeredSession(t, data, "author-user", "Author")
	voter := registeredSession(t, data, "voter-user", "Voter")
	unverified := unverifiedSession(t, data, "guest-user")
	handler := NewWithStore(data, nil).Routes()

	item := postItem(t, handler, author, map[string]any{
		"kind": "suggestion", "title": "Add a rematch button",
	})
	path := "/api/feedback/" + item.ItemID + "/votes"

	if response := tournamentRequest(
		t, handler, http.MethodPost, path, nil, "",
	); response.Code != http.StatusUnauthorized {
		t.Fatalf("expected a signed-out vote to be refused, got %d", response.Code)
	}
	if response := tournamentRequest(
		t, handler, http.MethodPost, path, nil, unverified,
	); response.Code != http.StatusForbidden {
		t.Fatalf("expected an unverified vote to be refused, got %d", response.Code)
	}

	cast := tournamentRequest(t, handler, http.MethodPost, path, nil, voter)
	if cast.Code != http.StatusOK {
		t.Fatalf("expected the vote to be taken, got %d: %s", cast.Code, cast.Body)
	}
	var tally struct {
		Votes    int  `json:"votes"`
		YouVoted bool `json:"youVoted"`
	}
	if err := json.NewDecoder(cast.Body).Decode(&tally); err != nil {
		t.Fatal(err)
	}
	if tally.Votes != 2 || !tally.YouVoted {
		t.Fatalf("expected two votes and a mark, got %+v", tally)
	}

	withdrawn := tournamentRequest(t, handler, http.MethodDelete, path, nil, voter)
	if withdrawn.Code != http.StatusOK {
		t.Fatalf("expected the vote to be withdrawn, got %d: %s",
			withdrawn.Code, withdrawn.Body)
	}
	if err := json.NewDecoder(withdrawn.Body).Decode(&tally); err != nil {
		t.Fatal(err)
	}
	if tally.Votes != 1 || tally.YouVoted {
		t.Fatalf("expected one vote and no mark, got %+v", tally)
	}
}

func TestOnlyTheAuthorOrTheHostCanRemoveAPost(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	author := registeredSession(t, data, "author-user", "Author")
	stranger := registeredSession(t, data, "stranger-user", "Stranger")
	host := hostSession(t, data, "host-user")
	handler := NewWithStore(data, nil).Routes()

	mine := postItem(t, handler, author, map[string]any{
		"kind": "suggestion", "title": "Mine to delete",
	})
	theirs := postItem(t, handler, author, map[string]any{
		"kind": "suggestion", "title": "The host's to delete",
	})

	if response := tournamentRequest(
		t, handler, http.MethodDelete, "/api/feedback/"+mine.ItemID, nil, stranger,
	); response.Code != http.StatusForbidden {
		t.Fatalf("expected a stranger's delete to be refused, got %d: %s",
			response.Code, response.Body)
	}
	if response := tournamentRequest(
		t, handler, http.MethodDelete, "/api/feedback/"+mine.ItemID, nil, author,
	); response.Code != http.StatusOK {
		t.Fatalf("expected the author to delete their own, got %d: %s",
			response.Code, response.Body)
	}
	if response := tournamentRequest(
		t, handler, http.MethodDelete, "/api/feedback/"+theirs.ItemID, nil, host,
	); response.Code != http.StatusOK {
		t.Fatalf("expected the host to delete anybody's, got %d: %s",
			response.Code, response.Body)
	}

	// The same rule on a reply, checked separately because it is a separate
	// route and an author's power over a thread stops at their own words.
	item := postItem(t, handler, author, map[string]any{
		"kind": "bug", "title": "With a thread", "body": "details",
	})
	reply := tournamentRequest(
		t, handler, http.MethodPost, "/api/feedback/"+item.ItemID+"/comments",
		map[string]any{"body": "seeing this too"}, stranger,
	)
	if reply.Code != http.StatusCreated {
		t.Fatalf("expected the reply to be accepted, got %d: %s", reply.Code, reply.Body)
	}
	var comment persistence.FeedbackComment
	if err := json.NewDecoder(reply.Body).Decode(&comment); err != nil {
		t.Fatal(err)
	}
	commentPath := "/api/feedback/" + item.ItemID + "/comments/" + comment.CommentID
	// The address has to name the item the reply is actually on.
	if response := tournamentRequest(
		t, handler, http.MethodDelete,
		"/api/feedback/"+mine.ItemID+"/comments/"+comment.CommentID, nil, stranger,
	); response.Code != http.StatusNotFound {
		t.Fatalf("expected a reply addressed under the wrong item to be missing, got %d",
			response.Code)
	}
	if response := tournamentRequest(
		t, handler, http.MethodDelete, commentPath, nil, author,
	); response.Code != http.StatusForbidden {
		t.Fatalf("an item's author should not be able to delete somebody's reply, got %d",
			response.Code)
	}
	if response := tournamentRequest(
		t, handler, http.MethodDelete, commentPath, nil, stranger,
	); response.Code != http.StatusOK {
		t.Fatalf("expected the reply's own author to remove it, got %d: %s",
			response.Code, response.Body)
	}
}

func TestOnlyTheHostAnswers(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	author := registeredSession(t, data, "author-user", "Author")
	host := hostSession(t, data, "host-user")
	handler := NewWithStoreAndAdminToken(data, nil, "host-token").Routes()

	item := postItem(t, handler, author, map[string]any{
		"kind": "bug", "title": "The clock keeps running", "body": "details",
	})
	path := "/api/admin/feedback/" + item.ItemID
	answer := map[string]any{
		"status":     "accepted",
		"statusNote": "Reproduced. Fixed in the next build.",
		"pinned":     true,
	}

	if response := tournamentRequest(
		t, handler, http.MethodPatch, path, answer, author,
	); response.Code != http.StatusUnauthorized {
		t.Fatalf("expected a player's answer to be refused, got %d: %s",
			response.Code, response.Body)
	}

	updated := tournamentRequest(t, handler, http.MethodPatch, path, answer, host)
	if updated.Code != http.StatusOK {
		t.Fatalf("expected the host's answer to stand, got %d: %s",
			updated.Code, updated.Body)
	}
	var after persistence.FeedbackItem
	if err := json.NewDecoder(updated.Body).Decode(&after); err != nil {
		t.Fatal(err)
	}
	if after.Status != persistence.FeedbackAccepted || !after.Pinned {
		t.Fatalf("unexpected item after the answer: %+v", after)
	}
	// The wording of a bug's status, resolved on the server so the client does
	// not restate the table. See persistence.StatusLabel.
	if after.StatusLabel != "Known issue" {
		t.Fatalf("expected a bug's wording for accepted, got %q", after.StatusLabel)
	}

	// A bad status is the caller's mistake rather than the server's fault.
	if response := tournamentRequest(
		t, handler, http.MethodPatch, path, map[string]any{"status": "maybe"}, host,
	); response.Code != http.StatusBadRequest {
		t.Fatalf("expected an unknown status to be refused, got %d: %s",
			response.Code, response.Body)
	}
}

func TestAHiddenItemIsGoneForEverybodyButTheHost(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	author := registeredSession(t, data, "author-user", "Author")
	host := hostSession(t, data, "host-user")
	handler := NewWithStoreAndAdminToken(data, nil, "host-token").Routes()

	item := postItem(t, handler, author, map[string]any{
		"kind": "bug", "title": "Spam", "body": "buy things",
	})
	if response := tournamentRequest(
		t, handler, http.MethodPatch, "/api/admin/feedback/"+item.ItemID,
		map[string]any{"hidden": true}, host,
	); response.Code != http.StatusOK {
		t.Fatalf("expected the host to hide it, got %d: %s", response.Code, response.Body)
	}

	public := decodePage(t, tournamentRequest(
		t, handler, http.MethodGet, "/api/feedback", nil, author))
	if len(public.Items) != 0 {
		t.Fatalf("expected a hidden item to be off the board, got %d", len(public.Items))
	}
	if response := tournamentRequest(
		t, handler, http.MethodGet, "/api/feedback/"+item.ItemID, nil, author,
	); response.Code != http.StatusNotFound {
		t.Fatalf("knowing the id should not be enough, got %d", response.Code)
	}

	// The host sees it, through a session and through the shared token alike —
	// the token is how the host gets in when there is no session to use.
	for _, credential := range []string{host, "host-token"} {
		page := decodePage(t, tournamentRequest(
			t, handler, http.MethodGet, "/api/feedback", nil, credential))
		if len(page.Items) != 1 || !page.Items[0].Hidden {
			t.Fatalf("expected the host to see the hidden item, got %+v", page.Items)
		}
	}
}

func TestPostingIsRateLimitedAndTheHostIsNot(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	player := registeredSession(t, data, "busy-user", "Busy")
	host := hostSession(t, data, "host-user")
	handler := NewWithStore(data, nil).Routes()

	for index := range feedbackPostsPerWindow {
		postItem(t, handler, player, map[string]any{
			"kind": "suggestion", "title": fmt.Sprintf("Idea %d", index),
		})
	}
	refused := tournamentRequest(t, handler, http.MethodPost, "/api/feedback",
		map[string]any{"kind": "suggestion", "title": "One more"}, player)
	if refused.Code != http.StatusTooManyRequests {
		t.Fatalf("expected the allowance to run out, got %d: %s",
			refused.Code, refused.Body)
	}

	// The host writing up the known issues must not be told to come back in an
	// hour by their own server.
	for index := range feedbackPostsPerWindow + 2 {
		postItem(t, handler, host, map[string]any{
			"kind": "bug", "title": fmt.Sprintf("Known issue %d", index), "body": "details",
		})
	}
}

func TestAMutedAccountCannotPostOrVote(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	author := registeredSession(t, data, "author-user", "Author")
	muted := registeredSession(t, data, "muted-user", "Muted")
	// Before the server is built: the sanction cache is filled once, at
	// construction. See loadRestrictions.
	if _, err := data.SetRestriction(
		t.Context(), "muted-user", persistence.RestrictMute, "being unpleasant", "host", nil,
	); err != nil {
		t.Fatal(err)
	}
	handler := NewWithStore(data, nil).Routes()

	item := postItem(t, handler, author, map[string]any{
		"kind": "bug", "title": "A real bug", "body": "details",
	})

	post := tournamentRequest(t, handler, http.MethodPost, "/api/feedback",
		map[string]any{"kind": "suggestion", "title": "Let me speak"}, muted)
	if post.Code != http.StatusForbidden {
		t.Fatalf("expected a muted account to be refused, got %d: %s", post.Code, post.Body)
	}
	if !containsFold(post.Body.String(), "muted") {
		t.Fatalf("the refusal should say why, got %s", post.Body)
	}
	reply := tournamentRequest(
		t, handler, http.MethodPost, "/api/feedback/"+item.ItemID+"/comments",
		map[string]any{"body": "hello"}, muted)
	if reply.Code != http.StatusForbidden {
		t.Fatalf("expected a muted reply to be refused, got %d: %s", reply.Code, reply.Body)
	}
}

func TestThePolicySaysWhetherYouMayPostAndWhyNot(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	verified := registeredSession(t, data, "verified-user", "Verified")
	unverified := unverifiedSession(t, data, "guest-user")
	handler := NewWithStore(data, nil).Routes()

	read := func(token string) (bool, string) {
		t.Helper()
		response := tournamentRequest(
			t, handler, http.MethodGet, "/api/feedback/policy", nil, token)
		if response.Code != http.StatusOK {
			t.Fatalf("expected the policy to be readable, got %d: %s",
				response.Code, response.Body)
		}
		var policy struct {
			Kinds []struct {
				ID    string `json:"id"`
				Label string `json:"label"`
			} `json:"kinds"`
			Statuses []struct {
				ID              string `json:"id"`
				BugLabel        string `json:"bugLabel"`
				SuggestionLabel string `json:"suggestionLabel"`
			} `json:"statuses"`
			MayPost     bool   `json:"mayPost"`
			PostRefusal string `json:"postRefusal"`
		}
		if err := json.NewDecoder(response.Body).Decode(&policy); err != nil {
			t.Fatal(err)
		}
		if len(policy.Kinds) != len(persistence.FeedbackKinds) {
			t.Fatalf("expected both kinds, got %+v", policy.Kinds)
		}
		if len(policy.Statuses) != len(persistence.FeedbackStatuses) {
			t.Fatalf("expected every status, got %+v", policy.Statuses)
		}
		return policy.MayPost, policy.PostRefusal
	}

	// Three different answers, which is the reason this route exists: the form
	// cannot tell these apart on its own.
	if may, refusal := read(""); may || !containsFold(refusal, "sign in") {
		t.Fatalf("a signed-out visitor should be told to sign in, got %t / %q", may, refusal)
	}
	if may, refusal := read(unverified); may || !containsFold(refusal, "verify") {
		t.Fatalf("an unverified account should be told to verify, got %t / %q", may, refusal)
	}
	if may, refusal := read(verified); !may || refusal != "" {
		t.Fatalf("a verified account should be able to post, got %t / %q", may, refusal)
	}
}

func TestALinkThatCannotBeOpenedIsRefusedAtTheDoor(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	token := registeredSession(t, data, "author-user", "Author")
	handler := NewWithStore(data, nil).Routes()

	refused := tournamentRequest(t, handler, http.MethodPost, "/api/feedback",
		map[string]any{
			"kind": "bug", "title": "With a link", "body": "details",
			"linkUrl": "javascript:alert(1)",
		}, token)
	if refused.Code != http.StatusBadRequest {
		t.Fatalf("expected a script link to be refused, got %d: %s",
			refused.Code, refused.Body)
	}
	item := postItem(t, handler, token, map[string]any{
		"kind": "bug", "title": "With a link", "body": "details",
		"linkUrl": "https://discord.com/channels/1/2/3",
	})
	if item.LinkURL == "" {
		t.Fatal("expected an https link to be kept")
	}
}

// containsFold is strings.Contains without caring about case, for assertions
// about a message's sense rather than its exact wording.
func containsFold(haystack string, needle string) bool {
	return len(needle) == 0 ||
		len(haystack) >= len(needle) &&
			indexFold(haystack, needle) >= 0
}

func indexFold(haystack string, needle string) int {
	for index := 0; index+len(needle) <= len(haystack); index++ {
		if equalFold(haystack[index:index+len(needle)], needle) {
			return index
		}
	}
	return -1
}

func equalFold(first string, second string) bool {
	if len(first) != len(second) {
		return false
	}
	for index := range len(first) {
		if lower(first[index]) != lower(second[index]) {
			return false
		}
	}
	return true
}

func lower(character byte) byte {
	if character >= 'A' && character <= 'Z' {
		return character + ('a' - 'A')
	}
	return character
}
