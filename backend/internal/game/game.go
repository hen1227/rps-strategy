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
	ErrTimeOfferExists       = errors.New("a time extension is already pending")
	ErrTimeOfferUnavailable  = errors.New("extra time can only be requested once per move")
	ErrNoTimeOffer           = errors.New("there is no time extension to respond to")
	ErrCannotRespondOwnOffer = errors.New("a player cannot respond to their own offer")
)

// Game is intentionally a thin synchronized shell. It contains no movement,
// setup, or victory rules; every rule decision is delegated to its GameMode.
type Game struct {
	mu               sync.RWMutex
	mode             GameMode
	state            GameState
	repetitionCounts map[repetitionPosition]uint8
	now              func() time.Time
	clockUpdatedAt   time.Time
	startedAt        time.Time
	// events is the archival record of the game. pendingElapsedMs holds clock
	// time consumed since the last recorded event, so time spent on an action
	// that never became an event is still attributed to the next one.
	events           []Event
	plyCount         int
	pendingElapsedMs int64
	endRecorded      bool
}

// repetitionPosition contains exactly the state that determines legal play.
// Clocks, move numbers, draw offers, and player metadata do not distinguish a
// position for repetition purposes.
type repetitionPosition struct {
	Grid        [BoardSize][BoardSize]Tile
	CurrentTurn PlayerColor
}

func positionForRepetition(state GameState) repetitionPosition {
	return repetitionPosition{Grid: state.Grid, CurrentTurn: state.CurrentTurn}
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
	return newGame(registry, gameID, modeID, red, blue, timeControl, gameOptions{})
}

// gameOptions carries the two knobs only replay needs: a synthetic clock, and
// the exact board a recorded game was played from. Live play supplies neither
// and gets wall-clock time and the mode's current opening position.
type gameOptions struct {
	now              func() time.Time
	startingPosition *StartingPosition
}

func newGame(
	registry *ModeRegistry,
	gameID string,
	modeID ModeID,
	red PlayerProfile,
	blue PlayerProfile,
	timeControl TimeControl,
	options gameOptions,
) (*Game, error) {
	if err := timeControl.Validate(); err != nil {
		return nil, fmt.Errorf("create game: %w", err)
	}
	mode, err := registry.New(modeID)
	if err != nil {
		return nil, fmt.Errorf("create game: %w", err)
	}
	clock := options.now
	if clock == nil {
		clock = time.Now
	}

	now := clock()
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
	if options.startingPosition != nil {
		resetBoard(&state, *options.startingPosition)
		state.Mode.StartingPosition = *options.startingPosition
	}
	repetitionCounts := map[repetitionPosition]uint8{
		positionForRepetition(state): 1,
	}
	game := &Game{
		mode:             mode,
		state:            state,
		repetitionCounts: repetitionCounts,
		now:              clock,
		clockUpdatedAt:   now,
		startedAt:        now,
	}
	// A mode is free to define a starting position with no legal move. That is
	// an immediate stalemate rather than an unplayable game.
	game.adjudicateStalemateLocked()
	game.recordEndLocked(Neutral)
	return game, nil
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
	// Read both squares before the mode touches them: the record names the
	// piece that moved and the piece it took.
	movedPiece, capturedPiece := Empty, Empty
	if inBounds(from) {
		movedPiece = game.state.Grid[from.Y][from.X].Occupant
	}
	if inBounds(to) {
		capturedPiece = game.state.Grid[to.Y][to.X].Occupant
	}
	if err := game.mode.Move(&game.state, player, from, to); err != nil {
		return game.state, err
	}
	if game.state.Status == InProgress {
		position := positionForRepetition(game.state)
		game.repetitionCounts[position]++
		if game.repetitionCounts[position] >= 3 {
			game.finishLocked(Neutral, EndReasonRepetition)
		}
	}
	game.adjudicateStalemateLocked()
	// A move by the recipient declines a pending offer. A move by the player
	// who made the offer leaves it available for the opponent to accept.
	if pendingDrawOffer != "" && pendingDrawOffer != player {
		game.state.DrawOfferedBy = ""
	}
	// A time request outlives the move it interrupted, so whoever it was made
	// to can still grant it once they have played. Only the once-per-move
	// allowance resets.
	game.state.DrawOfferUsedBy = ""
	game.state.TimeOfferUsedBy = ""

	remaining := game.remainingTimeLocked(player)
	if remaining != nil {
		*remaining = addMilliseconds(*remaining, game.state.TimeControl.IncrementMs)
	}
	game.clockUpdatedAt = now
	game.state.Clock.UpdatedAtUnixMs = now.UnixMilli()
	if game.state.Status == Finished {
		game.state.DrawOfferedBy = ""
		game.state.TimeOfferedBy = ""
		game.state.Clock.ActiveColor = Neutral
		if game.state.EndReason == "" {
			game.state.EndReason = EndReasonGameRule
		}
	} else {
		game.state.Clock.ActiveColor = game.state.CurrentTurn
	}
	// Recorded last so the event carries the clock the move actually left
	// behind, increment included.
	game.recordMoveLocked(player, from, to, movedPiece, capturedPiece)
	game.recordEndLocked(player)
	return game.state, nil
}

