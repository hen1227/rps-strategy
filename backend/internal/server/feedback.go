package server

import (
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"rps-strategy/backend/internal/persistence"
	"rps-strategy/backend/internal/textfilter"
)

// The feedback board's routes: a public read, a verified write, and the host's
// pass over both.
//
// persistence/feedback.go holds the shape of the board and the reasoning
// behind it. This file is who may do what.
//
// # Why reading is open and writing is not
//
// Reading takes no credential at all. The whole point of a public board is that
// the person about to report a bug for the fortieth time finds it already
// there, answered — and that person is not signed in, because they arrived
// five minutes ago and something broke.
//
// Writing takes a Discord-verified account, which is a higher bar than anything
// else a player can do here: chat needs only a browser, and a report needs
// nothing at all. The difference is that a report is read once by one person
// and a post is read by everybody, forever, and carries a tally that decides
// what gets fixed first. Every browser that opens this site owns an account
// already, so anything short of Discord would make the vote count a measure of
// how many times somebody cleared their cookies.
//
// The bar is also the reason the refusals below name the page that clears it.
// "Sign in" is not an instruction when the player is already signed in.

const (
	// feedbackPostWindow and feedbackPostsPerWindow bound how fast one account
	// can post. Five an hour: more than anybody has bugs to report in one
	// sitting, and low enough that the board cannot be filled faster than one
	// person can read it.
	//
	// Counted in the database rather than in memory, for the reason
	// ReportsSinceBy gives: reconnecting must not reset it, and neither must a
	// deploy.
	feedbackPostWindow     = time.Hour
	feedbackPostsPerWindow = 5
	// The thread is bounded more generously than the board, because a
	// conversation is several messages and a post is one. Thirty an hour is a
	// long argument and still not a flood.
	feedbackCommentWindow     = time.Hour
	feedbackCommentsPerWindow = 30
)

/* ----------------------------------------------------------- who is asking -- */

// requireVerifiedAccount resolves a Discord-verified account, writing the
// refusal itself and returning false when there is not one.
//
// Three different refusals rather than one, because they need three different
// things done about them and a single "you may not post" leaves the player
// guessing which. requireSession covers the first; this adds the other two.
func (server *Server) requireVerifiedAccount(
	writer http.ResponseWriter,
	request *http.Request,
	what string,
) (persistence.Account, bool) {
	account, ok := server.requireSession(writer, request)
	if !ok {
		return persistence.Account{}, false
	}
	if !account.DiscordVerified {
		writeAPIError(
			writer, http.StatusForbidden,
			"verify your account with Discord before you can "+what,
		)
		return persistence.Account{}, false
	}
	// A mute is a mute everywhere somebody can be heard. A board post is
	// louder than a chat line, not quieter, so an account silenced in chat
	// that could still post here would not be silenced at all.
	if refusal := server.mutedRefusal(account.UserID, what); refusal != "" {
		writeAPIError(writer, http.StatusForbidden, refusal)
		return persistence.Account{}, false
	}
	return account, true
}

/* ------------------------------------------------------------ reading it -- */

// getFeedback is the board.
func (server *Server) getFeedback(writer http.ResponseWriter, request *http.Request) {
	query := request.URL.Query()
	limit, _ := strconv.Atoi(query.Get("limit"))
	offset, _ := strconv.Atoi(query.Get("offset"))

	// Signed in or not: a reader with a session sees which items they have
	// already voted for, and one without sees the same board with no marks on
	// it. Neither is refused — see the note at the top of this file.
	viewerID := ""
	if account, ok := server.optionalSession(request); ok {
		viewerID = account.UserID
	}
	page, err := server.data.FeedbackItems(request.Context(), persistence.FeedbackFilter{
		Kind:          persistence.FeedbackKind(strings.TrimSpace(query.Get("kind"))),
		Status:        persistence.FeedbackStatus(strings.TrimSpace(query.Get("status"))),
		Search:        strings.TrimSpace(query.Get("q")),
		Sort:          persistence.FeedbackSort(strings.TrimSpace(query.Get("sort"))),
		ViewerUserID:  viewerID,
		IncludeHidden: server.requestIsAdmin(request),
		Limit:         limit,
		Offset:        offset,
	})
	if err != nil {
		writeFeedbackError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, page)
}

