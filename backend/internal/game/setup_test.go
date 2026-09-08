package game

import (
	"errors"
	"testing"
)

func totalWarDefinition(t *testing.T) ModeDefinition {
	t.Helper()
	mode, err := DefaultModeRegistry.New(ModeTotalWar)
	if err != nil {
		t.Fatal(err)
	}
	return mode.Definition()
}

// The invariant the whole design leans on: a client that sends nothing is
// asking for a normal rated game.
func TestZeroSetupNormalizesToTheStandardGame(t *testing.T) {
	definition := totalWarDefinition(t)
	setup := GameSetup{}.Normalize(definition)

	if setup != StandardSetup(definition) {
		t.Fatalf("the zero setup is not the standard game: %#v", setup)
	}
	if !setup.IsStandard(definition) || !setup.Ranked() {
		t.Fatalf("expected a standard rated game, got %#v", setup)
	}
	if !setup.Rules.IsStandard() {
		t.Fatalf("expected normal rules, got %#v", setup.Rules)
	}
	if err := setup.Validate(); err != nil {
		t.Fatalf("the standard game must be a valid one: %v", err)
	}
}

// An empty board is how a client says "whatever the mode uses". Without this,
// two setups describing the same opening would compare unequal and never pair.
func TestAnEmptyPositionMeansTheModesOwn(t *testing.T) {
	definition := totalWarDefinition(t)
	setup := GameSetup{ModeID: ModeTotalWar, Casual: true}.Normalize(definition)

	if setup.StartingPosition != definition.StartingPosition {
		t.Fatalf("expected the mode's opening, got %#v", setup.StartingPosition)
	}
	if setup.HasCustomPosition(definition) {
		t.Fatal("the mode's own opening is not a custom position")
	}
}

func TestEachCustomizationStopsASetupBeingStandard(t *testing.T) {
	definition := totalWarDefinition(t)
	empty := MustStartingPosition(
		".........", ".........", "....R....", ".........", ".........",
		".........", "....r....", ".........", ".........",
	)
	edits := map[string]GameSetup{
		"clock":    {TimeControl: TimeControl{InitialTimeMs: 60_000, IncrementMs: 1_000}},
		"board":    {StartingPosition: empty},
		"casual":   {Casual: true},
		"seat":     {PreferredColor: Red},
		"rule off": {Rules: RuleFlags{NoDrawOffers: true}},
	}
	for name, edit := range edits {
		t.Run(name, func(t *testing.T) {
			edit.ModeID = ModeTotalWar
			setup := edit.Normalize(definition)
			if setup.IsStandard(definition) {
				t.Fatalf("%s should not read as the standard game: %#v", name, setup)
			}
			if err := setup.Validate(); err != nil {
				t.Fatalf("%s should still be a playable game: %v", name, err)
			}
		})
	}
}

func TestSetupsFitOnlyWhenTheGameIsTheSame(t *testing.T) {
	definition := totalWarDefinition(t)
	standard := StandardSetup(definition)

	if !standard.Fits(standard) {
		t.Fatal("a setup must fit itself")
	}
	casual := standard
	casual.Casual = true
	if standard.Fits(casual) {
		t.Fatal("a rated game and a casual one are different games")
	}
	// A seat is the one difference two people can have and still be offering
	// each other the same game.
	wantsRed, wantsBlue := standard, standard
	wantsRed.PreferredColor, wantsBlue.PreferredColor = Red, Blue
	if !wantsRed.Fits(wantsBlue) || !wantsRed.Fits(standard) {
		t.Fatal("compatible seat preferences must still fit")
	}
	if wantsRed.Fits(wantsRed) {
		t.Fatal("two seeks wanting the same seat cannot be seated together")
	}
}

func TestSetupValidationRejectsNonsense(t *testing.T) {
	definition := totalWarDefinition(t)
	base := StandardSetup(definition)

	badSeat := base
	badSeat.PreferredColor = PlayerColor("Green")
	if err := badSeat.Validate(); !errors.Is(err, ErrInvalidSetup) {
		t.Fatalf("expected a setup error for an unknown seat, got %v", err)
	}
	badClock := base
	badClock.TimeControl = TimeControl{InitialTimeMs: -1}
	if err := badClock.Validate(); !errors.Is(err, ErrInvalidTimeControl) {
		t.Fatalf("expected a time control error, got %v", err)
	}
}

func setupGame(t *testing.T, rules RuleFlags) *Game {
	t.Helper()
	created, err := NewGameFromSetup(
		DefaultModeRegistry,
		"rules-test",
		GameSetup{ModeID: ModeTotalWar, Rules: rules},
		PlayerProfile{UserID: "red"},
		PlayerProfile{UserID: "blue"},
	)
	if err != nil {
		t.Fatal(err)
	}
	return created
}

// A setup-built game gets the mode's own board without the caller looking it up.
func TestNewGameFromSetupFillsInTheModesBoard(t *testing.T) {
	definition := totalWarDefinition(t)
	created := setupGame(t, RuleFlags{})
	state := created.Snapshot()

	if state.Mode.StartingPosition != definition.StartingPosition {
		t.Fatalf("expected the mode's opening, got %#v", state.Mode.StartingPosition)
	}
	if !state.Rules.IsStandard() {
		t.Fatalf("expected normal rules on the state, got %#v", state.Rules)
	}
}

// The shuffle that is a draw in a normal game is just play with the rule off.
func TestRepetitionDrawCanBeSwitchedOff(t *testing.T) {
	cycle := []struct {
		player   PlayerColor
		from, to Position
	}{
		{Blue, Position{X: 3, Y: 2}, Position{X: 2, Y: 3}},
		{Red, Position{X: 3, Y: 6}, Position{X: 2, Y: 5}},
		{Blue, Position{X: 2, Y: 3}, Position{X: 3, Y: 2}},
		{Red, Position{X: 2, Y: 5}, Position{X: 3, Y: 6}},
	}
	created := setupGame(t, RuleFlags{NoRepetitionDraw: true})
	var state GameState
	for repeat := 0; repeat < 4; repeat++ {
		for _, move := range cycle {
			var err error
			state, err = created.Move(move.player, move.from, move.to)
			if err != nil {
				t.Fatalf("move %s %v-%v failed: %v", move.player, move.from, move.to, err)
			}
		}
	}
	if state.Status != InProgress {
		t.Fatalf("expected the game to continue, got %#v", state)
	}
}

func TestDrawOffersCanBeSwitchedOff(t *testing.T) {
	created := setupGame(t, RuleFlags{NoDrawOffers: true})

	if _, err := created.OfferDraw(Red); !errors.Is(err, ErrDrawOffersDisabled) {
		t.Fatalf("expected the offer to be refused, got %v", err)
	}
	if state := created.Snapshot(); state.DrawOfferedBy != "" {
		t.Fatalf("a refused offer must leave no trace, got %#v", state)
	}
	// The engine's own draws are untouched: only agreeing one is gone.
	if _, err := created.AcceptDraw(Blue); !errors.Is(err, ErrNoDrawOffer) {
		t.Fatalf("expected nothing to accept, got %v", err)
	}
}

func TestTimeExtensionsCanBeSwitchedOff(t *testing.T) {
	created := setupGame(t, RuleFlags{NoTimeExtensions: true})

	if _, err := created.OfferTimeExtension(Blue); !errors.Is(err, ErrTimeExtensionsDisabled) {
		t.Fatalf("expected the request to be refused, got %v", err)
	}
	if state := created.Snapshot(); state.TimeOfferedBy != "" {
		t.Fatalf("a refused request must leave no trace, got %#v", state)
	}
}
