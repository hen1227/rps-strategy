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
	initialPosition  *InitialPosition
	repetitionCounts map[string]uint8
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
	// standardOpening is a game the opening book can speak about: one that
	// began from the mode's own starting position. A custom board or a
	// replayed position is a different tree, and a line measured from it would
	// name openings nobody played.
	standardOpening bool
	// clockPending is a game that exists but has not begun. Neither clock runs
	// and neither can fall, because the two people it was made for may still be
	// walking back to it: a game is now seated the instant two seeks fit, and
	// the first move is what turns it into something being played. The server
	// puts its own thirty-second bound on how long this may last; the rule here
	// is only that no time is spent until somebody moves.
	clockPending bool
}

// positionForRepetition names exactly the state that determines legal play.
// Clocks, move numbers, draw offers, and player metadata do not distinguish a
// position for repetition purposes.
//
// A string rather than a struct because the board is a slice now and a slice
// cannot be a map key. Grid.Key spells the board; the side to move is the rest
// of what makes a position the same picture twice.
func positionForRepetition(state GameState) string {
	return state.Grid.Key() + " " + string(state.CurrentTurn)
}

// stateCopyLocked is the live state over a board nobody else holds.
//
// GameState is passed and returned by value, but its grid is a slice now, so
// the value alone no longer carries a private board — and two paths depended on
// the fixed array giving them one for free:
//
//   - A mode reading the state (ValidMoves, and the stalemate scan through it)
//     would otherwise get a writable alias of the live board. A mode's Move is
//     supposed to mutate, so Move is deliberately still handed game.state
//     itself; every other call into a mode goes through here.
//   - A caller that received a GameState is still holding it after the lock is
//     released, and the next move would rewrite the board underneath them.
//     recordOpeningMoveLocked rebuilds its slice for the same reason.
func (game *Game) stateCopyLocked() GameState {
	copied := game.state
	copied.Grid = game.state.Grid.Clone()
	return copied
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
	return NewGameWithRegistryTimeControlAndStartingPosition(
		registry,
		gameID,
		modeID,
		red,
		blue,
		timeControl,
		nil,
	)
}

// NewGameWithRegistryTimeControlAndStartingPosition creates a live game from
// an optional custom board. A nil position keeps the mode's normal opening.
func NewGameWithRegistryTimeControlAndStartingPosition(
	registry *ModeRegistry,
	gameID string,
	modeID ModeID,
	red PlayerProfile,
	blue PlayerProfile,
	timeControl TimeControl,
	startingPosition *StartingPosition,
) (*Game, error) {
	if startingPosition != nil {
		mode, err := registry.New(modeID)
		if err != nil {
			return nil, fmt.Errorf("create game: %w", err)
		}
		if err := ValidatePositionFor(mode, *startingPosition); err != nil {
			return nil, fmt.Errorf("create game: %w", err)
		}
	}
	return newGame(
		registry,
		gameID,
		modeID,
		red,
		blue,
		timeControl,
		gameOptions{startingPosition: startingPosition},
	)
}

// NewGameFromSetup creates the game a GameSetup describes. This is the
// constructor every live game goes through: the ones above are the old
// argument-per-option spellings, kept for callers that only vary one thing, and
// they cannot express rule flags at all.
func NewGameFromSetup(
	registry *ModeRegistry,
	gameID string,
	setup GameSetup,
	red PlayerProfile,
	blue PlayerProfile,
) (*Game, error) {
	return NewGameFromSetupWithStart(registry, gameID, setup, red, blue, StartOptions{})
}

// StartOptions are the things a caller decides about a new game that are not
// part of what the two players agreed to play.
type StartOptions struct {
	// ClockStartsOnFirstMove holds both clocks at their initial time until a
	// move is played. Matchmaking sets it, because the game is now opened
	// before either player has necessarily arrived at it; a tournament round or
	// a bot game does not, because both sides are demonstrably already there.
	ClockStartsOnFirstMove bool
}

// NewGameFromSetupWithStart is NewGameFromSetup for a caller that has something
// to say about how the game begins.
func NewGameFromSetupWithStart(
	registry *ModeRegistry,
	gameID string,
	setup GameSetup,
	red PlayerProfile,
	blue PlayerProfile,
	start StartOptions,
) (*Game, error) {
	mode, err := registry.New(setup.ModeID)
	if err != nil {
		return nil, fmt.Errorf("create game: %w", err)
	}
	// Normalized here rather than by the caller. A tournament round or a bot
	// game knows a mode and a clock and nothing about opening formations, and
	// asking each of those callers to look one up would be asking them to get
	// it right.
	setup = setup.Normalize(mode.Definition())
	if err := setup.ValidateForMode(mode); err != nil {
		return nil, fmt.Errorf("create game: %w", err)
	}
	startingPosition := setup.StartingPosition
	return newGame(
		registry,
		gameID,
		setup.ModeID,
		red,
		blue,
		setup.TimeControl,
		gameOptions{
			startingPosition:       &startingPosition,
			rules:                  setup.Rules,
			clockStartsOnFirstMove: start.ClockStartsOnFirstMove,
		},
	)
}

