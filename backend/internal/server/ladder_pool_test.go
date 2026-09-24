package server

import (
	"strings"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
	"rps-strategy/backend/internal/rpsi"
)

// everyModeHandshake is an engine that plays everything, so a pairing test is
// never about which modes a fixture happened to declare.
func everyModeHandshake() rpsi.Handshake {
	return rpsi.Handshake{
		Name:     "test",
		Protocol: 1,
		Modes: []game.ModeID{
			game.ModeTotalWar, game.ModeInfiltration, game.ModeIntransitive,
		},
	}
}

// poolBot connects an engine that has consented to the ranked pool.
func poolBot(t *testing.T, server *Server, name string, owner string) persistence.Bot {
	t.Helper()
	// Registering the same owner twice is how a same-owner pairing is built, so
	// a second claim under a name already taken is expected rather than fatal.
	_, err := server.data.ClaimAccountWithDiscord(
		t.Context(), owner, "Owner_"+owner, "discord-"+owner, owner,
	)
	if err != nil && !ownerAlreadyRegistered(t, server, owner) {
		t.Fatalf("register owner %s: %v", owner, err)
	}
	_, token, err := server.data.MintBotToken(t.Context(), owner)
	if err != nil {
		t.Fatalf("mint %s: %v", name, err)
	}
	bot, err := server.data.ClaimBot(t.Context(), token, persistence.BotSettings{Name: name})
	if err != nil {
		t.Fatalf("claim %s: %v", name, err)
	}
	account, err := server.data.Account(t.Context(), bot.UserID)
	if err != nil {
		t.Fatalf("load account for %s: %v", name, err)
	}
	client := &Client{
		send:    make(chan []byte, 256),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: bot.UserID, Username: bot.Name},
		account: account,
		server:  server,
		bot: &botClient{
			botID:     bot.BotID,
			record:    bot,
			ready:     true,
			handshake: everyModeHandshake(),
		},
	}
	server.hub.Register(client)
	t.Cleanup(func() { server.hub.Unregister(client) })
	server.mu.Lock()
	server.bots[bot.BotID] = []*Client{client}
	server.mu.Unlock()
	return bot
}

// poolSeats is what the pairer would see right now.
// ownerAlreadyRegistered reports whether this owner exists and can mint bots.
func ownerAlreadyRegistered(t *testing.T, server *Server, owner string) bool {
	t.Helper()
	_, err := server.data.Account(t.Context(), owner)
	return err == nil
}

func poolSeats(t *testing.T, server *Server, modeID game.ModeID) []ladderSeat {
	t.Helper()
	entrants, err := server.data.LadderEntrants(t.Context(), modeID)
	if err != nil {
		t.Fatalf("read entrants: %v", err)
	}
	seats := make([]ladderSeat, 0, len(entrants))
	for _, entrant := range entrants {
		if !server.ladderBotIsAvailable(entrant.BotID, modeID) {
			continue
		}
		seats = append(seats, ladderSeat{LadderCandidate: entrant, variance: 1})
	}
	return seats
}

func poolNames(server *Server, pairings []ladderPairing) []string {
	names := make([]string, 0, len(pairings))
	for _, pairing := range pairings {
		names = append(names, botName(server, pairing.first)+" v "+botName(server, pairing.second))
	}
	return names
}

func botName(server *Server, botID string) string {
	server.mu.Lock()
	defer server.mu.Unlock()
	for _, connections := range server.bots {
		for _, client := range connections {
			if client.bot.botID == botID {
				return client.profile.Username
			}
		}
	}
	return botID
}

// Consent is the whole reason the switch exists: an author who does not want
// their machine running games on somebody else's schedule must not have them
// run anyway.
func TestTheRoundLeavesOutEnginesThatHaveNotEntered(t *testing.T) {
	server := ladderTestServer(t)
	entered := poolBot(t, server, "Entered", "owner-entered")
	declined := poolBot(t, server, "Declined", "owner-declined")
	other := poolBot(t, server, "Other", "owner-other")
	if _, err := server.data.UpdateBotSettings(
		t.Context(), declined.BotID, true, true, false, "",
	); err != nil {
		t.Fatalf("opt out: %v", err)
	}

	entrants, err := server.data.LadderEntrants(t.Context(), game.ModeTotalWar)
	if err != nil {
		t.Fatalf("read entrants: %v", err)
	}
	for _, entrant := range entrants {
		if entrant.BotID == declined.BotID {
			t.Fatal("an engine that opted out was listed as an entrant")
		}
	}
	seen := map[string]bool{}
	for _, entrant := range entrants {
		seen[entrant.BotID] = true
	}
	if !seen[entered.BotID] || !seen[other.BotID] {
		t.Fatalf("an engine that entered was left out: %#v", entrants)
	}
}

