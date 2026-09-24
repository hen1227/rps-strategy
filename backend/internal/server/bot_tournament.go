package server

import (
	"context"
	"errors"
	"net/http"
	"slices"
	"strings"

	"rps-strategy/backend/internal/persistence"
)

// Bots in tournaments.
//
// There is no parallel scheduler here, deliberately. A tournament already
// knows how to build a signup-order round robin, seat two players in an
// ordinary game, record the result, and update the standings. All a bot needs
// is to be entered like anyone else and then to turn up when its match is
// due — so that is all this file does: the sweep that enters it, and the sweep
// that notices when its match has come round.
//
// # An engine does not register
//
// It has a switch. `enterTournaments` on the bot is the whole of an author's
// say in the matter, and everything below reads it: an engine that is online
// with the switch on is entered when an event it can play begins, and one with
// the switch off is never entered by anything.
//
// It used to be both — a standing switch *and* a per-event registration an owner
// pressed. They answered the same question in two voices and disagreed in the
// case that mattered: the weekend arena, which is the only event most engines
// ever see, swept in every online engine whatever anybody had registered, so the
// registration it offered was decoration. Worse, the registration carried a
// one-place-per-party rule, so an author with three engines was made to choose
// between them for an event that would take all three anyway.
//
// So the registration is gone and the switch is what decides. An author who
// wants their engine in events turns it on once, rather than per event and per
// engine, and the answer on the page matches what the sweep will do.

// enrollBots enters every connected engine that is set to enter tournaments.
//
// The host's tool, and it is the same sweep the arena runs on its own timer —
// this is the button for an event that is not on a timer, a bots-only cup whose
// field the host is assembling from whatever is up.
//
// # What it overrides, and what it does not
//
// It seats **every** eligible engine, including two from the same author, by
// going through the door with the one-place-per-party rule lifted. That rule is
// about an entrant choosing between themselves and their own bots, and nobody is
// choosing here: an author who happens to run two of the four has not taken the
// event from anybody. See HostSignupForTournament.
//
// Everything else stands. An engine whose owner switched events off is not
// conscripted, and neither is one that is shutting down, barred, or unable to
// play the game — which is why the reply is two lists rather than a count. An
// engine that was *not* enrolled is the interesting outcome, and each reason has
// a different fix.
func (server *Server) enrollBots(writer http.ResponseWriter, request *http.Request) {
	tournamentID := request.PathValue("tournamentID")
	tournament, err := server.data.Tournament(request.Context(), tournamentID)
	if err != nil {
		writeTournamentError(writer, err)
		return
	}
	if tournament.Status != persistence.TournamentRegistration {
		writeAPIError(writer, http.StatusConflict, "this tournament is no longer taking signups")
		return
	}
	// Asked once rather than once per engine. It is a fact about the event, and
	// reporting it as a per-bot refusal would answer "why did nothing happen"
	// with the same sentence repeated down the roster.
	if !tournament.Field.Admits(persistence.AccountKindBot) {
		writeAPIError(
			writer, http.StatusConflict,
			"this event is "+tournament.Field.Label()+", so no engine can enter it",
		)
		return
	}

	enrolled, skipped := server.enrolOnlineBots(request.Context(), tournament)
	slices.Sort(enrolled)

	server.broadcastTournaments()
	writeJSON(writer, http.StatusOK, map[string]any{
		"enrolled": enrolled,
		"skipped":  skipped,
	})
}

