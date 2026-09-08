package server

import (
	"context"
	"errors"
	"log"
	"net/http"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// Titles on the wire: who is wearing one, who has just earned one, and the two
// routes that hand them out.
//
// The rules themselves are in persistence/titles.go. Nothing in this file
// decides who deserves anything; it decides when to ask, and who to tell.

// playerProfile is how an account becomes the player other people see.
//
// One function rather than a struct literal per connection type, because the
// browser path and the engine path had already drifted apart once — the engine
// one never carried Discord — and a field added to PlayerProfile that only half
// the seats populate is a field that works until a bot sits in the chair.
func playerProfile(account persistence.Account) game.PlayerProfile {
	return game.PlayerProfile{
		UserID:   account.UserID,
		Username: account.Username,
		Discord:  account.Discord,
		Title:    string(account.Title),
	}
}

// awardTitles re-runs the rulebook for everyone the given accounts implicate,
// and tells whoever is connected about anything new.
//
// Called after the events that can change an answer: a finished game, a
// tournament result, a connection. Never on a read path — the evaluation is
// several queries, and a title that appears a moment after the game it was
// earned in is indistinguishable from one that appeared during it.
//
// Failures are logged and swallowed. A title is a decoration; a game that has
// just finished must be recorded, broadcast, and archived whether or not the
// decoration can be worked out.
func (server *Server) awardTitles(ctx context.Context, userIDs ...string) {
	awarded, err := server.data.EvaluateTitlesFor(ctx, userIDs...)
	if err != nil {
		log.Printf("evaluate titles: %v", err)
		return
	}
	for userID, titles := range awarded {
		names := make([]string, 0, len(titles))
		for _, title := range titles {
			names = append(names, string(title.ID))
		}
		log.Printf("titles awarded to %s: %v", userID, names)
		server.publishAccount(ctx, userID)
	}
}

// publishAccount sends an account its own refreshed row, so a collection that
// grew mid-session is on screen without a reload.
//
// Deliberately does not touch Client.profile, which is the copy every board and
// lobby row renders this player from. That field is read all over the server,
// on goroutines that hold no lock in common with an HTTP handler, so writing to
// it here would be a data race for the sake of a decoration.
//
// Nothing is lost by leaving it: a title is not worn until it is chosen, and
// choosing one reconnects the socket — so the profile is rebuilt from the
// account row exactly when its title changes. The one visible lag is an
// administrator revoking a title somebody is currently wearing, which stays on
// their name until they next connect.
func (server *Server) publishAccount(ctx context.Context, userID string) {
	account, err := server.data.Account(ctx, userID)
	if err != nil {
		log.Printf("publish account %s: %v", userID, err)
		return
	}
	for _, client := range server.connectedClients() {
		if client.profile.UserID == userID && !client.isBot() {
			client.Send(ServerMessage{Type: "account_updated", Account: &account})
		}
	}
}

// titledAccount runs the rulebook for an account about to be handed to its
// owner, and returns it with anything new already on it.
//
// Synchronous, and on the connect path before the connection is registered, for
// two reasons that both come down to the handshake: `connection_ready` carries
// this account, and the profile every other player sees is built from it. Doing
// the work afterwards would mean a player who earned a title yesterday — or
// before this feature existed — connects once without it. The Discord sign-in
// path uses it for the same reason: its reply is the account, and the link it
// has just written is worth a title.
//
// The evaluation is a handful of indexed queries against rows the connect path
// is already touching, run once per connection rather than per message.
func (server *Server) titledAccount(
	ctx context.Context,
	account persistence.Account,
) persistence.Account {
	awarded, err := server.data.EvaluateTitlesFor(ctx, account.UserID)
	if err != nil {
		log.Printf("evaluate titles for %s: %v", account.UserID, err)
		return account
	}
	if len(awarded) == 0 {
		return account
	}
	refreshed, err := server.data.Account(ctx, account.UserID)
	if err != nil {
		log.Printf("reload account %s after awarding titles: %v", account.UserID, err)
		return account
	}
	return refreshed
}

// awardTournamentTitles re-runs the rulebook for a tournament's entrants once
// the last result is in.
//
// Only on completion, because until then nobody has won it: the standings move
// with every result, and a title handed to whoever was leading in round two
// could not be taken back. Every entrant is evaluated rather than only the
// champion, since a tournament is also where a bot's owner earns Bot Master and
// the runners-up may have beaten an engine on the way.
func (server *Server) awardTournamentTitles(
	ctx context.Context,
	tournament persistence.Tournament,
) {
	if tournament.Status != persistence.TournamentCompleted {
		return
	}
	entrants := make([]string, 0, len(tournament.Players))
	for _, player := range tournament.Players {
		entrants = append(entrants, player.UserID)
	}
	server.awardTitles(ctx, entrants...)
}

/* -------------------------------------------------------------- routes -- */

// getTitles is the whole catalogue, which is public: a title nobody can look up
// is a private joke rather than something to collect, and the requirement text
// is what makes an unearned one worth chasing.
func (server *Server) getTitles(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, persistence.TitleCatalogue())
}

