package notation

import (
	"math/rand"
	"reflect"
	"strings"
	"testing"

	"rps-strategy/backend/internal/game"
)

func newTestGame(t *testing.T, modeID game.ModeID) *game.Game {
	t.Helper()
	played, err := game.NewGameWithTimeControl(
		"pgn-test-"+string(modeID),
		modeID,
		game.PlayerProfile{UserID: "red-uuid", Username: "Alice"},
		game.PlayerProfile{UserID: "blue-uuid", Username: "Bob"},
		game.TimeControl{InitialTimeMs: 300000, IncrementMs: 3000},
	)
	if err != nil {
		t.Fatal(err)
	}
	return played
}

// playOut runs a reproducible random game so the notation is exercised against
// real positions, real captures, and whatever ending the rules produce.
func playOut(t *testing.T, played *game.Game, seed int64, maxPlies int) {
	t.Helper()
	random := rand.New(rand.NewSource(seed))
	for ply := 0; ply < maxPlies; ply++ {
		state := played.Snapshot()
		if state.Status != game.InProgress {
			return
		}
		type candidate struct{ from, to game.Position }
		candidates := make([]candidate, 0, 64)
		for y := 0; y < game.BoardSize; y++ {
			for x := 0; x < game.BoardSize; x++ {
				if state.Grid[y][x].OccupantOwner != state.CurrentTurn {
					continue
				}
				from := game.Position{X: x, Y: y}
				for _, to := range played.ValidMoves(state.CurrentTurn, from) {
					candidates = append(candidates, candidate{from: from, to: to})
				}
			}
		}
		if len(candidates) == 0 {
			return
		}
		chosen := candidates[random.Intn(len(candidates))]
		if _, err := played.Move(state.CurrentTurn, chosen.from, chosen.to); err != nil {
			t.Fatalf("ply %d rejected: %v", ply, err)
		}
	}
}

func requireRoundTrip(t *testing.T, record game.Record) ParsedGame {
	t.Helper()
	text := Encode(record, Metadata{Event: "Ranked", Ranked: true})
	parsed, err := Parse(text)
	if err != nil {
		t.Fatalf("parse failed: %v\n%s", err, text)
	}
	if !reflect.DeepEqual(record.Events, parsed.Record.Events) {
		for index := range record.Events {
			if index >= len(parsed.Record.Events) {
				t.Fatalf("event %d missing after round trip", index)
			}
			if record.Events[index] != parsed.Record.Events[index] {
				t.Fatalf(
					"event %d differs\n original: %+v\nround trip: %+v",
					index, record.Events[index], parsed.Record.Events[index],
				)
			}
		}
		t.Fatalf("event counts differ: %d vs %d", len(record.Events), len(parsed.Record.Events))
	}
	if !record.Final.Grid.Equal(parsed.Record.Final.Grid) {
		t.Fatal("final board did not survive the round trip")
	}
	if err := game.Verify(parsed.Record); err != nil {
		t.Fatalf("parsed record does not replay: %v\n%s", err, text)
	}
	return parsed
}

func TestPGNRoundTripsRandomGamesInEveryMode(t *testing.T) {
	for _, modeID := range game.DefaultModeRegistry.IDs() {
		for seed := int64(1); seed <= 4; seed++ {
			played := newTestGame(t, modeID)
			playOut(t, played, seed, 400)
			if played.Snapshot().Status == game.InProgress {
				if _, err := played.Resign(game.Blue); err != nil {
					t.Fatal(err)
				}
			}
			record := played.Record()
			parsed := requireRoundTrip(t, record)
			if parsed.Record.Mode.ID != modeID {
				t.Fatalf("mode %s became %s", modeID, parsed.Record.Mode.ID)
			}
			if parsed.Result != Result(record.Final) {
				t.Fatalf("result %s became %s", Result(record.Final), parsed.Result)
			}
		}
	}
}

