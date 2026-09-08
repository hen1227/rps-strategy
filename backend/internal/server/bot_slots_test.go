package server

import (
	"strings"
	"testing"
	"time"

	"rps-strategy/backend/internal/botclient"
	"rps-strategy/backend/internal/game"
)

// A bot whose owner allowed it several games at once opens one connection per
// slot, all from the same process. These are the two questions that follow: the
// server has to hand a second game to the second slot rather than refuse it,
// and it has to keep treating the whole set as one engine — one row on the
// roster, one drain, one thing to displace when a second process turns up.

// fakeSlot opens another connection for a bot fakeClient already made, the way
// the client does: same bot, same session, the next slot along.
func fakeSlot(t *testing.T, server *Server, first *Client, index int, count int) *Client {
	t.Helper()
	first.bot.mu.Lock()
	record := first.bot.record
	session := first.bot.sessionID
	first.bot.maxGames = count
	first.bot.clientVersion = botclient.Version()
	first.bot.mu.Unlock()

	client := &Client{
		send:    make(chan []byte, 64),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: record.UserID, Username: record.Name},
		server:  server,
		bot: &botClient{
			botID:         record.BotID,
			record:        record,
			ready:         true,
			sessionID:     session,
			slot:          index,
			maxGames:      count,
			clientVersion: botclient.Version(),
		},
	}
	server.hub.Register(client)
	t.Cleanup(func() { server.hub.Unregister(client) })
	server.registerBot(client)
	return client
}

// The point of the whole feature: a second challenge is seated rather than
// refused, and it lands on the slot that is free.
func TestASecondChallengeGoesToTheEngineSSecondSlot(t *testing.T) {
	server := New(nil)
	first := openToChallenges(t, server, "engine")
	second := fakeSlot(t, server, first, 1, 2)

	alice := fakeClient(t, server, "alice", false)
	bob := fakeClient(t, server, "bob", false)
	server.challengeBot(alice, first.bot.botID, game.ModeTotalWar, nil, game.Red)
	server.challengeBot(bob, first.bot.botID, game.ModeTotalWar, nil, game.Red)

	if server.participantFor(alice) == nil || server.participantFor(bob) == nil {
		t.Fatal("both challengers should be in a game")
	}
	if server.participantFor(first) == nil || server.participantFor(second) == nil {
		t.Fatal("both slots should be playing")
	}
	if same := server.participantFor(alice).session == server.participantFor(bob).session; same {
		t.Fatal("the two challengers were seated at the same board")
	}
}

// And the third one is refused, in words that say what is actually happening.
func TestAChallengeIsRefusedOnceEverySlotIsPlaying(t *testing.T) {
	server := New(nil)
	first := openToChallenges(t, server, "engine")
	fakeSlot(t, server, first, 1, 2)

	for _, name := range []string{"alice", "bob"} {
		server.challengeBot(fakeClient(t, server, name, false),
			first.bot.botID, game.ModeTotalWar, nil, game.Red)
	}
	late := fakeClient(t, server, "late", false)
	server.challengeBot(late, first.bot.botID, game.ModeTotalWar, nil, game.Red)

	if server.participantFor(late) != nil {
		t.Fatal("a third game opened on a bot with two slots")
	}
	refusal, ok := messageOfType(drain(late), "bot_unavailable")
	if !ok {
		t.Fatal("the challenger was not told why")
	}
	if !strings.Contains(refusal.Message, "2 games") {
		t.Errorf("the refusal should say how many games it is in: %q", refusal.Message)
	}
}

