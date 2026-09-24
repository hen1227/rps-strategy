package game

type InfiltrationMode struct {
	rules standardRPSRules
}

func (mode *InfiltrationMode) Definition() ModeDefinition {
	return ModeDefinition{
		ID:               ModeInfiltration,
		ShortCode:        "V3",
		Name:             "Infiltration",
		Description:      "Reach their boundary.",
		Objective:        "Move any piece onto the opponent's home boundary.",
		DisplayOrder:     3,
		Playable:         true,
		Features:         []ModeFeature{},
		StartingPosition: infiltrationStartingPosition,
		Symmetries:       []BoardSymmetry{SymmetryMirrorFiles},
		RulesPublished:   rulesPublished,
	}
}

func (mode *InfiltrationMode) Initialize(state *GameState) {
	mode.rules.initializeBoard(state, infiltrationStartingPosition)
}

func (mode *InfiltrationMode) ValidMoves(
	state GameState,
	player PlayerColor,
	from Position,
) []Position {
	return mode.rules.validMoves(state, player, from)
}

func (mode *InfiltrationMode) Move(
	state *GameState,
	player PlayerColor,
	from Position,
	to Position,
) error {
	if err := mode.rules.movePiece(state, player, from, to); err != nil {
		return err
	}
	if to.Y == goalRank(state.Grid, player) {
		mode.rules.finish(state, player, EndReasonInfiltration)
	} else {
		mode.rules.passTurn(state, player)
	}
	return nil
}

// goalRank is the rank a side wins by reaching: the opponent's home boundary.
//
// Blue opens on rank 1 and Red on the last one, so Red runs at rank 1 and Blue
// at the last -- the same way round as Intransitive's goal corners, which are
// one end of these two ranks. See goalCorner in mode_intransitive.go.
//
// Taken off the grid rather than from BoardSize, for the reason board.go gives:
// Contains is the only bounds check here, and a comparison against the constant
// is wrong on any board that is not nine ranks tall. ValidateForMode keeps a
// live game on this mode's own shape, so the constant was right for every game
// this server plays -- but a record is replayed from the board its own FEN
// describes, and the review screen replays records people paste. The frontend's
// copy of this rule already measured from the board it was handed
// (`goalOwnerAt` in `frontend/src/engine/goals.ts`), so the constant was also
// the one place the two disagreed.
func goalRank(grid Grid, player PlayerColor) int {
	if player == Red {
		return 0
	}
	return grid.Height() - 1
}

func init() {
	DefaultModeRegistry.MustRegister(func() GameMode { return &InfiltrationMode{} })
}
