package server

import (
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"rps-strategy/backend/internal/persistence"
)

type updateAccountAdminRequest struct {
	Disabled *bool `json:"disabled,omitempty"`
	IsAdmin  *bool `json:"isAdmin,omitempty"`
}

// listAccounts is the admin account browser.
//
// The filters are the point of this route rather than a refinement of it. Every
// browser that has ever visited owns a Guest account, so an unfiltered list
// ordered newest-first is fifty Guests and nothing else — see
// persistence.AccountFilter, which is where that is explained at length.
//
// Nothing here has a default beyond the store's own: `?registered=true` is what
// hides the Guests, and it is the *client* that opens with it applied. Keeping
// the route neutral means "give me everything" stays expressible, which a host
// hunting one particular anonymous browser needs.
func (server *Server) listAccounts(writer http.ResponseWriter, request *http.Request) {
	query := request.URL.Query()
	limit, _ := strconv.Atoi(query.Get("limit"))
	offset, _ := strconv.Atoi(query.Get("offset"))
	filter := persistence.AccountFilter{
		Query:         query.Get("query"),
		Registered:    optionalBool(query.Get("registered")),
		DiscordLinked: optionalBool(query.Get("discord")),
		Disabled:      optionalBool(query.Get("disabled")),
		IsAdmin:       optionalBool(query.Get("admin")),
		Kind:          strings.TrimSpace(query.Get("kind")),
		Sort:          persistence.AccountSort(query.Get("sort")),
		Limit:         limit,
		Offset:        offset,
	}
	if minGames, err := strconv.Atoi(query.Get("minGames")); err == nil {
		filter.MinGames = minGames
	}
	// `activeWithinHours` rather than an instant, because the client is asking
	// "in the last hour" and the two clocks need not agree for that to work.
	if hours, err := strconv.ParseFloat(query.Get("activeWithinHours"), 64); err == nil &&
		hours > 0 {
		filter.ActiveSinceUnixMs = time.Now().
			Add(-time.Duration(hours * float64(time.Hour))).UnixMilli()
	}
	if filter.Kind != "" &&
		filter.Kind != persistence.AccountKindHuman &&
		filter.Kind != persistence.AccountKindBot {
		writeAPIError(writer, http.StatusBadRequest, "kind must be human or bot")
		return
	}

	page, err := server.data.SearchAccounts(request.Context(), filter)
	if err != nil {
		writeAdminAccountError(writer, err)
		return
	}
	// The sanctions come from memory rather than from a join: the server already
	// holds every restriction in force — see moderation.go — so a badge on a row
	// costs a map lookup instead of a query per page.
	rows := make([]adminAccountRow, 0, len(page.Accounts))
	for _, account := range page.Accounts {
		rows = append(rows, adminAccountRow{
			AccountSummary: account,
			Restrictions:   server.activeRestrictions(account.UserID),
		})
	}
	writeJSON(writer, http.StatusOK, adminAccountPage{Accounts: rows, Total: page.Total})
}

// adminAccountRow is one row of the browser: the stored summary, plus what the
// running server knows about it.
type adminAccountRow struct {
	persistence.AccountSummary
	// Restrictions is what is in force on this account, so the list can mark a
	// muted or barred player without the host expanding every row to find out.
	Restrictions []persistence.PublicRestriction `json:"restrictions,omitempty"`
}

type adminAccountPage struct {
	Accounts []adminAccountRow `json:"accounts"`
	Total    int               `json:"total"`
}

// optionalBool reads a tri-state query parameter: absent means "do not care",
// which is a different answer from false and has to stay expressible.
func optionalBool(raw string) *bool {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "":
		return nil
	case "false", "0", "no":
		value := false
		return &value
	default:
		value := true
		return &value
	}
}

// updateAccountAdmin toggles the two flags an administrator owns.
//
// Both are optional and applied independently, so a client that only wants to
// disable somebody does not have to restate their admin status and risk
// clobbering it.
func (server *Server) updateAccountAdmin(writer http.ResponseWriter, request *http.Request) {
	userID := request.PathValue("userID")
	var input updateAccountAdminRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if input.Disabled != nil {
		if err := server.data.SetAccountDisabled(request.Context(), userID, *input.Disabled); err != nil {
			writeAdminAccountError(writer, err)
			return
		}
		if *input.Disabled {
			// A ban that leaves the banned player sitting in the lobby is not
			// one yet.
			server.disconnectAccount(userID, "this account has been disabled")
		}
	}
	if input.IsAdmin != nil {
		if err := server.data.SetAccountAdmin(request.Context(), userID, *input.IsAdmin); err != nil {
			writeAdminAccountError(writer, err)
			return
		}
	}
	account, err := server.data.Account(request.Context(), userID)
	if err != nil {
		writeAdminAccountError(writer, err)
		return
	}
	writeJSON(writer, http.StatusOK, account)
}

// deleteAccount anonymizes rather than deletes, whenever the account has
// played. See persistence.AnonymizeAccount for why that is not a shortcut.
func (server *Server) deleteAccount(writer http.ResponseWriter, request *http.Request) {
	userID := request.PathValue("userID")
	rewritten, err := server.data.AnonymizeAccount(request.Context(), userID)
	if err != nil {
		writeAdminAccountError(writer, err)
		return
	}
	server.disconnectAccount(userID, "this account has been removed")
	// See the same call in deleteOwnAccount: an anonymized account keeps its
	// row, but a never-played one is deleted outright and takes its block rows
	// with it. The cache has to be told either way, since it is what every
	// enforcement path actually reads.
	server.forgetBlocksOf(userID)
	writeJSON(writer, http.StatusOK, map[string]any{
		"anonymized":       true,
		"recordsRewritten": rewritten,
	})
}

// disconnectAccount closes every connection an account holds.
func (server *Server) disconnectAccount(userID string, reason string) {
	for _, client := range server.connectedClients() {
		if client.profile.UserID != userID {
			continue
		}
		client.Send(ServerMessage{Type: "authentication_failed", Message: reason})
		client.close()
	}
}

func writeAdminAccountError(writer http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, persistence.ErrAccountNotFound):
		writeAPIError(writer, http.StatusNotFound, "no such account")
	case errors.Is(err, persistence.ErrLastAdministrator):
		writeAPIError(writer, http.StatusConflict, err.Error())
	default:
		writeAPIError(writer, http.StatusInternalServerError, err.Error())
	}
}
