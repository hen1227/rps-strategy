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
	DisplayName      string `json:"displayName"`
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

func (server *Server) updateAccount(writer http.ResponseWriter, request *http.Request) {
	profileKey := bearerToken(request)
	if profileKey == "" {
		writer.Header().Set("WWW-Authenticate", `Bearer realm="account-profile"`)
		writeAPIError(writer, http.StatusUnauthorized, "local account key is required")
		return
	}
	var input updateAccountRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if usesReservedIdentity(input.DisplayName, input.Discord) &&
		!server.hasValidAdminTokenValue(input.ReservationToken) {
		writeAPIError(writer, http.StatusForbidden, "this username or Discord handle is reserved; paste the special token")
		return
	}
	account, err := server.data.UpdateAccountProfile(
		request.Context(),
		request.PathValue("userID"),
		profileKey,
		input.DisplayName,
		input.Discord,
	)
	if err != nil {
		switch {
		case errors.Is(err, persistence.ErrInvalidProfileKey):
			writeAPIError(writer, http.StatusUnauthorized, "local account key is invalid")
		case errors.Is(err, persistence.ErrAccountNotFound):
			writeAPIError(writer, http.StatusNotFound, err.Error())
		case errors.Is(err, persistence.ErrInvalidAccountProfile):
			message := strings.TrimPrefix(
				err.Error(),
				persistence.ErrInvalidAccountProfile.Error()+": ",
			)
			writeAPIError(writer, http.StatusBadRequest, message)
		default:
			writeAPIError(writer, http.StatusInternalServerError, "account profile is unavailable")
		}
		return
	}
	writeJSON(writer, http.StatusOK, account)
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
