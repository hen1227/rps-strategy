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
// playing out, so a finished game can record its own result. Red always plays
// the match's first player, which keeps the schedule and the board consistent.
type tournamentMatchRef struct {
	tournamentID string
	matchID      int64
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

	// Resolved before the lock is taken: botIsReadyFor reads server state
	// through an RLock, and sync.RWMutex is not reentrant, so asking inside
	// the critical section below would deadlock this goroutine against itself.
	opponentIsWaitingBot := server.botIsReadyFor(opponent.UserID)

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
	// tournament awareness — so an opponent that is an idle, connected engine
	// counts as present. Without this a human-versus-bot match waits forever
	// for a click nobody is going to make.
	opponentReady = opponentReady || opponentIsWaitingBot
	// Claiming the match's game slot under the same lock that reads readiness
	// keeps two simultaneous ready-ups from starting two games for one match.
	_, claimed := server.tournamentGames[key]
	starting := opponentReady && !claimed
	if starting {
		server.tournamentGames[key] = nil
	}
	server.mu.Unlock()

	if starting {
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
	// Casual: a tournament keeps its own standings, and has never moved the
	// ladder ratings on top of them.
	setup := game.GameSetup{
		ModeID:      tournament.ModeID,
		TimeControl: game.DefaultTimeControl(),
		Casual:      true,
	}
	session := server.startConfiguredMatch(
		QueueEntry{
			Client:   player1Client,
			Setup:    setup,
			Elo:      matchmakingElo(player1Client, tournament.ModeID),
			JoinedAt: entryTime,
		},
		QueueEntry{
			Client:   player2Client,
			Setup:    setup,
			Elo:      matchmakingElo(player2Client, tournament.ModeID),
			JoinedAt: entryTime,
		},
		matchSetup{
			tournament: &tournamentMatchRef{
				tournamentID: tournament.TournamentID,
				matchID:      match.MatchID,
			},
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

	result := persistence.MatchDraw
	switch state.Winner {
	case game.Red:
		result = persistence.MatchPlayer1Win
	case game.Blue:
		result = persistence.MatchPlayer2Win
	}
	tournament, err := server.data.SetTournamentMatchResult(
		context.Background(),
		reference.tournamentID,
		reference.matchID,
		result,
	)
	if err != nil {
		log.Printf("record tournament match %d result: %v", reference.matchID, err)
	} else {
		server.awardTournamentTitles(context.Background(), tournament)
	}
	server.broadcastTournaments()
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
