package persistence

import (
	"testing"
)

// What these pin, and why each is worth a test:
//
// The board's value is the tally and the order it produces, so both are tested
// against the rules stated in feedback.go rather than against whatever the
// queries happen to do. The rest is the handful of places where getting it
// wrong is quiet: a vote that double-counts, a hidden item that is merely
// unlisted, a deleted account that takes half a conversation with it.

func newFeedbackStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

func mustPost(t *testing.T, store *Store, input NewFeedbackItem) FeedbackItem {
	t.Helper()
	item, err := store.CreateFeedbackItem(t.Context(), input)
	if err != nil {
		t.Fatalf("post %q: %v", input.Title, err)
	}
	return item
}

func TestPostingCountsAsAVoteForYourOwnItem(t *testing.T) {
	store := newFeedbackStore(t)
	item := mustPost(t, store, NewFeedbackItem{
		Kind:         FeedbackBug,
		Title:        "The clock keeps running after a resign",
		Body:         "Resigned on move 4 and my clock kept ticking down.",
		AuthorUserID: "reporter",
		AuthorName:   "Reporter",
	})
	if item.Votes != 1 || !item.YouVoted {
		t.Fatalf("expected the author's own vote to be counted, got %d votes (yours: %t)",
			item.Votes, item.YouVoted)
	}

	// And it is a real row rather than a number set on the way out: reading the
	// item back as somebody else must still see the one vote.
	read, err := store.FeedbackItemByID(t.Context(), item.ItemID, "stranger", false)
	if err != nil {
		t.Fatal(err)
	}
	if read.Votes != 1 {
		t.Fatalf("expected the author's vote to be stored, got %d", read.Votes)
	}
	if read.YouVoted {
		t.Fatal("a stranger should not be marked as having voted")
	}
}

func TestABugNeedsWordsAndASuggestionDoesNot(t *testing.T) {
	store := newFeedbackStore(t)
	if _, err := store.CreateFeedbackItem(t.Context(), NewFeedbackItem{
		Kind:         FeedbackBug,
		Title:        "Something is broken",
		AuthorUserID: "reporter",
	}); err != ErrFeedbackNeedsBody {
		t.Fatalf("expected a bug with no body to be refused, got %v", err)
	}
	if _, err := store.CreateFeedbackItem(t.Context(), NewFeedbackItem{
		Kind:         FeedbackSuggestion,
		Title:        "Add a rematch button",
		AuthorUserID: "reporter",
	}); err != nil {
		t.Fatalf("expected a suggestion to stand on its title, got %v", err)
	}
	if _, err := store.CreateFeedbackItem(t.Context(), NewFeedbackItem{
		Kind:         FeedbackSuggestion,
		Title:        "   ",
		AuthorUserID: "reporter",
	}); err != ErrFeedbackNeedsTitle {
		t.Fatalf("expected a blank title to be refused, got %v", err)
	}
}

func TestVotingTwiceIsOneVoteAndWithdrawingIsIdempotent(t *testing.T) {
	store := newFeedbackStore(t)
	item := mustPost(t, store, NewFeedbackItem{
		Kind:         FeedbackSuggestion,
		Title:        "Add a rematch button",
		AuthorUserID: "author",
		AuthorName:   "Author",
	})

	for range 2 {
		votes, err := store.SetFeedbackVote(t.Context(), item.ItemID, "voter", true)
		if err != nil {
			t.Fatal(err)
		}
		// The author's own vote plus this one, however many times it is cast.
		if votes != 2 {
			t.Fatalf("expected a double-tapped vote to count once, got %d", votes)
		}
	}
	for range 2 {
		votes, err := store.SetFeedbackVote(t.Context(), item.ItemID, "voter", false)
		if err != nil {
			t.Fatal(err)
		}
		if votes != 1 {
			t.Fatalf("expected withdrawing to be idempotent, got %d", votes)
		}
	}
	// A vote nobody ever cast, withdrawn. Not an error: see SetFeedbackVote.
	if _, err := store.SetFeedbackVote(t.Context(), item.ItemID, "stranger", false); err != nil {
		t.Fatalf("withdrawing an uncast vote should be silent, got %v", err)
	}
	if _, err := store.SetFeedbackVote(t.Context(), "no-such-item", "voter", true); err != ErrFeedbackNotFound {
		t.Fatalf("expected a vote on nothing to be refused, got %v", err)
	}
}

