package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"rps-strategy/backend/internal/persistence"
)

func (server *Server) getAccount(writer http.ResponseWriter, request *http.Request) {
	account, err := server.data.Account(request.Context(), request.PathValue("userID"))
	if err != nil {
		writePersistenceError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, account)
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
