package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/notation"
	"rps-strategy/backend/internal/persistence"
)

// playOpening plays a specific line and resigns, so the archive holds a game
// that opened exactly the way the test meant it to.
//
// Written in the book's own notation, which is the notation the statistics
// come back in, so a test reads as the thing it is asserting.
func playOpening(
	t *testing.T,
	gameID string,
	modeID game.ModeID,
	red, blue game.PlayerProfile,
	line []string,
	resigning game.PlayerColor,
) *game.Game {
	t.Helper()
	played, err := game.NewGame(gameID, modeID, red, blue)
	if err != nil {
		t.Fatal(err)
	}
	for _, text := range line {
		movement, ok := parseOpeningBookMove(text)
		if !ok {
			t.Fatalf("%s is not a move", text)
		}
		mover := played.Snapshot().CurrentTurn
		if _, err := played.Move(mover, movement.From, movement.To); err != nil {
			t.Fatalf("playing %s: %v", text, err)
		}
	}
	if _, err := played.Resign(resigning); err != nil {
		t.Fatal(err)
	}
	return played
}

func archiveOpening(
	t *testing.T,
	data *persistence.Store,
	played *game.Game,
	finishedAt time.Time,
) {
	t.Helper()
	if _, err := data.ArchiveGame(
		context.Background(), played.Record(),
		notation.Metadata{Event: "Casual", FinishedAt: finishedAt}, "",
	); err != nil {
		t.Fatal(err)
	}
}

func archiveOpeningRecord(
	t *testing.T,
	data *persistence.Store,
	record game.Record,
	finishedAt time.Time,
) {
	t.Helper()
	if _, err := data.ArchiveGame(
		context.Background(), record,
		notation.Metadata{Event: "Casual", FinishedAt: finishedAt}, "",
	); err != nil {
		t.Fatal(err)
	}
}

func statsTestServer(t *testing.T) *Server {
	t.Helper()
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = data.Close() })
	return NewWithStore(data, nil)
}

// The first two plies of Infiltration under the current rules, where Blue
// moves first. Named rather than repeated so a later rules change breaks one
// place instead of six.
var (
	openingLeft  = []string{"d2-c3", "d7-c6"}
	openingRight = []string{"f2-g3", "f7-g6"}
)

func TestOpeningStatsCountsEveryPrefixAndItsShare(t *testing.T) {
	server := statsTestServer(t)
	ctx := context.Background()
	now := time.Now()

	// Three games down the left, one down the right: shares of 75% and 25% on
	// the first move, and the left line's second move shared by all three.
	for index := range 3 {
		played := playOpening(
			t, fmt.Sprintf("left-%d", index), game.ModeInfiltration,
			game.PlayerProfile{UserID: "human-red", Username: "Red"},
			game.PlayerProfile{UserID: "human-blue", Username: "Blue"},
			openingLeft, game.Blue,
		)
		archiveOpening(t, server.data, played, now)
	}
	played := playOpening(
		t, "right-0", game.ModeInfiltration,
		game.PlayerProfile{UserID: "human-red", Username: "Red"},
		game.PlayerProfile{UserID: "human-blue", Username: "Blue"},
		openingRight, game.Red,
	)
	archiveOpening(t, server.data, played, now)

	if err := server.compileOpeningStats(ctx, game.ModeInfiltration); err != nil {
		t.Fatal(err)
	}
	node, err := server.data.OpeningStatsAt(
		ctx, string(game.ModeInfiltration), []string{persistence.OpeningSegmentHuman}, nil, 10,
	)
	if err != nil {
		t.Fatal(err)
	}
	if node.Games != 4 || node.Skipped != 0 {
		t.Fatalf("counted %d games and skipped %d, want 4 and 0", node.Games, node.Skipped)
	}
	if len(node.Continuations) != 2 {
		t.Fatalf("first moves: %#v", node.Continuations)
	}
	first := node.Continuations[0]
	if first.Move != openingLeft[0] || first.Games != 3 {
		t.Fatalf("most played first move: %#v", first)
	}
	if first.Share != 0.75 {
		t.Fatalf("share %v, want 0.75", first.Share)
	}
	// Every game reached the starting position, so at the root the two shares
	// are the same number. They stop agreeing one ply down.
	if first.ShareOfParent != 0.75 {
		t.Fatalf("share of parent %v, want 0.75", first.ShareOfParent)
	}
	// The three left-hand games were resigned by Blue, so Red won them.
	if first.RedWins != 3 || first.BlueWins != 0 {
		t.Fatalf("results on the first move: %#v", first)
	}

	// One ply down: three of four games overall, and all three of the games
	// that got here.
	deeper, err := server.data.OpeningStatsAt(
		ctx, string(game.ModeInfiltration), []string{persistence.OpeningSegmentHuman},
		openingLeft[:1], 0,
	)
	if err != nil {
		t.Fatal(err)
	}
	if deeper.Position == nil || deeper.Position.Games != 3 {
		t.Fatalf("position counts: %#v", deeper.Position)
	}
	if len(deeper.Continuations) != 1 {
		t.Fatalf("continuations: %#v", deeper.Continuations)
	}
	reply := deeper.Continuations[0]
	if reply.Move != openingLeft[1] {
		t.Fatalf("reply %q, want %q", reply.Move, openingLeft[1])
	}
	if reply.Share != 0.75 || reply.ShareOfParent != 1 {
		t.Fatalf("share %v of the mode and %v of the parent, want 0.75 and 1",
			reply.Share, reply.ShareOfParent)
	}
}