func TestTheBoardPutsPinnedFirstAndSettledLast(t *testing.T) {
	store := newFeedbackStore(t)
	popular := mustPost(t, store, NewFeedbackItem{
		Kind: FeedbackBug, Title: "Popular and open", Body: "b",
		AuthorUserID: "a1", AuthorName: "One",
	})
	fixed := mustPost(t, store, NewFeedbackItem{
		Kind: FeedbackBug, Title: "Fixed but adored", Body: "b",
		AuthorUserID: "a2", AuthorName: "Two",
	})
	quiet := mustPost(t, store, NewFeedbackItem{
		Kind: FeedbackBug, Title: "Quiet and open", Body: "b",
		AuthorUserID: "a3", AuthorName: "Three",
	})
	notice := mustPost(t, store, NewFeedbackItem{
		Kind: FeedbackBug, Title: "Known issue, read this first", Body: "b",
		AuthorUserID: "host", AuthorName: "Host", FromHost: true,
	})

	// The fixed one is the most voted-for thing on the board, and belongs
	// below both live items anyway. That is the whole rule.
	for _, voter := range []string{"v1", "v2", "v3", "v4"} {
		if _, err := store.SetFeedbackVote(t.Context(), fixed.ItemID, voter, true); err != nil {
			t.Fatal(err)
		}
	}
	for _, voter := range []string{"v1", "v2"} {
		if _, err := store.SetFeedbackVote(t.Context(), popular.ItemID, voter, true); err != nil {
			t.Fatal(err)
		}
	}
	done := FeedbackDone
	if _, err := store.UpdateFeedbackItem(
		t.Context(), fixed.ItemID, FeedbackEdit{Status: &done}, "",
	); err != nil {
		t.Fatal(err)
	}
	pinned := true
	if _, err := store.UpdateFeedbackItem(
		t.Context(), notice.ItemID, FeedbackEdit{Pinned: &pinned}, "",
	); err != nil {
		t.Fatal(err)
	}

	page, err := store.FeedbackItems(t.Context(), FeedbackFilter{})
	if err != nil {
		t.Fatal(err)
	}
	order := make([]string, 0, len(page.Items))
	for _, item := range page.Items {
		order = append(order, item.ItemID)
	}
	want := []string{notice.ItemID, popular.ItemID, quiet.ItemID, fixed.ItemID}
	if len(order) != len(want) {
		t.Fatalf("expected %d items, got %d", len(want), len(order))
	}
	for index := range want {
		if order[index] != want[index] {
			t.Fatalf("board out of order: got %v, want %v", order, want)
		}
	}

	// The counts beside the tabs are of live items only, and do not move with
	// the filter — see FeedbackPage.
	if page.OpenBugs != 3 || page.OpenSuggestions != 0 {
		t.Fatalf("unexpected open counts: %d bugs, %d suggestions",
			page.OpenBugs, page.OpenSuggestions)
	}
	newest, err := store.FeedbackItems(t.Context(), FeedbackFilter{Sort: FeedbackNewest})
	if err != nil {
		t.Fatal(err)
	}
	if newest.Items[0].ItemID != notice.ItemID {
		t.Fatal("pinning should hold an item at the top of the newest sort too")
	}
	if newest.Items[1].ItemID != quiet.ItemID {
		t.Fatalf("expected the newest unpinned item second, got %q", newest.Items[1].Title)
	}
}

