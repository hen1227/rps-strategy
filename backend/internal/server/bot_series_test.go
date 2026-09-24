package server

import (
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// A stand-in engine.
//
// It reads the frames the server sends, answers `readyok` to a handshake and a
// legal move to a `go`, and picks that move out of the `legalmoves` line the
// server supplies — which is the same thing the ten-line example bot does, so
// this exercises the real path rather than a special one.
type stubEngine struct {
	client *Client
	server *Server
	done   chan struct{}
}

func startStubEngine(t *testing.T, server *Server, client *Client) *stubEngine {
	t.Helper()
	engine := &stubEngine{client: client, server: server, done: make(chan struct{})}
	go engine.run()
	t.Cleanup(func() { close(engine.done) })
	return engine
}

func (engine *stubEngine) run() {
	for {
		select {
		case <-engine.done:
			return
		case payload := <-engine.client.send:
			var frame struct {
				Type   string   `json:"type"`
				GameID string   `json:"gameId"`
				Seq    int64    `json:"seq"`
				Lines  []string `json:"lines"`
				Expect string   `json:"expect"`
			}
			if json.Unmarshal(payload, &frame) != nil || frame.Type != "engine" {
				continue
			}
			reply := engine.answer(frame.Expect, frame.Lines)
			if reply == nil {
				continue
			}
			engine.server.handleEngineReply(engine.client, ClientMessage{
				Type: "engine_reply", Seq: frame.Seq, GameID: frame.GameID, Lines: reply,
			})
		}
	}
}

func (engine *stubEngine) answer(expect string, lines []string) []string {
	switch expect {
	case "rpsiok":
		return []string{"id name Stub", "protocol 1", "mode V3", "mode V5", "rpsiok"}
	case "readyok":
		return []string{"readyok"}
	case "bestmove":
		for _, line := range lines {
			if !strings.HasPrefix(line, "legalmoves ") {
				continue
			}
			moves := strings.Fields(line)[1:]
			if len(moves) == 0 {
				return nil
			}
			return []string{"bestmove " + moves[0]}
		}
	}
	return nil
}

// seriesTestBots registers two real bots and wires a stub engine to each.
func seriesTestBots(t *testing.T) (*Server, persistence.Bot, persistence.Bot) {
	t.Helper()
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = data.Close() })
	server := NewWithStore(data, nil)
	// Long enough that the games are still sequenced, short enough that four
	// of them do not take three seconds of wall clock to prove a pairing rule.
	server.seriesDelay = time.Millisecond
	// Same bargain for the pace between moves: a stub engine answers instantly,
	// so the real fifth of a second would make every game of every series test
	// take a minute. That the pace is applied at all is proved on its own, in
	// bot_pace_test.go.
	server.movePaceOverride = time.Millisecond

	ctx := t.Context()
	const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if _, err := data.EnsureAccountWithProfileKey(ctx, "owner", "Owner", key); err != nil {
		t.Fatalf("owner account: %v", err)
	}
	if _, err := data.ClaimAccountWithDiscord(ctx, "owner", "Owner", "discord-owner", "owner"); err != nil {
		t.Fatalf("register owner: %v", err)
	}

	return server, addSeriesBot(t, server, "Alpha"), addSeriesBot(t, server, "Beta")
}

// addSeriesBot claims one more bot for the test owner and wires a stub engine to
// it. Separate from seriesTestBots because the public path needs four: two runs
// at once is the state its per-account ceiling is about, and two bots cannot be
// in two runs.
func addSeriesBot(t *testing.T, server *Server, name string) persistence.Bot {
	t.Helper()
	_, token, err := server.data.MintBotToken(t.Context(), "owner")
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	bot, err := server.data.ClaimBot(t.Context(), token, persistence.BotSettings{Name: name})
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	client := &Client{
		send:    make(chan []byte, 256),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: bot.UserID, Username: bot.Name},
		server:  server,
		bot:     &botClient{botID: bot.BotID, record: bot, ready: true},
	}
	server.hub.Register(client)
	server.mu.Lock()
	server.bots[bot.BotID] = []*Client{client}
	server.mu.Unlock()
	startStubEngine(t, server, client)
	return bot
}

