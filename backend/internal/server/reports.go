package server

import (
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"rps-strategy/backend/internal/persistence"
)

// The report button, and the queue it fills.
//
// persistence/reports.go holds the shape of a report and the reasoning behind
// storing evidence as a snapshot. This file is the two ends: the route anybody
// may call to file one, and the admin routes that read and resolve them.
//
// # Why a guest may file one
//
// requireAnyIdentity rather than requireSession, which is the opposite of the
// choice blocks.go makes, and the difference is worth stating. A block is a
// durable preference that has to survive a cleared browser, so it needs an
// account. A report is a single message that is acted on within a day and never
// consulted by its author again — so requiring a sign-in first would buy
// nothing except a dead button in front of the player most likely to need it,
// which is the one who arrived five minutes ago and met somebody unpleasant.
//
// What stands in for the account requirement is the rate limit below.

const (
	// reportWindow and reportsPerWindow bound how fast one account can file.
	//
	// Six an hour: high enough that somebody having a genuinely bad session can
	// report everyone involved in it, low enough that the queue cannot be
	// buried by one person. Counted in the database rather than in memory,
	// because reconnecting must not reset it.
	reportWindow     = time.Hour
	reportsPerWindow = 6
)

type reportRequest struct {
	// TargetUserID and TargetUsername: the id when the client has one — a chat
	// line carries it — and the name otherwise. See resolveTarget.
	TargetUserID   string `json:"targetUserId"`
	TargetUsername string `json:"targetUsername"`
	Category       string `json:"category"`
	Details        string `json:"details"`
	GameID         string `json:"gameId"`
	// Context is the evidence the client attached: the chat lines around the
	// incident, already rendered as text. Sent by the client rather than
	// gathered here because the room lives in server memory and is gone by the
	// time anybody reads the report — see persistence/reports.go.
	Context string `json:"context"`
}

// fileReport records a report and acknowledges it.
func (server *Server) fileReport(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireAnyIdentity(writer, request)
	if !ok {
		return
	}
	var input reportRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	category := persistence.ReportCategory(strings.TrimSpace(input.Category))
	if !category.Valid() {
		writeAPIError(writer, http.StatusBadRequest, "choose a reason for this report")
		return
	}

	recent, err := server.data.ReportsSinceBy(
		request.Context(), account.UserID, time.Now().Add(-reportWindow).UnixMilli(),
	)
	if err != nil {
		writeReportError(writer, err)
		return
	}
	if recent >= reportsPerWindow {
		writeAPIError(
			writer,
			http.StatusTooManyRequests,
			"you have filed several reports recently; they are all in the queue, "+
				"and you can file more in an hour",
		)
		return
	}

	// The name is what a report is really about — see the note on snapshots —
	// so it is resolved from the account when there is one, and taken from the
	// client's word when there is not.
	// The id is only kept when an account actually answers to it. A client
	// sends both, and the id is its word for who this is about — storing an
	// unverified one would let anybody inflate the "other open reports" count
	// the admin queue shows against a name, which is precisely the number a
	// host leans on when deciding.
	//
	// An unresolvable target is still a report worth filing: they may have been
	// renamed or removed since, and the host can still read what happened. Only
	// the id is lost.
	targetID, targetName := "", strings.TrimSpace(input.TargetUsername)
	resolved, err := server.resolveTarget(
		request.Context(), input.TargetUserID, input.TargetUsername,
	)
	if err != nil && !errors.Is(err, persistence.ErrAccountNotFound) {
		writeReportError(writer, err)
		return
	}
	if err == nil {
		if target, err := server.data.Account(request.Context(), resolved); err == nil {
			targetID = target.UserID
			targetName = target.Username
		}
	}

	report, err := server.data.CreateReport(request.Context(), persistence.NewReport{
		ReporterUserID: account.UserID,
		ReporterName:   account.Username,
		TargetUserID:   targetID,
		TargetName:     targetName,
		Category:       category,
		Details:        input.Details,
		GameID:         input.GameID,
		Context:        input.Context,
	})
	if err != nil {
		writeReportError(writer, err)
		return
	}
	log.Printf(
		"report %s filed by %s against %q (%s)",
		report.ReportID, account.UserID, report.TargetName, report.Category,
	)
	// Only the id and the promise. A report is not a receipt the reporter comes
	// back to read, and echoing the stored row would hand back the evidence
	// snapshot for no purpose.
	writeJSON(writer, http.StatusCreated, map[string]any{
		"reportId": report.ReportID,
		"filed":    true,
	})
}