// getFeedbackItem is one item and its thread.
func (server *Server) getFeedbackItem(writer http.ResponseWriter, request *http.Request) {
	viewerID := ""
	if account, ok := server.optionalSession(request); ok {
		viewerID = account.UserID
	}
	item, err := server.data.FeedbackItemByID(
		request.Context(),
		request.PathValue("itemID"),
		viewerID,
		server.requestIsAdmin(request),
	)
	if err != nil {
		writeFeedbackError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, item)
}

// feedbackPolicy publishes what the board accepts, so the form does not restate
// it and then drift from what the server will take.
//
// The same reasoning as /api/reports/categories and /api/identity/policy. It
// also answers the one question the form cannot work out for itself: whether
// *this* visitor may post, and what to say if not. That is three different
// sentences depending on whether they are signed out, unverified, or muted, and
// the server is the only side that knows which.
func (server *Server) feedbackPolicy(writer http.ResponseWriter, request *http.Request) {
	type kind struct {
		ID    persistence.FeedbackKind `json:"id"`
		Label string                   `json:"label"`
	}
	type status struct {
		ID persistence.FeedbackStatus `json:"id"`
		// One label per kind, because a bug is fixed and a suggestion ships.
		// See persistence.StatusLabel.
		BugLabel        string `json:"bugLabel"`
		SuggestionLabel string `json:"suggestionLabel"`
		Settled         bool   `json:"settled,omitempty"`
	}

	kinds := make([]kind, 0, len(persistence.FeedbackKinds))
	for _, id := range persistence.FeedbackKinds {
		kinds = append(kinds, kind{ID: id, Label: id.Label()})
	}
	statuses := make([]status, 0, len(persistence.FeedbackStatuses))
	for _, id := range persistence.FeedbackStatuses {
		statuses = append(statuses, status{
			ID:              id,
			BugLabel:        persistence.StatusLabel(persistence.FeedbackBug, id),
			SuggestionLabel: persistence.StatusLabel(persistence.FeedbackSuggestion, id),
			Settled:         id.Settled(),
		})
	}

	mayPost, refusal := false, "sign in with Discord to post on the board"
	if account, ok := server.optionalSession(request); ok {
		muted := server.mutedRefusal(account.UserID, "post on the board")
		switch {
		case !account.DiscordVerified:
			refusal = "verify your account with Discord to post on the board"
		case muted != "":
			refusal = muted
		default:
			mayPost, refusal = true, ""
		}
	}

	writeJSON(writer, http.StatusOK, map[string]any{
		"kinds":       kinds,
		"statuses":    statuses,
		"maxTitle":    persistence.MaximumFeedbackTitleRunes,
		"maxBody":     persistence.MaximumFeedbackBodyRunes,
		"maxComment":  persistence.MaximumFeedbackCommentRunes,
		"mayPost":     mayPost,
		"postRefusal": refusal,
		"contactName": moderationContact,
	})
}

/* ------------------------------------------------------------- posting -- */

type newFeedbackRequest struct {
	Kind  string `json:"kind"`
	Title string `json:"title"`
	Body  string `json:"body"`
	// LinkURL is somewhere else to look — an issue, a thread, a video of the
	// bug. Validated to http(s) in the store, because it is rendered as a
	// tappable link on everybody else's screen.
	LinkURL string `json:"linkUrl"`
	// GameID is the game it happened in, filled in by the finished-game card.
	GameID string `json:"gameId"`
	// AppVersion and Platform are the client's word about itself. Taken rather
	// than sniffed: the user agent of a React Native app says nothing useful,
	// and the build number is the thing that decides whether a bug is already
	// fixed.
	AppVersion string `json:"appVersion"`
	Platform   string `json:"platform"`
}

