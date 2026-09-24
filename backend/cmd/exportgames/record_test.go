package main

import (
	"encoding/json"
	"strings"
	"testing"

	"rps-strategy/backend/internal/notation"
	"rps-strategy/backend/internal/persistence"
)

const testRedID = "06f208e0-2f04-4a1e-9c33-8b1d5f7a2e10"
const testBlueID = "bot-8a2712bae7c47c888f97f203"

// storedPGN is the shape ArchiveGame writes: a tag block naming both seats and
// both account ids, a blank line, then the movetext.
func storedPGN(redName, redID, blueName, blueID string) string {
	return strings.Join([]string{
		`[Event "Ranked"]`,
		`[Site "RPS Strategy"]`,
		`[Red "` + redName + `"]`,
		`[Blue "` + blueName + `"]`,
		`[Result "1-0"]`,
		`[Variant "Intransitive"]`,
		`[SetUp "1"]`,
		`[FEN "9/3RP4/2RPS4/1RPS5/1PS3sp1/5spr1/4spr2/4pr3/9 b 9/3bb4"]`,
		`[RedId "` + redID + `"]`,
		`[BlueId "` + blueID + `"]`,
		`[RedElo "1654"]`,
		`[BlueElo "1472"]`,
		`[RedEloAfter "1655"]`,
		`[BlueEloAfter "1467"]`,
		`[BookPlies "3"]`,
		`[SeriesId "9ac71074a8b3d4f692f75da7"]`,
		`[Termination "Red wins by corner"]`,
		`[Generator "rps-strategy-pgn/2"]`,
		``,
		`1. Sc5-d5 {[%emt 0] [%clk 0:01:00.000 0:01:01.000]} 1... Sf6-f5`,
		`{[%emt 0] [%clk 0:01:01.000 0:01:01.000]} 1-0`,
		``,
	}, "\n")
}

func testRow(finishedAtUnixMs int64) archivedRow {
	return archivedRow{
		GameID:           "dd809de00040c690934320dc",
		ModeID:           "V6",
		ModeName:         "Intransitive",
		RedPlayerID:      testRedID,
		RedUsername:      "papercut",
		BluePlayerID:     testBlueID,
		BlueUsername:     "Mocca",
		WinnerColor:      "Red",
		Outcome:          "red_win",
		EndReason:        "corner",
		Ranked:           true,
		PlyCount:         2,
		FinishedAtUnixMs: finishedAtUnixMs,
		PGN:              storedPGN("papercut", testRedID, "Mocca", testBlueID),
	}
}

func testExporter() *exporter {
	return &exporter{secret: []byte("a-test-secret"), excluded: map[string]bool{}}
}

func TestPreCutoffGamesArePublishedWithoutNames(t *testing.T) {
	record, err := testExporter().record(testRow(namesPublishedFrom - 1))
	if err != nil {
		t.Fatalf("record: %v", err)
	}
	if record.RedPlayer != anonymousName || record.BluePlayer != anonymousName {
		t.Fatalf("got %q/%q, want both %q",
			record.RedPlayer, record.BluePlayer, anonymousName)
	}
	for _, name := range []string{"papercut", "Mocca"} {
		if strings.Contains(record.PGN, name) {
			t.Errorf("username %q survived into the published PGN", name)
		}
	}
}

// The instant itself is on the published side of the line. PRIVACY.md says
// games are named "from September 9, 2026 onward", so a game finishing exactly
// at midnight is one of them.
func TestCutoffInstantIsNamed(t *testing.T) {
	record, err := testExporter().record(testRow(namesPublishedFrom))
	if err != nil {
		t.Fatalf("record: %v", err)
	}
	if record.RedPlayer != "papercut" || record.BluePlayer != "Mocca" {
		t.Fatalf("got %q/%q, want the stored usernames",
			record.RedPlayer, record.BluePlayer)
	}
}

// The case the first version of this command got wrong. AnonymizeAccount
// rewrites the PGN's [RedId] tag to "Deleted player" but leaves the
// red_player_id column holding the real account id, so an id-addressed rewrite
// finds no seat and silently publishes the record untouched.
func TestAnonymizedAccountRowStillGetsRewritten(t *testing.T) {
	row := testRow(namesPublishedFrom + 1)
	row.RedUsername = "Deleted player"
	row.PGN = storedPGN("Deleted player", "Deleted player", "Mocca", testBlueID)

	record, err := testExporter().record(row)
	if err != nil {
		t.Fatalf("record: %v", err)
	}
	tags, err := notation.ParseTags(record.PGN)
	if err != nil {
		t.Fatalf("reread: %v", err)
	}
	if got := notation.TagValue(tags, "RedId"); got != record.RedKey {
		t.Fatalf("[RedId] is %q, want the opaque key %q", got, record.RedKey)
	}
	if record.RedKey == "" {
		t.Fatal("no opaque key was derived for the deleted account")
	}
}

// A seat whose record carries no Id tag at all -- buildTags omits it when the
// id is empty -- must still end up with one.
func TestMissingIdTagIsInserted(t *testing.T) {
	row := testRow(namesPublishedFrom + 1)
	row.PGN = strings.ReplaceAll(row.PGN, `[RedId "`+testRedID+`"]`+"\n", "")

	record, err := testExporter().record(row)
	if err != nil {
		t.Fatalf("record: %v", err)
	}
	tags, err := notation.ParseTags(record.PGN)
	if err != nil {
		t.Fatalf("reread: %v", err)
	}
	if got := notation.TagValue(tags, "RedId"); got != record.RedKey {
		t.Fatalf("[RedId] is %q, want the opaque key %q", got, record.RedKey)
	}
}

