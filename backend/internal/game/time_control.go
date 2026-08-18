package game

import (
	"errors"
	"fmt"
	"math"
	"time"
)

const (
	DefaultInitialTimeMs int64 = 5 * 60 * 1000
	DefaultIncrementMs   int64 = 3 * 1000
)

var ErrInvalidTimeControl = errors.New("invalid time control")

// TimeControl uses milliseconds on the wire so clients do not need to know
// about Go's nanosecond-based time.Duration representation.
type TimeControl struct {
	InitialTimeMs int64 `json:"initialTimeMs"`
	IncrementMs   int64 `json:"incrementMs"`
}

func DefaultTimeControl() TimeControl {
	return TimeControl{
		InitialTimeMs: DefaultInitialTimeMs,
		IncrementMs:   DefaultIncrementMs,
	}
}

func (control TimeControl) Validate() error {
	if control.InitialTimeMs <= 0 {
		return fmt.Errorf("%w: initialTimeMs must be greater than zero", ErrInvalidTimeControl)
	}
	if control.IncrementMs < 0 {
		return fmt.Errorf("%w: incrementMs must not be negative", ErrInvalidTimeControl)
	}
	return nil
}

// ClockState is a server-authoritative snapshot. While ActiveColor is Red or
// Blue, that player's displayed time should be reduced from UpdatedAtUnixMs.
type ClockState struct {
	RedRemainingMs  int64       `json:"redRemainingMs"`
	BlueRemainingMs int64       `json:"blueRemainingMs"`
	ActiveColor     PlayerColor `json:"activeColor"`
	UpdatedAtUnixMs int64       `json:"updatedAtUnixMs"`
}

func newClockState(control TimeControl, now time.Time) ClockState {
	return ClockState{
		RedRemainingMs:  control.InitialTimeMs,
		BlueRemainingMs: control.InitialTimeMs,
		ActiveColor:     Red,
		UpdatedAtUnixMs: now.UnixMilli(),
	}
}

func addMilliseconds(value, increment int64) int64 {
	if increment > math.MaxInt64-value {
		return math.MaxInt64
	}
	return value + increment
}
