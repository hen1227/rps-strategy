package game

import (
	"errors"
	"fmt"
	"time"
)

// ErrRecordMismatch reports a recorded game that does not reproduce itself.
// Every archived game is expected to replay into the exact position it
// finished in, so a mismatch means the record, not the replay, is wrong.
var ErrRecordMismatch = errors.New("recorded game does not reproduce its final state")

// EventKind names one entry in a game's history. The event log is the complete
// ordered account of everything that changed a game: every move, every
// proposal exchanged between the players, and the ending. Replay turns the log
// back into an identical Game, which makes it the canonical archival form.
type EventKind string

const (
	EventMove        EventKind = "move"
	EventDrawOffer   EventKind = "draw_offer"
	EventDrawDecline EventKind = "draw_decline"
	EventTimeOffer   EventKind = "time_offer"
	EventTimeDecline EventKind = "time_decline"
	EventTimeAccept  EventKind = "time_accept"
	EventGameEnd     EventKind = "end"
)

// Event is one recorded change to a game.
//
// ElapsedMs is what makes a record replayable rather than merely readable: it
// is the clock time the side to move spent between the previous event and this
// one, so advancing a replay clock by exactly that amount reproduces both
// clocks to the millisecond. Time an action did not survive to record — a
// rejected move, a draw offer out of turn — is carried forward into the next
// event, so the elapsed times always sum to the time actually consumed.
type Event struct {
	Kind   EventKind   `json:"kind"`
	Player PlayerColor `json:"player"`
	// Ply counts the moves recorded up to and including this event, so a
	// proposal shares the ply number of the move it followed.
	Ply int `json:"ply"`
	// From, To, Piece, and Captured describe EventMove and are zero otherwise.
	Captured        Piece         `json:"captured,omitempty"`
	Piece           Piece         `json:"piece,omitempty"`
	From            Position      `json:"from"`
	To              Position      `json:"to"`
	ElapsedMs       int64         `json:"elapsedMs"`
	BonusMs         int64         `json:"bonusMs,omitempty"`
	RedRemainingMs  int64         `json:"redRemainingMs"`
	BlueRemainingMs int64         `json:"blueRemainingMs"`
	Winner          PlayerColor   `json:"winner,omitempty"`
	EndReason       GameEndReason `json:"endReason,omitempty"`
}

// InitialPosition is the complete state a record began from. Most live games
// can derive this from Mode.StartingPosition, but an imported PGN may also
// start with Blue to move or with territory that does not follow its pieces.
type InitialPosition struct {
	Grid        Grid        `json:"grid"`
	CurrentTurn PlayerColor `json:"currentTurn"`
}

func (position InitialPosition) Validate() error {
	if position.CurrentTurn != Red && position.CurrentTurn != Blue {
		return fmt.Errorf(
			"%w: initial current turn must be Red or Blue, got %q",
			ErrInvalidStartingPosition,
			position.CurrentTurn,
		)
	}
	if err := ValidateBoardSize(position.Grid.Width(), position.Grid.Height()); err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidStartingPosition, err)
	}
	for y, row := range position.Grid {
		if len(row) != position.Grid.Width() {
			return fmt.Errorf(
				"%w: initial row %d holds %d tiles, expected %d",
				ErrInvalidStartingPosition, y, len(row), position.Grid.Width(),
			)
		}
		for x, tile := range row {
			if tile.X != x || tile.Y != y {
				return fmt.Errorf(
					"%w: initial tile (%d, %d) carries coordinates (%d, %d)",
					ErrInvalidStartingPosition, x, y, tile.X, tile.Y,
				)
			}
			switch tile.Occupant {
			case Empty:
				if tile.OccupantOwner != Neutral {
					return fmt.Errorf(
						"%w: empty initial tile (%d, %d) has occupant owner %q",
						ErrInvalidStartingPosition, x, y, tile.OccupantOwner,
					)
				}
			case Rock, Paper, Scissors:
				if tile.OccupantOwner != Red && tile.OccupantOwner != Blue {
					return fmt.Errorf(
						"%w: occupied initial tile (%d, %d) has owner %q",
						ErrInvalidStartingPosition, x, y, tile.OccupantOwner,
					)
				}
			default:
				return fmt.Errorf(
					"%w: initial tile (%d, %d) has piece %q",
					ErrInvalidStartingPosition, x, y, tile.Occupant,
				)
			}
			if tile.OwnerColor != Neutral && tile.OwnerColor != Red && tile.OwnerColor != Blue {
				return fmt.Errorf(
					"%w: initial tile (%d, %d) has territory owner %q",
					ErrInvalidStartingPosition, x, y, tile.OwnerColor,
				)
			}
		}
	}
	return nil
}

// Record is a complete, self-contained game. Everything needed to rebuild the
// game is here: the mode and the exact board it started from, the time
// control, the players, and the ordered event log. Final is what a replay of
// Events must produce.
type Record struct {
	GameID          string           `json:"gameId"`
	Mode            ModeDefinition   `json:"mode"`
	TimeControl     TimeControl      `json:"timeControl"`
	RedPlayer       PlayerProfile    `json:"redPlayer"`
	BluePlayer      PlayerProfile    `json:"bluePlayer"`
	StartedAtUnixMs int64            `json:"startedAtUnixMs"`
	InitialPosition *InitialPosition `json:"initialPosition,omitempty"`
	Events          []Event          `json:"events"`
	Final           GameState        `json:"final"`
}