// A yardstick is in the pool whatever anybody's settings say. Consent is a
// question for a person lending their machine, and these run on the server's.
func TestAYardstickIsAlwaysInThePool(t *testing.T) {
	server := ladderTestServer(t)
	anchor := poolBot(t, server, "Anchor", "owner-anchor")
	markLadderAnchor(t, server, anchor)
	if _, err := server.data.UpdateBotSettings(
		t.Context(), anchor.BotID, false, false, false, "",
	); err != nil {
		t.Fatalf("opt out: %v", err)
	}

	entrants, err := server.data.LadderEntrants(t.Context(), game.ModeTotalWar)
	if err != nil {
		t.Fatalf("read entrants: %v", err)
	}
	for _, entrant := range entrants {
		if entrant.BotID == anchor.BotID {
			return
		}
	}
	t.Fatalf("the anchor opted itself out of the pool: %#v", entrants)
}

// Two engines one person registered are never paired. The fit drops the pair
// whatever the game says, so seating them would spend both engines' round on a
// result the ladder never hears about.
func TestTheRoundNeverPairsOneOwnersEngines(t *testing.T) {
	server := ladderTestServer(t)
	poolBot(t, server, "Mine-1", "one-owner")
	poolBot(t, server, "Mine-2", "one-owner")
	poolBot(t, server, "Rival", "other-owner")

	seats := poolSeats(t, server, game.ModeTotalWar)
	if len(seats) != 3 {
		t.Fatalf("expected three seats, got %d", len(seats))
	}
	for _, pairing := range server.chooseLadderPairings(seats, nil) {
		one, other := seatFor(seats, pairing.first), seatFor(seats, pairing.second)
		if one.OwnerUserID == other.OwnerUserID {
			t.Fatalf("the round paired one owner's engines: %v",
				poolNames(server, []ladderPairing{pairing}))
		}
	}
}

func seatFor(seats []ladderSeat, botID string) ladderSeat {
	for _, seat := range seats {
		if seat.BotID == botID {
			return seat
		}
	}
	return ladderSeat{}
}

// Closer in rating beats further away, because p(1-p) peaks at even odds. This
// is the "less random" the community asked for, and it is not a rule bolted on
// top — it is the information one game carries, which is the same term the
// rating's error bars are built from.
func TestTheRoundPrefersAnOpponentOfSimilarStrength(t *testing.T) {
	near := ladderSeat{
		LadderCandidate: persistence.LadderCandidate{
			BotID: "near", UserID: "u-near", OwnerUserID: "o-near", Rating: 102,
		},
		variance: 1,
	}
	far := ladderSeat{
		LadderCandidate: persistence.LadderCandidate{
			BotID: "far", UserID: "u-far", OwnerUserID: "o-far", Rating: 20,
		},
		variance: 1,
	}
	subject := ladderSeat{
		LadderCandidate: persistence.LadderCandidate{
			BotID: "subject", UserID: "u-subject", OwnerUserID: "o-subject", Rating: 100,
		},
		variance: 1,
	}
	if ladderPairValue(subject, near, nil) <= ladderPairValue(subject, far, nil) {
		t.Fatal("a mismatch was scored at least as high as an even matchup")
	}
	// But not to the exclusion of everything else: a distant pairing is still
	// worth something, because a board that only ever played its neighbours
	// would separate into bands with nothing joining them, and every rating here
	// is a distance from the anchor along a chain of matchups.
	if ladderPairValue(subject, far, nil) <= 0 {
		t.Fatal("a mismatch was scored at zero, so the ladder could never connect")
	}
}

