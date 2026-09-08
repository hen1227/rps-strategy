package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"rps-strategy/backend/internal/botclient"
	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// The case the whole feature exists for: the button is pressed on a bot that is
// mid-game, and the drain has to settle once that game — and nothing else —
// ends. Every other test here checks the bot is *not* stopped early; this is
// the one that checks it is stopped at all.
func TestADrainSettlesOnceTheGameOnTheBoardEnds(t *testing.T) {
	server := New(nil)
	human := fakeClient(t, server, "human", false)
	engine := openToChallenges(t, server, "engine")
	engine.bot.mu.Lock()
	engine.bot.clientVersion = botclient.Version()
	engine.bot.mu.Unlock()

	server.challengeBot(human, engine.bot.botID, game.ModeTotalWar, nil, game.Red)
	if server.participantFor(engine) == nil {
		t.Fatal("the setup did not seat the engine in a game")
	}

	server.requestBotShutdown(engine, true, "the website")
	drain(engine) // the bot_draining notice, already asserted elsewhere

	server.resign(human)
	if server.participantFor(engine) != nil {
		t.Fatal("the game did not end")
	}

	server.settleBotShutdowns() // the lobby tick that notices

	if _, ok := messageOfType(drain(engine), "bot_shutdown"); !ok {
		t.Fatal("the drain never settled once the game it was waiting on ended")
	}
}

// FINISH AND STOP travels as a one-field body, and a body is not always a body
// the proxy in front declared a length for. Reading Content-Length instead of
// the body itself turns the whole request into its opposite — a pause — and
// the owner watches the engine finish its game and then sit there, connected
// and idle, having been told to leave.
func TestAShutdownWithAnUndeclaredBodyLengthStillStopsTheBot(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = data.Close() })

	const adminToken = "0123456789abcdef0123456789abcdef"
	server := NewWithStoreAndAdminToken(data, nil, adminToken)
	ctx := t.Context()
	const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if _, err := data.EnsureAccountWithProfileKey(ctx, "owner", "Owner", key); err != nil {
		t.Fatalf("owner account: %v", err)
	}
	if _, err := data.ClaimAccountWithDiscord(ctx, "owner", "Owner", "discord-owner", "owner"); err != nil {
		t.Fatalf("register owner: %v", err)
	}
	_, token, err := server.data.MintBotToken(ctx, "owner")
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	record, err := server.data.ClaimBot(ctx, token, persistence.BotSettings{Name: "Engine"})
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	engine := &Client{
		send:    make(chan []byte, 64),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: record.UserID, Username: record.Name},
		server:  server,
		bot: &botClient{
			botID:         record.BotID,
			record:        record,
			ready:         true,
			clientVersion: botclient.Version(),
		},
	}
	server.hub.Register(engine)
	t.Cleanup(func() { server.hub.Unregister(engine) })
	server.mu.Lock()
	server.bots[record.BotID] = []*Client{engine}
	server.mu.Unlock()

	request := httptest.NewRequest(
		http.MethodPost,
		"/api/bots/"+record.BotID+"/shutdown",
		strings.NewReader(`{"exit":true}`),
	)
	// What a chunked request looks like by the time it reaches a handler: the
	// body is all there, and its length was never declared.
	request.ContentLength = -1
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Authorization", "Bearer "+adminToken)
	response := httptest.NewRecorder()
	server.Routes().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("shutdown request answered %d: %s", response.Code, response.Body)
	}
	if !server.botDrainState(engine).ExitWhenDone {
		t.Fatal("a request to stop the bot was recorded as a pause")
	}
	if _, ok := messageOfType(drain(engine), "bot_shutdown"); !ok {
		t.Fatal("the idle bot was never told to stop")
	}
}
