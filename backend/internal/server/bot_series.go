package server

import (
	"context"
	"errors"
	"log"
	"strconv"
	"strings"
	"sync"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/notation"
	"rps-strategy/backend/internal/persistence"
)

// A bot series: two engines, N games, paired openings, one at a time.
//
// Sequential is a deliberate choice, not a simplification. It keeps the client
// down to one engine subprocess, and it means the games are watchable — the
// point of running a series on the live server rather than in the offline
// arena is that people can see it happen.
//
// Fairness comes from pairing. Each opening is played twice with the colours
// swapped, which cancels both the opening's own bias and whatever the first
// move is worth. The paired game replays the *identical* move list from the
// identical board; only the seats change. Reaching for a board mirror instead
// is the easy mistake, and it would measure something else.

const (
	// botSeriesDelay lets a finished game settle before the next one starts.
	// Zero would work, but the result card and the lobby update would race the
	// new game onto the screen.
	botSeriesDelay = 750 * time.Millisecond
	// botSeriesMaxPairs bounds an admin's typo. Sequential games at a real
	// time control take minutes each.
	botSeriesMaxPairs = 100
	// botSeriesMaxOpeningPlies keeps the "opening" an opening rather than most
	// of a game somebody else played.
	botSeriesMaxOpeningPlies = 20
)

// What a visitor may commit two other people's engines to.
//
// Starting a series is no longer an administrator's command, which is the point
// of these numbers: the person who presses the button is spending somebody
// else's CPU and holding two bots out of every other game on the server for as
// long as the run lasts. The consent for that is the bot's own public-play
// switch — the same switch that decides whether a stranger may challenge it —
// and these ceilings are what keep an act of consent from becoming an open tab.
//
// An administrator is exempt, because the offline arena's job is long runs and
// the host is the person who owns the hardware.
const (
	// publicSeriesMaxPairs is six games, which is long enough for the result to
	// mean something and short enough to be over while somebody watches it.
	publicSeriesMaxPairs = 3
	// publicSeriesMaxInitialMs and publicSeriesMaxIncrementMs bound the clock.
	// Six games at ten minutes each is a couple of hours of two engines' time
	// in the worst case. That is a lot, but it is the clock at which a result
	// between two strong engines means anything, and publicSeriesConcurrent
	// already bounds how many of these can be running at once.
	publicSeriesMaxInitialMs   = 10 * 60 * 1000
	publicSeriesMaxIncrementMs = 5000
	// publicSeriesConcurrent caps visitor-started runs across the whole server.
	// Series games are sequential and every one of them is a real game in the
	// lobby, so an unbounded number of them would crowd out the people playing.
	publicSeriesConcurrent = 2
)

// botMatchRef links a live game back to the series it belongs to.
type botMatchRef struct {
	seriesID   string
	gameNumber int
}

// botSeries is the run state the database does not need to hold.
type botSeries struct {
	// step guards advancing to the next game. Always used through a pointer,
	// so an embedded mutex is safe and needs no side table.
	step      sync.Mutex
	seriesID  string
	modeID    game.ModeID
	control   game.TimeControl
	firstBot  string // bot id
	secondBot string
	// requestedBy is the account that asked for this run, and privileged says
	// whether they asked as an administrator. Both are held here rather than
	// read back from the database because they are consulted on the two hot
	// paths — the concurrency ceiling on every new request, and the permission
	// check on an abort — and neither wants a query.
	requestedBy string
	privileged  bool
	pairs       int
	plies       int
	seed        uint64
	gameNumber  int
	// openings is one move list per pair, built up as pairs begin so that a
	// swapped rematch replays exactly what its partner did.
	openings map[int][]game.Move
	// openingSeeds records which seed produced each pair's opening, since a
	// rejected walk means the seed used is not always the one asked for.
	openingSeeds map[int]uint64
	// advancing guards the step to the next game. finishSession can be reached
	// from the clock ticker and from a move at the same moment, and starting
	// game N+1 twice would seat both engines twice.
	advancing bool
	aborted   bool
	// firstWins, secondWins and draws are the run's own tally, always from the
	// first bot's point of view. The database holds the same numbers; this copy
	// exists so the lobby can put a score on every row of a broadcast without a
	// query per row.
	firstWins  int
	secondWins int
	draws      int
	// counted records which games have already moved the tally. The database
	// guards itself against a repeated result by only counting a row that is
	// still pending; this guards the in-memory copy against the same double
	// callback.
	counted map[int]bool
	// chat is the run's conversation. A series is watched as one thing, so it
	// is one room: every game joins this rather than opening its own, and the
	// run holds it through the pause between games, when no game does. Set
	// once here and never reassigned, so it is read without run.step; what is
	// inside it is guarded by the server lock, like every other room.
	chat *chatRoom
}

