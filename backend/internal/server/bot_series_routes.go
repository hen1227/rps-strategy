package server

import (
	"errors"
	"net/http"
	"strconv"
	"strings"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// Starting a series, from either door.
//
// It used to be one administrative route, on the reasoning that a run costs two
// engines' time and only the host should be able to spend it. That reasoning
// held for the cost and not for the permission: the bots are other people's
// programs, and every one of them already carries a switch saying whether
// strangers may play it. So the public route asks that switch, applies the
// ceilings in bot_series.go, and is otherwise the same call the host makes.
//
// The administrative route stays, and not only for compatibility: it is the one
// that can run fifty pairs at a long time control, which is what the host wants
// when the question is which of two engines is actually better.

type startSeriesRequest struct {
	FirstBotID   string      `json:"firstBotId"`
	SecondBotID  string      `json:"secondBotId"`
	ModeID       game.ModeID `json:"modeId"`
	Pairs        int         `json:"pairs"`
	OpeningPlies int         `json:"openingPlies"`
	// A string, matching the way a series reports its seed. A client that read
	// one off a finished run has to be able to send it back unharmed, and a
	// JSON number cannot carry it there.
	Seed        string            `json:"seed"`
	TimeControl *game.TimeControl `json:"timeControl"`
}

// ask fills in the parts of a run that come off the wire, leaving the caller to
// say who is asking. Shared so the two routes cannot drift on a default.
func (input startSeriesRequest) ask() BotSeriesRequest {
	control := game.DefaultTimeControl()
	if input.TimeControl != nil {
		control = *input.TimeControl
	}
	// An unparseable seed is a zero, which is what the server treats "pick one
	// for me" as: refusing the whole request over a typo in an optional field
	// would be worse than ignoring it.
	seed, _ := strconv.ParseUint(strings.TrimSpace(input.Seed), 10, 64)
	return BotSeriesRequest{
		FirstBotID:   input.FirstBotID,
		SecondBotID:  input.SecondBotID,
		ModeID:       input.ModeID,
		Pairs:        input.Pairs,
		OpeningPlies: input.OpeningPlies,
		Seed:         seed,
		Control:      control,
	}
}

// startBotSeries lets anybody pit two bots against each other.
//
// Identity is resolved the permissive way — a login when there is one, this
// browser's own Guest account otherwise — because a visitor who has not
// registered is exactly the person most likely to want to watch two engines
// play, and refusing them would leave the feature to the people who need it
// least. What the identity is *for* is attribution and the two ceilings: the
// row says who started the run, and one account may hold one slot.
func (server *Server) startBotSeries(writer http.ResponseWriter, request *http.Request) {
	var input startSeriesRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	account, ok := server.requireAnyIdentity(writer, request)
	if !ok {
		return
	}
	if !server.allowSeriesRequest(writer, request, account.UserID) {
		return
	}

	ask := input.ask()
	ask.RequestedBy = account.UserID
	// An administrator who is signed in gets the administrator's ceilings on
	// this route too, so there is no reason for them to hold two tokens.
	ask.Privileged = server.requestIsAdmin(request)

	series, err := server.StartBotSeries(request.Context(), ask)
	if err != nil {
		writeSeriesError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, series)
}

// startAdminBotSeries is the host's route: the same run without the ceilings.
func (server *Server) startAdminBotSeries(writer http.ResponseWriter, request *http.Request) {
	var input startSeriesRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	ask := input.ask()
	ask.RequestedBy = server.seriesRequester(request)
	ask.Privileged = true

	series, err := server.StartBotSeries(request.Context(), ask)
	if err != nil {
		writeSeriesError(writer, err)
		return
	}
	writeJSON(writer, http.StatusCreated, series)
}

// abortBotSeries stops a run its caller started.
func (server *Server) abortBotSeries(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireAnyIdentity(writer, request)
	if !ok {
		return
	}
	err := server.AbortBotSeries(
		request.PathValue("seriesID"),
		account.UserID,
		server.requestIsAdmin(request),
	)
	if err != nil {
		writeSeriesError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]bool{"aborted": true})
}

// abortAdminBotSeries stops any run, whoever started it.
func (server *Server) abortAdminBotSeries(writer http.ResponseWriter, request *http.Request) {
	if err := server.AbortBotSeries(request.PathValue("seriesID"), "", true); err != nil {
		writeSeriesError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, map[string]bool{"aborted": true})
}

// seriesRequester names the account behind an administrative request, when
// there is one. The shared host token is a secret rather than a person, so a run
// started with it is attributed to nobody rather than to a guess.
func (server *Server) seriesRequester(request *http.Request) string {
	token := sessionToken(request)
	if token == "" {
		return ""
	}
	account, err := server.data.SessionAccount(request.Context(), token)
	if err != nil {
		return ""
	}
	return account.UserID
}

// getBotSeriesList and getBotSeries are public: a series is a spectacle, and
// hiding the scoreboard from the people watching the games would be strange.
func (server *Server) getBotSeriesList(writer http.ResponseWriter, request *http.Request) {
	// `?game=` asks the same question the other way round: not "what has been
	// run lately" but "what run was this game part of". One route because one
	// answer shape — a client that gets a list back can render it the same way
	// whether it asked for the last twelve or for the one containing a game.
	if gameID := strings.TrimSpace(request.URL.Query().Get("game")); gameID != "" {
		series, err := server.data.BotSeriesForGame(request.Context(), gameID)
		if errors.Is(err, persistence.ErrBotSeriesNotFound) {
			writeJSON(writer, http.StatusOK, []persistence.BotSeries{})
			return
		}
		if err != nil {
			writeSeriesError(writer, err)
			return
		}
		writeJSON(writer, http.StatusOK, []persistence.BotSeries{series})
		return
	}
	limit, _ := strconv.Atoi(request.URL.Query().Get("limit"))
	list, err := server.data.BotSeriesList(request.Context(), limit)
	if err != nil {
		writeSeriesError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, list)
}

func (server *Server) getBotSeries(writer http.ResponseWriter, request *http.Request) {
	series, err := server.data.BotSeries(request.Context(), request.PathValue("seriesID"))
	if err != nil {
		writeSeriesError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, series)
}

func writeSeriesError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, persistence.ErrBotSeriesNotFound):
		writeAPIError(writer, http.StatusNotFound, "no such series")
	case errors.Is(err, errSeriesNotRunning):
		writeAPIError(writer, http.StatusNotFound, err.Error())
	case errors.Is(err, errSeriesSameBot),
		errors.Is(err, errSeriesPairCount),
		errors.Is(err, errSeriesOpeningPlies),
		errors.Is(err, errSeriesMode),
		errors.Is(err, errSeriesPublicPairs),
		errors.Is(err, errSeriesPublicClock):
		writeAPIError(writer, http.StatusBadRequest, err.Error())
	case errors.Is(err, errSeriesBotPrivate), errors.Is(err, errSeriesNotYours):
		writeAPIError(writer, http.StatusForbidden, err.Error())
	case errors.Is(err, errSeriesBotOffline),
		errors.Is(err, errSeriesBotBusy),
		errors.Is(err, errSeriesBotDraining),
		errors.Is(err, errSeriesAlreadyYours),
		errors.Is(err, errSeriesServerBusy):
		writeAPIError(writer, http.StatusConflict, err.Error())
	default:
		writeAPIError(writer, http.StatusInternalServerError, "could not start the series")
	}
}
