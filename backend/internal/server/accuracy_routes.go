package server

import (
	"errors"
	"net/http"
	"strings"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// A review is computed in the browser — see `backend/docs/review.md` for why
// that is where it belongs — so the server's job here is not to check the
// arithmetic but to check the claim: that the account presenting a key played
// this game as this colour. Nothing that decides a rating reads this table, so
// a player who lies about their own accuracy has fooled only themselves.
type accuracyRequest struct {
	Color                 game.PlayerColor `json:"color"`
	Accuracy              float64          `json:"accuracy"`
	AverageLossPercent    float64          `json:"averageLossPercent"`
	AverageLossCentipawns float64          `json:"averageLossCentipawns"`
	MoveCount             int              `json:"moveCount"`
	Grades                struct {
		Best       int `json:"best"`
		Excellent  int `json:"excellent"`
		Good       int `json:"good"`
		Inaccuracy int `json:"inaccuracy"`
		Mistake    int `json:"mistake"`
		Blunder    int `json:"blunder"`
	} `json:"grades"`
	Engine struct {
		Preset     string `json:"preset"`
		MaxDepth   int    `json:"maxDepth"`
		MaxNodes   int64  `json:"maxNodes"`
		MaxTimeMs  int64  `json:"maxTimeMs"`
		Variations int    `json:"variations"`
	} `json:"engine"`
}

func (server *Server) putGameAccuracy(writer http.ResponseWriter, request *http.Request) {
	profileKey := bearerToken(request)
	if profileKey == "" {
		writer.Header().Set("WWW-Authenticate", `Bearer realm="account-profile"`)
		writeAPIError(writer, http.StatusUnauthorized, "local account key is required")
		return
	}
	var input accuracyRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}

	gameID := request.PathValue("gameID")
	archived, err := server.data.ArchivedGame(request.Context(), gameID)
	if err != nil {
		writeArchiveError(writer, err)
		return
	}

	// The game says who played each colour, so the request does not get to.
	var userID string
	switch input.Color {
	case game.Red:
		userID = archived.RedPlayerID
	case game.Blue:
		userID = archived.BluePlayerID
	default:
		writeAPIError(writer, http.StatusBadRequest, "colour must be Red or Blue")
		return
	}
	if strings.TrimSpace(userID) == "" {
		writeAPIError(writer, http.StatusForbidden, "that side of this game has no account")
		return
	}
	if err := server.data.VerifyProfileKey(request.Context(), userID, profileKey); err != nil {
		switch {
		case errors.Is(err, persistence.ErrInvalidProfileKey):
			writeAPIError(writer, http.StatusForbidden, "only that player can record their own accuracy")
		case errors.Is(err, persistence.ErrAccountNotFound):
			writeAPIError(writer, http.StatusNotFound, "that player no longer has an account")
		default:
			writeAPIError(writer, http.StatusInternalServerError, "stored games are unavailable")
		}
		return
	}

	stored, err := server.data.RecordGameAccuracy(request.Context(), persistence.GameAccuracy{
		GameID:                archived.GameID,
		Color:                 input.Color,
		UserID:                userID,
		Accuracy:              input.Accuracy,
		AverageLossPercent:    input.AverageLossPercent,
		AverageLossCentipawns: input.AverageLossCentipawns,
		MoveCount:             input.MoveCount,
		BestMoves:             input.Grades.Best,
		ExcellentMoves:        input.Grades.Excellent,
		GoodMoves:             input.Grades.Good,
		Inaccuracies:          input.Grades.Inaccuracy,
		Mistakes:              input.Grades.Mistake,
		Blunders:              input.Grades.Blunder,
		EnginePreset:          input.Engine.Preset,
		EngineMaxDepth:        input.Engine.MaxDepth,
		EngineMaxNodes:        input.Engine.MaxNodes,
		EngineMaxTimeMs:       input.Engine.MaxTimeMs,
		EngineVariations:      input.Engine.Variations,
		ReportedBy:            userID,
	})
	if err != nil {
		if errors.Is(err, persistence.ErrInvalidAccuracy) {
			writeAPIError(
				writer,
				http.StatusBadRequest,
				strings.TrimPrefix(err.Error(), persistence.ErrInvalidAccuracy.Error()+": "),
			)
			return
		}
		writeAPIError(writer, http.StatusInternalServerError, "the review could not be saved")
		return
	}
	writeJSON(writer, http.StatusOK, stored)
}

func (server *Server) getGameAccuracy(writer http.ResponseWriter, request *http.Request) {
	accuracies, err := server.data.GameAccuracies(request.Context(), request.PathValue("gameID"))
	if err != nil {
		writeArchiveError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, accuracies)
}
