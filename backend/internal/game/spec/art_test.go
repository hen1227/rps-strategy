package spec

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"rps-strategy/backend/internal/game"
)

// A digest-shaped id, so a case reads as its own difference and not as hex.
func artID(fill string) string {
	return "img:" + strings.Repeat(fill, 32)[:32]
}

// pieceArt re-decodes Total War with the first kind's art replaced, which is
// the same door withChange opens on a top-level field.
func pieceArt(t *testing.T, art string) Report {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal([]byte(TotalWarJSON), &document); err != nil {
		t.Fatal(err)
	}
	pieces, ok := document["pieces"].([]any)
	if !ok || len(pieces) == 0 {
		t.Fatal("Total War has no pieces to give artwork to")
	}
	first, ok := pieces[0].(map[string]any)
	if !ok {
		t.Fatal("a piece is not an object")
	}
	first["art"] = art
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	_, report := ValidateJSON(encoded)
	return report
}

// The whole degradation story rests on this staying a warning: a build that has
// never heard of a bundled picture must still publish and still play the mode,
// drawing letters. Its TypeScript twin is in `engine/spec/validate.test.mts`
// and the two messages are meant to read the same.
func TestAnArtNameThisBuildDoesNotKnowIsStillOnlyAWarning(t *testing.T) {
	report := pieceArt(t, "lizard")
	if !report.Valid() {
		t.Fatalf("refused a mode over artwork: %v", report.Err())
	}
	if !mentions(report.Warnings, "pieces[0].art") {
		t.Fatalf("said nothing about the artwork: %v", report.Warnings)
	}
}

func TestAPictureReferenceIsAcceptedWithoutComment(t *testing.T) {
	report := pieceArt(t, artID("a"))
	if !report.Valid() {
		t.Fatalf("refused a picture: %v", report.Err())
	}
	if len(report.Warnings) != 0 {
		t.Fatalf("warned about a picture: %v", report.Warnings)
	}
}

// A malformed id can only be a typo — nothing will ever resolve it — so it is
// named where it is written rather than becoming a permanent hole in a
// published mode.
func TestAMalformedPictureIDIsAnErrorRatherThanAWarning(t *testing.T) {
	for _, bad := range []string{
		"img:",
		"img:nothex",
		"img:../../admin",
		artID("A"), // upper-case hex: the pattern is lower-case only
		"img:" + strings.Repeat("a", 31),
		"img:" + strings.Repeat("a", 33),
		artID("a") + "0",
	} {
		report := pieceArt(t, bad)
		if report.Valid() {
			t.Fatalf("accepted %q as a picture id", bad)
		}
	}
}

func TestTheBoardAndTheCoverTakeAPictureAndNothingElse(t *testing.T) {
	var document map[string]any
	if err := json.Unmarshal([]byte(TotalWarJSON), &document); err != nil {
		t.Fatal(err)
	}
	board, _ := document["board"].(map[string]any)
	board["art"] = artID("b")
	document["cover"] = artID("c")
	encoded, _ := json.Marshal(document)
	if _, report := ValidateJSON(encoded); !report.Valid() {
		t.Fatalf("refused a board picture and a cover: %v", report.Err())
	}

	// There is no bundled board artwork to name, so the identical string that
	// only warns on a piece is a mistake here.
	board["art"] = "rock"
	encoded, _ = json.Marshal(document)
	_, report := ValidateJSON(encoded)
	if !mentions(report.Errors, "board.art") {
		t.Fatalf("accepted a bundled name on the board: %v", report)
	}
}

// One walk over the document, so the validator and the publish route that pins
// what it finds cannot drift apart.
func TestArtReferencesAreListedOnceEachWithWhereTheyAreUsed(t *testing.T) {
	shared := artID("a")
	parsed := MustParse(TotalWarJSON)
	parsed.Pieces[0].Art = shared
	parsed.Pieces[1].Art = shared // the same picture twice: one asset to pin
	parsed.Pieces[2].Art = "rock" // bundled, so not an asset at all
	parsed.Board.Art = artID("b")
	parsed.Cover = artID("c")

	refs := parsed.ArtReferences()
	if len(refs) != 3 {
		t.Fatalf("expected three distinct pictures, got %d: %+v", len(refs), refs)
	}
	if refs[0].Path != "pieces[0].art" || refs[0].Role != ArtRolePiece {
		t.Fatalf("the first reference should be the first place it is named: %+v", refs[0])
	}
	if refs[0].ID != shared[4:] {
		t.Fatalf("a reference carries the digest without its prefix: %q", refs[0].ID)
	}
	if refs[1].Role != ArtRoleBoard || refs[2].Role != ArtRoleCover {
		t.Fatalf("roles are wrong: %+v", refs)
	}
}

// Art is not a rule. Nothing about legality may depend on it, which is why the
// conformance corpus is untouched by this whole feature.
func TestArtChangesNothingAboutHowAModePlays(t *testing.T) {
	plain := MustParse(TotalWarJSON)
	decorated := MustParse(TotalWarJSON)
	for index := range decorated.Pieces {
		decorated.Pieces[index].Art = artID(string(rune('a' + index)))
	}
	decorated.Board.Art = artID("f")
	decorated.Cover = artID("e")

	plainMode, err := NewMode("custom:plain@1", plain, game.OriginCommunity)
	if err != nil {
		t.Fatal(err)
	}
	decoratedMode, err := NewMode("custom:decorated@1", decorated, game.OriginCommunity)
	if err != nil {
		t.Fatal(err)
	}

	var plainState, decoratedState game.GameState
	plainMode.Initialize(&plainState)
	decoratedMode.Initialize(&decoratedState)
	if !reflect.DeepEqual(plainState.Grid, decoratedState.Grid) {
		t.Fatal("artwork changed the opening board")
	}
	for y := range plainState.Grid {
		for x := range plainState.Grid[y] {
			at := game.Position{X: x, Y: y}
			before := plainMode.ValidMoves(plainState, game.Red, at)
			after := decoratedMode.ValidMoves(decoratedState, game.Red, at)
			if !reflect.DeepEqual(before, after) {
				t.Fatalf("artwork changed the legal moves from %v", at)
			}
		}
	}
}