func TestOpeningStatsSeparatesBotsFromHumans(t *testing.T) {
	server := statsTestServer(t)
	ctx := context.Background()
	now := time.Now()

	bot := game.PlayerProfile{
		UserID:   persistence.BotAccountPrefix + "engine",
		Username: "RPSFish",
	}
	human := game.PlayerProfile{UserID: "human-blue", Username: "Blue"}

	archiveOpening(t, server.data, playOpening(
		t, "bots", game.ModeInfiltration,
		game.PlayerProfile{UserID: persistence.BotAccountPrefix + "other", Username: "Alt"},
		bot, openingLeft, game.Blue,
	), now)
	archiveOpening(t, server.data, playOpening(
		t, "mixed", game.ModeInfiltration, bot, human, openingRight, game.Red,
	), now)
	archiveOpening(t, server.data, playOpening(
		t, "humans", game.ModeInfiltration,
		game.PlayerProfile{UserID: "human-red", Username: "Red"}, human,
		openingLeft, game.Red,
	), now)

	if err := server.compileOpeningStats(ctx, game.ModeInfiltration); err != nil {
		t.Fatal(err)
	}
	for name, want := range map[string]int{
		persistence.OpeningSegmentHuman: 1,
		persistence.OpeningSegmentBot:   1,
		persistence.OpeningSegmentMixed: 1,
	} {
		node, err := server.data.OpeningStatsAt(
			ctx, string(game.ModeInfiltration), []string{name}, nil, 0,
		)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if node.Games != want {
			t.Fatalf("%s counted %d games, want %d", name, node.Games, want)
		}
	}
	// And every box ticked is the three of them added up, which is what makes
	// the checkboxes mixable at all.
	together, err := server.data.OpeningStatsAt(
		ctx, string(game.ModeInfiltration), persistence.OpeningSegments, nil, 0,
	)
	if err != nil {
		t.Fatal(err)
	}
	if together.Games != 3 {
		t.Fatalf("every segment together counted %d games, want 3", together.Games)
	}
}

