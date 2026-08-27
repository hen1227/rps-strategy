package server

import (
	"context"
	"testing"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// The whole promise of a drain is that nothing new arrives while what is
// already owed plays out. These are the four doors a new game comes through.

func TestADrainingBotRefusesAChallenge(t *testing.T) {
	server := New(nil)
	human := fakeClient(t, server, "human", false)
	engine := openToChallenges(t, server, "engine")

	server.requestBotShutdown(engine, true, "the website")
	server.challengeBot(human, engine.bot.botID, game.ModeTotalWar, nil, game.Red)

	if server.participantFor(human) != nil {
		t.Fatal("a challenge opened a game against a bot that is shutting down")
	}
	refusal, ok := messageOfType(drain(human), "bot_unavailable")
	if !ok {
		t.Fatal("the challenger should be told why the game did not open")
	}
	if refusal.Message == "" {
		t.Fatal("the refusal should say what happened")
	}
}

func TestADrainingBotCannotBeEnteredIntoASeries(t *testing.T) {
	server := New(nil)
	first := fakeClient(t, server, "first", true)
	second := fakeClient(t, server, "second", true)

	server.requestBotShutdown(second, false, "the website")

	_, err := server.StartBotSeries(context.Background(), BotSeriesRequest{
		ModeID:      game.ModeTotalWar,
		FirstBotID:  first.bot.botID,
		SecondBotID: second.bot.botID,
		Pairs:       1,
		Control:     game.DefaultTimeControl(),
		Privileged:  true,
	})
	if err != errSeriesBotDraining {
		t.Fatalf("expected the series to be refused as draining, got %v", err)
	}
}

// A pause is a drain too. An owner who only wanted the machine quiet for an
// hour still expects nothing new to start.
func TestAPausedBotIsNotOfferedInTheRoster(t *testing.T) {
	server := New(nil)
	engine := openToChallenges(t, server, "engine")

	server.requestBotShutdown(engine, false, "the website")

	roster := server.botRoster()
	if len(roster) != 1 {
		t.Fatalf("expected the bot to stay on the roster, got %d rows", len(roster))
	}
	if !roster[0].Draining {
		t.Fatal("a draining bot should be published as draining, not quietly hidden")
	}
}

// The one thing a drain does not do is take a bot off a board it is already on.
// That is the whole reason this exists: killing the process abandons the game,
// and an abandonment is a loss the engine did not play for.
func TestADrainWaitsForTheGameOnTheBoard(t *testing.T) {
	server := New(nil)
	human := fakeClient(t, server, "human", false)
	engine := openToChallenges(t, server, "engine")
	server.challengeBot(human, engine.bot.botID, game.ModeTotalWar, nil, game.Red)
	if server.participantFor(engine) == nil {
		t.Fatal("the setup did not seat the engine in a game")
	}

	state := server.requestBotShutdown(engine, true, "the website")

	if len(state.WaitingOn) == 0 {
		t.Fatal("a bot mid-game owes at least one thing")
	}
	if server.participantFor(engine) == nil {
		t.Fatal("the drain ended the game the engine was playing")
	}
	if _, ok := messageOfType(drain(engine), "bot_shutdown"); ok {
		t.Fatal("the engine was told to stop while it still had a game to finish")
	}
}

// An idle bot owes nothing, so it settles on the spot rather than waiting for
// the lobby ticker to notice.
func TestAnIdleBotShutsDownImmediately(t *testing.T) {
	server := New(nil)
	engine := fakeClient(t, server, "engine", true)
	engine.bot.mu.Lock()
	engine.bot.clientVersion = botShutdownExitVersion
	engine.bot.mu.Unlock()

	state := server.requestBotShutdown(engine, true, "the website")

	if len(state.WaitingOn) != 0 {
		t.Fatalf("an idle bot owes nothing, got %v", state.WaitingOn)
	}
	if _, ok := messageOfType(drain(engine), "bot_shutdown"); !ok {
		t.Fatal("an idle bot asked to shut down should be told to stop")
	}
}

// A pause is the other half of the same request: same drain, no exit.
func TestAPausedBotIsNotToldToStop(t *testing.T) {
	server := New(nil)
	engine := fakeClient(t, server, "engine", true)
	engine.bot.mu.Lock()
	engine.bot.clientVersion = botShutdownExitVersion
	engine.bot.mu.Unlock()

	server.requestBotShutdown(engine, false, "the website")

	messages := drain(engine)
	if _, ok := messageOfType(messages, "bot_shutdown"); ok {
		t.Fatal("a pause should never tell the client to stop")
	}
	if _, ok := messageOfType(messages, "bot_draining"); !ok {
		t.Fatal("a paused bot should still be told it is draining")
	}
}

// Every client since 1.0 exits on bot_rejected, which is what lets a graceful
// shutdown work for a script its owner has not re-downloaded.
func TestAnOlderClientIsToldToStopInAWordItKnows(t *testing.T) {
	server := New(nil)
	engine := fakeClient(t, server, "engine", true)
	engine.bot.mu.Lock()
	engine.bot.clientVersion = "1.1"
	engine.bot.mu.Unlock()

	server.requestBotShutdown(engine, true, "the website")

	messages := drain(engine)
	if _, ok := messageOfType(messages, "bot_shutdown"); ok {
		t.Fatal("a 1.1 client cannot read bot_shutdown and would sit there forever")
	}
	if _, ok := messageOfType(messages, "bot_rejected"); !ok {
		t.Fatal("a 1.1 client should be stopped with the message it does understand")
	}
}

// A drain is one connection's state, so cancelling puts the bot straight back
// in the pool rather than leaving it half out of play.
func TestCancellingADrainPutsTheBotBackInPlay(t *testing.T) {
	server := New(nil)
	human := fakeClient(t, server, "human", false)
	engine := openToChallenges(t, server, "engine")

	server.requestBotShutdown(engine, true, "the website")
	server.cancelBotShutdown(engine)

	if botIsDraining(engine) {
		t.Fatal("the drain survived being cancelled")
	}
	server.challengeBot(human, engine.bot.botID, game.ModeTotalWar, nil, game.Red)
	if server.participantFor(human) == nil {
		t.Fatal("a cancelled drain should leave the bot challengeable again")
	}
}

// A drain lives on the socket and not in the registry, which is what makes
// "until it reboots" true without anything having to remember to clear it.
func TestADrainDoesNotSurviveAReconnect(t *testing.T) {
	server := New(nil)
	engine := fakeClient(t, server, "engine", true)
	server.requestBotShutdown(engine, true, "the website")

	// The same bot id arriving on a new connection, which is what rpsbot.py
	// does after it restarts.
	restarted := &Client{
		send:    make(chan []byte, 64),
		done:    make(chan struct{}),
		profile: engine.profile,
		server:  server,
		bot: &botClient{
			botID:  engine.bot.botID,
			record: engine.bot.record,
			ready:  true,
		},
	}
	server.mu.Lock()
	server.bots[restarted.bot.botID] = restarted
	server.mu.Unlock()

	if botIsDraining(restarted) {
		t.Fatal("a restarted bot came back still refusing games")
	}
}

// An event that has started is the one commitment a drain waits out: a round
// robin is built around every entrant being there, and a bot that leaves
// halfway takes the meaning out of everybody else's standings too.
func TestADrainWaitsForMatchesInAStartedTournament(t *testing.T) {
	server := New(nil)
	data, ctx := server.data, context.Background()

	if _, err := data.CreateTournament(ctx, "cup", "Summer Cup", game.ModeTotalWar, "Total War"); err != nil {
		t.Fatalf("create tournament: %v", err)
	}
	for _, name := range []string{"engine", "rival"} {
		if _, err := data.SignupForTournament(ctx, "cup", name, name, "bot."+name, true); err != nil {
			t.Fatalf("sign up %s: %v", name, err)
		}
	}
	if _, err := data.StartTournament(ctx, "cup"); err != nil {
		t.Fatalf("start tournament: %v", err)
	}

	engine := fakeClient(t, server, "engine", true)
	engine.bot.mu.Lock()
	engine.bot.record.UserID = "engine"
	engine.bot.mu.Unlock()

	state := server.requestBotShutdown(engine, true, "the website")

	if len(state.WaitingOn) == 0 {
		t.Fatal("a bot with a pending tournament match owes that match")
	}
	if _, ok := messageOfType(drain(engine), "bot_shutdown"); ok {
		t.Fatal("the engine was told to stop with a tournament still to play")
	}
}

// An event nobody has played yet loses nothing by this bot leaving it, and
// waiting for a tournament that may never start is a drain that never settles.
func TestADrainWithdrawsFromATournamentThatHasNotStarted(t *testing.T) {
	server := New(nil)
	data, ctx := server.data, context.Background()

	if _, err := data.CreateTournament(ctx, "cup", "Summer Cup", game.ModeTotalWar, "Total War"); err != nil {
		t.Fatalf("create tournament: %v", err)
	}
	if _, err := data.SignupForTournament(ctx, "cup", "engine", "engine", "bot.engine", true); err != nil {
		t.Fatalf("sign up: %v", err)
	}

	engine := fakeClient(t, server, "engine", true)
	engine.bot.mu.Lock()
	engine.bot.record.UserID = "engine"
	engine.bot.mu.Unlock()

	state := server.requestBotShutdown(engine, true, "the website")

	if len(state.WaitingOn) != 0 {
		t.Fatalf("an unstarted event is not a commitment, got %v", state.WaitingOn)
	}
	tournament, err := data.Tournament(ctx, "cup")
	if err != nil {
		t.Fatalf("read tournament: %v", err)
	}
	for _, player := range tournament.Players {
		if player.UserID == "engine" {
			t.Fatal("the draining bot is still entered in an event it will not attend")
		}
	}
}

// The registration-only rule, at the layer that enforces it. A round robin
// already built cannot lose a name without rewriting games that were played.
func TestWithdrawingFromAStartedTournamentIsRefused(t *testing.T) {
	data, ctx := New(nil).data, context.Background()

	if _, err := data.CreateTournament(ctx, "cup", "Summer Cup", game.ModeTotalWar, "Total War"); err != nil {
		t.Fatalf("create tournament: %v", err)
	}
	for _, name := range []string{"one", "two"} {
		if _, err := data.SignupForTournament(ctx, "cup", name, name, "bot."+name, true); err != nil {
			t.Fatalf("sign up %s: %v", name, err)
		}
	}
	if _, err := data.StartTournament(ctx, "cup"); err != nil {
		t.Fatalf("start tournament: %v", err)
	}

	if _, err := data.WithdrawFromTournament(ctx, "cup", "one"); err != persistence.ErrTournamentAlreadyStarted {
		t.Fatalf("expected a started tournament to refuse a withdrawal, got %v", err)
	}
}

// An engine that prints `shutdown` on every search would otherwise re-read
// every tournament and re-broadcast the roster once a move.
func TestRepeatingAShutdownRequestChangesNothing(t *testing.T) {
	server := New(nil)
	engine := fakeClient(t, server, "engine", true)
	engine.bot.mu.Lock()
	engine.bot.clientVersion = botShutdownExitVersion
	engine.bot.mu.Unlock()

	server.requestBotShutdown(engine, true, "the engine")
	before := drain(engine)
	server.requestBotShutdown(engine, true, "the engine")
	after := drain(engine)

	if len(before) == 0 {
		t.Fatal("the first request should have said something")
	}
	if len(after) != 0 {
		t.Fatalf("a repeated request should be silent, got %d messages", len(after))
	}
}

// A pause must never quietly downgrade a shutdown somebody already asked for —
// and an engine asking to stop must still be able to upgrade its owner's pause.
func TestAPauseCannotUndoAShutdownButAShutdownCanUpgradeAPause(t *testing.T) {
	server := New(nil)

	stopping := fakeClient(t, server, "stopping", true)
	server.requestBotShutdown(stopping, true, "the website")
	if state := server.requestBotShutdown(stopping, false, "the engine"); !state.ExitWhenDone {
		t.Fatal("a pause downgraded a shutdown that was already asked for")
	}

	pausing := fakeClient(t, server, "pausing", true)
	server.requestBotShutdown(pausing, false, "the website")
	if state := server.requestBotShutdown(pausing, true, "the engine"); !state.ExitWhenDone {
		t.Fatal("a shutdown should be able to upgrade a pause")
	}
}

// Pausing an idle bot settles immediately. Asking it to stop after that has to
// actually stop it, rather than finding the drain already marked settled and
// leaving the client connected for ever.
func TestUpgradingASettledPauseStillStopsTheBot(t *testing.T) {
	server := New(nil)
	engine := fakeClient(t, server, "engine", true)
	engine.bot.mu.Lock()
	engine.bot.clientVersion = botShutdownExitVersion
	engine.bot.mu.Unlock()

	server.requestBotShutdown(engine, false, "the website")
	drain(engine)
	server.requestBotShutdown(engine, true, "the website")

	if _, ok := messageOfType(drain(engine), "bot_shutdown"); !ok {
		t.Fatal("upgrading a settled pause to a shutdown never told the client to stop")
	}
}