type setTitleRequest struct {
	// Title is the id to wear, and "" takes the tag off. Not a pointer: unlike
	// the profile fields this route sits beside, there is no third state — a
	// request either names a title or asks for none.
	Title persistence.TitleID `json:"title"`
}

// setAccountTitle chooses which owned title goes in front of the name.
//
// Its own route rather than a field on the profile PATCH, because the two are
// not edited together: a title is picked from a list of things already earned,
// while the profile form is free text that can fail validation. Sharing a route
// would mean a rejected username could not be saved without also losing the
// title choice made beside it.
func (server *Server) setAccountTitle(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireSession(writer, request)
	if !ok {
		return
	}
	if request.PathValue("userID") != account.UserID {
		writeAPIError(writer, http.StatusForbidden, "you can only edit your own account")
		return
	}
	var input setTitleRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	updated, err := server.data.SetAccountTitle(request.Context(), account.UserID, input.Title)
	if err != nil {
		writeTitleError(writer, err)
		return
	}
	// The tag is part of how this player appears at the board, so every
	// connection they hold starts showing it now rather than at the next
	// reconnect.
	server.publishAccount(request.Context(), account.UserID)
	writeJSON(writer, http.StatusOK, updated)
}

// grantAccountTitle hands out a title an administrator has decided somebody
// should have, earned or not.
func (server *Server) grantAccountTitle(writer http.ResponseWriter, request *http.Request) {
	server.changeAccountTitle(writer, request, (*persistence.Store).GrantTitle)
}

// revokeAccountTitle takes one back, and takes it off the name if it was worn.
func (server *Server) revokeAccountTitle(writer http.ResponseWriter, request *http.Request) {
	server.changeAccountTitle(writer, request, (*persistence.Store).RevokeTitle)
}

// changeAccountTitle is the half the two admin routes share: read the title out
// of the path, apply the change, publish the account, answer with it.
//
// The title is in the URL rather than in a body so that revoking — a DELETE —
// needs no body at all, and so the two routes are the same shape.
func (server *Server) changeAccountTitle(
	writer http.ResponseWriter,
	request *http.Request,
	apply func(*persistence.Store, context.Context, string, persistence.TitleID) error,
) {
	userID := request.PathValue("userID")
	title := persistence.TitleID(request.PathValue("title"))
	if err := apply(server.data, request.Context(), userID, title); err != nil {
		writeTitleError(writer, err)
		return
	}
	server.publishAccount(request.Context(), userID)
	account, err := server.data.Account(request.Context(), userID)
	if err != nil {
		writeTitleError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, account)
}

func writeTitleError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, persistence.ErrUnknownTitle):
		writeAPIError(writer, http.StatusBadRequest, err.Error())
	case errors.Is(err, persistence.ErrTitleNotOwned):
		writeAPIError(writer, http.StatusForbidden, err.Error())
	case errors.Is(err, persistence.ErrAccountNotFound):
		writeAPIError(writer, http.StatusNotFound, "no such account")
	default:
		writeAPIError(writer, http.StatusInternalServerError, "could not update titles")
	}
}