func TestPGNRoundTripsProposalsAndEndings(t *testing.T) {
	played := newTestGame(t, game.ModeTotalWar)
	if _, err := played.OfferTimeExtension(game.Red); err != nil {
		t.Fatal(err)
	}
	if _, err := played.AcceptTimeExtension(game.Blue); err != nil {
		t.Fatal(err)
	}
	playOut(t, played, 11, 6)
	if _, err := played.OfferDraw(played.Snapshot().CurrentTurn); err != nil {
		t.Fatal(err)
	}
	current := played.Snapshot().CurrentTurn
	if _, err := played.DeclineDraw(oppositeOf(current)); err != nil {
		t.Fatal(err)
	}
	playOut(t, played, 12, 4)
	if _, err := played.Resign(played.Snapshot().CurrentTurn); err != nil {
		t.Fatal(err)
	}

	record := played.Record()
	parsed := requireRoundTrip(t, record)
	text := Encode(record, Metadata{})
	for _, fragment := range []string{"%act time_offer", "%act time_accept", "%act draw_offer", "%act draw_decline", "%end resignation"} {
		if !strings.Contains(text, fragment) {
			t.Fatalf("movetext is missing %s\n%s", fragment, text)
		}
	}
	if parsed.Record.Final.EndReason != game.EndReasonResignation {
		t.Fatalf("unexpected end reason %q", parsed.Record.Final.EndReason)
	}
}

func oppositeOf(color game.PlayerColor) game.PlayerColor {
	if color == game.Red {
		return game.Blue
	}
	return game.Red
}

func TestPGNIsReadable(t *testing.T) {
	played := newTestGame(t, game.ModeInfiltration)
	// d3-d4 is a quiet rock-file advance off Blue's opening rank, and Blue is
	// the side that opens.
	from := game.Position{X: 3, Y: 2}
	to := game.Position{X: 3, Y: 3}
	if _, err := played.Move(game.Blue, from, to); err != nil {
		t.Fatal(err)
	}
	text := Encode(played.Record(), Metadata{Event: "Ranked", Ranked: true, Site: "RPS Strategy"})

	for _, fragment := range []string{
		`[Event "Ranked"]`,
		`[Red "Alice"]`,
		`[Blue "Bob"]`,
		`[Variant "Infiltration"]`,
		`[ModeId "V3"]`,
		`[TimeControl "300+3"]`,
		`[FEN "3SSS3/3PPP3/3RRR3/9/9/9/3rrr3/3ppp3/3sss3 b 3bbb3/3bbb3/3bbb3/9/9/9/3rrr3/3rrr3/3rrr3"]`,
		"1. Rd3-d4 ",
		"[%clk ",
	} {
		if !strings.Contains(text, fragment) {
			t.Fatalf("PGN is missing %s:\n%s", fragment, text)
		}
	}
	if !strings.Contains(text, "*") {
		t.Fatalf("an unfinished game should end with *:\n%s", text)
	}
}

func TestPGNWritesCapturesWithoutNamingTheVictim(t *testing.T) {
	played := newTestGame(t, game.ModeTotalWar)
	record := played.Record()
	record.Events = []game.Event{{
		Kind:     game.EventMove,
		Player:   game.Red,
		Piece:    game.Rock,
		Captured: game.Scissors,
		From:     game.Position{X: 3, Y: 6},
		To:       game.Position{X: 3, Y: 5},
	}}
	if token := FormatMove(record.Events[0], false); token != "Rd7xd6" {
		t.Fatalf("expected Rd7xd6, got %s", token)
	}
	parsed, err := ParseMove("Rd7xd6")
	if err != nil {
		t.Fatal(err)
	}
	if parsed.Captured != game.Scissors {
		t.Fatalf("a rock capture must be scissors, got %s", parsed.Captured)
	}
	// An unusual capture spells its victim out so exotic modes stay lossless.
	unusual := game.Event{
		Kind: game.EventMove, Piece: game.Rock, Captured: game.Paper,
		From: game.Position{X: 0, Y: 0}, To: game.Position{X: 0, Y: 1},
	}
	token := FormatMove(unusual, true)
	if token != "Ra1xPa2#" {
		t.Fatalf("expected Ra1xPa2#, got %s", token)
	}
	reparsed, err := ParseMove(token)
	if err != nil {
		t.Fatal(err)
	}
	if reparsed.Captured != game.Paper {
		t.Fatalf("expected a captured paper, got %s", reparsed.Captured)
	}
}