// addRivalSeriesBot claims an engine under an owner of its own, for the tests
// that need two engines the ladder will actually rate against each other.
func addRivalSeriesBot(t *testing.T, server *Server, name string) persistence.Bot {
	t.Helper()
	owner := "owner-" + strings.ToLower(name)
	if _, err := server.data.ClaimAccountWithDiscord(
		t.Context(), owner, "Owner_"+name, "discord-"+owner, owner,
	); err != nil {
		t.Fatalf("register owner for %s: %v", name, err)
	}
	_, token, err := server.data.MintBotToken(t.Context(), owner)
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	bot, err := server.data.ClaimBot(t.Context(), token, persistence.BotSettings{Name: name})
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	client := &Client{
		send:    make(chan []byte, 256),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: bot.UserID, Username: bot.Name},
		server:  server,
		bot:     &botClient{botID: bot.BotID, record: bot, ready: true},
	}
	server.hub.Register(client)
	server.mu.Lock()
	server.bots[bot.BotID] = []*Client{client}
	server.mu.Unlock()
	startStubEngine(t, server, client)
	return bot
}

// playOneSeries runs a single pair to completion and hands back the games it
// filed, which is where the ranked flag it seated them with ends up.
// awaitSeriesFinished waits for the most recent run to stop running.
func awaitSeriesFinished(t *testing.T, server *Server) {
	t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		series, err := server.data.BotSeries(t.Context(), latestSeriesID(t, server))
		if err != nil {
			t.Fatalf("read series: %v", err)
		}
		if series.Status != persistence.BotSeriesRunning {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
}

func playOneSeries(
	t *testing.T,
	server *Server,
	first persistence.Bot,
	second persistence.Bot,
) []persistence.GameRecord {
	t.Helper()
	if _, err := server.StartBotSeries(
		t.Context(), hostSeries(first, second, game.ModeTotalWar, 1, 4, 99),
	); err != nil {
		t.Fatalf("start series: %v", err)
	}
	awaitSeriesFinished(t, server)
	history, err := server.data.GameHistory(t.Context(), first.UserID, 10, 0)
	if err != nil {
		t.Fatalf("read history: %v", err)
	}
	if len(history) == 0 {
		t.Fatal("the series filed no games")
	}
	return history
}

// Two of one person's engines may play — that is what the five-bot allowance is
// for — but the game is casual, because a rating is the one thing a private
// match between two accounts the same hand controls must not produce.
func TestASeriesBetweenOneOwnersBotsIsCasual(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)

	for _, played := range playOneSeries(t, server, alpha, beta) {
		if played.Ranked {
			t.Fatalf("game %s between one owner's bots was seated ranked", played.GameID)
		}
	}
	// The run itself says so too, so a card drawn from it can. Derived from the
	// two owners on read, which is why it does not need the games to have been
	// flagged when they were played.
	series, err := server.data.BotSeries(t.Context(), latestSeriesID(t, server))
	if err != nil {
		t.Fatalf("read series: %v", err)
	}
	if !series.Casual {
		t.Fatal("a run between one owner's bots did not read as casual")
	}

	// And the ladder is where that has to show: neither engine has a rating,
	// because neither has a game the record will count.
	for _, bot := range []persistence.Bot{alpha, beta} {
		ratings, err := server.data.BotModeRatings(t.Context(), game.ModeTotalWar)
		if err != nil {
			t.Fatalf("read ladder: %v", err)
		}
		if rating, rated := ratings[bot.UserID]; rated && rating != persistence.RatingFloor {
			t.Fatalf("%s came out of a private series rated %d", bot.Name, rating)
		}
	}
}

// A series two rival owners' engines play is still casual, and this is the rule
// the community asked for.
//
// It used to be ranked, and that was the hole. Whoever started the run chose the
// opponent — so the way to gain rating was to pick a weak one, or register one,
// or find a friend to register one — and chose the mode, the clock and the
// length of the run besides. A rating now comes from a round the server
// arranged and from nowhere else. Everything an author can start still plays,
// still records, and still shows in the archive; none of it moves a number.
func TestAHandStartedSeriesIsCasualHoweverManyOwnersAreInvolved(t *testing.T) {
	server, _, _ := seriesTestBots(t)
	first := addRivalSeriesBot(t, server, "Rival")
	second := addRivalSeriesBot(t, server, "Challenger")

	for _, played := range playOneSeries(t, server, first, second) {
		if played.Ranked {
			t.Fatalf("a hand-started game %s was seated ranked", played.GameID)
		}
	}
	series, err := server.data.BotSeries(t.Context(), latestSeriesID(t, server))
	if err != nil {
		t.Fatalf("read series: %v", err)
	}
	if !series.Casual || series.Ladder {
		t.Fatalf("a hand-started run read as ranked: %#v", series)
	}
}