// summaries snapshots every running series for the lobby.
//
// Called before the server lock is taken rather than under it. Nothing in the
// server acquires the runner's lock while holding server.mu today, and keeping
// the two apart is cheaper than having to keep checking that.
func (runner *botSeriesRunner) summaries() map[string]LiveGameSeries {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	summaries := make(map[string]LiveGameSeries, len(runner.series))
	for seriesID, run := range runner.series {
		run.step.Lock()
		summaries[seriesID] = LiveGameSeries{
			SeriesID:   seriesID,
			TotalGames: run.pairs * 2,
			FirstWins:  run.firstWins,
			SecondWins: run.secondWins,
			Draws:      run.draws,
		}
		run.step.Unlock()
	}
	return summaries
}

type botSeriesRunner struct {
	mu     sync.Mutex
	series map[string]*botSeries
}

func newBotSeriesRunner() *botSeriesRunner {
	return &botSeriesRunner{series: make(map[string]*botSeries)}
}

// BotSeriesRequest is one asked-for run.
//
// A struct rather than eight positional arguments, and not only for length: the
// last two fields are about the *caller* rather than the run, and passing those
// as a trailing `string, bool` would be the kind of call nobody can read at the
// site. Every route that starts a series fills this in, which is also what makes
// the public and administrative paths obviously the same path.
type BotSeriesRequest struct {
	FirstBotID   string
	SecondBotID  string
	ModeID       game.ModeID
	Pairs        int
	OpeningPlies int
	Seed         uint64
	Control      game.TimeControl
	// RequestedBy is the account asking. Empty only for the host token, which is
	// a secret rather than a person.
	RequestedBy string
	// Privileged lifts the public ceilings and the public-play requirement. True
	// for an administrator, and for nobody else.
	Privileged bool
}

