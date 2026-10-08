package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// A host's ranked run, and a host moving a finished game between ranked and
// casual. See BotSeriesRequest.Ranked and persistence/reclassify.go.

// The one exception to "only the pool makes a ranked engine game": an
// administrator who asks for it, on a run they set up themselves.
func TestAHostCanStartARankedSeries(t *testing.T) {
	server, _, _ := seriesTestBots(t)
	first := addRivalSeriesBot(t, server, "Rival")
	second := addRivalSeriesBot(t, server, "Challenger")

	ask := hostSeries(first, second, game.ModeTotalWar, 1, 4, 99)
	ask.Ranked = true
	if _, err := server.StartBotSeries(t.Context(), ask); err != nil {
		t.Fatalf("start series: %v", err)
	}
	awaitSeriesFinished(t, server)

	history, err := server.data.GameHistory(t.Context(), first.UserID, 10, 0)
	if err != nil {
		t.Fatalf("read history: %v", err)
	}
	if len(history) != 2 {
		t.Fatalf("one pair is two games, got %d", len(history))
	}
	for _, played := range history {
		if !played.Ranked {
			t.Fatalf("a host's ranked run seated game %s casual", played.GameID)
		}
	}
	series, err := server.data.BotSeries(t.Context(), latestSeriesID(t, server))
	if err != nil {
		t.Fatalf("read series: %v", err)
	}
	if series.Casual || !series.Ranked || series.Ladder {
		t.Fatalf("a host's ranked run read as %#v", series)
	}
	// And it is not a round: the rounds page reports what the pool arranged,
	// and this run would otherwise be filed under whichever hour it began in.
	rounds, err := server.data.LadderSeriesBetween(
		t.Context(), 0, time.Now().Add(time.Hour).UnixMilli(),
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, round := range rounds {
		if round.SeriesID == series.SeriesID {
			t.Fatal("a host's run was reported as one of the pool's rounds")
		}
	}
}

// A visitor sending the field is told no, rather than having it ignored and
// believing their run counts.
func TestOnlyAHostMayAskForARankedSeries(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	openToPlay(t, server, alpha)
	openToPlay(t, server, beta)

	ask := visitorSeries(alpha, beta, "owner")
	ask.Ranked = true
	if _, err := server.StartBotSeries(t.Context(), ask); !errors.Is(err, errSeriesRankedHostOnly) {
		t.Fatalf("expected a visitor's ranked run to be refused, got %v", err)
	}
	// Refused before anything was claimed, so the same visitor's casual run is
	// not turned away as a second one.
	ask.Ranked = false
	if _, err := server.StartBotSeries(t.Context(), ask); err != nil {
		t.Fatalf("the casual run after it was refused: %v", err)
	}
}

// Two engines one person registered would be seated casual whatever was asked,
// so asking for ranked is refused up front instead.
func TestARankedSeriesBetweenOneOwnersBotsIsRefused(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)

	ask := hostSeries(alpha, beta, game.ModeTotalWar, 1, 4, 99)
	ask.Ranked = true
	if _, err := server.StartBotSeries(t.Context(), ask); !errors.Is(err, errSeriesRankedSameOwner) {
		t.Fatalf("expected the same-owner refusal, got %v", err)
	}
	ask.Ranked = false
	if _, err := server.StartBotSeries(t.Context(), ask); err != nil {
		t.Fatalf("the refusal left something claimed: %v", err)
	}
}

// A host's ranked run is a ranked game like any other, so it waits out the
// weekly arena with the rest of them. A casual one does not.
func TestAHostsRankedSeriesWaitsOutTheArena(t *testing.T) {
	server, _ := arenaUnderWay(t)
	first := poolBot(t, server, "Outsider", "owner-outsider")
	second := poolBot(t, server, "Bystander", "owner-bystander")
	server.seriesDelay = time.Hour

	ask := BotSeriesRequest{
		FirstBotID:   first.BotID,
		SecondBotID:  second.BotID,
		ModeID:       game.ModeIntransitive,
		Pairs:        1,
		OpeningPlies: ladderOpeningPlies,
		Control:      ladderClocks[0],
		Privileged:   true,
		Ranked:       true,
	}
	if _, err := server.StartBotSeries(t.Context(), ask); !errors.Is(err, errLadderPaused) {
		t.Fatalf("a host's ranked run started during the arena: %v", err)
	}
	ask.Ranked = false
	if _, err := server.StartBotSeries(t.Context(), ask); err != nil {
		t.Fatalf("a casual run during the arena was refused: %v", err)
	}
}