// And the other half: a round the pool arranged is the one thing that counts.
//
// Seated through the same StartBotSeries with one field different, which is
// deliberate — there is exactly one place a ranked engine game can come from,
// and it is a flag no route can set.
func TestAPoolRoundIsRanked(t *testing.T) {
	server, _, _ := seriesTestBots(t)
	first := addRivalSeriesBot(t, server, "Rival")
	second := addRivalSeriesBot(t, server, "Challenger")

	ask := hostSeries(first, second, game.ModeTotalWar, 1, 4, 99)
	ask.Ladder = true
	if _, err := server.StartBotSeries(t.Context(), ask); err != nil {
		t.Fatalf("start series: %v", err)
	}
	awaitSeriesFinished(t, server)

	history, err := server.data.GameHistory(t.Context(), first.UserID, 10, 0)
	if err != nil {
		t.Fatalf("read history: %v", err)
	}
	if len(history) == 0 {
		t.Fatal("the round filed no games")
	}
	for _, played := range history {
		if !played.Ranked {
			t.Fatalf("a pool game %s was seated casual", played.GameID)
		}
	}
}

// Two of one person's engines stay casual even in a pool round. The pairer will
// not choose such a pairing, so this is the belt to that braces.
func TestAPoolRoundBetweenOneOwnersBotsIsStillCasual(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)

	ask := hostSeries(alpha, beta, game.ModeTotalWar, 1, 4, 99)
	ask.Ladder = true
	if _, err := server.StartBotSeries(t.Context(), ask); err != nil {
		t.Fatalf("start series: %v", err)
	}
	awaitSeriesFinished(t, server)

	history, err := server.data.GameHistory(t.Context(), alpha.UserID, 10, 0)
	if err != nil {
		t.Fatalf("read history: %v", err)
	}
	for _, played := range history {
		if played.Ranked {
			t.Fatalf("one owner's two engines were rated in game %s", played.GameID)
		}
	}
}

// hostSeries is a run asked for the way the host asks for one.
//
// Privileged, because these tests are about pairing, sequencing and abandonment
// rather than about the ceilings a visitor's request is held to — two of them
// ask for fifty pairs, which is exactly what the public limit refuses. The
// public path has its own tests below.
func hostSeries(
	first persistence.Bot,
	second persistence.Bot,
	modeID game.ModeID,
	pairs int,
	plies int,
	seed uint64,
) BotSeriesRequest {
	return BotSeriesRequest{
		FirstBotID:   first.BotID,
		SecondBotID:  second.BotID,
		ModeID:       modeID,
		Pairs:        pairs,
		OpeningPlies: plies,
		Seed:         seed,
		Control:      game.TimeControl{InitialTimeMs: 60_000},
		Privileged:   true,
	}
}