// postFeedback adds an item to the board.
func (server *Server) postFeedback(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireVerifiedAccount(writer, request, "post on the board")
	if !ok {
		return
	}
	var input newFeedbackRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	kind := persistence.FeedbackKind(strings.TrimSpace(input.Kind))
	if !kind.Valid() {
		writeAPIError(writer, http.StatusBadRequest, "say whether this is a bug or a suggestion")
		return
	}
	if !server.allowFeedbackPost(writer, request, account) {
		return
	}
	if refused := feedbackTextRefusal(writer, account.UserID, input.Title, input.Body); refused {
		return
	}

	item, err := server.data.CreateFeedbackItem(request.Context(), persistence.NewFeedbackItem{
		Kind:         kind,
		Title:        input.Title,
		Body:         input.Body,
		AuthorUserID: account.UserID,
		AuthorName:   account.Username,
		// The badge records what was true when it was written, rather than
		// being derived at read time from a flag that can be taken away. See
		// FeedbackItem.FromHost.
		FromHost:   account.IsAdmin,
		LinkURL:    input.LinkURL,
		GameID:     input.GameID,
		AppVersion: input.AppVersion,
		Platform:   input.Platform,
	})
	if err != nil {
		writeFeedbackError(writer, err)
		return
	}
	log.Printf("feedback %s (%s) posted by %s", item.ItemID, item.Kind, account.UserID)
	writeJSON(writer, http.StatusCreated, item)
}

// allowFeedbackPost spends this account's hourly allowance, writing the 429
// itself.
//
// The host is exempt, and deliberately: posting the known issues is one of the
// things this board is *for*, and a host writing up eight of them in one
// sitting would otherwise be told to come back in an hour by their own server.
func (server *Server) allowFeedbackPost(
	writer http.ResponseWriter,
	request *http.Request,
	account persistence.Account,
) bool {
	if account.IsAdmin {
		return true
	}
	recent, err := server.data.FeedbackItemsSinceBy(
		request.Context(), account.UserID, time.Now().Add(-feedbackPostWindow).UnixMilli(),
	)
	if err != nil {
		writeFeedbackError(writer, err)
		return false
	}
	if recent >= feedbackPostsPerWindow {
		writeAPIError(
			writer,
			http.StatusTooManyRequests,
			"you have posted several times recently; they are all on the board, "+
				"and you can post again in an hour",
		)
		return false
	}
	return true
}

// feedbackTextRefusal runs what somebody typed past the word list, and reports
// whether it was refused.
//
// Every field at once rather than one call per field, because a refusal reads
// the same whichever field tripped it — and deliberately does not quote the
// word back. See textfilter.Match.Term, and the chat refusal that makes the
// same two choices.
func feedbackTextRefusal(
	writer http.ResponseWriter,
	userID string,
	fields ...string,
) bool {
	for _, field := range fields {
		match, found := textfilter.Check(field)
		if !found {
			continue
		}
		log.Printf("feedback refused for %s: matched %q", userID, match.Term)
		writeAPIError(
			writer, http.StatusBadRequest,
			"that contains language this server does not carry",
		)
		return true
	}
	return false
}

/* --------------------------------------------------------------- voting -- */

// voteOnFeedback casts this account's vote, and dropVoteOnFeedback withdraws
// it. Both answer with the tally as it stands, so the button that was pressed
// can show the number it produced without a second round trip.
func (server *Server) voteOnFeedback(writer http.ResponseWriter, request *http.Request) {
	server.setFeedbackVote(writer, request, true)
}

func (server *Server) dropVoteOnFeedback(writer http.ResponseWriter, request *http.Request) {
	server.setFeedbackVote(writer, request, false)
}

func (server *Server) setFeedbackVote(
	writer http.ResponseWriter,
	request *http.Request,
	voted bool,
) {
	// Verified to vote, for the reason at the top of this file: every browser
	// here owns an account already, so a vote that only needed one would count
	// browsers rather than people.
	//
	// Withdrawing asks the same, rather than being the one direction anybody
	// may take: a vote can only be withdrawn by the account that cast it, so
	// the check costs nothing and the alternative is a route where an
	// unverified caller gets a different error for the same action.
	account, ok := server.requireVerifiedAccount(writer, request, "vote on the board")
	if !ok {
		return
	}
	votes, err := server.data.SetFeedbackVote(
		request.Context(), request.PathValue("itemID"), account.UserID, voted,
	)
	if err != nil {
		writeFeedbackError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"votes": votes, "youVoted": voted})
}

/* ------------------------------------------------------------- replying -- */

type newFeedbackCommentRequest struct {
	Body string `json:"body"`
}

