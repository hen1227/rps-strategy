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
	if (player == Red && to.Y == 0) || (player == Blue && to.Y == BoardSize-1) {
		mode.rules.finish(state, player, EndReasonInfiltration)
	} else {
		mode.rules.passTurn(state, player)
	}
	return nil
}

func init() {
	DefaultModeRegistry.MustRegister(func() GameMode { return &InfiltrationMode{} })
}