func TestASeriesPlaysPairedOpeningsWithSwappedSeats(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)

	if _, err := server.StartBotSeries(
		t.Context(), hostSeries(alpha, beta, game.ModeTotalWar, 2, 4, 1234),
	); err != nil {
		t.Fatalf("start series: %v", err)
	}

	var series persistence.BotSeries
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		var err error
		series, err = server.data.BotSeries(t.Context(), latestSeriesID(t, server))
		if err != nil {
			t.Fatalf("read series: %v", err)
		}
		if series.Status != persistence.BotSeriesRunning {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if series.Status != persistence.BotSeriesCompleted {
		t.Fatalf("series did not complete: %#v", series)
	}
	if len(series.Games) != 4 {
		t.Fatalf("two pairs is four games, got %d", len(series.Games))
	}

	// The point of pairing: both games of a pair start from an identical
	// board, and only the seats change. Mirroring instead would measure
	// something else entirely.
	for pair := 1; pair <= 2; pair++ {
		var first, second persistence.BotSeriesGame
		for _, entry := range series.Games {
			if entry.PairNumber != pair {
				continue
			}
			if entry.Swapped {
				second = entry
			} else {
				first = entry
			}
		}
		if first.OpeningLine == "" {
			t.Fatalf("pair %d has no opening line", pair)
		}
		if first.OpeningLine != second.OpeningLine {
			t.Fatalf(
				"pair %d played different openings: %q then %q",
				pair, first.OpeningLine, second.OpeningLine,
			)
		}
		if len(strings.Fields(first.OpeningLine)) != 4 {
			t.Fatalf("pair %d: expected four book plies, got %q", pair, first.OpeningLine)
		}
	}
	// Different pairs must not share an opening, or the series measures one
	// position four times.
	if series.Games[0].OpeningLine == series.Games[2].OpeningLine {
		t.Fatal("both pairs drew the same opening")
	}

	// Every game is a real game in the real archive.
	for _, entry := range series.Games {
		if entry.GameID == "" {
			t.Fatalf("game %d has no game id", entry.GameNumber)
		}
		archived, err := server.data.ArchivedGame(t.Context(), entry.GameID)
		if err != nil {
			t.Fatalf("game %d was not archived: %v", entry.GameNumber, err)
		}
		if !strings.Contains(archived.PGN, `[Event "Bot Match"]`) {
			t.Fatalf("game %d is not tagged as a bot match", entry.GameNumber)
		}
		if !strings.Contains(archived.PGN, `[BookPlies "4"]`) {
			t.Fatalf("game %d does not record its book plies", entry.GameNumber)
		}
	}
}

