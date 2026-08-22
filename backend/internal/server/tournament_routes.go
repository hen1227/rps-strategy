package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

const tournamentRequestLimit = 16 << 10

type createTournamentRequest struct {
	Name   string      `json:"name"`
	ModeID game.ModeID `json:"modeId"`
}

type tournamentSignupRequest struct {
	UserID                 string `json:"userId"`
	IGN                    string `json:"ign"`
	Discord                string `json:"discord"`
	AgreedToUnfilteredChat bool   `json:"agreedToUnfilteredChat"`
	ReservationToken       string `json:"reservationToken"`
}

type tournamentResultRequest struct {
	Result persistence.TournamentMatchResult `json:"result"`
}

func (server *Server) getTournaments(writer http.ResponseWriter, request *http.Request) {
	tournaments, err := server.data.Tournaments(request.Context())
	if err != nil {
		writeTournamentError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, tournaments)
}

func (server *Server) getTournament(writer http.ResponseWriter, request *http.Request) {
	tournament, err := server.data.Tournament(
		request.Context(),
		request.PathValue("tournamentID"),
	)
	if err != nil {
		writeTournamentError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, tournament)
}

func (server *Server) signupForTournament(writer http.ResponseWriter, request *http.Request) {
	var signup tournamentSignupRequest
	if err := decodeAPIRequest(writer, request, &signup); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if usesReservedIdentity(signup.IGN, signup.Discord) &&
		!server.hasValidAdminTokenValue(signup.ReservationToken) {
		writeAPIError(writer, http.StatusForbidden, "this username or Discord handle is reserved; paste the special token")
		return
	}
	tournament, err := server.data.SignupForTournament(
		request.Context(),
		request.PathValue("tournamentID"),
		signup.UserID,
		signup.IGN,
		signup.Discord,
		signup.AgreedToUnfilteredChat,
	)
	if err != nil {
		writeTournamentError(writer, err)
		return
	}
	server.broadcastTournaments()
	writeJSON(writer, http.StatusCreated, tournament)
}

func (server *Server) getAdminSession(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]bool{"admin": true})
}

func (server *Server) createTournament(writer http.ResponseWriter, request *http.Request) {
	var input createTournamentRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	mode, err := server.registry.New(input.ModeID)
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, "invalid game mode")
		return
	}
	if !server.registry.Playable(input.ModeID) {
		writeAPIError(
			writer,
			http.StatusBadRequest,
			"that game mode is no longer open for new matches",
		)
		return
	}
	tournamentID, err := randomID()
	if err != nil {
		log.Printf("create tournament ID: %v", err)
		writeAPIError(writer, http.StatusInternalServerError, "could not create tournament")
		return
	}
	definition := mode.Definition()
	tournament, err := server.data.CreateTournament(
		request.Context(),
		tournamentID,
		input.Name,
		definition.ID,
		definition.Name,
	)
	if err != nil {
		writeTournamentError(writer, err)
		return
	}
	server.broadcastTournaments()
	writeJSON(writer, http.StatusCreated, tournament)
}

func (server *Server) startTournament(writer http.ResponseWriter, request *http.Request) {
	tournament, err := server.data.StartTournament(
		request.Context(),
		request.PathValue("tournamentID"),
	)
	if err != nil {
		writeTournamentError(writer, err)
		return
	}
	server.broadcastTournaments()
	writeJSON(writer, http.StatusOK, tournament)
}

func (server *Server) updateTournamentMatch(writer http.ResponseWriter, request *http.Request) {
	matchID, err := strconv.ParseInt(request.PathValue("matchID"), 10, 64)
	if err != nil || matchID <= 0 {
		writeAPIError(writer, http.StatusBadRequest, "matchId must be a positive integer")
		return
	}
	var input tournamentResultRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	tournament, err := server.data.SetTournamentMatchResult(
		request.Context(),
		request.PathValue("tournamentID"),
		matchID,
		input.Result,
	)
	if err != nil {
		writeTournamentError(writer, err)
		return
	}
	server.broadcastTournaments()
	writeJSON(writer, http.StatusOK, tournament)
}

func decodeAPIRequest(
	writer http.ResponseWriter,
	request *http.Request,
	destination any,
) error {
	request.Body = http.MaxBytesReader(writer, request.Body, tournamentRequestLimit)
	decoder := json.NewDecoder(request.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("invalid JSON body: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		return errors.New("invalid JSON body: only one object is allowed")
	}
	return nil
}

func writeTournamentError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, persistence.ErrTournamentNotFound),
		errors.Is(err, persistence.ErrTournamentMatchNotFound):
		writeAPIError(writer, http.StatusNotFound, err.Error())
	case errors.Is(err, persistence.ErrTournamentClosed),
		errors.Is(err, persistence.ErrTournamentAlreadyStarted),
		errors.Is(err, persistence.ErrTournamentNeedsPlayers),
		errors.Is(err, persistence.ErrTournamentSignupExists):
		writeAPIError(writer, http.StatusConflict, err.Error())
	case errors.Is(err, persistence.ErrInvalidTournament):
		message := strings.TrimPrefix(err.Error(), persistence.ErrInvalidTournament.Error()+": ")
		writeAPIError(writer, http.StatusBadRequest, message)
	default:
		log.Printf("tournament persistence: %v", err)
		writeAPIError(writer, http.StatusInternalServerError, "tournament data is unavailable")
	}
}

func writeAPIError(writer http.ResponseWriter, status int, message string) {
	writeJSON(writer, status, map[string]string{"error": message})
}
