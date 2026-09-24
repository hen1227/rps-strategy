//go:build meaf

package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/meafarchive"
	"rps-strategy/backend/internal/persistence"
)

// The claim the import rests on: meaf.us plays the game this server calls
// Intransitive, on today's board, with Blue moving first -- so its games need
// no relabelling at all, unlike this site's own pre-change archive.
//
// Checked by replaying every game in full rather than the twelve plies the
// compiler keeps. A shared opening proves much less than a shared endgame: two
// rule sets can agree for a dozen moves and part company over a corner.
//
// "In full" is a stronger claim than it was: this engine draws a game after
// game.QuietPlyLimit plies with nothing taken, and meaf.us does not, so a game
// long enough and quiet enough would end here before it ended there and stop
// contributing its tail. None is. That is worth pinning rather than assuming --
// the same replay at a hundred plies cut three of these games short, and thirty
// more would go if game.RepetitionDrawEnabled were turned on. Either count
// shows up below as games that do not finish.
func TestMeafExportPlaysUnderIntransitiveRules(t *testing.T) {
	server := openingTestServer(t)
	played, refused, moves := 0, 0, 0
	for _, export := range meafarchive.Games() {
		scratch, err := server.newOpeningScratchGame(meafModeID)
		if err != nil {
			t.Fatal(err)
		}
		ok := true
		for _, text := range export.Moves {
			state := scratch.Snapshot()
			if state.Status != game.InProgress {
				ok = false
				break
			}
			movement, parsed := parseOpeningBookMove(text)
			if !parsed {
				ok = false
				break
			}
			if _, err := scratch.Move(state.CurrentTurn, movement.From, movement.To); err != nil {
				ok = false
				break
			}
			moves++
		}
		if ok {
			played++
		} else {
			refused++
		}
	}
	if refused != 0 {
		t.Fatalf("%d of %d meaf.us games do not replay under %s", refused, played+refused, meafModeID)
	}
	if moves != 255274 {
		t.Fatalf("replayed %d moves, want every one of the 255274 in the export", moves)
	}
}