// A matchup played to the cap has nothing left to teach, so an unplayed opponent
// wins even when it is further away in rating. This is what spreads a round out
// instead of letting two engines lock into each other every hour.
func TestTheRoundPrefersAnOpponentItHasNotSeen(t *testing.T) {
	seat := func(id string, rating int) ladderSeat {
		return ladderSeat{
			LadderCandidate: persistence.LadderCandidate{
				BotID: id, UserID: "u-" + id, OwnerUserID: "o-" + id, Rating: rating,
			},
			variance: 1,
		}
	}
	subject, played, fresh := seat("subject", 100), seat("played", 100), seat("fresh", 130)
	weights := map[[2]string]float64{
		pairKeyOf(subject.UserID, played.UserID): persistence.LadderPairCap,
	}
	if ladderPairValue(subject, fresh, weights) <=
		ladderPairValue(subject, played, weights) {
		t.Fatal("a matchup already at the cap outranked one never played")
	}
}

func pairKeyOf(one string, other string) [2]string {
	if other < one {
		one, other = other, one
	}
	return [2]string{one, other}
}

// A new engine's first ranked opponent is a yardstick, which is the on-ramp and
// the anti-farm guarantee in one move: the games that put a newcomer on the
// scale are against an engine nobody owns and nobody could have tuned to lose.
func TestANewEnginesFirstOpponentIsAYardstick(t *testing.T) {
	server := ladderTestServer(t)
	anchor := poolBot(t, server, "Anchor", "owner-anchor")
	markLadderAnchor(t, server, anchor)
	newcomer := poolBot(t, server, "Newcomer", "owner-newcomer")

	seats := poolSeats(t, server, game.ModeTotalWar)
	pairings := server.chooseLadderPairings(seats, nil)
	if len(pairings) != 1 {
		t.Fatalf("expected one pairing, got %v", poolNames(server, pairings))
	}
	paired := pairings[0].first == newcomer.BotID && pairings[0].second == anchor.BotID ||
		pairings[0].first == anchor.BotID && pairings[0].second == newcomer.BotID
	if !paired {
		t.Fatalf("a newcomer was not paired with the anchor: %v",
			poolNames(server, pairings))
	}
}

// One pairing per engine per round. The budget is the whole answer to "will this
// eat my machine", and it has to be true rather than approximately true.
func TestNoEnginePlaysTwiceInOneRound(t *testing.T) {
	server := ladderTestServer(t)
	for _, name := range []string{"A", "B", "C", "D", "E"} {
		poolBot(t, server, "Bot"+name, "owner-"+strings.ToLower(name))
	}
	seats := poolSeats(t, server, game.ModeTotalWar)
	counted := map[string]int{}
	for _, pairing := range server.chooseLadderPairings(seats, nil) {
		counted[pairing.first]++
		counted[pairing.second]++
	}
	for botID, times := range counted {
		if times > ladderMaxRoundsPerBot {
			t.Fatalf("%s was seated %d times in one round", botName(server, botID), times)
		}
	}
	// Five engines is two pairings and a bye, not two and a half.
	if len(counted) != 4 {
		t.Fatalf("expected four engines seated out of five, got %d", len(counted))
	}
}

// The conditions come from the clock, not from anybody's request, and the same
// hour always gives the same answer. A schedule nobody can predict is a schedule
// nobody can check.
func TestTheRoundsConditionsAreFixedByTheHour(t *testing.T) {
	at := time.Date(2026, 9, 11, 14, 0, 0, 0, time.UTC)
	mode, clock := ladderConditions(at)
	for range 5 {
		againMode, againClock := ladderConditions(at.Add(37 * time.Minute))
		if againMode != mode || againClock != clock {
			t.Fatalf("the conditions moved within the hour: %s/%v then %s/%v",
				mode, clock, againMode, againClock)
		}
	}
	// And they do move between hours, or the rotation is not one.
	changed := false
	for hour := 1; hour <= len(ladderClocks)*len(ladderModes); hour++ {
		nextMode, nextClock := ladderConditions(at.Add(time.Duration(hour) * time.Hour))
		if nextMode != mode || nextClock != clock {
			changed = true
			break
		}
	}
	if !changed {
		t.Fatal("every hour has the same conditions, so there is no rotation")
	}
}

