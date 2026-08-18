package game

const BoardSize = 9

type Piece string

const (
	Empty    Piece = "Empty"
	Rock     Piece = "Rock"
	Paper    Piece = "Paper"
	Scissors Piece = "Scissors"
)

type PlayerColor string

const (
	Neutral PlayerColor = "Neutral"
	Red     PlayerColor = "Red"
	Blue    PlayerColor = "Blue"
)

// ModeID is deliberately opaque to the engine and matchmaking layers.
// A newly registered GameMode can use any stable, unique ID.
type ModeID string

const (
	ModeAnnihilation ModeID = "V1"
	ModeTotalWar     ModeID = "V5"
	ModeInfiltration ModeID = "V3"
)

type ModeFeature string

const (
	FeatureTerritory ModeFeature = "territory"
)

// ModeDefinition is shared with the frontend, allowing the lobby to render
// registered modes without duplicating a hard-coded mode list.
type ModeDefinition struct {
	ID               ModeID           `json:"id"`
	ShortCode        string           `json:"shortCode"`
	Name             string           `json:"name"`
	Description      string           `json:"description"`
	Objective        string           `json:"objective"`
	DisplayOrder     int              `json:"displayOrder"`
	Features         []ModeFeature    `json:"features"`
	StartingPosition StartingPosition `json:"startingPosition"`
}

func (definition ModeDefinition) HasFeature(feature ModeFeature) bool {
	for _, candidate := range definition.Features {
		if candidate == feature {
			return true
		}
	}
	return false
}

type GameStatus string

const (
	InProgress GameStatus = "InProgress"
	Finished   GameStatus = "Finished"
)

type GameEndReason string

const (
	EndReasonGameRule      GameEndReason = "game_rule"
	EndReasonAnnihilation  GameEndReason = "annihilation"
	EndReasonTerritory     GameEndReason = "territory"
	EndReasonInfiltration  GameEndReason = "infiltration"
	EndReasonTimeout       GameEndReason = "timeout"
	EndReasonResignation   GameEndReason = "resignation"
	EndReasonDrawAgreement GameEndReason = "draw_agreement"
	EndReasonAbandonment   GameEndReason = "abandonment"
)

type PlayerProfile struct {
	UserID   string `json:"userId"`
	Username string `json:"username"`
}

type Tile struct {
	X             int         `json:"x"`
	Y             int         `json:"y"`
	Occupant      Piece       `json:"occupant"`
	OccupantOwner PlayerColor `json:"occupantOwner"`
	OwnerColor    PlayerColor `json:"ownerColor"`
}

type Position struct {
	X int `json:"x"`
	Y int `json:"y"`
}

type GameState struct {
	GameID          string                     `json:"gameId"`
	Grid            [BoardSize][BoardSize]Tile `json:"grid"`
	Mode            ModeDefinition             `json:"mode"`
	TimeControl     TimeControl                `json:"timeControl"`
	Clock           ClockState                 `json:"clock"`
	CurrentTurn     PlayerColor                `json:"currentTurn"`
	Status          GameStatus                 `json:"status"`
	Winner          PlayerColor                `json:"winner"`
	EndReason       GameEndReason              `json:"endReason,omitempty"`
	DrawOfferedBy   PlayerColor                `json:"drawOfferedBy,omitempty"`
	DrawOfferUsedBy PlayerColor                `json:"drawOfferUsedBy,omitempty"`
	MoveNumber      int                        `json:"moveNumber"`
	RedPlayer       PlayerProfile              `json:"redPlayer"`
	BluePlayer      PlayerProfile              `json:"bluePlayer"`
}
