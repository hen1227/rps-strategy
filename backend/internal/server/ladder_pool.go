package server

import (
	"context"
	"errors"
	"log"
	"net/http"
	"sort"
	"sync"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// The ranked pool: the only thing that produces a bot rating.
//
// Three complaints about the old ladder, and one mechanism answers all of them.
//
// You could pick your opponent, so you picked a weak one — or registered one.
// You could pick the clock and the number of games, so you picked the ones your
// engine happened to be good at. And if you wanted an honest rating anyway you
// had to arrange every matchup by hand, find opponents near your own strength,
// and come back when the last run finished.
//
// So nobody picks anything. On the hour the server chooses the mode and the
// clock from a rotation, looks at who is entered and online, works out which
// pairings would teach it the most, and seats them. A game that was not arranged
// this way is not ranked — see playNextSeriesGame, which is the only place a
// ranked engine game is created.
//
// An author may also ask for one of these between the hours, which is
// ladder_match.go and is this file's mechanism rather than an exception to it:
// the press supplies the *when* and the server still supplies the opponent and
// the conditions. The third complaint above is the one that answers — having to
// wait out a schedule for evidence about a build you finished tonight — and it
// answers it without giving back either of the first two.
//
// # How pairs are chosen
//
// Not at random, and not strictly by nearest rating either. Each admissible pair
// is scored by how much the fit would learn from the game:
//
//	value(i,j) = p(1-p) * headroom(i,j) * (var(i) + var(j))
//
// and the three terms are not three heuristics. The first is literally the term
// the Bradley-Terry information matrix contributes for that matchup — see
// botStrengthVariance — so the pool is maximising exactly the quantity the
// rating's error bars minimise. It peaks at even odds, which is what "pair bots
// of similar strength" means once you write it down, and it falls off smoothly
// rather than cutting off, so a mismatch still happens occasionally. That matters
// more than it looks: a pool that only ever paired neighbours would leave the
// ladder in bands with nothing joining them, and a rating is a distance from the
// anchor along a chain of matchups.
//
// The second says a pair already played to the cap has nothing left to give, so
// the pool spreads out and prefers an opponent you have not met. The third
// prioritises the engines the board is least sure of, which is new arrivals and
// anyone back from a break.
//
// A brand-new bot has maximum uncertainty and has played nobody, so its first
// round is against whichever yardstick sits nearest the pairer's guess at it.
// That is the on-ramp and the anti-farm guarantee in the same move: the games
// that put a newcomer on the scale are against an engine it cannot have farmed,
// because nobody owns it.
const (
	// ladderRoundInterval is how far apart the round slots are.
	//
	// An hour is a compromise between a ladder that tracks the field and an
	// engine's owner not minding that it is running. Two games an hour is a few
	// minutes of CPU; the pool would learn faster at ten minutes and would be
	// something people turned off.
	//
	// The slots are the hours themselves — 14:00, 15:00, 16:00 — rather than an
	// hour after whenever the last round happened to run. An interval measured
	// from the last round is measured from wherever the process found itself, so
	// a restart at twenty past would move every round after it to twenty past
	// for as long as that process lived, and the schedule the server publishes
	// and the schedule it runs would agree only until the next deploy. Anything
	// other than an hour here would have to divide one for the slots to keep
	// landing with the rotation in ladderConditions.
	ladderRoundInterval = time.Hour

	// ladderRoundGrace is how late a round may still be seated.
	//
	// The clock is looked at once a minute and a drain can swallow the top of an
	// hour outright, so a slot needs a little room after it or a round would be
	// lost to a rounding error. What it does not get is unlimited room: past
	// this the hour is simply skipped, which is the second half of "on the hour"
	// — a round seated at twenty past is one the published countdown announced
	// for twenty minutes ago, and the engines whose owners were watching for it
	// have gone back to whatever else they do.
	ladderRoundGrace = 5 * time.Minute

	// ladderTick is how often runLadderRound does more than glance at the clock.
	//
	// The lobby ticker fires every couple of seconds and this is one of a dozen
	// jobs on it, so the guard has to be cheap and the work has to be rare. It
	// bites only inside the grace window, the slot check ahead of it being a
	// subtraction and nothing else — so the first tick after an hour is always a
	// full look and a round is seated within seconds of its slot rather than up
	// to a minute after it. What the minute bounds is the database read, for the
	// hour where the round cannot be marked and every tick would retry it.
	ladderTick = time.Minute

	// ladderOpeningPlies is how many moves of book each pairing is dealt.
	//
	// The same opening is played twice with the colours swapped, which is what
	// makes a pairing worth two games rather than one: engines are deterministic,
	// and Blue moves first, so an unswapped pair would measure the opening as
	// much as the engines.
	ladderOpeningPlies = 4

	// ladderMaxRoundsPerBot is how many pairings one engine takes per round.
	//
	// One. The budget is the whole answer to "will this eat my machine", and it
	// is a promise worth being able to make plainly: entering the pool costs two
	// games an hour and never more, whatever else is going on.
	ladderMaxRoundsPerBot = 1

	// ladderMinimumField is how many engines have to be online for a round.
	// Two is a pairing; below that there is nothing to seat.
	ladderMinimumField = 2
)

// ladderModes and ladderClocks are the rotation.
//
// Fixed in code and stepped by the hour, so that the conditions of a ranked game
// are neither anybody's choice nor a surprise: an author can work out what next
// Tuesday afternoon looks like, and cannot change it. That is the point of the
// rotation rather than a side effect — "the requester picks the clock" is one of
// the three things this file exists to take away.
//
// # One mode
//
// The pool plays Intransitive and nothing else. It rotated through all three for
// a while, and the argument for that — every mode gets a board, and an engine
// cannot pick the one it is best at — was answered by what the rounds were
// actually spending themselves on. Intransitive is the game this site is about
// and the one the official events are played at; a third of every engine's two
// games an hour was going into boards almost nobody competes on, which is a
// third of the evidence behind the only rating anybody reads.
//
// The list is still a list, so adding a mode back is one line here and needs no
// other change — ladderConditions steps whatever is in it, and everything
// downstream reads the answer rather than assuming one. What it must not become
// is empty: that would index out of range on the next tick.
//
// The clocks still rotate, and they carry the whole of the anti-specialisation
// argument on their own. An engine tuned for 1+1 has to answer at 5+2 three
// hours in four.
//
// **This does not retire the other boards.** V5 and V3 still have ladders, and
// the games already in them still count — they simply stop gaining new ones, so
// the evidence behind those numbers ages and the fit says so. See the decay in
// botHeadToHeadTx.
var (
	ladderModes  = []game.ModeID{game.ModeIntransitive}
	ladderClocks = []game.TimeControl{
		{InitialTimeMs: 60_000, IncrementMs: 1_000},
		{InitialTimeMs: 180_000, IncrementMs: 1_000},
		{InitialTimeMs: 120_000, IncrementMs: 2_000},
		{InitialTimeMs: 300_000, IncrementMs: 2_000},
	}
)

// ladderRotationHours is how long the published schedule takes to repeat.
//
// The lowest common multiple of the two list lengths, which with one mode and
// four clocks is four hours. Derived rather than written down, because it is the
// kind of number that goes stale silently: the only thing that reads it is the
// page's own copy about how far ahead the rotation is worth showing, and a
// sentence claiming twelve hours next to a list that repeats every four is
// exactly the sort of quiet wrongness the rounds page exists to remove.
func ladderRotationHours() int {
	modes, clocks := len(ladderModes), len(ladderClocks)
	product := modes * clocks
	for modes != 0 {
		modes, clocks = clocks%modes, modes
	}
	return product / clocks
}

// ladderConditions is what this round is played under.
//
// Derived from the hour rather than stored or randomised, which makes it the
// same on every process that computes it and publishable in advance. The two
// lists are walked by independent counters, so with more than one mode in the
// list every mode would be played at every clock rather than the two staying in
// step; see ladderRotationHours for how long that takes to come round.
func ladderConditions(now time.Time) (game.ModeID, game.TimeControl) {
	hours := now.UTC().Unix() / int64(time.Hour/time.Second)
	mode := ladderModes[int(hours%int64(len(ladderModes)))]
	clock := ladderClocks[int(hours%int64(len(ladderClocks)))]
	return mode, clock
}

// ladderRoundSlot is the round a moment belongs to: the top of its hour.
//
// UTC, like the rotation in ladderConditions, so the two cannot end up
// disagreeing about which round is which. Truncate works on the instant rather
// than on anybody's local clock, so the slot is the same moment on every host;
// the zone here only decides how it prints.
func ladderRoundSlot(now time.Time) time.Time {
	return now.UTC().Truncate(ladderRoundInterval)
}

// ladderRoundDue reports whether this hour's round is still owed.
//
// Two ways to answer no and they are the two halves of the rule: it has run
// already, or it is too late for it to be this round rather than a late one.
func ladderRoundDue(now time.Time, last time.Time) bool {
	slot := ladderRoundSlot(now)
	return now.Sub(slot) <= ladderRoundGrace && last.Before(slot)
}

// nextLadderRound is the slot the pool will seat next.
//
// The current one while its round is still owed, so a client asking a few
// seconds after the hour is told about the round that is about to start rather
// than the one after it; the next slot otherwise. Nothing in here depends on
// how long the process has been up, which is what lets the schedule be computed
// in advance and checked afterwards.
func nextLadderRound(now time.Time, last time.Time) time.Time {
	if ladderRoundDue(now, last) {
		return ladderRoundSlot(now)
	}
	return ladderRoundSlot(now).Add(ladderRoundInterval)
}

// ladderHeld is a pairing this round chose that could not start when it was
// chosen, because one of its engines was in a game.
type ladderHeld struct {
	pairing ladderPairing
	modeID  game.ModeID
	clock   game.TimeControl
}

// ladderPoolState is the pool's memory between ticks.
type ladderPoolState struct {
	mu       sync.Mutex
	lastLook time.Time
	// lastRound is the in-process copy of what the database holds, so that the
	// common case — a tick a minute after the last round — costs nothing. The
	// database is still the authority, and is read whenever a round looks due.
	lastRound time.Time
	// held is this round's pairings that have not started yet, retried every
	// tick until they do or until the next round replaces them. See
	// resumeHeldPairings.
	held []ladderHeld
	// yardsticks is which bots are reference engines, filled on first use. See
	// botIsYardstick.
	yardsticks map[string]bool
}

// runLadderRound is the ticker's entry point: a clock check almost every time,
// and a round on the hour.
//
// On the hour, and not necessarily every hour. A round belongs to its slot
// rather than to the time since the last one, so an hour the server spent
// draining, or restarting, or too busy to look at the clock, is an hour with no
// round in it — and the next round is at the next slot rather than an hour after
// whatever finally happened. Skipping one costs the ladder an hour of evidence;
// running it late costs the schedule its meaning, which is the more expensive of
// the two because the schedule is the thing an author is asked to trust.
func (server *Server) runLadderRound(now time.Time) {
	// Never during a drain. A round seats series that take minutes, and a deploy
	// waiting for games to finish should not have more started underneath it.
	if server.isUpdating() {
		return
	}
	slot := ladderRoundSlot(now)
	// The cheap gate, and the only one almost every tick reaches: for all but
	// the first few minutes of an hour there is nothing to decide and no lock
	// worth taking to decide it.
	if now.Sub(slot) > ladderRoundGrace {
		return
	}
	server.ladderPool.mu.Lock()
	if now.Sub(server.ladderPool.lastLook) < ladderTick {
		server.ladderPool.mu.Unlock()
		return
	}
	server.ladderPool.lastLook = now
	if !ladderRoundDue(now, server.ladderPool.lastRound) {
		server.ladderPool.mu.Unlock()
		return
	}
	server.ladderPool.mu.Unlock()

	ctx := context.Background()
	// The database, not the process, decides whether a round is due. A process
	// that has just started has no memory of the round its predecessor ran three
	// minutes ago, and the row is the only thing that outlives a deploy.
	state, err := server.data.LadderPool(ctx)
	if err != nil {
		log.Printf("ladder pool: read state: %v", err)
		return
	}
	last := time.UnixMilli(state.LastRoundAtUnixMs)
	if !ladderRoundDue(now, last) {
		server.ladderPool.mu.Lock()
		server.ladderPool.lastRound = last
		server.ladderPool.mu.Unlock()
		return
	}

	// Last hour's waiting pairings, written off before this hour's are chosen.
	// A pairing is an appointment for one round: carrying one into the next
	// would seat engines that have since been paired against somebody else.
	server.ladderPool.mu.Lock()
	server.ladderPool.held = nil
	server.ladderPool.mu.Unlock()

	seated := server.seatLadderRound(ctx, now)
	// Marked whether or not anything was seated. A round with nobody online is
	// a round that happened and found an empty room; retrying it every minute
	// until somebody connects would turn a quiet afternoon into a burst of
	// games the moment one engine appeared.
	//
	// At the slot rather than at now, so the row says which round ran rather
	// than how late the tick that noticed it was. That is the round's identity:
	// it is the moment the schedule published, and it is what the next process
	// to come up will compare its own slot against.
	if err := server.data.MarkLadderRound(ctx, slot.UnixMilli()); err != nil {
		log.Printf("ladder pool: mark round: %v", err)
	}
	server.ladderPool.mu.Lock()
	server.ladderPool.lastRound = slot
	server.ladderPool.mu.Unlock()

	if seated > 0 {
		log.Printf("ladder pool: seated %d pairings", seated)
	}
}

// ladderSeat is one engine the round could use.
type ladderSeat struct {
	persistence.LadderCandidate
	// variance is how unsure the board is about this engine, standing in for the
	// fit's own error bar. Recomputing that here would mean running the fit a
	// second time for a number the pairer only needs the ordering of, so this is
	// read off the two things that actually drive it: how much evidence there is
	// about the engine, and how long ago it arrived.
	variance float64
}

// seatLadderRound pairs and starts one round, returning how many pairings it
// seated.
func (server *Server) seatLadderRound(ctx context.Context, now time.Time) int {
	modeID, clock := ladderConditions(now)
	if !server.registry.Has(modeID) || !server.registry.Playable(modeID) {
		return 0
	}

	entrants, err := server.data.LadderEntrants(ctx, modeID)
	if err != nil {
		log.Printf("ladder pool: read entrants: %v", err)
		return 0
	}
	weights, err := server.data.LadderPairWeights(ctx, modeID, now.UnixMilli())
	if err != nil {
		log.Printf("ladder pool: read pair weights: %v", err)
		return 0
	}

	// Evidence per engine, summed over its matchups, so that the uncertainty
	// term below can be read off it. A pair worth 20 decayed games says a lot
	// about both of its ends; one worth 0.2 says almost nothing about either.
	evidence := make(map[string]float64, len(entrants))
	for pair, weight := range weights {
		evidence[pair[0]] += weight
		evidence[pair[1]] += weight
	}

	seats := make([]ladderSeat, 0, len(entrants))
	for _, entrant := range entrants {
		if !server.ladderBotIsAvailable(entrant.BotID, modeID) {
			continue
		}
		// 1/(1+evidence): one for an engine nobody has played, falling towards
		// zero as its record fills in. The shape matters more than the scale,
		// because this only ever multiplies a comparison between two pairings.
		seats = append(seats, ladderSeat{
			LadderCandidate: entrant,
			variance:        1 / (1 + evidence[entrant.UserID]),
		})
	}
	if len(seats) < ladderMinimumField {
		return 0
	}

	return server.startLadderPairings(
		ctx, modeID, clock, server.chooseLadderPairings(seats, weights),
	)
}

// ladderBotIsAvailable asks every question the series path will ask, before the
// pairer commits an engine to a matchup.
//
// Every one of these predicates already exists and every one is asked again
// inside StartBotSeries, which is what makes a failure here harmless rather than
// a source of drift. Asking early is about the pairing rather than the
// permission: a round that matched two engines and then found one of them
// benched would drop the pairing rather than repair it, and the second-best
// opponent would have gone unused.
//
// # The round never interrupts anything
//
// Worth being explicit about, because the opt-in rests on it and because the
// engines this now says yes to are precisely the ones that are busy.
//
// Nothing in the pool can stop a live game. The one mechanism in this server
// that does — the recall in bot_recall.go — is reachable from the tournament
// schedulers and from nowhere else. What makes a *waiting* pairing safe is that
// it starts through StartBotSeries like every other, and that call asks
// freeBotConnection: a slot is free only if it is not in a game and not
// reserved, so a round takes neither an engine that is playing nor one a series
// is holding between two of its games. That second case is the dangerous one,
// since the slot is briefly idle there and a check that only asked "playing
// right now" would take the seat out from under a run somebody started.
//
// # A busy engine is paired, not skipped
//
// A bot running three slots has told the server it can play three games at
// once, so if one is occupied the round uses a free one and the two run
// alongside each other — within what its owner configured. An owner who wants a
// hard ceiling on concurrent games sets max_games, which is the control that
// already means that.
//
// A bot with *no* free slot is still in the round: its pairing is held and
// started when the board clears. It used to be dropped, which meant an author
// whose engine happened to be playing a casual game at five to lost that hour's
// rated games having done nothing wrong. The budget is unchanged — one pairing,
// two games, and ladderBotStanding refuses an engine that is still playing the
// last round's — so entering the pool costs two games an hour on top of
// whatever the engine was already doing, and never more.
func (server *Server) ladderBotIsAvailable(botID string, modeID game.ModeID) bool {
	return server.ladderBotStanding(botID, modeID).In
}

// ladderBotStanding is what the round will do with an engine, in one answer.
//
// Three outcomes rather than two, and the third is the one that took a rewrite
// to get right. An engine in a game at the top of the hour used to be skipped:
// the pairer asked whether a slot was free, found none, and left it out of the
// round entirely — so an author who had their engine playing a casual game at
// five to lost that hour's rated games, having done nothing wrong and with the
// page cheerfully reporting it as unavailable.
//
// It is now paired like anybody else and its pairing waits. Nothing about the
// promise changes: the round still never interrupts a game, because starting is
// still `StartBotSeries`, which refuses while a slot is taken — see
// resumeHeldPairings for the waiting, which is the whole of the difference.
//
// The words are for an owner rather than for a log, so they name the thing to
// do about it where there is one. A bench and a shutdown are told apart here
// even though every offer path treats them alike, for the reason botHasOwnDrain
// gives: an owner during a bench has not asked for anything, and must not be
// shown a shutdown they did not start.
type ladderBotStanding struct {
	// In is whether the round will use this engine at all.
	In bool
	// Waiting is an engine the round will use as soon as it is free, rather
	// than at the top of the hour. In is true for these.
	Waiting bool
	// Reason is why the round will not use it, and empty when In.
	Reason string
}

func (server *Server) ladderBotStanding(
	botID string,
	modeID game.ModeID,
) ladderBotStanding {
	out := func(reason string) ladderBotStanding {
		return ladderBotStanding{Reason: reason}
	}
	client := server.readyBot(botID)
	if client == nil {
		return out("not connected")
	}
	if server.botsAreBenched(time.Now()) {
		return out("all engines are benched")
	}
	if botHasOwnDrain(client) {
		return out("shutting down")
	}
	if reservation := server.botReservation(client.account.UserID); reservation != "" {
		return out("held in reserve for " + reservation)
	}
	client.bot.mu.Lock()
	handshake := client.bot.handshake
	client.bot.mu.Unlock()
	if !handshake.Supports(modeID) {
		return out("does not play " + server.modeNameFor(modeID))
	}
	// Already playing its round, which is the one case a busy engine is *not*
	// waiting for a new pairing.
	//
	// This is what keeps "one pairing at a time" true now that a pairing can
	// start late. A held pairing from the last hour may only get going at five
	// to, and without this the next round would pair those engines again on top
	// of the games they are still playing — two rounds at once, which is twice
	// the budget entering the pool is supposed to cost.
	if server.botSeriesRuns.inLadderRun(botID) {
		return out("playing this hour's round")
	}
	// A bot with three slots is playing and available at the same time — see
	// freeBotConnection — so this is genuinely "every slot is taken". It is the
	// last question asked because it is the only one whose answer does not keep
	// the engine out of the round.
	if server.freeBotConnection(botID) == nil {
		return ladderBotStanding{In: true, Waiting: true}
	}
	return ladderBotStanding{In: true}
}

// ladderPairing is two engines the round has decided to seat.
type ladderPairing struct {
	first  string // bot id
	second string
	value  float64
}

// chooseLadderPairings scores every admissible pair and takes the best set of
// them that shares no engine.
//
// Greedy over the sorted scores rather than a proper maximum-weight matching.
// The difference is a few per cent of total information on a board of this size,
// and it costs a page of Blossom; more to the point, the scores are estimates of
// how much a game would teach, so an exactly optimal set of approximate values
// is not worth the code.
func (server *Server) chooseLadderPairings(
	seats []ladderSeat,
	weights map[[2]string]float64,
) []ladderPairing {
	candidates := make([]ladderPairing, 0, len(seats)*len(seats)/2)
	for first := range seats {
		for second := first + 1; second < len(seats); second++ {
			one, other := seats[first], seats[second]
			// Two engines one person owns produce no rating — the fit drops the
			// pair whatever the flag on the game says — so seating them would
			// spend both engines' round on a game the ladder never hears about.
			if one.OwnerUserID != "" && one.OwnerUserID == other.OwnerUserID {
				continue
			}
			// Two yardsticks against each other is not wasted: the staircase is
			// how the scale reaches the top of the board, and those rungs need
			// measuring against each other like anybody else. It is only ever a
			// small part of a round because the headroom term saturates.
			value := ladderPairValue(one, other, weights)
			if value <= 0 {
				continue
			}
			candidates = append(candidates, ladderPairing{
				first: one.BotID, second: other.BotID, value: value,
			})
		}
	}
	// Ties broken on the ids so a round is the same round whichever order the
	// database handed the entrants over in.
	sort.Slice(candidates, func(first, second int) bool {
		if candidates[first].value != candidates[second].value {
			return candidates[first].value > candidates[second].value
		}
		if candidates[first].first != candidates[second].first {
			return candidates[first].first < candidates[second].first
		}
		return candidates[first].second < candidates[second].second
	})

	used := make(map[string]int, len(seats))
	chosen := make([]ladderPairing, 0, len(seats)/2)
	for _, candidate := range candidates {
		if used[candidate.first] >= ladderMaxRoundsPerBot ||
			used[candidate.second] >= ladderMaxRoundsPerBot {
			continue
		}
		used[candidate.first]++
		used[candidate.second]++
		chosen = append(chosen, candidate)
	}
	return chosen
}

// ladderPairValue is how much the ladder would learn from playing these two.
//
// The three terms are explained at the top of the file. What is worth repeating
// here is that the first of them is not a similarity heuristic dressed up: it is
// the Bradley-Terry information contribution for this matchup, the same n*p(1-p)
// the fit's error bars are built from, so the pool and the rating are optimising
// one quantity from two directions.
func ladderPairValue(
	one ladderSeat,
	other ladderSeat,
	weights map[[2]string]float64,
) float64 {
	chance := persistence.RatingWinProbability(one.Rating, other.Rating)
	information := chance * (1 - chance)

	low, high := one.UserID, other.UserID
	if high < low {
		low, high = high, low
	}
	headroom := 1 - weights[[2]string{low, high}]/persistence.LadderPairCap
	if headroom <= 0 {
		// Played to the cap and still fresh. Not zero, because the record decays
		// and a pair that is finished with today is worth revisiting eventually,
		// and because a small field could otherwise have no admissible pairing
		// at all. Small enough that anything unplayed outranks it.
		headroom = 0.01
	}
	return information * headroom * (one.variance + other.variance)
}

// startLadderPairings seats the chosen pairings as ranked series.
//
// Through StartBotSeries rather than through startConfiguredMatch directly,
// which is the reuse that makes this file short. A series already knows how to
// hold both engines' slots between games, replay one opening with the colours
// swapped, notice an engine that disappeared mid-run and pick it up again when
// it comes back, and abort cleanly on a deploy. A pairer that seated raw games
// would need all of that again and would get the reconnection case wrong.
func (server *Server) startLadderPairings(
	ctx context.Context,
	modeID game.ModeID,
	clock game.TimeControl,
	pairings []ladderPairing,
) int {
	seated, held := 0, make([]ladderHeld, 0, len(pairings))
	for _, pairing := range pairings {
		err := server.startLadderPairing(ctx, modeID, clock, pairing)
		switch {
		case err == nil:
			seated++
		case errors.Is(err, errSeriesBotBusy):
			// The engine is in a game, so this pairing waits for it rather than
			// being dropped. That is the whole of what the pool now promises an
			// author whose engine was mid-game at the hour: the round is theirs,
			// it just starts when the board is clear. See resumeHeldPairings.
			held = append(held, ladderHeld{pairing: pairing, modeID: modeID, clock: clock})
		default:
			// Everything else is a pairing that will not become startable by
			// waiting — an engine that went offline, started draining or was
			// reserved between the pairer looking and this call. Dropped rather
			// than repaired; its engines get the next round.
			log.Printf("ladder pool: could not seat %s against %s: %v",
				pairing.first, pairing.second, err)
		}
	}

	server.ladderPool.mu.Lock()
	// Assigned rather than appended: these are *this* round's pairings, and the
	// previous round's have already been written off by the caller.
	server.ladderPool.held = held
	server.ladderPool.mu.Unlock()
	if len(held) > 0 {
		log.Printf("ladder pool: holding %d pairings for engines still playing", len(held))
	}
	return seated
}

// startLadderPairing seats one pairing as a ranked series.
func (server *Server) startLadderPairing(
	ctx context.Context,
	modeID game.ModeID,
	clock game.TimeControl,
	pairing ladderPairing,
) error {
	_, err := server.StartBotSeries(ctx, BotSeriesRequest{
		FirstBotID:   pairing.first,
		SecondBotID:  pairing.second,
		ModeID:       modeID,
		Pairs:        1,
		OpeningPlies: ladderOpeningPlies,
		Control:      clock,
		// Privileged, because the public ceilings are about one person not
		// monopolising the fleet and the server is not a person. Ladder,
		// because that is the flag that makes the games ranked, and it is
		// set here and nowhere else.
		Privileged: true,
		Ladder:     true,
	})
	return err
}

// resumeHeldPairings starts the round's waiting pairings as their engines come
// free, and is the other half of runLadderRound.
//
// The pairing is decided at the top of the hour and only its *start* moves,
// which is the property worth protecting: an engine that was busy is not
// re-paired against whoever happens to be idle later, it plays the opponent the
// round chose for it. So this retries the same pairing rather than re-running
// the pairer.
//
// Cheap enough to run on every tick. StartBotSeries asks its four questions
// about connections and slots before it touches the database or mints an id, so
// a retry that finds an engine still playing costs a handful of map lookups —
// and a game can finish at any second, so a coarser gate would be minutes of
// two idle engines with a pairing waiting for them.
//
// Nothing here can outlive its hour: runLadderRound writes this list off when
// the next round is seated. A pairing that never became startable is simply an
// hour those two engines did not play, which is the same outcome the old
// skip-and-drop had — it just stopped being the outcome for the common case.
func (server *Server) resumeHeldPairings(ctx context.Context) {
	// Never during a drain, matching runLadderRound: a deploy waiting for games
	// to finish should not have more started underneath it.
	if server.isUpdating() {
		return
	}
	server.ladderPool.mu.Lock()
	held := append([]ladderHeld(nil), server.ladderPool.held...)
	server.ladderPool.mu.Unlock()
	if len(held) == 0 {
		return
	}

	remaining := make([]ladderHeld, 0, len(held))
	started := 0
	for _, waiting := range held {
		err := server.startLadderPairing(ctx, waiting.modeID, waiting.clock, waiting.pairing)
		switch {
		case err == nil:
			started++
		case errors.Is(err, errSeriesBotBusy):
			remaining = append(remaining, waiting)
		default:
			// Gone rather than busy. Logged once, here, rather than every tick
			// for the rest of the hour.
			log.Printf("ladder pool: gave up on %s against %s: %v",
				waiting.pairing.first, waiting.pairing.second, err)
		}
	}

	server.ladderPool.mu.Lock()
	// Rebuilt from what was read above rather than filtered in place, and this
	// is the one race worth naming: a round seated between the read and here
	// would have replaced the list, and writing `remaining` over it would
	// resurrect the previous hour's pairings. Both paths run on the one lobby
	// ticker, in the same goroutine, so that ordering cannot happen — and if
	// this ever moves off that ticker, the list needs a round stamp.
	server.ladderPool.held = remaining
	server.ladderPool.mu.Unlock()
	if started > 0 {
		log.Printf("ladder pool: started %d held pairings", started)
	}
}

// LadderRoundPreview is what the pool is doing and what it will do next.
//
// Published because a schedule nobody can see is indistinguishable from a random
// one, and "the conditions are not yours to choose" only sounds fair if the
// conditions are visible in advance.
type LadderRoundPreview struct {
	ModeID        game.ModeID `json:"modeId"`
	InitialTimeMs int64       `json:"initialTimeMs"`
	IncrementMs   int64       `json:"incrementMs"`
	AtUnixMs      int64       `json:"atUnixMs"`
	// Entered is how many engines are online, consenting and able to play this
	// round's mode.
	Entered int `json:"entered"`
}

// ladderSchedule is this round and the next few, with the current field size.
//
// The head is the round that is owed, so during the few minutes of grace after
// an hour it is a moment just past rather than one in the future — a reader
// after the next start counts from the first entry later than now, the way
// ladderRoundView does.
func (server *Server) ladderSchedule(ctx context.Context, now time.Time, ahead int) []LadderRoundPreview {
	state, err := server.data.LadderPool(ctx)
	if err != nil {
		log.Printf("ladder pool: read state: %v", err)
		return nil
	}
	next := nextLadderRound(now, time.UnixMilli(state.LastRoundAtUnixMs))

	previews := make([]LadderRoundPreview, 0, ahead)
	for index := range ahead {
		at := next.Add(time.Duration(index) * ladderRoundInterval)
		modeID, clock := ladderConditions(at)
		preview := LadderRoundPreview{
			ModeID:        modeID,
			InitialTimeMs: clock.InitialTimeMs,
			IncrementMs:   clock.IncrementMs,
			AtUnixMs:      at.UnixMilli(),
		}
		if index == 0 {
			preview.Entered = server.ladderFieldSize(ctx, modeID)
		}
		previews = append(previews, preview)
	}
	return previews
}

// ladderFieldSize is how many engines would be available for a round right now.
func (server *Server) ladderFieldSize(ctx context.Context, modeID game.ModeID) int {
	entrants, err := server.data.LadderEntrants(ctx, modeID)
	if err != nil {
		return 0
	}
	field := 0
	for _, entrant := range entrants {
		if server.ladderBotIsAvailable(entrant.BotID, modeID) {
			field++
		}
	}
	return field
}

// getLadderPool publishes the schedule and the current field.
//
// Public and unauthenticated, because "the conditions are not yours to choose"
// only reads as fair if anybody can see what they are going to be. An author
// deciding whether to enter wants to know what their engine is signing up for,
// and an author who thinks a round went against them wants to be able to check
// that it ran under the conditions the schedule said it would.
func (server *Server) getLadderPool(writer http.ResponseWriter, request *http.Request) {
	state, err := server.data.LadderPool(request.Context())
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not read the ladder pool")
		return
	}
	yardsticks, err := server.data.BotYardsticks(request.Context())
	if err != nil {
		writeAPIError(writer, http.StatusInternalServerError, "could not read the yardsticks")
		return
	}
	writeJSON(writer, http.StatusOK, map[string]any{
		"roundsRun":         state.RoundsRun,
		"lastRoundAtUnixMs": state.LastRoundAtUnixMs,
		"intervalMs":        ladderRoundInterval.Milliseconds(),
		// How late a slot may still be seated, which a client needs in order to
		// work out which round the head of the schedule is. See
		// nextLadderRound, and ladderRoundView on the client: the head is a
		// moment in the past for as long as its round is still owed, and a
		// reader who moved past it on that basis alone would count down to the
		// wrong hour for the few minutes an hour that is true.
		"graceMs":         ladderRoundGrace.Milliseconds(),
		"gamesPerRound":   2 * ladderMaxRoundsPerBot,
		"schedule":        server.ladderSchedule(request.Context(), time.Now(), 6),
		"anchorBotId":     yardsticks.AnchorBotID,
		"yardstickBotIds": append([]string{yardsticks.AnchorBotID}, yardsticks.RungBotIDs...),
		// The two numbers that define the scale, served rather than restated in
		// the client, so a front end cannot drift from the fit.
		"ratingFloor":             persistence.RatingFloor,
		"ratingPointsPerDoubling": persistence.RatingPointsPerDoubling,
	})
}

