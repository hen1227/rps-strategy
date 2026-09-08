package server

import (
	"sort"
	"strings"
	"testing"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// A bots-only event is one conversation across all of its boards. See
// tournament_chat.go.

// engineEvent is a running round robin between four connected engines, which is
// the smallest field with two matches being played at the same time — and two
// at the same time is the whole subject here.
//
// The engines never move: they are pipes with nothing on the other end, so the
// games they are seated at stay live for as long as the test needs them.
func engineEvent(t *testing.T, field persistence.TournamentField) (*Server, persistence.Tournament) {
	t.Helper()
	server := New(nil)
	config := persistence.DefaultTournamentConfig(game.ModeTotalWar, "Total War")
	config.Name = "Engine Cup"
	config.Field = field
	if _, err := server.data.CreateTournament(t.Context(), "engine-cup", config); err != nil {
		t.Fatalf("create the event: %v", err)
	}
	if _, err := server.data.PublishTournament(t.Context(), "engine-cup"); err != nil {
		t.Fatalf("publish the event: %v", err)
	}
	for _, name := range []string{"Alpha", "Beta", "Gamma", "Delta"} {
		_, engine := connectLadderBot(t, server, name)
		if _, err := server.data.SignupForTournament(
			t.Context(), "engine-cup", engine.profile.UserID, engine.profile.Username,
			"bot."+strings.ToLower(engine.profile.Username), true,
		); err != nil {
			t.Fatalf("enter %s: %v", engine.profile.Username, err)
		}
	}
	tournament, err := server.data.StartTournament(t.Context(), "engine-cup")
	if err != nil {
		t.Fatalf("start the event: %v", err)
	}
	server.refreshBotReservations()
	server.autoReadyBotMatches()
	return server, tournament
}

// liveEventGames is every board the event has going at this moment, in a stable
// order so the two the test picks up are the same two on every run.
func liveEventGames(t *testing.T, server *Server, tournament persistence.Tournament) []*GameSession {
	t.Helper()
	sessions := make([]*GameSession, 0, 2)
	server.mu.RLock()
	for key, session := range server.tournamentGames {
		if key.tournamentID == tournament.TournamentID && session != nil {
			sessions = append(sessions, session)
		}
	}
	server.mu.RUnlock()
	sort.Slice(sessions, func(first, second int) bool {
		return sessions[first].gameID < sessions[second].gameID
	})
	if len(sessions) < 2 {
		t.Fatalf("a four-engine round robin should have two boards going, got %d", len(sessions))
	}
	return sessions
}

// watchGame puts a spectator on a board and hands back their join message.
func watchGame(t *testing.T, server *Server, userID string, gameID string) (*Client, ServerMessage) {
	t.Helper()
	watcher := &Client{
		// Roomy: a board broadcasts a state per move and these clients only
		// read when the test goes looking for a particular message.
		send:    make(chan []byte, 4096),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: userID, Username: userID},
	}
	server.spectateGame(watcher, gameID)
	joined := readClientMessage(t, watcher)
	if joined.Type != "spectator_joined" {
		t.Fatalf("%s could not watch %s: %#v", userID, gameID, joined)
	}
	return watcher, joined
}

// The point of the whole file: an event that nobody is playing in is an event
// everybody is watching together, so the people on one board hear the people on
// the next rather than sitting alone in a room of one.
func TestTheMatchesOfABotsOnlyEventAreOneConversation(t *testing.T) {
	server, tournament := engineEvent(t, persistence.FieldBots)
	boards := liveEventGames(t, server, tournament)

	here, joined := watchGame(t, server, "here", boards[0].gameID)
	there, _ := watchGame(t, server, "there", boards[1].gameID)
	if joined.ChatRoomID != tournament.TournamentID {
		t.Fatalf("a match of a bots-only event should join the event's room: %#v", joined)
	}
	if joined.ChatRoomScope != ChatScopeTournament {
		t.Fatalf("the room should say what it covers, got %q", joined.ChatRoomScope)
	}

	server.handleMessage(here, ClientMessage{Type: "send_chat", Text: "alpha has lost a rock"})
	crossed := waitForChat(t, there, "alpha has lost a rock")
	// Typed at one board and delivered to somebody on another, which is the
	// difference between one conversation and two.
	if crossed.GameID != boards[0].gameID {
		t.Fatalf("the message should carry the board it was typed at: %#v", crossed)
	}
	if crossed.RoomID != tournament.TournamentID {
		t.Fatalf("the message should be addressed to the event's room: %#v", crossed)
	}

	// And back the other way, because a room that only carries one direction is
	// a broadcast rather than a chat.
	server.handleMessage(there, ClientMessage{Type: "send_chat", Text: "so has gamma"})
	waitForChat(t, here, "so has gamma")
}

