package server

import (
	"strings"
	"testing"

	"rps-strategy/backend/internal/game"
)

func TestMirroredLinesShareOneCanonicalKey(t *testing.T) {
	for _, test := range []struct {
		line   []string
		mirror []string
	}{
		{line: []string{"d8-c7"}, mirror: []string{"f8-g7"}},
		{line: []string{"a1-b2"}, mirror: []string{"i1-h2"}},
		// The middle file is its own mirror, so this line is too.
		{line: []string{"e8-e7"}, mirror: []string{"e8-e7"}},
		{line: []string{"d8-c7", "f2-g3"}, mirror: []string{"f8-g7", "d2-c3"}},
	} {
		if got := strings.Join(mirrorOpeningLine(test.line, game.BoardSize), " "); got != strings.Join(test.mirror, " ") {
			t.Fatalf("mirror of %v is %q, expected %v", test.line, got, test.mirror)
		}
		// Whichever of the two is asked about, the answer is the same key --
		// which is the only property naming actually depends on.
		first := strings.Join(canonicalOpeningLine(test.line, openingBoard{width: game.BoardSize, mirrors: true}), " ")
		second := strings.Join(canonicalOpeningLine(test.mirror, openingBoard{width: game.BoardSize, mirrors: true}), " ")
		if first != second {
			t.Fatalf("%v and %v canonicalize to %q and %q", test.line, test.mirror, first, second)
		}
		// And the key is a line somebody can play, not a per-move minimum.
		if first != strings.Join(test.line, " ") && first != strings.Join(test.mirror, " ") {
			t.Fatalf("canonical key %q is neither the line nor its mirror", first)
		}
	}
}

func TestOpeningMirroringIsAskedOfTheModeRatherThanAssumed(t *testing.T) {
	server := openingTestServer(t)
	if !server.openingBoardFor("V3").mirrors || !server.openingBoardFor("V5").mirrors {
		t.Fatal("both shipped modes start from a layout that reads the same right to left")
	}
	if server.openingBoardFor("nonsense").mirrors {
		t.Fatal("a mode that does not exist cannot have mirror-image openings")
	}
	// A lopsided mode names its two wings separately, because there its two
	// wings really are different openings.
	lopsided := []string{"d8-c7"}
	if got := canonicalOpeningLine(lopsided, openingBoard{width: game.BoardSize}); strings.Join(got, " ") != "d8-c7" {
		t.Fatalf("without mirroring a line is its own key, got %q", got)
	}
	// Notation the book would never contain is handed back rather than mangled.
	if got := mirrorOpeningMove("not-a-move", game.BoardSize); got != "not-a-move" {
		t.Fatalf("unparseable notation was rewritten to %q", got)
	}
	if !game.MustStartingPosition(
		".........", ".........", ".........", ".........", ".........",
		".........", ".........", ".........", "...rrr...",
	).MirrorsFiles() {
		t.Fatal("a centred layout mirrors")
	}
	if game.MustStartingPosition(
		".........", ".........", ".........", ".........", ".........",
		".........", ".........", ".........", "rrr......",
	).MirrorsFiles() {
		t.Fatal("a layout pushed to one wing does not mirror")
	}
}