// Both doors take the field: the administrative route starts a ranked run, and
// the public one refuses the field from anybody who is not an administrator.
func TestTheSeriesRoutesTakeTheRankedField(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	server.setAdminToken(adminRouteToken)
	handler := server.Routes()
	openToPlay(t, server, alpha)
	openToPlay(t, server, beta)
	first := addRivalSeriesBot(t, server, "Rival")
	second := addRivalSeriesBot(t, server, "Challenger")

	const guestKey = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
	if _, err := server.data.EnsureAccountWithProfileKey(
		t.Context(), "guest", "Guest", guestKey,
	); err != nil {
		t.Fatalf("guest account: %v", err)
	}
	body := func(one persistence.Bot, other persistence.Bot) map[string]any {
		return map[string]any{
			"firstBotId":   one.BotID,
			"secondBotId":  other.BotID,
			"modeId":       game.ModeTotalWar,
			"pairs":        1,
			"openingPlies": 4,
			"timeControl":  map[string]any{"initialTimeMs": 60_000, "incrementMs": 0},
			"ranked":       true,
		}
	}

	refused := tournamentRequest(
		t, handler, http.MethodPost, "/api/bot-series?userId=guest", body(alpha, beta), guestKey,
	)
	if refused.Code != http.StatusForbidden {
		t.Fatalf("a guest's ranked run should be forbidden, got %d: %s", refused.Code, refused.Body)
	}

	started := tournamentRequest(
		t, handler, http.MethodPost, "/api/admin/bot-series", body(first, second), adminRouteToken,
	)
	if started.Code != http.StatusCreated {
		t.Fatalf("the host's ranked run: %d: %s", started.Code, started.Body)
	}
	var series persistence.BotSeries
	if err := json.Unmarshal(started.Body.Bytes(), &series); err != nil {
		t.Fatal(err)
	}
	if series.Casual {
		t.Fatalf("the host's ranked run came back casual: %s", started.Body)
	}
}