// The case that matters most, and the one the archive is currently full of:
// the rules changed on 2026-09-03 so that Blue moves first, so a game recorded
// before that opens with a Red move from Red's own half, which is not a legal
// opening move now. The relabelling that reads it is the rank flip, not the
// half turn -- see TestRankFlipReadsThePreChangeArchive, which is where the
// difference between the two is pinned against a real archived game.
//
// It is still the same game seen from the other end of the board, so it is
// counted as the game it is the image of. This asserts that literally: the
// same game archived twice, once as it was played and once turned, compiles to
// the same statistics down to the shares -- and the turned compile says so,
// because a reader of a pre-change archive is owed the fact that its counts
// were turned.
func TestOpeningStatsCountsGamesFromBeforeTheRulesChanged(t *testing.T) {
	ctx := context.Background()
	finishedAt := time.Now()

	played := playOpening(
		t, "current-rules", game.ModeInfiltration,
		game.PlayerProfile{UserID: "human-red", Username: "Red"},
		game.PlayerProfile{UserID: "human-blue", Username: "Blue"},
		openingLeft, game.Blue,
	)
	asPlayed := statsTestServer(t)
	archiveOpeningRecord(t, asPlayed.data, played.Record(), finishedAt)

	// The same game as a record from before the change: every move flipped end
	// for end and handed to the other colour, the two seats swapped with them,
	// and the board it began from carrying Red to move. That is not a doctored
	// file -- it is what this game would have been archived as in August.
	turned := statsTestServer(t)
	stale := rankFlipRecord(t, played.Record())
	stale.GameID = "old-rules"
	archiveOpeningRecord(t, turned.data, stale, finishedAt)

	for _, server := range []*Server{asPlayed, turned} {
		if err := server.compileOpeningStats(ctx, game.ModeInfiltration); err != nil {
			t.Fatal(err)
		}
	}
	before := openingStatsFor(t, asPlayed, []string{persistence.OpeningSegmentHuman})
	after := openingStatsFor(t, turned, []string{persistence.OpeningSegmentHuman})

	if before.Turned != 0 || after.Turned != 1 {
		t.Fatalf(
			"turned %d games as played and %d from before the change, want 0 and 1",
			before.Turned, after.Turned,
		)
	}
	if after.Games != 1 || after.Skipped != 0 {
		t.Fatalf(
			"counted %d games and skipped %d, want the pre-change game counted",
			after.Games, after.Skipped,
		)
	}
	// Compared whole rather than field by field, because the claim is that the
	// turn changes nothing: same lines, same shares, same side won.
	before.Turned, after.Turned = 0, 0
	before.ComputedAtUnixMs, after.ComputedAtUnixMs = 0, 0
	if !reflect.DeepEqual(before, after) {
		t.Fatalf(
			"the turned game compiled differently:\n got %+v\nwant %+v", after, before,
		)
	}
}

// A record neither this server's rules nor the ones before them can replay is
// still skipped, and still counted as skipped. The rank flip is a relabelling
// of a game somebody played, not a licence to make an illegal file legal.
func TestOpeningStatsSkipsGamesNoRulesEverAllowed(t *testing.T) {
	server := statsTestServer(t)
	ctx := context.Background()

	good := playOpening(
		t, "current-rules", game.ModeInfiltration,
		game.PlayerProfile{UserID: "human-red", Username: "Red"},
		game.PlayerProfile{UserID: "human-blue", Username: "Blue"},
		openingLeft, game.Blue,
	)
	archiveOpening(t, server.data, good, time.Now())

	// The colours on the moves swapped and nothing else: Red opening with a
	// move out of Blue's half. No rules this game ever had would produce it,
	// and turning it only moves the same illegality to the other side.
	stale := good.Record()
	stale.GameID = "impossible"
	swapped := make([]game.Event, 0, len(stale.Events))
	for _, event := range stale.Events {
		if event.Kind == game.EventMove {
			event.Player = game.OtherColor(event.Player)
		}
		swapped = append(swapped, event)
	}
	stale.Events = swapped
	archiveOpeningRecord(t, server.data, stale, time.Now())

	if err := server.compileOpeningStats(ctx, game.ModeInfiltration); err != nil {
		t.Fatal(err)
	}
	node := openingStatsFor(t, server, []string{persistence.OpeningSegmentHuman})
	if node.Games != 1 {
		t.Fatalf("counted %d games, want only the one that replays", node.Games)
	}
	if node.Skipped != 1 {
		t.Fatalf("skipped %d, want 1 -- a dropped game has to be reported", node.Skipped)
	}
	if node.Turned != 0 {
		t.Fatalf("turned %d games, want 0 -- turning it does not make it legal", node.Turned)
	}
}