// enrolOnlineBots is the sweep itself, without a request around it.
//
// Shared by the host's button and by the weekend scheduler, which does the same
// thing on a timer. Neither is an owner choosing, so both go through the door
// that lifts the one-place-per-party rule — see HostSignupForTournament.
//
// Returns the engines it just entered and, for each one left out, why. The
// second half is the interesting one: an engine that was not enrolled is
// skipped for a reason, and each reason has a different fix.
//
// Note what the first half is *not*: the field. An engine already entered is
// skipped silently, so a caller asking "is there an event here" has to count the
// bracket rather than this slice. See weekendFieldSize, which is that caller and
// which used to get it wrong.
func (server *Server) enrolOnlineBots(
	ctx context.Context,
	tournament persistence.Tournament,
) ([]string, map[string]string) {
	enrolled := make([]string, 0)
	skipped := make(map[string]string)
	for _, presence := range server.botRoster() {
		client := server.readyBot(presence.BotID)
		if client == nil {
			continue
		}
		client.bot.mu.Lock()
		record := client.bot.record
		handshake := client.bot.handshake
		client.bot.mu.Unlock()

		if !record.EnterTournaments {
			skipped[record.Name] = "not entering tournaments"
			continue
		}
		// Signing up an engine that is shutting down would enrol it in a round
		// robin it has already said it will not be there for. Its scheduled
		// matches, once an event has started, are the one thing a drain waits
		// out — so the answer is to not create any.
		if botIsDraining(client) {
			skipped[record.Name] = "shutting down"
			continue
		}
		if !handshake.Supports(tournament.ModeID) {
			skipped[record.Name] = "does not play " + string(tournament.ModeID)
			continue
		}
		// An engine can be barred from events just as a person can, and the
		// sweep is the one path that would otherwise seat it without anybody
		// choosing to. The owner's bar counts too: a tournament ban that an
		// author's engine walks through on the host's ticket is not a ban.
		if refusal := server.tournamentRefusal(record.UserID); refusal != "" {
			skipped[record.Name] = refusal
			continue
		}
		if refusal := server.tournamentRefusal(record.OwnerUserID); refusal != "" {
			skipped[record.Name] = "its owner " + refusal
			continue
		}
		// The handle passed here only has to satisfy the signup table's 2-to-64
		// rule: the door replaces it with the one Discord vouched for on the
		// owner's account, which is the handle a host chasing a missing engine
		// actually needs. See the substitution in SignupForTournament.
		if _, err := server.data.HostSignupForTournament(
			ctx, tournament.TournamentID, record.UserID, record.Name,
			"bot."+strings.ToLower(record.Name),
		); err != nil {
			switch {
			case errors.Is(err, persistence.ErrTournamentSignupExists):
				continue
			case errors.Is(err, persistence.ErrTournamentDiscordRequired):
				// Worth saying in the owner's terms. The engine has done nothing
				// wrong and there is nothing to fix on it — its author has not
				// linked Discord, and only they can.
				skipped[record.Name] = "its owner has not verified with Discord"
			default:
				skipped[record.Name] = err.Error()
			}
			continue
		}
		enrolled = append(enrolled, record.Name)
	}
	return enrolled, skipped
}

// botTournamentSwitchHint is the one sentence every refused engine entry gets.
//
// Named because more than one refusal says it and they have to say it
// identically: an owner who reads two different explanations of the same rule
// learns that the rule has exceptions. It names the switch rather than a page,
// because the switch is drawn on the bots page, the account page and the event
// page itself, and pointing at one of those would be wrong on the other two.
const botTournamentSwitchHint = "engines are not entered one event at a time: " +
	"turn on \"Tournaments\" for the engine and it enters every event it can play"

// autoReadyBotMatches starts any scheduled match whose players are all bots.
//
// A bot never sends `tournament_ready` — the client is a pipe with no
// tournament awareness — so something has to notice on its behalf. This runs
// on the existing lobby ticker rather than on a timer of its own; two seconds
// of latency before a bot match starts is not worth a second scheduler.
func (server *Server) autoReadyBotMatches() {
	// Cheap guard first. Without it this reads every tournament out of SQLite
	// twice a minute forever on a server that has never seen a bot, over the
	// single connection the game loop also uses.
	server.mu.RLock()
	connected := len(server.bots)
	server.mu.RUnlock()
	if connected == 0 {
		return
	}

	tournaments, err := server.data.Tournaments(context.Background())
	if err != nil {
		return
	}
	for _, tournament := range tournaments {
		if tournament.Status != persistence.TournamentInProgress {
			continue
		}
		if !server.registry.Playable(tournament.ModeID) {
			continue
		}
		for _, match := range tournament.Matches {
			if match.Result != persistence.MatchPending {
				continue
			}
			// Worked out for both seats before either is acted on. An engine
			// that is busy is freed by stopping whatever it is doing, and doing
			// that for one seat only to find the other unreachable would have
			// destroyed a game for a match that still cannot start. See
			// bot_recall.go.
			firstPlan := server.planBotRecall(match.Player1.UserID)
			secondPlan := server.planBotRecall(match.Player2.UserID)
			if firstPlan == nil || secondPlan == nil {
				continue
			}

			// Claim the slot under the same lock readyForTournamentMatch uses,
			// with the same nil-value marker. Without that, two ticks — or a
			// tick racing a human readying up — would each see an unclaimed
			// match and start two games for it.
			key := tournamentMatchKey{tournamentID: tournament.TournamentID, matchID: match.MatchID}
			server.mu.Lock()
			_, claimed := server.tournamentGames[key]
			if !claimed {
				server.tournamentGames[key] = nil
			}
			server.mu.Unlock()
			if claimed {
				continue
			}

			// Only now, with the match's slot held, is anything stopped: the
			// game about to be voided is being voided *for* a game that is
			// definitely starting.
			first := server.runBotRecall(firstPlan, tournament.Name)
			second := server.runBotRecall(secondPlan, tournament.Name)
			if first == nil || second == nil {
				// Something took a slot between the plan and here. Give the
				// claim back rather than hold a match nothing is playing; the
				// next tick plans it again.
				server.releaseMatchClaim(key)
				continue
			}

			server.startTournamentMatch(tournament, match, first, second)
		}
	}
}
