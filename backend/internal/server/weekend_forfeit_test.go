package server

import (
	"strings"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// The arena's no-show clock, against the format that publishes every pairing at
// once. See settleWeekendForfeits.

// roundRobinArena is a weekend arena that has just begun as a round robin, with
// the engines in online connected and those in offline entered but not. The
// connected ones come back by name, one slot each.
//
// Every engine has an owner of its own, as it would in a real field.
func roundRobinArena(
	t *testing.T,
	online []string,
	offline []string,
) (*Server, time.Duration, persistence.Tournament, map[string]*Client) {
	t.Helper()
	server, config := weekendServer(t, func(config *persistence.WeekendConfig) {
		config.GraceSeconds = 90
	})
	ctx := t.Context()
	today := time.Now().Format("2006-01-02")
	server.openWeekendDoors(ctx, config, today, time.Now().Add(-time.Minute))
	open, err := server.data.OpenWeekend(ctx)
	if err != nil {
		t.Fatal(err)
	}

	modes := []game.ModeID{config.ModeID}
	engine := func(name string) persistence.Bot {
		owner := "owner-" + strings.ToLower(name)
		registeredSession(t, server.data, owner, "Author"+name)
		return ownedEngine(t, server.data, owner, name, modes)
	}
	clients := make(map[string]*Client, len(online))
	for _, name := range online {
		clients[name] = connectEngine(t, server, engine(name), modes)
	}
	// The sweep at the start enters only the engines it can see, so one that is
	// not connected has to be in the bracket already: entered while the doors
	// were open, gone by the time the event began.
	for _, name := range offline {
		bot := engine(name)
		if _, err := server.data.HostSignupForTournament(
			ctx, open.TournamentID, bot.UserID, bot.Name, "bot."+strings.ToLower(name),
		); err != nil {
			t.Fatalf("enter %s: %v", name, err)
		}
	}

	server.beginWeekend(ctx, config, today)
	started, err := server.data.Tournament(ctx, open.TournamentID)
	if err != nil {
		t.Fatal(err)
	}
	if started.Status != persistence.TournamentInProgress {
		t.Fatalf("expected the arena to be under way, got %q", started.Status)
	}
	if started.Format != persistence.FormatRoundRobin {
		t.Fatalf("a field of %d should play a round robin, got %q",
			len(started.Players), started.Format)
	}
	return server, time.Duration(config.GraceSeconds) * time.Second, started, clients
}

// spareSlot connects a second socket for an engine that is already online, the
// way an author running two copies of it does.
func spareSlot(t *testing.T, server *Server, first *Client) *Client {
	t.Helper()
	first.bot.mu.Lock()
	record, handshake := first.bot.record, first.bot.handshake
	first.bot.mu.Unlock()
	client := &Client{
		send:    make(chan []byte, 64),
		done:    make(chan struct{}),
		profile: first.profile,
		server:  server,
		bot: &botClient{
			botID:     first.bot.botID,
			sessionID: first.bot.sessionID,
			slot:      first.bot.slot + 1,
			record:    record,
			handshake: handshake,
			ready:     true,
		},
	}
	server.hub.Register(client)
	t.Cleanup(func() { server.hub.Unregister(client) })
	server.registerBot(client)
	return client
}

// settleAfterGrace runs the no-show clock twice: once to start it, and once a
// second after it would run out.
func settleAfterGrace(server *Server, from time.Time, grace time.Duration) {
	server.settleWeekendForfeits(from)
	server.settleWeekendForfeits(from.Add(grace + time.Second))
}

// pairingOf is the match between two engines, by name, as stored now.
func pairingOf(
	t *testing.T,
	server *Server,
	tournamentID string,
	first string,
	second string,
) persistence.TournamentMatch {
	t.Helper()
	tournament, err := server.data.Tournament(t.Context(), tournamentID)
	if err != nil {
		t.Fatal(err)
	}
	for _, match := range tournament.Matches {
		one, two := match.Player1.IGN, match.Player2.IGN
		if one == first && two == second || one == second && two == first {
			return match
		}
	}
	t.Fatalf("no pairing of %s and %s", first, second)
	return persistence.TournamentMatch{}
}

// wonBy reports whether a match went to the named engine.
func wonBy(match persistence.TournamentMatch, name string) bool {
	switch match.Result {
	case persistence.MatchPlayer1Win:
		return match.Player1.IGN == name
	case persistence.MatchPlayer2Win:
		return match.Player2.IGN == name
	}
	return false
}

// boardsInPlay is the names on every board the event is playing right now.
func boardsInPlay(server *Server, tournament persistence.Tournament) map[string]bool {
	playing := make(map[string]bool)
	for _, match := range tournament.Matches {
		key := tournamentMatchKey{tournamentID: tournament.TournamentID, matchID: match.MatchID}
		if server.tournamentGame(key) != nil {
			playing[match.Player1.IGN] = true
			playing[match.Player2.IGN] = true
		}
	}
	return playing
}

// clearBoards ends every game the event is playing without a result, which
// leaves those pairings pending and their engines idle.
func clearBoards(server *Server) {
	server.mu.Lock()
	defer server.mu.Unlock()
	for key, session := range server.tournamentGames {
		if session != nil {
			delete(server.games, session.gameID)
			delete(server.participants, session.redClient)
			delete(server.participants, session.blueClient)
		}
		delete(server.tournamentGames, key)
	}
}

// Weekend Bot Arena #6, in miniature. A round robin creates every pairing when
// it starts, so most of its schedule is always waiting on engines that are busy
// at another of its boards. The clock counted busy as gone. Ninety seconds into
// round one it drew every pairing between two busy engines, and gave the rest
// to whichever engine had a slot free. The event then finished with round one.
func TestARoundRobinWaitsForEnginesAtItsOtherBoards(t *testing.T) {
	server, grace, tournament, _ := roundRobinArena(
		t, []string{"Alpha", "Bravo", "Charlie", "Delta"}, nil,
	)
	server.autoReadyBotMatches()
	if playing := boardsInPlay(server, tournament); len(playing) != 4 {
		t.Fatalf("four engines should be on two boards, got %v", playing)
	}

	settleAfterGrace(server, time.Now(), grace)

	settled, err := server.data.Tournament(t.Context(), tournament.TournamentID)
	if err != nil {
		t.Fatal(err)
	}
	for _, match := range settled.Matches {
		if match.Result != persistence.MatchPending {
			t.Errorf(
				"%s v %s was settled %q while both engines were connected and playing",
				match.Player1.IGN, match.Player2.IGN, match.Result,
			)
		}
	}
	if settled.Status != persistence.TournamentInProgress {
		t.Fatalf("the arena should still be under way, got %q", settled.Status)
	}
}

// The other half of #6. An engine with a slot to spare was the only one ever
// free, so it was handed every pairing it had not played. TheraRPS took six
// that way and won the event on them.
func TestASpareSlotWinsNothingFromEnginesAtOtherBoards(t *testing.T) {
	server, grace, tournament, clients := roundRobinArena(
		t, []string{"Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot"}, nil,
	)
	spareSlot(t, server, clients["Alpha"])
	server.autoReadyBotMatches()
	if playing := boardsInPlay(server, tournament); len(playing) != 6 {
		t.Fatalf("six engines should be on three boards, got %v", playing)
	}

	settleAfterGrace(server, time.Now(), grace)

	settled, err := server.data.Tournament(t.Context(), tournament.TournamentID)
	if err != nil {
		t.Fatal(err)
	}
	for _, match := range settled.Matches {
		if match.Result != persistence.MatchPending {
			t.Errorf(
				"%s v %s was settled %q while both engines were connected",
				match.Player1.IGN, match.Player2.IGN, match.Result,
			)
		}
	}
}

// An engine that has gone forfeits the pairings kept waiting for it, and only
// those. A pairing whose other engine is busy at another board is not waiting
// yet. Its clock starts when that engine is free and has nothing else to play.
func TestAnEngineThatHasGoneForfeitsOnlyThePairingsWaitingForIt(t *testing.T) {
	server, grace, tournament, _ := roundRobinArena(
		t, []string{"Alpha", "Bravo", "Charlie"}, []string{"Delta"},
	)
	server.autoReadyBotMatches()
	playing := boardsInPlay(server, tournament)
	if len(playing) != 2 {
		t.Fatalf("three engines and an empty seat should fill one board, got %v", playing)
	}
	var idle string
	var busy []string
	for _, name := range []string{"Alpha", "Bravo", "Charlie"} {
		if playing[name] {
			busy = append(busy, name)
		} else {
			idle = name
		}
	}

	settleAfterGrace(server, time.Now(), grace)

	if match := pairingOf(t, server, tournament.TournamentID, idle, "Delta"); !wonBy(match, idle) {
		t.Fatalf("%s waited out the grace for Delta and should have the match, got %q",
			idle, match.Result)
	}
	for _, name := range busy {
		if match := pairingOf(t, server, tournament.TournamentID, name, "Delta"); match.Result != persistence.MatchPending {
			t.Fatalf("%s is at another board, so nothing waited for Delta yet; got %q",
				name, match.Result)
		}
		if match := pairingOf(t, server, tournament.TournamentID, idle, name); match.Result != persistence.MatchPending {
			t.Fatalf("%s v %s has both engines here and should wait, got %q",
				idle, name, match.Result)
		}
	}

	// Their board clears. Now the pairings with Delta are what each of them is
	// waiting on, and the clock runs for them too.
	clearBoards(server)
	settleAfterGrace(server, time.Now().Add(time.Hour), grace)

	for _, name := range busy {
		if match := pairingOf(t, server, tournament.TournamentID, name, "Delta"); !wonBy(match, name) {
			t.Fatalf("%s should have its match with Delta once it was free, got %q",
				name, match.Result)
		}
	}
	if match := pairingOf(t, server, tournament.TournamentID, busy[0], busy[1]); match.Result != persistence.MatchPending {
		t.Fatalf("%s v %s is still to be played, got %q", busy[0], busy[1], match.Result)
	}
}

// A pairing neither of whose engines is here is a draw once the grace runs out.
// Nobody is left to award it to, and the event cannot finish while it is
// pending.
func TestAPairingWithNeitherEngineHereIsDrawn(t *testing.T) {
	server, grace, tournament, _ := roundRobinArena(
		t, []string{"Alpha", "Bravo"}, []string{"Charlie", "Delta"},
	)
	server.autoReadyBotMatches()

	settleAfterGrace(server, time.Now(), grace)

	if match := pairingOf(t, server, tournament.TournamentID, "Charlie", "Delta"); match.Result != persistence.MatchDraw {
		t.Fatalf("a pairing with both engines gone should be drawn, got %q", match.Result)
	}
}