// rankFlipRecord rewrites a game as the record it would have been before the
// rules changed: the board flipped end for end, every colour swapped, and the
// opening seat handed to Red.
//
// The inverse of what the compiler does, which is the point of using it here:
// a fixture written by hand would be a guess about what the archive holds.
func rankFlipRecord(t *testing.T, record game.Record) game.Record {
	t.Helper()
	grid, turn, err := notation.DecodePosition(
		notation.EncodeStartingPosition(record.StartingPosition()),
	)
	if err != nil {
		t.Fatal(err)
	}
	width, height := grid.Width(), grid.Height()
	record.InitialPosition = &game.InitialPosition{
		Grid:        game.RankFlipGrid(grid),
		CurrentTurn: game.OtherColor(turn),
	}
	record.RedPlayer, record.BluePlayer = record.BluePlayer, record.RedPlayer
	events := make([]game.Event, 0, len(record.Events))
	for _, event := range record.Events {
		event.Player = game.OtherColor(event.Player)
		if event.Kind == game.EventMove {
			event.From = game.RankFlipSquare(width, height, event.From)
			event.To = game.RankFlipSquare(width, height, event.To)
		}
		events = append(events, event)
	}
	record.Events = events
	record.Final.Grid = game.RankFlipGrid(record.Final.Grid)
	record.Final.Winner = game.OtherColor(record.Final.Winner)
	record.Final.CurrentTurn = game.OtherColor(record.Final.CurrentTurn)
	record.Final.RedPlayer, record.Final.BluePlayer =
		record.Final.BluePlayer, record.Final.RedPlayer
	return record
}

func openingStatsFor(
	t *testing.T,
	server *Server,
	segments []string,
) persistence.OpeningStatsNode {
	t.Helper()
	node, err := server.data.OpeningStatsAt(
		context.Background(), string(game.ModeInfiltration), segments, nil, 10,
	)
	if err != nil {
		t.Fatal(err)
	}
	return node
}

func TestOpeningStatsRouteServesTheCondensedDataset(t *testing.T) {
	server := statsTestServer(t)
	archiveOpening(t, server.data, playOpening(
		t, "route", game.ModeInfiltration,
		game.PlayerProfile{UserID: "human-red", Username: "Red"},
		game.PlayerProfile{UserID: "human-blue", Username: "Blue"},
		openingLeft, game.Blue,
	), time.Now())
	if err := server.compileOpeningStats(context.Background(), game.ModeInfiltration); err != nil {
		t.Fatal(err)
	}

	recorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, httptest.NewRequest(
		"GET", "/api/openings/V3/stats", nil,
	))
	if recorder.Code != 200 {
		t.Fatalf("status %d: %s", recorder.Code, recorder.Body)
	}
	var node persistence.OpeningStatsNode
	if err := json.Unmarshal(recorder.Body.Bytes(), &node); err != nil {
		t.Fatal(err)
	}
	// Humans without being asked: an unqualified "most played" that included
	// bots would be a survey of bot configuration.
	if !reflect.DeepEqual(node.Segments, []string{persistence.OpeningSegmentHuman}) {
		t.Fatalf("segments %v, want human by default", node.Segments)
	}
	if node.Games != 1 || len(node.Continuations) != 1 {
		t.Fatalf("payload: %#v", node)
	}
	if node.Plies != persistence.OpeningStatsPlies {
		t.Fatalf("plies %d, want %d", node.Plies, persistence.OpeningStatsPlies)
	}

	// A cohort nobody has is still a compiled answer, not a 404: "no bot games
	// yet" and "never compiled" read differently on the page.
	recorder = httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, httptest.NewRequest(
		"GET", "/api/openings/V3/stats?cohort=bot", nil,
	))
	if recorder.Code != 200 {
		t.Fatalf("bot cohort status %d: %s", recorder.Code, recorder.Body)
	}

	recorder = httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, httptest.NewRequest(
		"GET", "/api/openings/V3/stats?cohort=aliens", nil,
	))
	if recorder.Code != 400 {
		t.Fatalf("unknown cohort status %d, want 400", recorder.Code)
	}
}

