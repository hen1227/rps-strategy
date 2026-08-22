package game

import (
	"errors"
	"testing"
	"time"
)

func useFakeGameTime(game *Game, now *time.Time) {
	game.mu.Lock()
	game.now = func() time.Time { return *now }
	game.clockUpdatedAt = *now
	game.state.Clock.UpdatedAtUnixMs = now.UnixMilli()
	game.mu.Unlock()
}

func TestNewGameUsesFivePlusThreeByDefault(t *testing.T) {
	game := testGame(t, ModeAnnihilation)
	now := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	useFakeGameTime(game, &now)

	state := game.Snapshot()
	if state.TimeControl != DefaultTimeControl() {
		t.Fatalf("expected default 5/+3 control, got %#v", state.TimeControl)
	}
	if state.Clock.RedRemainingMs != DefaultInitialTimeMs ||
		state.Clock.BlueRemainingMs != DefaultInitialTimeMs {
		t.Fatalf("expected both clocks at %dms, got %#v", DefaultInitialTimeMs, state.Clock)
	}
	if state.Clock.ActiveColor != Red {
		t.Fatalf("expected Red's clock to start first, got %s", state.Clock.ActiveColor)
	}
}

func TestCustomClockChargesElapsedTimeAndAddsIncrement(t *testing.T) {
	control := TimeControl{InitialTimeMs: 10_000, IncrementMs: 2_000}
	game, err := NewGameWithTimeControl(
		"custom-clock",
		ModeAnnihilation,
		PlayerProfile{UserID: "red"},
		PlayerProfile{UserID: "blue"},
		control,
	)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	useFakeGameTime(game, &now)

	now = now.Add(1500 * time.Millisecond)
	redFrom, redTo := anyLegalMove(t, game)
	state, err := game.Move(Red, redFrom, redTo)
	if err != nil {
		t.Fatal(err)
	}
	if state.Clock.RedRemainingMs != 10_500 {
		t.Fatalf("expected 10000-1500+2000ms for Red, got %d", state.Clock.RedRemainingMs)
	}
	if state.Clock.BlueRemainingMs != 10_000 || state.Clock.ActiveColor != Blue {
		t.Fatalf("expected untouched active Blue clock, got %#v", state.Clock)
	}

	now = now.Add(4 * time.Second)
	blueFrom, blueTo := anyLegalMove(t, game)
	state, err = game.Move(Blue, blueFrom, blueTo)
	if err != nil {
		t.Fatal(err)
	}
	if state.Clock.BlueRemainingMs != 8_000 {
		t.Fatalf("expected 10000-4000+2000ms for Blue, got %d", state.Clock.BlueRemainingMs)
	}
	if state.Clock.ActiveColor != Red {
		t.Fatalf("expected Red's clock to resume, got %s", state.Clock.ActiveColor)
	}
}

func TestInvalidMoveConsumesTimeWithoutAddingIncrement(t *testing.T) {
	control := TimeControl{InitialTimeMs: 10_000, IncrementMs: 2_000}
	game, err := NewGameWithTimeControl(
		"invalid-move-clock",
		ModeAnnihilation,
		PlayerProfile{UserID: "red"},
		PlayerProfile{UserID: "blue"},
		control,
	)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	useFakeGameTime(game, &now)

	now = now.Add(2 * time.Second)
	invalidFrom := firstPieceOf(t, game, Red, Rock)
	state, err := game.Move(Red, invalidFrom, Position{X: invalidFrom.X - 2, Y: invalidFrom.Y})
	if !errors.Is(err, ErrInvalidMovement) {
		t.Fatalf("expected invalid movement, got %v", err)
	}
	if state.Clock.RedRemainingMs != 8_000 {
		t.Fatalf("expected elapsed time without increment, got %d", state.Clock.RedRemainingMs)
	}
	if state.Clock.ActiveColor != Red {
		t.Fatalf("expected Red's clock to keep running, got %s", state.Clock.ActiveColor)
	}
}