// Somebody who turns up at the third match hears what was said at the first
// two. A room per board would have handed them an empty transcript.
func TestABotsOnlyEventHandsItsWholeTranscriptToALateArrival(t *testing.T) {
	server, tournament := engineEvent(t, persistence.FieldBots)
	boards := liveEventGames(t, server, tournament)

	early, _ := watchGame(t, server, "early", boards[0].gameID)
	server.handleMessage(early, ClientMessage{Type: "send_chat", Text: "worth watching"})
	waitForChat(t, early, "worth watching")

	_, joined := watchGame(t, server, "late", boards[1].gameID)
	if len(joined.ChatMessages) != 1 || joined.ChatMessages[0].Text != "worth watching" {
		t.Fatalf("the other board's talk did not reach the new arrival: %#v", joined.ChatMessages)
	}
	// Counted the same way it is addressed: both of them are in this room.
	if joined.ChatOccupancy != 2 {
		t.Fatalf("two people are in the event's room, it says %d", joined.ChatOccupancy)
	}
}

// The other half of the rule, and the more important one. An event with people
// in it keeps a room per board: the crowd around a game is talking to the two
// playing it, and carrying that to the other boards would be telling a player
// what their next opponent is doing.
func TestAnOpenEventKeepsOneRoomPerBoard(t *testing.T) {
	server, tournament := engineEvent(t, persistence.FieldOpen)
	boards := liveEventGames(t, server, tournament)

	here, joined := watchGame(t, server, "here", boards[0].gameID)
	there, _ := watchGame(t, server, "there", boards[1].gameID)
	if joined.ChatRoomID != boards[0].gameID {
		t.Fatalf("a match of an open event should have a room of its own: %#v", joined)
	}
	if joined.ChatRoomScope != ChatScopeGame {
		t.Fatalf("the room covers one game, it says %q", joined.ChatRoomScope)
	}

	server.handleMessage(here, ClientMessage{Type: "send_chat", Text: "not for the other board"})
	heard := waitForChat(t, here, "not for the other board")
	if heard.RoomID != boards[0].gameID {
		t.Fatalf("the message went to the wrong room: %#v", heard)
	}
	// Delivery is a buffered write made while the message is being sent, so
	// anybody who was going to hear this already has it: whatever is queued for
	// the other watcher now is everything they will ever be told about it.
	for _, told := range drainChallengeTestMessages(t, there) {
		if told.Type == "chat_message" {
			t.Fatalf("the other board should not have heard it: %#v", told.ChatMessage)
		}
	}
}

// The room belongs to the event rather than to any of its boards, so the next
// round arrives in the conversation the last one was having. Between the two
// there is a moment with no game in it at all, which is what a room tied to a
// board would be forgotten in.
func TestTheNextRoundOfABotsOnlyEventJoinsTheSameConversation(t *testing.T) {
	server, tournament := engineEvent(t, persistence.FieldBots)
	firstRound := liveEventGames(t, server, tournament)

	watcher, _ := watchGame(t, server, "watcher", firstRound[0].gameID)
	server.handleMessage(watcher, ClientMessage{Type: "send_chat", Text: "between rounds"})
	waitForChat(t, watcher, "between rounds")

	for _, board := range firstRound {
		resigned, err := board.game.Resign(game.Blue)
		if err != nil {
			t.Fatalf("end %s: %v", board.gameID, err)
		}
		server.finishSession(board, resigned)
	}
	// The gap: every board of the event is over and the next pairings have not
	// been seated. A sweep in here must not take the room with it.
	server.pruneTournamentChats()
	server.autoReadyBotMatches()

	nextRound := liveEventGames(t, server, tournament)
	for _, board := range nextRound {
		if board.chat.id != tournament.TournamentID {
			t.Fatalf("a later match opened a room of its own: %q", board.chat.id)
		}
	}
	_, joined := watchGame(t, server, "second-round-watcher", nextRound[0].gameID)
	if len(joined.ChatMessages) != 1 || joined.ChatMessages[0].Text != "between rounds" {
		t.Fatalf("the event lost what was said before this round: %#v", joined.ChatMessages)
	}
}

// And it is forgotten once the event is over, so the map does not grow for the
// life of the process.
func TestTheRoomOfAFinishedEventIsForgotten(t *testing.T) {
	server, tournament := engineEvent(t, persistence.FieldBots)
	liveEventGames(t, server, tournament)

	server.mu.RLock()
	_, opened := server.tournamentChats[tournament.TournamentID]
	server.mu.RUnlock()
	if !opened {
		t.Fatal("a bots-only event should have opened a room for its matches")
	}

	if _, err := server.data.CancelTournament(
		t.Context(), tournament.TournamentID, "testing",
	); err != nil {
		t.Fatalf("cancel the event: %v", err)
	}
	server.pruneTournamentChats()

	server.mu.RLock()
	_, held := server.tournamentChats[tournament.TournamentID]
	server.mu.RUnlock()
	if held {
		t.Fatal("the room of an event that is over should have been dropped")
	}
}