// StartBotSeries sets up a run and plays its first game.
func (server *Server) StartBotSeries(
	ctx context.Context,
	ask BotSeriesRequest,
) (persistence.BotSeries, error) {
	if ask.FirstBotID == ask.SecondBotID {
		return persistence.BotSeries{}, errSeriesSameBot
	}
	if ask.Pairs < 1 || ask.Pairs > botSeriesMaxPairs {
		return persistence.BotSeries{}, errSeriesPairCount
	}
	if ask.OpeningPlies < 0 || ask.OpeningPlies > botSeriesMaxOpeningPlies {
		return persistence.BotSeries{}, errSeriesOpeningPlies
	}
	if !server.registry.Has(ask.ModeID) || !server.registry.Playable(ask.ModeID) {
		return persistence.BotSeries{}, errSeriesMode
	}
	if err := ask.Control.Validate(); err != nil {
		return persistence.BotSeries{}, err
	}
	if !ask.Privileged {
		if ask.Pairs > publicSeriesMaxPairs {
			return persistence.BotSeries{}, errSeriesPublicPairs
		}
		if ask.Control.InitialTimeMs > publicSeriesMaxInitialMs ||
			ask.Control.IncrementMs > publicSeriesMaxIncrementMs {
			return persistence.BotSeries{}, errSeriesPublicClock
		}
	}

	first, second := server.readyBot(ask.FirstBotID), server.readyBot(ask.SecondBotID)
	if first == nil || second == nil {
		return persistence.BotSeries{}, errSeriesBotOffline
	}
	if server.participantFor(first) != nil || server.participantFor(second) != nil {
		return persistence.BotSeries{}, errSeriesBotBusy
	}
	if botIsDraining(first) || botIsDraining(second) {
		return persistence.BotSeries{}, errSeriesBotDraining
	}
	if !ask.Privileged &&
		(!openToPublicSeries(first, ask.RequestedBy) ||
			!openToPublicSeries(second, ask.RequestedBy)) {
		return persistence.BotSeries{}, errSeriesBotPrivate
	}

	seriesID, err := randomID()
	if err != nil {
		return persistence.BotSeries{}, err
	}
	seed := ask.Seed
	if seed == 0 {
		// Seeds are stored in a signed 64-bit column, so keep them inside its
		// positive range rather than letting one round-trip as a negative.
		seed = newSplitMix64(uint64(time.Now().UnixNano())).next() >> 1
	}
	seed &= (1 << 63) - 1

	run := &botSeries{
		seriesID: seriesID, modeID: ask.ModeID, control: ask.Control,
		firstBot: ask.FirstBotID, secondBot: ask.SecondBotID,
		requestedBy: ask.RequestedBy, privileged: ask.Privileged,
		pairs: ask.Pairs, plies: ask.OpeningPlies, seed: seed,
		openings:     make(map[int][]game.Move),
		openingSeeds: make(map[int]uint64),
		counted:      make(map[int]bool),
		chat:         newChatRoom(seriesID),
	}
	// The run is registered before its database row exists, so that the public
	// ceiling and the claim on a slot happen under one lock. Checking first and
	// inserting afterwards would let two clicks that arrive together both pass a
	// limit of one.
	if err := server.botSeriesRuns.claim(run); err != nil {
		return persistence.BotSeries{}, err
	}

	record, err := server.data.CreateBotSeries(ctx, persistence.BotSeries{
		SeriesID:          seriesID,
		ModeID:            ask.ModeID,
		FirstBotID:        ask.FirstBotID,
		SecondBotID:       ask.SecondBotID,
		RequestedByUserID: ask.RequestedBy,
		Pairs:             ask.Pairs,
		OpeningPlies:      ask.OpeningPlies,
		Seed:              int64(seed),
		InitialTimeMs:     ask.Control.InitialTimeMs,
		IncrementMs:       ask.Control.IncrementMs,
	})
	if err != nil {
		server.botSeriesRuns.drop(seriesID)
		return persistence.BotSeries{}, err
	}

	server.playNextSeriesGame(run)
	return record, nil
}