// The round is owed from its slot until the grace runs out, and no longer.
//
// The two halves of "on the hour, not necessarily every hour" in one table: a
// tick a little after the hour still gets the round it was late for, and a tick
// long after it gets nothing, because a round seated at twenty past is not the
// round anybody was told about.
func TestARoundIsOwedFromItsSlotUntilTheGraceRunsOut(t *testing.T) {
	slot := time.Date(2026, 9, 11, 14, 0, 0, 0, time.UTC)
	previous := slot.Add(-ladderRoundInterval)
	cases := []struct {
		what string
		now  time.Time
		last time.Time
		owed bool
	}{
		{"on the hour", slot, previous, true},
		{"a tick after it", slot.Add(40 * time.Second), previous, true},
		{"a restart at the edge of the grace", slot.Add(ladderRoundGrace), previous, true},
		{"past the grace", slot.Add(ladderRoundGrace + time.Minute), previous, false},
		{"most of the way to the next slot", slot.Add(47 * time.Minute), previous, false},
		{"a second later on a round that ran", slot.Add(time.Second), slot, false},
		{"a pool that has never run", slot, time.Time{}, true},
		{"a server that was down for two hours", slot, slot.Add(-3 * ladderRoundInterval), true},
	}
	for _, test := range cases {
		if owed := ladderRoundDue(test.now, test.last); owed != test.owed {
			t.Errorf("%s: owed = %v, want %v", test.what, owed, test.owed)
		}
	}
}

// What the schedule promises is the clock, not the last round.
//
// This is the whole reason the slots are the hours: an author reading the
// published schedule gets the same answer as the server, and a deploy in the
// middle of the afternoon does not move every round after it.
func TestTheNextRoundIsTheClockRatherThanTheLastRound(t *testing.T) {
	hour := time.Date(2026, 9, 11, 14, 0, 0, 0, time.UTC)
	cases := []struct {
		what string
		now  time.Time
		last time.Time
		want time.Time
	}{
		{"mid-hour", hour.Add(37 * time.Minute), hour, hour.Add(time.Hour)},
		{"owed and about to run", hour.Add(20 * time.Second), hour.Add(-time.Hour), hour},
		{"just run", hour.Add(2 * time.Minute), hour, hour.Add(time.Hour)},
		{
			"after a long outage",
			hour.Add(37 * time.Minute),
			hour.Add(-3 * time.Hour),
			hour.Add(time.Hour),
		},
	}
	for _, test := range cases {
		if next := nextLadderRound(test.now, test.last); !next.Equal(test.want) {
			t.Errorf("%s: next round at %v, want %v", test.what, next, test.want)
		}
	}
}

// ladderState is what the pool has recorded about itself.
func ladderState(t *testing.T, server *Server) persistence.LadderPoolState {
	t.Helper()
	state, err := server.data.LadderPool(t.Context())
	if err != nil {
		t.Fatalf("read ladder pool: %v", err)
	}
	return state
}

// The pool through its own entry point, over an afternoon.
//
// A round on the hour and only on the hour; an hour that got away skipped
// rather than made up; and a process that comes up mid-round deferring to the
// row rather than to its own empty memory. The unit tables above say what the
// rule is, and this says the ticker actually applies it — which is the part
// that used to be wrong, because the old gate measured an hour from whenever
// the process last managed to run one.
func TestThePoolRunsOnTheHourAndSkipsTheHoursItMisses(t *testing.T) {
	server := ladderTestServer(t)
	hour := time.Date(2026, 9, 11, 14, 0, 0, 0, time.UTC)

	// A server that comes up at twenty to does not start an hourly cycle of its
	// own from where it happens to have started.
	server.runLadderRound(hour.Add(-20 * time.Minute))
	if state := ladderState(t, server); state.RoundsRun != 0 {
		t.Fatalf("a round ran off the hour: %+v", state)
	}

	// On the hour it runs, and the row carries the slot rather than the tick
	// that noticed it — that number is what the schedule published.
	server.runLadderRound(hour.Add(20 * time.Second))
	state := ladderState(t, server)
	if state.RoundsRun != 1 {
		t.Fatalf("no round on the hour: %+v", state)
	}
	if state.LastRoundAtUnixMs != hour.UnixMilli() {
		t.Fatalf("the round was recorded at %v, not at %v",
			time.UnixMilli(state.LastRoundAtUnixMs).UTC(), hour)
	}

	// And not again for the rest of the hour, however many ticks arrive.
	for _, later := range []time.Duration{2 * time.Minute, 31 * time.Minute, 59 * time.Minute} {
		server.runLadderRound(hour.Add(later))
	}
	if state := ladderState(t, server); state.RoundsRun != 1 {
		t.Fatalf("the hour ran %d rounds", state.RoundsRun)
	}

	// The next hour is missed entirely — a drain, a restart, a host that was
	// busy — and the pool does not make it up at twenty past.
	server.runLadderRound(hour.Add(time.Hour).Add(20 * time.Minute))
	if state := ladderState(t, server); state.RoundsRun != 1 {
		t.Fatalf("a missed hour was run late: %+v", state)
	}

	// The hour after that is a round again, on the hour.
	server.runLadderRound(hour.Add(2 * time.Hour))
	state = ladderState(t, server)
	if state.RoundsRun != 2 {
		t.Fatalf("the next hour did not run: %+v", state)
	}
	if state.LastRoundAtUnixMs != hour.Add(2*time.Hour).UnixMilli() {
		t.Fatalf("the second round was recorded at %v",
			time.UnixMilli(state.LastRoundAtUnixMs).UTC())
	}

	// A process that came up three minutes later has no memory of any of this,
	// and the grace window is still open. The row is what stops it.
	server.ladderPool.mu.Lock()
	server.ladderPool.lastLook, server.ladderPool.lastRound = time.Time{}, time.Time{}
	server.ladderPool.mu.Unlock()
	server.runLadderRound(hour.Add(2 * time.Hour).Add(3 * time.Minute))
	if state := ladderState(t, server); state.RoundsRun != 2 {
		t.Fatalf("a restart re-ran the round: %+v", state)
	}
}

