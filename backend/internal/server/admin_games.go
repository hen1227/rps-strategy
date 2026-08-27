package server

import (
	"errors"
	"net/http"
	"strconv"

	"rps-strategy/backend/internal/persistence"
)

// The destructive half of the admin screen: removing games, bots, and accounts
// rather than flagging them.
//
// Everything here is a hard delete, and everything here is behind adminOnly.
// The reasoning about when a host should reach for these instead of the
// anonymize-and-disable pair lives with the queries, in
// persistence/admin_delete.go.

// listAdminGames is the game browser: recent games, or the ones matching a
// player id, a username, or an exact game id.
func (server *Server) listAdminGames(writer http.ResponseWriter, request *http.Request) {
	limit, _ := strconv.Atoi(request.URL.Query().Get("limit"))
	offset, _ := strconv.Atoi(request.URL.Query().Get("offset"))
	games, err := server.data.SearchGames(
		request.Context(), request.URL.Query().Get("query"), limit, offset,
	)
	if err != nil {
		writeAdminAccountError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, games)
}

// deleteAdminGame removes one game from the history and the archive.
//
// Ratings are given back unless the caller says otherwise, because that is the
// answer that is right by default: the usual reason to delete a game is that
// its result should not stand.
func (server *Server) deleteAdminGame(writer http.ResponseWriter, request *http.Request) {
	revert := request.URL.Query().Get("revertRatings") != "false"
	deletion, err := server.data.DeleteGame(
		request.Context(), request.PathValue("gameID"), revert,
	)
	if err != nil {
		writeAdminDeleteError(writer, err)
		return
	}
	// Removing a bot game refits its ladder whether or not the ratings were
	// reverted, because the fit is over the games on record and one of them is
	// now gone. The deletion does not say which mode it was in, so this asks
	// after all of them.
	server.republishBotLadder(request.Context(), server.ratedModeIDs()...)
	writeJSON(writer, http.StatusOK, deletion)
}

// deleteAdminBot removes a bot entirely: its games, its series, and the account
// it played under.
//
// The owner-facing DELETE /api/bots/{botID} retires instead, and an admin can
// still call it. This is the stronger one, and it is a separate route rather
// than a flag on that one so that nothing an owner clicks can reach it.
func (server *Server) deleteAdminBot(writer http.ResponseWriter, request *http.Request) {
	botID := request.PathValue("botID")
	// Read the bot before it stops existing, so the socket can be closed with
	// a reason afterwards.
	bot, err := server.data.Bot(request.Context(), botID)
	if err != nil {
		writeBotError(writer, err)
		return
	}
	deletion, err := server.data.DeleteBot(request.Context(), botID)
	if err != nil {
		writeAdminDeleteError(writer, err)
		return
	}
	server.disconnectBot(bot.BotID, "this bot has been deleted")
	if bot.UserID != "" {
		server.disconnectAccount(bot.UserID, "this bot has been deleted")
	}
	// Its games went with it, so every ladder it played in has been refit and
	// the engines still connected are holding ratings from before that.
	server.republishBotLadder(request.Context(), server.ratedModeIDs()...)
	writeJSON(writer, http.StatusOK, deletion)
}

// purgeAccount is the hard delete, beside the anonymize on the same screen.
func (server *Server) purgeAccount(writer http.ResponseWriter, request *http.Request) {
	userID := request.PathValue("userID")
	bots, err := server.data.BotsForOwner(request.Context(), userID)
	if err != nil {
		writeAdminDeleteError(writer, err)
		return
	}
	purge, err := server.data.PurgeAccount(request.Context(), userID)
	if err != nil {
		writeAdminDeleteError(writer, err)
		return
	}
	server.disconnectAccount(userID, "this account has been removed")
	for _, bot := range bots {
		server.disconnectBot(bot.BotID, "this bot's owner account has been removed")
		if bot.UserID != "" {
			server.disconnectAccount(bot.UserID, "this bot has been deleted")
		}
	}
	if len(bots) > 0 {
		server.republishBotLadder(request.Context(), server.ratedModeIDs()...)
	}
	writeJSON(writer, http.StatusOK, purge)
}

// getAccountDetail is what the admin screen opens when a row is expanded: the
// account, the bots it owns, and its recent games, in one request rather than
// three round trips per row.
func (server *Server) getAccountDetail(writer http.ResponseWriter, request *http.Request) {
	userID := request.PathValue("userID")
	account, err := server.data.Account(request.Context(), userID)
	if err != nil {
		writeAdminAccountError(writer, err)
		return
	}
	bots, err := server.data.BotsForOwner(request.Context(), userID)
	if err != nil {
		writeAdminAccountError(writer, err)
		return
	}
	// A bot account owns nothing, but it *is* something, and the host looking
	// at it wants the delete button that removes the bot rather than one that
	// only touches the account row underneath it.
	if own, err := server.data.BotForAccount(request.Context(), userID); err == nil {
		bots = append(bots, own)
	} else if !errors.Is(err, persistence.ErrBotNotFound) {
		writeAdminAccountError(writer, err)
		return
	}
	limit, _ := strconv.Atoi(request.URL.Query().Get("limit"))
	games, err := server.data.SearchGames(request.Context(), userID, limit, 0)
	if err != nil {
		writeAdminAccountError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"account": account,
		"bots":    bots,
		"games":   games,
	})
}

func writeAdminDeleteError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, persistence.ErrGameNotFound):
		writeAPIError(writer, http.StatusNotFound, "no such game")
	case errors.Is(err, persistence.ErrBotNotFound):
		writeAPIError(writer, http.StatusNotFound, "no such bot")
	default:
		writeAdminAccountError(writer, err)
	}
}
