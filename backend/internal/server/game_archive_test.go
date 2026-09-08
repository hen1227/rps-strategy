package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/notation"
	"rps-strategy/backend/internal/persistence"
)

func archiveTestServer(t *testing.T) (*Server, *persistence.Store) {
	t.Helper()
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = data.Close() })
	return NewWithStore(data, nil), data
}

func archiveTestClients(t *testing.T, data *persistence.Store, userIDs ...string) []*Client {
	t.Helper()
	clients := make([]*Client, 0, len(userIDs))
	for _, userID := range userIDs {
		account, err := data.EnsureAccount(t.Context(), userID, userID)
		if err != nil {
			t.Fatal(err)
		}
		clients = append(clients, &Client{
			send:    make(chan []byte, 16),
			done:    make(chan struct{}),
			profile: game.PlayerProfile{UserID: userID, Username: userID},
			account: account,
		})
	}
	return clients
}

func startArchiveTestMatch(server *Server, red, blue *Client, modeID game.ModeID) {
	entryTime := time.Now()
	setup := game.GameSetup{ModeID: modeID}
	server.startConfiguredMatch(
		QueueEntry{
			Client: red, Setup: setup,
			Elo: matchmakingElo(red, modeID), JoinedAt: entryTime,
		},
		QueueEntry{
			Client: blue, Setup: setup,
			Elo: matchmakingElo(blue, modeID), JoinedAt: entryTime,
		},
		matchSetup{},
	)
}

// playOpeningMove plays whatever the side to move can play, from whichever of
// the two clients holds that seat, and reports the move it played. The tests
// below care that a move happened and was archived, not which move it was.
func playOpeningMove(t *testing.T, server *Server, red, blue *Client) (from, to game.Position) {
	t.Helper()
	participant := server.participantFor(red)
	if participant == nil {
		t.Fatal("expected the red client to be in a game")
	}
	state := participant.session.game.Snapshot()
	mover := red
	if state.CurrentTurn == game.Blue {
		mover = blue
	}
	for y := 0; y < state.Grid.Height(); y++ {
		for x := 0; x < state.Grid.Width(); x++ {
			if state.Grid[y][x].OccupantOwner != state.CurrentTurn {
				continue
			}
			from := game.Position{X: x, Y: y}
			moves := participant.session.game.ValidMoves(state.CurrentTurn, from)
			if len(moves) == 0 {
				continue
			}
			if !server.makeMove(mover, from, moves[0]) {
				t.Fatalf("the opening move %v-%v was refused", from, moves[0])
			}
			return from, moves[0]
		}
	}
	t.Fatal("the opening position has no legal move")
	return game.Position{}, game.Position{}
}

func TestFinishedGameIsArchivedAsReplayablePGN(t *testing.T) {
	server, data := archiveTestServer(t)
	clients := archiveTestClients(t, data, "archive-red", "archive-blue")
	redClient, blueClient := clients[0], clients[1]
	startArchiveTestMatch(server, redClient, blueClient, game.ModeTotalWar)
	_ = readClientMessage(t, redClient)
	_ = readClientMessage(t, blueClient)

	participant := server.participantFor(redClient)
	if participant == nil {
		t.Fatal("expected the red client to be in a game")
	}
	gameID := participant.session.gameID
	from, to := playOpeningMove(t, server, redClient, blueClient)
	server.resign(blueClient)

	archived, err := data.ArchivedGame(t.Context(), gameID)
	if err != nil {
		t.Fatalf("the finished game was not archived: %v", err)
	}
	if archived.ModeID != game.ModeTotalWar || !archived.Ranked || archived.PlyCount != 1 {
		t.Fatalf("unexpected archive row: %#v", archived)
	}
	if archived.WinnerColor != game.Red || archived.EndReason != game.EndReasonResignation {
		t.Fatalf("unexpected result stored: %#v", archived)
	}

	parsed, err := notation.Parse(archived.PGN)
	if err != nil {
		t.Fatalf("stored PGN does not parse: %v\n%s", err, archived.PGN)
	}
	if err := game.Verify(parsed.Record); err != nil {
		t.Fatalf("stored PGN does not replay into its own result: %v", err)
	}
	// The rating the game produced is part of the record, so a stored game
	// explains the Elo it moved without a database join.
	if parsed.Metadata.RedEloBefore != persistence.DefaultElo ||
		parsed.Metadata.RedEloAfter != 1216 {
		t.Fatalf("ratings did not reach the archive: %#v", parsed.Metadata)
	}
	if parsed.Record.Moves()[0].From != from || parsed.Record.Moves()[0].To != to {
		t.Fatalf("the played move is not in the record: %#v", parsed.Record.Moves())
	}
}

