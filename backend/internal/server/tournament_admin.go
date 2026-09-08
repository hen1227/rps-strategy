package server

import (
	"errors"
	"log"
	"net/http"
	"strconv"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// The host's side of a tournament.
//
// Everything here is behind adminOnly, and everything here is about an event
// rather than about a match in one: writing it down, deciding what it is,
// letting people in, closing the field, and calling it off. The playing of it
// lives next door in tournament_live.go and needs no administrator at all.
//
// The one rule that shapes this file: **a draft is not public.** Not on the
// board, not in the socket broadcast, not in the REST list. It exists on the
// host's screen and nowhere else until it is published. That is enforced in
// exactly one place — publicTournaments below — and every public path goes
// through it.

// tournamentConfigRequest is the builder's form, on the wire.
//
// Every field is optional so that a client can send a partial update, with one
// exception: a create needs a mode, because a tournament with no game is not a
// draft of anything. Absent fields on an update keep their stored value, which
// is what lets the builder save one field without restating the rest.
type tournamentConfigRequest struct {
	Name           *string                        `json:"name,omitempty"`
	Description    *string                        `json:"description,omitempty"`
	ModeID         *game.ModeID                   `json:"modeId,omitempty"`
	Format         *persistence.TournamentFormat  `json:"format,omitempty"`
	Field          *persistence.TournamentField   `json:"field,omitempty"`
	Seeding        *persistence.TournamentSeeding `json:"seeding,omitempty"`
	MaxPlayers     *int                           `json:"maxPlayers,omitempty"`
	SwissRounds    *int                           `json:"swissRounds,omitempty"`
	InitialTimeMs  *int                           `json:"initialTimeMs,omitempty"`
	IncrementMs    *int                           `json:"incrementMs,omitempty"`
	StartsAtUnixMs *int64                         `json:"startsAtUnixMs,omitempty"`
	// ClearStartsAt is how a client removes a start time it previously set.
	// Needed because a nil StartsAtUnixMs already means "leave it alone", and
	// the two intentions are not the same.
	ClearStartsAt bool `json:"clearStartsAt,omitempty"`
}

type cancelTournamentRequest struct {
	Reason string `json:"reason"`
}

// apply folds a request onto an existing configuration.
//
// The mode is resolved through the registry rather than trusted, so a
// tournament can never be stored against a mode that does not exist or is
// closed to new matches — and the denormalised mode name is always the
// registry's, never the client's.
func (server *Server) apply(
	base persistence.TournamentConfig,
	input tournamentConfigRequest,
) (persistence.TournamentConfig, error) {
	config := base
	if input.Name != nil {
		config.Name = *input.Name
	}
	if input.Description != nil {
		config.Description = *input.Description
	}
	if input.ModeID != nil {
		mode, err := server.registry.New(*input.ModeID)
		if err != nil {
			return config, errors.New("invalid game mode")
		}
		if !server.registry.Playable(*input.ModeID) {
			return config, errors.New("that game mode is no longer open for new matches")
		}
		definition := mode.Definition()
		config.ModeID = definition.ID
		config.ModeName = definition.Name
	}
	if input.Format != nil {
		config.Format = *input.Format
	}
	if input.Field != nil {
		config.Field = *input.Field
	}
	if input.Seeding != nil {
		config.Seeding = *input.Seeding
	}
	if input.MaxPlayers != nil {
		config.MaxPlayers = *input.MaxPlayers
	}
	if input.SwissRounds != nil {
		config.SwissRounds = *input.SwissRounds
	}
	if input.InitialTimeMs != nil {
		config.InitialTimeMs = *input.InitialTimeMs
	}
	if input.IncrementMs != nil {
		config.IncrementMs = *input.IncrementMs
	}
	if input.ClearStartsAt {
		config.StartsAtUnixMs = nil
	} else if input.StartsAtUnixMs != nil {
		config.StartsAtUnixMs = input.StartsAtUnixMs
	}
	return config, nil
}

// createTournament writes a new draft.
//
// It is not public and it takes no signups. That is the change from the old
// two-field create, and it is the whole reason this exists: a host can now put
// an event down, look at it, and decide.
func (server *Server) createTournament(writer http.ResponseWriter, request *http.Request) {
	var input tournamentConfigRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if input.ModeID == nil {
		writeAPIError(writer, http.StatusBadRequest, "modeId is required")
		return
	}
	config, err := server.apply(persistence.TournamentConfig{}, input)
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	tournamentID, err := randomID()
	if err != nil {
		log.Printf("create tournament ID: %v", err)
		writeAPIError(writer, http.StatusInternalServerError, "could not create tournament")
		return
	}
	tournament, err := server.data.CreateTournament(request.Context(), tournamentID, config)
	if err != nil {
		writeTournamentError(writer, err)
		return
	}
	// Not broadcast. A draft is not public — see the note at the top of this
	// file — so there is nothing for the lobby to hear about yet.
	writeJSON(writer, http.StatusCreated, tournament)
}

// updateTournament edits an event's details. What is still editable depends on
// how far along it is; persistence.UpdateTournament owns that judgement.
func (server *Server) updateTournament(writer http.ResponseWriter, request *http.Request) {
	tournamentID := request.PathValue("tournamentID")
	existing, err := server.data.Tournament(request.Context(), tournamentID)
	if err != nil {
		writeTournamentError(writer, err)
		return
	}
	var input tournamentConfigRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	config, err := server.apply(configOf(existing), input)
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	tournament, err := server.data.UpdateTournament(request.Context(), tournamentID, config)
	if err != nil {
		writeTournamentError(writer, err)
		return
	}
	// Only once it is public. Editing a draft changes nothing anybody else can
	// see, and a broadcast for it would be a message about a thing that,
	// as far as every recipient is concerned, does not exist.
	if tournament.Status != persistence.TournamentDraft {
		server.broadcastTournaments()
	}
	writeJSON(writer, http.StatusOK, tournament)
}

// publishTournament opens registration and puts the event on the board.
func (server *Server) publishTournament(writer http.ResponseWriter, request *http.Request) {
	tournament, err := server.data.PublishTournament(
		request.Context(), request.PathValue("tournamentID"),
	)
	if err != nil {
		writeTournamentError(writer, err)
		return
	}
	server.broadcastTournaments()
	writeJSON(writer, http.StatusOK, tournament)
}

// unpublishTournament takes an unentered event back into draft.
func (server *Server) unpublishTournament(writer http.ResponseWriter, request *http.Request) {
	tournament, err := server.data.UnpublishTournament(
		request.Context(), request.PathValue("tournamentID"),
	)
	if err != nil {
		writeTournamentError(writer, err)
		return
	}
	// Broadcast on the way out too, so a board showing it drops it.
	server.broadcastTournaments()
	writeJSON(writer, http.StatusOK, tournament)
}

// cancelTournament calls an event off, keeping whatever was played.
func (server *Server) cancelTournament(writer http.ResponseWriter, request *http.Request) {
	tournamentID := request.PathValue("tournamentID")
	var input cancelTournamentRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	tournament, err := server.data.CancelTournament(request.Context(), tournamentID, input.Reason)
	if err != nil {
		writeTournamentError(writer, err)
		return
	}
	// Anybody sitting on a readiness for one of its matches is waiting for a
	// game that is never going to start now.
	server.releaseTournamentReadiness(tournamentID)
	// And any engine it was holding is free again.
	server.refreshBotReservations()
	server.broadcastTournaments()
	writeJSON(writer, http.StatusOK, tournament)
}

// hideTournament takes a finished event off the public board.
//
// The tidying tool, and the one to reach for first: it changes what is listed
// and nothing else. See persistence.SetTournamentHidden.
func (server *Server) hideTournament(writer http.ResponseWriter, request *http.Request) {
	server.setTournamentHidden(writer, request, true)
}

// showTournament puts a hidden event back on the board.
func (server *Server) showTournament(writer http.ResponseWriter, request *http.Request) {
	server.setTournamentHidden(writer, request, false)
}

func (server *Server) setTournamentHidden(
	writer http.ResponseWriter,
	request *http.Request,
	hidden bool,
) {
	tournament, err := server.data.SetTournamentHidden(
		request.Context(), request.PathValue("tournamentID"), hidden,
	)
	if err != nil {
		writeTournamentError(writer, err)
		return
	}
	// Both ways round: hiding has to reach the boards that are showing it, and
	// unhiding has to reach the ones that are not.
	server.broadcastTournaments()
	writeJSON(writer, http.StatusOK, tournament)
}

// deleteTournament removes an event and everything scheduling it.
//
// Any event now, not just a draft. The report goes back to the caller because
// deleting a completed one quietly takes the champion's title with it — see
// persistence.TournamentDeletion.
func (server *Server) deleteTournament(writer http.ResponseWriter, request *http.Request) {
	tournamentID := request.PathValue("tournamentID")
	deletion, err := server.data.DeleteTournament(request.Context(), tournamentID)
	if err != nil {
		writeTournamentError(writer, err)
		return
	}
	// Anybody waiting on one of its matches is waiting for a game that cannot
	// be paired now, and any engine it was holding is free.
	server.releaseTournamentReadiness(tournamentID)
	server.refreshBotReservations()
	// The champions' rows are re-evaluated, so a title that no longer has an
	// event behind it goes now rather than at some unrelated moment later.
	if len(deletion.ChampionUserIDs) > 0 {
		server.awardTitles(request.Context(), deletion.ChampionUserIDs...)
	}
	server.broadcastTournaments()
	writeJSON(writer, http.StatusOK, deletion)
}

// withdrawTournamentPlayer removes an entrant during registration.
func (server *Server) withdrawTournamentPlayer(
	writer http.ResponseWriter,
	request *http.Request,
) {
	playerID, err := strconv.ParseInt(request.PathValue("playerID"), 10, 64)
	if err != nil || playerID <= 0 {
		writeAPIError(writer, http.StatusBadRequest, "playerId must be a positive integer")
		return
	}
	tournament, err := server.data.WithdrawTournamentPlayer(
		request.Context(), request.PathValue("tournamentID"), playerID,
	)
	if err != nil {
		writeTournamentError(writer, err)
		return
	}
	server.broadcastTournaments()
	writeJSON(writer, http.StatusOK, tournament)
}

// advanceTournament builds the next round of a progressive event by hand.
//
// The rounds normally build themselves as results land, so this is a repair
// tool rather than part of the flow: it is what un-sticks a bracket whose
// round finished while the store was returning errors, without a host having
// to touch the database.
func (server *Server) advanceTournament(writer http.ResponseWriter, request *http.Request) {
	tournament, err := server.data.AdvanceTournament(
		request.Context(), request.PathValue("tournamentID"),
	)
	if err != nil {
		writeTournamentError(writer, err)
		return
	}
	server.awardTournamentTitles(request.Context(), tournament)
	// Advancing can also *finish* an event — when there is no further round to
	// build — which releases its engines.
	server.refreshBotReservations()
	server.broadcastTournaments()
	writeJSON(writer, http.StatusOK, tournament)
}

// listAdminTournaments is the host's board: every event, drafts included.
func (server *Server) listAdminTournaments(writer http.ResponseWriter, request *http.Request) {
	tournaments, err := server.data.Tournaments(request.Context())
	if err != nil {
		writeTournamentError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, tournaments)
}

// configOf reads an event's current settings back out as the builder's form,
// so that an update which mentions one field leaves the others as they were.
func configOf(tournament persistence.Tournament) persistence.TournamentConfig {
	return persistence.TournamentConfig{
		Name:           tournament.Name,
		Description:    tournament.Description,
		ModeID:         tournament.ModeID,
		ModeName:       tournament.ModeName,
		Format:         tournament.Format,
		Field:          tournament.Field,
		Seeding:        tournament.Seeding,
		MaxPlayers:     tournament.MaxPlayers,
		SwissRounds:    tournament.SwissRounds,
		InitialTimeMs:  tournament.InitialTimeMs,
		IncrementMs:    tournament.IncrementMs,
		StartsAtUnixMs: tournament.StartsAtUnixMs,
	}
}

// publicTournaments is the board as everybody who is not the host sees it.
//
// The single chokepoint for both of the reasons an event is not listed. Both
// the REST list and the socket broadcast go through it, which is the only
// reason neither can leak: there is one filter, not one per transport.
//
// The two reasons are not the same thing, and the difference matters:
//
//   - A **draft** is not public *at all*. Its own address answers 404 — see
//     getTournament — because it has not been announced and confirming the id
//     would be the leak this filter exists to prevent.
//   - A **hidden** event is merely not *listed*. It is still readable at its
//     address, still on its entrants' profile pages, and still counted
//     everywhere it was counted. It has been tidied away, not concealed.
func publicTournaments(tournaments []persistence.Tournament) []persistence.Tournament {
	public := make([]persistence.Tournament, 0, len(tournaments))
	for _, tournament := range tournaments {
		if tournament.Status == persistence.TournamentDraft {
			continue
		}
		if tournament.HiddenAtUnixMs != nil {
			continue
		}
		public = append(public, tournament)
	}
	return public
}

// tournamentTimeControl is the clock a scheduled match is played with.
//
// A configured control, or the server's default when the host left the fields
// blank — which is what every event before the builder used. Validated rather
// than trusted: a stored control that cannot pass game.TimeControl.Validate
// would produce a board with no time on it, and falling back is better than
// seating two players at a clock that has already expired.
func tournamentTimeControl(tournament persistence.Tournament) game.TimeControl {
	control := game.TimeControl{
		InitialTimeMs: int64(tournament.InitialTimeMs),
		IncrementMs:   int64(tournament.IncrementMs),
	}
	if control.Validate() != nil {
		return game.DefaultTimeControl()
	}
	return control
}