func TestParseMultiReadsAnArchive(t *testing.T) {
	archive := strings.Builder{}
	for seed := int64(1); seed <= 3; seed++ {
		played := newTestGame(t, game.ModeInfiltration)
		playOut(t, played, seed, 40)
		if played.Snapshot().Status == game.InProgress {
			if _, err := played.Resign(game.Red); err != nil {
				t.Fatal(err)
			}
		}
		archive.WriteString(Encode(played.Record(), Metadata{Ranked: true}))
		archive.WriteString("\n")
	}
	games, err := ParseMulti(archive.String())
	if err != nil {
		t.Fatal(err)
	}
	if len(games) != 3 {
		t.Fatalf("expected 3 games, got %d", len(games))
	}
	for index, parsed := range games {
		if err := game.Verify(parsed.Record); err != nil {
			t.Fatalf("archived game %d does not replay: %v", index, err)
		}
	}
}

func TestSquareNames(t *testing.T) {
	for _, testCase := range []struct {
		position game.Position
		name     string
	}{
		{game.Position{X: 0, Y: 0}, "a1"},
		{game.Position{X: 8, Y: 8}, "i9"},
		{game.Position{X: 3, Y: 6}, "d7"},
	} {
		if name := FormatSquare(testCase.position); name != testCase.name {
			t.Fatalf("expected %s, got %s", testCase.name, name)
		}
		parsed, err := ParseSquare(testCase.name)
		if err != nil || parsed != testCase.position {
			t.Fatalf("%s parsed to %v (%v)", testCase.name, parsed, err)
		}
	}
	// Files past i and ranks past 9 belong to boards bigger than the built-in
	// modes, and are read rather than refused: a move is parsed before the FEN
	// beside it has settled the shape.
	if parsed, err := ParseSquare("j10"); err != nil ||
		parsed != (game.Position{X: 9, Y: 9}) {
		t.Fatalf("j10 parsed to %v (%v)", parsed, err)
	}
	for _, notASquare := range []string{"aa1", "z27", "a0", "a", "1a", "a-1"} {
		if _, err := ParseSquare(notASquare); err == nil {
			t.Fatalf("%q is not a square on any board", notASquare)
		}
	}
}

func TestPositionRoundTrip(t *testing.T) {
	played := newTestGame(t, game.ModeTotalWar)
	playOut(t, played, 5, 30)
	state := played.Snapshot()

	encoded := EncodePosition(state.Grid, state.CurrentTurn)
	grid, turn, err := DecodePosition(encoded)
	if err != nil {
		t.Fatal(err)
	}
	if !grid.Equal(state.Grid) {
		t.Fatal("board did not survive encoding")
	}
	if turn != state.CurrentTurn {
		t.Fatalf("side to move %s became %s", state.CurrentTurn, turn)
	}
}

func TestPGNRoundTripsAFullCustomStartingPosition(t *testing.T) {
	const startingFEN = "4S4/9/9/9/9/9/9/9/4r4 b 4r4/9/9/9/9/9/9/9/4b4"
	const finalFEN = "9/4S4/9/9/9/9/9/9/4r4 r 4r4/9/9/9/9/9/9/9/4b4"
	pgn := strings.Join([]string{
		`[Event "Custom position"]`,
		`[Red "Alice"]`,
		`[Blue "Bob"]`,
		`[Result "*"]`,
		`[GameId "custom-fen"]`,
		`[Variant "Infiltration"]`,
		`[ModeId "V3"]`,
		`[TimeControl "300+0"]`,
		`[SetUp "1"]`,
		`[FEN "` + startingFEN + `"]`,
		`[FinalFEN "` + finalFEN + `"]`,
		`[MoveNumber "1"]`,
		"",
		`1. Se1-e2 {[%emt 1] [%clk 0:05:00.000 0:04:59.000]} *`,
	}, "\n")

	parsed, err := Parse(pgn)
	if err != nil {
		t.Fatal(err)
	}
	if err := game.Verify(parsed.Record); err != nil {
		t.Fatalf("custom starting position does not replay: %v", err)
	}
	replayed, err := game.Replay(parsed.Record)
	if err != nil {
		t.Fatal(err)
	}
	encoded := Encode(replayed.Record(), Metadata{})
	if !strings.Contains(encoded, `[FEN "`+startingFEN+`"]`) {
		t.Fatalf("custom starting position was not preserved:\n%s", encoded)
	}
}

