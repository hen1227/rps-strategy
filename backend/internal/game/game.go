package game

import (
	"errors"
	"fmt"
	"sync"
	"time"
)

var (
	ErrDrawOfferExists       = errors.New("a draw offer is already pending")
	ErrDrawOfferUnavailable  = errors.New("a draw can only be offered once on your turn")
	ErrNoDrawOffer           = errors.New("there is no draw offer to respond to")
	ErrCannotRespondOwnOffer = errors.New("a player cannot respond to their own draw offer")
)

// Game is intentionally a thin synchronized shell. It contains no movement,
// setup, or victory rules; every rule decision is delegated to its GameMode.
type Game struct {
	mu             sync.RWMutex
	mode           GameMode
	state          GameState
	now            func() time.Time
	clockUpdatedAt time.Time
	timeoutPending bool
}

func NewGame(gameID string, modeID ModeID, red, blue PlayerProfile) (*Game, error) {
	return NewGameWithTimeControl(gameID, modeID, red, blue, DefaultTimeControl())
}

func NewGameWithTimeControl(
	gameID string,
	modeID ModeID,
	red PlayerProfile,
	blue PlayerProfile,
	timeControl TimeControl,
) (*Game, error) {
	return NewGameWithRegistryAndTimeControl(
		DefaultModeRegistry,
		gameID,
		modeID,
		red,
		blue,
		timeControl,
	)
}

func NewGameWithRegistry(
	registry *ModeRegistry,
	gameID string,
	modeID ModeID,
	red PlayerProfile,
	blue PlayerProfile,
) (*Game, error) {
	return NewGameWithRegistryAndTimeControl(
		registry,
		gameID,
		modeID,
		red,
		blue,
		DefaultTimeControl(),
	)
}

func NewGameWithRegistryAndTimeControl(
	registry *ModeRegistry,
	gameID string,
	modeID ModeID,
	red PlayerProfile,
	blue PlayerProfile,
	timeControl TimeControl,
) (*Game, error) {
	if err := timeControl.Validate(); err != nil {
		return nil, fmt.Errorf("create game: %w", err)
	}
	mode, err := registry.New(modeID)
	if err != nil {
		return nil, fmt.Errorf("create game: %w", err)
	}

	now := time.Now()
	state := GameState{
		GameID:      gameID,
		Mode:        mode.Definition(),
		TimeControl: timeControl,
		Clock:       newClockState(timeControl, now),
		CurrentTurn: Red,
		Status:      InProgress,
		Winner:      Neutral,
		RedPlayer:   red,
		BluePlayer:  blue,
	}
	mode.Initialize(&state)
	return &Game{
		mode:           mode,
		state:          state,
		now:            time.Now,
		clockUpdatedAt: now,
	}, nil
}

func (game *Game) Snapshot() GameState {
	game.mu.Lock()
	defer game.mu.Unlock()
	game.updateClockLocked(game.now())
	return game.state
}

func (game *Game) ValidMoves(player PlayerColor, from Position) []Position {
	game.mu.Lock()
	defer game.mu.Unlock()
	game.updateClockLocked(game.now())
	return game.mode.ValidMoves(game.state, player, from)
}

func (game *Game) Move(player PlayerColor, from, to Position) (GameState, error) {
	game.mu.Lock()
	defer game.mu.Unlock()
	now := game.now()
	game.updateClockLocked(now)
	if game.state.Status != InProgress {
		return game.state, ErrGameFinished
	}
	pendingDrawOffer := game.state.DrawOfferedBy
	if err := game.mode.Move(&game.state, player, from, to); err != nil {
		return game.state, err
	}
	// A move by the recipient declines a pending offer. A move by the player
	// who made the offer leaves it available for the opponent to accept.
	if pendingDrawOffer != "" && pendingDrawOffer != player {
		game.state.DrawOfferedBy = ""
	}
	game.state.DrawOfferUsedBy = ""

	remaining := game.remainingTimeLocked(player)
	if remaining != nil {
		*remaining = addMilliseconds(*remaining, game.state.TimeControl.IncrementMs)
	}
	game.clockUpdatedAt = now
	game.state.Clock.UpdatedAtUnixMs = now.UnixMilli()
	if game.state.Status == Finished {
		game.state.DrawOfferedBy = ""
		game.state.Clock.ActiveColor = Neutral
		if game.state.EndReason == "" {
			game.state.EndReason = EndReasonGameRule
		}
	} else {
		game.state.Clock.ActiveColor = game.state.CurrentTurn
	}
	return game.state, nil
}