func TestAccountIdNeverReachesTheOutput(t *testing.T) {
	for _, finishedAt := range []int64{namesPublishedFrom - 1, namesPublishedFrom + 1} {
		row := testRow(finishedAt)
		record, err := testExporter().record(row)
		if err != nil {
			t.Fatalf("record: %v", err)
		}
		encoded, err := json.Marshal(record)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		for _, id := range []string{testRedID, testBlueID} {
			if strings.Contains(string(encoded), id) {
				t.Errorf("account id %q reached the published record", id)
			}
		}
	}
}

func TestMovetextIsByteIdentical(t *testing.T) {
	row := testRow(namesPublishedFrom + 1)
	record, err := testExporter().record(row)
	if err != nil {
		t.Fatalf("record: %v", err)
	}
	if got, want := movetextOf(record.PGN), movetextOf(row.PGN); got != want {
		t.Fatalf("movetext changed:\n got %q\nwant %q", got, want)
	}
}

func TestOpaqueKeyIsStableAndKeyed(t *testing.T) {
	first := testExporter()
	if first.playerKey(testRedID) != first.playerKey(testRedID) {
		t.Fatal("the same account got two different keys")
	}
	other := &exporter{secret: []byte("a-different-secret"), excluded: map[string]bool{}}
	if first.playerKey(testRedID) == other.playerKey(testRedID) {
		t.Fatal("the key does not depend on the secret, so it is not opaque")
	}
	if first.playerKey(testRedID) == first.playerKey(testBlueID) {
		t.Fatal("two accounts collided")
	}
}

// Opting out anonymizes rather than drops, and reaches the player whichever
// seat they held.
func TestOptOutAnonymizesEitherSeat(t *testing.T) {
	for _, id := range []string{testRedID, testBlueID} {
		export := &exporter{
			secret:   []byte("a-test-secret"),
			excluded: map[string]bool{id: true},
		}
		record, err := export.record(testRow(namesPublishedFrom + 1))
		if err != nil {
			t.Fatalf("record: %v", err)
		}
		named := record.RedPlayer
		if id == testBlueID {
			named = record.BluePlayer
		}
		if named != anonymousName {
			t.Errorf("opted-out %s reads %q, want %q", id, named, anonymousName)
		}
		if record.GameID == "" {
			t.Error("the game was dropped rather than anonymized")
		}
	}
}

func TestSeatsWithoutAnAccountAreSkipped(t *testing.T) {
	row := testRow(namesPublishedFrom + 1)
	row.BluePlayerID = ""
	if _, err := testExporter().record(row); err == nil {
		t.Fatal("a game with an unidentifiable seat was published")
	}
}

func TestLabels(t *testing.T) {
	record, err := testExporter().record(testRow(namesPublishedFrom + 1))
	if err != nil {
		t.Fatalf("record: %v", err)
	}
	// One human, one bot account.
	if record.Players != persistence.OpeningSegmentMixed {
		t.Errorf("players is %q, want %q", record.Players, persistence.OpeningSegmentMixed)
	}
	if record.Opener != "blue" {
		t.Errorf("opener is %q, want blue from the FEN's side to move", record.Opener)
	}
	if record.PGNDialect != 2 {
		t.Errorf("dialect is %d, want 2", record.PGNDialect)
	}
	if record.BookPlies != 3 {
		t.Errorf("book_plies is %d, want 3", record.BookPlies)
	}
	if record.RedElo != 1654 || record.BlueEloAfter != 1467 {
		t.Errorf("ratings not recovered from the tags: %+v", record)
	}
	if record.Termination != "Red wins by corner" {
		t.Errorf("termination is %q", record.Termination)
	}
}

// The first mover changed on 2026-09-03. A record from before it opens with
// Red, and that has to be readable off the published row.
func TestOpenerDistinguishesTheRuleSets(t *testing.T) {
	row := testRow(namesPublishedFrom - 1)
	row.PGN = strings.Replace(row.PGN, "/9 b 9/", "/9 r 9/", 1)
	row.PGN = strings.Replace(row.PGN, "rps-strategy-pgn/2", "rps-strategy-pgn/1", 1)

	record, err := testExporter().record(row)
	if err != nil {
		t.Fatalf("record: %v", err)
	}
	if record.Opener != "red" {
		t.Fatalf("opener is %q, want red for a pre-2026-09-03 game", record.Opener)
	}
	if record.PGNDialect != 1 {
		t.Fatalf("dialect is %d, want 1", record.PGNDialect)
	}
}

// A record with no Generator tag is the *current* dialect, which is what the
// notation documentation tells readers to assume. Defaulting the other way
// would label the oldest-looking records as new ones.
func TestAbsentGeneratorIsTheCurrentDialect(t *testing.T) {
	row := testRow(namesPublishedFrom + 1)
	row.PGN = strings.ReplaceAll(row.PGN, `[Generator "rps-strategy-pgn/2"]`+"\n", "")
	record, err := testExporter().record(row)
	if err != nil {
		t.Fatalf("record: %v", err)
	}
	if record.PGNDialect != 2 {
		t.Fatalf("dialect is %d, want 2 for a record with no Generator tag", record.PGNDialect)
	}
}