func TestASeriesRunsOneGameAtATime(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	if _, err := server.StartBotSeries(
		t.Context(), hostSeries(alpha, beta, game.ModeInfiltration, 3, 2, 99),
	); err != nil {
		t.Fatalf("start series: %v", err)
	}

	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		server.mu.RLock()
		live := len(server.games)
		server.mu.RUnlock()
		// Sequential means exactly this: never two boards up at once.
		if live > 1 {
			t.Fatalf("%d games running at once; a series must be sequential", live)
		}
		series, err := server.data.BotSeries(t.Context(), latestSeriesID(t, server))
		if err != nil {
			t.Fatalf("read series: %v", err)
		}
		if series.Status != persistence.BotSeriesRunning {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("series did not finish in time")
}

// A series with one engine in it is not a series, so it stops rather than
// grinding through 100 games one side cannot play — but not on the instant the
// socket drops, which is what it used to do. See bot_absence_test.go for both
// halves of that rule.

func latestSeriesID(t *testing.T, server *Server) string {
	t.Helper()
	list, err := server.data.BotSeriesList(t.Context(), 1)
	if err != nil || len(list) == 0 {
		t.Fatalf("no series recorded: %v", err)
	}
	return list[0].SeriesID
}

// seriesWatcher keeps the first lobby row published for each game of a run.
//
// A stub engine answers instantly, so a series game can go live and be over
// between two polls of the live-game list -- which makes "wait until game two
// is on the board" a race the run usually wins. A lobby broadcast is not a
// poll: one goes out on every change, so watching the stream keeps the rows a
// run actually published rather than the ones it happened to still be showing
// when somebody looked. Use this for a test that reads a row; use
// waitForSeriesGame for one that has to catch a game while it is live.
type seriesWatcher struct {
	mu   sync.Mutex
	rows map[int]LiveGameSummary
}

func watchSeriesRows(t *testing.T, server *Server) *seriesWatcher {
	t.Helper()
	// A far bigger queue than a real connection gets: this client exists to
	// keep every broadcast a whole run produces, and a full queue closes a
	// client rather than blocking the server.
	observer := &Client{send: make(chan []byte, 8192), done: make(chan struct{})}
	server.hub.Register(observer)
	watcher := &seriesWatcher{rows: make(map[int]LiveGameSummary)}
	go func() {
		for {
			select {
			case <-observer.done:
				return
			case encoded := <-observer.send:
				var message ServerMessage
				if json.Unmarshal(encoded, &message) != nil {
					continue
				}
				watcher.mu.Lock()
				for _, live := range message.LiveGames {
					if live.Series == nil {
						continue
					}
					if _, seen := watcher.rows[live.Series.GameNumber]; !seen {
						watcher.rows[live.Series.GameNumber] = live
					}
				}
				watcher.mu.Unlock()
			}
		}
	}()
	t.Cleanup(func() { close(observer.done) })
	return watcher
}

// row blocks until the numbered game of a run has been published, and answers
// with the row it was published with.
func (watcher *seriesWatcher) row(t *testing.T, number int) LiveGameSummary {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		watcher.mu.Lock()
		row, seen := watcher.rows[number]
		watcher.mu.Unlock()
		if seen {
			return row
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatalf("game %d of the series was never published", number)
	return LiveGameSummary{}
}

// waitForSeriesGame blocks until the numbered game of a run is on the board.
// For a test that has to interact with a game while it is live -- spectating
// it, talking in its room -- which a recorded row cannot do.
func waitForSeriesGame(t *testing.T, server *Server, number int) LiveGameSummary {
	t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		for _, live := range server.liveGames() {
			if live.Series != nil && live.Series.GameNumber == number {
				return live
			}
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("game %d of the series never went live", number)
	return LiveGameSummary{}
}

func TestALobbyRowCarriesTheSeriesItBelongsTo(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	watcher := watchSeriesRows(t, server)
	if _, err := server.StartBotSeries(
		t.Context(), hostSeries(alpha, beta, game.ModeTotalWar, 2, 4, 4321),
	); err != nil {
		t.Fatalf("start series: %v", err)
	}

	first := watcher.row(t, 1)
	if first.Series.TotalGames != 4 {
		t.Fatalf("two pairs is four games, the row says %d", first.Series.TotalGames)
	}
	if !first.Series.FirstIsRed || first.RedPlayer.Username != "Alpha" {
		t.Fatalf("the run's first bot should open as Red: %#v", first.Series)
	}
	if played := first.Series.FirstWins + first.Series.SecondWins + first.Series.Draws; played != 0 {
		t.Fatalf("nothing has finished yet, the tally counts %d games", played)
	}

	second := watcher.row(t, 2)
	if second.Series.SeriesID != first.Series.SeriesID {
		t.Fatalf("the pair partner belongs to another run: %#v", second.Series)
	}
	// The seats swap for the second half of a pair, which is the whole reason
	// the row has to say which side the tally's first bot is sitting on.
	if second.Series.FirstIsRed || second.RedPlayer.Username != "Beta" {
		t.Fatalf("the pair partner did not swap seats: %#v", second.Series)
	}
	if played := second.Series.FirstWins + second.Series.SecondWins + second.Series.Draws; played != 1 {
		t.Fatalf("one game has finished, the tally counts %d", played)
	}
}

func TestASeriesCarriesItsChatIntoTheNextGame(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	if _, err := server.StartBotSeries(
		t.Context(), hostSeries(alpha, beta, game.ModeTotalWar, 1, 4, 77),
	); err != nil {
		t.Fatalf("start series: %v", err)
	}

	first := waitForSeriesGame(t, server, 1)
	watcher := &Client{
		// Roomy: the board broadcasts a state per move and this client stops
		// reading after the join.
		send:    make(chan []byte, 4096),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "series-watcher", Username: "Watcher"},
	}
	server.spectateGame(watcher, first.GameID)
	if joined := readClientMessage(t, watcher); joined.Type != "spectator_joined" {
		t.Fatalf("could not watch the first game: %#v", joined)
	}
	server.handleMessage(watcher, ClientMessage{Type: "send_chat", Text: "go alpha"})

	second := waitForSeriesGame(t, server, 2)
	late := &Client{
		send:    make(chan []byte, 16),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "late-watcher", Username: "Late"},
	}
	server.spectateGame(late, second.GameID)
	joined := readClientMessage(t, late)
	// Someone who only turns up for the second game arrives in the same room,
	// which is what makes a series one thing to watch rather than N.
	if len(joined.ChatMessages) != 1 || joined.ChatMessages[0].Text != "go alpha" {
		t.Fatalf("the run's conversation did not survive the game: %#v", joined.ChatMessages)
	}
	if joined.ChatRoomID == "" || joined.ChatRoomID != joined.ChatMessages[0].RoomID {
		t.Fatalf("the second game should name the room its history came from: %#v", joined)
	}
}

// The two audiences of a changeover — whoever has moved to the new board and
// whoever is still sitting on the old one — are one conversation. Copying the
// transcript forward instead would give each of them a room the other cannot
// hear, which is the bug this is here to keep fixed.
func TestASeriesChangeoverLeavesEveryoneInOneConversation(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	if _, err := server.StartBotSeries(
		t.Context(), hostSeries(alpha, beta, game.ModeTotalWar, 1, 4, 77),
	); err != nil {
		t.Fatalf("start series: %v", err)
	}

	first := waitForSeriesGame(t, server, 1)
	// Roomy: the board broadcasts a state per move and these clients only read
	// when the test looks for a particular message.
	stayed := &Client{
		send:    make(chan []byte, 4096),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "stayed", Username: "Stayed"},
	}
	server.spectateGame(stayed, first.GameID)
	if joined := readClientMessage(t, stayed); joined.Type != "spectator_joined" {
		t.Fatalf("could not watch the first game: %#v", joined)
	}

	second := waitForSeriesGame(t, server, 2)
	followed := &Client{
		send:    make(chan []byte, 4096),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "followed", Username: "Followed"},
	}
	server.spectateGame(followed, second.GameID)
	if joined := readClientMessage(t, followed); joined.Type != "spectator_joined" {
		t.Fatalf("could not watch the second game: %#v", joined)
	}

	// Said on the finished board, after the game it was said in was over.
	server.handleMessage(stayed, ClientMessage{Type: "send_chat", Text: "that was close"})
	fromOldBoard := waitForChat(t, followed, "that was close")
	// And back the other way.
	server.handleMessage(followed, ClientMessage{Type: "send_chat", Text: "here we go again"})
	fromNewBoard := waitForChat(t, stayed, "here we go again")
	// Typed at different boards, delivered as one room — which is what a
	// client needs in order to show them as one conversation.
	if fromOldBoard.GameID == fromNewBoard.GameID {
		t.Fatalf("the two sides should have been typed at different games: %#v", fromOldBoard)
	}
	if fromOldBoard.RoomID != fromNewBoard.RoomID {
		t.Fatalf("one changeover, two rooms: %#v and %#v", fromOldBoard, fromNewBoard)
	}
}