// StartingPosition is the board the game was actually played from, which is
// the mode's layout at the time it was played rather than whatever the mode
// defines today. Replaying an old record therefore survives a mode redesign.
func (record Record) StartingPosition() StartingPosition {
	return record.Mode.StartingPosition
}

// PlyCount is the number of moves played.
func (record Record) PlyCount() int {
	count := 0
	for _, event := range record.Events {
		if event.Kind == EventMove {
			count++
		}
	}
	return count
}

// Moves returns only the move events, in order.
func (record Record) Moves() []Event {
	moves := make([]Event, 0, len(record.Events))
	for _, event := range record.Events {
		if event.Kind == EventMove {
			moves = append(moves, event)
		}
	}
	return moves
}

// Record snapshots the game as an archivable record.
func (game *Game) Record() Record {
	game.mu.Lock()
	defer game.mu.Unlock()
	// Reading the clock can flag a player, which appends the ending, so the
	// event log is copied only after time has been brought up to date.
	game.updateClockLocked(game.now())
	events := make([]Event, len(game.events))
	copy(events, game.events)
	var initialPosition *InitialPosition
	if game.initialPosition != nil {
		copied := *game.initialPosition
		initialPosition = &copied
	}
	return Record{
		GameID:          game.state.GameID,
		Mode:            game.state.Mode,
		TimeControl:     game.state.TimeControl,
		RedPlayer:       game.state.RedPlayer,
		BluePlayer:      game.state.BluePlayer,
		StartedAtUnixMs: game.startedAt.UnixMilli(),
		InitialPosition: initialPosition,
		Events:          events,
		Final:           game.state,
	}
}

// StartedAt is the moment the game's first clock started.
func (game *Game) StartedAt() time.Time {
	game.mu.RLock()
	defer game.mu.RUnlock()
	return game.startedAt
}

func (game *Game) recordEventLocked(event Event) {
	event.Ply = game.plyCount
	event.ElapsedMs = game.pendingElapsedMs
	event.RedRemainingMs = game.state.Clock.RedRemainingMs
	event.BlueRemainingMs = game.state.Clock.BlueRemainingMs
	game.pendingElapsedMs = 0
	game.events = append(game.events, event)
}

func (game *Game) recordMoveLocked(player PlayerColor, from, to Position, moved, captured Piece) {
	game.plyCount++
	game.recordOpeningMoveLocked(from, to)
	game.recordEventLocked(Event{
		Kind:     EventMove,
		Player:   player,
		From:     from,
		To:       to,
		Piece:    moved,
		Captured: captured,
	})
}

// recordEndLocked appends the ending exactly once, whoever noticed it. A mode
// that finishes a game inside its own Move, an adjudicated draw, a
// resignation, and a flag fall all arrive here.
func (game *Game) recordEndLocked(actor PlayerColor) {
	if game.state.Status != Finished || game.endRecorded {
		return
	}
	game.endRecorded = true
	game.recordEventLocked(Event{
		Kind:      EventGameEnd,
		Player:    actor,
		Winner:    game.state.Winner,
		EndReason: game.state.EndReason,
	})
}

// resetBoard replaces the board a mode built with an explicit layout. Replay
// and custom challenges use it to preserve the exact board they began from.
func resetBoard(state *GameState, position StartingPosition) {
	state.Grid = NewGrid(position.Width(), position.Height())
	position.apply(state)
}

// Replay rebuilds a Game from a record using the default mode registry.
func Replay(record Record) (*Game, error) {
	return ReplayWithRegistry(DefaultModeRegistry, record)
}

// ReplayWithRegistry rebuilds a Game by replaying every recorded event through
// the real mode rules on a synthetic clock. It fails if any recorded move is
// illegal or any recorded ending does not follow from the position, so a
// successful replay is proof the record describes exactly one game.
func ReplayWithRegistry(registry *ModeRegistry, record Record) (*Game, error) {
	startingPosition := record.StartingPosition()
	if err := startingPosition.Validate(); err != nil {
		return nil, fmt.Errorf("replay game %s: %w", record.GameID, err)
	}
	if record.InitialPosition != nil {
		if err := record.InitialPosition.Validate(); err != nil {
			return nil, fmt.Errorf("replay game %s: %w", record.GameID, err)
		}
	}
	clock := time.UnixMilli(record.StartedAtUnixMs).UTC()
	replayed, err := newGame(
		registry,
		record.GameID,
		record.Mode.ID,
		record.RedPlayer,
		record.BluePlayer,
		record.TimeControl,
		gameOptions{
			now:              func() time.Time { return clock },
			startingPosition: &startingPosition,
			initialPosition:  record.InitialPosition,
		},
	)
	if err != nil {
		return nil, fmt.Errorf("replay game %s: %w", record.GameID, err)
	}
	for index, event := range record.Events {
		clock = clock.Add(time.Duration(event.ElapsedMs) * time.Millisecond)
		if err := replayed.applyRecordedEvent(event); err != nil {
			return nil, fmt.Errorf(
				"replay game %s: event %d (%s): %w",
				record.GameID, index, event.Kind, err,
			)
		}
	}
	return replayed, nil
}

