package spec

import (
	"encoding/json"
	"strings"
	"testing"
)

// paths is the shape most assertions here want: which fields were complained
// about, without caring what the complaint said.
func paths(issues []Issue) []string {
	found := make([]string, 0, len(issues))
	for _, issue := range issues {
		found = append(found, issue.Path)
	}
	return found
}

func mentions(issues []Issue, path string) bool {
	for _, issue := range issues {
		if issue.Path == path {
			return true
		}
	}
	return false
}

// withChange re-decodes a built-in spec with one top-level field replaced, so
// each case reads as its own difference from a mode that works.
func withChange(t *testing.T, field string, value any) Report {
	t.Helper()
	var document map[string]any
	if err := json.Unmarshal([]byte(TotalWarJSON), &document); err != nil {
		t.Fatal(err)
	}
	if value == nil {
		delete(document, field)
	} else {
		document[field] = value
	}
	encoded, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	_, report := ValidateJSON(encoded)
	return report
}

func TestTheShippedModesAreValidWithNothingToWarnAbout(t *testing.T) {
	for name, parsed := range Builtin {
		report := Validate(parsed)
		if !report.Valid() {
			t.Fatalf("%s: %v", name, report.Err())
		}
		if len(report.Warnings) != 0 {
			t.Fatalf("%s warns: %v", name, report.Warnings)
		}
	}
}

// The Go and TypeScript copies of a shipped spec have to be the same document,
// because the differential tests on each side are measuring different things
// against what is meant to be one artifact. Compared as decoded JSON rather than
// as text, so whitespace is not the thing under test.
func TestABuiltinSpecRoundTripsThroughItsOwnFormat(t *testing.T) {
	for name, document := range map[string]string{
		"V5": TotalWarJSON,
		"V3": InfiltrationJSON,
	} {
		parsed := MustParse(document)
		encoded, err := Encode(parsed)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		var first, second map[string]any
		if err := json.Unmarshal([]byte(document), &first); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(encoded, &second); err != nil {
			t.Fatal(err)
		}
		firstText, _ := json.Marshal(first)
		secondText, _ := json.Marshal(second)
		if string(firstText) != string(secondText) {
			t.Fatalf("%s did not survive a round trip:\n%s\n%s", name, firstText, secondText)
		}
	}
}

func TestASpecFromAnotherLanguageVersionIsRefusedAndNothingElseIsSaid(t *testing.T) {
	report := withChange(t, "spec", 2)
	if got := paths(report.Errors); len(got) != 1 || got[0] != "spec" {
		t.Fatalf("expected one error about the version, got %v", got)
	}
}

func TestAMovementRuleNamingAPieceThatDoesNotExist(t *testing.T) {
	report := withChange(t, "movement", []any{
		map[string]any{"kind": "step", "dirs": "all8", "piece": "lizard"},
	})
	if !mentions(report.Errors, "movement[0].piece") {
		t.Fatalf("expected a complaint about the piece, got %v", report.Errors)
	}
}

func TestALayoutThatIsNotTheBoardItDeclares(t *testing.T) {
	report := withChange(t, "board", map[string]any{"width": 5, "height": 5})
	if !mentions(report.Errors, "startingPosition.rows") {
		t.Fatalf("expected the layout and the board to disagree, got %v", report.Errors)
	}
}

func TestASymbolInTheLayoutWithNoPieceBehindIt(t *testing.T) {
	report := withChange(t, "startingPosition", map[string]any{"rows": []string{
		"...SSS...", "...PPP...", "...RRR...",
		".........", "....X....", ".........",
		"...rrr...", "...ppp...", "...sss...",
	}})
	if !mentions(report.Errors, "startingPosition.rows[4]") {
		t.Fatalf("expected the stray symbol to be named, got %v", report.Errors)
	}
}

func TestTwoPiecesCannotShareALetter(t *testing.T) {
	report := withChange(t, "pieces", []any{
		map[string]any{"id": "Rock", "name": "Rock", "symbol": "R"},
		map[string]any{"id": "Ruin", "name": "Ruin", "symbol": "R"},
	})
	if !mentions(report.Errors, "pieces[1].symbol") {
		t.Fatalf("expected the duplicate letter to be refused, got %v", report.Errors)
	}
}

func TestALowerCaseSymbolHasNoRoomToSayWhoseItIs(t *testing.T) {
	report := withChange(t, "pieces", []any{
		map[string]any{"id": "rock", "name": "Rock", "symbol": "r"},
	})
	if !mentions(report.Errors, "pieces[0].symbol") {
		t.Fatalf("expected a lower-case symbol to be refused, got %v", report.Errors)
	}
}