// The gap between two games of a run is when most of the talk about the one
// that just ended happens. It belongs to the run, not to the finished board.
func TestASeriesKeepsWhatIsSaidBetweenItsGames(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	// Long enough to leave a window with no game in it at all, which is the
	// state a transcript copied at the final move loses everything said in.
	server.seriesDelay = 250 * time.Millisecond
	if _, err := server.StartBotSeries(
		t.Context(), hostSeries(alpha, beta, game.ModeTotalWar, 1, 4, 77),
	); err != nil {
		t.Fatalf("start series: %v", err)
	}

	first := waitForSeriesGame(t, server, 1)
	watcher := &Client{
		send:    make(chan []byte, 4096),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "series-watcher", Username: "Watcher"},
	}
	server.spectateGame(watcher, first.GameID)
	if joined := readClientMessage(t, watcher); joined.Type != "spectator_joined" {
		t.Fatalf("could not watch the first game: %#v", joined)
	}
	server.handleMessage(watcher, ClientMessage{Type: "send_chat", Text: "during"})

	waitForGameToEnd(t, server, first.GameID)
	server.handleMessage(watcher, ClientMessage{Type: "send_chat", Text: "after the whistle"})

	second := waitForSeriesGame(t, server, 2)
	late := &Client{
		send:    make(chan []byte, 64),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: "late-watcher", Username: "Late"},
	}
	server.spectateGame(late, second.GameID)
	joined := readClientMessage(t, late)
	if joined.Type != "spectator_joined" {
		t.Fatalf("could not watch the second game: %#v", joined)
	}
	texts := make([]string, 0, len(joined.ChatMessages))
	for _, message := range joined.ChatMessages {
		texts = append(texts, message.Text)
	}
	if strings.Join(texts, "|") != "during|after the whistle" {
		t.Fatalf("the run lost what was said between its games: %#v", texts)
	}
}