// One engine, one row. Publishing a slot each would put three challenge buttons
// in the lobby for one opponent.
func TestTheRosterListsOneRowPerBotWithItsSlotsCounted(t *testing.T) {
	server := New(nil)
	first := openToChallenges(t, server, "engine")
	fakeSlot(t, server, first, 1, 3)
	fakeSlot(t, server, first, 2, 3)

	roster := server.botRoster()
	if len(roster) != 1 {
		t.Fatalf("expected one row for one bot, got %d", len(roster))
	}
	if roster[0].Slots != 3 || roster[0].ActiveGames != 0 || roster[0].Busy {
		t.Fatalf("an idle three-slot bot published as %+v", roster[0])
	}

	server.challengeBot(fakeClient(t, server, "alice", false),
		first.bot.botID, game.ModeTotalWar, nil, game.Red)
	roster = server.botRoster()
	if roster[0].ActiveGames != 1 || roster[0].Busy {
		t.Fatalf("a three-slot bot in one game published as %+v", roster[0])
	}

	for _, name := range []string{"bob", "carol"} {
		server.challengeBot(fakeClient(t, server, name, false),
			first.bot.botID, game.ModeTotalWar, nil, game.Red)
	}
	roster = server.botRoster()
	if roster[0].ActiveGames != 3 || !roster[0].Busy {
		t.Fatalf("a full three-slot bot published as %+v", roster[0])
	}
}

// A forgotten terminal is the case this protects: two processes on one token
// means two engines answering for one bot, so the older set goes — all of it,
// not just the slot the new one happens to be numbered.
func TestASecondProcessDisplacesEverySlotOfTheFirst(t *testing.T) {
	server := New(nil)
	first := openToChallenges(t, server, "engine")
	first.bot.mu.Lock()
	first.bot.sessionID = "old-process"
	first.bot.maxGames = 2
	first.bot.mu.Unlock()
	server.registerBot(first)
	second := fakeSlot(t, server, first, 1, 2)

	replacement := fakeSlot(t, server, first, 0, 2)
	replacement.bot.mu.Lock()
	replacement.bot.sessionID = "new-process"
	replacement.bot.mu.Unlock()
	server.registerBot(replacement)

	connections := server.botConnections(first.bot.botID)
	if len(connections) != 1 || connections[0] != replacement {
		t.Fatalf("expected only the new process to be left, got %d connections", len(connections))
	}
	for _, displaced := range []*Client{first, second} {
		if _, ok := messageOfType(drain(displaced), "bot_rejected"); !ok {
			t.Error("a displaced slot was never told it had been replaced")
		}
	}
}

// The same slot reconnecting is not a second process, and must not take the
// bot's other slots down with it.
func TestASlotReconnectingReplacesOnlyItself(t *testing.T) {
	server := New(nil)
	first := openToChallenges(t, server, "engine")
	first.bot.mu.Lock()
	first.bot.sessionID = "one-process"
	first.bot.maxGames = 2
	first.bot.mu.Unlock()
	server.registerBot(first)
	second := fakeSlot(t, server, first, 1, 2)

	again := fakeSlot(t, server, first, 1, 2)
	server.registerBot(again)

	connections := server.botConnections(first.bot.botID)
	if len(connections) != 2 {
		t.Fatalf("expected two slots, got %d", len(connections))
	}
	if connections[0] != first || connections[1] != again {
		t.Fatal("the reconnecting slot did not take its own place back")
	}
	if _, ok := messageOfType(drain(second), "bot_rejected"); !ok {
		t.Error("the old socket for that slot should have been displaced")
	}
	if _, ok := messageOfType(drain(first), "bot_rejected"); ok {
		t.Error("the other slot was displaced by a reconnect that was not its own")
	}
}

