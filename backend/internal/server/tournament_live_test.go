package server

import (
	"encoding/json"
	"net/http"
	"testing"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

func tournamentTestClient(userID string, username string) *Client {
	return &Client{
		send:    make(chan []byte, 64),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: userID, Username: username},
	}
}

// startedTournament signs two accounts up for a round robin and starts it.
func startedTournament(t *testing.T, data *persistence.Store) persistence.Tournament {
	t.Helper()
	ctx := t.Context()
	for _, account := range []struct{ userID, username string }{
		{"user-one", "One"},
		{"user-two", "Two"},
	} {
		if _, err := data.EnsureAccount(ctx, account.userID, account.username); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := data.CreateTournament(
		ctx, "cup", "Test Cup", game.ModeTotalWar, "Total War",
	); err != nil {
		t.Fatal(err)
	}
	for _, signup := range []struct{ userID, ign, discord string }{
		{"user-one", "One", "one.discord"},
		{"user-two", "Two", "two.discord"},
	} {
		if _, err := data.SignupForTournament(
			ctx, "cup", signup.userID, signup.ign, signup.discord, true,
		); err != nil {
			t.Fatal(err)
		}
	}
	tournament, err := data.StartTournament(ctx, "cup")
	if err != nil {
		t.Fatal(err)
	}
	if len(tournament.Matches) != 1 {
		t.Fatalf("expected a single scheduled match, got %d", len(tournament.Matches))
	}
	return tournament
}

func TestTournamentMatchStartsWhenBothPlayersAreReady(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	server := NewWithStore(data, nil)
	tournament := startedTournament(t, data)
	match := tournament.Matches[0]

	first := tournamentTestClient("user-one", "One")
	second := tournamentTestClient("user-two", "Two")
	server.hub.Register(first)
	server.hub.Register(second)

	ready := ClientMessage{
		Type:         "tournament_ready",
		TournamentID: tournament.TournamentID,
		MatchID:      match.MatchID,
	}
	server.handleMessage(first, ready)
	if server.participantFor(first) != nil {
		t.Fatal("one ready player must not start the match alone")
	}
	snapshots := server.tournamentSnapshots(t.Context())
	if len(snapshots) != 1 || len(snapshots[0].MatchStates) != 1 ||
		len(snapshots[0].MatchStates[0].ReadyUserIDs) != 1 {
		t.Fatalf("expected one ready player in the snapshot, got %#v", snapshots)
	}

	server.handleMessage(second, ready)
	participant := server.participantFor(first)
	opponent := server.participantFor(second)
	if participant == nil || opponent == nil {
		t.Fatal("both ready players must be put into the match")
	}
	if participant.color != game.Red || opponent.color != game.Blue {
		t.Fatalf("the match's first player must play Red, got %s and %s",
			participant.color, opponent.color)
	}
	if participant.session.tournament == nil ||
		participant.session.tournament.matchID != match.MatchID {
		t.Fatalf("the session must reference its schedule slot: %#v", participant.session)
	}

	stored, err := data.Tournament(t.Context(), tournament.TournamentID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Matches[0].GameID != participant.session.gameID {
		t.Fatalf("expected the live game to be recorded, got %q", stored.Matches[0].GameID)
	}

	// Finishing the game is what records the result: no host input required.
	server.handleMessage(second, ClientMessage{Type: "resign_game"})
	stored, err = data.Tournament(t.Context(), tournament.TournamentID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Matches[0].Result != persistence.MatchPlayer1Win {
		t.Fatalf("expected a first-player win, got %q", stored.Matches[0].Result)
	}
	if stored.Status != persistence.TournamentCompleted {
		t.Fatalf("expected the tournament to complete, got %q", stored.Status)
	}
	if server.tournamentGame(tournamentMatchKey{tournament.TournamentID, match.MatchID}) != nil {
		t.Fatal("a finished match must not stay live")
	}
}

func TestTournamentReadyRejectsPlayersOutsideTheMatch(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	server := NewWithStore(data, nil)
	tournament := startedTournament(t, data)

	stranger := tournamentTestClient("user-three", "Three")
	server.hub.Register(stranger)
	server.handleMessage(stranger, ClientMessage{
		Type:         "tournament_ready",
		TournamentID: tournament.TournamentID,
		MatchID:      tournament.Matches[0].MatchID,
	})

	var response ServerMessage
	if err := json.Unmarshal(<-stranger.send, &response); err != nil {
		t.Fatal(err)
	}
	if response.Type != "tournament_rejected" {
		t.Fatalf("expected the match to be refused, got %#v", response)
	}
	if len(server.tournamentSnapshots(t.Context())[0].MatchStates) != 0 {
		t.Fatal("a refused player must not appear ready")
	}
}

func TestTournamentReadinessIsReleasedOnDisconnect(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	server := NewWithStore(data, nil)
	tournament := startedTournament(t, data)

	player := tournamentTestClient("user-one", "One")
	server.hub.Register(player)
	server.handleMessage(player, ClientMessage{
		Type:         "tournament_ready",
		TournamentID: tournament.TournamentID,
		MatchID:      tournament.Matches[0].MatchID,
	})
	if len(server.tournamentSnapshots(t.Context())[0].MatchStates) != 1 {
		t.Fatal("expected the player to be ready")
	}

	server.disconnect(player)
	if len(server.tournamentSnapshots(t.Context())[0].MatchStates) != 0 {
		t.Fatal("a disconnected player must not stay ready")
	}
}

func TestRetiredModeAcceptsNoNewMatches(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	server := NewWithStoreAndAdminToken(data, nil, "tournament-admin-secret")

	if game.DefaultModeRegistry.Playable(game.ModeAnnihilation) {
		t.Fatal("Annihilation is expected to be retired from new matches")
	}

	queued := tournamentTestClient("queue-player", "Queued")
	server.handleMessage(queued, ClientMessage{
		Type:   "join_queue",
		ModeID: game.ModeAnnihilation,
	})
	if _, searching := server.matchmaking.Status(queued); searching {
		t.Fatal("a retired mode must not accept matchmaking")
	}
	var queueResponse ServerMessage
	if err := json.Unmarshal(<-queued.send, &queueResponse); err != nil {
		t.Fatal(err)
	}
	if queueResponse.Type != "error" {
		t.Fatalf("expected a rejected queue, got %#v", queueResponse)
	}

	challenger := tournamentTestClient("challenger", "Challenger")
	server.handleMessage(challenger, ClientMessage{
		Type:     "send_challenge",
		Username: "Someone",
		ModeID:   game.ModeAnnihilation,
	})
	var challengeResponse ServerMessage
	if err := json.Unmarshal(<-challenger.send, &challengeResponse); err != nil {
		t.Fatal(err)
	}
	if challengeResponse.Type != "challenge_rejected" {
		t.Fatalf("expected a rejected challenge, got %#v", challengeResponse)
	}

	created := tournamentRequest(
		t,
		server.Routes(),
		http.MethodPost,
		"/api/admin/tournaments",
		map[string]any{"name": "Retired Cup", "modeId": game.ModeAnnihilation},
		"tournament-admin-secret",
	)
	if created.Code != http.StatusBadRequest {
		t.Fatalf("expected a retired mode to be refused, got %d: %s", created.Code, created.Body)
	}
}

func TestTournamentMatchStartsOnlyOneGame(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	server := NewWithStore(data, nil)
	tournament := startedTournament(t, data)
	match := tournament.Matches[0]

	first := tournamentTestClient("user-one", "One")
	second := tournamentTestClient("user-two", "Two")
	server.hub.Register(first)
	server.hub.Register(second)

	ready := ClientMessage{
		Type:         "tournament_ready",
		TournamentID: tournament.TournamentID,
		MatchID:      match.MatchID,
	}
	server.handleMessage(first, ready)
	server.handleMessage(second, ready)
	// Readying up again while the match runs returns the player to their board
	// instead of starting a second game for the same slot.
	server.handleMessage(first, ready)
	server.handleMessage(second, ready)

	server.mu.RLock()
	games := len(server.games)
	server.mu.RUnlock()
	if games != 1 {
		t.Fatalf("expected exactly one game for the match, got %d", games)
	}
	if participant := server.participantFor(first); participant == nil ||
		participant.session.gameID == "" {
		t.Fatal("the player must still be seated in the match")
	}
}