func TestAKindMayCaptureItsOwnKindTheWayAChessPawnDoes(t *testing.T) {
	report := withChange(t, "beats", []any{[]any{"Rock", "Rock"}})
	if !report.Valid() {
		t.Fatalf("a kind taking its own kind should be legal: %v", report.Err())
	}
}

func TestAPairCannotBeWrittenTwice(t *testing.T) {
	duplicate := withChange(t, "beats", []any{
		[]any{"Rock", "Scissors"},
		[]any{"Rock", "Scissors"},
	})
	if !mentions(duplicate.Errors, "beats[1]") {
		t.Fatalf("expected the duplicate pair to be refused, got %v", duplicate.Errors)
	}
}

// Legal, and almost certainly not what the author meant. Rock-Paper-Scissors-
// Lizard-Spock's real graph minus an edge, so nothing takes the lizard.
func TestAPieceNothingCapturesIsAWarningNotAnError(t *testing.T) {
	var document map[string]any
	if err := json.Unmarshal([]byte(TotalWarJSON), &document); err != nil {
		t.Fatal(err)
	}
	document["pieces"] = []any{
		map[string]any{"id": "Rock", "name": "Rock", "symbol": "R"},
		map[string]any{"id": "Paper", "name": "Paper", "symbol": "P"},
		map[string]any{"id": "Scissors", "name": "Scissors", "symbol": "S"},
		map[string]any{"id": "Lizard", "name": "Lizard", "symbol": "L"},
	}
	document["beats"] = []any{
		[]any{"Rock", "Scissors"},
		[]any{"Scissors", "Paper"},
		[]any{"Paper", "Rock"},
		[]any{"Lizard", "Paper"},
	}
	encoded, _ := json.Marshal(document)
	_, report := ValidateJSON(encoded)
	if !report.Valid() {
		t.Fatalf("a five-piece mode should be legal: %v", report.Err())
	}
	found := false
	for _, issue := range report.Warnings {
		if issue.Path == "beats" && strings.Contains(issue.Message, "Lizard") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a warning about the lizard, got %v", report.Warnings)
	}
}