func (game *Game) OfferDraw(player PlayerColor) (GameState, error) {
	game.mu.Lock()
	defer game.mu.Unlock()
	game.updateClockLocked(game.now())
	if game.state.Status != InProgress {
		return game.state, ErrGameFinished
	}
	if player != game.state.CurrentTurn || game.state.DrawOfferUsedBy == player {
		return game.state, ErrDrawOfferUnavailable
	}
	if game.state.DrawOfferedBy != "" {
		return game.state, ErrDrawOfferExists
	}
	game.state.DrawOfferedBy = player
	game.state.DrawOfferUsedBy = player
	return game.state, nil
}

func (game *Game) AcceptDraw(player PlayerColor) (GameState, error) {
	game.mu.Lock()
	defer game.mu.Unlock()
	game.updateClockLocked(game.now())
	if game.state.Status != InProgress {
		return game.state, ErrGameFinished
	}
	if game.state.DrawOfferedBy == "" {
		return game.state, ErrNoDrawOffer
	}
	if game.state.DrawOfferedBy == player {
		return game.state, ErrCannotRespondOwnOffer
	}
	game.finishLocked(Neutral, EndReasonDrawAgreement)
	return game.state, nil
}

func (game *Game) DeclineDraw(player PlayerColor) (GameState, error) {
	game.mu.Lock()
	defer game.mu.Unlock()
	game.updateClockLocked(game.now())
	if game.state.Status != InProgress {
		return game.state, ErrGameFinished
	}
	if game.state.DrawOfferedBy == "" {
		return game.state, ErrNoDrawOffer
	}
	if game.state.DrawOfferedBy == player {
		return game.state, ErrCannotRespondOwnOffer
	}
	game.state.DrawOfferedBy = ""
	return game.state, nil
}

func (game *Game) Resign(player PlayerColor) (GameState, error) {
	game.mu.Lock()
	defer game.mu.Unlock()
	game.updateClockLocked(game.now())
	if game.state.Status != InProgress {
		return game.state, ErrGameFinished
	}
	game.finishLocked(OtherColor(player), EndReasonResignation)
	return game.state, nil
}

func (game *Game) Abandon(player PlayerColor) (GameState, error) {
	game.mu.Lock()
	defer game.mu.Unlock()
	game.updateClockLocked(game.now())
	if game.state.Status != InProgress {
		return game.state, ErrGameFinished
	}
	game.finishLocked(OtherColor(player), EndReasonAbandonment)
	return game.state, nil
}

func (game *Game) finishLocked(winner PlayerColor, reason GameEndReason) {
	game.state.Status = Finished
	game.state.Winner = winner
	game.state.EndReason = reason
	game.state.DrawOfferedBy = ""
	game.state.DrawOfferUsedBy = ""
	game.state.Clock.ActiveColor = Neutral
	game.state.Clock.UpdatedAtUnixMs = game.clockUpdatedAt.UnixMilli()
}

// Tick advances the clock to now. The boolean reports an unpublished timeout,
// allowing the server to broadcast it even if another game read observed it
// just before this tick.
func (game *Game) Tick(now time.Time) (GameState, bool) {
	game.mu.Lock()
	defer game.mu.Unlock()
	game.updateClockLocked(now)
	expired := game.timeoutPending
	game.timeoutPending = false
	return game.state, expired
}

func (game *Game) updateClockLocked(now time.Time) bool {
	if game.state.Status != InProgress || !now.After(game.clockUpdatedAt) {
		return false
	}

	remaining := game.remainingTimeLocked(game.state.CurrentTurn)
	if remaining == nil {
		return false
	}
	elapsedMs := now.Sub(game.clockUpdatedAt).Milliseconds()
	if elapsedMs <= 0 {
		return false
	}
	if elapsedMs >= *remaining {
		expiredAt := game.clockUpdatedAt.Add(time.Duration(*remaining) * time.Millisecond)
		*remaining = 0
		game.clockUpdatedAt = expiredAt
		game.state.Clock.ActiveColor = Neutral
		game.state.Clock.UpdatedAtUnixMs = expiredAt.UnixMilli()
		game.state.Status = Finished
		game.state.Winner = OtherColor(game.state.CurrentTurn)
		game.state.EndReason = EndReasonTimeout
		game.timeoutPending = true
		return true
	}

	*remaining -= elapsedMs
	game.clockUpdatedAt = game.clockUpdatedAt.Add(time.Duration(elapsedMs) * time.Millisecond)
	game.state.Clock.UpdatedAtUnixMs = game.clockUpdatedAt.UnixMilli()
	return false
}

func (game *Game) remainingTimeLocked(color PlayerColor) *int64 {
	switch color {
	case Red:
		return &game.state.Clock.RedRemainingMs
	case Blue:
		return &game.state.Clock.BlueRemainingMs
	default:
		return nil
	}
}
