package server

import (
	"context"
	"errors"
	"io"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"

	"rps-strategy/backend/internal/persistence"
)

// Taking an engine out of play without ending the game it is in.
//
// Stopping a bot used to mean killing the process, and killing the process
// abandons whatever is on the board: a loss for the engine, a spoiled game for
// whoever was playing it, and an abandonment on the record that nobody meant.
// So the way to retire a build was to ask on Discord for people to stop
// challenging it, wait for the lobby to notice, and then pull the plug. This is
// that ask, made mechanical — the bot stops being offered new games and plays
// out the ones it already owes.
//
// A drain is *connection state*, deliberately, and never a column in the
// registry. "No more games until it reboots" is exactly the life of one socket:
// rpsbot.py restarts the engine subprocess on every reconnect, so a reconnected
// bot is a rebooted bot and is back in the pool. Storing the flag would mean an
// owner who drained a bot in September finds it silently refusing games in
// October, with nothing on screen to say why.

// botDrain is a graceful shutdown in progress on one connection.
type botDrain struct {
	// exitWhenDone tells the client to stop once the last commitment is
	// settled. False is a pause: the bot stays connected and idle, which is
	// what an owner wants when the machine is busy rather than going away, and
	// what an owner wants when something else — systemd, a container runtime —
	// owns the decision to restart the process.
	exitWhenDone bool
	// source is what asked, in the words the owner reads. "the website", "the
	// engine", "the client" — enough to tell a button press from an engine that
	// decided for itself.
	source      string
	requestedAt time.Time
	// settled marks a drain whose commitments have all finished, so the
	// finishing notice is sent once rather than on every lobby tick.
	settled bool
}

// BotDrainState is a drain as the owner's page and the bot's own client are
// told about it.
type BotDrainState struct {
	Draining     bool   `json:"draining"`
	ExitWhenDone bool   `json:"exitWhenDone"`
	Source       string `json:"source,omitempty"`
	// WaitingOn is every commitment still outstanding, each phrased for a
	// person reading it. Empty on a drain that has settled, which is what makes
	// "nothing left — safe to stop" a state the page can show rather than
	// infer.
	//
	// Never omitempty: an empty list is the interesting value here, and a
	// client that saw no field could not tell "settled" from "old server".
	WaitingOn         []string `json:"waitingOn"`
	RequestedAtUnixMs int64    `json:"requestedAtUnixMs,omitempty"`
}

// requestBotShutdown puts a connected engine into a drain, or updates the one
// it is already in.
//
// Idempotent by design, because three different things can ask for it — the
// website, the engine, a signal on the owner's machine — and two of them
// arriving together is a coincidence rather than an error. A second request
// only ever moves a pause to a shutdown, never the other way: an owner who has
// said "stop when you are done" should not have that downgraded by an engine
// that also asked to be paused.
func (server *Server) requestBotShutdown(
	client *Client,
	exitWhenDone bool,
	source string,
) BotDrainState {
	if !client.isBot() {
		return BotDrainState{WaitingOn: []string{}}
	}
	// Every slot of the bot, not the one that asked. An engine allowed three
	// games at once holds three sockets, and "stop taking new games" is a thing
	// the bot does rather than a thing one of its sockets does: draining the
	// slot that printed `shutdown` and leaving the other two in the lobby is
	// the shutdown not happening.
	changed := false
	for _, connection := range server.botDrainTargets(client) {
		connection.bot.mu.Lock()
		existing := connection.bot.drain
		// Nothing left to change, and saying so early matters: an engine that
		// prints `shutdown` on every search would otherwise re-read every
		// tournament and re-broadcast the roster once a move. The one request
		// that gets past this is a pause being upgraded to a shutdown — never
		// the reverse, because an owner who has said "stop when you are done"
		// should not have that undone by an engine that also asked to be paused.
		if existing != nil && (existing.exitWhenDone || !exitWhenDone) {
			connection.bot.mu.Unlock()
			continue
		}
		if existing == nil {
			connection.bot.drain = &botDrain{requestedAt: time.Now()}
		}
		connection.bot.drain.exitWhenDone = connection.bot.drain.exitWhenDone || exitWhenDone
		connection.bot.drain.source = source
		// Reaching here past the check above means this is a pause being
		// upgraded to a shutdown, and a pause on an idle bot has already
		// settled. Without clearing that, the settle below finds its own
		// finished-with mark and the client is never told to stop.
		connection.bot.drain.settled = false
		connection.bot.mu.Unlock()
		changed = true
	}
	if !changed {
		return server.botDrainState(client)
	}

	// Before anything is reported: an event nobody has played yet loses nothing
	// by this bot leaving it, and staying in one would be a commitment the
	// drain then had to wait on.
	server.withdrawDrainingBotFromUnstartedTournaments(client)

	state := server.botDrainState(client)
	for _, connection := range server.botDrainTargets(client) {
		connection.Send(ServerMessage{
			Type:    "bot_draining",
			Message: botDrainNotice(state),
			Drain:   &state,
		})
	}
	server.notifyBotOwnerOfDrain(client, state)
	// The lobby has to stop offering this engine straight away, not on the next
	// broadcast something else happens to trigger.
	server.broadcastBots()
	// An idle bot is finished the moment it is asked, and should not wait a
	// tick of the lobby timer to be told so.
	server.settleBotShutdown(client)
	return state
}