func TestOpeningStatsIsAbsentUntilItIsCompiled(t *testing.T) {
	server := statsTestServer(t)
	recorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, httptest.NewRequest(
		"GET", "/api/openings/V3/stats", nil,
	))
	if recorder.Code != 404 {
		t.Fatalf("status %d, want 404 before the first compile", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), "not compiled yet") {
		t.Fatalf("body %q should say why", recorder.Body)
	}
}

// ---------------------------------------------------------------------------
// The explorer
// ---------------------------------------------------------------------------

func exploreStats(
	t *testing.T,
	server *Server,
	query string,
) (persistence.OpeningStatsExplored, int) {
	t.Helper()
	recorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, httptest.NewRequest(
		"GET", "/api/openings/V3/explore"+query, nil,
	))
	var explored persistence.OpeningStatsExplored
	if recorder.Code == 200 {
		if err := json.Unmarshal(recorder.Body.Bytes(), &explored); err != nil {
			t.Fatalf("%s: %v (%s)", query, err, recorder.Body)
		}
	}
	return explored, recorder.Code
}

// The explorer's third chip: every game, whoever played it.
//
// Worth its own test because a union cohort looks like something a caller
// could assemble from the other three and is not. Here a human game and a bot
// game reach one board by two different move orders: each disjoint cohort
// counts one game there, and so would any sum of them, but the board was in
// fact reached by two.
func TestTheExplorerCountsEverybodyTogether(t *testing.T) {
	server := statsTestServer(t)
	ctx := context.Background()
	red := game.PlayerProfile{UserID: "human-red", Username: "Red"}
	blue := game.PlayerProfile{UserID: "human-blue", Username: "Blue"}
	botRed := game.PlayerProfile{
		UserID:   persistence.BotAccountPrefix + "red",
		Username: "RPSFish",
	}
	botBlue := game.PlayerProfile{
		UserID:   persistence.BotAccountPrefix + "blue",
		Username: "ALTFish",
	}

	archiveOpening(t, server.data, playOpening(
		t, "humans", game.ModeInfiltration, red, blue,
		[]string{"d2-c3", "d7-c6", "f3-g4"}, game.Blue,
	), time.Now())
	archiveOpening(t, server.data, playOpening(
		t, "bots", game.ModeInfiltration, botRed, botBlue,
		[]string{"f3-g4", "d7-c6", "d2-c3"}, game.Blue,
	), time.Now())

	if err := server.compileOpeningStats(ctx, game.ModeInfiltration); err != nil {
		t.Fatal(err)
	}

	const board = "?line=d2-c3,d7-c6,f3-g4"
	for query, want := range map[string]int{
		board:                   1, // the default cohort, humans
		board + "&cohort=human": 1,
		board + "&cohort=bot":   1,
		board + "&cohort=all":   2,
	} {
		explored, status := exploreStats(t, server, query)
		if status != 200 {
			t.Fatalf("%s: status %d", query, status)
		}
		if explored.Games != want {
			t.Fatalf("%s: %d games, want %d", query, explored.Games, want)
		}
		// Every counted game in each of these cohorts reached this board.
		if explored.Share != 1 {
			t.Fatalf("%s: share %v, want 1", query, explored.Share)
		}
	}

	// And the union really is the union rather than a fourth slice: both first
	// moves are continuations of its starting position.
	node, err := server.data.OpeningStatsAt(
		ctx, string(game.ModeInfiltration), persistence.OpeningSegments, nil, 0,
	)
	if err != nil {
		t.Fatal(err)
	}
	if node.Games != 2 || len(node.Continuations) != 2 {
		t.Fatalf("union: %d games, continuations %#v", node.Games, node.Continuations)
	}
}