func TestArchiveRoutesServeStoredGames(t *testing.T) {
	server, data := archiveTestServer(t)
	clients := archiveTestClients(t, data, "route-red", "route-blue")
	redClient, blueClient := clients[0], clients[1]
	startArchiveTestMatch(server, redClient, blueClient, game.ModeInfiltration)
	_ = readClientMessage(t, redClient)
	_ = readClientMessage(t, blueClient)
	gameID := server.participantFor(redClient).session.gameID
	server.resign(blueClient)

	routes := server.Routes()

	recorder := httptest.NewRecorder()
	routes.ServeHTTP(recorder, httptest.NewRequest(
		http.MethodGet, "/api/games/"+gameID+"/pgn", nil,
	))
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body)
	}
	if !strings.Contains(recorder.Body.String(), `[GameId "`+gameID+`"]`) {
		t.Fatalf("unexpected PGN body:\n%s", recorder.Body)
	}

	recorder = httptest.NewRecorder()
	routes.ServeHTTP(recorder, httptest.NewRequest(
		http.MethodGet, "/api/accounts/route-blue/games/pgn", nil,
	))
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body)
	}
	games, err := notation.ParseMulti(recorder.Body.String())
	if err != nil {
		t.Fatal(err)
	}
	if len(games) != 1 || games[0].Record.GameID != gameID {
		t.Fatalf("account export returned %d games", len(games))
	}

	recorder = httptest.NewRecorder()
	routes.ServeHTTP(recorder, httptest.NewRequest(
		http.MethodGet, "/api/games/"+gameID+"/pgn?format=json", nil,
	))
	var archived persistence.ArchivedGame
	if err := json.NewDecoder(recorder.Body).Decode(&archived); err != nil {
		t.Fatal(err)
	}
	if archived.GameID != gameID || archived.PGN == "" {
		t.Fatalf("unexpected JSON body: %#v", archived)
	}

	recorder = httptest.NewRecorder()
	routes.ServeHTTP(recorder, httptest.NewRequest(
		http.MethodGet, "/api/games/does-not-exist/pgn", nil,
	))
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("expected 404 for an unknown game, got %d", recorder.Code)
	}
}

func TestBulkExportRequiresTheHostToken(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer data.Close()
	const adminToken = "0123456789abcdef0123456789abcdef"
	server := NewWithStoreAndAdminToken(data, nil, adminToken)

	clients := archiveTestClients(t, data, "export-red", "export-blue")
	startArchiveTestMatch(server, clients[0], clients[1], game.ModeTotalWar)
	_ = readClientMessage(t, clients[0])
	_ = readClientMessage(t, clients[1])
	server.resign(clients[1])

	routes := server.Routes()
	recorder := httptest.NewRecorder()
	routes.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, "/api/admin/games/pgn", nil))
	if recorder.Code != http.StatusUnauthorized && recorder.Code != http.StatusForbidden {
		t.Fatalf("bulk export must be host-only, got %d", recorder.Code)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/admin/games/pgn?format=jsonl", nil)
	request.Header.Set("Authorization", "Bearer "+adminToken)
	recorder = httptest.NewRecorder()
	routes.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", recorder.Code, recorder.Body)
	}
	if total := recorder.Header().Get("X-Archive-Total"); total != "1" {
		t.Fatalf("expected one archived game, header says %q", total)
	}
	lines := strings.Split(strings.TrimSpace(recorder.Body.String()), "\n")
	if len(lines) != 1 {
		t.Fatalf("expected one JSON line, got %d", len(lines))
	}
	var record persistence.ArchivedGame
	if err := json.Unmarshal([]byte(lines[0]), &record); err != nil {
		t.Fatal(err)
	}
	parsed, err := notation.Parse(record.PGN)
	if err != nil {
		t.Fatal(err)
	}
	if err := game.Verify(parsed.Record); err != nil {
		t.Fatalf("exported game does not replay: %v", err)
	}
}

// An abandoned game still happened, so it still has to be archived.
func TestAbandonedGameIsArchived(t *testing.T) {
	server, data := archiveTestServer(t)
	clients := archiveTestClients(t, data, "gone-red", "gone-blue")
	redClient, blueClient := clients[0], clients[1]
	startArchiveTestMatch(server, redClient, blueClient, game.ModeTotalWar)
	_ = readClientMessage(t, redClient)
	_ = readClientMessage(t, blueClient)
	gameID := server.participantFor(redClient).session.gameID

	server.disconnect(blueClient)
	server.expireGames(time.Now().Add(reconnectGracePeriod + time.Second))

	archived, err := data.ArchivedGame(t.Context(), gameID)
	if err != nil {
		t.Fatalf("abandoned game was not archived: %v", err)
	}
	if archived.EndReason != game.EndReasonAbandonment || archived.WinnerColor != game.Red {
		t.Fatalf("unexpected archived result: %#v", archived)
	}
	parsed, err := notation.Parse(archived.PGN)
	if err != nil {
		t.Fatal(err)
	}
	if err := game.Verify(parsed.Record); err != nil {
		t.Fatalf("archived abandonment does not replay: %v", err)
	}
}

// A game interrupted by a restart is archived as far as it was played, so the
// moves survive even though nobody won.
func TestLiveGamesAreArchivedUnfinishedOnShutdown(t *testing.T) {
	server, data := archiveTestServer(t)
	clients := archiveTestClients(t, data, "live-red", "live-blue")
	redClient, blueClient := clients[0], clients[1]
	startArchiveTestMatch(server, redClient, blueClient, game.ModeTotalWar)
	_ = readClientMessage(t, redClient)
	_ = readClientMessage(t, blueClient)

	gameID := server.participantFor(redClient).session.gameID
	playOpeningMove(t, server, redClient, blueClient)

	if archived := server.ArchiveLiveGames(t.Context()); archived != 1 {
		t.Fatalf("expected one live game to be archived, got %d", archived)
	}
	stored, err := data.ArchivedGame(t.Context(), gameID)
	if err != nil {
		t.Fatal(err)
	}
	if stored.Outcome != "unfinished" || stored.PlyCount != 1 {
		t.Fatalf("unexpected archive row: %#v", stored)
	}
	parsed, err := notation.Parse(stored.PGN)
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Result != "*" {
		t.Fatalf("an interrupted game should carry the * result, got %q", parsed.Result)
	}
	if err := game.Verify(parsed.Record); err != nil {
		t.Fatalf("interrupted game does not replay: %v", err)
	}
}
