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
	// Ten is well short of that: the per-account ceiling means ten runs are ten
	// different visitors, and the engines themselves run out of slots first.
	publicSeriesConcurrent = 10
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
	// ladder marks a run the ranked pool arranged, which is what makes its games
	// count. See BotSeriesRequest.Ladder.
	ladder     bool
	pairs      int
	plies      int
	seed       uint64
	gameNumber int
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
	// awaySince is when the server first found one of this run's engines
	// offline, and is zero the rest of the time. Kept whether or not the run is
	// between games, because it is what the window for coming back is measured
	// from. See noteSeriesEnginePresence.
	awaySince time.Time
	// stalled is a run that tried to deal its next game, found an engine
	// missing, and is holding its place until that engine is back: it keeps its
	// slot claims, its score and its conversation, and resumes at the game it
	// stopped at. Distinct from awaySince, which is only the clock — a run
	// whose engine drops mid-game is timing the absence without being stalled,
	// because the game on the board is what it is waiting for.
	//
	// It is also the flag that says who may deal the next game. Exactly one
	// thing advances a run at a time: the goroutine after a finished game while
	// `advancing` is set, or the sweep while this is. Clearing it under step
	// before dealing is what keeps those two from both seating game N+1.
	stalled bool
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

// inLadderRun reports whether this engine is in a running ranked round.
//
// Only the pool asks, and what it is really asking is "have I already spent
// this engine's budget". A round's pairing can start late — see
// resumeHeldPairings — so "it is in a game" and "it is in a game I started" are
// no longer the same question, and the second is the one that decides whether
// to pair it again.
func (runner *botSeriesRunner) inLadderRun(botID string) bool {
	runner.mu.Lock()
	defer runner.mu.Unlock()
	for _, run := range runner.series {
		// `ladder`, `firstBot` and `secondBot` are set when the run is built and
		// never reassigned, so they are read without taking run.step — which
		// this must not do anyway, since it is called from the pairer with the
		// runner's lock held.
		if run.ladder && (run.firstBot == botID || run.secondBot == botID) {
			return true
		}
	}
	return false
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
	// Ladder marks a run the ranked pool arranged, and it is the only thing that
	// makes an engine game count.
	//
	// Set by seatLadderRound and by StartLadderMatch, and by nothing else — not
	// by a request field anybody can send, not even on an administrator's
	// series. Those two are one rule rather than two doors: both take the
	// opponent from the field and the conditions from the rotation, and the only
	// difference between them is whether the hour struck or somebody pressed a
	// button. What stays impossible is the thing the complaint was about —
	// choosing the opponent, the mode, the clock or the length of a run and then
	// keeping the result. None of those four is reachable from outside, which is
	// why the flag is set from inside the server or not at all.
	Ladder bool
}

// StartBotSeries sets up a run and plays its first game.
func (server *Server) StartBotSeries(
	ctx context.Context,
	ask BotSeriesRequest,
) (persistence.BotSeries, error) {
	// A run started during a drain would be aborted before its second game, so
	// refusing it up front is both faster and honest. Administrators included:
	// the one who asked for the restart is the one most likely to be here.
	if server.isUpdating() {
		return persistence.BotSeries{}, errSeriesServerUpdating
	}
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
	if server.freeBotConnection(ask.FirstBotID) == nil ||
		server.freeBotConnection(ask.SecondBotID) == nil {
		return persistence.BotSeries{}, errSeriesBotBusy
	}
	if botIsDraining(first) || botIsDraining(second) {
		return persistence.BotSeries{}, errSeriesBotDraining
	}
	// A series is minutes of both engines' time, which is exactly what an
	// engine entered in a running tournament does not have. See bot_reserve.go.
	if server.botIsReserved(first) || server.botIsReserved(second) {
		return persistence.BotSeries{}, errSeriesBotReserved
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
		ladder: ask.Ladder,
		pairs:  ask.Pairs, plies: ask.OpeningPlies, seed: seed,
		openings:     make(map[int][]game.Move),
		openingSeeds: make(map[int]uint64),
		counted:      make(map[int]bool),
		chat:         newScopedChatRoom(seriesID, ChatScopeSeries),
	}
	// The run is registered before its database row exists, so that the public
	// ceiling and the claim on a slot happen under one lock. Checking first and
	// inserting afterwards would let two clicks that arrive together both pass a
	// limit of one.
	if err := server.botSeriesRuns.claim(run); err != nil {
		return persistence.BotSeries{}, err
	}
	// The slots come next, under the run's own id, so that two series starting
	// together cannot both take the same one — and so that the pair boundaries
	// below have a seat waiting rather than a search for one.
	if server.claimSeriesBot(ask.FirstBotID, seriesID) == nil ||
		server.claimSeriesBot(ask.SecondBotID, seriesID) == nil {
		server.releaseSeriesBots(run)
		server.botSeriesRuns.drop(seriesID)
		return persistence.BotSeries{}, errSeriesBotBusy
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
		Ladder:            ask.Ladder,
	})
	if err != nil {
		server.releaseSeriesBots(run)
		server.botSeriesRuns.drop(seriesID)
		return persistence.BotSeries{}, err
	}

	server.playNextSeriesGame(run)
	return record, nil
}

