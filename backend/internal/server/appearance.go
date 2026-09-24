package server

import (
	"errors"
	"net/http"

	"rps-strategy/backend/internal/persistence"
)

type setAppearanceRequest struct {
	// Appearance is the client's own JSON object of preset ids, as a string, or
	// "" to clear it. A string rather than a struct on purpose: this server does
	// not know what a theme is and must not start guarding a catalogue it does
	// not own. See persistence/appearance.go.
	Appearance string `json:"appearance"`
}

// setAccountAppearance stores the look a player chose, so it follows them to
// their other devices.
//
// Its own route rather than a field on the profile PATCH, for the same reason
// the title has one: the profile form is free text that can fail validation,
// and a rejected username must not also cost the player the theme they picked
// beside it. This route saves on every tap, and the two must not be coupled.
//
// requireSession rather than requireRegistered, deliberately. A guest is a real
// player with a real account here, and losing your theme because you have not
// chosen a username would be a strange thing to enforce.
func (server *Server) setAccountAppearance(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireSession(writer, request)
	if !ok {
		return
	}
	if request.PathValue("userID") != account.UserID {
		writeAPIError(writer, http.StatusForbidden, "you can only edit your own account")
		return
	}
	var input setAppearanceRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	updated, err := server.data.SetAccountAppearance(
		request.Context(),
		account.UserID,
		input.Appearance,
	)
	if err != nil {
		writeAppearanceError(writer, err)
		return
	}
	// Every connection this player holds hears about it, so a second tab or a
	// phone in a pocket follows along without being reloaded.
	server.publishAccount(request.Context(), account.UserID)
	writeJSON(writer, http.StatusOK, updated)
}

func writeAppearanceError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, persistence.ErrBadAppearance):
		writeAPIError(writer, http.StatusBadRequest, err.Error())
	case errors.Is(err, persistence.ErrAccountNotFound):
		writeAPIError(writer, http.StatusNotFound, "no such account")
	default:
		writeAPIError(writer, http.StatusInternalServerError, "could not update appearance")
	}
}
