package server

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"rps-strategy/backend/internal/persistence"
)

// Bots in tournaments.
//
// There is no parallel scheduler here, deliberately. A tournament already
// knows how to build a signup-order round robin, seat two players in an
// ordinary game, record the result, and update the standings. All a bot needs
// is to be enrolled like anyone else and then to turn up when its match is
// due — so that is all this file does.

// enrollBots signs every eligible online bot into a tournament.
//
// Eligible means online, handshaken, not disabled, and configured to enter
// tournaments — that last one being the answer its owner gave the client's
// third setup question. An author who runs a bot for challenges only is never
// conscripted into an event.
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
		// The signup table demands a Discord handle of at least two characters
		// and an agreement to unfiltered chat. Neither means anything for a
		// program, so a synthetic handle stands in and the agreement is implied
		// by the owner having connected the bot at all.
		if _, err := server.data.SignupForTournament(
			request.Context(), tournamentID, record.UserID, record.Name,
			"bot."+strings.ToLower(record.Name), true,
		); err != nil {
			if errors.Is(err, persistence.ErrTournamentSignupExists) {
				continue
			}
			skipped[record.Name] = err.Error()
			continue
		}
		enrolled = append(enrolled, record.Name)
	}

	server.broadcastTournaments()
	writeJSON(writer, http.StatusOK, map[string]any{
		"enrolled": enrolled,
		"skipped":  skipped,
	})
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
			first := server.idleBotClientFor(match.Player1.UserID)
			second := server.idleBotClientFor(match.Player2.UserID)
			if first == nil || second == nil {
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

			server.startTournamentMatch(tournament, match, first, second)
		}
	}
}

// idleBotClientFor returns a ready, unoccupied bot connection for an account.
func (server *Server) idleBotClientFor(userID string) *Client {
	client := server.botClientFor(userID)
	if client == nil {
		return nil
	}
	client.bot.mu.Lock()
	ready := client.bot.ready
	client.bot.mu.Unlock()
	if !ready || server.participantFor(client) != nil {
		return nil
	}
	return client
}

// botIsReadyFor reports whether a scheduled opponent is a bot that will turn
// up by itself, so a human readying up does not wait for a click that will
// never come.
func (server *Server) botIsReadyFor(userID string) bool {
	return server.idleBotClientFor(userID) != nil
}
