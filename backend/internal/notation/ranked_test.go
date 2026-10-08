package notation

import (
	"strings"
	"testing"

	"rps-strategy/backend/internal/game"
)

// movetextOf is everything after the tag block, which a rewrite of the tags must
// hand back untouched.
func movetextOf(t *testing.T, pgn string) string {
	t.Helper()
	_, movetext, found := strings.Cut(pgn, "\n\n")
	if !found {
		t.Fatalf("record has no movetext:\n%s", pgn)
	}
	return movetext
}

// Moving a game between ranked and casual rewrites what the file says about it,
// in both of the places it says it, and nothing else.
func TestSetRankedRewritesTheFlagAndTheEventThatFollowsIt(t *testing.T) {
	played := newTestGame(t, game.ModeInfiltration)
	playOut(t, played, 7, 12)
	record := played.Record()
	casual := Encode(record, Metadata{Event: "Casual", RedEloBefore: 40, BlueEloBefore: 38})

	ranked := SetRanked(casual, true)
	if !strings.Contains(ranked, `[Ranked "true"]`) || strings.Contains(ranked, `[Ranked "false"]`) {
		t.Fatalf("the flag did not move:\n%s", ranked)
	}
	if !strings.Contains(ranked, `[Event "Ranked"]`) {
		t.Fatalf("the event still calls a ranked game casual:\n%s", ranked)
	}
	if movetextOf(t, ranked) != movetextOf(t, casual) {
		t.Fatal("rewriting the tags touched the moves")
	}
	parsed, err := Parse(ranked)
	if err != nil {
		t.Fatalf("parse the rewritten record: %v", err)
	}
	if !parsed.Metadata.Ranked || parsed.Metadata.Event != "Ranked" {
		t.Fatalf("the record reads back as %#v", parsed.Metadata)
	}
	if err := game.Verify(parsed.Record); err != nil {
		t.Fatalf("the rewritten record no longer replays: %v", err)
	}

	// And back again is the file it started as, byte for byte: nothing about a
	// round trip through the admin screen should be visible in an export.
	if restored := SetRanked(ranked, false); restored != casual {
		t.Fatalf("a round trip changed the record:\n%s\nwas\n%s", restored, casual)
	}
	// Asking for what a record already says is not a change.
	if again := SetRanked(casual, false); again != casual {
		t.Fatalf("setting casual on a casual record changed it:\n%s", again)
	}
}

// An event that names what the game was for keeps its name. A series game is a
// "Bot Match" whichever way it counts.
func TestSetRankedLeavesAnEventThatIsNotAboutRating(t *testing.T) {
	record := newTestGame(t, game.ModeInfiltration).Record()
	for _, event := range []string{"Bot Match", "Tournament", "Interrupted"} {
		text := SetRanked(Encode(record, Metadata{Event: event}), true)
		parsed, err := Parse(text)
		if err != nil {
			t.Fatalf("parse %s: %v", event, err)
		}
		if parsed.Metadata.Event != event || !parsed.Metadata.Ranked {
			t.Fatalf("a %q game read back as %#v", event, parsed.Metadata)
		}
	}
}

// A record from before the flag existed gets one, rather than being left to say
// nothing — a missing tag parses as casual, which would be the wrong answer for
// a game an administrator has just made ranked.
func TestSetRankedAddsTheFlagToARecordWithout(t *testing.T) {
	record := newTestGame(t, game.ModeInfiltration).Record()
	older := strings.ReplaceAll(
		Encode(record, Metadata{Event: "Bot Match"}), `[Ranked "false"]`+"\n", "",
	)
	if strings.Contains(older, "[Ranked ") {
		t.Fatalf("the fixture still has a flag:\n%s", older)
	}

	text := SetRanked(older, true)
	if strings.Count(text, "[Ranked ") != 1 {
		t.Fatalf("expected exactly one flag:\n%s", text)
	}
	if movetextOf(t, text) != movetextOf(t, older) {
		t.Fatal("adding a tag touched the moves")
	}
	parsed, err := Parse(text)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if !parsed.Metadata.Ranked {
		t.Fatal("the inserted flag did not read back as ranked")
	}
}