// botIsYardstick reports whether a bot is one of the server's reference engines.
//
// Cached on the server rather than read from the database, because it is asked
// on the challenge path and the answer changes about once a year. The cache is
// filled at startup and invalidated whenever an administrator sets a reference
// kind, which are the only two moments it can move.
func (server *Server) botIsYardstick(botID string) bool {
	if botID == "" {
		return false
	}
	server.ladderPool.mu.Lock()
	defer server.ladderPool.mu.Unlock()
	if server.ladderPool.yardsticks == nil {
		yardsticks, err := server.data.BotYardsticks(context.Background())
		if err != nil {
			// Refusing to answer would make every challenge casual, which is the
			// safe direction: a game that should have been rated and was not is
			// a disappointment, and one that was rated on a guess is a wrong
			// number on the board.
			log.Printf("ladder pool: read yardsticks: %v", err)
			return false
		}
		known := map[string]bool{}
		if yardsticks.AnchorBotID != "" {
			known[yardsticks.AnchorBotID] = true
		}
		for _, rung := range yardsticks.RungBotIDs {
			known[rung] = true
		}
		server.ladderPool.yardsticks = known
	}
	return server.ladderPool.yardsticks[botID]
}

// forgetYardsticks drops the cache above, for the one route that can change it.
func (server *Server) forgetYardsticks() {
	server.ladderPool.mu.Lock()
	defer server.ladderPool.mu.Unlock()
	server.ladderPool.yardsticks = nil
}
