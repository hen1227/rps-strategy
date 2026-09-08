package game

// Intransitive is Infiltration with the goal shrunk from a rank to a tile: the
// one corner the opponent's army started in, diagonally across the board. The
// name is the shape of the piece hierarchy — rock, paper, scissors is the
// standard example of a relation that beats around in a circle — and the
// diagonal race is what makes that circle bite, because a runner cannot pick
// which file it arrives on the way an Infiltration runner can.
//
// Everything else is the standard rule set. Only the win condition differs, so
// this mode is the same three delegating methods as the others plus one
// coordinate check.

type IntransitiveMode struct {
	rules standardRPSRules
}

func (mode *IntransitiveMode) Definition() ModeDefinition {
	return ModeDefinition{
		ID:           ModeIntransitive,
		ShortCode:    "V6",
		Name:         "Intransitive",
		Description:  "Reach their corner.",
		Objective:    "Move any piece onto the corner the opponent's army started in.",
		DisplayOrder: 1,
		Playable:     true,
		// The one rule this mode does not share with the others: a race for one
		// tile is decided by who arrives, so a side that blockades itself has
		// lost the race rather than survived it.
		//
		// It used to be two. This mode also declared FeatureNoRepetitionDraw,
		// on the same reasoning -- standing still is a defensive resource in a
		// race, not a claim to half a point. That is no longer said here
		// because it is no longer only true here: game.RepetitionDrawEnabled
		// turns the rule off for every mode, and saying it twice would leave
		// this line looking load-bearing when it is not.
		Features:         []ModeFeature{FeatureStalemateLoses},
		StartingPosition: intransitiveStartingPosition,
		Symmetries:       []BoardSymmetry{SymmetryDiagonal},
		RulesPublished:   rulesPublished,
	}
}

func (mode *IntransitiveMode) Initialize(state *GameState) {
	mode.rules.initializeBoard(state, intransitiveStartingPosition)
}

func (mode *IntransitiveMode) ValidMoves(
	state GameState,
	player PlayerColor,
	from Position,
) []Position {
	return mode.rules.validMoves(state, player, from)
}

func (mode *IntransitiveMode) Move(
	state *GameState,
	player PlayerColor,
	from Position,
	to Position,
) error {
	if err := mode.rules.movePiece(state, player, from, to); err != nil {
		return err
	}
	if to == goalCorner(state.Grid, player) {
		mode.rules.finish(state, player, EndReasonCorner)
	} else {
		mode.rules.passTurn(state, player)
	}
	return nil
}

// goalCorner is the tile a side wins by standing on: the corner diagonally
// opposite its own home.
//
// The same way round as Infiltration's goal ranks, and for the same reason.
// Blue opens on rank 1 and Red on the last one, so Red runs at rank 1 and Blue
// at the last -- Intransitive just names one end of each rank as well. Blue
// opens in the a1 corner, so that is the tile Red is running at, and Red opens
// in the far corner of its own home rank, which is Blue's.
//
// Taken off the grid rather than from BoardSize because a mode may be any
// rectangle. The frontend holds its own copy of this rule in
// `frontend/src/engine/goals.ts`, the way it holds its own copy of every other
// rule here; the two have to move together.
func goalCorner(grid Grid, player PlayerColor) Position {
	if player == Red {
		return Position{X: 0, Y: 0}
	}
	return Position{X: grid.Width() - 1, Y: grid.Height() - 1}
}

func init() {
	DefaultModeRegistry.MustRegister(func() GameMode { return &IntransitiveMode{} })
}
