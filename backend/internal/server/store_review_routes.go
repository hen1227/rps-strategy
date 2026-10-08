package server

import (
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"

	"rps-strategy/backend/internal/persistence"
)

// The admin side of store review accounts, the sign-ins App Review and Google
// Play's reviewers are given. persistence/store_review.go says what they are and
// why they exist; deploy/store-review-account.sh is what calls these.

type storeReviewRequest struct {
	Username    string `json:"username"`
	NewPassword bool   `json:"newPassword"`
}

func (server *Server) listStoreReviewAccounts(writer http.ResponseWriter, request *http.Request) {
	accounts, err := server.data.StoreReviewAccounts(request.Context())
	if err != nil {
		writeStoreReviewError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{"accounts": accounts})
}

// resetStoreReviewAccount makes a label's account, or puts it back the way the
// store was told it is. The reply carries the password only when it changed.
func (server *Server) resetStoreReviewAccount(writer http.ResponseWriter, request *http.Request) {
	var input storeReviewRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	label := request.PathValue("label")
	reset, err := server.data.ResetStoreReviewAccount(request.Context(), label,
		persistence.StoreReviewOptions{Username: input.Username, NewPassword: input.NewPassword})
	if err != nil {
		writeStoreReviewError(writer, err)
		return
	}
	// Proved rather than assumed. A new password is about to be pasted into a
	// console and read by a reviewer days from now, which is the worst possible
	// time to find out it does not work, so it goes through the same check the
	// login route makes before anybody is shown it.
	if reset.Password != "" {
		if _, err := server.data.AuthenticateAccount(
			request.Context(), reset.Username, reset.Password,
		); err != nil {
			log.Printf("store review account %q: the new password does not sign in: %v", label, err)
			writeAPIError(writer, http.StatusInternalServerError,
				"the account was reset but its new password does not sign in; reset it again")
			return
		}
	}
	// The sessions are gone from the table, but a socket that authenticated
	// with one stays open until it is told otherwise.
	if reset.SessionsRevoked > 0 {
		server.disconnectAccount(reset.UserID, "this review account was reset; sign in again")
	}
	log.Printf("store review account %q (%s): %s", label, reset.Username, describeStoreReviewReset(reset))
	writeJSON(writer, http.StatusOK, reset)
}

// describeStoreReviewReset is the log line: everything the reset did, and never
// the password itself.
func describeStoreReviewReset(reset persistence.StoreReviewReset) string {
	var changes []string
	if reset.Created {
		changes = append(changes, "made a new account")
	}
	if reset.RenamedFrom != "" {
		changes = append(changes, "renamed back from "+reset.RenamedFrom)
	}
	if reset.ReEnabled {
		changes = append(changes, "re-enabled")
	}
	if reset.SessionsRevoked > 0 {
		changes = append(changes, "signed out "+strconv.FormatInt(reset.SessionsRevoked, 10)+" session(s)")
	}
	if reset.Password != "" {
		changes = append(changes, "new password")
	}
	if len(changes) == 0 {
		return "already as the store was told"
	}
	return strings.Join(changes, ", ")
}

func writeStoreReviewError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, persistence.ErrInvalidStoreReview),
		errors.Is(err, persistence.ErrInvalidUsername):
		writeAPIError(writer, http.StatusBadRequest, err.Error())
	case errors.Is(err, persistence.ErrUsernameTaken):
		// The name the store has on file belongs to somebody else now, and the
		// only fix is a different one — which the store then has to be told.
		writeAPIError(writer, http.StatusConflict,
			"that username belongs to another account; choose a different one")
	default:
		writeAPIError(writer, http.StatusInternalServerError, err.Error())
	}
}
