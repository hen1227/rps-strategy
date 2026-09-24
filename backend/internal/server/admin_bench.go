package server

import (
	"errors"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"rps-strategy/backend/internal/persistence"
)

// The host's three routes for the scheduled bot bench: read the schedule, add a
// window, take one off.
//
// The whole argument for why this exists is in bot_bench.go, and the short
// version is that a bench used to need a deploy. These are what make it not.
//
// There is deliberately no edit. A window is two instants and a sentence, and
// "delete and add" says the same thing in one fewer route with no partial-update
// question to answer — and, more to the point, a host correcting a bench an hour
// before it opens should be reading the times they are about to commit to rather
// than a form pre-filled with the ones that were wrong.

// maximumBenchReasonRunes caps the sentence a player is shown. It is the length
// of the refusal in bot_benchRefusal minus the words around it — long enough to
// name an event and where it is, short enough not to break the lobby.
const maximumBenchReasonRunes = 160

// maximumBenchLabelRunes caps the "back at four" half.
const maximumBenchLabelRunes = 40

// AdminBenchWindow is one scheduled window as the host's screen draws it.
//
// Active and the stored record together, rather than the record alone, because
// the screen's only interesting question is which of these is happening now and
// the client would otherwise re-derive that from a clock this server already
// read. See BotBenchState for the same reasoning aimed at players.
type AdminBenchWindow struct {
	persistence.BotBenchWindow
	// Active is whether this window covers the moment the list was read.
	Active bool `json:"active"`
	// Past is whether it is over. Kept apart from `!Active` because the screen
	// says three different things — over, running, coming — and a single flag
	// would collapse two of them.
	Past bool `json:"past"`
}

// adminBenchWindows is the schedule, annotated against now.
func (server *Server) adminBenchWindows(
	request *http.Request,
) ([]AdminBenchWindow, error) {
	stored, err := server.data.BotBenchWindows(request.Context())
	if err != nil {
		return nil, err
	}
	now := time.Now().UnixMilli()
	windows := make([]AdminBenchWindow, 0, len(stored))
	for _, record := range stored {
		windows = append(windows, AdminBenchWindow{
			BotBenchWindow: record,
			Active:         now >= record.FromUnixMs && now < record.UntilUnixMs,
			Past:           now >= record.UntilUnixMs,
		})
	}
	return windows, nil
}

// listBenchWindows is GET /api/admin/bot-bench.
func (server *Server) listBenchWindows(writer http.ResponseWriter, request *http.Request) {
	windows, err := server.adminBenchWindows(request)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not read the bench schedule")
		return
	}
	writeJSON(writer, http.StatusOK, windows)
}

// addBenchWindowRequest is the form the admin screen posts.
//
// Instants rather than a date, a time and a zone: the browser knows what zone
// the person typing is in and this server does not, so the conversion happens
// where the knowledge is. See the note on botBenchWindow about why a wall clock
// plus a location is the spelling that drifts.
type addBenchWindowRequest struct {
	Reason      string `json:"reason"`
	UntilLabel  string `json:"untilLabel"`
	FromUnixMs  int64  `json:"fromUnixMs"`
	UntilUnixMs int64  `json:"untilUnixMs"`
}

// addBenchWindow is POST /api/admin/bot-bench.
func (server *Server) addBenchWindow(writer http.ResponseWriter, request *http.Request) {
	var input addBenchWindowRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}

	reason := strings.TrimSpace(input.Reason)
	label := strings.TrimSpace(input.UntilLabel)
	if reason == "" {
		writeAPIError(writer, http.StatusBadRequest,
			"enter a reason to show players")
		return
	}
	if !utf8.ValidString(reason) || utf8Length(reason) > maximumBenchReasonRunes {
		writeAPIError(writer, http.StatusBadRequest,
			"the reason must be 160 characters or fewer")
		return
	}
	if label == "" {
		writeAPIError(writer, http.StatusBadRequest,
			"say when the engines are back, in the timezone the event was announced in")
		return
	}
	if !utf8.ValidString(label) || utf8Length(label) > maximumBenchLabelRunes {
		writeAPIError(writer, http.StatusBadRequest,
			"the 'back at' label must be 40 characters or fewer")
		return
	}
	if input.UntilUnixMs <= input.FromUnixMs {
		writeAPIError(writer, http.StatusBadRequest, "the window ends before it starts")
		return
	}
	// A window wholly in the past is refused rather than stored. It would
	// enforce nothing, and the one thing it *would* do is sit at the top of the
	// schedule looking like cover the ladder does not have — which is the exact
	// mistake this screen exists to prevent. A window already running is fine:
	// that is how a host benches the engines right now.
	if input.UntilUnixMs <= time.Now().UnixMilli() {
		writeAPIError(writer, http.StatusBadRequest, "that window has already finished")
		return
	}

	id, err := randomID()
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not schedule the bench")
		return
	}
	window := persistence.BotBenchWindow{
		ID:              "bench-" + id,
		Reason:          reason,
		UntilLabel:      label,
		FromUnixMs:      input.FromUnixMs,
		UntilUnixMs:     input.UntilUnixMs,
		CreatedAtUnixMs: time.Now().UnixMilli(),
		CreatedBy:       server.adminActor(request),
	}
	if err := server.data.AddBotBenchWindow(request.Context(), window); err != nil {
		if errors.Is(err, persistence.ErrInvalidBotBenchWindow) {
			writeAPIError(writer, http.StatusBadRequest, err.Error())
			return
		}
		writeAPIError(writer, http.StatusInternalServerError, "could not schedule the bench")
		return
	}
	server.benchScheduleChanged(request)
	writeJSON(writer, http.StatusOK, window)
}

// deleteBenchWindow is DELETE /api/admin/bot-bench/{windowID}.
func (server *Server) deleteBenchWindow(writer http.ResponseWriter, request *http.Request) {
	id := strings.TrimSpace(request.PathValue("windowID"))
	removed, err := server.data.DeleteBotBenchWindow(request.Context(), id)
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not cancel the bench")
		return
	}
	if !removed {
		writeAPIError(writer, http.StatusNotFound, "no such scheduled bench")
		return
	}
	server.benchScheduleChanged(request)
	writeJSON(writer, http.StatusOK, map[string]bool{"cancelled": true})
}

// benchScheduleChanged refills the cache and tells everybody.
//
// The broadcast is not decoration. Cancelling a running bench has to put the
// engines back on the ladder *visibly*, and adding one has to move the "the
// engines go offline at a quarter to ten" line onto every open page — otherwise
// the schedule is right and the site goes on saying something else until the
// next thing happens to any bot on the server.
func (server *Server) benchScheduleChanged(request *http.Request) {
	server.reloadBotBenches(request.Context())
	server.broadcastBots()
}

// adminActor is who is making an administrative request, when that is knowable.
//
// Empty for the shared host token, which is an identity the server does not
// have and must not invent: a bench scheduled with it is recorded as scheduled
// by nobody, which is true.
func (server *Server) adminActor(request *http.Request) string {
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