// offer points at the pair of GameState fields tracking one kind of mutually
// agreed proposal. Draw offers and time extensions share most of a lifecycle:
// only one of each kind is live at a time, a player may open one only once per
// move, and only the opponent can answer it.
//
// Where they differ is whose clock the proposal belongs to. A draw is a move
// substitute, so it is offered on your own turn and a move by its recipient
// declines it. Running low on time happens whenever it happens, so either
// player may ask for more at any point and the request stands until answered.
type offer struct {
	offeredBy   *PlayerColor
	usedBy      *PlayerColor
	ownTurnOnly bool
	errExists   error
	errUnusable error
	errMissing  error
}

func (game *Game) drawOffer() offer {
	return offer{
		offeredBy:   &game.state.DrawOfferedBy,
		usedBy:      &game.state.DrawOfferUsedBy,
		ownTurnOnly: true,
		errExists:   ErrDrawOfferExists,
		errUnusable: ErrDrawOfferUnavailable,
		errMissing:  ErrNoDrawOffer,
	}
}

func (game *Game) timeOffer() offer {
	return offer{
		offeredBy:   &game.state.TimeOfferedBy,
		usedBy:      &game.state.TimeOfferUsedBy,
		errExists:   ErrTimeOfferExists,
		errUnusable: ErrTimeOfferUnavailable,
		errMissing:  ErrNoTimeOffer,
	}
}

func (game *Game) openOfferLocked(player PlayerColor, pending offer) error {
	if game.state.Status != InProgress {
		return ErrGameFinished
	}
	if *pending.usedBy == player ||
		(pending.ownTurnOnly && player != game.state.CurrentTurn) {
		return pending.errUnusable
	}
	if *pending.offeredBy != "" {
		return pending.errExists
	}
	*pending.offeredBy = player
	*pending.usedBy = player
	return nil
}

// answerOfferLocked validates a response without consuming the offer, leaving
// the caller to apply whatever accepting or declining means for its kind.
func (game *Game) answerOfferLocked(player PlayerColor, pending offer) error {
	if game.state.Status != InProgress {
		return ErrGameFinished
	}
	if *pending.offeredBy == "" {
		return pending.errMissing
	}
	if *pending.offeredBy == player {
		return ErrCannotRespondOwnOffer
	}
	return nil
}

func (game *Game) OfferDraw(player PlayerColor) (GameState, error) {
	game.mu.Lock()
	defer game.mu.Unlock()
	game.updateClockLocked(game.now())
	if err := game.openOfferLocked(player, game.drawOffer()); err != nil {
		return game.state, err
	}
	game.recordEventLocked(Event{Kind: EventDrawOffer, Player: player})
	return game.state, nil
}

func (game *Game) AcceptDraw(player PlayerColor) (GameState, error) {
	game.mu.Lock()
	defer game.mu.Unlock()
	game.updateClockLocked(game.now())
	if err := game.answerOfferLocked(player, game.drawOffer()); err != nil {
		return game.state, err
	}
	game.finishLocked(Neutral, EndReasonDrawAgreement)
	game.recordEndLocked(player)
	return game.state, nil
}

func (game *Game) DeclineDraw(player PlayerColor) (GameState, error) {
	game.mu.Lock()
	defer game.mu.Unlock()
	game.updateClockLocked(game.now())
	if err := game.answerOfferLocked(player, game.drawOffer()); err != nil {
		return game.state, err
	}
	game.state.DrawOfferedBy = ""
	game.recordEventLocked(Event{Kind: EventDrawDecline, Player: player})
	return game.state, nil
}

func (game *Game) OfferTimeExtension(player PlayerColor) (GameState, error) {
	game.mu.Lock()
	defer game.mu.Unlock()
	game.updateClockLocked(game.now())
	if err := game.openOfferLocked(player, game.timeOffer()); err != nil {
		return game.state, err
	}
	game.recordEventLocked(Event{Kind: EventTimeOffer, Player: player})
	return game.state, nil
}