func TestTimeControlFormatting(t *testing.T) {
	for _, testCase := range []struct {
		control game.TimeControl
		text    string
	}{
		{game.TimeControl{InitialTimeMs: 300000, IncrementMs: 3000}, "300+3"},
		{game.TimeControl{InitialTimeMs: 60000, IncrementMs: 0}, "60+0"},
		{game.TimeControl{InitialTimeMs: 1500, IncrementMs: 250}, "1.5+0.25"},
	} {
		if text := FormatTimeControl(testCase.control); text != testCase.text {
			t.Fatalf("expected %s, got %s", testCase.text, text)
		}
		parsed, err := ParseTimeControl(testCase.text)
		if err != nil || parsed != testCase.control {
			t.Fatalf("%s parsed to %+v (%v)", testCase.text, parsed, err)
		}
	}
}

// The archive holds games written when "12." meant Red rather than the opener,
// and the two only disagree about a game the non-opening side began. One such
// game, in each dialect, replaying into the same record.
func TestBothDialectsReadAGameTheNonOpenerBegan(t *testing.T) {
	// Red to move on a board somebody set up: a Red rock on e1 with one Blue
	// scissors out of its way on e5, so Red's move is the first of the game and
	// Red is not the side that opens a normal one.
	const startingFEN = "4r4/9/9/9/4S4/9/9/9/9 r 4r4/9/9/9/4b4/9/9/9/9"
	const finalFEN = "9/4r4/9/9/4S4/9/9/9/9 b 4r4/9/9/9/4b4/9/9/9/9"
	fixture := func(generator, numbering string) string {
		return strings.Join([]string{
			`[Event "Dialects"]`,
			`[Red "Alice"]`,
			`[Blue "Bob"]`,
			`[Result "*"]`,
			`[GameId "dialect-fixture"]`,
			`[Variant "Infiltration"]`,
			`[ModeId "V3"]`,
			`[TimeControl "300+0"]`,
			`[SetUp "1"]`,
			`[FEN "` + startingFEN + `"]`,
			`[FinalFEN "` + finalFEN + `"]`,
			`[MoveNumber "1"]`,
			`[Generator "` + generator + `"]`,
			"",
			numbering + ` Re1-e2 {[%emt 1] [%clk 0:04:59.000 0:05:00.000]} *`,
		}, "\n")
	}
	// Dialect 1 wrote Red's move as "1." because it was Red's; dialect 2 writes
	// it as "1." because it is the first move of this game. The same file read
	// two ways, which is what makes the second dialect safe to adopt.
	legacy := fixture("rps-strategy-pgn/1", "1.")
	current := fixture(Generator, "1.")

	for name, text := range map[string]string{"dialect 1": legacy, "dialect 2": current} {
		parsed, err := Parse(text)
		if err != nil {
			t.Fatalf("%s did not parse: %v", name, err)
		}
		if err := game.Verify(parsed.Record); err != nil {
			t.Fatalf("%s does not replay: %v", name, err)
		}
		moves := parsed.Record.Moves()
		if len(moves) != 1 || moves[0].Player != game.Red {
			t.Fatalf("%s read the move as %#v", name, moves)
		}
	}

	// And written back out, the move keeps its number: a record round-trips
	// through the dialect it is written in rather than picking up whichever
	// number the colour would have had.
	replayed, err := game.Replay(mustParse(t, current).Record)
	if err != nil {
		t.Fatal(err)
	}
	if encoded := Encode(replayed.Record(), Metadata{}); !strings.Contains(encoded, "1. Re1-e2") {
		t.Fatalf("a re-encoded record renumbered the opening move:\n%s", encoded)
	}
}

func mustParse(t *testing.T, text string) ParsedGame {
	t.Helper()
	parsed, err := Parse(text)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}

