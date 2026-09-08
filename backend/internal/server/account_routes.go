package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"rps-strategy/backend/internal/persistence"
)

type updateAccountRequest struct {
	Username         string `json:"username"`
	Discord          string `json:"discord"`
	ReservationToken string `json:"reservationToken"`
}

func (server *Server) getAccount(writer http.ResponseWriter, request *http.Request) {
	account, err := server.data.Account(request.Context(), request.PathValue("userID"))
	if err != nil {
		writePersistenceError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, account)
}

// updateAccount renames the signed-in account and sets its Discord handle.
//
// Editing a profile takes a session rather than the browser's local key: a
// name is part of the account system now, so there is no anonymous profile to
// edit and no way to wear a name without having claimed it.
func (server *Server) updateAccount(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireSession(writer, request)
	if !ok {
		return
	}
	// The path says whose account this is, and a client that has drifted out of
	// step with its own session should hear about it rather than quietly edit
	// the wrong row.
	if request.PathValue("userID") != account.UserID {
		writeAPIError(writer, http.StatusForbidden, "you can only edit your own account")
		return
	}
	var input updateAccountRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	// The username only. The Discord handle used to be checked here too, back
	// when it was free text somebody could type — the rule existed to stop
	// people claiming a handle they did not own. Discord answers that now, so
	// the check would prevent no impersonation while permanently locking out
	// any real Discord user whose handle happened to match a reserved name.
	if persistence.IsReservedUsername(input.Username) &&
		!account.IsAdmin && !server.hasValidAdminTokenValue(input.ReservationToken) {
		writeAPIError(
			writer,
			http.StatusForbidden,
			"this username is reserved; paste the special token",
		)
		return
	}
	updated, err := server.data.UpdateAccountProfile(
		request.Context(),
		account.UserID,
		input.Username,
		input.Discord,
	)
	if err != nil {
		writeAuthError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, updated)
}

func bearerToken(request *http.Request) string {
	authorization := strings.TrimSpace(request.Header.Get("Authorization"))
	scheme, token, found := strings.Cut(authorization, " ")
	if !found || !strings.EqualFold(scheme, "Bearer") {
		return ""
	}
	return strings.TrimSpace(token)
}

func (server *Server) getGameHistory(writer http.ResponseWriter, request *http.Request) {
	limit, err := nonNegativeQueryInteger(request, "limit", 20)
	if err != nil {
		http.Error(writer, err.Error(), http.StatusBadRequest)
		return
	}
	offset, err := nonNegativeQueryInteger(request, "offset", 0)
	if err != nil {
		http.Error(writer, err.Error(), http.StatusBadRequest)
		return
	}
	records, err := server.data.GameHistory(
		request.Context(),
		request.PathValue("userID"),
		limit,
		offset,
	)
	if err != nil {
		writePersistenceError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, records)
}

func (server *Server) getHeadToHeadRecord(writer http.ResponseWriter, request *http.Request) {
	record, err := server.data.HeadToHead(
		request.Context(),
		request.PathValue("userID"),
		request.PathValue("opponentID"),
	)
	if err != nil {
		writePersistenceError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, record)
}

func writeJSON(writer http.ResponseWriter, status int, payload any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(payload)
}

func writePersistenceError(writer http.ResponseWriter, err error) {
	if errors.Is(err, persistence.ErrAccountNotFound) {
		http.Error(writer, err.Error(), http.StatusNotFound)
		return
	}
	http.Error(writer, "persistent data is unavailable", http.StatusInternalServerError)
}

func nonNegativeQueryInteger(request *http.Request, key string, fallback int) (int, error) {
	value := request.URL.Query().Get(key)
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed < 0 {
		return 0, &queryIntegerError{key: key}
	}
	return parsed, nil
}

type queryIntegerError struct {
	key string
}

func (err *queryIntegerError) Error() string {
	return err.key + " must be a non-negative integer"
}