func TestAHiddenItemIsAbsentRatherThanUnlisted(t *testing.T) {
	store := newFeedbackStore(t)
	item := mustPost(t, store, NewFeedbackItem{
		Kind: FeedbackBug, Title: "Spam", Body: "buy things",
		AuthorUserID: "spammer", AuthorName: "Spammer",
	})
	hidden := true
	if _, err := store.UpdateFeedbackItem(
		t.Context(), item.ItemID, FeedbackEdit{Hidden: &hidden}, "",
	); err != nil {
		t.Fatal(err)
	}

	page, err := store.FeedbackItems(t.Context(), FeedbackFilter{})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 0 || len(page.Items) != 0 {
		t.Fatalf("expected a hidden item to be off the board, got %d", page.Total)
	}
	// Knowing the id must not be enough, which is the difference between
	// hidden and merely unlisted.
	if _, err := store.FeedbackItemByID(t.Context(), item.ItemID, "", false); err != ErrFeedbackNotFound {
		t.Fatalf("expected a hidden item to read as missing, got %v", err)
	}
	if _, err := store.FeedbackItemByID(t.Context(), item.ItemID, "", true); err != nil {
		t.Fatalf("the host should still see it, got %v", err)
	}
	hostView, err := store.FeedbackItems(t.Context(), FeedbackFilter{IncludeHidden: true})
	if err != nil {
		t.Fatal(err)
	}
	if hostView.Total != 1 {
		t.Fatalf("expected the host to see the hidden item, got %d", hostView.Total)
	}
	// And nobody may vote on or reply to something that is not there.
	if _, err := store.SetFeedbackVote(t.Context(), item.ItemID, "voter", true); err != ErrFeedbackNotFound {
		t.Fatalf("expected voting on a hidden item to be refused, got %v", err)
	}
	if _, err := store.AddFeedbackComment(t.Context(), NewFeedbackComment{
		ItemID: item.ItemID, AuthorUserID: "talker", Body: "hello",
	}); err != ErrFeedbackNotFound {
		t.Fatalf("expected replying to a hidden item to be refused, got %v", err)
	}
}

func TestSearchingForAWildcardFindsTheWordAndNotEverything(t *testing.T) {
	store := newFeedbackStore(t)
	mustPost(t, store, NewFeedbackItem{
		Kind: FeedbackBug, Title: "Accuracy shows 100% after one move", Body: "b",
		AuthorUserID: "a1", AuthorName: "One",
	})
	mustPost(t, store, NewFeedbackItem{
		Kind: FeedbackBug, Title: "Something else entirely", Body: "b",
		AuthorUserID: "a2", AuthorName: "Two",
	})

	page, err := store.FeedbackItems(t.Context(), FeedbackFilter{Search: "100%"})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 1 {
		t.Fatalf("expected the escaped wildcard to match one item, got %d", page.Total)
	}
	// The body is searched as well as the title, which is what makes the
	// before-you-post check worth running.
	body, err := store.FeedbackItems(t.Context(), FeedbackFilter{Search: "entirely"})
	if err != nil {
		t.Fatal(err)
	}
	if body.Total != 1 {
		t.Fatalf("expected a title match, got %d", body.Total)
	}
}