// commentOnFeedback adds a reply to a thread.
func (server *Server) commentOnFeedback(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireVerifiedAccount(writer, request, "reply on the board")
	if !ok {
		return
	}
	var input newFeedbackCommentRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if !account.IsAdmin {
		recent, err := server.data.FeedbackCommentsSinceBy(
			request.Context(),
			account.UserID,
			time.Now().Add(-feedbackCommentWindow).UnixMilli(),
		)
		if err != nil {
			writeFeedbackError(writer, err)
			return
		}
		if recent >= feedbackCommentsPerWindow {
			writeAPIError(
				writer, http.StatusTooManyRequests,
				"you have replied a lot in the last hour; try again shortly",
			)
			return
		}
	}
	if refused := feedbackTextRefusal(writer, account.UserID, input.Body); refused {
		return
	}

	comment, err := server.data.AddFeedbackComment(
		request.Context(),
		persistence.NewFeedbackComment{
			ItemID:       request.PathValue("itemID"),
			AuthorUserID: account.UserID,
			AuthorName:   account.Username,
			FromHost:     account.IsAdmin,
			Body:         input.Body,
		},
	)
	if err != nil {
		writeFeedbackError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, comment)
}

/* ------------------------------------------------------------- removing -- */

// deleteFeedbackItem removes a post, at the request of whoever wrote it or of
// the host.
//
// The author may delete their own, which is not true of a report and is true
// here for the obvious reason: a report is evidence somebody else acts on, and
// a post is your own words on a public board. What the author cannot do is
// delete somebody else's reply to it — the thread goes with the item because
// the item is what the thread is about, and that is a cost of posting rather
// than a power over other people.
func (server *Server) deleteFeedbackItem(writer http.ResponseWriter, request *http.Request) {
	itemID := request.PathValue("itemID")
	item, err := server.data.FeedbackItemByID(request.Context(), itemID, "", true)
	if err != nil {
		writeFeedbackError(writer, err)
		return
	}
	if !server.mayRemoveFeedback(writer, request, item.AuthorUserID) {
		return
	}
	if err := server.data.DeleteFeedbackItem(request.Context(), itemID); err != nil {
		writeFeedbackError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"deleted": true})
}

// deleteFeedbackComment removes one reply, on the same rule.
func (server *Server) deleteFeedbackComment(writer http.ResponseWriter, request *http.Request) {
	comment, ok := server.commentOnThisItem(writer, request)
	if !ok {
		return
	}
	if !server.mayRemoveFeedback(writer, request, comment.AuthorUserID) {
		return
	}
	if err := server.data.DeleteFeedbackComment(request.Context(), comment.CommentID); err != nil {
		writeFeedbackError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"deleted": true})
}

// commentOnThisItem resolves the reply an address names, and refuses one that
// is on a different item than the address says.
//
// A comment id is unique on its own, so this check is not needed to find the
// row — it is needed so the address cannot lie. `/api/feedback/A/comments/x`
// where x is on item B would otherwise work, which makes every link to a reply
// unverifiable and every log line about one misleading about where it was.
func (server *Server) commentOnThisItem(
	writer http.ResponseWriter,
	request *http.Request,
) (persistence.FeedbackComment, bool) {
	comment, err := server.data.FeedbackCommentByID(
		request.Context(), request.PathValue("commentID"),
	)
	if err != nil {
		writeFeedbackError(writer, err)
		return persistence.FeedbackComment{}, false
	}
	if comment.ItemID != request.PathValue("itemID") {
		writeFeedbackError(writer, persistence.ErrFeedbackCommentNotFound)
		return persistence.FeedbackComment{}, false
	}
	return comment, true
}

// mayRemoveFeedback answers whether this request may remove something that
// account wrote, writing the refusal itself.
//
// The administrator check comes first and takes the shared host token as well
// as an account, which is the same rule requestIsAdmin states everywhere else:
// the token is how the host gets in when there is no session to use.
//
// An anonymized author — an empty id, left by a deleted account — matches
// nobody. That is the point: an id that could be issued again must not carry
// authority over a stranger's post. See AnonymizeFeedbackAuthorshipTx.
func (server *Server) mayRemoveFeedback(
	writer http.ResponseWriter,
	request *http.Request,
	authorUserID string,
) bool {
	if server.requestIsAdmin(request) {
		return true
	}
	account, ok := server.requireSession(writer, request)
	if !ok {
		return false
	}
	if authorUserID == "" || account.UserID != authorUserID {
		writeAPIError(writer, http.StatusForbidden, "you can only remove your own posts")
		return false
	}
	return true
}

