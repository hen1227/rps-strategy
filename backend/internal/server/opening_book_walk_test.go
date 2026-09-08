package server

import (
	"context"
	"strings"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

// A published book, small enough to reason about and grown from the mode's own
// legal moves so that no test here hard-codes a square a mode definition could
// move. Every position is keyed by the line that reaches it, which is what lets
// an assertion say "that opening is one of ours" by walking the same keys.
type bookFixture struct {
	meta      persistence.OpeningGraphMeta
	positions []persistence.OpeningPosition
	children  map[string][]persistence.OpeningMove
}

const bookFixtureRoot = "root"

// bookFixtureKey names a position by the line that reaches it.
func bookFixtureKey(line []string) string {
	if len(line) == 0 {
		return bookFixtureRoot
	}
	return strings.Join(line, " ")
}

// growBookFixture builds a book `depth` plies deep, storing the first `breadth`
// legal moves out of every position it writes.
//
// Positions at the bottom get their moves without children, which is the
// frontier the real export has four edges in ten of: the scan ranked the move
// and stopped there. A walk may end on one and may not pass through one.
func growBookFixture(
	t *testing.T,
	registry *game.ModeRegistry,
	modeID game.ModeID,
	depth, breadth int,
	score func(ply, rank int) int,
) bookFixture {
	t.Helper()
	fixture := bookFixture{
		meta: persistence.OpeningGraphMeta{
			ModeID: string(modeID), ModeName: "fixture", EngineVersion: "test",
			RulesVersion: 1, Weights: "fixture", Symmetry: "files",
			MaxPly: depth, RootKey: bookFixtureRoot,
		},
		children: make(map[string][]persistence.OpeningMove),
	}

	var grow func(line []string)
	grow = func(line []string) {
		key := bookFixtureKey(line)
		if _, written := fixture.children[key]; written {
			return
		}
		scratch := replayFixture(t, registry, modeID, line)
		state := scratch.Snapshot()
		if state.Status != game.InProgress {
			return
		}
		legal := scratch.LegalMoves()
		if len(legal) > breadth {
			legal = legal[:breadth]
		}
		position := persistence.OpeningPosition{
			Key: key, Turn: string(state.CurrentTurn), Depth: 20,
			SelectiveDepth: 26, Nodes: 1000,
			Moves: make([]persistence.OpeningMove, 0, len(legal)),
		}
		for index, move := range legal {
			rank := index + 1
			child := ""
			if len(line) < depth {
				child = bookFixtureKey(append(append([]string{}, line...), openingLine([]game.Move{move})))
			}
			position.Moves = append(position.Moves, persistence.OpeningMove{
				Move:     openingLine([]game.Move{move}),
				Score:    score(len(line), rank),
				Rank:     rank,
				Searched: true,
				MainLine: rank == 1,
				Child:    child,
			})
		}
		fixture.positions = append(fixture.positions, position)
		fixture.children[key] = position.Moves
		if len(line) >= depth {
			return
		}
		for _, move := range position.Moves {
			grow(append(append([]string{}, line...), move.Move))
		}
	}
	grow(nil)
	return fixture
}

// replayFixture plays a line onto a fresh game, so the fixture only ever
// records moves the rules accept.
func replayFixture(
	t *testing.T,
	registry *game.ModeRegistry,
	modeID game.ModeID,
	line []string,
) *game.Game {
	t.Helper()
	scratch, err := game.NewGameWithRegistry(
		registry, "fixture", modeID,
		game.PlayerProfile{UserID: "red"}, game.PlayerProfile{UserID: "blue"},
	)
	if err != nil {
		t.Fatalf("new fixture game: %v", err)
	}
	for _, text := range line {
		move, ok := parseOpeningBookMove(text)
		if !ok {
			t.Fatalf("fixture wrote unreadable notation %q", text)
		}
		state := scratch.Snapshot()
		if _, err := scratch.Move(state.CurrentTurn, move.From, move.To); err != nil {
			t.Fatalf("fixture move %q rejected: %v", text, err)
		}
	}
	return scratch
}

// publishFixture puts the fixture where dealOpening will look for it.
func publishFixture(t *testing.T, server *Server, fixture bookFixture) {
	t.Helper()
	if _, err := server.data.ReplaceOpeningGraph(
		context.Background(), fixture.meta, fixture.positions,
	); err != nil {
		t.Fatalf("publish fixture book: %v", err)
	}
}

// assertBookLine walks a dealt opening back through the fixture, which is the
// whole claim: every move came out of the position the walk was standing on.
func assertBookLine(t *testing.T, fixture bookFixture, moves []game.Move) {
	t.Helper()
	line := make([]string, 0, len(moves))
	for index, move := range moves {
		ranked, known := fixture.children[bookFixtureKey(line)]
		if !known {
			t.Fatalf("opening %v left the book at ply %d", openingLine(moves), index+1)
		}
		text := openingLine([]game.Move{move})
		found := false
		for _, candidate := range ranked {
			if candidate.Move == text {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("ply %d of %q is not a move the book ranked", index+1, openingLine(moves))
		}
		line = append(line, text)
	}
}

func bookFixtureServer(t *testing.T) *Server {
	t.Helper()
	data, err := persistence.Open(":memory:")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = data.Close() })
	return NewWithStore(data, nil)
}

