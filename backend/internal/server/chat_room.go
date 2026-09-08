package server

// chatRoom is a conversation, which is not the same thing as a game. A
// standalone game has a room of its own and the two end together; every game
// of a bot series shares one room, so a run is one conversation rather than a
// new one each time two engines sit down, and every match of a bots-only
// tournament shares one, so an event is one crowd rather than one per board.
//
// The alternative — copying a finished game's transcript into the next game —
// produces two rooms that both look like the series chat and cannot hear each
// other: whatever is said in the old one after the copy is taken is lost, and
// the people who have not moved on yet are talking to nobody.
//
// Every field is guarded by Server.mu, like the session fields that point here.
type chatRoom struct {
	// id names the conversation on the wire. For a standalone game it is the
	// game id, so a client that only knows about games still sees what it
	// expects; for a series it is the series id, and for a bots-only event the
	// tournament id.
	id string
	// scope is what kind of thing the room covers, sent alongside the id so a
	// client can name the conversation it is showing. Set once and never
	// changed: a room that spans a run, or an event, does so from its first
	// message.
	scope    ChatScope
	messages []ChatMessage
	// sessions are the games pointing at this room right now: the one being
	// played, and any finished one whose post-game room somebody is still
	// sitting in. Messages go to all of them, which is what keeps a series
	// changeover from splitting the audience in two.
	sessions map[*GameSession]struct{}
}

// ChatScope is how much of the site one conversation covers.
//
// A client needs this to say what it is showing. The room id alone cannot: a
// room that is not the game on screen is either a run or an event, and "SERIES
// CHAT" over a tournament match is the sort of wrong that makes a reader
// distrust the rest of the page.
type ChatScope string

const (
	// ChatScopeGame is one game and the room that outlives it, which is nearly
	// every conversation on the site.
	ChatScopeGame ChatScope = "game"
	// ChatScopeSeries is every game of one bot-versus-bot run.
	ChatScopeSeries ChatScope = "series"
	// ChatScopeTournament is every match of one bots-only event, played at the
	// same time as each other rather than one after another.
	ChatScopeTournament ChatScope = "tournament"
)

func newChatRoom(id string) *chatRoom {
	return newScopedChatRoom(id, ChatScopeGame)
}

// newScopedChatRoom opens a conversation that outlasts any one game.
func newScopedChatRoom(id string, scope ChatScope) *chatRoom {
	return &chatRoom{id: id, scope: scope, sessions: make(map[*GameSession]struct{})}
}

// join adds a game to the conversation. Called under Server.mu.
func (room *chatRoom) join(session *GameSession) {
	if room.sessions == nil {
		room.sessions = make(map[*GameSession]struct{})
	}
	room.sessions[session] = struct{}{}
}

// leave drops a game nobody is in any more. The room itself survives: a series
// keeps a reference to it between games, when no game points here at all.
// Called under Server.mu.
func (room *chatRoom) leave(session *GameSession) {
	delete(room.sessions, session)
}

// append records a message and trims the history to its ceiling. Called under
// Server.mu.
func (room *chatRoom) append(message ChatMessage) {
	room.messages = append(room.messages, message)
	if len(room.messages) > maximumChatHistory {
		room.messages = append(
			[]ChatMessage(nil),
			room.messages[len(room.messages)-maximumChatHistory:]...,
		)
	}
}

// history copies the conversation out. Called under Server.mu.
func (room *chatRoom) history() []ChatMessage {
	return append([]ChatMessage(nil), room.messages...)
}

// audience is everyone who should hear a message, across every game in the
// room and without repeating anybody who is in more than one seat. Bots are
// left out: they are sent RPSI lines, not chat. Called under Server.mu.
func (room *chatRoom) audience() []*Client {
	listeners := make([]*Client, 0, len(room.sessions)*3)
	seen := make(map[*Client]struct{}, len(room.sessions)*3)
	add := func(client *Client) {
		if client == nil || client.isBot() {
			return
		}
		if _, already := seen[client]; already {
			return
		}
		seen[client] = struct{}{}
		listeners = append(listeners, client)
	}
	for session := range room.sessions {
		add(session.redClient)
		add(session.blueClient)
		for spectator := range session.spectators {
			add(spectator)
		}
	}
	return listeners
}

// occupancy is how many people are in the conversation right now: everyone the
// next message would be delivered to, counted the same way it is addressed. A
// finished game keeps a count because the room does — it is the audience that
// is being counted, not the board. Called under Server.mu.
func (room *chatRoom) occupancy() int {
	return len(room.audience())
}