// A drain is something the bot is doing. Draining the slot that asked and
// leaving the others in the lobby is the shutdown not happening.
func TestADrainCoversEverySlotAndWaitsForAllOfTheirGames(t *testing.T) {
	server := New(nil)
	first := openToChallenges(t, server, "engine")
	second := fakeSlot(t, server, first, 1, 2)
	alice := fakeClient(t, server, "alice", false)
	bob := fakeClient(t, server, "bob", false)
	server.challengeBot(alice, first.bot.botID, game.ModeTotalWar, nil, game.Red)
	server.challengeBot(bob, first.bot.botID, game.ModeTotalWar, nil, game.Red)
	drain(first)
	drain(second)

	state := server.requestBotShutdown(second, true, "the website")
	if len(state.WaitingOn) != 1 || !strings.Contains(state.WaitingOn[0], "2 games") {
		t.Fatalf("a two-slot bot in two games is waiting on %v", state.WaitingOn)
	}
	for _, slot := range []*Client{first, second} {
		if _, ok := messageOfType(drain(slot), "bot_draining"); !ok {
			t.Error("a slot was not told the bot is shutting down")
		}
		if !botHasOwnDrain(slot) {
			t.Error("a slot was left out of the drain")
		}
	}
	if roster := server.botRoster(); !roster[0].Draining {
		t.Error("the lobby was still offering a draining bot")
	}

	// One game ending is not the bot being finished.
	server.resign(alice)
	server.settleBotShutdowns()
	if _, ok := messageOfType(drain(first), "bot_shutdown"); ok {
		t.Fatal("the bot was released while a slot was still playing")
	}

	server.resign(bob)
	server.settleBotShutdowns()
	for _, slot := range []*Client{first, second} {
		if _, ok := messageOfType(drain(slot), "bot_shutdown"); !ok {
			t.Error("a slot was never told it could stop")
		}
	}
}

// Out-of-range answers are refused at the door rather than capped, so a client
// that asks for seven slots hears about it instead of opening five that work.
func TestSlotRequestsOutsideTheCeilingAreRefused(t *testing.T) {
	for _, testCase := range []struct {
		name    string
		message ClientMessage
		want    int
		refused string
	}{
		{"a client that says nothing plays one game",
			ClientMessage{}, 1, ""},
		{"within the ceiling",
			ClientMessage{MaxGames: 5, Slot: 4}, 5, ""},
		{"above the ceiling",
			ClientMessage{MaxGames: 6, Slot: 0}, 0, "the most any bot may play is 5"},
		{"a slot it did not ask for",
			ClientMessage{MaxGames: 2, Slot: 2}, 0, "slot 3 of 2"},
		{"a negative slot",
			ClientMessage{MaxGames: 2, Slot: -1}, 0, "of 2"},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			maxGames, refusal := botSlotRequest(testCase.message)
			if maxGames != testCase.want {
				t.Errorf("maxGames = %d, want %d", maxGames, testCase.want)
			}
			if testCase.refused == "" && refusal != "" {
				t.Errorf("unexpected refusal: %s", refusal)
			}
			if testCase.refused != "" && !strings.Contains(refusal, testCase.refused) {
				t.Errorf("refusal %q does not say %q", refusal, testCase.refused)
			}
		})
	}
}

// Unregistering one slot leaves the bot online, and the last one takes it off
// the roster.
func TestABotStaysOnlineUntilItsLastSlotGoes(t *testing.T) {
	server := New(nil)
	first := openToChallenges(t, server, "engine")
	second := fakeSlot(t, server, first, 1, 2)

	server.unregisterBot(second)
	if len(server.botRoster()) != 1 {
		t.Fatal("a bot with a slot still connected went offline")
	}
	server.unregisterBot(first)
	if len(server.botRoster()) != 0 {
		t.Fatal("a bot with no slots left is still on the roster")
	}
	if server.botConnection(first.bot.botID) != nil {
		t.Fatal("the directory kept an entry for a bot with no connections")
	}
}

// The rules dates ride on bot_ready, for the modes this engine says it plays
// and no others: a bot told about a change in a mode it does not play has been
// given something to check that cannot affect it.
func TestBotReadyDatesTheRulesOfTheModesTheEnginePlays(t *testing.T) {
	server := New(nil)
	published := server.rulesPublishedFor([]game.ModeID{game.ModeInfiltration})

	if len(published) != 1 {
		t.Fatalf("an engine that plays one mode was sent %d dates: %v",
			len(published), published)
	}
	if _, err := time.Parse("2006-01-02", published[game.ModeInfiltration]); err != nil {
		t.Errorf("%s is dated %q: %v",
			game.ModeInfiltration, published[game.ModeInfiltration], err)
	}
	if server.rulesPublishedFor([]game.ModeID{"not-a-mode"}) != nil {
		t.Error("a mode this server does not have should carry no date at all")
	}
}