// waitForGameToEnd blocks until a game has left the live table.
func waitForGameToEnd(t *testing.T, server *Server, gameID string) {
	t.Helper()
	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		server.mu.RLock()
		_, live := server.games[gameID]
		server.mu.RUnlock()
		if !live {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	t.Fatalf("game %s never finished", gameID)
}

// waitForChat reads past the board traffic, and past any chat that is not the
// message being waited for, to the one that is.
func waitForChat(t *testing.T, client *Client, text string) ChatMessage {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case encoded := <-client.send:
			var message ServerMessage
			if err := json.Unmarshal(encoded, &message); err != nil {
				t.Fatal(err)
			}
			if message.Type == "chat_message" && message.ChatMessage != nil &&
				message.ChatMessage.Text == text {
				return *message.ChatMessage
			}
		case <-deadline:
			t.Fatalf("timed out waiting for the chat message %q", text)
			return ChatMessage{}
		}
	}
}

// Stopping a run does not stop the game it is in the middle of: two engines are
// already on a board and nothing here can take that back. So that game plays to
// a finish, and its result belongs to the run it was started for.
//
// It used to be lost. The abort removed the run from the map, and the callback
// that files results gave up when it could not find one — so the game counted
// for both bots' ratings and for nothing else, and the pair it belonged to read
// `pending` for ever afterwards.
func TestAbortingARunStillCountsTheGameItWasIn(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	if _, err := server.StartBotSeries(
		t.Context(), hostSeries(alpha, beta, game.ModeTotalWar, 50, 2, 11),
	); err != nil {
		t.Fatalf("start series: %v", err)
	}
	seriesID := latestSeriesID(t, server)
	waitForSeriesGame(t, server, 1)

	if err := server.AbortBotSeries(seriesID, "", true); err != nil {
		t.Fatalf("abort series: %v", err)
	}

	deadline := time.Now().Add(60 * time.Second)
	for time.Now().Before(deadline) {
		series, err := server.data.BotSeries(t.Context(), seriesID)
		if err != nil {
			t.Fatalf("read series: %v", err)
		}
		if series.Status != persistence.BotSeriesAborted {
			t.Fatalf("expected the run to be aborted, got %q", series.Status)
		}
		decided := series.FirstWins + series.SecondWins + series.Draws
		if decided == 0 {
			time.Sleep(10 * time.Millisecond)
			continue
		}
		// Exactly the one game that was on the board. An abort takes the run's
		// remaining pairs with it — they were never started, so there is nothing
		// to forget — and it cannot conjure results for them either.
		if decided != 1 {
			t.Fatalf("expected one game on the record, got %d: %#v", decided, series)
		}
		if len(series.Games) != 1 {
			t.Fatalf("expected one game row, got %d", len(series.Games))
		}
		if series.Games[0].Result == persistence.BotSeriesPending {
			t.Fatalf("the game the abort interrupted is still pending: %#v", series.Games[0])
		}
		return
	}
	t.Fatal("the interrupted game never landed on the record")
}

// stallingEngine plays perfectly, except that it ignores exactly one `bestmove`
// question — one search that overran, the everyday case the move timeout and
// `botMinimumMoveTimeout` exist to absorb. Everything it says afterwards is
// correct and on time.
type stallingEngine struct {
	client   *Client
	server   *Server
	done     chan struct{}
	mu       sync.Mutex
	stalls   int
	answered int
}

func startStallingEngine(t *testing.T, server *Server, client *Client, stalls int) *stallingEngine {
	t.Helper()
	engine := &stallingEngine{
		client: client, server: server, done: make(chan struct{}), stalls: stalls,
	}
	go engine.run()
	t.Cleanup(func() { close(engine.done) })
	return engine
}

