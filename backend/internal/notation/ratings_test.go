package notation

import (
	"strings"
	"testing"

	"rps-strategy/backend/internal/game"
)

// A rebuilt record must be the record Encode would have written with the new
// numbers, not merely one that parses to them: the archive is published, and
// two copies of one game that differ in their bytes would read as two games.
func TestSetRatingsRestatesARecordExactlyAsEncodeWouldWriteIt(t *testing.T) {
	played := newTestGame(t, game.ModeInfiltration)
	if _, err := played.Move(
		game.Blue, game.Position{X: 3, Y: 2}, game.Position{X: 3, Y: 3},
	); err != nil {
		t.Fatal(err)
	}
	record := played.Record()
	metadata := Metadata{
		Event: "Ranked", Ranked: true,
		RedEloBefore: 182, RedEloAfter: 186,
		BlueEloBefore: 196, BlueEloAfter: 192,
	}
	old := Encode(record, metadata)

	metadata.RedEloBefore, metadata.RedEloAfter = 1488, 1503
	metadata.BlueEloBefore, metadata.BlueEloAfter = 1532, 1517
	want := Encode(record, metadata)
	got := SetRatings(old, Ratings{RedBefore: 1488, RedAfter: 1503, BlueBefore: 1532, BlueAfter: 1517})
	if got != want {
		t.Fatalf("restated record differs from a fresh one:\n--- got\n%s\n--- want\n%s", got, want)
	}
	if !strings.Contains(got, `[RedRatingDiff "+15"]`) || !strings.Contains(got, `[BlueRatingDiff "-15"]`) {
		t.Fatalf("the differences were not restated:\n%s", got)
	}
	if !strings.Contains(got, `[RatingSystem "`+RatingSystem+`"]`) {
		t.Fatalf("the restated record does not name today's scale:\n%s", got)
	}
}

// A record written with no ratings at all gets them where Encode puts them,
// just before [Ranked], and its moves are not touched.
func TestSetRatingsAddsRatingsToARecordThatHadNone(t *testing.T) {
	played := newTestGame(t, game.ModeInfiltration)
	if _, err := played.Move(
		game.Blue, game.Position{X: 3, Y: 2}, game.Position{X: 3, Y: 3},
	); err != nil {
		t.Fatal(err)
	}
	record := played.Record()
	bare := Encode(record, Metadata{Event: "Casual"})
	ratings := Ratings{RedBefore: 1150, RedAfter: 1150, BlueBefore: 1402, BlueAfter: 1402}
	want := Encode(record, Metadata{
		Event: "Casual", RedEloBefore: 1150, RedEloAfter: 1150,
		BlueEloBefore: 1402, BlueEloAfter: 1402,
	})
	got := SetRatings(bare, ratings)
	if got != want {
		t.Fatalf("ratings added in the wrong place:\n--- got\n%s\n--- want\n%s", got, want)
	}
	_, movesBefore, _ := strings.Cut(bare, "\n\n")
	_, movesAfter, _ := strings.Cut(got, "\n\n")
	if movesBefore != movesAfter {
		t.Fatal("restating the ratings changed the movetext")
	}

	// And taking them away again gives back the record they were added to.
	if cleared := SetRatings(got, Ratings{}); cleared != bare {
		t.Fatalf("clearing the ratings did not restore the record:\n%s", cleared)
	}
}