// gameOptions carries a synthetic clock for replay, an optional board for
// replay or a custom game, and the optional rules a custom game switched off.
// Ordinary games supply none of them.
type gameOptions struct {
	now              func() time.Time
	startingPosition *StartingPosition
	initialPosition  *InitialPosition
	rules            RuleFlags
	// clockStartsOnFirstMove withholds the clock until the game is actually
	// being played. Replay never sets it: a recorded first move already carries
	// the elapsed time it consumed, which for such a game is zero.
	clockStartsOnFirstMove bool
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
		Rules:       options.rules,
		Clock:       newClockState(timeControl, now),
		CurrentTurn: Red,
		Status:      InProgress,
		Winner:      Neutral,
		RedPlayer:   red,
		BluePlayer:  blue,
	}
	mode.Initialize(&state)
	var initialPosition *InitialPosition
	if options.initialPosition != nil {
		// Three boards, deliberately: the caller's, the record's, and the one
		// about to be played on. The caller keeps theirs, and the record's has
		// to survive the game being played — one shared slice here wrote the
		// final position into the record's own starting FEN, which the PGN
		// round-trip test caught.
		copied := *options.initialPosition
		copied.Grid = copied.Grid.Clone()
		initialPosition = &copied
		state.Grid = copied.Grid.Clone()
		state.CurrentTurn = copied.CurrentTurn
		state.Clock.ActiveColor = copied.CurrentTurn
	}
	if options.startingPosition != nil {
		if options.initialPosition == nil {
			resetBoard(&state, *options.startingPosition)
		}
		state.Mode.StartingPosition = *options.startingPosition
	}
	if options.clockStartsOnFirstMove {
		// Neutral is the same value a finished game carries, and it means the
		// same thing to every clock on every screen: nothing is running. It is
		// restored to the side to move by the first move, in Move below.
		state.Clock.ActiveColor = Neutral
	}
	standardOpening := options.initialPosition == nil &&
		(options.startingPosition == nil ||
			*options.startingPosition == mode.Definition().StartingPosition)
	var repetitionCounts map[string]uint8
	if !options.rules.NoRepetitionDraw {
		repetitionCounts = map[string]uint8{
			positionForRepetition(state): 1,
		}
	}
	game := &Game{
		mode:             mode,
		state:            state,
		initialPosition:  initialPosition,
		repetitionCounts: repetitionCounts,
		now:              clock,
		clockUpdatedAt:   now,
		startedAt:        now,
		standardOpening:  standardOpening,
		clockPending:     options.clockStartsOnFirstMove,
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
	return game.stateCopyLocked()
}

// AwaitingFirstMove reports a game that has been opened but not begun: both
// clocks are still whole, and neither is running.
//
// It answers false the moment a move is played, and false for every game whose
// caller did not ask for a deferred clock, so a reader that does not know about
// this state never sees it.
func (game *Game) AwaitingFirstMove() bool {
	game.mu.RLock()
	defer game.mu.RUnlock()
	return game.clockPending && game.state.Status == InProgress
}

func (game *Game) ValidMoves(player PlayerColor, from Position) []Position {
	game.mu.Lock()
	defer game.mu.Unlock()
	game.updateClockLocked(game.now())
	return game.mode.ValidMoves(game.stateCopyLocked(), player, from)
}