// cancelBotShutdown puts a drained or draining bot back in the pool.
//
// Only reachable while the connection is still up, which is the whole of its
// scope: once a shutdown has told the client to stop there is nothing left to
// cancel, and the answer is to start the bot again.
func (server *Server) cancelBotShutdown(client *Client) BotDrainState {
	if !client.isBot() {
		return BotDrainState{WaitingOn: []string{}}
	}
	targets := server.botDrainTargets(client)
	cancelled := false
	for _, connection := range targets {
		connection.bot.mu.Lock()
		cancelled = cancelled || connection.bot.drain != nil
		connection.bot.drain = nil
		connection.bot.mu.Unlock()
	}
	if !cancelled {
		return BotDrainState{WaitingOn: []string{}}
	}

	state := BotDrainState{WaitingOn: []string{}}
	for _, connection := range targets {
		connection.Send(ServerMessage{
			Type:    "bot_draining",
			Message: "back in play: this bot is accepting games again",
			Drain:   &state,
		})
	}
	server.notifyBotOwnerOfDrain(client, state)
	server.broadcastBots()
	return state
}

// botDrainTargets is every socket a drain has to reach: all of the bot's slots,
// or the connection itself when it is no longer in the directory — a bot that
// has just gone offline is still allowed to be told what happened to it.
func (server *Server) botDrainTargets(client *Client) []*Client {
	if !client.isBot() {
		return nil
	}
	connections := server.botConnections(client.bot.botID)
	for _, connection := range connections {
		if connection == client {
			return connections
		}
	}
	return append(connections, client)
}

// botIsDraining is the question every path that could hand an engine a new game
// asks. Cheap, and deliberately the only shape of that question in the server:
// a second spelling is how one of those paths gets missed.
//
// Two things make it true, and the scheduled bench in bot_bench.go is here
// rather than beside each offer because of the sentence above: a bench that
// asked its own question would have to be remembered at every one of those
// sites, and the one that got missed would be the one that handed out a game
// during the tournament everything was stood down for.
func botIsDraining(client *Client) bool {
	if client == nil || !client.isBot() {
		return false
	}
	// Through the client's own server, because the schedule is per-server
	// state now rather than a package-level slice. Nil only in tests that build
	// a bare Client, and a connection with no server has no game to be offered.
	if client.server.botsAreBenched(time.Now()) {
		return true
	}
	return botHasOwnDrain(client)
}

// botHasOwnDrain is the narrower question: has *this* engine been asked to
// stop, by its owner or by itself.
//
// The difference from botIsDraining matters wherever the answer is shown rather
// than enforced. An owner looking at their bots during a bench has not asked
// for anything and must not be shown a shutdown they did not start, and a
// settle has nothing to settle for a drain that does not exist.
func botHasOwnDrain(client *Client) bool {
	if client == nil || !client.isBot() {
		return false
	}
	client.bot.mu.Lock()
	defer client.bot.mu.Unlock()
	return client.bot.drain != nil
}