// The point of the change: a series no longer opens on a position nobody has
// looked at. Every ply of every dealt opening has to be a move the book ranked
// out of the position the walk had reached.
func TestDealtOpeningIsALineTheBookRanked(t *testing.T) {
	server := bookFixtureServer(t)
	fixture := growBookFixture(
		t, server.registry, game.ModeInfiltration, 3, 3,
		func(ply, rank int) int { return 40 - ply*3 - rank*5 },
	)
	publishFixture(t, server, fixture)

	// Three plies walks through the book; four ends on a frontier move, which
	// is a line the book has and a position it never expanded.
	for _, plies := range []int{1, 3, 4} {
		distinct := make(map[string]struct{})
		for seed := uint64(1); seed <= 40; seed++ {
			moves, _, ok := server.dealOpening(
				context.Background(), game.ModeInfiltration, seed, plies,
			)
			if !ok {
				t.Fatalf("%d plies, seed %d: no opening", plies, seed)
			}
			if len(moves) != plies {
				t.Fatalf("%d plies, seed %d: got %d moves", plies, seed, len(moves))
			}
			assertBookLine(t, fixture, moves)
			distinct[openingLine(moves)] = struct{}{}
		}
		// Varying the opening is the reason any of this exists; a book walk
		// that dealt one line every time would measure exactly as little as a
		// fixed starting position does.
		if plies > 1 && len(distinct) < 4 {
			t.Fatalf("%d plies: only %d distinct openings in 40 seeds", plies, len(distinct))
		}
	}
}

// The same seed has to name the same opening, or a pair's two games would start
// from different boards and the swap would cancel nothing.
func TestDealtBookOpeningIsReproducible(t *testing.T) {
	server := bookFixtureServer(t)
	fixture := growBookFixture(
		t, server.registry, game.ModeInfiltration, 3, 3,
		func(ply, rank int) int { return 40 - ply*3 - rank*5 },
	)
	publishFixture(t, server, fixture)

	first, firstSeed, ok := server.dealOpening(context.Background(), game.ModeInfiltration, 99, 3)
	if !ok {
		t.Fatal("no opening")
	}
	second, secondSeed, ok := server.dealOpening(context.Background(), game.ModeInfiltration, 99, 3)
	if !ok {
		t.Fatal("no opening on the second call")
	}
	if firstSeed != secondSeed || openingLine(first) != openingLine(second) {
		t.Fatalf("the same seed dealt %q then %q", openingLine(first), openingLine(second))
	}
}

// A book is something a mode acquires. Until it has one, a series still has to
// start, and it has to start from exactly what it started from before.
func TestDealtOpeningFallsBackToTheRandomWalkWithoutABook(t *testing.T) {
	server := bookFixtureServer(t)
	for _, plies := range []int{0, 4} {
		dealt, dealtSeed, ok := server.dealOpening(
			context.Background(), game.ModeTotalWar, 12345, plies,
		)
		if !ok {
			t.Fatalf("%d plies: no opening", plies)
		}
		walked, walkedSeed, ok := buildOpening(server.registry, game.ModeTotalWar, 12345, plies)
		if !ok {
			t.Fatalf("%d plies: the random walk itself failed", plies)
		}
		if dealtSeed != walkedSeed || openingLine(dealt) != openingLine(walked) {
			t.Fatalf(
				"%d plies: fallback dealt %q (seed %d), random walk gives %q (seed %d)",
				plies, openingLine(dealt), dealtSeed, openingLine(walked), walkedSeed,
			)
		}
	}
}

// The book ranks every legal move at the root -- 23 of them in V3, down to
// scores nobody would open with. Only the top few are openings.
func TestDealtOpeningStopsAtTheBooksRankCap(t *testing.T) {
	server := bookFixtureServer(t)
	fixture := growBookFixture(
		t, server.registry, game.ModeInfiltration, 2, openingBookChoices+3,
		func(ply, rank int) int { return 40 - ply*3 - rank*5 },
	)
	publishFixture(t, server, fixture)

	capped := make(map[string]int, openingBookChoices)
	for _, move := range fixture.children[bookFixtureRoot] {
		capped[move.Move] = move.Rank
	}
	for seed := uint64(1); seed <= 120; seed++ {
		moves, _, ok := server.dealOpening(context.Background(), game.ModeInfiltration, seed, 2)
		if !ok {
			t.Fatalf("seed %d: no opening", seed)
		}
		if rank := capped[openingLine(moves[:1])]; rank > openingBookChoices {
			t.Fatalf("seed %d opened on the book's rank %d move", seed, rank)
		}
	}
}