// reportCategories publishes the list the report form offers, so the client
// does not restate it and then drift from the server's idea of what is valid.
//
// The same reasoning as /api/identity/policy, which publishes the username rule
// for the same reason.
func (server *Server) reportCategories(writer http.ResponseWriter, _ *http.Request) {
	type category struct {
		ID    persistence.ReportCategory `json:"id"`
		Label string                     `json:"label"`
	}
	categories := make([]category, 0, len(persistence.ReportCategories))
	for _, id := range persistence.ReportCategories {
		categories = append(categories, category{ID: id, Label: id.Label()})
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"categories":  categories,
		"maxDetails":  persistence.MaximumReportDetailRunes,
		"contactName": moderationContact,
	})
}

// moderationContact is where a report goes when the queue is not the right
// place for it — an emergency, or a complaint about the host.
//
// Published rather than hard-coded into the frontend so the two cannot drift,
// and required by the same guideline the report button is: an app that carries
// user content has to say how to reach the person responsible for it.
const moderationContact = "@henhen1227"

/* -------------------------------------------------------- the admin queue -- */

// listReports is the queue.
func (server *Server) listReports(writer http.ResponseWriter, request *http.Request) {
	query := request.URL.Query()
	limit, _ := strconv.Atoi(query.Get("limit"))
	offset, _ := strconv.Atoi(query.Get("offset"))
	page, err := server.data.Reports(request.Context(), persistence.ReportFilter{
		Status: persistence.ReportStatus(strings.TrimSpace(query.Get("status"))),
		Limit:  limit,
		Offset: offset,
	})
	if err != nil {
		writeReportError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, page)
}

type resolveReportRequest struct {
	Status string `json:"status"`
	Note   string `json:"note"`
}

// resolveReport records that somebody looked at one.
func (server *Server) resolveReport(writer http.ResponseWriter, request *http.Request) {
	var input resolveReportRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	// Who read it, for the record, resolved the same way a sanction's issuer
	// is: off the session when there is one, and empty for an administrator
	// holding the shared token, who has no account to name.
	resolvedBy := ""
	if account, ok := server.optionalSession(request); ok {
		resolvedBy = account.UserID
	}
	report, err := server.data.ResolveReport(
		request.Context(),
		request.PathValue("reportID"),
		persistence.ReportStatus(strings.TrimSpace(input.Status)),
		resolvedBy,
		input.Note,
	)
	if err != nil {
		writeReportError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, report)
}

func writeReportError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, persistence.ErrReportNotFound):
		writeAPIError(writer, http.StatusNotFound, "no such report")
	case errors.Is(err, persistence.ErrCannotReportSelf):
		writeAPIError(writer, http.StatusBadRequest, err.Error())
	case errors.Is(err, persistence.ErrUnknownReportCategory),
		errors.Is(err, persistence.ErrUnknownReportStatus),
		errors.Is(err, persistence.ErrReportNeedsTarget),
		errors.Is(err, persistence.ErrReportNeedsDetails):
		writeAPIError(writer, http.StatusBadRequest, err.Error())
	case errors.Is(err, persistence.ErrAccountNotFound):
		writeAPIError(writer, http.StatusNotFound, "no such player")
	default:
		log.Printf("content report: %v", err)
		writeAPIError(writer, http.StatusInternalServerError, err.Error())
	}
}