// playNextSeriesGame seats the two engines for the next game in the run.
func (server *Server) playNextSeriesGame(run *botSeries) {
	run.gameNumber++
	number := run.gameNumber
	if run.aborted || number > run.pairs*2 {
		server.finishBotSeries(run, persistence.BotSeriesCompleted)
		return
	}

	// Games 1 and 2 are pair 1, games 3 and 4 are pair 2, and the second of
	// each pair swaps seats.
	pair := (number + 1) / 2
	swapped := number%2 == 0

	// A draining engine leaves on a pair boundary rather than the moment it is
	// asked, and an odd `number` is exactly that boundary: this game would open
	// a new pair. Half a pair is not wrong — an unplayed game is recorded
	// nowhere and reaches no ladder — but the two seatings of a pair exist to
	// cancel the first-move advantage, and stopping between them leaves the
	// matchup's sample one game lopsided. Finishing costs one more short game.
	if !swapped && server.seriesBotIsDraining(run) {
		server.finishBotSeries(run, persistence.BotSeriesAborted)
		return
	}

	moves, ok := run.openings[pair]
	if !ok {
		usedSeed, built := uint64(0), false
		moves, usedSeed, built = buildOpening(
			server.registry, run.modeID,
			run.seed+uint64(pair)*0x9e3779b97f4a7c15, run.plies,
		)
		if !built {
			log.Printf("bot series %s: no playable opening for pair %d", run.seriesID, pair)
			server.finishBotSeries(run, persistence.BotSeriesAborted)
			return
		}
		run.openings[pair] = moves
		run.openingSeeds[pair] = usedSeed
	}

	first, second := server.readyBot(run.firstBot), server.readyBot(run.secondBot)
	if first == nil || second == nil {
		server.finishBotSeries(run, persistence.BotSeriesAborted)
		return
	}
	red, blue := first, second
	if swapped {
		red, blue = second, first
	}

	entry := func(client *Client) QueueEntry {
		return QueueEntry{
			Client: client,
			// Ranked: both sides are bots, so this moves bot ratings and cannot
			// touch a person's. That is the whole of the separate-pool design.
			Setup:    game.GameSetup{ModeID: run.modeID, TimeControl: run.control},
			Elo:      matchmakingElo(client, run.modeID),
			JoinedAt: time.Now(),
		}
	}
	session := server.startConfiguredMatch(entry(red), entry(blue), matchSetup{
		botMatch:     &botMatchRef{seriesID: run.seriesID, gameNumber: number},
		openingMoves: moves,
		openingSeed:  strconv.FormatUint(run.openingSeeds[pair], 10),
		// The new game joins the run's conversation rather than being handed a
		// copy of it: a spectator who follows the series to its next board is
		// still in the room they were talking in, one who stays behind on the
		// finished board can still hear them, and one who only turns up at
		// game six arrives to the whole thing.
		chat: run.chat,
	})
	if session == nil {
		server.finishBotSeries(run, persistence.BotSeriesAborted)
		return
	}
	if err := server.data.RecordBotSeriesGame(
		context.Background(), run.seriesID, number, pair, swapped, session.gameID,
		openingLine(moves),
	); err != nil {
		log.Printf("record series game: %v", err)
	}
}

// recordBotMatchResult files a finished series game and starts the next one.
//
// Called from finishSession, which frequently runs on the 100ms clock ticker.
// Starting the next game inline would stall that ticker for the whole of
// startConfiguredMatch, so the step happens on its own goroutine after a short
// delay, guarded so two paths cannot both take it.
func (server *Server) recordBotMatchResult(session *GameSession, state game.GameState) {
	if session.botMatch == nil {
		return
	}

	outcome := persistence.BotSeriesDraw
	swapped := session.botMatch.gameNumber%2 == 0
	switch state.Winner {
	case game.Red:
		outcome = persistence.BotSeriesFirstWin
		if swapped {
			outcome = persistence.BotSeriesSecondWin
		}
	case game.Blue:
		outcome = persistence.BotSeriesSecondWin
		if swapped {
			outcome = persistence.BotSeriesFirstWin
		}
	}

	// Filed before the run is looked up, and whether or not it is still there.
	//
	// Aborting a run does not stop the game already on the board — two engines
	// are mid-match and nothing here can take that back — so that game finishes,
	// is rated, and lands in the archive like any other. It used to be dropped
	// from its own series on the way past, because this function gave up when
	// the abort had already removed the run from the map: a result that counted
	// for both bots' ratings and for nothing else, leaving the pair it belonged
	// to reading `pending` for ever. The database write needs no run — the
	// series and game number are both on the session.
	if err := server.data.FinishBotSeriesGame(
		context.Background(), session.botMatch.seriesID, session.botMatch.gameNumber,
		outcome, string(state.EndReason),
	); err != nil {
		log.Printf("finish series game: %v", err)
	}

	// The rest is about carrying on, which an aborted run is not doing.
	server.botSeriesRuns.mu.Lock()
	run := server.botSeriesRuns.series[session.botMatch.seriesID]
	server.botSeriesRuns.mu.Unlock()
	if run == nil {
		return
	}
	run.count(session.botMatch.gameNumber, outcome)

	run.step.Lock()
	if run.advancing || run.aborted {
		run.step.Unlock()
		return
	}
	run.advancing = true
	run.step.Unlock()

	go func() {
		time.Sleep(server.botSeriesDelay())
		run.step.Lock()
		run.advancing = false
		run.step.Unlock()
		server.playNextSeriesGame(run)
	}()
}