// botDrainState reads the drain and prices up what is left to do.
func (server *Server) botDrainState(client *Client) BotDrainState {
	if !client.isBot() {
		return BotDrainState{WaitingOn: []string{}}
	}
	client.bot.mu.Lock()
	drain := client.bot.drain
	record := client.bot.record
	client.bot.mu.Unlock()
	if drain == nil {
		return BotDrainState{WaitingOn: []string{}}
	}
	return BotDrainState{
		Draining:          true,
		ExitWhenDone:      drain.exitWhenDone,
		Source:            drain.source,
		WaitingOn:         server.botShutdownCommitments(client, record),
		RequestedAtUnixMs: drain.requestedAt.UnixMilli(),
	}
}

// botShutdownCommitments is everything a draining engine still owes, in the
// words the owner's page prints.
//
// The list is the feature. "Shutting down" with no explanation is the state an
// owner stares at wondering whether it is stuck, and the answer — a game on the
// board, a pair to finish, four tournament matches still to play — is the
// difference between waiting and pulling the plug anyway.
func (server *Server) botShutdownCommitments(
	client *Client,
	record persistence.Bot,
) []string {
	waiting := make([]string, 0, 3)
	// Counted rather than asked as a yes-or-no, because a bot with several
	// slots can be finishing three games at once, and "finishing the game it is
	// playing" would have its owner waiting on a list that never shortens for
	// two of them.
	playing := server.botActiveGames(client.bot.botID)
	if playing == 0 && server.participantFor(client) != nil {
		// A connection that has already left the directory, being told what it
		// still owes. See botDrainTargets.
		playing = 1
	}
	switch {
	case playing == 1:
		waiting = append(waiting, "finishing the game it is playing")
	case playing > 1:
		waiting = append(waiting,
			"finishing the "+strconv.Itoa(playing)+" games it is playing")
	}
	if server.botSeriesForBot(client.bot.botID) != nil {
		waiting = append(waiting, "finishing the current pair of a series")
	}
	waiting = append(waiting, server.botTournamentCommitments(record.UserID)...)
	return waiting
}

// botTournamentCommitments is the matches a bot still owes to events that have
// started.
//
// An event is the one thing a drain waits out rather than bows out of. A round
// robin is built around every entrant being there; a bot that leaves halfway
// does not just forfeit its own remaining games, it takes the meaning out of
// everybody else's, because the standings are then over a schedule that was
// never played. Tournaments that have not started are not here at all — the
// drain withdrew from those, which costs nobody anything.
func (server *Server) botTournamentCommitments(userID string) []string {
	if userID == "" {
		return nil
	}
	tournaments, err := server.data.Tournaments(context.Background())
	if err != nil {
		// Reported as no commitments rather than as an unknown number of them.
		// The alternative is a drain that never settles because SQLite was
		// briefly busy, which is a worse failure than one that settles early.
		log.Printf("bot drain: read tournaments: %v", err)
		return nil
	}
	waiting := make([]string, 0, 1)
	for _, tournament := range tournaments {
		if tournament.Status != persistence.TournamentInProgress {
			continue
		}
		pending := 0
		for _, match := range tournament.Matches {
			if match.Result != persistence.MatchPending {
				continue
			}
			if match.Player1.UserID == userID || match.Player2.UserID == userID {
				pending++
			}
		}
		if pending == 0 {
			continue
		}
		noun := " matches left in "
		if pending == 1 {
			noun = " match left in "
		}
		waiting = append(waiting, strconv.Itoa(pending)+noun+tournament.Name)
	}
	return waiting
}

