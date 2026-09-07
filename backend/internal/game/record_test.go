package game

import (
	"errors"
	"math/rand"
	"testing"
	"time"
)

// playRandomGame plays a reproducible pseudo-random game so a record is
// exercised against real rules rather than a hand-picked line. The clock moves
// in uneven steps because uniform thinking times would hide clock-accounting
// bugs a record must not have.
func playRandomGame(t *testing.T, modeID ModeID, seed int64, maxMoves int) *Game {
	t.Helper()
	game, err := NewGameWithTimeControl(
		"random-"+string(modeID),
		modeID,
		PlayerProfile{UserID: "red", Username: "Red Player"},
		PlayerProfile{UserID: "blue", Username: "Blue Player"},
		TimeControl{InitialTimeMs: 300000, IncrementMs: 3000},
	)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC)
	useFakeGameTime(game, &now)

	random := rand.New(rand.NewSource(seed))
	for move := 0; move < maxMoves; move++ {
		state := game.Snapshot()
		if state.Status != InProgress {
			break
		}
		from, to, found := randomLegalMove(game, random)
		if !found {
			break
		}
		now = now.Add(time.Duration(37+random.Intn(4000)) * time.Millisecond)
		if _, err := game.Move(state.CurrentTurn, from, to); err != nil {
			t.Fatalf("random move %d rejected: %v", move, err)
		}
	}
	return game
}

func randomLegalMove(game *Game, random *rand.Rand) (Position, Position, bool) {
	state := game.Snapshot()
	type candidate struct{ from, to Position }
	candidates := make([]candidate, 0, 64)
	for y := 0; y < BoardSize; y++ {
		for x := 0; x < BoardSize; x++ {
			if state.Grid[y][x].OccupantOwner != state.CurrentTurn {
				continue
			}
			from := Position{X: x, Y: y}
			for _, to := range game.ValidMoves(state.CurrentTurn, from) {
				candidates = append(candidates, candidate{from: from, to: to})
			}
		}
	}
	if len(candidates) == 0 {
		return Position{}, Position{}, false
	}
	chosen := candidates[random.Intn(len(candidates))]
	return chosen.from, chosen.to, true
}

func TestRecordReplaysRandomGamesInEveryMode(t *testing.T) {
	for _, modeID := range DefaultModeRegistry.IDs() {
		for seed := int64(1); seed <= 5; seed++ {
			game := playRandomGame(t, modeID, seed, 120)
			record := game.Record()
			if record.PlyCount() == 0 {
				t.Fatalf("mode %s seed %d produced no moves", modeID, seed)
			}
			if err := Verify(record); err != nil {
				t.Fatalf("mode %s seed %d: %v", modeID, seed, err)
			}
		}
	}
}

func TestRecordCapturesMoveDetail(t *testing.T) {
	game := testGame(t, ModeTotalWar)
	now := time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC)
	useFakeGameTime(game, &now)

	from := firstPieceOf(t, game, Blue, Rock)
	to := Position{X: from.X, Y: from.Y + 1}
	now = now.Add(1500 * time.Millisecond)
	if _, err := game.Move(Blue, from, to); err != nil {
		t.Fatal(err)
	}

	record := game.Record()
	if len(record.Events) != 1 {
		t.Fatalf("expected one event, got %d", len(record.Events))
	}
	event := record.Events[0]
	if event.Kind != EventMove || event.Player != Blue || event.Piece != Rock {
		t.Fatalf("unexpected move event: %+v", event)
	}
	if event.From != from || event.To != to {
		t.Fatalf("recorded %v-%v, played %v-%v", event.From, event.To, from, to)
	}
	if event.Captured != Empty {
		t.Fatalf("quiet move recorded a capture of %s", event.Captured)
	}
	if event.ElapsedMs != 1500 {
		t.Fatalf("expected 1500ms elapsed, got %d", event.ElapsedMs)
	}
	// The increment is paid after the move, so the record shows 5:00 - 1.5s + 3s.
	if event.BlueRemainingMs != 300000-1500+3000 {
		t.Fatalf("unexpected blue clock: %d", event.BlueRemainingMs)
	}
	if event.Ply != 1 {
		t.Fatalf("expected ply 1, got %d", event.Ply)
	}
}