// The import lands in its own segment and nowhere else: it does not inflate
// this site's own human count, and it does not appear under a mode meaf.us
// does not play.
func TestMeafImportCompilesIntoItsOwnSegment(t *testing.T) {
	server := statsTestServer(t)
	ctx := context.Background()

	archiveOpening(t, server.data, playOpening(
		t, "ours", meafModeID,
		game.PlayerProfile{UserID: "human-red", Username: "Red"},
		game.PlayerProfile{UserID: "human-blue", Username: "Blue"},
		[]string{"e3-e4"}, game.Red,
	), time.Now())

	if err := server.compileOpeningStats(ctx, meafModeID); err != nil {
		t.Fatal(err)
	}
	ours, err := server.data.OpeningStatsAt(
		ctx, string(meafModeID), []string{persistence.OpeningSegmentHuman}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if ours.Games != 1 {
		t.Fatalf("this site's human segment counted %d games, want only our own", ours.Games)
	}
	theirs, err := server.data.OpeningStatsAt(
		ctx, string(meafModeID), []string{persistence.OpeningSegmentMeaf}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if theirs.Games != len(meafarchive.Games()) || theirs.Skipped != 0 {
		t.Fatalf("the meaf segment counted %d games and skipped %d, want all %d counted",
			theirs.Games, theirs.Skipped, len(meafarchive.Games()))
	}
	// Nothing from the import is claimed to have been relabelled: these games
	// were played the way this server plays now.
	if theirs.Turned != 0 {
		t.Fatalf("%d meaf.us games were counted as turned", theirs.Turned)
	}
	// And the two add up, which is the property the checkboxes rely on.
	both, err := server.data.OpeningStatsAt(ctx, string(meafModeID),
		[]string{persistence.OpeningSegmentHuman, persistence.OpeningSegmentMeaf}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if both.Games != ours.Games+theirs.Games {
		t.Fatalf("together they count %d, want %d", both.Games, ours.Games+theirs.Games)
	}

	// A mode meaf.us does not play gets an empty segment rather than four
	// thousand skips: "they have no Total War games" is the true statement.
	if err := server.compileOpeningStats(ctx, game.ModeTotalWar); err != nil {
		t.Fatal(err)
	}
	elsewhere, err := server.data.OpeningStatsAt(
		ctx, string(game.ModeTotalWar), []string{persistence.OpeningSegmentMeaf}, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if elsewhere.Games != 0 || elsewhere.Skipped != 0 {
		t.Fatalf("the meaf segment under Total War: %d games, %d skipped, want nothing",
			elsewhere.Games, elsewhere.Skipped)
	}
}

// The wire contract for the checkboxes: a set in, the same set echoed back,
// and the counts added up. Exercised through the router rather than the store
// because the parsing is the part that is easy to get wrong.
func TestOpeningStatsRouteTakesASetOfSegments(t *testing.T) {
	server := statsTestServer(t)
	ctx := context.Background()
	now := time.Now()

	bot := game.PlayerProfile{UserID: persistence.BotAccountPrefix + "engine", Username: "Fish"}
	human := game.PlayerProfile{UserID: "human-blue", Username: "Blue"}
	archiveOpening(t, server.data, playOpening(
		t, "humans", game.ModeInfiltration,
		game.PlayerProfile{UserID: "human-red", Username: "Red"}, human,
		openingLeft, game.Red,
	), now)
	archiveOpening(t, server.data, playOpening(
		t, "bots", game.ModeInfiltration,
		game.PlayerProfile{UserID: persistence.BotAccountPrefix + "other", Username: "Alt"}, bot,
		openingRight, game.Blue,
	), now)
	if err := server.compileOpeningStats(ctx, game.ModeInfiltration); err != nil {
		t.Fatal(err)
	}

	read := func(query string) persistence.OpeningStatsNode {
		t.Helper()
		recorder := httptest.NewRecorder()
		server.Routes().ServeHTTP(recorder, httptest.NewRequest(
			"GET", "/api/openings/V3/stats"+query, nil,
		))
		if recorder.Code != 200 {
			t.Fatalf("%s: status %d: %s", query, recorder.Code, recorder.Body)
		}
		var node persistence.OpeningStatsNode
		if err := json.Unmarshal(recorder.Body.Bytes(), &node); err != nil {
			t.Fatal(err)
		}
		return node
	}

	// Comma separated, repeated, and in the wrong order all mean the same set.
	for _, query := range []string{
		"?segments=human,bot",
		"?segment=human&segment=bot",
		"?segments=bot,human",
		"?segments=bot&segments=human",
	} {
		node := read(query)
		if !reflect.DeepEqual(node.Segments, []string{"human", "bot"}) {
			t.Fatalf("%s came back as %v", query, node.Segments)
		}
		if node.Games != 2 || len(node.Continuations) != 2 {
			t.Fatalf("%s counted %d games and %d first moves, want 2 and 2",
				query, node.Games, len(node.Continuations))
		}
	}
	// One segment is one segment's games.
	if node := read("?segments=human"); node.Games != 1 {
		t.Fatalf("humans alone counted %d games", node.Games)
	}
	// `cohort=` is what every caller sent before there were checkboxes.
	if node := read("?cohort=bot"); node.Games != 1 ||
		!reflect.DeepEqual(node.Segments, []string{"bot"}) {
		t.Fatalf("the old parameter came back as %v with %d games", node.Segments, node.Games)
	}
	// And `all` still means everything, which now includes meaf.us.
	all := read("?cohort=all")
	if !reflect.DeepEqual(all.Segments, persistence.OpeningSegments) {
		t.Fatalf("all came back as %v", all.Segments)
	}

	// A name that is not a segment is refused rather than quietly ignored --
	// silently answering a narrower question than the one asked is how a page
	// ends up showing numbers nobody can account for.
	recorder := httptest.NewRecorder()
	server.Routes().ServeHTTP(recorder, httptest.NewRequest(
		"GET", "/api/openings/V3/stats?segments=nonsense", nil,
	))
	if recorder.Code != 400 {
		t.Fatalf("an unknown segment gave status %d", recorder.Code)
	}
}