func (game *Game) Move(player PlayerColor, from, to Position) (GameState, error) {
	game.mu.Lock()
	defer game.mu.Unlock()
	now := game.now()
	game.updateClockLocked(now)
	if game.state.Status != InProgress {
		return game.stateCopyLocked(), ErrGameFinished
	}
	pendingDrawOffer := game.state.DrawOfferedBy
	// Read both squares before the mode touches them: the record names the
	// piece that moved and the piece it took.
	movedPiece, capturedPiece := Empty, Empty
	if game.state.Grid.Contains(from) {
		movedPiece = game.state.Grid.At(from).Occupant
	}
	if game.state.Grid.Contains(to) {
		capturedPiece = game.state.Grid.At(to).Occupant
	}
	if err := game.mode.Move(&game.state, player, from, to); err != nil {
		return game.stateCopyLocked(), err
	}
	if game.state.Status == InProgress && !game.state.Rules.NoRepetitionDraw {
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

	// The move that turns a seated game into a game being played. Cleared
	// before the clock is re-anchored below, so the side to move is on the
	// clock from this instant.
	game.clockPending = false

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
	return game.stateCopyLocked(), nil
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
	if game.state.Rules.NoDrawOffers {
		return game.stateCopyLocked(), ErrDrawOffersDisabled
	}
	if err := game.openOfferLocked(player, game.drawOffer()); err != nil {
		return game.stateCopyLocked(), err
	}
	game.recordEventLocked(Event{Kind: EventDrawOffer, Player: player})
	return game.stateCopyLocked(), nil
}

func (game *Game) AcceptDraw(player PlayerColor) (GameState, error) {
	game.mu.Lock()
	defer game.mu.Unlock()
	game.updateClockLocked(game.now())
	if err := game.answerOfferLocked(player, game.drawOffer()); err != nil {
		return game.stateCopyLocked(), err
	}
	game.finishLocked(Neutral, EndReasonDrawAgreement)
	game.recordEndLocked(player)
	return game.stateCopyLocked(), nil
}

func (game *Game) DeclineDraw(player PlayerColor) (GameState, error) {
	game.mu.Lock()
	defer game.mu.Unlock()
	game.updateClockLocked(game.now())
	if err := game.answerOfferLocked(player, game.drawOffer()); err != nil {
		return game.stateCopyLocked(), err
	}
	game.state.DrawOfferedBy = ""
	game.recordEventLocked(Event{Kind: EventDrawDecline, Player: player})
	return game.stateCopyLocked(), nil
}

func (game *Game) OfferTimeExtension(player PlayerColor) (GameState, error) {
	game.mu.Lock()
	defer game.mu.Unlock()
	game.updateClockLocked(game.now())
	if game.state.Rules.NoTimeExtensions {
		return game.stateCopyLocked(), ErrTimeExtensionsDisabled
	}
	if err := game.openOfferLocked(player, game.timeOffer()); err != nil {
		return game.stateCopyLocked(), err
	}
	game.recordEventLocked(Event{Kind: EventTimeOffer, Player: player})
	return game.stateCopyLocked(), nil
}

// AcceptTimeExtension adds TimeExtensionMs to both clocks. Extending only the
// player who asked would turn a courtesy into a concession, so agreeing to play
// on leaves the accepting player's time advantage intact.
func (game *Game) AcceptTimeExtension(player PlayerColor) (GameState, error) {
	game.mu.Lock()
	defer game.mu.Unlock()
	game.updateClockLocked(game.now())
	if err := game.answerOfferLocked(player, game.timeOffer()); err != nil {
		return game.stateCopyLocked(), err
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
	return game.stateCopyLocked(), nil
}

func (game *Game) DeclineTimeExtension(player PlayerColor) (GameState, error) {
	game.mu.Lock()
	defer game.mu.Unlock()
	game.updateClockLocked(game.now())
	if err := game.answerOfferLocked(player, game.timeOffer()); err != nil {
		return game.stateCopyLocked(), err
	}
	game.state.TimeOfferedBy = ""
	game.recordEventLocked(Event{Kind: EventTimeDecline, Player: player})
	return game.stateCopyLocked(), nil
}

func (game *Game) Resign(player PlayerColor) (GameState, error) {
	game.mu.Lock()
	defer game.mu.Unlock()
	game.updateClockLocked(game.now())
	if game.state.Status != InProgress {
		return game.stateCopyLocked(), ErrGameFinished
	}
	game.finishLocked(OtherColor(player), EndReasonResignation)
	game.recordEndLocked(player)
	return game.stateCopyLocked(), nil
}

func (game *Game) Abandon(player PlayerColor) (GameState, error) {
	game.mu.Lock()
	defer game.mu.Unlock()
	game.updateClockLocked(game.now())
	if game.state.Status != InProgress {
		return game.stateCopyLocked(), ErrGameFinished
	}
	game.finishLocked(OtherColor(player), EndReasonAbandonment)
	game.recordEndLocked(player)
	return game.stateCopyLocked(), nil
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
	view := game.stateCopyLocked()
	for y, row := range game.state.Grid {
		for x, tile := range row {
			if tile.OccupantOwner != player {
				continue
			}
			if len(game.mode.ValidMoves(view, player, Position{X: x, Y: y})) > 0 {
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
	return game.stateCopyLocked(), game.state.Status == Finished && game.state.EndReason == EndReasonTimeout
}

func (game *Game) updateClockLocked(now time.Time) bool {
	if game.state.Status != InProgress || !now.After(game.clockUpdatedAt) {
		return false
	}
	if game.clockPending {
		// Time passes and none of it is spent. The anchor still moves, so the
		// first move starts its opponent's clock from the moment it was played
		// rather than from the moment the board opened, and the elapsed time
		// recorded against that move is zero — which is what makes a replay of
		// this game reproduce these clocks exactly.
		game.clockUpdatedAt = now
		game.state.Clock.UpdatedAtUnixMs = now.UnixMilli()
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