// One game at a time, through the admin browser's route.
func TestTheAdminRouteMovesAnEngineGameBetweenRankedAndCasual(t *testing.T) {
	server, _, _ := seriesTestBots(t)
	server.setAdminToken(adminRouteToken)
	handler := server.Routes()
	first := addRivalSeriesBot(t, server, "Rival")
	second := addRivalSeriesBot(t, server, "Challenger")
	played := playOneSeries(t, server, first, second)
	gameID := played[0].GameID
	path := "/api/admin/games/" + gameID + "/ranked"

	if anonymous := tournamentRequest(
		t, handler, http.MethodPut, path, map[string]bool{"ranked": true}, "",
	); anonymous.Code != http.StatusUnauthorized {
		t.Fatalf("expected the route to require an admin, got %d", anonymous.Code)
	}
	if missing := tournamentRequest(
		t, handler, http.MethodPut, path, map[string]any{}, adminRouteToken,
	); missing.Code != http.StatusBadRequest {
		t.Fatalf("a body that says nothing should be refused, got %d: %s", missing.Code, missing.Body)
	}

	moved := tournamentRequest(
		t, handler, http.MethodPut, path, map[string]bool{"ranked": true}, adminRouteToken,
	)
	if moved.Code != http.StatusOK {
		t.Fatalf("move the game: %d: %s", moved.Code, moved.Body)
	}
	var report persistence.Reclassification
	if err := json.Unmarshal(moved.Body.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if report.Changed != 1 || !report.Ranked {
		t.Fatalf("unexpected report: %s", moved.Body)
	}
	history, err := server.data.GameHistory(t.Context(), first.UserID, 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range history {
		// The one game moved and its partner did not: this is the per-game
		// route, and the run has its own.
		if record.Ranked != (record.GameID == gameID) {
			t.Fatalf("game %s reads ranked=%v", record.GameID, record.Ranked)
		}
	}
	archived, err := server.data.ArchivedGame(t.Context(), gameID)
	if err != nil {
		t.Fatal(err)
	}
	if !archived.Ranked || !strings.Contains(archived.PGN, `[Ranked "true"]`) {
		t.Fatalf("the archived record was not moved with the history:\n%s", archived.PGN)
	}

	// A game with people in it is refused, whatever it is being moved to.
	registeredSession(t, server.data, "red-player", "RedPlayer")
	registeredSession(t, server.data, "blue-player", "BluePlayer")
	recordRouteGame(t, server.data, "people", "red-player", "blue-player")
	if human := tournamentRequest(
		t, handler, http.MethodPut, "/api/admin/games/people/ranked",
		map[string]bool{"ranked": false}, adminRouteToken,
	); human.Code != http.StatusConflict {
		t.Fatalf("a human game should be refused, got %d: %s", human.Code, human.Body)
	}
	if unknown := tournamentRequest(
		t, handler, http.MethodPut, "/api/admin/games/no-such-game/ranked",
		map[string]bool{"ranked": true}, adminRouteToken,
	); unknown.Code != http.StatusNotFound {
		t.Fatalf("an unknown game should be not found, got %d", unknown.Code)
	}
}

// A whole run at once, and only once it has stopped being played.
func TestTheAdminRouteMovesAFinishedRunAndNotARunningOne(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	server.setAdminToken(adminRouteToken)
	handler := server.Routes()
	first := addRivalSeriesBot(t, server, "Rival")
	second := addRivalSeriesBot(t, server, "Challenger")

	// Held between its games for as long as the test runs, so there is a run
	// to be refused on.
	server.seriesDelay = time.Hour
	series, err := server.StartBotSeries(
		t.Context(), hostSeries(first, second, game.ModeTotalWar, 2, 4, 5),
	)
	if err != nil {
		t.Fatalf("start series: %v", err)
	}
	path := "/api/admin/bot-series/" + series.SeriesID + "/ranked"
	if running := tournamentRequest(
		t, handler, http.MethodPut, path, map[string]bool{"ranked": true}, adminRouteToken,
	); running.Code != http.StatusConflict {
		t.Fatalf("a running series should be refused, got %d: %s", running.Code, running.Body)
	}

	// Stopped, and its game on the board allowed to finish — which is the other
	// half of "still being played".
	if err := server.AbortBotSeries(series.SeriesID, "", true); err != nil {
		t.Fatalf("stop the run: %v", err)
	}
	deadline := time.Now().Add(30 * time.Second)
	for server.seriesWithGamesInPlay()[series.SeriesID] {
		if time.Now().After(deadline) {
			t.Fatal("the run's last game never finished")
		}
		time.Sleep(20 * time.Millisecond)
	}

	moved := tournamentRequest(
		t, handler, http.MethodPut, path, map[string]bool{"ranked": true}, adminRouteToken,
	)
	if moved.Code != http.StatusOK {
		t.Fatalf("move the run: %d: %s", moved.Code, moved.Body)
	}
	var report persistence.Reclassification
	if err := json.Unmarshal(moved.Body.Bytes(), &report); err != nil {
		t.Fatal(err)
	}
	if report.Changed < 1 {
		t.Fatalf("the run's game did not move with it: %s", moved.Body)
	}
	after, err := server.data.BotSeries(t.Context(), series.SeriesID)
	if err != nil {
		t.Fatal(err)
	}
	if after.Casual {
		t.Fatal("a run made ranked still reads casual")
	}
	history, err := server.data.GameHistory(t.Context(), first.UserID, 10, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, record := range history {
		if !record.Ranked {
			t.Fatalf("game %s did not follow its run", record.GameID)
		}
	}

	// The same-owner rule holds on this route as well.
	server.seriesDelay = time.Millisecond
	stable, err := server.StartBotSeries(
		t.Context(), hostSeries(alpha, beta, game.ModeTotalWar, 1, 4, 5),
	)
	if err != nil {
		t.Fatalf("start the stable's run: %v", err)
	}
	awaitSeriesFinished(t, server)
	if shared := tournamentRequest(
		t, handler, http.MethodPut, "/api/admin/bot-series/"+stable.SeriesID+"/ranked",
		map[string]bool{"ranked": true}, adminRouteToken,
	); shared.Code != http.StatusConflict {
		t.Fatalf("one owner's run should be refused, got %d: %s", shared.Code, shared.Body)
	}
	if unknown := tournamentRequest(
		t, handler, http.MethodPut, "/api/admin/bot-series/no-such-run/ranked",
		map[string]bool{"ranked": true}, adminRouteToken,
	); unknown.Code != http.StatusNotFound {
		t.Fatalf("an unknown run should be not found, got %d", unknown.Code)
	}
}
