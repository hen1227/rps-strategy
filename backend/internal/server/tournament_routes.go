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

	"rps-strategy/backend/internal/persistence"
)

const tournamentRequestLimit = 16 << 10

type tournamentSignupRequest struct {
	UserID                 string `json:"userId"`
	IGN                    string `json:"ign"`
	Discord                string `json:"discord"`
	AgreedToUnfilteredChat bool   `json:"agreedToUnfilteredChat"`
	ReservationToken       string `json:"reservationToken"`
	// BotID used to enter one of the caller's engines instead of the caller.
	//
	// It is kept only so that a client still sending it gets a sentence saying
	// where the switch is, rather than the "unknown field botId" that
	// DisallowUnknownFields would otherwise produce. An engine is not entered one
	// event at a time any more — see enrolOnlineBots, and `enterTournaments` on
	// the bot itself.
	BotID string `json:"botId"`
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
	writeJSON(writer, http.StatusOK, publicTournaments(tournaments))
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
	// An unpublished event answers as though it does not exist, because to
	// everybody but its host it does not. Anything softer — a 403, a stub —
	// would confirm the id, which is the one thing a draft's address must not
	// do. The host reads it through GET /api/admin/tournaments instead.
	if tournament.Status == persistence.TournamentDraft && !server.requestIsAdmin(request) {
		writeAPIError(writer, http.StatusNotFound, persistence.ErrTournamentNotFound.Error())
		return
	}
	writeJSON(writer, http.StatusOK, tournament)
}

// signupForTournament enters the caller. People only.
//
// An engine is not entered here and is not entered anywhere else one event at a
// time: it has a standing switch instead, and every online engine with that
// switch on is swept into the field when an event it can play begins. See
// enrolOnlineBots for the sweep and botTournamentSwitchHint for why this route
// used to take a botId and now only explains itself.
//
// That is not a shortcut around the rules; it moves the choice to where it
// reads the same on every screen. An author with three engines was choosing one
// of them per event under a one-place-per-party rule, while the arena — the only
// event most of them ever enter — swept in all three regardless. Two mechanisms
// answering the same question differently is the whole of what was confusing,
// and the switch is the one that was already deciding.
func (server *Server) signupForTournament(writer http.ResponseWriter, request *http.Request) {
	var signup tournamentSignupRequest
	if err := decodeAPIRequest(writer, request, &signup); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if strings.TrimSpace(signup.BotID) != "" {
		writeAPIError(writer, http.StatusConflict, botTournamentSwitchHint)
		return
	}
	// An engine is never entered by naming its account here. Without this the
	// rule above is decoration: bot account ids are on every game record, so this
	// route would take one from anybody.
	if _, err := server.data.BotForAccount(request.Context(), signup.UserID); err == nil {
		writeAPIError(writer, http.StatusForbidden, botTournamentSwitchHint)
		return
	} else if !errors.Is(err, persistence.ErrBotNotFound) {
		writeBotError(writer, err)
		return
	}
	// Both halves still apply here, unlike the account routes: a tournament
	// signup types its own Discord handle into a form, so nothing has proved
	// the person entering it owns it.
	if (persistence.IsReservedUsername(signup.IGN) ||
		persistence.IsReservedContact(signup.Discord)) &&
		!server.hasValidAdminTokenValue(signup.ReservationToken) {
		writeAPIError(writer, http.StatusForbidden, "this username or Discord handle is reserved; paste the special token")
		return
	}
	// Barred accounts are refused at the door rather than removed later: a
	// signup that has to be undone has already appeared in the field, and
	// probably in a screenshot.
	if refusal := server.tournamentRefusal(signup.UserID); refusal != "" {
		writeAPIError(writer, http.StatusForbidden, refusal)
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

// withdrawFromTournament takes the caller's own entry back out.
//
// Signed in rather than named in the body, and it removes the account that
// asked and nothing else. An engine is not withdrawn here — it holds its own
// entry under its own account, which nobody has a session for, and it leaves
// events the way it enters them: its owner turns the switch off. See
// WithdrawTournamentEntry for why this is the account rather than its party,
// and botTournamentSwitchHint for what an owner looking for the button is told.
//
// Registration only. WithdrawTournamentEntry is where that rule is enforced and
// explained.
func (server *Server) withdrawFromTournament(writer http.ResponseWriter, request *http.Request) {
	account, ok := server.requireSession(writer, request)
	if !ok {
		return
	}
	tournament, _, err := server.data.WithdrawTournamentEntry(
		request.Context(),
		request.PathValue("tournamentID"),
		account.UserID,
	)
	if err != nil {
		writeTournamentError(writer, err)
		return
	}
	server.broadcastTournaments()
	writeJSON(writer, http.StatusOK, tournament)
}

func (server *Server) getAdminSession(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, map[string]bool{"admin": true})
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
	// The host entering the last result finishes the tournament just as the
	// last game finishing does, so it crowns a champion the same way.
	server.awardTournamentTitles(request.Context(), tournament)
	// The field has just been closed, which is the moment its engines go into
	// reserve. The lobby ticker would notice within a couple of seconds; doing
	// it here closes the window in which a bot in a running event can still be
	// challenged. See bot_reserve.go.
	server.refreshBotReservations()
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
	// The last result finishes the event, which releases its engines.
	server.refreshBotReservations()
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
		errors.Is(err, persistence.ErrTournamentEntryNotFound),
		errors.Is(err, persistence.ErrTournamentMatchNotFound):
		writeAPIError(writer, http.StatusNotFound, err.Error())
	case errors.Is(err, persistence.ErrTournamentClosed),
		errors.Is(err, persistence.ErrTournamentAlreadyStarted),
		errors.Is(err, persistence.ErrTournamentNeedsPlayers),
		errors.Is(err, persistence.ErrTournamentSignupExists),
		errors.Is(err, persistence.ErrTournamentAlreadyEntered),
		errors.Is(err, persistence.ErrTournamentPublished),
		errors.Is(err, persistence.ErrTournamentCancelled),
		errors.Is(err, persistence.ErrTournamentNotHideable),
		errors.Is(err, persistence.ErrTournamentFull):
		writeAPIError(writer, http.StatusConflict, err.Error())
	case errors.Is(err, persistence.ErrTournamentFieldClosed),
		errors.Is(err, persistence.ErrTournamentDiscordRequired):
		writeAPIError(writer, http.StatusForbidden, err.Error())
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