func TestDeletingAnItemTakesItsVotesThreadAndDuplicatePointers(t *testing.T) {
	store := newFeedbackStore(t)
	original := mustPost(t, store, NewFeedbackItem{
		Kind: FeedbackBug, Title: "The real one", Body: "b",
		AuthorUserID: "a1", AuthorName: "One",
	})
	copycat := mustPost(t, store, NewFeedbackItem{
		Kind: FeedbackBug, Title: "The same one again", Body: "b",
		AuthorUserID: "a2", AuthorName: "Two",
	})
	if _, err := store.SetFeedbackVote(t.Context(), original.ItemID, "voter", true); err != nil {
		t.Fatal(err)
	}
	if _, err := store.AddFeedbackComment(t.Context(), NewFeedbackComment{
		ItemID: original.ItemID, AuthorUserID: "talker", AuthorName: "Talker", Body: "same here",
	}); err != nil {
		t.Fatal(err)
	}
	duplicate := FeedbackDuplicate
	if _, err := store.UpdateFeedbackItem(t.Context(), copycat.ItemID, FeedbackEdit{
		Status: &duplicate, DuplicateOf: &original.ItemID,
	}, ""); err != nil {
		t.Fatal(err)
	}

	if err := store.DeleteFeedbackItem(t.Context(), original.ItemID); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteFeedbackItem(t.Context(), original.ItemID); err != ErrFeedbackNotFound {
		t.Fatalf("expected deleting it twice to report it missing, got %v", err)
	}

	var votes, comments int
	if err := store.db.QueryRowContext(t.Context(),
		"SELECT COUNT(*) FROM feedback_votes WHERE item_id = ?", original.ItemID,
	).Scan(&votes); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRowContext(t.Context(),
		"SELECT COUNT(*) FROM feedback_comments WHERE item_id = ?", original.ItemID,
	).Scan(&comments); err != nil {
		t.Fatal(err)
	}
	if votes != 0 || comments != 0 {
		t.Fatalf("expected the votes and thread to go with it, got %d votes and %d replies",
			votes, comments)
	}

	// The duplicate still says it is one, and no longer points at a page that
	// is not there.
	after, err := store.FeedbackItemByID(t.Context(), copycat.ItemID, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if after.Status != FeedbackDuplicate {
		t.Fatalf("expected the status to stand, got %q", after.Status)
	}
	if after.DuplicateOf != "" {
		t.Fatalf("expected a dangling duplicate pointer to be cleared, got %q", after.DuplicateOf)
	}
}

func TestDeletingAnAccountKeepsThePostsAndDropsTheVotes(t *testing.T) {
	store := newFeedbackStore(t)
	if _, err := store.EnsureAccount(t.Context(), "leaver", "Leaver"); err != nil {
		t.Fatal(err)
	}
	item := mustPost(t, store, NewFeedbackItem{
		Kind: FeedbackBug, Title: "A bug they found", Body: "the details",
		AuthorUserID: "leaver", AuthorName: "Leaver",
	})
	if _, err := store.AddFeedbackComment(t.Context(), NewFeedbackComment{
		ItemID: item.ItemID, AuthorUserID: "leaver", AuthorName: "Leaver", Body: "still happening",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetFeedbackVote(t.Context(), item.ItemID, "somebody-else", true); err != nil {
		t.Fatal(err)
	}

	if _, err := store.AnonymizeAccount(t.Context(), "leaver"); err != nil {
		t.Fatal(err)
	}

	after, err := store.FeedbackItemByID(t.Context(), item.ItemID, "", false)
	if err != nil {
		t.Fatalf("the post should survive the account, got %v", err)
	}
	if after.Title != "A bug they found" || after.Body != "the details" {
		t.Fatal("the post's own words should be untouched")
	}
	if after.AuthorName != "Deleted player" || after.AuthorUserID != "" {
		t.Fatalf("expected the author to be anonymized, got %q (%q)",
			after.AuthorName, after.AuthorUserID)
	}
	// Their own vote goes; the stranger's stays.
	if after.Votes != 1 {
		t.Fatalf("expected the leaver's vote to be dropped, got %d", after.Votes)
	}
	if len(after.Thread) != 1 {
		t.Fatalf("expected the reply to survive, got %d", len(after.Thread))
	}
	if after.Thread[0].AuthorName != "Deleted player" || after.Thread[0].AuthorUserID != "" {
		t.Fatalf("expected the reply to be anonymized, got %q (%q)",
			after.Thread[0].AuthorName, after.Thread[0].AuthorUserID)
	}
}

func TestOnlyLinksThatCanBeOpenedAreAccepted(t *testing.T) {
	store := newFeedbackStore(t)
	for _, link := range []string{
		"javascript:alert(1)",
		"data:text/html,<script>",
		"file:///etc/passwd",
		"not a url at all",
		"https://",
	} {
		if _, err := store.CreateFeedbackItem(t.Context(), NewFeedbackItem{
			Kind: FeedbackSuggestion, Title: "With a link", LinkURL: link,
			AuthorUserID: "a1", AuthorName: "One",
		}); err != ErrFeedbackBadLink {
			t.Fatalf("expected %q to be refused, got %v", link, err)
		}
	}
	item, err := store.CreateFeedbackItem(t.Context(), NewFeedbackItem{
		Kind: FeedbackSuggestion, Title: "With a link",
		LinkURL:      "https://github.com/example/repo/issues/4",
		AuthorUserID: "a1", AuthorName: "One",
	})
	if err != nil {
		t.Fatal(err)
	}
	if item.LinkURL != "https://github.com/example/repo/issues/4" {
		t.Fatalf("unexpected link: %q", item.LinkURL)
	}
}

func TestAnItemCannotDuplicateItselfOrSomethingThatIsNotThere(t *testing.T) {
	store := newFeedbackStore(t)
	item := mustPost(t, store, NewFeedbackItem{
		Kind: FeedbackBug, Title: "One", Body: "b", AuthorUserID: "a1", AuthorName: "One",
	})
	missing := "no-such-item"
	if _, err := store.UpdateFeedbackItem(
		t.Context(), item.ItemID, FeedbackEdit{DuplicateOf: &item.ItemID}, "",
	); err != ErrFeedbackDuplicateOfItself {
		t.Fatalf("expected a self-reference to be refused, got %v", err)
	}
	if _, err := store.UpdateFeedbackItem(
		t.Context(), item.ItemID, FeedbackEdit{DuplicateOf: &missing}, "",
	); err != ErrFeedbackNotFound {
		t.Fatalf("expected a pointer to nothing to be refused, got %v", err)
	}
}

func TestTheStatusReadsDifferentlyForABugAndASuggestion(t *testing.T) {
	// The one thing a client must not restate for itself, and the reason
	// StatusLabel takes the kind. A single word for both is wrong for one of
	// them every time.
	cases := []struct {
		status    FeedbackStatus
		bug, idea string
	}{
		{FeedbackAccepted, "Known issue", "Planned"},
		{FeedbackDone, "Fixed", "Shipped"},
		{FeedbackDeclined, "Not a bug", "Declined"},
		{FeedbackOpen, "Open", "Open"},
		{FeedbackDuplicate, "Duplicate", "Duplicate"},
	}
	for _, testCase := range cases {
		if got := StatusLabel(FeedbackBug, testCase.status); got != testCase.bug {
			t.Errorf("bug %q: got %q, want %q", testCase.status, got, testCase.bug)
		}
		if got := StatusLabel(FeedbackSuggestion, testCase.status); got != testCase.idea {
			t.Errorf("suggestion %q: got %q, want %q", testCase.status, got, testCase.idea)
		}
	}
}

func TestAnEditThatMentionsNothingChangesNothing(t *testing.T) {
	// What the pointers in FeedbackEdit are for: a PATCH carrying only a pin
	// must not blank the note beside the status.
	store := newFeedbackStore(t)
	item := mustPost(t, store, NewFeedbackItem{
		Kind: FeedbackBug, Title: "One", Body: "b", AuthorUserID: "a1", AuthorName: "One",
	})
	note := "Fixed in the next build."
	accepted := FeedbackAccepted
	if _, err := store.UpdateFeedbackItem(t.Context(), item.ItemID, FeedbackEdit{
		Status: &accepted, StatusNote: &note,
	}, ""); err != nil {
		t.Fatal(err)
	}
	pinned := true
	after, err := store.UpdateFeedbackItem(
		t.Context(), item.ItemID, FeedbackEdit{Pinned: &pinned}, "",
	)
	if err != nil {
		t.Fatal(err)
	}
	if after.StatusNote != note || after.Status != FeedbackAccepted {
		t.Fatalf("a pin should not have touched the answer: %q / %q",
			after.Status, after.StatusNote)
	}
	if after.StatusLabel != "Known issue" {
		t.Fatalf("expected the bug's wording for accepted, got %q", after.StatusLabel)
	}
	// And an empty string is a clear, which is the other half of the rule.
	empty := ""
	cleared, err := store.UpdateFeedbackItem(
		t.Context(), item.ItemID, FeedbackEdit{StatusNote: &empty}, "",
	)
	if err != nil {
		t.Fatal(err)
	}
	if cleared.StatusNote != "" {
		t.Fatalf("expected the note to be cleared, got %q", cleared.StatusNote)
	}
}

func TestAReplyTouchesTheItemItIsOn(t *testing.T) {
	store := newFeedbackStore(t)
	item := mustPost(t, store, NewFeedbackItem{
		Kind: FeedbackBug, Title: "One", Body: "b", AuthorUserID: "a1", AuthorName: "One",
	})
	comment, err := store.AddFeedbackComment(t.Context(), NewFeedbackComment{
		ItemID: item.ItemID, AuthorUserID: "a2", AuthorName: "Two", Body: "me too",
	})
	if err != nil {
		t.Fatal(err)
	}
	after, err := store.FeedbackItemByID(t.Context(), item.ItemID, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if after.UpdatedAtUnixMs < item.UpdatedAtUnixMs {
		t.Fatal("a reply should move the item's last-touched time forwards")
	}
	if after.Comments != 1 {
		t.Fatalf("expected the reply to be counted, got %d", after.Comments)
	}

	// A hidden reply is off the thread and out of the count for everybody but
	// the host, the same as a hidden item.
	if _, err := store.HideFeedbackComment(t.Context(), comment.CommentID, true); err != nil {
		t.Fatal(err)
	}
	public, err := store.FeedbackItemByID(t.Context(), item.ItemID, "", false)
	if err != nil {
		t.Fatal(err)
	}
	if public.Comments != 0 || len(public.Thread) != 0 {
		t.Fatalf("expected a hidden reply to be absent, got %d in a thread of %d",
			public.Comments, len(public.Thread))
	}
	host, err := store.FeedbackItemByID(t.Context(), item.ItemID, "", true)
	if err != nil {
		t.Fatal(err)
	}
	if len(host.Thread) != 1 || !host.Thread[0].Hidden {
		t.Fatal("the host should still see a hidden reply, marked as hidden")
	}
	if err := store.DeleteFeedbackComment(t.Context(), comment.CommentID); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteFeedbackComment(t.Context(), comment.CommentID); err != ErrFeedbackCommentNotFound {
		t.Fatalf("expected a second delete to report it missing, got %v", err)
	}
}

func TestTheBoardPagesWithoutItsCountDisagreeing(t *testing.T) {
	// The count and the page have to be asking the same question — see
	// feedbackWhere — and that only ever goes wrong once there is enough on the
	// board to page.
	store := newFeedbackStore(t)
	for index := range 7 {
		kind := FeedbackBug
		if index%2 == 0 {
			kind = FeedbackSuggestion
		}
		mustPost(t, store, NewFeedbackItem{
			Kind: kind, Title: "Item", Body: "b",
			AuthorUserID: "a", AuthorName: "A",
		})
	}
	page, err := store.FeedbackItems(t.Context(), FeedbackFilter{
		Kind: FeedbackBug, Limit: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 3 {
		t.Fatalf("expected the total to count the filter rather than the page, got %d", page.Total)
	}
	if len(page.Items) != 2 {
		t.Fatalf("expected one page of two, got %d", len(page.Items))
	}
	rest, err := store.FeedbackItems(t.Context(), FeedbackFilter{
		Kind: FeedbackBug, Limit: 2, Offset: 2,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(rest.Items) != 1 {
		t.Fatalf("expected the last page to hold one, got %d", len(rest.Items))
	}
}

func TestTheViewersOwnVotesSurviveAFilterAndASearch(t *testing.T) {
	// The board's query mixes a numbered placeholder for the viewer with
	// anonymous ones for the filter — see feedbackSelect — and SQLite numbers
	// the anonymous ones from where the numbered one left off. Get that wrong
	// and the viewer is silently compared against a filter value, which shows
	// up as every item reading "not voted" for somebody who has voted for all
	// of them. Nothing else here would catch it: an unfiltered read passes
	// either way.
	store := newFeedbackStore(t)
	mine := mustPost(t, store, NewFeedbackItem{
		Kind: FeedbackBug, Title: "The clock keeps running", Body: "details",
		AuthorUserID: "viewer", AuthorName: "Viewer",
	})
	theirs := mustPost(t, store, NewFeedbackItem{
		Kind: FeedbackBug, Title: "The clock is fine actually", Body: "details",
		AuthorUserID: "somebody", AuthorName: "Somebody",
	})

	page, err := store.FeedbackItems(t.Context(), FeedbackFilter{
		Kind:         FeedbackBug,
		Status:       FeedbackOpen,
		Search:       "clock",
		ViewerUserID: "viewer",
	})
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 2 {
		t.Fatalf("expected both items through the filter, got %d", page.Total)
	}
	marks := map[string]bool{}
	for _, item := range page.Items {
		marks[item.ItemID] = item.YouVoted
	}
	if !marks[mine.ItemID] {
		t.Error("the viewer's own post should still read as voted for through a filter")
	}
	if marks[theirs.ItemID] {
		t.Error("somebody else's post should not read as voted for")
	}
}