// awaitEverySeriesFinished waits until no run is still playing.
func awaitEverySeriesFinished(t *testing.T, server *Server) {
	t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		list, err := server.data.BotSeriesList(t.Context(), 50)
		if err != nil {
			t.Fatalf("read series list: %v", err)
		}
		running := false
		for _, series := range list {
			if series.Status == persistence.BotSeriesRunning {
				running = true
				break
			}
		}
		if !running {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("a series never finished")
}

// The round, end to end: the pool chooses the pairing, seats it, the engines
// play it, and the refit turns it into a rating.
//
// The one test that runs the whole mechanism rather than a piece of it. Every
// step above is arguable in isolation — a pairing rule proves nothing if the
// round never seats, and a seated round proves nothing if the games come out
// casual — so this asserts the thing the three community complaints were
// actually about: that an engine which does nothing but stay connected ends up
// with a rating it did not have to arrange.
func TestARoundSeatsItselfPlaysAndProducesARating(t *testing.T) {
	server, alpha, _ := seriesTestBots(t)
	anchor := addRivalSeriesBot(t, server, "Anchor")
	markLadderAnchor(t, server, anchor)
	rival := addRivalSeriesBot(t, server, "Rival")

	// Nobody asks for anything. The clock comes round and the server does the
	// rest — which is the entire point of the pool.
	now := time.Now()
	modeID, _ := ladderConditions(now)
	if seated := server.seatLadderRound(t.Context(), now); seated == 0 {
		t.Fatal("the round seated nothing")
	}
	// Every run, not just the newest: a round seats as many pairings as the
	// field allows and they play at the same time, so waiting on the latest
	// series id would return while another was still going.
	awaitEverySeriesFinished(t, server)

	history, err := server.data.GameHistory(t.Context(), anchor.UserID, 20, 0)
	if err != nil {
		t.Fatalf("read history: %v", err)
	}
	if len(history) == 0 {
		t.Fatal("the round produced no games")
	}
	ranked := 0
	for _, played := range history {
		if played.Ranked {
			ranked++
		}
		if played.ModeID != modeID {
			t.Fatalf("a round game was played in %s, not the hour's %s",
				played.ModeID, modeID)
		}
	}
	if ranked == 0 {
		t.Fatal("a round the server arranged produced no ranked games")
	}
	// Both colours, because engines are deterministic and Blue moves first: an
	// unswapped pairing measures the opening as much as the engines.
	colours := map[string]bool{}
	for _, played := range history {
		colours[played.RedPlayer.UserID] = true
	}
	if len(colours) < 2 {
		t.Fatalf("the pairing did not swap colours: %#v", colours)
	}

	if err := server.data.RefitBotLadder(t.Context(), modeID); err != nil {
		t.Fatalf("refit: %v", err)
	}
	ratings, err := server.data.BotModeRatings(t.Context(), modeID)
	if err != nil {
		t.Fatalf("read ladder: %v", err)
	}
	if ratings[anchor.UserID] != persistence.RatingFloor {
		t.Fatalf("the anchor is not at the floor: %d", ratings[anchor.UserID])
	}
	// Somebody played somebody, so at least one engine is now placed against the
	// anchor. Which one depends on how the stub engines happened to play, so the
	// assertion is that the board exists rather than what order it is in.
	placed := 0
	for _, bot := range []persistence.Bot{alpha, rival} {
		if _, rated := ratings[bot.UserID]; rated {
			placed++
		}
	}
	if placed == 0 {
		t.Fatalf("nobody came out of the round rated: %#v", ratings)
	}
}

// putBotInAGame seats a bot's slot in a live game, the way startConfiguredMatch
// does, so a test can ask what the round makes of an engine that is busy.
func putBotInAGame(t *testing.T, server *Server, botID string) {
	t.Helper()
	server.mu.Lock()
	defer server.mu.Unlock()
	for _, client := range server.bots[botID] {
		server.participants[client] = Participant{
			session: &GameSession{gameID: "in-progress"}, color: game.Red,
		}
		return
	}
	t.Fatalf("no connection for %s", botID)
}

// freeBotFromItsGame is the other half of putBotInAGame: the game ends, the
// slot is free, and the pool's held pairing has something to start on.
func freeBotFromItsGame(t *testing.T, server *Server, botID string) {
	t.Helper()
	server.mu.Lock()
	defer server.mu.Unlock()
	for _, client := range server.bots[botID] {
		delete(server.participants, client)
	}
}

// heldPairings is what the round is still waiting to start.
func heldPairings(server *Server) []ladderHeld {
	server.ladderPool.mu.Lock()
	defer server.ladderPool.mu.Unlock()
	return append([]ladderHeld(nil), server.ladderPool.held...)
}

// The round never touches a game in progress.
//
// This is the guarantee the whole opt-in rests on. An owner who enters the pool
// is agreeing to two games an hour on a free slot; they are not agreeing to have
// a game they are already playing cut short, and an engine that could have its
// work voided by the clock striking would be one nobody sane would enter.
//
// What changed is *how* it holds, and the distinction is the point of this test.
// A busy engine used to be left out of the round altogether, which kept the
// guarantee by throwing the engine's hour away with it. It is now paired like
// anybody else and the pairing waits — so the assertion is no longer "the pairer
// did not see it" but "nothing started while the game was on".
func TestTheRoundNeverInterruptsAGameInProgress(t *testing.T) {
	server := ladderTestServer(t)
	anchor := poolBot(t, server, "Anchor", "owner-anchor")
	markLadderAnchor(t, server, anchor)
	busy := poolBot(t, server, "Busy", "owner-busy")

	putBotInAGame(t, server, busy.BotID)
	// Offered to the pairer, which is the change: its hour is not forfeit.
	seats := poolSeats(t, server, game.ModeIntransitive)
	if len(seats) != 2 {
		t.Fatalf("a busy engine should still be in the round, got %d seats", len(seats))
	}

	// And nothing was started, because the only pairing needs a slot it cannot
	// have yet. A series started here would be the guarantee broken.
	if seated := server.seatLadderRound(t.Context(), time.Now()); seated != 0 {
		t.Fatalf("a round seated %d pairings while an engine was mid-game", seated)
	}
	held := heldPairings(server)
	if len(held) != 1 {
		t.Fatalf("the pairing should be held for the busy engine, got %d", len(held))
	}
	if held[0].pairing.first != busy.BotID && held[0].pairing.second != busy.BotID {
		t.Fatal("the held pairing is not the one the busy engine is in")
	}
	// The game it was playing is untouched.
	server.mu.Lock()
	playing := len(server.participants)
	server.mu.Unlock()
	if playing != 1 {
		t.Fatalf("the game in progress was disturbed: %d participants", playing)
	}
}

// And the other half: the game ends, and the round it was in the middle of
// starts for it.
//
// This is what an author was promised by being in the field at all. Before, an
// engine that was busy at the hour simply lost that hour; the page said so, and
// the honest reading of "3 of 5 ready" was that two engines were being skipped.
// They are not skipped — they are late.
func TestAHeldPairingStartsWhenTheEngineComesFree(t *testing.T) {
	server := ladderTestServer(t)
	anchor := poolBot(t, server, "Anchor", "owner-anchor")
	markLadderAnchor(t, server, anchor)
	busy := poolBot(t, server, "Busy", "owner-busy")
	// Long enough that the run does not finish inside the test and start
	// deleting itself from under the assertions below.
	server.seriesDelay = time.Hour

	putBotInAGame(t, server, busy.BotID)
	server.seatLadderRound(t.Context(), time.Now())
	if len(heldPairings(server)) != 1 {
		t.Fatal("the pairing was not held")
	}
	// Still nothing to start while the game is on.
	server.resumeHeldPairings(t.Context())
	if len(heldPairings(server)) != 1 {
		t.Fatal("a held pairing was resolved while its engine was still playing")
	}

	freeBotFromItsGame(t, server, busy.BotID)
	server.resumeHeldPairings(t.Context())
	if remaining := heldPairings(server); len(remaining) != 0 {
		t.Fatalf("the pairing did not start once the engine was free: %d held", len(remaining))
	}
	if !server.botSeriesRuns.inLadderRun(busy.BotID) {
		t.Fatal("no ranked run was started for the engine that came free")
	}
}

// One pairing at a time, which is what keeps "two games an hour and never more"
// true now that a pairing can start late.
//
// A held pairing may only get going at five to. Without this the next round
// would pair those engines again on top of the games they are still playing,
// which is two rounds at once and twice the budget entering the pool costs.
func TestAnEngineStillPlayingItsRoundIsNotPairedAgain(t *testing.T) {
	server := ladderTestServer(t)
	anchor := poolBot(t, server, "Anchor", "owner-anchor")
	markLadderAnchor(t, server, anchor)
	entrant := poolBot(t, server, "Entrant", "owner-entrant")
	server.seriesDelay = time.Hour

	if seated := server.seatLadderRound(t.Context(), time.Now()); seated != 1 {
		t.Fatalf("expected the round to seat one pairing, got %d", seated)
	}
	if !server.botSeriesRuns.inLadderRun(entrant.BotID) {
		t.Fatal("the run did not register")
	}

	standing := server.ladderBotStanding(entrant.BotID, game.ModeIntransitive)
	if standing.In {
		t.Error("an engine still playing its round was offered to the next one")
	}
	if standing.Reason != "playing this hour's round" {
		t.Errorf("reason is %q, want the round it is already in", standing.Reason)
	}
	// And that is not the same answer a busy engine gets. The distinction is the
	// whole rule: busy means wait for it, in a round means it has had its turn.
	if standing.Waiting {
		t.Error("an engine playing its round was reported as waiting for one")
	}
}

// A bot held by a series is left alone too, including between two games of one.
//
// Worth its own case because the gap between games is the dangerous moment: the
// slot is not in a game for a fraction of a second while the next one is set up,
// and a pairer that only asked "are you playing right now" would take the engine
// out from under a run somebody started. The series holds the slot across that
// gap with a reservation, and starting a held pairing reads the same
// reservation — so the round waits for the run to finish rather than cutting in.
func TestTheRoundLeavesAnEngineHeldByASeriesAlone(t *testing.T) {
	server := ladderTestServer(t)
	anchor := poolBot(t, server, "Anchor", "owner-anchor")
	markLadderAnchor(t, server, anchor)
	held := poolBot(t, server, "Held", "owner-held")

	server.mu.Lock()
	for _, client := range server.bots[held.BotID] {
		client.bot.mu.Lock()
		client.bot.reservedBy = "some-other-series"
		client.bot.mu.Unlock()
	}
	server.mu.Unlock()

	standing := server.ladderBotStanding(held.BotID, game.ModeIntransitive)
	if !standing.In || !standing.Waiting {
		t.Fatalf("an engine between games of a run should be waiting, got %+v", standing)
	}
	// Paired, and not started: the reservation is what StartBotSeries refuses on,
	// so the other run keeps its seat.
	if seated := server.seatLadderRound(t.Context(), time.Now()); seated != 0 {
		t.Fatalf("a round seated %d pairings into a reserved slot", seated)
	}
	server.resumeHeldPairings(t.Context())
	if len(heldPairings(server)) != 1 {
		t.Fatal("the pairing should still be waiting for the reservation to clear")
	}
}
