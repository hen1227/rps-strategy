package server

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/notation"
	"rps-strategy/backend/internal/persistence"
)

// archiveSite names this deployment inside every stored game, so records
// exported from here stay identifiable once they are mixed into a data set.
const archiveSite = "RPS Strategy"

// archiveGame stores the finished game as PGN. It runs for every game that
// ends, ranked or not, and independently of the rating transaction: a game
// whose Elo could not be committed is still a game that was played, and the
// archive is the only place it survives.
func (server *Server) archiveGame(
	session *GameSession,
	finishedAt time.Time,
	update persistence.RatingUpdate,
	rated bool,
) {
	record := session.game.Record()
	metadata := notation.Metadata{
		Event:         "Casual",
		Site:          archiveSite,
		Ranked:        session.ranked,
		FinishedAt:    finishedAt,
		RedEloBefore:  session.redElo,
		BlueEloBefore: session.blueElo,
	}
	if session.ranked {
		metadata.Event = "Ranked"
	}
	tournamentID := ""
	if session.tournament != nil {
		metadata.Event = "Tournament"
		tournamentID = session.tournament.tournamentID
		// The match ID identifies the pairing; the round it belongs to lives
		// in the tournament record this ID points at.
		metadata.Round = "match-" + strconv.FormatInt(session.tournament.matchID, 10)
	}
	if rated && update.Recorded {
		metadata.RedEloBefore = update.RedEloBefore
		metadata.RedEloAfter = update.RedEloAfter
		metadata.BlueEloBefore = update.BlueEloBefore
		metadata.BlueEloAfter = update.BlueEloAfter
	}

	if _, err := server.data.ArchiveGame(
		context.Background(),
		record,
		metadata,
		tournamentID,
	); err != nil {
		log.Printf("archive game %s: %v", session.gameID, err)
	}
}

// ArchiveLiveGames stores every game still being played. The server calls
// nothing here during normal operation: this exists for shutdown, so a restart
// costs the moves already played nothing. Games are archived unfinished
// because nobody lost them — the server went away.
func (server *Server) ArchiveLiveGames(ctx context.Context) int {
	server.mu.RLock()
	sessions := make([]*GameSession, 0, len(server.games))
	for _, session := range server.games {
		sessions = append(sessions, session)
	}
	server.mu.RUnlock()

	archived := 0
	for _, session := range sessions {
		record := session.game.Record()
		if record.PlyCount() == 0 {
			continue
		}
		tournamentID := ""
		if session.tournament != nil {
			tournamentID = session.tournament.tournamentID
		}
		if _, err := server.data.ArchiveGame(ctx, record, notation.Metadata{
			Event:         "Interrupted",
			Site:          archiveSite,
			Ranked:        session.ranked,
			FinishedAt:    time.Now(),
			RedEloBefore:  session.redElo,
			BlueEloBefore: session.blueElo,
		}, tournamentID); err != nil {
			log.Printf("archive live game %s: %v", session.gameID, err)
			continue
		}
		archived++
	}
	return archived
}

func (server *Server) getGamePGN(writer http.ResponseWriter, request *http.Request) {
	archived, err := server.data.ArchivedGame(
		request.Context(),
		request.PathValue("gameID"),
	)
	if err != nil {
		writeArchiveError(writer, err)
		return
	}
	if request.URL.Query().Get("format") == "json" {
		writeJSON(writer, http.StatusOK, archived)
		return
	}
	writePGN(writer, archived.PGN)
}

func (server *Server) getAccountGamePGNs(writer http.ResponseWriter, request *http.Request) {
	limit, offset, err := pageFromQuery(request)
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	archived, err := server.data.AccountArchivedGames(
		request.Context(),
		request.PathValue("userID"),
		limit,
		offset,
	)
	if err != nil {
		writeArchiveError(writer, err)
		return
	}
	if request.URL.Query().Get("format") == "json" {
		writeJSON(writer, http.StatusOK, archived)
		return
	}
	writePGN(writer, persistence.ArchiveFile(archived))
}

// exportGamePGNs is the bulk training-data endpoint: an ordered, pageable dump
// of every archived game. It is host-only because it hands out the whole
// database in one call, unlike the per-game and per-account views.
func (server *Server) exportGamePGNs(writer http.ResponseWriter, request *http.Request) {
	limit, offset, err := pageFromQuery(request)
	if err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	query := request.URL.Query()
	filter := persistence.ArchiveFilter{
		ModeID: game.ModeID(strings.TrimSpace(query.Get("mode"))),
		Limit:  limit,
		Offset: offset,
	}
	for _, bound := range []struct {
		key   string
		field *int64
	}{
		{"since", &filter.SinceUnixMs},
		{"until", &filter.UntilUnixMs},
	} {
		value := strings.TrimSpace(query.Get(bound.key))
		if value == "" {
			continue
		}
		parsed, err := strconv.ParseInt(value, 10, 64)
		if err != nil || parsed < 0 {
			writeAPIError(
				writer,
				http.StatusBadRequest,
				bound.key+" must be a Unix timestamp in milliseconds",
			)
			return
		}
		*bound.field = parsed
	}
	if value := strings.TrimSpace(query.Get("ranked")); value != "" {
		ranked, err := strconv.ParseBool(value)
		if err != nil {
			writeAPIError(writer, http.StatusBadRequest, "ranked must be true or false")
			return
		}
		filter.Ranked = &ranked
	}

	archived, err := server.data.ExportArchivedGames(request.Context(), filter)
	if err != nil {
		writeArchiveError(writer, err)
		return
	}
	if total, err := server.data.CountArchivedGames(request.Context()); err == nil {
		writer.Header().Set("X-Archive-Total", strconv.Itoa(total))
	}

	switch query.Get("format") {
	case "json":
		writeJSON(writer, http.StatusOK, archived)
	case "jsonl":
		// One self-contained JSON object per line: the shape a training
		// pipeline can stream without loading the whole export.
		writer.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
		encoder := json.NewEncoder(writer)
		for _, record := range archived {
			if err := encoder.Encode(record); err != nil {
				return
			}
		}
	default:
		writePGN(writer, persistence.ArchiveFile(archived))
	}
}

func writePGN(writer http.ResponseWriter, text string) {
	writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
	writer.WriteHeader(http.StatusOK)
	_, _ = writer.Write([]byte(text))
}

func writeArchiveError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, persistence.ErrGamePGNNotFound):
		writeAPIError(writer, http.StatusNotFound, "no stored game with that id")
	case errors.Is(err, persistence.ErrAccountNotFound):
		writeAPIError(writer, http.StatusNotFound, err.Error())
	default:
		writeAPIError(writer, http.StatusInternalServerError, "stored games are unavailable")
	}
}

// pageFromQuery leaves limit at zero when it is absent so the store applies
// its own default for the endpoint being served.
func pageFromQuery(request *http.Request) (int, int, error) {
	limit, err := nonNegativeQueryInteger(request, "limit", 0)
	if err != nil {
		return 0, 0, err
	}
	offset, err := nonNegativeQueryInteger(request, "offset", 0)
	if err != nil {
		return 0, 0, err
	}
	return limit, offset, nil
}
