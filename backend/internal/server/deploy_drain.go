package server

import (
	"errors"
	"io"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Replacing the binary without taking a game off anybody.
//
// Deploying used to be `systemctl restart`, which is honest about what it does:
// every socket drops, every board on the screen goes away, and the games that
// were being played are archived as Interrupted — a result nobody earned, in
// two people's history, because a new build was ready. That was fine when the
// lobby was empty most of the time. It is not fine now that there are engines
// connected around the clock and a game or two nearly always on the board.
//
// So a deploy is a *drain*, deliberately modelled on the per-bot one next door
// in bot_shutdown.go: stop handing out new games, let the ones already being
// played finish, then go. The two are the same idea at different scales and
// share their vocabulary — a thing that is draining, a list of what it still
// owes, and a settle that fires the moment the list empties.
//
// Three properties are worth stating, because each one is a decision:
//
//   - **It is not SIGTERM.** A signal still means stop now: that is the escape
//     hatch for a server that is wedged, and it is what systemd's
//     TimeoutStopSec is for. A drain is asked for over HTTP, by an
//     administrator, and can be called off.
//   - **It ends by exiting.** When the last game finishes the process stops on
//     its own and systemd's Restart=always brings up whatever binary is on
//     disk — which the deploy script has already replaced. Nothing has to
//     notice the drain finished and go run a command: the gap between the last
//     move and the new build is however long it takes Go to return from main.
//   - **It is on a clock.** A drain that waits forever is a deploy that hangs,
//     and one abandoned game in an untimed mode would be enough. The deadline
//     below stops waiting and shuts down the ordinary way, archiving whatever
//     is left exactly as a restart always did.
//
// What a drain does *not* do is touch the engines. A bot is not told to stop:
// rpsbot.py reconnects on its own when the socket drops, and reconnecting is
// how it picks up the new server. Telling it to exit would leave every bot down
// after a deploy, waiting for its owner to notice.

// updateDrainDeadline is how long a drain waits before giving up and shutting
// down the blunt way. Generous next to a game — the clocks in every mode are
// minutes, not tens of them — and short enough that a deploy is never a thing
// somebody has to go back and check on.
const updateDrainDeadline = 12 * time.Minute

// updateDrainNoticeDefault is what everybody is told when the administrator
// asking for the drain did not say anything themselves.
const updateDrainNoticeDefault = "A new version is on the way."

// serverDrain is the update in progress. One at a time, held on the Server.
type serverDrain struct {
	startedAt time.Time
	deadline  time.Time
	// note is the sentence shown to every connected client, which an
	// administrator may write themselves. See announcements.go for the same
	// idea without a shutdown behind it.
	note string
	// settledAt is when the last commitment cleared. Zero while there is still
	// something to wait for; set once, so the exit fires once.
	settledAt time.Time
}

// ServerUpdateState is a drain as the lobby, the deploy script, and the admin
// screen are all told about it.
//
// One shape for three audiences on purpose. The banner needs the sentence and
// whether anything is left; the script needs the same list to print while it
// waits; and an administrator watching the screen wants exactly what the script
// is seeing. A second shape would be a second thing to keep true.
type ServerUpdateState struct {
	// Updating is false for the ordinary state of the world, which is what
	// makes this message safe to broadcast on every change: a client receiving
	// `updating: false` hides the banner rather than having to be told to.
	Updating bool   `json:"updating"`
	Note     string `json:"note,omitempty"`
	// WaitingOn is every game still being played, phrased for a person reading
	// it. Never omitempty — an empty list is the interesting value, and it is
	// what "the restart is happening now" is made of.
	WaitingOn []string `json:"waitingOn"`
	// Settled says the list emptied and the process is on its way out. Distinct
	// from an empty WaitingOn, which is also true for the instant between the
	// last game ending and the settle running.
	Settled         bool  `json:"settled"`
	StartedAtUnixMs int64 `json:"startedAtUnixMs,omitempty"`
	DeadlineUnixMs  int64 `json:"deadlineUnixMs,omitempty"`
	// GamesRemaining is len(WaitingOn), sent alongside it so a client can show
	// a count without having to hold the list it did not otherwise need.
	GamesRemaining int `json:"gamesRemaining"`
}

// updateDrainFields are the Server's share of all this, embedded rather than
// spread through the main struct so the drain reads as one thing.
type updateDrainFields struct {
	mu    sync.RWMutex
	drain *serverDrain
	// exit is closed exactly once, when a drain settles or runs out of time.
	// main() waits on it beside the signal context, which is what makes
	// "finished draining" and "was asked to stop" the same kind of event.
	exit     chan struct{}
	exitOnce sync.Once
}

// BeginUpdateDrain takes the server out of play. Idempotent: asking twice only
// rewrites the notice, because the deadline is measured from the first ask and
// a retried request should not extend it.
func (server *Server) BeginUpdateDrain(note string) ServerUpdateState {
	note = strings.TrimSpace(note)
	if note == "" {
		note = updateDrainNoticeDefault
	}
	now := time.Now()

	server.update.mu.Lock()
	if server.update.drain == nil {
		server.update.drain = &serverDrain{
			startedAt: now,
			deadline:  now.Add(updateDrainDeadline),
		}
	}
	server.update.drain.note = note
	server.update.mu.Unlock()

	log.Printf("update drain: started — %s", note)

	// A game that was opened and never begun is given up on now rather than in
	// thirty seconds. Nothing is rated and nothing was played, so calling it off
	// costs its two seats nothing but the wait — and waiting out the first-move
	// window on a board neither player ever looked at is half a minute added to
	// every deploy. Reusing the sweep with the clock wound forward keeps one
	// implementation of what calling a match off means.
	server.expireUnstartedGames(now.Add(firstMoveWindow))

	state := server.UpdateDrainState()
	server.broadcastUpdateState(state)
	// An empty lobby should not wait two seconds for the ticker to notice it is
	// empty. This is the whole deploy when nobody is playing.
	server.settleUpdateDrain()
	return state
}

// CancelUpdateDrain puts the server back in play.
//
// The rescue path for a deploy that went wrong before it finished — a build
// that will not install, a change somebody thought better of. Only reachable
// while the drain is still waiting: once it has settled the process is already
// on its way out, and the answer then is that the new binary is starting.
func (server *Server) CancelUpdateDrain() ServerUpdateState {
	server.update.mu.Lock()
	cancelled := server.update.drain != nil && server.update.drain.settledAt.IsZero()
	if cancelled {
		server.update.drain = nil
	}
	server.update.mu.Unlock()
	if !cancelled {
		return server.UpdateDrainState()
	}

	log.Printf("update drain: cancelled")
	state := server.UpdateDrainState()
	server.broadcastUpdateState(state)
	// Two things stopped while the drain was on and neither restarts itself:
	// the board stopped pairing, and every population figure the lobby shows
	// was published with the queue frozen behind it.
	server.broadcastModePlayerCounts()
	return state
}

// isUpdating is the question every path that could open a new game asks, and
// deliberately the only spelling of it. See botIsDraining for the same rule one
// scale down.
func (server *Server) isUpdating() bool {
	server.update.mu.RLock()
	defer server.update.mu.RUnlock()
	return server.update.drain != nil
}

// UpdateDrainState reads the drain and prices up what is left to play.
func (server *Server) UpdateDrainState() ServerUpdateState {
	server.update.mu.RLock()
	drain := server.update.drain
	var startedAt, deadline, settledAt time.Time
	note := ""
	if drain != nil {
		startedAt, deadline, settledAt, note =
			drain.startedAt, drain.deadline, drain.settledAt, drain.note
	}
	server.update.mu.RUnlock()

	if drain == nil {
		return ServerUpdateState{WaitingOn: []string{}}
	}
	waiting := server.updateDrainCommitments()
	state := ServerUpdateState{
		Updating:        true,
		Note:            note,
		WaitingOn:       waiting,
		GamesRemaining:  len(waiting),
		Settled:         !settledAt.IsZero(),
		StartedAtUnixMs: startedAt.UnixMilli(),
		DeadlineUnixMs:  deadline.UnixMilli(),
	}
	return state
}

// updateDrainCommitments is every game the server still owes, in the words the
// deploy script prints and the admin screen shows.
//
// The list is the feature, for the same reason the bot drain's is: "restarting"
// with no explanation is a state somebody stares at wondering whether it is
// stuck, and "waiting on RPSFish vs AltFish, move 23" is the difference between
// waiting and reaching for `systemctl restart` anyway.
//
// Sorted, because it is polled: an unsorted map walk would reshuffle the list
// between two identical reads and make a stable situation look like a busy one.
func (server *Server) updateDrainCommitments() []string {
	// Read before the server lock, never under it — the same ordering
	// broadcastLiveGames uses for the same pair of locks.
	runs := server.runningSeriesNames()

	server.mu.RLock()
	waiting := make([]string, 0, len(server.games))
	seated := make(map[string]bool, len(runs))
	for _, session := range server.games {
		state := session.game.Snapshot()
		line := playerName(state.RedPlayer.Username) + " vs " +
			playerName(state.BluePlayer.Username) +
			" (" + state.Mode.Name + ", move " + strconv.Itoa(state.MoveNumber) + ")"
		if session.botMatch != nil {
			seated[session.botMatch.seriesID] = true
			line += ", game " + strconv.Itoa(session.botMatch.gameNumber) + " of a series"
		}
		waiting = append(waiting, line)
	}
	server.mu.RUnlock()

	// A series between two of its own games is a commitment with nothing on the
	// board to show for it, and it is the one that would otherwise be missed.
	// playNextSeriesGame seats the next game from a goroutine after a pause, so
	// there is a second or two in which the run is still going and `games` is
	// empty — long enough for a settle to fire and this process to exit between
	// the two halves of a pair. Counting the run itself closes that window.
	for seriesID, description := range runs {
		if seated[seriesID] {
			continue
		}
		waiting = append(waiting, description)
	}

	sort.Strings(waiting)
	return waiting
}

// runningSeriesNames describes every bot run still going, keyed by series id.
//
// Names rather than ids, because this is read out loud: the deploy script
// prints it and the admin screen shows it. A bot that has since disconnected
// falls back to its id, which is still better than an empty pair of quotes.
func (server *Server) runningSeriesNames() map[string]string {
	server.botSeriesRuns.mu.Lock()
	pairs := make(map[string][2]string, len(server.botSeriesRuns.series))
	for seriesID, run := range server.botSeriesRuns.series {
		pairs[seriesID] = [2]string{run.firstBot, run.secondBot}
	}
	server.botSeriesRuns.mu.Unlock()

	server.mu.RLock()
	defer server.mu.RUnlock()
	name := func(botID string) string {
		for _, client := range server.bots[botID] {
			client.bot.mu.Lock()
			named := client.bot.record.Name
			client.bot.mu.Unlock()
			if named != "" {
				return named
			}
		}
		return botID
	}
	described := make(map[string]string, len(pairs))
	for seriesID, bots := range pairs {
		described[seriesID] = name(bots[0]) + " vs " + name(bots[1]) +
			" (series, between games)"
	}
	return described
}

// playerName is a fallback for the seat nobody has taken yet, so a commitment
// never prints as " vs Bob".
func playerName(username string) string {
	if strings.TrimSpace(username) == "" {
		return "an empty seat"
	}
	return username
}

// settleUpdateDrain ends the drain when there is nothing left to wait for.
//
// Called from three places, and the redundancy is deliberate: from the lobby
// ticker, which is the backstop; from the end of every finished game, so the
// last game of the day is not followed by up to two seconds of an idle server;
// and from BeginUpdateDrain, which is the whole of a deploy made while the
// lobby is empty.
func (server *Server) settleUpdateDrain() {
	server.update.mu.RLock()
	drain := server.update.drain
	alreadySettled := drain != nil && !drain.settledAt.IsZero()
	deadline := time.Time{}
	if drain != nil {
		deadline = drain.deadline
	}
	server.update.mu.RUnlock()
	if drain == nil || alreadySettled {
		return
	}

	now := time.Now()
	expired := now.After(deadline)
	waiting := server.updateDrainCommitments()
	if len(waiting) > 0 && !expired {
		return
	}

	server.update.mu.Lock()
	// Re-read under the write lock: the ticker and a finishing game can both
	// arrive here, and the notice below should be sent once.
	if server.update.drain == nil || !server.update.drain.settledAt.IsZero() {
		server.update.mu.Unlock()
		return
	}
	server.update.drain.settledAt = now
	server.update.mu.Unlock()

	if expired && len(waiting) > 0 {
		// Said loudly, because it is the one path that costs somebody a game:
		// what is still on the board is about to be archived unfinished.
		log.Printf(
			"update drain: deadline passed with %d game(s) still playing; restarting anyway",
			len(waiting),
		)
	} else {
		log.Printf("update drain: nothing left to play; restarting")
	}

	server.broadcastUpdateState(server.UpdateDrainState())
	// A beat for that last broadcast to reach the sockets it was written to.
	// Without it the banner that explains the disconnection races the
	// disconnection, and whoever was watching sees the tab drop with no reason
	// given. Off the caller's goroutine, because one of the callers is the
	// 100ms clock ticker by way of a finished game.
	go func() {
		time.Sleep(updateSettleGrace)
		server.update.exitOnce.Do(func() { close(server.update.exit) })
	}()
}

// updateSettleGrace is how long the last banner gets to reach the clients
// before the process stops. Long enough for a write already queued on a socket
// to go out, short enough that it is not a delay anybody perceives.
const updateSettleGrace = 400 * time.Millisecond

// UpdateFinished is closed when a drain has run its course. main() selects on
// it beside the signal context: both mean the same thing by the time they fire,
// which is that this process is done.
func (server *Server) UpdateFinished() <-chan struct{} {
	return server.update.exit
}

// broadcastUpdateState tells the lobby where the drain stands.
//
// People only. An engine has no banner to put this on, and the buffer that
// protects a bot mid-search is the one thing a drain must not overrun — the
// game it would drop is precisely the game the drain is waiting for. See
// broadcastToClients, whose whole point this is. An owner who wants to know is
// told through the announcement channel instead, which is one message and
// deliberately does reach engines.
func (server *Server) broadcastUpdateState(state ServerUpdateState) {
	server.broadcastToClients(ServerMessage{Type: "server_update", Update: &state})
}

// updateRefusalMessage is what somebody trying to start a game during a drain is
// told. One sentence, and it says what to do about it, because "unavailable"
// with no horizon reads as broken.
func (server *Server) updateRefusalMessage() string {
	server.update.mu.RLock()
	note := ""
	if server.update.drain != nil {
		note = server.update.drain.note
	}
	server.update.mu.RUnlock()
	if note == "" {
		note = updateDrainNoticeDefault
	}
	return note + " New games are paused for a moment while the games already " +
		"being played finish. This page will reconnect on its own."
}

/* --------------------------------------------------------------- routes -- */

// updateDrainRequest is the body of a drain request. Both fields are optional:
// an empty POST is a deploy with nothing to say about itself.
type updateDrainRequest struct {
	// Note is the sentence shown in the banner. Write it for the player, not
	// for the changelog: "Back in about a minute" beats a version number.
	Note string `json:"note"`
}

// beginUpdateDrain is POST /api/admin/drain.
func (server *Server) beginUpdateDrain(writer http.ResponseWriter, request *http.Request) {
	var input updateDrainRequest
	// An empty body is a drain with the default notice. Read rather than
	// inferred from Content-Length, for the reason spelled out on shutdownBot:
	// a proxy that re-frames the request as chunked reports no length at all.
	if err := decodeAPIRequest(writer, request, &input); err != nil &&
		!errors.Is(err, io.EOF) {
		writeAPIError(writer, http.StatusBadRequest, err.Error())
		return
	}
	if utf8Length(input.Note) > maximumNoticeRunes {
		writeAPIError(writer, http.StatusBadRequest,
			"the notice must be "+strconv.Itoa(maximumNoticeRunes)+" characters or fewer")
		return
	}
	writeJSON(writer, http.StatusOK, server.BeginUpdateDrain(input.Note))
}

// cancelUpdateDrain is DELETE /api/admin/drain.
func (server *Server) cancelUpdateDrain(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, server.CancelUpdateDrain())
}

// getUpdateDrain is GET /api/admin/drain, which is what the deploy script
// polls while it waits.
func (server *Server) getUpdateDrain(writer http.ResponseWriter, _ *http.Request) {
	writeJSON(writer, http.StatusOK, server.UpdateDrainState())
}

// DrainedCleanly says the drain reached the end of its list rather than the end
// of its clock. main() logs the difference: a clean drain leaves nothing to
// archive, and one that timed out is the only case where a restart still costs
// somebody an unfinished game.
func (server *Server) DrainedCleanly() bool {
	server.update.mu.RLock()
	defer server.update.mu.RUnlock()
	return server.update.drain != nil && !server.update.drain.settledAt.IsZero()
}