// count moves the run's own tally, once per game.
func (run *botSeries) count(gameNumber int, outcome persistence.BotSeriesResult) {
	run.step.Lock()
	defer run.step.Unlock()
	if run.counted[gameNumber] {
		return
	}
	run.counted[gameNumber] = true
	switch outcome {
	case persistence.BotSeriesFirstWin:
		run.firstWins++
	case persistence.BotSeriesSecondWin:
		run.secondWins++
	default:
		run.draws++
	}
}

// AbortBotSeries stops a run between games.
//
// Anybody may start a run, so anybody may stop the one they started — and
// nobody else's. Without that second half, the abort button would be a way to
// spoil a series somebody is watching, which is a worse thing to leave open
// than a run that has to be waited out.
func (server *Server) AbortBotSeries(
	seriesID string,
	requestedBy string,
	privileged bool,
) error {
	server.botSeriesRuns.mu.Lock()
	run := server.botSeriesRuns.series[seriesID]
	server.botSeriesRuns.mu.Unlock()
	if run == nil {
		return errSeriesNotRunning
	}
	if !privileged && (requestedBy == "" || run.requestedBy != requestedBy) {
		return errSeriesNotYours
	}
	server.finishBotSeries(run, persistence.BotSeriesAborted)
	return nil
}

// claim takes a slot for a run and registers it, or says why it cannot.
//
// An administrator's run is registered unconditionally; a visitor's has two
// ceilings to clear, and they answer two different questions. The per-account
// one keeps one enthusiast from holding every slot; the server-wide one keeps
// the lobby from being all bots. A signed-in account and a browser's Guest
// account are the same thing here, deliberately — the identity is what the run
// is attributed to, not a privilege level.
func (runner *botSeriesRunner) claim(run *botSeries) error {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	if !run.privileged {
		running := 0
		for _, existing := range runner.series {
			if existing.privileged {
				continue
			}
			if run.requestedBy != "" && existing.requestedBy == run.requestedBy {
				return errSeriesAlreadyYours
			}
			running++
		}
		if running >= publicSeriesConcurrent {
			return errSeriesServerBusy
		}
	}
	runner.series[run.seriesID] = run
	return nil
}

// drop un-registers a run that never got off the ground, so a failed database
// write does not leave a slot occupied by a series that does not exist.
func (runner *botSeriesRunner) drop(seriesID string) {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	delete(runner.series, seriesID)
}

// openToPublicSeries reports whether this bot may be entered into a series by
// the given account.
//
// The gate is the bot's own public-play switch, which is the same switch that
// decides whether a stranger may challenge it. Reusing it rather than adding a
// second one means an owner who has already said "yes, play against people" does
// not have to find and answer a near-identical question, and one who has said no
// is not overruled by a route that did not exist when they said it.
//
// An owner is exempt from their own switch: a private bot is private from
// strangers, and running your new version against your old one is the reason the
// five-bot allowance exists.
func openToPublicSeries(client *Client, requestedBy string) bool {
	client.bot.mu.Lock()
	record := client.bot.record
	client.bot.mu.Unlock()
	if record.AllowPublicPlay {
		return true
	}
	return requestedBy != "" && record.OwnerUserID == requestedBy
}

