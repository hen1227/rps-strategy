package server

import (
	"net/http"
	"strings"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// The bot-versus-bot record, as a page of finished games.
//
// Public and unauthenticated, like the ladder it sits under: these are games two
// programs played in front of whoever was watching, and a scoreboard that would
// not say which games it was counting is not much of a scoreboard.
//
// `botId` may be repeated, which is what the leaderboard sends — the ids of the
// bots it just listed — so that "recent games" on a board of the top eight is
// their games rather than whatever happened to be most recent on the server.
func (server *Server) getBotMatches(writer http.ResponseWriter, request *http.Request) {
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

	// Accepted as bot *account* ids, which is what a game record and a
	// leaderboard row both carry. A registry bot id would be the wrong key here:
	// the games are filed against the account the bot plays as.
	identifiers := make([]string, 0, 8)
	for _, value := range request.URL.Query()["botId"] {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			identifiers = append(identifiers, trimmed)
		}
	}

	modeID := strings.TrimSpace(request.URL.Query().Get("mode"))
	if modeID != "" && !server.registry.Has(game.ModeID(modeID)) {
		// A 400 rather than an empty list, for the reason the ladder gives: an
		// empty list reads as "these bots have not played", and a typo should
		// not be able to say that.
		writeAPIError(writer, http.StatusBadRequest, "unknown game mode")
		return
	}

	matches, err := server.data.BotMatches(request.Context(), persistence.BotMatchFilter{
		BotUserIDs: identifiers,
		ModeID:     modeID,
		Limit:      limit,
		Offset:     offset,
	})
	if err != nil {
		writePersistenceError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, matches)
}
