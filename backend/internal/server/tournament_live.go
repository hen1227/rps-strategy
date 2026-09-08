package server

import (
	"context"
	"log"
	"sort"
	"strings"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// tournamentMatchKey identifies one scheduled match of one tournament.
type tournamentMatchKey struct {
	tournamentID string
	matchID      int64
}

// tournamentMatchRef links a live game session back to the schedule slot it is
// playing out, so a finished game can record its own result. The match's first
// player takes the seat that opens in the first game -- the same courtesy
// matchmaking gives the older seek and a challenge gives its author -- and the
// two swap on every game after that.
type tournamentMatchRef struct {
	tournamentID string
	matchID      int64
	// player1Opened is which way round the colours were dealt for *this* game.
	//
	// A match of more than one game swaps them every game, so the board result
	// on its own does not say who won the pairing. Carried on the session
	// rather than recomputed at the end, because by then the only thing that
	// remembers the order is the game itself.
	player1Opened bool
}

// TournamentMatchState carries the parts of a scheduled match that live only in
// server memory: who has readied up, and the game currently playing it out.
type TournamentMatchState struct {
	MatchID      int64    `json:"matchId"`
	GameID       string   `json:"gameId,omitempty"`
	Live         bool     `json:"live"`
	ReadyUserIDs []string `json:"readyUserIds,omitempty"`
}

// TournamentSnapshot is the stored tournament plus its live match state. The
// embedded tournament keeps the JSON shape identical to the REST payload, so
// clients can hold one tournament model regardless of transport.
type TournamentSnapshot struct {
	persistence.Tournament
	MatchStates []TournamentMatchState `json:"matchStates"`
}

func (server *Server) tournamentSnapshots(ctx context.Context) []TournamentSnapshot {
	tournaments, err := server.data.Tournaments(ctx)
	if err != nil {
		log.Printf("read tournaments for broadcast: %v", err)
		return nil
	}

	server.mu.RLock()
	defer server.mu.RUnlock()
	// Drafts are filtered out here rather than at each call site, because this
	// feeds the broadcast that goes to every connected client. See
	// publicTournaments.
	tournaments = publicTournaments(tournaments)
	snapshots := make([]TournamentSnapshot, 0, len(tournaments))
	for _, tournament := range tournaments {
		states := make([]TournamentMatchState, 0)
		for _, match := range tournament.Matches {
			key := tournamentMatchKey{
				tournamentID: tournament.TournamentID,
				matchID:      match.MatchID,
			}
			session := server.tournamentGames[key]
			ready := server.tournamentReady[key]
			if session == nil && len(ready) == 0 {
				continue
			}
			state := TournamentMatchState{
				MatchID:      match.MatchID,
				ReadyUserIDs: sortedUserIDs(ready),
			}
			if session != nil {
				state.GameID = session.gameID
				state.Live = true
			}
			states = append(states, state)
		}
		snapshots = append(snapshots, TournamentSnapshot{
			Tournament:  tournament,
			MatchStates: states,
		})
	}
	return snapshots
}

// broadcastTournaments republishes the whole board. Tournament changes are rare
// compared to moves, so every client can hold one always-current copy.
func (server *Server) broadcastTournaments() {
	server.broadcastToClients(ServerMessage{
		Type:        "tournaments",
		Tournaments: server.tournamentSnapshots(context.Background()),
	})
}

// readyForTournamentMatch marks a player as present for one of their scheduled
// matches and starts the game as soon as both players are ready. A player can
// only hold one readiness at a time, so choosing a match releases the others.
func (server *Server) readyForTournamentMatch(
	client *Client,
	tournamentID string,
	matchID int64,
) {
	// A tournament is the one thing a drain neither cancels nor waits out: the
	// event is persisted, the pairings survive the restart, and both players
	// ready up again on the other side of it. So the answer here is "not yet",
	// not "not at all" — and it is checked first, before the player is taken out
	// of whatever else they were doing.
	if server.isUpdating() {
		client.Send(ServerMessage{
			Type:    "tournament_rejected",
			Message: server.updateRefusalMessage(),
		})
		return
	}
	tournament, match, err := server.scheduledMatch(tournamentID, matchID)
	if err != nil {
		client.Send(ServerMessage{Type: "tournament_rejected", Message: err.Error()})
		return
	}
	seat, opponent := matchSeats(*match, client.profile.UserID)
	if seat == nil {
		client.Send(ServerMessage{
			Type:    "tournament_rejected",
			Message: "you are not scheduled to play that match",
		})
		return
	}
	if !server.registry.Playable(tournament.ModeID) {
		client.Send(ServerMessage{
			Type:    "tournament_rejected",
			Message: "this tournament's game mode is no longer open for new matches",
		})
		return
	}

	if participant := server.participantFor(client); participant != nil {
		client.Send(ServerMessage{
			Type:    "tournament_rejected",
			Message: "finish your current game before starting a tournament match",
		})
		return
	}
	// Watching another board or waiting in matchmaking both have to end before
	// this player can be seated at their own match.
	server.releaseFromLobby(client)

	key := tournamentMatchKey{tournamentID: tournament.TournamentID, matchID: matchID}
	if session := server.tournamentGame(key); session != nil {
		// The match is already running: send this player back into their board.
		server.rejoinGame(client, session.gameID)
		return
	}

	// Resolved before the lock is taken: planBotRecall reads server state
	// through an RLock, and sync.RWMutex is not reentrant, so asking inside
	// the critical section below would deadlock this goroutine against itself.
	//
	// A plan rather than a plain "is it idle", because an engine that is busy is
	// not the same as an engine that will not come: its own match outranks
	// whatever else it is doing, and the plan is how that is worked out without
	// acting on it yet. Nothing is stopped until the match's slot is claimed
	// below. See bot_recall.go.
	opponentRecall := server.planBotRecall(opponent.UserID)

	server.mu.Lock()
	server.clearReadinessLocked(client.profile.UserID, &key)
	ready := server.tournamentReady[key]
	if ready == nil {
		ready = make(map[string]struct{})
		server.tournamentReady[key] = ready
	}
	ready[client.profile.UserID] = struct{}{}
	_, opponentReady := ready[opponent.UserID]
	// A bot never sends tournament_ready — its client is a pipe with no
	// tournament awareness — so an opponent that is a connected engine this can
	// get a slot out of counts as present. Without this a human-versus-bot match
	// waits forever for a click nobody is going to make.
	opponentReady = opponentReady || opponentRecall != nil
	// Claiming the match's game slot under the same lock that reads readiness
	// keeps two simultaneous ready-ups from starting two games for one match.
	_, claimed := server.tournamentGames[key]
	starting := opponentReady && !claimed
	if starting {
		server.tournamentGames[key] = nil
	}
	server.mu.Unlock()

	if starting {
		// The engine comes out of whatever it was in, now that there is a match
		// waiting on it that is definitely starting. A no-op for a human
		// opponent, and for an engine that was idle anyway.
		if opponentRecall != nil {
			server.runBotRecall(opponentRecall, tournament.Name)
		}
		if opponentClient := server.availableClientForUser(opponent.UserID); opponentClient != nil {
			server.startTournamentMatch(*tournament, *match, client, opponentClient)
			return
		}
		// The opponent readied up but is no longer able to play: keep both
		// players waiting rather than holding the slot.
		server.releaseMatchClaim(key)
	}
	server.broadcastTournaments()
}

// releaseMatchClaim gives up an unused game slot, leaving a started game alone.
func (server *Server) releaseMatchClaim(key tournamentMatchKey) {
	server.mu.Lock()
	if session, claimed := server.tournamentGames[key]; claimed && session == nil {
		delete(server.tournamentGames, key)
	}
	server.mu.Unlock()
}

// withdrawFromTournamentMatch takes a player back out of the ready state, which
// lets them watch other matches without being pulled into a game.
func (server *Server) withdrawFromTournamentMatch(
	client *Client,
	tournamentID string,
	matchID int64,
) {
	key := tournamentMatchKey{
		tournamentID: strings.TrimSpace(tournamentID),
		matchID:      matchID,
	}
	server.mu.Lock()
	changed := false
	if ready := server.tournamentReady[key]; ready != nil {
		if _, waiting := ready[client.profile.UserID]; waiting {
			delete(ready, client.profile.UserID)
			changed = true
			if len(ready) == 0 {
				delete(server.tournamentReady, key)
			}
		}
	}
	server.mu.Unlock()
	if changed {
		server.broadcastTournaments()
	}
}

// startTournamentMatch plays a scheduled match as an ordinary game session: the
// same board, clocks, chat, spectating, and reconnection as every other game.
func (server *Server) startTournamentMatch(
	tournament persistence.Tournament,
	match persistence.TournamentMatch,
	first *Client,
	second *Client,
) {
	player1Client, player2Client := first, second
	if match.Player1.UserID != first.profile.UserID {
		player1Client, player2Client = second, first
	}
	server.releaseFromLobby(player1Client)
	server.releaseFromLobby(player2Client)

	key := tournamentMatchKey{
		tournamentID: tournament.TournamentID,
		matchID:      match.MatchID,
	}
	entryTime := time.Now()
	// Rated, which is what a tournament game is expected to be everywhere else
	// this game is played. It used to be casual on the reasoning that an event
	// keeps its own standings and should not move the ladder on top of them —
	// but the standings answer "who won this event" and the ladder answers "how
	// strong is this player", and a competitive game is evidence for the second
	// whether or not it is scored in the first. It matters most for engines: the
	// bot ladder is fitted from ranked bot-versus-bot games, so a casual
	// tournament was invisible to the one ladder its games were best placed to
	// inform.
	//
	// Downgraded per pairing rather than refused, exactly as a challenge is —
	// see the same move in challenge.go. rankedAllowed is false for an
	// unregistered account and for one under a ranked-play sanction, and neither
	// is a reason to keep somebody out of a bracket they have already entered.
	// So a mixed field can produce some rated games and some casual ones, and
	// the PGN says which.
	rated := server.rankedAllowed(player1Client) && server.rankedAllowed(player2Client)
	setup := game.GameSetup{
		ModeID: tournament.ModeID,
		// The event's own clock, which the builder can set and which falls back
		// to the server default for every event that leaves it blank — which is
		// all of the ones that predate the builder. See tournamentTimeControl.
		TimeControl: tournamentTimeControl(tournament),
		Casual:      !rated,
	}
	entryFor := func(client *Client) QueueEntry {
		return QueueEntry{
			Client:   client,
			Setup:    setup,
			Elo:      matchmakingElo(client, tournament.ModeID),
			JoinedAt: entryTime,
		}
	}
	// Who opens alternates with the game index, so a match of an even number of
	// games gives each side the first move exactly half the time. One side
	// always moves first in this game and engines are strong enough for that to
	// decide close pairings — cancelling it is the reason a match is more than
	// one game at all. Game 0 gives it to the first player, which is what a
	// single-game match has always done.
	opener, follower := player1Client, player2Client
	if match.GamesPlayed%2 == 1 {
		opener, follower = player2Client, player1Client
	}
	// startConfiguredMatch seats its first entry Red, so the order depends on
	// which colour opens.
	redClient, blueClient := follower, opener
	if game.FirstToMove == game.Red {
		redClient, blueClient = opener, follower
	}
	session := server.startConfiguredMatch(
		entryFor(redClient),
		entryFor(blueClient),
		matchSetup{
			tournament: &tournamentMatchRef{
				tournamentID:  tournament.TournamentID,
				matchID:       match.MatchID,
				player1Opened: opener == player1Client,
			},
			// Nil for every event with people in it, which gives this game a
			// room of its own as before. A bots-only event is one conversation
			// across all of its boards — see tournament_chat.go.
			chat: server.tournamentChatRoom(tournament),
		},
	)
	if session == nil {
		server.releaseMatchClaim(key)
		return
	}

	server.mu.Lock()
	server.tournamentGames[key] = session
	delete(server.tournamentReady, key)
	server.mu.Unlock()

	if _, err := server.data.SetTournamentMatchGame(
		context.Background(),
		tournament.TournamentID,
		match.MatchID,
		session.gameID,
	); err != nil {
		log.Printf("link tournament match %d to game %s: %v", match.MatchID, session.gameID, err)
	}
	server.broadcastTournaments()
}

// recordTournamentMatchResult turns a finished tournament game into the match
// result, so standings follow play without a host typing anything in.
func (server *Server) recordTournamentMatchResult(
	session *GameSession,
	state game.GameState,
) {
	reference := session.tournament
	if reference == nil {
		return
	}
	key := tournamentMatchKey{
		tournamentID: reference.tournamentID,
		matchID:      reference.matchID,
	}
	server.mu.Lock()
	if server.tournamentGames[key] == session {
		delete(server.tournamentGames, key)
	}
	delete(server.tournamentReady, key)
	server.mu.Unlock()

	// The first player's score for this game, doubled. Read through
	// `openedForPlayer1` rather than off the colour directly: the colours swap
	// every game of a multi-game match, so "the side that opened won" is only
	// the first player's win on the games they opened.
	points := 1
	if state.Winner != game.Neutral {
		openerWon := state.Winner == game.FirstToMove
		if openerWon == reference.player1Opened {
			points = 2
		} else {
			points = 0
		}
	}
	tournament, complete, err := server.data.RecordTournamentMatchGame(
		context.Background(),
		reference.tournamentID,
		reference.matchID,
		session.gameID,
		points,
	)
	if err != nil {
		log.Printf("record tournament match %d game: %v", reference.matchID, err)
		server.broadcastTournaments()
		return
	}
	if !complete {
		// More games in this pairing. Nothing about the schedule changes, so the
		// board just needs to be set up again.
		server.continueTournamentMatch(tournament, reference.matchID)
		server.broadcastTournaments()
		return
	}
	server.awardTournamentTitles(context.Background(), tournament)
	// A result can be the one that finishes the event, which is when its
	// engines stop being held. See bot_reserve.go.
	server.refreshBotReservations()
	server.broadcastTournaments()
}

// continueTournamentMatch starts the next game of a match that is not finished.
//
// Best effort, and deliberately so. If either side is not free this moment —
// an engine still settling, a person who has closed the tab — the match simply
// stays pending, which is a state the rest of the system already knows how to
// pick up: the lobby ticker seats bot pairings as soon as both are idle, and a
// person readies up again. Nothing is lost by not starting here.
func (server *Server) continueTournamentMatch(
	tournament persistence.Tournament,
	matchID int64,
) {
	var match *persistence.TournamentMatch
	for index := range tournament.Matches {
		if tournament.Matches[index].MatchID == matchID {
			match = &tournament.Matches[index]
			break
		}
	}
	if match == nil || match.Result != persistence.MatchPending {
		return
	}
	if !server.registry.Playable(tournament.ModeID) {
		return
	}
	first := server.availableClientForUser(match.Player1.UserID)
	second := server.availableClientForUser(match.Player2.UserID)
	if first == nil || second == nil {
		return
	}

	// The same claim the ready path and the bot sweep take, for the same
	// reason: two things starting a game for one match is the failure this
	// prevents.
	key := tournamentMatchKey{tournamentID: tournament.TournamentID, matchID: matchID}
	server.mu.Lock()
	_, claimed := server.tournamentGames[key]
	if !claimed {
		server.tournamentGames[key] = nil
	}
	server.mu.Unlock()
	if claimed {
		return
	}
	server.startTournamentMatch(tournament, *match, first, second)
}

// scheduledMatch validates that a tournament match is still open for play.
func (server *Server) scheduledMatch(
	tournamentID string,
	matchID int64,
) (*persistence.Tournament, *persistence.TournamentMatch, error) {
	tournamentID = strings.TrimSpace(tournamentID)
	if tournamentID == "" || matchID <= 0 {
		return nil, nil, persistence.ErrTournamentMatchNotFound
	}
	tournament, err := server.data.Tournament(context.Background(), tournamentID)
	if err != nil {
		return nil, nil, err
	}
	if tournament.Status != persistence.TournamentInProgress {
		return nil, nil, persistence.ErrTournamentMatchNotFound
	}
	for index := range tournament.Matches {
		match := &tournament.Matches[index]
		if match.MatchID != matchID {
			continue
		}
		if match.Result != persistence.MatchPending {
			return nil, nil, persistence.ErrTournamentMatchNotFound
		}
		return &tournament, match, nil
	}
	return nil, nil, persistence.ErrTournamentMatchNotFound
}

// matchSeats returns the requesting player's own seat and their opponent's.
func matchSeats(
	match persistence.TournamentMatch,
	userID string,
) (*persistence.TournamentPlayer, *persistence.TournamentPlayer) {
	switch userID {
	case match.Player1.UserID:
		return &match.Player1, &match.Player2
	case match.Player2.UserID:
		return &match.Player2, &match.Player1
	}
	return nil, nil
}

func (server *Server) tournamentGame(key tournamentMatchKey) *GameSession {
	server.mu.RLock()
	defer server.mu.RUnlock()
	return server.tournamentGames[key]
}

// clearReadinessLocked drops a player's readiness everywhere except keep, so a
// player is only ever waiting on one match. Callers must hold server.mu.
func (server *Server) clearReadinessLocked(userID string, keep *tournamentMatchKey) bool {
	changed := false
	for key, ready := range server.tournamentReady {
		if keep != nil && key == *keep {
			continue
		}
		if _, waiting := ready[userID]; !waiting {
			continue
		}
		delete(ready, userID)
		changed = true
		if len(ready) == 0 {
			delete(server.tournamentReady, key)
		}
	}
	return changed
}

func (server *Server) clearTournamentReadiness(client *Client) bool {
	server.mu.Lock()
	defer server.mu.Unlock()
	return server.clearReadinessLocked(client.profile.UserID, nil)
}

// releaseFromLobby frees a client from everything that conflicts with being
// dropped into a game: spectating another board and waiting in matchmaking.
func (server *Server) releaseFromLobby(client *Client) {
	server.stopSpectating(client, true)
	seek := server.seeks.RemoveClient(client)
	if seek == nil {
		return
	}
	// Withdrawn the same way the lobby withdraws one, so a posted game
	// disappears from its author's screen as a cancelled challenge rather than
	// as a search they never started.
	server.announceWithdrawnSeek(seek, "Your challenge was withdrawn to start this match.")
}

// availableClientForUser finds a connection for an account that could start a
// game right now, so a second tab left open in a finished game is skipped.
func (server *Server) availableClientForUser(userID string) *Client {
	for _, candidate := range server.connectedClients() {
		if candidate.profile.UserID != userID {
			continue
		}
		if server.participantFor(candidate) != nil {
			continue
		}
		return candidate
	}
	return nil
}

func sortedUserIDs(ready map[string]struct{}) []string {
	userIDs := make([]string, 0, len(ready))
	for userID := range ready {
		userIDs = append(userIDs, userID)
	}
	sort.Strings(userIDs)
	return userIDs
}

// releaseTournamentReadiness drops every readiness held against one
// tournament, and tells whoever was holding one.
//
// Called when an event is cancelled. Without it, a player who pressed ready on
// a match of a cancelled tournament sits watching a spinner for a game that
// will never be paired, with nothing on screen to say why.
func (server *Server) releaseTournamentReadiness(tournamentID string) {
	tournamentID = strings.TrimSpace(tournamentID)
	stranded := make(map[string]struct{})
	server.mu.Lock()
	for key, ready := range server.tournamentReady {
		if key.tournamentID != tournamentID {
			continue
		}
		for userID := range ready {
			stranded[userID] = struct{}{}
		}
		delete(server.tournamentReady, key)
	}
	// Only the unstarted claims. A game that is actually being played is left
	// alone: cancelling the event does not reach into a live board and take it
	// away from the two people on it, and its result simply stops mattering.
	for key, session := range server.tournamentGames {
		if key.tournamentID == tournamentID && session == nil {
			delete(server.tournamentGames, key)
		}
	}
	server.mu.Unlock()

	if len(stranded) == 0 {
		return
	}
	for _, client := range server.connectedClients() {
		if _, waiting := stranded[client.profile.UserID]; !waiting {
			continue
		}
		client.Send(ServerMessage{
			Type:    "tournament_rejected",
			Message: "that tournament has been cancelled",
		})
	}
}
