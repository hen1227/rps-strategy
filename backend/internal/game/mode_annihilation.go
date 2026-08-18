package game

type AnnihilationMode struct {
	rules standardRPSRules
}

func (mode *AnnihilationMode) Definition() ModeDefinition {
	return ModeDefinition{
		ID:               ModeAnnihilation,
		ShortCode:        "V1",
		Name:             "Annihilation",
		Description:      "Leave no survivors.",
		Objective:        "Capture every opposing piece.",
		DisplayOrder:     1,
		Features:         []ModeFeature{},
		StartingPosition: annihilationStartingPosition,
	}
}

func (mode *AnnihilationMode) Initialize(state *GameState) {
	mode.rules.initializeBoard(state, annihilationStartingPosition)
}

func (mode *AnnihilationMode) ValidMoves(
	state GameState,
	player PlayerColor,
	from Position,
) []Position {
	return mode.rules.validMoves(state, player, from)
}

func (mode *AnnihilationMode) Move(
	state *GameState,
	player PlayerColor,
	from Position,
	to Position,
) error {
	if err := mode.rules.movePiece(state, player, from, to); err != nil {
		return err
	}
	if countPieces(state.Grid, OtherColor(player)) == 0 {
		mode.rules.finish(state, player, EndReasonAnnihilation)
	} else {
		mode.rules.passTurn(state, player)
	}
	return nil
}

func init() {
	DefaultModeRegistry.MustRegister(func() GameMode { return &AnnihilationMode{} })
}
