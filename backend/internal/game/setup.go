package game

import (
	"errors"
	"fmt"
)

var (
	ErrInvalidSetup           = errors.New("invalid game setup")
	ErrDrawOffersDisabled     = errors.New("draw offers are switched off in this game")
	ErrTimeExtensionsDisabled = errors.New("time extensions are switched off in this game")
)

// RuleFlags are the engine-level rules a custom game may switch off.
//
// Every field is a *deviation*, so the zero value is the standard game. That is
// deliberate and load-bearing: a client that sends nothing gets normal rules,
// `flags == RuleFlags{}` is the whole question "is anything unusual here", and
// the lobby renders one icon per non-zero field without needing to know what
// normal looks like.
type RuleFlags struct {
	// NoRepetitionDraw removes the engine's threefold-repetition draw. The
	// mode's own win conditions and the stalemate rule still apply, so this
	// does not make a game endless — it makes one where shuffling is legal
	// play rather than a way to claim half a point.
	NoRepetitionDraw bool `json:"noRepetitionDraw,omitempty"`
	// NoDrawOffers forbids agreeing a draw. Draws the engine adjudicates —
	// repetition, stalemate — are untouched.
	NoDrawOffers bool `json:"noDrawOffers,omitempty"`
	// NoTimeExtensions forbids the mutually agreed clock top-up, which turns a
	// short clock back into a real constraint.
	NoTimeExtensions bool `json:"noTimeExtensions,omitempty"`
}

// IsStandard reports whether these are the ordinary rules.
func (flags RuleFlags) IsStandard() bool { return flags == RuleFlags{} }

// GameSetup is the complete description of a game somebody wants to play: the
// mode whose rules apply, the clock, the board it starts from, which optional
// rules are on, whether it counts for ratings, and which seat its author wants.
//
// One value covers matchmaking and challenges because they are the same act.
// Joining a queue posts the mode's StandardSetup; posting a challenge posts an
// edited one; two people want the same game exactly when their setups are
// equal. Every field is comparable so that `==` can be the whole pairing rule.
//
// The zero value normalizes into the standard game, for the same reason
// RuleFlags does: a client that sends nothing asks for a normal match, and
// every field it does send is a visible deviation from one.
type GameSetup struct {
	ModeID ModeID `json:"modeId"`
	// TimeControl zero means "the default clock", filled in by Normalize.
	TimeControl TimeControl `json:"timeControl"`
	// StartingPosition is resolved rather than optional. An absent board would
	// make two setups describing the same opening compare unequal, so Normalize
	// fills it from the mode and "is this custom" becomes a comparison against
	// the mode's own opening rather than a nil check.
	StartingPosition StartingPosition `json:"startingPosition"`
	Rules            RuleFlags        `json:"rules"`
	// Casual games leave ratings alone. Stored as the deviation so that a zero
	// setup is a rated one, and kept here beside the rules because it is part
	// of what the two players agreed to: pairing must never seat a rated seek
	// against a casual one.
	Casual bool `json:"casual,omitempty"`
	// PreferredColor is the seat its author wants, or Neutral for either. The
	// one field pairing does not compare for equality — two seeks fit when both
	// preferences can be honoured, which ColorsCompatible decides.
	PreferredColor PlayerColor `json:"preferredColor,omitempty"`
}

// StandardSetup is the normal game for a mode: its own opening, the default
// clock, every optional rule at its usual setting, and rated. This is what
// matchmaking hands out and what every customization is measured against.
func StandardSetup(definition ModeDefinition) GameSetup {
	return GameSetup{
		ModeID:           definition.ID,
		TimeControl:      DefaultTimeControl(),
		StartingPosition: definition.StartingPosition,
	}
}

// Normalize fills in everything the author left out, turning a partial request
// from a client into a setup that can be compared, published, and played.
func (setup GameSetup) Normalize(definition ModeDefinition) GameSetup {
	setup.ModeID = definition.ID
	if setup.TimeControl == (TimeControl{}) {
		setup.TimeControl = DefaultTimeControl()
	}
	if setup.StartingPosition == (StartingPosition{}) {
		setup.StartingPosition = definition.StartingPosition
	}
	if setup.PreferredColor == Neutral {
		setup.PreferredColor = ""
	}
	return setup
}

// IsStandard reports whether this is the plain rated game for its mode — the
// one nobody had to configure. A setup that answers true is the queue's own
// offer, which is why posting it puts its author into matchmaking rather than
// onto the open board.
func (setup GameSetup) IsStandard(definition ModeDefinition) bool {
	return setup == StandardSetup(definition)
}

// Ranked reports whether finishing this game should move ratings.
func (setup GameSetup) Ranked() bool { return !setup.Casual }

// HasCustomPosition reports whether the board differs from the mode's opening.
func (setup GameSetup) HasCustomPosition(definition ModeDefinition) bool {
	return setup.StartingPosition != definition.StartingPosition
}

// ValidateForMode is Validate plus the two rules that need the mode: a board
// somebody drew has to be spelled in the mode's own letters, and it has to be
// the shape the mode is played on.
//
// A mode owns its board. A custom starting position is a different arrangement
// of the same squares, not a different board — every rule a mode states about a
// rank ("reach the far one to win") would mean something else on a board of
// another size, and the goal rank, the reach tool and the opening book would all
// quietly answer for the wrong shape. Only reachable since a mode stopped being
// nine by nine, which is why it is a separate method rather than part of
// Validate: Validate is also called where no definition is in hand.
func (setup GameSetup) ValidateForMode(mode GameMode) error {
	if err := setup.Validate(); err != nil {
		return err
	}
	if err := setup.StartingPosition.Validate(); err != nil {
		return err
	}
	definition := mode.Definition()
	wanted := definition.StartingPosition
	drawn := setup.StartingPosition
	if drawn.Width() != wanted.Width() || drawn.Height() != wanted.Height() {
		return fmt.Errorf(
			"%w: %s is played on a %d by %d board, not %d by %d",
			ErrInvalidSetup,
			definition.ID,
			wanted.Width(), wanted.Height(),
			drawn.Width(), drawn.Height(),
		)
	}
	return nil
}

func (setup GameSetup) Validate() error {
	if err := setup.TimeControl.Validate(); err != nil {
		return err
	}
	// Shape only here; the symbols are checked against the mode's own alphabet
	// by ValidateForMode, which is the only place the mode is in hand.
	if err := setup.StartingPosition.ValidateShape(); err != nil {
		return err
	}
	switch setup.PreferredColor {
	case "", Neutral, Red, Blue:
	default:
		return fmt.Errorf(
			"%w: preferredColor must be Red, Blue, or unset",
			ErrInvalidSetup,
		)
	}
	return nil
}

// Fits reports whether two seeks describe the same game and can be seated
// together: identical in every respect that decides how the game is played,
// and asking for seats that do not collide.
func (setup GameSetup) Fits(other GameSetup) bool {
	if !ColorsCompatible(setup.PreferredColor, other.PreferredColor) {
		return false
	}
	// Cleared rather than compared: the seat is the one thing two people may
	// disagree about and still be offering each other the same game.
	setup.PreferredColor, other.PreferredColor = "", ""
	return setup == other
}

// ColorsCompatible reports whether two seat preferences can both be honoured.
// Neutral — the ordinary case — fits anything.
func ColorsCompatible(first, second PlayerColor) bool {
	if first == Neutral || first == "" || second == Neutral || second == "" {
		return true
	}
	return first != second
}
