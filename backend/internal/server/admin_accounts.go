package server

import (
	"errors"
	"net/http"
	"strconv"

	"rps-strategy/backend/internal/persistence"
)

type updateAccountAdminRequest struct {
	Disabled *bool `json:"disabled,omitempty"`
	IsAdmin  *bool `json:"isAdmin,omitempty"`
}

// listAccounts is the admin account browser.
func (server *Server) listAccounts(writer http.ResponseWriter, request *http.Request) {
	limit, _ := strconv.Atoi(request.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(request.URL.Query().Get("offset"))
	accounts, err := server.data.SearchAccounts(
		request.Context(), request.URL.Query().Get("query"), limit, offset,
	)
	if err != nil {
		writeAdminAccountError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, accounts)
}

// updateAccountAdmin toggles the two flags an administrator owns.
//
// Both are optional and applied independently, so a client that only wants to
// disable somebody does not have to restate their admin status and risk
// clobbering it.
func (server *Server) updateAccountAdmin(writer http.ResponseWriter, request *http.Request) {
	userID := request.PathValue("userID")
	var input updateAccountAdminRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if input.Disabled != nil {
		if err := server.data.SetAccountDisabled(request.Context(), userID, *input.Disabled); err != nil {
			writeAdminAccountError(writer, err)
			return
		}
		if *input.Disabled {
			// A ban that leaves the banned player sitting in the lobby is not
			// one yet.
			server.disconnectAccount(userID, "this account has been disabled")
		}
	}
	if input.IsAdmin != nil {
		if err := server.data.SetAccountAdmin(request.Context(), userID, *input.IsAdmin); err != nil {
			writeAdminAccountError(writer, err)
			return
		}
	}
	account, err := server.data.Account(request.Context(), userID)
	if err != nil {
		writeAdminAccountError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, account)
}

// deleteAccount anonymizes rather than deletes, whenever the account has
// played. See persistence.AnonymizeAccount for why that is not a shortcut.
func (server *Server) deleteAccount(writer http.ResponseWriter, request *http.Request) {
	userID := request.PathValue("userID")
	rewritten, err := server.data.AnonymizeAccount(request.Context(), userID)
	if err != nil {
		writeAdminAccountError(writer, err)
		return
	}
	server.disconnectAccount(userID, "this account has been removed")
	writeJSON(writer, http.StatusOK, map[string]any{
		"anonymized":       true,
		"recordsRewritten": rewritten,
	})
}

// disconnectAccount closes every connection an account holds.
func (server *Server) disconnectAccount(userID string, reason string) {
	for _, client := range server.connectedClients() {
		if client.profile.UserID != userID {
			continue
		}
		client.Send(ServerMessage{Type: "authentication_failed", Message: reason})
		client.close()
	}
}

func writeAdminAccountError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, persistence.ErrAccountNotFound):
		writeAPIError(writer, http.StatusNotFound, "no such account")
	case errors.Is(err, persistence.ErrLastAdministrator):
		writeAPIError(writer, http.StatusConflict, err.Error())
	default:
		writeAPIError(writer, http.StatusInternalServerError, err.Error())
	}
}