// withdrawDrainingBotFromUnstartedTournaments takes a draining bot out of every
// event that has not begun.
//
// Nothing has been played and no pairings exist yet, so leaving is free — and
// the alternative is ugly in both directions: wait for a tournament that might
// never start, or stay enrolled and be absent for a round robin built around
// being present.
func (server *Server) withdrawDrainingBotFromUnstartedTournaments(client *Client) {
	client.bot.mu.Lock()
	userID := client.bot.record.UserID
	client.bot.mu.Unlock()
	if userID == "" {
		return
	}

	ctx := context.Background()
	tournaments, err := server.data.Tournaments(ctx)
	if err != nil {
		log.Printf("bot drain: read tournaments: %v", err)
		return
	}
	withdrawn := false
	for _, tournament := range tournaments {
		if tournament.Status != persistence.TournamentRegistration {
			continue
		}
		removed, err := server.data.WithdrawFromTournament(ctx, tournament.TournamentID, userID)
		if err != nil {
			log.Printf("bot drain: withdraw from %s: %v", tournament.TournamentID, err)
			continue
		}
		withdrawn = withdrawn || removed
	}
	if withdrawn {
		server.broadcastTournaments()
	}
}

// settleBotShutdowns finishes off every drain whose commitments have run out.
//
// On the existing lobby ticker rather than a timer of its own, for the same
// reason autoReadyBotMatches is: two seconds of latency on a bot that has just
// finished its last game is nothing, and a second scheduler is a second thing
// to reason about.
func (server *Server) settleBotShutdowns() {
	for _, client := range server.allBotConnections() {
		// The bot's own drain, not botIsDraining: a bench stands every engine
		// down without any of them having asked for anything, and there is
		// nothing to settle for a drain nobody started.
		if botHasOwnDrain(client) {
			server.settleBotShutdown(client)
		}
	}
}

// settleBotShutdown checks one draining bot and, if it owes nothing, ends it.
func (server *Server) settleBotShutdown(client *Client) {
	state := server.botDrainState(client)
	if !state.Draining || len(state.WaitingOn) > 0 {
		return
	}

	// Every slot, and only the ones that have not already been told. The
	// commitments above are the bot's, so they run out for all of its sockets
	// at the same moment; each one still has to hear about it, because each is
	// a thread of rpsbot.py waiting to be released.
	type settled struct {
		connection *Client
		exit       bool
		name       string
	}
	settling := make([]settled, 0, 1)
	for _, connection := range server.botDrainTargets(client) {
		connection.bot.mu.Lock()
		drain := connection.bot.drain
		if drain == nil || drain.settled {
			connection.bot.mu.Unlock()
			continue
		}
		drain.settled = true
		settling = append(settling, settled{
			connection: connection,
			exit:       drain.exitWhenDone,
			name:       connection.bot.record.Name,
		})
		connection.bot.mu.Unlock()
	}
	if len(settling) == 0 {
		return
	}

	server.notifyBotOwnerOfDrain(client, state)
	for _, finished := range settling {
		connection, exit, name := finished.connection, finished.exit, finished.name

		if !exit {
			connection.Send(ServerMessage{
				Type: "bot_draining",
				Message: "paused: " + name + " has finished everything it owed" +
					" and is accepting no new games",
				Drain: &state,
			})
			continue
		}

		// Every client that can connect understands bot_shutdown: the minimum
		// version is past the one that added it, which is what let the older
		// spelling — bot_rejected, carrying a sentence about a shutdown — go.
		connection.Send(ServerMessage{
			Type:    "bot_shutdown",
			Message: name + " has finished everything it owed. Shutting down.",
			Drain:   &state,
		})
		// The client closes its own socket on that message. Closing from here
		// as well would race the write it has not read yet.
	}
}

// notifyBotOwnerOfDrain keeps the owner's open pages current.
//
// The Bots page learns about this from the roster broadcast, but the account
// page is a list of HTTP resources and has nothing to re-read on its own. This
// is what lets it show a drain settling without polling for it.
func (server *Server) notifyBotOwnerOfDrain(client *Client, state BotDrainState) {
	client.bot.mu.Lock()
	owner := client.bot.record.OwnerUserID
	name := client.bot.record.Name
	botID := client.bot.record.BotID
	client.bot.mu.Unlock()
	if owner == "" {
		return
	}

	message := ServerMessage{
		Type:    "bot_drain_update",
		BotName: name,
		BotID:   botID,
		Drain:   &state,
	}
	for _, candidate := range server.connectedClients() {
		if !candidate.isBot() && candidate.profile.UserID == owner {
			candidate.Send(message)
		}
	}
}

