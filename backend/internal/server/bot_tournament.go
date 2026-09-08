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
// due — so that is all this file does: the two doors it can be entered
// through — its owner, or the host filling a field — and the sweep that
// notices when its match has come round.

// enrollBots enters every connected engine that is set to enter tournaments.
//
// The host's tool, and only the host's: it is behind adminOnly and there is no
// owner-facing equivalent. Registration is otherwise self-service — see
// registerBotForTournament, which is how an engine normally gets in — and this
// exists for the case that is not self-service at all: a bots-only event whose
// field the host is assembling from whatever is up, where chasing four authors
// for four clicks is the whole of the friction.
//
// # What it overrides, and what it does not
//
// It seats **every** eligible engine, including two from the same author. The
// one-place-per-party rule is about somebody choosing between themselves and
// their own bots; a host looking at the engines that are online and deciding the
// field should contain them is not making that choice, and an author who happens
// to run two of the four is not taking the event from anybody. See
// HostSignupForTournament, which is the only caller of the lifted door.
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
// Returns the engines now in the field and, for each one left out, why. The
// second half is the interesting one: an engine that was not enrolled is
// skipped for a reason, and each reason has a different fix.
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

// registerBotForTournament enters one of the caller's engines.
//
// The owner chooses, and that is the whole design. There used to be a host
// button that swept every online bot with its "enter tournaments" switch on
// into the field, which meant an author found out their engine was in an event
// by watching it lose one, and meant a field could hold four engines from the
// same person. Both are gone: nothing enrols a bot but its owner, and the
// one-entry rule in tournamentPartyID is what makes "exactly one of your bots"
// true rather than merely intended.
//
// Nothing here asks whether the engine is connected. Registration is the days
// before the event and the bot is expected to be up for the event itself; an
// engine that is offline when its match is called forfeits that match, which
// is the same answer a person gets. What is checked instead is everything the
// registry already knows and that no amount of turning up later can fix.
func (server *Server) registerBotForTournament(
	writer http.ResponseWriter,
	request *http.Request,
	botID string,
) {
	account, ok := server.requireSession(writer, request)
	if !ok {
		return
	}
	tournament, err := server.data.Tournament(request.Context(), request.PathValue("tournamentID"))
	if err != nil {
		writeTournamentError(writer, err)
		return
	}
	// The same answer getTournament gives, and for the same reason: a draft's
	// address must not confirm that anything is there.
	if tournament.Status == persistence.TournamentDraft {
		writeAPIError(writer, http.StatusNotFound, persistence.ErrTournamentNotFound.Error())
		return
	}
	bot, err := server.data.Bot(request.Context(), botID)
	if err != nil {
		writeBotError(writer, err)
		return
	}
	// Not a 404. Bot ids are public — they are in the directory and in every
	// icon URL — so there is nothing to protect by pretending somebody else's
	// engine does not exist, and a clear answer is worth more than a coy one.
	if bot.OwnerUserID != account.UserID {
		writeAPIError(writer, http.StatusForbidden, "that bot belongs to another account")
		return
	}
	if bot.Retired {
		writeAPIError(writer, http.StatusConflict, persistence.ErrBotRetired.Error())
		return
	}
	if bot.Disabled {
		writeAPIError(writer, http.StatusForbidden, persistence.ErrBotDisabled.Error())
		return
	}
	// An unclaimed slot has no account and no name: there is literally nothing
	// to write in the bracket. The owner has minted a token and not yet run the
	// client with it, so the fix is on their machine rather than on this page.
	if !bot.Claimed || bot.UserID == "" || bot.Name == "" {
		writeAPIError(
			writer, http.StatusConflict,
			"that bot has never connected, so it has no name to enter under",
		)
		return
	}
	// The owner's own switch, which is now the only thing it guards: with the
	// sweep gone nothing else reads it, so leaving it off is how an author says
	// "this one is not ready for events" and has that answer respected even by
	// their own mis-click.
	if !bot.EnterTournaments {
		writeAPIError(
			writer, http.StatusConflict,
			bot.Name+" is set not to enter tournaments; turn that on for it first",
		)
		return
	}
	// The modes its last handshake reported, rather than a live one, so a bot
	// can be entered while it is switched off. An engine that has never said
	// what it plays is let through: the alternative is refusing on no evidence.
	if len(bot.EngineModes) > 0 && !slices.Contains(bot.EngineModes, string(tournament.ModeID)) {
		writeAPIError(
			writer, http.StatusConflict,
			bot.Name+" does not play "+tournament.ModeName,
		)
		return
	}
	// Verification is asked of the owner, because an engine has no Discord
	// account to link. The door enforces it regardless — see the party check in
	// SignupForTournament — but refusing here is what lets the message name the
	// person who has to fix it and the page they fix it on.
	if !account.DiscordVerified {
		writeAPIError(
			writer, http.StatusForbidden,
			"verify your account with Discord before entering an engine",
		)
		return
	}
	// Both accounts, because either being barred is a reason. An owner under a
	// tournament ban who could still enter through an engine would not be under
	// one at all.
	if refusal := server.tournamentRefusal(account.UserID); refusal != "" {
		writeAPIError(writer, http.StatusForbidden, refusal)
		return
	}
	if refusal := server.tournamentRefusal(bot.UserID); refusal != "" {
		writeAPIError(writer, http.StatusForbidden, refusal)
		return
	}

	// The signup table wants a Discord handle and an agreement to unfiltered
	// chat, and neither means anything said about a program. The agreement is
	// the owner's, made by entering it. The handle is a placeholder that the
	// door replaces with the owner's verified one.
	entered, err := server.data.SignupForTournament(
		request.Context(), tournament.TournamentID, bot.UserID, bot.Name,
		"bot."+strings.ToLower(bot.Name), true,
	)
	if err != nil {
		writeTournamentError(writer, err)
		return
	}
	server.broadcastTournaments()
	writeJSON(writer, http.StatusCreated, entered)
}

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