// A move scored past MATE_THRESHOLD is a finished game, not an opening. It is
// still a move the book ranked, so nothing but this rule keeps it out.
func TestDealtOpeningRefusesTheBooksDecisiveMoves(t *testing.T) {
	server := bookFixtureServer(t)
	// Rank 2 at every position is a forced loss for the side to move; rank 1
	// and rank 3 are ordinary.
	fixture := growBookFixture(
		t, server.registry, game.ModeInfiltration, 3, 3,
		func(ply, rank int) int {
			if rank == 2 {
				return -openingBookDecisive - 994
			}
			return 40 - ply*3 - rank*5
		},
	)
	publishFixture(t, server, fixture)

	decisive := make(map[string]struct{})
	for key, moves := range fixture.children {
		for _, move := range moves {
			if move.Rank == 2 {
				decisive[key+"|"+move.Move] = struct{}{}
			}
		}
	}
	for seed := uint64(1); seed <= 120; seed++ {
		moves, _, ok := server.dealOpening(context.Background(), game.ModeInfiltration, seed, 3)
		if !ok {
			t.Fatalf("seed %d: no opening", seed)
		}
		line := make([]string, 0, len(moves))
		for _, move := range moves {
			text := openingLine([]game.Move{move})
			if _, banned := decisive[bookFixtureKey(line)+"|"+text]; banned {
				t.Fatalf("seed %d dealt the decisive move %q", seed, text)
			}
			line = append(line, text)
		}
	}
}

// Every move before the last needs a position stored behind it: the walk has to
// step into it. A book only one ply deep can still open a one-ply game and
// nothing longer.
func TestDealtOpeningWillNotWalkThroughAFrontierMove(t *testing.T) {
	server := bookFixtureServer(t)
	fixture := growBookFixture(
		t, server.registry, game.ModeInfiltration, 0, 3,
		func(ply, rank int) int { return 40 - rank*5 },
	)
	publishFixture(t, server, fixture)

	moves, _, ok := server.dealOpening(context.Background(), game.ModeInfiltration, 5, 1)
	if !ok || len(moves) != 1 {
		t.Fatalf("a one-ply book should deal a one-ply opening, got %d (ok=%v)", len(moves), ok)
	}
	assertBookLine(t, fixture, moves)

	// Two plies cannot come out of this book, so the deal falls back rather
	// than inventing a second move or refusing to run the series.
	deeper, deeperSeed, ok := server.dealOpening(context.Background(), game.ModeInfiltration, 5, 2)
	if !ok || len(deeper) != 2 {
		t.Fatalf("expected the random walk to cover the second ply, got %d (ok=%v)", len(deeper), ok)
	}
	walked, walkedSeed, _ := buildOpening(server.registry, game.ModeInfiltration, 5, 2)
	if deeperSeed != walkedSeed || openingLine(deeper) != openingLine(walked) {
		t.Fatalf("expected the random walk's own opening, got %q", openingLine(deeper))
	}
}

// End to end: the openings a real run deals its pairs are the book's, and both
// games of a pair still start from the same one.
func TestASeriesDealsItsPairsBookOpenings(t *testing.T) {
	server, alpha, beta := seriesTestBots(t)
	fixture := growBookFixture(
		t, server.registry, game.ModeTotalWar, 3, 3,
		func(ply, rank int) int { return 40 - ply*3 - rank*5 },
	)
	publishFixture(t, server, fixture)

	if _, err := server.StartBotSeries(
		t.Context(), hostSeries(alpha, beta, game.ModeTotalWar, 2, 3, 1234),
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

	perPair := make(map[int]string, 2)
	for _, entry := range series.Games {
		line := strings.Fields(entry.OpeningLine)
		if len(line) != 3 {
			t.Fatalf("game %d was dealt %d plies: %q", entry.GameNumber, len(line), entry.OpeningLine)
		}
		// The claim: every ply came out of the book, at the position the walk
		// had reached.
		walked := make([]string, 0, len(line))
		for index, move := range line {
			ranked, known := fixture.children[bookFixtureKey(walked)]
			if !known {
				t.Fatalf("game %d left the book at ply %d: %q", entry.GameNumber, index+1, entry.OpeningLine)
			}
			found := false
			for _, candidate := range ranked {
				if candidate.Move == move {
					found = true
					break
				}
			}
			if !found {
				t.Fatalf("game %d ply %d (%q) is not a move the book ranked", entry.GameNumber, index+1, move)
			}
			walked = append(walked, move)
		}
		if previous, seen := perPair[entry.PairNumber]; seen && previous != entry.OpeningLine {
			t.Fatalf(
				"pair %d played %q and %q; both games of a pair are one opening",
				entry.PairNumber, previous, entry.OpeningLine,
			)
		}
		perPair[entry.PairNumber] = entry.OpeningLine
	}
}