// The whole reason the explorer is keyed on the board rather than on the moves
// that reached it. `d2-c3 f3-g4` and `f3-g4 d2-c3` are two move orders to one
// picture, so a player standing on that board should see both games -- which
// the line-keyed statistics, correctly, count as two different openings.
func TestTheExplorerMergesTranspositions(t *testing.T) {
	server := statsTestServer(t)
	ctx := context.Background()
	red := game.PlayerProfile{UserID: "human-red", Username: "Red"}
	blue := game.PlayerProfile{UserID: "human-blue", Username: "Blue"}

	// Two Blue moves that do not interfere with each other, played either way
	// round, then one Red reply each so the boards really do coincide.
	archiveOpening(t, server.data, playOpening(
		t, "order-one", game.ModeInfiltration, red, blue,
		[]string{"d2-c3", "d7-c6", "f3-g4"}, game.Blue,
	), time.Now())
	archiveOpening(t, server.data, playOpening(
		t, "order-two", game.ModeInfiltration, red, blue,
		[]string{"f3-g4", "d7-c6", "d2-c3"}, game.Blue,
	), time.Now())

	if err := server.compileOpeningStats(ctx, game.ModeInfiltration); err != nil {
		t.Fatal(err)
	}

	// The board after all three moves, reached by the first order.
	explored, status := exploreStats(t, server, "?line=d2-c3,d7-c6,f3-g4")
	if status != 200 {
		t.Fatalf("status %d", status)
	}
	if explored.Games != 2 {
		t.Fatalf("the board was reached by %d games, want both", explored.Games)
	}
	// Reached by every counted game, so the share is the whole cohort.
	if explored.Share != 1 {
		t.Fatalf("share %v, want 1", explored.Share)
	}
	// And by the other order, which must be the same answer.
	other, status := exploreStats(t, server, "?line=f3-g4,d7-c6,d2-c3")
	if status != 200 {
		t.Fatalf("status %d", status)
	}
	if other.Games != explored.Games {
		t.Fatalf("the two move orders disagree: %d and %d", explored.Games, other.Games)
	}
	// The ply is the shortest route anybody took, and both are three.
	if explored.Ply != 3 {
		t.Fatalf("ply %d, want 3", explored.Ply)
	}

	// The line-keyed statistics still see two openings, which is the right
	// answer to the different question they answer.
	node, err := server.data.OpeningStatsAt(
		ctx, string(game.ModeInfiltration), []string{persistence.OpeningSegmentHuman}, nil, 0,
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(node.Continuations) != 2 {
		t.Fatalf("first moves: %#v", node.Continuations)
	}
}

func TestTheExplorerRanksTheMovesPlayedFromABoard(t *testing.T) {
	server := statsTestServer(t)
	ctx := context.Background()
	red := game.PlayerProfile{UserID: "human-red", Username: "Red"}
	blue := game.PlayerProfile{UserID: "human-blue", Username: "Blue"}

	// Three games open d2-c3; two answer d7-c6 and one f7-g6.
	for index, reply := range []string{"d7-c6", "d7-c6", "f7-g6"} {
		archiveOpening(t, server.data, playOpening(
			t, fmt.Sprintf("reply-%d", index), game.ModeInfiltration, red, blue,
			[]string{"d2-c3", reply}, game.Blue,
		), time.Now())
	}
	if err := server.compileOpeningStats(ctx, game.ModeInfiltration); err != nil {
		t.Fatal(err)
	}

	explored, status := exploreStats(t, server, "?line=d2-c3")
	if status != 200 {
		t.Fatalf("status %d", status)
	}
	if explored.Games != 3 {
		t.Fatalf("games at the board: %d", explored.Games)
	}
	if len(explored.Moves) != 2 {
		t.Fatalf("moves: %#v", explored.Moves)
	}
	best := explored.Moves[0]
	if best.Move != "d7-c6" || best.Games != 2 {
		t.Fatalf("most played reply: %#v", best)
	}
	// The conditional share is the explorer's number: two of the three games
	// that got here, not two of the three games in the mode. They happen to
	// coincide here, so the second move is the one that proves it.
	if best.Share != 2.0/3.0 {
		t.Fatalf("share of the board %v, want 2/3", best.Share)
	}
	if explored.Moves[1].Share != 1.0/3.0 {
		t.Fatalf("share of the board %v, want 1/3", explored.Moves[1].Share)
	}
}

func TestTheExplorerAnswersForBoardsNobodyHasReached(t *testing.T) {
	server := statsTestServer(t)
	archiveOpening(t, server.data, playOpening(
		t, "one", game.ModeInfiltration,
		game.PlayerProfile{UserID: "human-red", Username: "Red"},
		game.PlayerProfile{UserID: "human-blue", Username: "Blue"},
		openingLeft, game.Blue,
	), time.Now())
	if err := server.compileOpeningStats(context.Background(), game.ModeInfiltration); err != nil {
		t.Fatal(err)
	}

	// A legal line nobody played. Zero games is the answer for most of the
	// tree, so it must not be an error -- the page says "nobody has been here".
	explored, status := exploreStats(t, server, "?line=e3-e4")
	if status != 200 {
		t.Fatalf("status %d, want 200 for an unvisited board", status)
	}
	if explored.Games != 0 || len(explored.Moves) != 0 {
		t.Fatalf("unvisited board: %#v", explored)
	}
	// The caller still gets told where they are.
	if explored.Ply != 1 {
		t.Fatalf("ply %d, want the depth they walked to", explored.Ply)
	}

	// A line the rules refuse is a different thing and does fail.
	if _, status := exploreStats(t, server, "?line=d8-c7"); status != 400 {
		t.Fatalf("status %d for a move Red cannot make first, want 400", status)
	}
	if _, status := exploreStats(t, server, "?line=nonsense"); status != 400 {
		t.Fatalf("status %d for junk, want 400", status)
	}
}

// A game that returns to a board has not reached it twice, and counting it
// twice would let one game outvote another.
func TestABoardIsCountedOncePerGame(t *testing.T) {
	server := statsTestServer(t)
	ctx := context.Background()
	// Out and back: after four plies both sides have undone their move and it
	// is Blue's turn again, so the board is the starting position in every
	// respect that names a position. The fifth move is what makes this worth
	// asserting -- the game now *leaves* that one board twice.
	archiveOpening(t, server.data, playOpening(
		t, "shuffle", game.ModeInfiltration,
		game.PlayerProfile{UserID: "human-red", Username: "Red"},
		game.PlayerProfile{UserID: "human-blue", Username: "Blue"},
		[]string{"d2-c3", "d7-c6", "c3-d2", "c6-d7", "f3-g4"}, game.Blue,
	), time.Now())
	if err := server.compileOpeningStats(ctx, game.ModeInfiltration); err != nil {
		t.Fatal(err)
	}

	explored, status := exploreStats(t, server, "")
	if status != 200 {
		t.Fatalf("status %d", status)
	}
	if explored.Games != 1 {
		t.Fatalf("the starting position was reached %d times by one game", explored.Games)
	}
	// The move counts are per visit, though, and they have to be: the game
	// really did leave this one board twice, by two different moves, and an
	// explorer showing only the first would be hiding half of what happened.
	total := 0
	for _, move := range explored.Moves {
		total += move.Games
	}
	if total != 2 {
		t.Fatalf("moves out of the start total %d, want the two the game played", total)
	}
	if len(explored.Moves) != 2 {
		t.Fatalf("moves out of the start: %#v", explored.Moves)
	}
	// Which makes the conditional shares sum past 1, and that is not a bug:
	// the denominator is games that reached the board, the numerator is times
	// it was left. Only a repetition can do it, and only the explorer sees it.
	if explored.Moves[0].Share != 1 {
		t.Fatalf("share %v, want 1 -- the one game played this move from here",
			explored.Moves[0].Share)
	}
}