func (server *Server) finishBotSeries(run *botSeries, status persistence.BotSeriesStatus) {
	run.step.Lock()
	if run.aborted {
		run.step.Unlock()
		return
	}
	run.aborted = true
	run.step.Unlock()

	server.botSeriesRuns.mu.Lock()
	delete(server.botSeriesRuns.series, run.seriesID)
	server.botSeriesRuns.mu.Unlock()

	if err := server.data.CloseBotSeries(context.Background(), run.seriesID, status); err != nil {
		log.Printf("close series: %v", err)
	}
}

// abortSeriesForBot ends any run a departing bot was part of. A series with one
// engine in it is not a series.
func (server *Server) abortSeriesForBot(botID string) {
	server.botSeriesRuns.mu.Lock()
	var affected []*botSeries
	for _, run := range server.botSeriesRuns.series {
		if run.firstBot == botID || run.secondBot == botID {
			affected = append(affected, run)
		}
	}
	server.botSeriesRuns.mu.Unlock()
	for _, run := range affected {
		server.finishBotSeries(run, persistence.BotSeriesAborted)
	}
}

// botSeriesForBot is the run an engine is in the middle of, if any.
func (server *Server) botSeriesForBot(botID string) *botSeries {
	server.botSeriesRuns.mu.Lock()
	defer server.botSeriesRuns.mu.Unlock()
	for _, run := range server.botSeriesRuns.series {
		if run.firstBot == botID || run.secondBot == botID {
			return run
		}
	}
	return nil
}

// seriesBotIsDraining reports whether either engine in a run is shutting down.
func (server *Server) seriesBotIsDraining(run *botSeries) bool {
	return botIsDraining(server.readyBot(run.firstBot)) ||
		botIsDraining(server.readyBot(run.secondBot))
}

// readyBot returns a connected, handshaken bot by id.
func (server *Server) readyBot(botID string) *Client {
	server.mu.RLock()
	client := server.bots[botID]
	server.mu.RUnlock()
	if client == nil {
		return nil
	}
	client.bot.mu.Lock()
	ready := client.bot.ready
	client.bot.mu.Unlock()
	if !ready {
		return nil
	}
	return client
}

func (server *Server) botSeriesDelay() time.Duration {
	if server.seriesDelay > 0 {
		return server.seriesDelay
	}
	return botSeriesDelay
}

// openingLine writes the book moves the way the opening book already does, so
// an opening is readable in the archive rather than only reproducible.
func openingLine(moves []game.Move) string {
	parts := make([]string, 0, len(moves))
	for _, move := range moves {
		parts = append(parts, notation.FormatSquare(move.From)+"-"+notation.FormatSquare(move.To))
	}
	return strings.Join(parts, " ")
}

// Series rejections an admin can act on, kept distinct so the route can map
// each to the right status code and message.
var (
	errSeriesSameBot      = errors.New("a bot cannot play itself")
	errSeriesPairCount    = errors.New("choose between 1 and 100 pairs of games")
	errSeriesOpeningPlies = errors.New("choose between 0 and 20 opening plies")
	errSeriesMode         = errors.New("that game mode is not open for new matches")
	errSeriesBotOffline   = errors.New("both bots must be online and ready")
	errSeriesBotBusy      = errors.New("both bots must be idle")
	errSeriesBotDraining  = errors.New("one of those bots is shutting down")
	errSeriesNotRunning   = errors.New("no such running series")

	// The public path's own refusals. Each says what the limit is rather than
	// that there was one, because the form that hit it can be corrected.
	errSeriesPublicPairs = errors.New(
		"choose at most 3 pairs; ask an admin for a longer run",
	)
	errSeriesPublicClock = errors.New(
		"choose at most 10 minutes each with a 5 second increment",
	)
	errSeriesBotPrivate = errors.New(
		"both bots must be open to public play, or be yours",
	)
	errSeriesAlreadyYours = errors.New(
		"you already have a series running; wait for it to finish",
	)
	errSeriesServerBusy = errors.New(
		"the server is already running as many bot series as it allows; try again shortly",
	)
	errSeriesNotYours = errors.New("only the person who started a series can stop it")
)
