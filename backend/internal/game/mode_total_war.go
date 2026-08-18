package game

type TotalWarMode struct {
	rules standardRPSRules
}

func (mode *TotalWarMode) Definition() ModeDefinition {
	return ModeDefinition{
		ID:               ModeTotalWar,
		ShortCode:        "V5",
		Name:             "Total War",
		Description:      "Pieces and territory.",
		Objective:        "Annihilate the enemy or control most territory when the board is filled.",
		DisplayOrder:     2,
		Features:         []ModeFeature{FeatureTerritory},
		StartingPosition: totalWarStartingPosition,
	}
}

func (mode *TotalWarMode) Initialize(state *GameState) {
	mode.rules.initializeBoard(state, totalWarStartingPosition)
}

func (mode *TotalWarMode) ValidMoves(
	state GameState,
	player PlayerColor,
	from Position,
) []Position {
	return mode.rules.validMoves(state, player, from)
}

func (mode *TotalWarMode) Move(
	state *GameState,
	player PlayerColor,
	from Position,
	to Position,
) error {
	if err := mode.rules.movePiece(state, player, from, to); err != nil {
		return err
	}
	if state.Grid[to.Y][to.X].OwnerColor == Neutral {
		state.Grid[to.Y][to.X].OwnerColor = player
	}

	if countPieces(state.Grid, OtherColor(player)) == 0 {
		mode.rules.finish(state, player, EndReasonAnnihilation)
		return nil
	}
	redTiles, blueTiles, neutralTiles := countTerritory(state.Grid)
	if neutralTiles == 0 {
		switch {
		case redTiles > blueTiles:
			mode.rules.finish(state, Red, EndReasonTerritory)
		case blueTiles > redTiles:
			mode.rules.finish(state, Blue, EndReasonTerritory)
		default:
			mode.rules.finish(state, Neutral, EndReasonTerritory)
		}
		return nil
	}

	mode.rules.passTurn(state, player)
	return nil
}

func init() {
	DefaultModeRegistry.MustRegister(func() GameMode { return &TotalWarMode{} })
}