func (engine *stallingEngine) run() {
	inner := &stubEngine{client: engine.client, server: engine.server}
	for {
		select {
		case <-engine.done:
			return
		case payload := <-engine.client.send:
			var frame struct {
				Type   string   `json:"type"`
				GameID string   `json:"gameId"`
				Seq    int64    `json:"seq"`
				Lines  []string `json:"lines"`
				Expect string   `json:"expect"`
			}
			if json.Unmarshal(payload, &frame) != nil || frame.Type != "engine" {
				continue
			}
			if frame.Expect == "bestmove" {
				engine.mu.Lock()
				stalling := engine.stalls > 0
				if stalling {
					engine.stalls--
				}
				engine.mu.Unlock()
				if stalling {
					continue // this one search took too long
				}
			}
			reply := inner.answer(frame.Expect, frame.Lines)
			if reply == nil {
				continue
			}
			engine.mu.Lock()
			engine.answered++
			engine.mu.Unlock()
			engine.server.handleEngineReply(engine.client, ClientMessage{
				Type: "engine_reply", Seq: frame.Seq, GameID: frame.GameID, Lines: reply,
			})
		}
	}
}

// One overrun search should cost one game, not the rest of the run.
func TestOneSlowSearchDoesNotAbandonTheRestOfTheSeries(t *testing.T) {
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = data.Close() })
	server := NewWithStore(data, nil)
	server.seriesDelay = time.Millisecond
	server.movePaceOverride = time.Millisecond

	ctx := t.Context()
	const key = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	if _, err := data.EnsureAccountWithProfileKey(ctx, "owner", "Owner", key); err != nil {
		t.Fatalf("owner account: %v", err)
	}
	if _, err := data.ClaimAccountWithDiscord(ctx, "owner", "Owner", "discord-owner", "owner"); err != nil {
		t.Fatalf("register owner: %v", err)
	}

	alpha := addStallingBot(t, server, "Alpha", 1)
	beta := addSeriesBot(t, server, "Beta")

	// The real server's two sweeps, at a pace that keeps the test quick.
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		ticker := time.NewTicker(5 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case now := <-ticker.C:
				server.expireGames(now)
				server.expireBotExchanges(now)
			}
		}
	}()

	// A short clock, because what this test is timing is one search that never
	// returns: the bot flags, and the run has to carry on without it.
	ask := hostSeries(alpha, beta, "V3", 3, 3, 99)
	ask.Control = game.TimeControl{InitialTimeMs: 3000}
	if _, err := server.StartBotSeries(ctx, ask); err != nil {
		t.Fatalf("start series: %v", err)
	}

	var series persistence.BotSeries
	deadline := time.Now().Add(90 * time.Second)
	for time.Now().Before(deadline) {
		series, err = server.data.BotSeries(ctx, latestSeriesID(t, server))
		if err != nil {
			t.Fatalf("read series: %v", err)
		}
		if series.Status != persistence.BotSeriesRunning {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}

	// Everything after game one is a game this engine answered correctly and on
	// time. Losing one of those on the clock means it was never asked to move;
	// losing one to abandonment means a question about an earlier game was
	// filed against it. Neither is something it did.
	spoiled := 0
	for _, entry := range series.Games {
		t.Logf("game %d: result=%v reason=%q", entry.GameNumber, entry.Result, entry.EndReason)
		if entry.GameNumber == 1 {
			continue // the stalled search really does lose this one
		}
		switch entry.EndReason {
		case "timeout", "abandonment":
			spoiled++
		}
	}
	t.Logf("series status=%v games=%d spoiled=%d", series.Status, len(series.Games), spoiled)
	if series.Status != persistence.BotSeriesCompleted {
		t.Fatalf("series did not complete: %v", series.Status)
	}
	if spoiled > 0 {
		t.Errorf("one overrun search spoiled %d later games", spoiled)
	}
}

func addStallingBot(t *testing.T, server *Server, name string, stalls int) persistence.Bot {
	t.Helper()
	_, token, err := server.data.MintBotToken(t.Context(), "owner")
	if err != nil {
		t.Fatalf("mint: %v", err)
	}
	bot, err := server.data.ClaimBot(t.Context(), token, persistence.BotSettings{Name: name})
	if err != nil {
		t.Fatalf("claim: %v", err)
	}
	client := &Client{
		send:    make(chan []byte, 256),
		done:    make(chan struct{}),
		profile: game.PlayerProfile{UserID: bot.UserID, Username: bot.Name},
		server:  server,
		bot:     &botClient{botID: bot.BotID, record: bot, ready: true},
	}
	server.hub.Register(client)
	server.mu.Lock()
	server.bots[bot.BotID] = []*Client{client}
	server.mu.Unlock()
	startStallingEngine(t, server, client, stalls)
	return bot
}