/* ------------------------------------------------------- the host's pass -- */

type feedbackEditRequest struct {
	// Every field is a pointer, so that a body which does not mention a field
	// leaves it alone and one that sends an empty string clears it. See
	// persistence.FeedbackEdit.
	Kind        *string `json:"kind"`
	Status      *string `json:"status"`
	StatusNote  *string `json:"statusNote"`
	LinkURL     *string `json:"linkUrl"`
	DuplicateOf *string `json:"duplicateOf"`
	Pinned      *bool   `json:"pinned"`
	Hidden      *bool   `json:"hidden"`
	Title       *string `json:"title"`
}

// updateFeedbackItem is the host answering: a status, a note beside it, a link
// out, a pin, or an item taken off the board.
func (server *Server) updateFeedbackItem(writer http.ResponseWriter, request *http.Request) {
	var input feedbackEditRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	edit := persistence.FeedbackEdit{
		StatusNote:  input.StatusNote,
		LinkURL:     input.LinkURL,
		DuplicateOf: input.DuplicateOf,
		Pinned:      input.Pinned,
		Hidden:      input.Hidden,
		Title:       input.Title,
	}
	if input.Kind != nil {
		kind := persistence.FeedbackKind(strings.TrimSpace(*input.Kind))
		edit.Kind = &kind
	}
	if input.Status != nil {
		status := persistence.FeedbackStatus(strings.TrimSpace(*input.Status))
		edit.Status = &status
	}
	// The viewer is whoever is holding the admin session, so the item comes
	// back marked with their own vote rather than with nobody's — the board
	// redraws from this answer, and a host who had voted for something should
	// not watch their vote disappear because they pinned it.
	//
	// Empty for an administrator holding the shared token, who has no account
	// to name — the same resolution resolveReport makes, for the same reason.
	viewerID := ""
	if account, ok := server.optionalSession(request); ok {
		viewerID = account.UserID
	}

	// The host's own words go past the same list everybody else's do. Not
	// ceremony: the note is published beside somebody else's post, and a slip
	// there is the one nobody else can moderate.
	if input.StatusNote != nil || input.Title != nil {
		fields := []string{}
		if input.StatusNote != nil {
			fields = append(fields, *input.StatusNote)
		}
		if input.Title != nil {
			fields = append(fields, *input.Title)
		}
		if feedbackTextRefusal(writer, viewerID, fields...) {
			return
		}
	}
	item, err := server.data.UpdateFeedbackItem(
		request.Context(), request.PathValue("itemID"), edit, viewerID,
	)
	if err != nil {
		writeFeedbackError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, item)
}

type hideCommentRequest struct {
	Hidden bool `json:"hidden"`
}

// hideFeedbackComment takes one reply off a thread, or puts it back.
func (server *Server) hideFeedbackComment(writer http.ResponseWriter, request *http.Request) {
	var input hideCommentRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	existing, ok := server.commentOnThisItem(writer, request)
	if !ok {
		return
	}
	comment, err := server.data.HideFeedbackComment(
		request.Context(), existing.CommentID, input.Hidden,
	)
	if err != nil {
		writeFeedbackError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, comment)
}

func writeFeedbackError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, persistence.ErrFeedbackNotFound):
		writeAPIError(writer, http.StatusNotFound, "no such item on the board")
	case errors.Is(err, persistence.ErrFeedbackCommentNotFound):
		writeAPIError(writer, http.StatusNotFound, "no such reply")
	case errors.Is(err, persistence.ErrUnknownFeedbackKind),
		errors.Is(err, persistence.ErrUnknownFeedbackStatus),
		errors.Is(err, persistence.ErrFeedbackNeedsTitle),
		errors.Is(err, persistence.ErrFeedbackNeedsBody),
		errors.Is(err, persistence.ErrFeedbackNeedsText),
		errors.Is(err, persistence.ErrFeedbackBadLink),
		errors.Is(err, persistence.ErrFeedbackDuplicateOfItself):
		writeAPIError(writer, http.StatusBadRequest, err.Error())
	case errors.Is(err, persistence.ErrAccountNotFound):
		writeAPIError(writer, http.StatusUnauthorized, "sign in to do that")
	default:
		log.Printf("feedback board: %v", err)
		writeAPIError(writer, http.StatusInternalServerError, err.Error())
	}
}
