package server

import (
	"errors"
	"log"
	"net/http"
	"strings"

	"rps-strategy/backend/internal/persistence"
)

// Deleting your own account.
//
// The mechanism already existed — persistence.AnonymizeAccount, reached from
// the admin screen — and what was missing was the player's own way to it. That
// gap was filled by a sentence in the privacy policy asking people to message
// the host on Discord, which is a real answer and is not one anybody can rely
// on: it needs the host to be awake, it needs the player to have Discord, and
// it makes a right conditional on a favour.
//
// So this is the same operation with the player as the author. Nothing about
// what deletion *means* changes; only who may ask for it.
//
// # What "deleted" means here, exactly
//
// An account that has never appeared in a game is removed outright: the row is
// gone. An account that has played is stripped instead — name, Discord handle
// and id, password material, titles, sessions, and every copy of the name
// inside stored game records and PGN text, including the archive. What remains
// is a disabled row nobody can sign into and a set of games that say "Deleted
// player" where the name used to be.
//
// The reason the games stay is not convenience: a game belongs to two people,
// and deleting one player's copy of a shared result would rewrite the other
// player's history and their rating along with it. Nobody should be able to
// erase somebody else's record by leaving. This is said in the confirmation
// dialog and in the privacy policy, because a deletion that quietly keeps
// something is worse than one that says what it keeps.

type deleteAccountRequest struct {
	// Confirm is the account's own username, typed back.
	//
	// Not ceremony. This route is irreversible, unauthenticated by anything
	// beyond a bearer token that lives in device storage, and reachable by a
	// single HTTP call — so the thing standing between a mis-click and an
	// erased account should be something only the person looking at the screen
	// can produce.
	Confirm string `json:"confirm"`
}

// deleteOwnAccount is the player's own deletion request.
//
// requireAnyIdentity rather than requireSession, which is looser than the block
// routes and deliberately so. A guest owns an account too — every browser here
// does, whether or not it has ever signed in — and it holds their games, their
// rating, and the name their opponents saw. "You have to make an account before
// you may delete the account you already have" is not a defensible answer, and
// it is exactly the answer a reviewer testing without signing in would get.
func (server *Server) deleteOwnAccount(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireAnyIdentity(writer, request)
	if !ok {
		return
	}
	// The path says whose account this is. A client that has drifted out of
	// step with its own credential should hear about it rather than delete
	// something it did not mean to.
	if pathUserID := request.PathValue("userID"); pathUserID != "" &&
		pathUserID != account.UserID {
		writeAPIError(writer, http.StatusForbidden, "you can only delete your own account")
		return
	}
	var input deleteAccountRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if !strings.EqualFold(
		strings.TrimSpace(input.Confirm), strings.TrimSpace(account.Username),
	) {
		writeAPIError(writer, http.StatusBadRequest, "type your username to confirm")
		return
	}

	// Bots first. AnonymizeAccount refuses an owner who still has live ones —
	// a bot with no owner has nobody to answer for it — and that refusal is
	// correct for the admin screen, where a host can go and look. Here it would
	// be a dead end: the player pressed delete, and "retire your bots first" in
	// a dialog is a puzzle rather than an answer. Retiring them *is* what
	// deleting the account means for them.
	retired, err := server.retireOwnedBots(request, account.UserID)
	if err != nil {
		writeAccountDeletionError(writer, err)
		return
	}

	rewritten, err := server.data.AnonymizeAccount(request.Context(), account.UserID)
	if err != nil {
		writeAccountDeletionError(writer, err)
		return
	}
	log.Printf(
		"account %s deleted at its owner's request (%d records rewritten, %d bots retired)",
		account.UserID, rewritten, retired,
	)
	// The block rows cascaded away with the account. The cache did not, and a
	// stale entry would go on hiding whoever is behind that id next.
	server.forgetBlocksOf(account.UserID)
	server.uncacheRestriction(account.UserID, persistence.RestrictMute)
	server.uncacheRestriction(account.UserID, persistence.RestrictRanked)
	server.uncacheRestriction(account.UserID, persistence.RestrictTournament)
	// Every session is already revoked in the database. This is the other half:
	// a socket that is still open is still playing, still in a chat room, and
	// still wearing the name that was just removed.
	server.disconnectAccount(account.UserID, "this account has been deleted")

	writeJSON(writer, http.StatusOK, map[string]any{
		"deleted": true,
		// What was kept, said plainly rather than implied by a bare success.
		// Zero means the account appeared nowhere and the row itself is gone.
		"recordsAnonymized": rewritten,
		"botsRetired":       retired,
	})
}

// retireOwnedBots retires every engine an account still owns, and reports how
// many there were.
func (server *Server) retireOwnedBots(request *http.Request, userID string) (int, error) {
	bots, err := server.data.BotsForOwner(request.Context(), userID)
	if err != nil {
		return 0, err
	}
	for _, bot := range bots {
		if err := server.data.RetireBot(request.Context(), bot.BotID); err != nil {
			return 0, err
		}
		// The same order deleteBot uses: retire the registration, then drop the
		// socket. A connected engine whose registration has gone would
		// otherwise keep playing under a bot id nothing owns.
		server.disconnectBot(bot.BotID, "this bot's owner deleted their account")
	}
	return len(bots), nil
}

func writeAccountDeletionError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, persistence.ErrAccountNotFound):
		writeAPIError(writer, http.StatusNotFound, "no such account")
	case errors.Is(err, persistence.ErrLastAdministrator):
		// The one account that cannot delete itself, and the message says why
		// rather than refusing flatly: a host locked out of their own server is
		// not a privacy improvement.
		writeAPIError(
			writer,
			http.StatusConflict,
			"this is the only administrator account; make somebody else an "+
				"administrator first",
		)
	default:
		log.Printf("delete own account: %v", err)
		writeAPIError(writer, http.StatusInternalServerError, err.Error())
	}
}
