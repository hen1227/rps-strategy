package server

import (
	"errors"
	"log"
	"net/http"
	"strconv"
	"time"

	"rps-strategy/backend/internal/persistence"
)

// The public player pages, and the directory of them.
//
// Unauthenticated, cacheable, and deliberately thin: everything interesting is
// in persistence/profile.go, including the rule about who has a page at all.
// What is here is the shape of the addresses, and one decision that is not
// obvious from the store's side —
//
// **`GET /api/players/{handle}` takes a name or an id.** The store resolves
// either. That is what lets `/player?user=yuki` be a link somebody types while
// a badge on a game record can link by the id it already has, without the
// client having to know which kind of string it is holding.

// getPlayerProfile is one player's page.
func (server *Server) getPlayerProfile(writer http.ResponseWriter, request *http.Request) {
	limit, err := nonNegativeQueryInteger(request, "games", 20)
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	profile, err := server.data.PublicProfile(
		request.Context(), request.PathValue("handle"), limit,
	)
	if err != nil {
		writeProfileError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, profile)
}

// listPlayerProfiles is the directory, optionally filtered by a name fragment.
func (server *Server) listPlayerProfiles(writer http.ResponseWriter, request *http.Request) {
	limit, _ := strconv.Atoi(request.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(request.URL.Query().Get("offset"))
	profiles, err := server.data.PublicProfiles(
		request.Context(), request.URL.Query().Get("query"), limit, offset,
	)
	if err != nil {
		writeProfileError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, profiles)
}

// getPlayerGames is the "show more" behind the history panel on a page.
//
// Separate from GET /api/accounts/{userID}/games, which is the same data by a
// different address, because that one takes a user id and this one takes
// whatever the page was addressed with. Resolving the handle here rather than
// making the client do it is what keeps a profile page's paging working when
// somebody arrived by name.
func (server *Server) getPlayerGames(writer http.ResponseWriter, request *http.Request) {
	limit, err := nonNegativeQueryInteger(request, "limit", 20)
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	offset, err := nonNegativeQueryInteger(request, "offset", 0)
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	// Resolved through the profile so that the who-has-a-page rule is applied
	// here too: a name with no page must not have a browsable history at an
	// address one segment along from it.
	profile, err := server.data.PublicProfile(request.Context(), request.PathValue("handle"), 1)
	if err != nil {
		writeProfileError(writer, err)
		return
	}
	games, err := server.data.ProfileHistoryPage(
		request.Context(), profile.UserID, limit, offset,
	)
	if err != nil {
		writeProfileError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, games)
}

// getAdminAnalytics is the overview at the top of the admin screen.
func (server *Server) getAdminAnalytics(writer http.ResponseWriter, request *http.Request) {
	analytics, err := server.data.Analytics(request.Context())
	if err != nil {
		log.Printf("analytics: %v", err)
		writeAPIError(writer, http.StatusInternalServerError, "could not read the numbers")
		return
	}
	// The two figures that cannot come from the database, because they are
	// about this process: who is connected right now, and what they are doing.
	writeJSON(writer, http.StatusOK, map[string]any{
		"stored": analytics,
		"live": map[string]any{
			"onlineCount":    server.onlineCount(),
			"liveGames":      len(server.liveGames()),
			"queued":         server.seeks.CountsByMode(),
			"botsConnected":  len(server.botRoster()),
			"botsPractising": server.botPlayerCount(),
			"openChallenges": len(server.openChallenges(time.Now())),
		},
	})
}

func writeProfileError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, persistence.ErrProfileNotFound),
		errors.Is(err, persistence.ErrAccountNotFound):
		writeAPIError(writer, http.StatusNotFound, "no such player")
	default:
		log.Printf("player profile: %v", err)
		writeAPIError(writer, http.StatusInternalServerError, "player data is unavailable")
	}
}