// botDrainNotice is the single line the client prints when a drain begins.
func botDrainNotice(state BotDrainState) string {
	verb := "pausing"
	if state.ExitWhenDone {
		verb = "shutting down"
	}
	if len(state.WaitingOn) == 0 {
		return verb + ": nothing left to finish"
	}
	notice := verb + " after: " + state.WaitingOn[0]
	for _, extra := range state.WaitingOn[1:] {
		notice += ", " + extra
	}
	return notice
}

// shutdownBotRequest is the body of a drain request from the website.
type shutdownBotRequest struct {
	// Exit stops the client once the last commitment is settled. False is a
	// pause: the engine stays connected and idle until its owner restarts it or
	// cancels the drain. Both are the same drain — this only decides what
	// happens at the end of it.
	Exit bool `json:"exit"`
}

// shutdownBot starts or updates a drain from the website.
//
// Owner or administrator, which requireBotOwner already resolves. An
// administrator draining somebody else's engine is the polite version of the
// thing they can already do — disabling the account or deleting the bot — and
// is the one that does not cost the game on the board.
func (server *Server) shutdownBot(writer http.ResponseWriter, request *http.Request) {
	bot, ok := server.requireBotOwner(writer, request)
	if !ok {
		return
	}
	var input shutdownBotRequest
	// An empty body is a pause, which is the recoverable half of the pair.
	//
	// Read rather than inferred from Content-Length. A body whose length the
	// sender did not declare — anything re-framed as chunked on the way in — has
	// a ContentLength of -1, and taking that for "no body" answers "stop when
	// you are done" with a pause: the engine finishes the game it owed and then
	// sits there connected and idle, waiting for nothing, having been told to
	// leave. Silent, and only on the deployment with a proxy in front of it.
	if err := decodeAPIRequest(writer, request, &input); err != nil &&
		!errors.Is(err, io.EOF) {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}

	client := server.botConnection(bot.BotID)
	if client == nil {
		// Not an error the caller can act on by retrying, and not a failure
		// either: a bot that is not connected is already accepting no games.
		// Saying so plainly beats a 404 that reads like the bot is unknown.
		writeJSON(writer, http.StatusOK, botShutdownReply{
			Online: false,
			Drain:  BotDrainState{WaitingOn: []string{}},
		})
		return
	}
	writeJSON(writer, http.StatusOK, botShutdownReply{
		Online: true,
		Drain:  server.requestBotShutdown(client, input.Exit, "the website"),
	})
}

// resumeBot cancels a drain, putting the engine back in the pool.
func (server *Server) resumeBot(writer http.ResponseWriter, request *http.Request) {
	bot, ok := server.requireBotOwner(writer, request)
	if !ok {
		return
	}
	client := server.botConnection(bot.BotID)
	if client == nil {
		writeJSON(writer, http.StatusOK, botShutdownReply{
			Online: false,
			Drain:  BotDrainState{WaitingOn: []string{}},
		})
		return
	}
	writeJSON(writer, http.StatusOK, botShutdownReply{
		Online: true,
		Drain:  server.cancelBotShutdown(client),
	})
}

// botShutdownReply is what both routes answer with.
type botShutdownReply struct {
	// Online is false for a bot nobody is running, whose drain state is
	// therefore the empty one. The page says "not connected" rather than
	// showing a shutdown that is not happening.
	Online bool          `json:"online"`
	Drain  BotDrainState `json:"drain"`
}

// handleBotDrainRequest is a drain asked for from the far end of the socket.
//
// Two things reach here and they are deliberately one message. An engine can
// print `shutdown` on its own stdout — it knows things the website does not,
// like that its host is about to be reclaimed — and rpsbot.py turns a first
// Ctrl-C or a SIGTERM into the same request, which is what makes `systemctl
// stop` something other than an abandonment. Neither can do anything an owner
// could not do from the website; both save them being at a browser to do it.
func (server *Server) handleBotDrainRequest(client *Client, message ClientMessage) {
	if !client.isBot() {
		return
	}
	source := "the client"
	if reason := strings.TrimSpace(message.Reason); reason != "" {
		source = reason
	}
	server.requestBotShutdown(client, message.Exit, source)
}