func TestRecordCapturesProposalsAndResignation(t *testing.T) {
	game := testGame(t, ModeTotalWar)
	now := time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC)
	useFakeGameTime(game, &now)

	if _, err := game.OfferDraw(Blue); err != nil {
		t.Fatal(err)
	}
	if _, err := game.DeclineDraw(Red); err != nil {
		t.Fatal(err)
	}
	if _, err := game.OfferTimeExtension(Blue); err != nil {
		t.Fatal(err)
	}
	if _, err := game.AcceptTimeExtension(Red); err != nil {
		t.Fatal(err)
	}
	from, to := anyLegalMove(t, game)
	if _, err := game.Move(Blue, from, to); err != nil {
		t.Fatal(err)
	}
	if _, err := game.Resign(Red); err != nil {
		t.Fatal(err)
	}

	record := game.Record()
	kinds := make([]EventKind, 0, len(record.Events))
	for _, event := range record.Events {
		kinds = append(kinds, event.Kind)
	}
	expected := []EventKind{
		EventDrawOffer, EventDrawDecline, EventTimeOffer, EventTimeAccept,
		EventMove, EventGameEnd,
	}
	if len(kinds) != len(expected) {
		t.Fatalf("expected %v, got %v", expected, kinds)
	}
	for index, kind := range expected {
		if kinds[index] != kind {
			t.Fatalf("expected %v, got %v", expected, kinds)
		}
	}
	accepted := record.Events[3]
	if accepted.BonusMs != TimeExtensionMs {
		t.Fatalf("time extension recorded %dms, expected %d", accepted.BonusMs, TimeExtensionMs)
	}
	ending := record.Events[len(record.Events)-1]
	if ending.Player != Red || ending.Winner != Blue || ending.EndReason != EndReasonResignation {
		t.Fatalf("unexpected ending: %+v", ending)
	}
	if err := Verify(record); err != nil {
		t.Fatal(err)
	}
}

func TestRecordReplaysTimeout(t *testing.T) {
	game, err := NewGameWithTimeControl(
		"timeout",
		ModeTotalWar,
		PlayerProfile{UserID: "blue"},
		PlayerProfile{UserID: "red"},
		TimeControl{InitialTimeMs: 5000, IncrementMs: 0},
	)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC)
	useFakeGameTime(game, &now)

	from, to := anyLegalMove(t, game)
	now = now.Add(time.Second)
	if _, err := game.Move(Blue, from, to); err != nil {
		t.Fatal(err)
	}
	now = now.Add(30 * time.Second)
	state, expired := game.Tick(now)
	if !expired || state.EndReason != EndReasonTimeout || state.Winner != Blue {
		t.Fatalf("expected Red to flag, got %+v", state)
	}

	record := game.Record()
	ending := record.Events[len(record.Events)-1]
	if ending.Kind != EventGameEnd || ending.EndReason != EndReasonTimeout || ending.Player != Red {
		t.Fatalf("unexpected ending: %+v", ending)
	}
	if ending.ElapsedMs != 5000 {
		t.Fatalf("expected the flagged player to burn its whole clock, got %d", ending.ElapsedMs)
	}
	if err := Verify(record); err != nil {
		t.Fatal(err)
	}
}

// A record replays on the board it was played from, not the board its mode
// defines today, so redesigning a mode cannot rewrite finished games.
func TestRecordReplaysItsOwnStartingPosition(t *testing.T) {
	game := testGame(t, ModeTotalWar)
	now := time.Date(2026, time.August, 21, 12, 0, 0, 0, time.UTC)
	useFakeGameTime(game, &now)
	record := game.Record()

	record.Mode.StartingPosition = MustStartingPosition(
		"....S....",
		".........",
		".........",
		".........",
		".........",
		".........",
		".........",
		".........",
		"....r....",
	)
	record.Final = GameState{}

	replayed, err := Replay(record)
	if err != nil {
		t.Fatal(err)
	}
	state := replayed.Snapshot()
	if countPieces(state.Grid, Red) != 1 || countPieces(state.Grid, Blue) != 1 {
		t.Fatal("replay used the mode's current layout instead of the record's")
	}
	if state.Mode.StartingPosition != record.Mode.StartingPosition {
		t.Fatal("replayed game does not report the position it was built from")
	}
}

func TestVerifyRejectsATamperedRecord(t *testing.T) {
	game := playRandomGame(t, ModeInfiltration, 7, 20)
	record := game.Record()
	if len(record.Events) < 2 {
		t.Fatal("expected a multi-move game")
	}
	record.Events = record.Events[:len(record.Events)-1]

	if err := Verify(record); err == nil || !errors.Is(err, ErrRecordMismatch) {
		t.Fatalf("expected a mismatch, got %v", err)
	}
}

// A game the engine drew on the hundredth quiet move has to replay into the
// same draw.
//
// The archive's central invariant is that a record describes one game and no
// other, and replay reproduces an adjudicated ending by playing the moves and
// insisting the engine agrees — so a new ending that the record wrote but the
// replay does not reach is a record that can never be verified again. Neither
// the resignation path nor the random-game sweep covers this one: random play
// captures far too often to ever reach the limit.
func TestRecordReplaysAGameDrawnWithNoCapture(t *testing.T) {
	created := testGame(t, ModeTotalWar)
	shuffle := quietShuffle(t, created)
	var state GameState
	for ply := 0; ply < QuietPlyLimit; ply++ {
		var err error
		move := shuffle[ply%len(shuffle)]
		state, err = created.Move(move.player, move.from, move.to)
		if err != nil {
			t.Fatalf("quiet move %d failed: %v", ply, err)
		}
	}
	if state.EndReason != EndReasonNoCapture {
		t.Fatalf("expected a no-capture draw, got %#v", state)
	}
	record := created.Record()
	if record.PlyCount() != QuietPlyLimit {
		t.Fatalf("recorded %d moves, played %d", record.PlyCount(), QuietPlyLimit)
	}
	if err := Verify(record); err != nil {
		t.Fatal(err)
	}
}