// AcceptTimeExtension adds TimeExtensionMs to both clocks. Extending only the
// player who asked would turn a courtesy into a concession, so agreeing to play
// on leaves the accepting player's time advantage intact.
func (game *Game) AcceptTimeExtension(player PlayerColor) (GameState, error) {
	game.mu.Lock()
	defer game.mu.Unlock()
	game.updateClockLocked(game.now())
	if err := game.answerOfferLocked(player, game.timeOffer()); err != nil {
		return game.state, err
	}
	game.state.TimeOfferedBy = ""
	game.state.Clock.RedRemainingMs = addMilliseconds(
		game.state.Clock.RedRemainingMs,
		TimeExtensionMs,
	)
	game.state.Clock.BlueRemainingMs = addMilliseconds(
		game.state.Clock.BlueRemainingMs,
		TimeExtensionMs,
	)
	// The bonus is recorded rather than assumed, so a record replays with the
	// extension its players were actually given.
	game.recordEventLocked(Event{
		Kind:    EventTimeAccept,
		Player:  player,
		BonusMs: TimeExtensionMs,
	})
	return game.state, nil
}

func (game *Game) DeclineTimeExtension(player PlayerColor) (GameState, error) {
	game.mu.Lock()
	defer game.mu.Unlock()
	game.updateClockLocked(game.now())
	if err := game.answerOfferLocked(player, game.timeOffer()); err != nil {
		return game.state, err
	}
	game.state.TimeOfferedBy = ""
	game.recordEventLocked(Event{Kind: EventTimeDecline, Player: player})
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
	game.recordEndLocked(player)
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
	game.recordEndLocked(player)
	return game.state, nil
}

// adjudicateStalemateLocked ends the game in a draw when the player to move
// has no legal move.
//
// This is an engine-level rule that every mode inherits: it asks the active
// mode for its own legal moves rather than assuming standard movement, so a
// mode with custom movement, blocking, or immobile pieces is covered without
// changing anything here.
func (game *Game) adjudicateStalemateLocked() {
	if game.state.Status != InProgress {
		return
	}
	if game.hasLegalMoveLocked(game.state.CurrentTurn) {
		return
	}
	game.finishLocked(Neutral, EndReasonStalemate)
}

// hasLegalMoveLocked reports whether player has at least one legal move.
//
// Only meaningful for the player whose turn it is, because a mode's ValidMoves
// is defined for the active player.
func (game *Game) hasLegalMoveLocked(player PlayerColor) bool {
	for y := 0; y < BoardSize; y++ {
		for x := 0; x < BoardSize; x++ {
			if game.state.Grid[y][x].OccupantOwner != player {
				continue
			}
			if len(game.mode.ValidMoves(game.state, player, Position{X: x, Y: y})) > 0 {
				return true
			}
		}
	}
	return false
}

// HasLegalMove reports whether the player to move has any legal move.
func (game *Game) HasLegalMove() bool {
	game.mu.RLock()
	defer game.mu.RUnlock()
	return game.hasLegalMoveLocked(game.state.CurrentTurn)
}

func (game *Game) finishLocked(winner PlayerColor, reason GameEndReason) {
	game.state.Status = Finished
	game.state.Winner = winner
	game.state.EndReason = reason
	game.state.DrawOfferedBy = ""
	game.state.DrawOfferUsedBy = ""
	game.state.TimeOfferedBy = ""
	game.state.TimeOfferUsedBy = ""
	game.state.Clock.ActiveColor = Neutral
	game.state.Clock.UpdatedAtUnixMs = game.clockUpdatedAt.UnixMilli()
}

// Tick advances the clock to now. The boolean reports whether the game ended
// on time. It remains true for a timed-out game so the server cannot miss the
// terminal result if another read advanced the clock first.
func (game *Game) Tick(now time.Time) (GameState, bool) {
	game.mu.Lock()
	defer game.mu.Unlock()
	game.updateClockLocked(now)
	return game.state, game.state.Status == Finished && game.state.EndReason == EndReasonTimeout
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
		game.pendingElapsedMs += *remaining
		*remaining = 0
		game.clockUpdatedAt = expiredAt
		flagged := game.state.CurrentTurn
		game.finishLocked(OtherColor(flagged), EndReasonTimeout)
		game.recordEndLocked(flagged)
		return true
	}

	game.pendingElapsedMs += elapsedMs
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
