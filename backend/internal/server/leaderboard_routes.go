package server

import (
	"net/http"
	"strings"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// The public ladder.
//
// One route serves both boards. They are the same question — who is winning —
// asked of two populations, and a `kind` parameter says which; splitting them
// into two routes would duplicate the paging and the mode filter to say nothing
// extra. An unknown mode is a 400 rather than an empty board, because an empty
// board looks like "nobody has played this yet" and a typo should not be able
// to say that.
func (server *Server) getLeaderboard(writer http.ResponseWriter, request *http.Request) {
	limit, err := nonNegativeQueryInteger(request, "limit", 0)
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	offset, err := nonNegativeQueryInteger(request, "offset", 0)
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	minimumGames, err := nonNegativeQueryInteger(request, "minGames", 0)
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}

	modeID := strings.TrimSpace(request.URL.Query().Get("mode"))
	if modeID != "" && !server.registry.Has(game.ModeID(modeID)) {
		writeAPIError(writer, http.StatusBadRequest, "unknown game mode")
		return
	}

	kind := strings.ToLower(strings.TrimSpace(request.URL.Query().Get("kind")))
	switch kind {
	case "", persistence.LeaderboardKindHuman, persistence.LeaderboardKindBot:
	default:
		writeAPIError(writer, http.StatusBadRequest, "kind must be human or bot")
		return
	}

	entries, err := server.data.Leaderboard(request.Context(), persistence.LeaderboardFilter{
		ModeID:       modeID,
		Kind:         kind,
		MinimumGames: minimumGames,
		Limit:        limit,
		Offset:       offset,
	})
	if err != nil {
		writePersistenceError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, entries)
}
