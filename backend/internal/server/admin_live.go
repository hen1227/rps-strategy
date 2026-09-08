package server

import (
	"net/http"
	"sort"
	"strings"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// Reaching into what is happening right now.
//
// Everything else on the admin screen is about rows in the database: an
// account, a stored game, an event. This is about the live server — the boards
// being played on, the engines connected to it, the people in the lobby — and
// the two things a host occasionally has to do to it: stop a match, and hang up
// on a bot.
//
// Both are last resorts and both are logged, which is why neither is folded
// into the ordinary controls beside them.

// AdminLiveGame is a board in progress, as the host's screen lists it.
//
// A superset of LiveGameSummary rather than a reuse of it: that one is the
// public spectator rail and deliberately says nothing about who the players
// *are* beyond their display profile. Here the account ids matter, because the
// reason a host is looking at this list is usually one particular person.
type AdminLiveGame struct {
	GameID     string             `json:"gameId"`
	ModeID     game.ModeID        `json:"modeId"`
	ModeName   string             `json:"modeName"`
	RedPlayer  game.PlayerProfile `json:"redPlayer"`
	BluePlayer game.PlayerProfile `json:"bluePlayer"`
	// The accounts behind the two seats, which is what every action on this
	// screen is keyed on.
	RedUserID      string `json:"redUserId"`
	BlueUserID     string `json:"blueUserId"`
	RedIsBot       bool   `json:"redIsBot"`
	BlueIsBot      bool   `json:"blueIsBot"`
	Ranked         bool   `json:"ranked"`
	MoveNumber     int    `json:"moveNumber"`
	SpectatorCount int    `json:"spectatorCount"`
	// StartedAtUnixMs is zero for a game that has been opened but not begun —
	// see GameSession.start — which is also the one state in which the players
	// can still abort it themselves.
	StartedAtUnixMs int64 `json:"startedAtUnixMs"`
	// AwaitingFirstMove distinguishes those two, so the screen does not offer
	// to stop a game that is about to expire on its own.
	AwaitingFirstMove bool `json:"awaitingFirstMove"`
	// TournamentID and SeriesID say what this board belongs to, when it belongs
	// to something. A series game cannot be stopped from here — see stopGame.
	TournamentID string `json:"tournamentId,omitempty"`
	SeriesID     string `json:"seriesId,omitempty"`
}

// AdminBot is a connected engine, as the host's screen lists it.
//
// Again a superset of the public BotPresence, and again for one reason: this
// one says how many sockets the engine actually holds, which is the number a
// host needs when an engine is behaving strangely and the public roster only
// reports the slot count its owner declared.
type AdminBot struct {
	BotID       string        `json:"botId"`
	UserID      string        `json:"userId"`
	Name        string        `json:"name"`
	OwnerUserID string        `json:"ownerUserId,omitempty"`
	EngineName  string        `json:"engineName,omitempty"`
	Modes       []game.ModeID `json:"modes,omitempty"`
	// Connections is how many sockets this bot holds, and ActiveGames how many
	// of them are in a game. The gap between them is idle capacity.
	Connections int `json:"connections"`
	ActiveGames int `json:"activeGames"`
	// DeclaredSlots is what the client asked for, which can exceed Connections
	// when the engine has not opened them all yet.
	DeclaredSlots int    `json:"declaredSlots"`
	ClientVersion string `json:"clientVersion,omitempty"`
	// IconSHA256 is what makes the portrait beside the row resolvable: the icon
	// endpoint takes the digest as a cache key. Empty for a bot whose owner has
	// not given it one, which is most of them.
	IconSHA256      string `json:"iconSha256,omitempty"`
	Draining        bool   `json:"draining"`
	Benched         bool   `json:"benched"`
	ReservedFor     string `json:"reservedFor,omitempty"`
	AllowPublicPlay bool   `json:"allowPublicPlay"`
	EnterTournament bool   `json:"enterTournaments"`
	Elo             int    `json:"elo"`
	// Restricted lists any sanctions on the engine's own account, because a bot
	// can be barred from ranked play or from events just as a person can.
	Restricted []persistence.PublicRestriction `json:"restricted,omitempty"`
}

type stopGameRequest struct {
	// Outcome is what the game is stopped *as*: "void", "draw", "red", or
	// "blue". Void is the one that records nothing; the other three declare a
	// result and file the game like any other.
	Outcome string `json:"outcome"`
	// Reason is shown to both players and to anybody watching. Optional, and
	// worth filling in: a board that vanishes with no explanation is
	// indistinguishable from a crash.
	Reason string `json:"reason"`
}

type disconnectBotRequest struct {
	Reason string `json:"reason"`
}

// listAdminLiveGames is every board in progress.
func (server *Server) listAdminLiveGames(writer http.ResponseWriter, request *http.Request) {
	server.mu.RLock()
	games := make([]AdminLiveGame, 0, len(server.games))
	for _, session := range server.games {
		state := session.game.Snapshot()
		entry := AdminLiveGame{
			GameID:            session.gameID,
			ModeID:            state.Mode.ID,
			ModeName:          state.Mode.Name,
			RedPlayer:         state.RedPlayer,
			BluePlayer:        state.BluePlayer,
			Ranked:            session.ranked,
			MoveNumber:        state.MoveNumber,
			SpectatorCount:    len(session.spectators),
			AwaitingFirstMove: session.start != nil,
		}
		if !session.startedAt.IsZero() {
			entry.StartedAtUnixMs = session.startedAt.UnixMilli()
		}
		if session.redClient != nil {
			entry.RedUserID = session.redClient.profile.UserID
			entry.RedIsBot = session.redClient.isBot()
		}
		if session.blueClient != nil {
			entry.BlueUserID = session.blueClient.profile.UserID
			entry.BlueIsBot = session.blueClient.isBot()
		}
		if session.tournament != nil {
			entry.TournamentID = session.tournament.tournamentID
		}
		if session.botMatch != nil {
			entry.SeriesID = session.botMatch.seriesID
		}
		games = append(games, entry)
	}
	server.mu.RUnlock()

	// Newest first, which is the order a host wants: the thing they are
	// reacting to just started.
	sort.SliceStable(games, func(first, second int) bool {
		return games[first].StartedAtUnixMs > games[second].StartedAtUnixMs
	})
	writeJSON(writer, http.StatusOK, games)
}

// stopGame ends a live match from outside it.
//
// Four outcomes, and the difference between them is what goes on the record:
//
//   - **void** files nothing. The board disappears, no result is stored, and no
//     rating moves. For the game that should not have happened — a bug, an
//     abusive board, two engines stuck in a loop.
//   - **draw**, **red**, **blue** declare a result, and the game is filed and
//     rated exactly as if it had ended that way on the board. For the game
//     whose result is not in doubt but which is not going to finish itself:
//     a player who has walked away, a match a host has adjudicated.
//
// A game belonging to a bot series is refused. Voiding one game out of a
// six-game run would leave the runner waiting for a board that no longer
// exists, and the operation the host actually wants — call the whole run off —
// already exists as DELETE on the series.
func (server *Server) stopGame(writer http.ResponseWriter, request *http.Request) {
	gameID := strings.TrimSpace(request.PathValue("gameID"))
	var input stopGameRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	winner, void, ok := stopOutcome(input.Outcome)
	if !ok {
		writeAPIError(writer, http.StatusBadRequest, "outcome must be void, draw, red, or blue")
		return
	}

	server.mu.RLock()
	session := server.games[gameID]
	server.mu.RUnlock()
	if session == nil {
		writeAPIError(writer, http.StatusNotFound, "no such live game")
		return
	}
	if session.botMatch != nil {
		writeAPIError(
			writer,
			http.StatusConflict,
			"that game is part of a bot series; abort the series instead",
		)
		return
	}

	reason := strings.TrimSpace(input.Reason)
	notice := "A moderator stopped this game."
	if reason != "" {
		notice = "A moderator stopped this game: " + reason
	}

	// A game that has been opened but not begun is holding both players' seeks
	// in escrow, and the only path that gives those back is the one the abort
	// button and the no-show sweep already use. So it goes through that, and a
	// declared *result* is refused: there are no moves to adjudicate, and
	// filing a rated win for a game nobody played would be worse than saying no.
	server.mu.RLock()
	unstarted := session.start != nil
	server.mu.RUnlock()
	if unstarted {
		if !void {
			writeAPIError(
				writer,
				http.StatusConflict,
				"that game has not started, so it has no result to record; stop it as void instead",
			)
			return
		}
		server.cancelUnstartedGame(session, game.Neutral, cancelledByModerator)
		writeJSON(writer, http.StatusOK, map[string]any{
			"gameId": gameID, "outcome": "void", "recorded": false,
		})
		return
	}

	if void {
		server.voidGame(session, notice)
		writeJSON(writer, http.StatusOK, map[string]any{
			"gameId": gameID, "outcome": "void", "recorded": false,
		})
		return
	}

	state, err := session.game.Adjudicate(winner)
	if err != nil {
		// It finished by itself between the press and the request arriving.
		writeAPIError(writer, http.StatusConflict, "that game has already finished")
		return
	}
	server.tellGame(session, ServerMessage{Type: "moderator_notice", Message: notice})
	// The ordinary end of a game: filed, rated, archived, and — if it was a
	// tournament round — recorded against the schedule. Reusing that path is
	// the whole reason Adjudicate exists rather than a bespoke teardown.
	server.finishSession(session, state)
	writeJSON(writer, http.StatusOK, map[string]any{
		"gameId": gameID, "outcome": input.Outcome, "recorded": true,
	})
}

// voidGame removes a live game without filing a result.
//
// It reuses discardSession, which is documented as the path for a game that
// produced no result — which is exactly what a voided game is, deliberately.
// The one thing it has to do that discardSession does not is give back a
// tournament match's claim, so the round can be played again.
func (server *Server) voidGame(session *GameSession, notice string) {
	// Told before the board is taken away, so the message arrives while there
	// is still a game on screen to explain.
	server.tellGame(session, ServerMessage{
		Type:    "game_cancelled",
		GameID:  session.gameID,
		Message: notice,
	})
	// The engines' outstanding questions are void along with the game.
	server.retireBotExchanges(session)
	if session.tournament != nil {
		key := tournamentMatchKey{
			tournamentID: session.tournament.tournamentID,
			matchID:      session.tournament.matchID,
		}
		server.mu.Lock()
		if held, claimed := server.tournamentGames[key]; claimed && held == session {
			delete(server.tournamentGames, key)
		}
		delete(server.tournamentReady, key)
		server.mu.Unlock()
	}
	server.discardSession(session)
	server.broadcastLiveGames()
	if session.tournament != nil {
		server.broadcastTournaments()
	}
}

// tellGame sends one message to both players and everybody watching.
func (server *Server) tellGame(session *GameSession, message ServerMessage) {
	server.mu.RLock()
	audience := make([]*Client, 0, len(session.spectators)+2)
	if session.redClient != nil {
		audience = append(audience, session.redClient)
	}
	if session.blueClient != nil {
		audience = append(audience, session.blueClient)
	}
	for spectator := range session.spectators {
		audience = append(audience, spectator)
	}
	server.mu.RUnlock()
	for _, client := range audience {
		client.Send(message)
	}
}

// stopOutcome reads the outcome a host asked for.
//
// Returns the winning colour, whether the game is to be voided, and whether the
// word was one this understands at all. Three returns rather than an error
// because the caller's three branches are exactly these three answers.
func stopOutcome(outcome string) (game.PlayerColor, bool, bool) {
	switch strings.ToLower(strings.TrimSpace(outcome)) {
	case "void", "":
		// Empty defaults to void, which is the conservative reading: a request
		// that did not say what result to record should not invent one.
		return game.Neutral, true, true
	case "draw":
		return game.Neutral, false, true
	case "red":
		return game.Red, false, true
	case "blue":
		return game.Blue, false, true
	}
	return game.Neutral, false, false
}

/* --------------------------------------------------------- bot management -- */

// listAdminBots is every connected engine, with the socket detail the public
// roster does not carry.
func (server *Server) listAdminBots(writer http.ResponseWriter, request *http.Request) {
	benched := botsAreBenched(time.Now())

	server.mu.RLock()
	byBot := make(map[string][]*Client, len(server.bots))
	for botID, connections := range server.bots {
		byBot[botID] = append([]*Client(nil), connections...)
	}
	inGame := make(map[*Client]bool, len(server.participants))
	for client := range server.participants {
		inGame[client] = true
	}
	server.mu.RUnlock()

	bots := make([]AdminBot, 0, len(byBot))
	for botID, connections := range byBot {
		if len(connections) == 0 {
			continue
		}
		entry := AdminBot{BotID: botID, Connections: len(connections), Benched: benched}
		for _, client := range connections {
			client.bot.mu.Lock()
			record := client.bot.record
			handshake := client.bot.handshake
			clientVersion := client.bot.clientVersion
			declared := client.bot.maxGames
			client.bot.mu.Unlock()

			if declared > entry.DeclaredSlots {
				entry.DeclaredSlots = declared
			}
			if inGame[client] {
				entry.ActiveGames++
			}
			// The first connection speaks for the bot's registry row; they all
			// share one, so any of them would do and the first is stable.
			if entry.Name == "" {
				entry.Name = record.Name
				entry.UserID = record.UserID
				entry.OwnerUserID = record.OwnerUserID
				entry.EngineName = handshake.Name
				entry.Modes = handshake.Modes
				entry.ClientVersion = clientVersion
				entry.AllowPublicPlay = record.AllowPublicPlay
				entry.EnterTournament = record.EnterTournaments
				entry.Elo = client.account.Elo
				entry.IconSHA256 = record.IconSHA256
				entry.Draining = botHasOwnDrain(client)
				entry.ReservedFor = server.botReservation(record.UserID)
				entry.Restricted = server.activeRestrictions(record.UserID)
			}
		}
		bots = append(bots, entry)
	}
	sort.SliceStable(bots, func(first, second int) bool {
		return bots[first].Name < bots[second].Name
	})
	writeJSON(writer, http.StatusOK, bots)
}

// disconnectBotSockets hangs up on an engine.
//
// Distinct from the three softer things a host or owner can already do, and it
// is worth being explicit about which is which, because reaching for the wrong
// one is easy:
//
//   - `POST /api/bots/{id}/shutdown` is a *drain*: the engine finishes what it
//     is playing and then goes. Almost always the right answer.
//   - The bench is every engine standing down for a scheduled window.
//   - Retiring or deleting removes the registry row.
//   - This closes the sockets, now, mid-game if necessary.
//
// It is the answer for an engine that has stopped responding, is flooding the
// server, or is playing in a way that has to stop this second. Its owner's
// process is not killed and will very likely reconnect — which is a feature,
// since the usual next step is for the owner to fix something and restart it.
func (server *Server) disconnectBotSockets(writer http.ResponseWriter, request *http.Request) {
	botID := strings.TrimSpace(request.PathValue("botID"))
	var input disconnectBotRequest
	if err := decodeAPIRequest(writer, request, &input); err != nil {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	connections := server.botConnections(botID)
	if len(connections) == 0 {
		writeAPIError(writer, http.StatusNotFound, "that bot is not connected")
		return
	}
	reason := strings.TrimSpace(input.Reason)
	if reason == "" {
		reason = "a moderator disconnected this bot"
	}
	// Any run it was in stops first. Otherwise the runner sits waiting for a
	// move from a socket that has just been closed, and the series expires
	// slowly instead of ending cleanly.
	server.abortSeriesForBot(botID)
	server.disconnectBot(botID, reason)
	server.broadcastBots()
	writeJSON(writer, http.StatusOK, map[string]any{
		"botId": botID, "connectionsClosed": len(connections),
	})
}