func TestAPieceWithNoMovementRuleIsAWarning(t *testing.T) {
	report := withChange(t, "movement", []any{
		map[string]any{"kind": "step", "dirs": "all8", "piece": "Rock"},
	})
	if !report.Valid() {
		t.Fatalf("unexpected errors: %v", report.Err())
	}
	found := false
	for _, issue := range report.Warnings {
		if strings.Contains(issue.Message, `"Paper"`) {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected a warning about the idle paper, got %v", report.Warnings)
	}
}

func TestNothingCanMoveAtAll(t *testing.T) {
	if !mentions(withChange(t, "movement", []any{}).Errors, "movement") {
		t.Fatal("a mode where nothing moves should be refused")
	}
}

func TestAPredicateWithAHoleInIt(t *testing.T) {
	report := withChange(t, "win", []any{map[string]any{
		"when": map[string]any{
			"eq": []any{map[string]any{"count": map[string]any{"owner": "nobody"}}, 0},
		},
		"result": "mover",
	}})
	if !mentions(report.Errors, "win[0].when.eq[0].count.owner") {
		t.Fatalf("expected the bad side reference to be pointed at, got %v", report.Errors)
	}
}

func TestAConditionNamingTwoKindsAtOnce(t *testing.T) {
	report := withChange(t, "win", []any{map[string]any{
		"when":   map[string]any{"captured": true, "moved": "Rock"},
		"result": "mover",
	}})
	if !mentions(report.Errors, "win[0].when") {
		t.Fatalf("expected an ambiguous condition to be refused, got %v", report.Errors)
	}
}

func TestARegionOffTheEdgeOfTheBoardItIsFor(t *testing.T) {
	report := withChange(t, "win", []any{map[string]any{
		"when":   map[string]any{"in": []any{"to", map[string]any{"rows": []any{12}}}},
		"result": "mover",
	}})
	if !mentions(report.Errors, "win[0].when.in[1].rows[0]") {
		t.Fatalf("expected rank 13 of a nine-rank board to be refused, got %v", report.Errors)
	}
}

func TestAPredicateNestedPastTheDepthCap(t *testing.T) {
	var predicate any = true
	for depth := 0; depth <= MaxDepth+2; depth++ {
		predicate = map[string]any{"not": predicate}
	}
	report := withChange(t, "win", []any{map[string]any{"when": predicate, "result": "mover"}})
	found := false
	for _, issue := range report.Errors {
		if strings.Contains(issue.Message, "nested deeper") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected the depth cap to bite, got %v", report.Errors)
	}
}

func TestADirectionOffsetThatGoesNowhereOrFurtherThanAnyBoard(t *testing.T) {
	nowhere := withChange(t, "movement", []any{map[string]any{
		"kind": "leap", "dirs": map[string]any{"offsets": []any{[]any{0, 0}}},
	}})
	if !mentions(nowhere.Errors, "movement[0].dirs.offsets[0]") {
		t.Fatalf("expected a zero offset to be refused, got %v", nowhere.Errors)
	}
	tooFar := withChange(t, "movement", []any{map[string]any{
		"kind": "leap", "dirs": map[string]any{"offsets": []any{[]any{99, 1}}},
	}})
	if !mentions(tooFar.Errors, "movement[0].dirs.offsets[0]") {
		t.Fatalf("expected an impossible offset to be refused, got %v", tooFar.Errors)
	}
}

func TestABoardOutsideTheSizesThisProjectCanPlay(t *testing.T) {
	for _, board := range []map[string]any{
		{"width": 2, "height": 9},
		{"width": 9, "height": 40},
		{"width": 26, "height": 26},
	} {
		if !mentions(withChange(t, "board", board).Errors, "board") {
			t.Fatalf("expected %v to be refused", board)
		}
	}
}

func TestAPromotionToAPieceTheModeDoesNotHave(t *testing.T) {
	report := withChange(t, "effects", []any{map[string]any{
		"on": "move",
		"do": []any{map[string]any{"promote": map[string]any{"to": "queen"}}},
	}})
	if !mentions(report.Errors, "effects[0].do[0].promote.to") {
		t.Fatalf("expected the unknown promotion target to be refused, got %v", report.Errors)
	}
}

// The shape `{ "use": "jump@1" }` resolves to. This is the check that the format
// can express the reuse example without a special case for it.
func TestAJumpFeatureWrittenTheWayAReusablePartWouldBeInlined(t *testing.T) {
	report := withChange(t, "movement", []any{
		map[string]any{"kind": "step", "dirs": "all8", "distance": 1},
		map[string]any{"kind": "jumpOver", "dirs": "all8", "captureJumped": true, "piece": "Rock"},
	})
	if !report.Valid() {
		t.Fatalf("a jump should be sayable: %v", report.Err())
	}
}

func TestAModeWithNoWinConditionIsLegalAndSaysSo(t *testing.T) {
	report := withChange(t, "win", []any{})
	if !report.Valid() {
		t.Fatalf("unexpected errors: %v", report.Err())
	}
	if !mentions(report.Warnings, "win") {
		t.Fatalf("expected a warning, got %v", report.Warnings)
	}
}

func TestBlankOverLongAndControlCharacterText(t *testing.T) {
	if !mentions(withChange(t, "name", "  ").Errors, "name") {
		t.Fatal("a blank name should be refused")
	}
	if !mentions(withChange(t, "description", strings.Repeat("x", MaxTextLength+1)).Errors, "description") {
		t.Fatal("an over-long description should be refused")
	}
	withBell := "Total" + string(rune(7)) + "War"
	if !mentions(withChange(t, "name", withBell).Errors, "name") {
		t.Fatal("a control character in a name should be refused")
	}
}

// A field nobody meant to write is refused rather than ignored: an author who
// misspelled `movement` should hear about it here, not by finding that nothing
// can move.
func TestAMisspelledFieldIsRefusedRatherThanIgnored(t *testing.T) {
	document := strings.Replace(TotalWarJSON, `"movement"`, `"movements"`, 1)
	if _, report := ValidateJSON([]byte(document)); report.Valid() {
		t.Fatal("an unknown field should be refused")
	}
}

func TestADocumentBiggerThanAPublishedModeMayBe(t *testing.T) {
	// Checked before anything is decoded, so a caller does not have to parse a
	// megabyte to find out it was refused.
	padded := strings.Repeat(" ", MaxSpecBytes+1) + TotalWarJSON
	_, report := ValidateJSON([]byte(padded))
	found := false
	for _, issue := range report.Errors {
		if strings.Contains(issue.Message, "bytes") {
			found = true
		}
	}
	if !found {
		t.Fatalf("expected the size cap to bite, got %v", report.Errors)
	}
}

// A kind's id is the string that appears on a tile, so `Empty` cannot be one:
// it would be a piece indistinguishable from an empty square.
func TestAPieceCannotBeCalledEmpty(t *testing.T) {
	report := withChange(t, "pieces", []any{
		map[string]any{"id": "Empty", "name": "Nothing", "symbol": "E"},
	})
	if !mentions(report.Errors, "pieces[0].id") {
		t.Fatalf("expected a piece called Empty to be refused, got %v", report.Errors)
	}
}
