package persistence

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func openingNameStore(t *testing.T) *Store {
	t.Helper()
	store, err := Open(filepath.Join(t.TempDir(), "openings.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })
	return store
}

// The rule this stands in for is the file mirror: `d8-c7` and `f8-g7` are one
// line, keyed by whichever sorts first. This package does not know that; it
// only has to move rows onto whatever key it is handed.
func firstOfMirrorPair(line []string) []string {
	mirrored := make([]string, len(line))
	for index, move := range line {
		mirrored[index] = strings.Map(func(file rune) rune {
			if file >= 'a' && file <= 'i' {
				return 'a' + ('i' - file)
			}
			return file
		}, move)
	}
	if strings.Join(mirrored, " ") < strings.Join(line, " ") {
		return mirrored
	}
	return line
}

func TestRekeyingMovesStoredLinesOntoTheirCanonicalKey(t *testing.T) {
	ctx := context.Background()
	store := openingNameStore(t)

	// Written before the rule existed: one name under the key that is about to
	// stop being looked up, one already where it belongs.
	if _, err := store.SetOpeningName(ctx, "V3", []string{"f8-g7"}, "Skipping Stone"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SetOpeningName(ctx, "V3", []string{"e8-e7"}, "The Straight Road"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.SuggestOpeningName(ctx, "V3", []string{"f8-g7", "d2-c3"}, "Twin Defense"); err != nil {
		t.Fatal(err)
	}

	moved, err := store.RekeyOpeningLines(ctx, "V3", firstOfMirrorPair)
	if err != nil {
		t.Fatal(err)
	}
	if moved != 2 {
		t.Fatalf("expected the two mirrored rows to move, got %d", moved)
	}
	names, err := store.OpeningNames(ctx, "V3")
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 2 {
		t.Fatalf("rekeying changed how many names there are: %#v", names)
	}
	if strings.Join(names[0].Line, " ") != "d8-c7" || names[0].Name != "Skipping Stone" {
		t.Fatalf("the mirrored name did not move: %#v", names[0])
	}
	if strings.Join(names[1].Line, " ") != "e8-e7" {
		t.Fatalf("a line that was already canonical moved: %#v", names[1])
	}
	pending, err := store.OpeningNameSuggestions(ctx, "V3")
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 1 || strings.Join(pending[0].Line, " ") != "d8-c7 f2-g3" {
		t.Fatalf("the suggested line did not move: %#v", pending)
	}

	// Running it twice is running it once: the second pass has nothing to do.
	if moved, err := store.RekeyOpeningLines(ctx, "V3", firstOfMirrorPair); err != nil || moved != 0 {
		t.Fatalf("a second pass moved %d rows (err %v)", moved, err)
	}
}

// Both halves of a mirror pair can already be named, from back when they looked
// like two openings. They cannot both survive; the later decision does.
func TestRekeyingKeepsTheMostRecentOfTwoCollidingNames(t *testing.T) {
	ctx := context.Background()
	store := openingNameStore(t)
	if _, err := store.SetOpeningName(ctx, "V3", []string{"d8-c7"}, "Named First"); err != nil {
		t.Fatal(err)
	}
	// Far enough apart to be two decisions rather than one: names carry a
	// millisecond, and "the later one" is only an answer when there is a later
	// one.
	time.Sleep(2 * time.Millisecond)
	if _, err := store.SetOpeningName(ctx, "V3", []string{"f8-g7"}, "Named Second"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RekeyOpeningLines(ctx, "V3", firstOfMirrorPair); err != nil {
		t.Fatal(err)
	}
	names, err := store.OpeningNames(ctx, "V3")
	if err != nil {
		t.Fatal(err)
	}
	if len(names) != 1 || names[0].Name != "Named Second" {
		t.Fatalf("expected the later name to win, got %#v", names)
	}
}

// Publishing a name answers that line's proposals and nobody else's. This is
// the difference between "the queue is what still needs a name" and "the queue
// empties when you touch it".
func TestPublishingANameResolvesOnlyThatLinesSuggestions(t *testing.T) {
	ctx := context.Background()
	store := openingNameStore(t)
	for _, suggestion := range []struct {
		line []string
		name string
	}{
		{line: []string{"d8-c7"}, name: "Skipping Stone"},
		{line: []string{"d8-c7"}, name: "The Long Walk"},
		{line: []string{"d8-c7", "f2-g3"}, name: "Crane Lift"},
	} {
		if _, err := store.SuggestOpeningName(ctx, "V3", suggestion.line, suggestion.name); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.SetOpeningName(ctx, "V3", []string{"d8-c7", "f2-g3"}, "Crane Lift"); err != nil {
		t.Fatal(err)
	}
	pending, err := store.OpeningNameSuggestions(ctx, "V3")
	if err != nil {
		t.Fatal(err)
	}
	if len(pending) != 2 {
		t.Fatalf("naming one line emptied another line's queue: %#v", pending)
	}

	if err := store.DeleteOpeningName(ctx, "V3", []string{"d8-c7", "f2-g3"}); err != nil {
		t.Fatal(err)
	}
	if err := store.DeleteOpeningName(ctx, "V3", []string{"d8-c7", "f2-g3"}); err != ErrOpeningNameNotFound {
		t.Fatalf("expected a second removal to report nothing to remove, got %v", err)
	}
	if names, err := store.OpeningNames(ctx, "V3"); err != nil || len(names) != 0 {
		t.Fatalf("the name survived removal: %#v (err %v)", names, err)
	}
}
