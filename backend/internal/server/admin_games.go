package server

import (
	"errors"
	"log"
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
// Win counts are given back unless the caller says otherwise, because that is
// the answer that is right by default: the usual reason to delete a game is
// that its result should not stand. Ratings are replayed either way.
func (server *Server) deleteAdminGame(writer http.ResponseWriter, request *http.Request) {
	revert := request.URL.Query().Get("revertRatings") != "false"
	deletion, err := server.data.DeleteGame(
		request.Context(), request.PathValue("gameID"), revert,
	)
	if err != nil {
		writeAdminDeleteError(writer, err)
		return
	}
	// The store replayed every rating, so anybody connected may be holding a
	// number from before the game went. The deletion does not say which mode it
	// was in, so this asks after all of them.
	server.refreshCachedRatings(request.Context(), server.ratedModeIDs()...)
	writeJSON(writer, http.StatusOK, deletion)
}

// setAdminGameRanked moves one finished engine game to ranked or to casual.
//
// The correction beside delete, for the host whose question is "that shouldn't
// have counted" — or the reverse — rather than "that shouldn't be here". Engine
// games only; see persistence/reclassify.go.
func (server *Server) setAdminGameRanked(writer http.ResponseWriter, request *http.Request) {
	ranked, ok := decodeRankedRequest(writer, request)
	if !ok {
		return
	}
	moved, err := server.data.SetGameRanked(request.Context(), request.PathValue("gameID"), ranked)
	if err != nil {
		writeReclassifyError(writer, err)
		return
	}
	// The store replayed the ratings in the same transaction; this tells the
	// accounts still connected what they are holding now.
	if moved.Changed > 0 {
		server.refreshCachedRatings(request.Context(), moved.ModeID)
	}
	writeJSON(writer, http.StatusOK, moved)
}

// decodeRankedRequest reads `{"ranked": true}` or `{"ranked": false}`.
//
// Required rather than defaulted: a body that forgot the field would otherwise
// read as false, and a request that meant nothing would quietly move a ranked
// game to casual.
func decodeRankedRequest(writer http.ResponseWriter, request *http.Request) (bool, bool) {
	var input struct {
		Ranked *bool `json:"ranked"`
	}
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return false, false
	}
	if input.Ranked == nil {
		writeAPIError(writer, http.StatusBadRequest, "say whether it should be ranked")
		return false, false
	}
	return *input.Ranked, true
}

func writeReclassifyError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, persistence.ErrGameNotFound):
		writeAPIError(writer, http.StatusNotFound, "no such game")
	case errors.Is(err, persistence.ErrBotSeriesNotFound):
		writeAPIError(writer, http.StatusNotFound, "no such series")
	case errors.Is(err, persistence.ErrReclassifyNotEngineGame),
		errors.Is(err, persistence.ErrReclassifySameOwner),
		errors.Is(err, errSeriesStillRunning):
		writeAPIError(writer, http.StatusConflict, err.Error())
	default:
		log.Printf("move a game between ranked and casual: %v", err)
		writeAPIError(writer, http.StatusInternalServerError, "could not change the game")
	}
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
	// Its games went with it, so every rating has been replayed and the
	// accounts still connected are holding numbers from before that.
	server.refreshCachedRatings(request.Context(), server.ratedModeIDs()...)
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
	// An Apple token went into the revocation queue with the account's
	// identities; this is the nudge that tries it now.
	server.wakeTokenRevocations()
	// The block rows went with the account, through the foreign key. The cache
	// they are enforced from did not, and every path that hides a message reads
	// the cache — so leaving it would hide a stranger and would put the account
	// screen's list (which reads the store) out of step with what the client
	// believes it is hiding. Same reasoning as deleteOwnAccount.
	server.forgetBlocksOf(userID)
	for _, bot := range bots {
		server.forgetBlocksOf(bot.UserID)
		server.disconnectBot(bot.BotID, "this bot's owner account has been removed")
		if bot.UserID != "" {
			server.disconnectAccount(bot.UserID, "this bot has been deleted")
		}
	}
	// The purge replayed every rating its games had a hand in.
	server.refreshCachedRatings(request.Context(), server.ratedModeIDs()...)
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