// The scale the rating tags are written on travels with them.
//
// RedElo and BlueElo are standard PGN tag names and the numbers under them are
// not comparable across the change: the archive is published, and 200 is a
// plausible rating on both the old 1200-centred scale and the anchored one —
// a weak player on the first and a strong one on the second. Nothing in a file
// would look wrong to a reader that mixed them.
func TestAStoredGameSaysWhichRatingScaleItsNumbersAreOn(t *testing.T) {
	played := newTestGame(t, game.ModeInfiltration)
	if _, err := played.Move(
		game.Blue, game.Position{X: 3, Y: 2}, game.Position{X: 3, Y: 3},
	); err != nil {
		t.Fatal(err)
	}
	record := played.Record()
	text := Encode(record, Metadata{
		Event:        "Ranked",
		Ranked:       true,
		RedEloBefore: 40, RedEloAfter: 45,
		BlueEloBefore: 38, BlueEloAfter: 36,
	})
	if !strings.Contains(text, `[RatingSystem "`+RatingSystem+`"]`) {
		t.Fatalf("the scale did not reach the file:\n%s", text)
	}

	parsed, err := Parse(text)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if parsed.Metadata.RatingScale != RatingSystem {
		t.Fatalf("the scale did not survive the round trip: %q", parsed.Metadata.RatingScale)
	}

	// A game with no ratings on it does not carry the tag, because there is
	// nothing for it to qualify.
	plain := Encode(record, Metadata{Event: "Casual"})
	if strings.Contains(plain, "RatingSystem") {
		t.Fatalf("an unrated game claimed a rating scale:\n%s", plain)
	}

	// And a file from before the tag existed parses as the old scale rather than
	// as this one, which is the whole point of reading it off the file.
	older := strings.ReplaceAll(text, `[RatingSystem "`+RatingSystem+`"]`+"\n", "")
	was, err := Parse(older)
	if err != nil {
		t.Fatalf("parse older: %v", err)
	}
	if was.Metadata.RatingScale != "" {
		t.Fatalf("a file with no tag claimed a scale: %q", was.Metadata.RatingScale)
	}
}

// Which build of an engine played a game is a fact about that game, and the
// archive is the only place it can be kept: a bot's current build is whatever
// it happens to be running today rather than what played this.
func TestAStoredGameSaysWhichEngineBuildsPlayedIt(t *testing.T) {
	played := newTestGame(t, game.ModeInfiltration)
	if _, err := played.Move(
		game.Blue, game.Position{X: 3, Y: 2}, game.Position{X: 3, Y: 3},
	); err != nil {
		t.Fatal(err)
	}
	record := played.Record()

	text := Encode(record, Metadata{
		Event:      "Bot Match",
		RedEngine:  "RPSFish 0.4.1",
		BlueEngine: "Chomper build 77",
	})
	if !strings.Contains(text, `[RedEngine "RPSFish 0.4.1"]`) ||
		!strings.Contains(text, `[BlueEngine "Chomper build 77"]`) {
		t.Fatalf("the builds did not reach the file:\n%s", text)
	}
	// A new tag may not disturb the moves or anything else a reader depends
	// on, so the record still has to come back out intact.
	if _, err := Parse(text); err != nil {
		t.Fatalf("parse a game carrying engine builds: %v", err)
	}

	// A game with no engine in it says nothing about engines. Two people
	// playing each other must archive exactly as they did before this existed.
	human := Encode(record, Metadata{Event: "Casual"})
	if strings.Contains(human, "Engine") {
		t.Fatalf("a human game claimed an engine build:\n%s", human)
	}

	// One engine against a person names the one seat that had an engine in it,
	// rather than writing an empty tag for the other.
	mixed := Encode(record, Metadata{Event: "Casual", BlueEngine: "Chomper 2.0"})
	if strings.Contains(mixed, "RedEngine") {
		t.Fatalf("an empty seat was given a build:\n%s", mixed)
	}
	if !strings.Contains(mixed, `[BlueEngine "Chomper 2.0"]`) {
		t.Fatalf("the engine that did play was left out:\n%s", mixed)
	}

	// And a record from before the tags existed still parses, which is the
	// property that matters: the archive is not migrated and cannot be.
	older := Encode(record, Metadata{Event: "Bot Match"})
	if _, err := Parse(older); err != nil {
		t.Fatalf("parse a record from before the tags: %v", err)
	}
}