func (game *Game) applyRecordedEvent(event Event) error {
	var err error
	switch event.Kind {
	case EventMove:
		_, err = game.Move(event.Player, event.From, event.To)
	case EventDrawOffer:
		_, err = game.OfferDraw(event.Player)
	case EventDrawDecline:
		_, err = game.DeclineDraw(event.Player)
	case EventTimeOffer:
		_, err = game.OfferTimeExtension(event.Player)
	case EventTimeDecline:
		_, err = game.DeclineTimeExtension(event.Player)
	case EventTimeAccept:
		_, err = game.AcceptTimeExtension(event.Player)
	case EventGameEnd:
		return game.applyRecordedEnd(event)
	default:
		return fmt.Errorf("unknown event kind %q", event.Kind)
	}
	return err
}

// applyRecordedEnd reproduces an ending and then insists the engine agrees
// with it. Only the three endings a player declares are replayed as actions;
// every other ending is adjudicated by the rules or the clock, so replay just
// advances time and checks the result it was told to expect.
func (game *Game) applyRecordedEnd(event Event) error {
	var err error
	switch event.EndReason {
	case EndReasonResignation:
		_, err = game.Resign(event.Player)
	case EndReasonDrawAgreement:
		_, err = game.AcceptDraw(event.Player)
	case EndReasonAbandonment:
		_, err = game.Abandon(event.Player)
	default:
		game.mu.RLock()
		now := game.now()
		game.mu.RUnlock()
		_, _ = game.Tick(now)
	}
	if err != nil {
		return err
	}
	state := game.Snapshot()
	if state.Status != Finished {
		return fmt.Errorf(
			"%w: expected the game to end with %q, but it is still in progress",
			ErrRecordMismatch, event.EndReason,
		)
	}
	if state.EndReason != event.EndReason {
		return fmt.Errorf(
			"%w: recorded end reason %q, replay produced %q",
			ErrRecordMismatch, event.EndReason, state.EndReason,
		)
	}
	if state.Winner != event.Winner {
		return fmt.Errorf(
			"%w: recorded winner %q, replay produced %q",
			ErrRecordMismatch, event.Winner, state.Winner,
		)
	}
	return nil
}

// Verify replays a record and confirms it reproduces its own final position,
// clocks included. A record that verifies describes one game and no other.
func Verify(record Record) error {
	return VerifyWithRegistry(DefaultModeRegistry, record)
}

func VerifyWithRegistry(registry *ModeRegistry, record Record) error {
	replayed, err := ReplayWithRegistry(registry, record)
	if err != nil {
		return err
	}
	return compareFinalStates(record.GameID, record.Final, replayed.Snapshot())
}

// compareFinalStates ignores Clock.UpdatedAtUnixMs alone: it is the wall-clock
// instant of the last clock read, not a property of the game.
func compareFinalStates(gameID string, recorded, replayed GameState) error {
	for _, difference := range []struct {
		field    string
		recorded any
		replayed any
		equal    bool
	}{
		{"grid", "", "", recorded.Grid.Equal(replayed.Grid)},
		{"currentTurn", recorded.CurrentTurn, replayed.CurrentTurn, recorded.CurrentTurn == replayed.CurrentTurn},
		{"status", recorded.Status, replayed.Status, recorded.Status == replayed.Status},
		{"winner", recorded.Winner, replayed.Winner, recorded.Winner == replayed.Winner},
		{"endReason", recorded.EndReason, replayed.EndReason, recorded.EndReason == replayed.EndReason},
		{"moveNumber", recorded.MoveNumber, replayed.MoveNumber, recorded.MoveNumber == replayed.MoveNumber},
		{"clock.redRemainingMs", recorded.Clock.RedRemainingMs, replayed.Clock.RedRemainingMs, recorded.Clock.RedRemainingMs == replayed.Clock.RedRemainingMs},
		{"clock.blueRemainingMs", recorded.Clock.BlueRemainingMs, replayed.Clock.BlueRemainingMs, recorded.Clock.BlueRemainingMs == replayed.Clock.BlueRemainingMs},
		{"clock.activeColor", recorded.Clock.ActiveColor, replayed.Clock.ActiveColor, recorded.Clock.ActiveColor == replayed.Clock.ActiveColor},
	} {
		if difference.equal {
			continue
		}
		if difference.field == "grid" {
			return fmt.Errorf("%w: game %s: final board differs", ErrRecordMismatch, gameID)
		}
		return fmt.Errorf(
			"%w: game %s: %s recorded as %v, replayed as %v",
			ErrRecordMismatch, gameID, difference.field, difference.recorded, difference.replayed,
		)
	}
	return nil
}