// playNextSeriesGame seats the two engines for the next game in the run.
func (server *Server) playNextSeriesGame(run *botSeries) {
	// Before the game number moves, so that waiting is a retry of the game
	// about to be dealt rather than a skip past it. An engine that is not
	// connected right now is very often one that will be in a second — see
	// stallSeriesForAbsentEngine.
	if server.stallSeriesForAbsentEngine(run, time.Now()) {
		return
	}
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

	// A draining engine — or a server being replaced — leaves on a pair boundary
	// rather than the moment it is asked, and an odd `number` is exactly that
	// boundary: this game would open a new pair. Half a pair is not wrong — an unplayed game is recorded
	// nowhere and reaches no ladder — but the two seatings of a pair exist to
	// cancel the first-move advantage, and stopping between them leaves the
	// matchup's sample one game lopsided. Finishing costs one more short game.
	if !swapped && (server.isUpdating() || server.seriesBotIsDraining(run)) {
		server.finishBotSeries(run, persistence.BotSeriesAborted)
		return
	}

	moves, ok := run.openings[pair]
	if !ok {
		usedSeed, built := uint64(0), false
		moves, usedSeed, built = server.dealOpening(
			context.Background(), run.modeID,
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

	first := server.claimSeriesBot(run.firstBot, run.seriesID)
	second := server.claimSeriesBot(run.secondBot, run.seriesID)
	if first == nil || second == nil {
		server.finishBotSeries(run, persistence.BotSeriesAborted)
		return
	}
	// Re-read after the claims, because an abort can land between the check at
	// the top of this function and here: a moderator's stop button, a recall
	// for a tournament match, the sweep giving up on an engine. releaseSeriesBots
	// has already run by then, so claiming afterwards would pin two slots to a
	// run that no longer exists and no later release would ever name — an
	// engine stuck showing as busy until its owner restarted it.
	run.step.Lock()
	dropped := run.aborted
	run.step.Unlock()
	if dropped {
		server.releaseSeriesBots(run)
		server.broadcastBots()
		return
	}
	red, blue := first, second
	if swapped {
		red, blue = second, first
	}

	// Ranked only if the ranked pool arranged this run, and casual otherwise.
	//
	// This used to be the other way round: an engine game was rated unless one
	// person owned both sides. That is the rule the community complained about,
	// from two directions at once. Whoever started the series chose the
	// opponent, so the way to gain rating was to pick a weak one — or to
	// register one, or to talk a friend into registering one. And they chose the
	// mode, the clock and the number of pairs, so an engine that happened to be
	// strong at one minute could be rated only ever at one minute.
	//
	// So a rating now comes from one shape of game: a pairing the server
	// arranged, under conditions the server picked, against an opponent the
	// server chose. See ladder_pool.go for the hourly one and ladder_match.go
	// for the same thing on a button — an author may ask for it whenever they
	// like, and still names nobody. Everything else an author can start — trying
	// a new build against an old one, answering somebody's challenge, running a
	// hundred games to test a change — still works and still shows up in the
	// archive, and none of it moves a number.
	//
	// Same-owner is still refused on top, because a pair of engines one hand
	// controls can be made to lose to each other on purpose. The pool will not
	// choose such a pairing, so this is the belt to that braces; the fit drops
	// the pair regardless, which is what covers the games recorded before either
	// rule existed.
	//
	// Marked here, on the game, rather than filtered out further down, so that
	// every place a game is shown reads it from the same flag: the history row,
	// the archive, the PGN and the review screen all say casual without being
	// told separately.
	setup := game.GameSetup{
		ModeID:      run.modeID,
		TimeControl: run.control,
		Casual:      !run.ladder || sameBotOwner(first, second),
	}
	entry := func(client *Client) QueueEntry {
		return QueueEntry{
			Client:   client,
			Setup:    setup,
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

// sameBotOwner reports whether one person owns both engines.
//
// Unclaimed is never the same as unclaimed: a bot that has not finished its
// handshake has no owner on record here, and two unknowns are not a match. The
// callers only ever ask about ready bots, so this is a guard rather than a case.
func sameBotOwner(first *Client, second *Client) bool {
	one, other := botOwner(first), botOwner(second)
	return one != "" && one == other
}

// botOwner reads the account a bot is registered to, or empty for a client that
// is not a bot or has not been claimed.
func botOwner(client *Client) string {
	if client == nil || client.bot == nil {
		return ""
	}
	client.bot.mu.Lock()
	defer client.bot.mu.Unlock()
	return client.bot.record.OwnerUserID
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
	server.releaseSeriesBots(run)
	// A held slot reads as busy even between the games of a run, which is the
	// point of holding it — so handing the slots back is a change to the roster
	// with no game ending to publish it. The last game of the run was retired
	// before this, and said its engines were in a series that still held them.
	server.broadcastBots()

	if err := server.data.CloseBotSeries(context.Background(), run.seriesID, status); err != nil {
		log.Printf("close series: %v", err)
	}
	// A run is a commitment a drain waits on even between its games, so a run
	// ending is a commitment clearing — the same event as a game finishing, and
	// it needs the same hook. Without it the last thing a deploy was waiting for
	// is a series that stops on a pair boundary, and the exit waits for a lobby
	// tick to notice. Only ever a no-op unless a deploy is in progress.
	server.settleUpdateDrain()
	// And the same at the other scale, which was missing: the whole point of
	// stopping on a pair boundary is that a draining engine can then go, so the
	// engine should be told the moment the pair is done rather than on whichever
	// lobby tick came next. Both bots, because either one of them may be the one
	// that is leaving.
	for _, botID := range []string{run.firstBot, run.secondBot} {
		if client := server.readyBot(botID); client != nil && botHasOwnDrain(client) {
			server.settleBotShutdown(client)
		}
	}
}

// An engine that is not there right now, and the difference between that and an
// engine that is gone.
//
// rpsbot.py reconnects on its own, on a backoff that starts at one second, and
// a supervised host restarts it if the process dies. So the overwhelmingly
// common reason a slot is missing is that it is on its way back — a redeploy of
// the owner's machine, a wifi drop, a laptop lid. A run used to be written off
// the instant that happened, which turned a two-second blip into a lost
// afternoon of engine time and, when the blip was mid-pair, into a matchup whose
// sample is one game lopsided in the first mover's favour.
//
// So a run *stalls* instead. It keeps its slot claims, its score, its chat room
// and the game number it was about to deal, and it waits the same window a game
// on the board waits for the same engine. Coming back inside that window is a
// blip and costs nothing. Not coming back is the run ending, which is what it
// always was.

// seriesAwayGrace is how long a run waits for a missing engine.
//
// Deliberately the same window a seat on the board gets. Two numbers here would
// be two things to explain and one of them would drift: an owner watching an
// engine reconnect wants "it has fifteen seconds" to be true of everything it
// was doing, not of its game but not its series.
func (server *Server) seriesAwayGrace() time.Duration {
	if server.seriesAwayOverride > 0 {
		return server.seriesAwayOverride
	}
	return botReconnectGracePeriod
}

// seriesEngineAway names an engine of this run that is not connected, or empty
// when both are here.
//
// Any handshaken slot counts, not the one the run was holding: an engine that
// came back on a different slot is the same engine, and claimSeriesBot will
// take whichever one is free.
func (server *Server) seriesEngineAway(run *botSeries) string {
	for _, botID := range []string{run.firstBot, run.secondBot} {
		if server.readyBot(botID) == nil {
			return botID
		}
	}
	return ""
}

// noteSeriesEnginePresence records whether a run's engines are here, and hands
// back which one is not and how long it has been gone.
//
// The clock starts when the *server* notices, which is the tick after the socket
// dropped — not when the run next tries to deal a game. That distinction is the
// difference between one window and two: an engine that vanishes mid-game has
// its seat held for botReconnectGracePeriod and only then is the game called,
// and a run that started counting at that point would sit through the whole
// window a second time before admitting the engine is gone. Half a minute of an
// empty lobby for a bot that stopped answering thirty seconds ago.
func (server *Server) noteSeriesEnginePresence(
	run *botSeries,
	now time.Time,
) (away string, waited time.Duration) {
	away = server.seriesEngineAway(run)

	run.step.Lock()
	defer run.step.Unlock()
	if away == "" {
		// Back, and possibly never noticed to have gone. Clearing this is what
		// makes the window per-absence rather than per-run: an engine that
		// drops twice gets a whole window the second time.
		if !run.awaySince.IsZero() {
			run.awaySince = time.Time{}
			log.Printf("bot series %s: engines are back", run.seriesID)
		}
		return "", 0
	}
	if run.awaySince.IsZero() {
		run.awaySince = now
		log.Printf(
			"bot series %s: waiting up to %s for %s to reconnect",
			run.seriesID, server.seriesAwayGrace(), away,
		)
		return away, 0
	}
	return away, now.Sub(run.awaySince)
}

// stallSeriesForAbsentEngine holds a run open for an engine that is missing,
// and reports whether the caller should stand down.
//
// True means "not now": either the run is waiting, or it has just been ended
// because the wait ran out. False is both engines present and the run free to
// deal its next game.
func (server *Server) stallSeriesForAbsentEngine(run *botSeries, now time.Time) bool {
	run.step.Lock()
	dropped := run.aborted
	run.step.Unlock()
	if dropped {
		return true
	}

	away, waited := server.noteSeriesEnginePresence(run, now)
	if away == "" {
		return false
	}
	if waited < server.seriesAwayGrace() {
		run.step.Lock()
		run.stalled = true
		run.step.Unlock()
		return true
	}

	log.Printf(
		"bot series %s: %s did not come back within %s; ending the run",
		run.seriesID, away, server.seriesAwayGrace(),
	)
	server.finishBotSeries(run, persistence.BotSeriesAborted)
	return true
}

// resumeStalledSeries is the other half of the stall: the thing that notices an
// engine came back, or that it is not going to.
//
// On the existing lobby ticker, for the reason settleBotShutdowns gives — a
// second scheduler is a second thing to reason about, and two seconds of
// latency on a run that has been waiting anyway is nothing. Nothing else could
// do it: a stalled run is between games, so no move, no result and no
// disconnect will come along to poke it.
//
// Every run is looked at, not only the stalled ones, because the counting has
// to start while the run still has a game on the board. What it will not do
// while that game is being played is *act* on the count: the board is where the
// same absence is already being timed, that sweep owns the result, and a run
// torn down underneath a live game would drop the last game out of its own
// tally. See noteSeriesEnginePresence.
func (server *Server) resumeStalledSeries(now time.Time) {
	server.botSeriesRuns.mu.Lock()
	runs := make([]*botSeries, 0, len(server.botSeriesRuns.series))
	for _, run := range server.botSeriesRuns.series {
		runs = append(runs, run)
	}
	server.botSeriesRuns.mu.Unlock()
	if len(runs) == 0 {
		return
	}
	playing := server.seriesWithGamesInPlay()

	for _, run := range runs {
		away, waited := server.noteSeriesEnginePresence(run, now)
		if playing[run.seriesID] {
			continue
		}
		switch {
		case away == "":
			run.step.Lock()
			resuming := run.stalled && !run.aborted
			run.stalled = false
			run.step.Unlock()
			if !resuming {
				continue
			}
			// Both engines are back and the run is where it stopped, so this
			// deals the game it was about to deal — including, when the engine
			// went away mid-pair, the swapped half that balances the pair it
			// already played.
			server.playNextSeriesGame(run)
		case waited >= server.seriesAwayGrace():
			log.Printf(
				"bot series %s: %s did not come back within %s; ending the run",
				run.seriesID, away, server.seriesAwayGrace(),
			)
			server.finishBotSeries(run, persistence.BotSeriesAborted)
		}
	}
}

// seriesWithGamesInPlay is the set of runs with a game on the board right now.
func (server *Server) seriesWithGamesInPlay() map[string]bool {
	server.mu.RLock()
	defer server.mu.RUnlock()
	playing := make(map[string]bool)
	for _, session := range server.games {
		if session.botMatch != nil {
			playing[session.botMatch.seriesID] = true
		}
	}
	return playing
}

// abortSeriesForBot ends any run an engine is part of, now, without waiting for
// it to come back.
//
// The deliberate reason to leave, as against the accidental one above: a
// moderator closing a misbehaving bot's sockets, and a recall pulling an engine
// out for a tournament match it is entered in. Both have already decided the
// run is the thing that gives way, so neither wants the fifteen seconds a blip
// gets. A dropped socket does *not* come here — see unregisterBot.
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

// readyBot returns a connected, handshaken slot of a bot by id.
//
// Any of them: the callers here want the engine's record, handshake and drain,
// which every slot of one bot agrees on. Seating a game is the other question,
// and goes through claimSeriesBot.
func (server *Server) readyBot(botID string) *Client {
	for _, client := range server.botConnections(botID) {
		client.bot.mu.Lock()
		ready := client.bot.ready
		client.bot.mu.Unlock()
		if ready {
			return client
		}
	}
	return nil
}

// claimSeriesBot takes a slot of an engine for a run, and keeps it.
//
// Held rather than found again each pair, because a series is a run of games
// between the same two engines and the second or so between one game and the
// next is not an invitation. On a bot with one slot the hold changes nothing —
// nothing else could have taken it anyway. On a bot with three, it is what
// keeps a challenge arriving in that gap from taking the seat out from under
// the run.
func (server *Server) claimSeriesBot(botID string, seriesID string) *Client {
	for _, client := range server.botConnections(botID) {
		client.bot.mu.Lock()
		mine := client.bot.ready && client.bot.reservedBy == seriesID
		client.bot.mu.Unlock()
		if mine {
			return client
		}
	}
	client := server.freeBotConnection(botID)
	if client == nil {
		return nil
	}
	client.bot.mu.Lock()
	if client.bot.reservedBy != "" {
		// Claimed by another run between the check and here.
		client.bot.mu.Unlock()
		return nil
	}
	client.bot.reservedBy = seriesID
	client.bot.mu.Unlock()
	return client
}

// releaseSeriesBots hands a run's slots back, whatever ended it.
func (server *Server) releaseSeriesBots(run *botSeries) {
	for _, botID := range []string{run.firstBot, run.secondBot} {
		for _, client := range server.botConnections(botID) {
			client.bot.mu.Lock()
			if client.bot.reservedBy == run.seriesID {
				client.bot.reservedBy = ""
			}
			client.bot.mu.Unlock()
		}
	}
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
	errSeriesBotReserved  = errors.New(
		"one of those bots is in reserve for a tournament it has entered",
	)
	errSeriesNotRunning = errors.New("no such running series")

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
	errSeriesNotYours       = errors.New("only the person who started a series can stop it")
	errSeriesServerUpdating = errors.New(
		"the server is restarting for an update; try again in a minute",
	)
)