func TestClockTimeoutFinishesGame(t *testing.T) {
	control := TimeControl{InitialTimeMs: 1_000, IncrementMs: 0}
	game, err := NewGameWithTimeControl(
		"timeout",
		ModeAnnihilation,
		PlayerProfile{UserID: "red"},
		PlayerProfile{UserID: "blue"},
		control,
	)
	if err != nil {
		t.Fatal(err)
	}
	baseTime := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	useFakeGameTime(game, &baseTime)

	state, expired := game.Tick(baseTime.Add(time.Second))
	if !expired {
		t.Fatal("expected the active clock to expire")
	}
	if state.Status != Finished || state.Winner != Blue || state.EndReason != EndReasonTimeout {
		t.Fatalf("expected Blue to win on time, got %#v", state)
	}
	if state.Clock.RedRemainingMs != 0 || state.Clock.ActiveColor != Neutral {
		t.Fatalf("expected a stopped, exhausted Red clock, got %#v", state.Clock)
	}
}

func TestClockTimeoutMakesBlueLoseAfterRedMoves(t *testing.T) {
	control := TimeControl{InitialTimeMs: 1_000, IncrementMs: 0}
	game, err := NewGameWithTimeControl(
		"blue-timeout",
		ModeAnnihilation,
		PlayerProfile{UserID: "red"},
		PlayerProfile{UserID: "blue"},
		control,
	)
	if err != nil {
		t.Fatal(err)
	}
	baseTime := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	now := baseTime
	useFakeGameTime(game, &now)

	now = now.Add(100 * time.Millisecond)
	from, to := anyLegalMove(t, game)
	state, err := game.Move(Red, from, to)
	if err != nil {
		t.Fatal(err)
	}
	if state.CurrentTurn != Blue {
		t.Fatalf("expected Blue's turn after Red moved, got %s", state.CurrentTurn)
	}

	state, expired := game.Tick(now.Add(time.Second))
	if !expired {
		t.Fatal("expected Blue's clock to expire")
	}
	if state.Status != Finished || state.Winner != Red || state.EndReason != EndReasonTimeout {
		t.Fatalf("expected Red to win when Blue ran out of time, got %#v", state)
	}
	if state.Clock.BlueRemainingMs != 0 || state.Clock.ActiveColor != Neutral {
		t.Fatalf("expected a stopped, exhausted Blue clock, got %#v", state.Clock)
	}
}

func TestTickReportsTimeoutObservedByValidMoveRequest(t *testing.T) {
	control := TimeControl{InitialTimeMs: 1_000, IncrementMs: 0}
	game, err := NewGameWithTimeControl(
		"valid-moves-timeout",
		ModeAnnihilation,
		PlayerProfile{UserID: "red"},
		PlayerProfile{UserID: "blue"},
		control,
	)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	useFakeGameTime(game, &now)

	now = now.Add(time.Second)
	if moves := game.ValidMoves(Red, Position{X: 0, Y: 8}); len(moves) != 0 {
		t.Fatalf("expected no moves after timeout, got %#v", moves)
	}
	state, expired := game.Tick(now)
	if !expired || state.EndReason != EndReasonTimeout {
		t.Fatalf("expected tick to publish the observed timeout, got expired=%t state=%#v", expired, state)
	}
}

func TestTickContinuesReportingTimeoutUntilServerHandlesIt(t *testing.T) {
	control := TimeControl{InitialTimeMs: 1_000, IncrementMs: 0}
	game, err := NewGameWithTimeControl(
		"repeated-timeout-report",
		ModeAnnihilation,
		PlayerProfile{UserID: "red"},
		PlayerProfile{UserID: "blue"},
		control,
	)
	if err != nil {
		t.Fatal(err)
	}
	baseTime := time.Date(2026, time.August, 17, 12, 0, 0, 0, time.UTC)
	useFakeGameTime(game, &baseTime)
	expiredAt := baseTime.Add(time.Second)

	if _, expired := game.Tick(expiredAt); !expired {
		t.Fatal("expected the first tick to report timeout")
	}
	if state, expired := game.Tick(expiredAt.Add(time.Second)); !expired || state.Winner != Blue {
		t.Fatalf("expected timeout loss to remain reportable, got expired=%t state=%#v", expired, state)
	}
}

func TestInvalidTimeControlsAreRejected(t *testing.T) {
	profiles := []PlayerProfile{{UserID: "red"}, {UserID: "blue"}}
	controls := []TimeControl{
		{InitialTimeMs: 0, IncrementMs: 1},
		{InitialTimeMs: 1, IncrementMs: -1},
	}
	for _, control := range controls {
		_, err := NewGameWithTimeControl(
			"invalid-control",
			ModeAnnihilation,
			profiles[0],
			profiles[1],
			control,
		)
		if !errors.Is(err, ErrInvalidTimeControl) {
			t.Fatalf("expected ErrInvalidTimeControl for %#v, got %v", control, err)
		}
	}
}
