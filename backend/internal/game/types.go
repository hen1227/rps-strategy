package game

import "encoding/json"

// BoardSize is the side of the standard board, and the size of every built-in
// mode. It is a default rather than a rule: a spec-defined mode may be any
// rectangle ValidateBoardSize accepts, so nothing may bound a coordinate
// against this. Use Grid.Contains.
const BoardSize = 9

const (
	// MinBoardSide is a board with somewhere to move.
	MinBoardSide = 3
	// MaxBoardSide is 26 because a file is one letter, a to z, in every
	// notation this project writes.
	MaxBoardSide = 26
	// MaxBoardTiles caps how much work one position can be, for the search and
	// the self-play the Lab runs over a mode being designed.
	MaxBoardTiles = 361
)

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
	ModeTotalWar     ModeID = "V5"
	ModeInfiltration ModeID = "V3"
)

type ModeFeature string

const (
	FeatureTerritory ModeFeature = "territory"
)

// ModeOrigin separates the modes this build ships from the modes people wrote.
//
// It exists because the lobby catalogue cannot be everything: the built-in modes
// are a handful and the community's are unbounded, and broadcasting the second
// set to every socket on connect would grow without limit. Catalogue callers ask
// for builtins; the library is a paged route.
type ModeOrigin string

const (
	OriginBuiltin   ModeOrigin = "builtin"
	OriginCommunity ModeOrigin = "community"
)

// ModeDefinition is shared with the frontend, allowing the lobby to render
// registered modes without duplicating a hard-coded mode list. Playable
// separates the modes that accept new matches from the ones that remain
// registered only for analysis and replay of existing games.
type ModeDefinition struct {
	ID               ModeID           `json:"id"`
	ShortCode        string           `json:"shortCode"`
	Name             string           `json:"name"`
	Description      string           `json:"description"`
	Objective        string           `json:"objective"`
	DisplayOrder     int              `json:"displayOrder"`
	Playable         bool             `json:"playable"`
	Features         []ModeFeature    `json:"features"`
	StartingPosition StartingPosition `json:"startingPosition"`
	// Spec is the rules, for a mode nobody wrote code for.
	//
	// Held as raw JSON on purpose. This package must not know what a rule spec
	// is — `internal/game/spec` reads it and imports this package, and the
	// dependency has to stay one-way — and carrying it opaquely is enough,
	// because the only thing done with it here is handing it to whoever asked
	// for the game. That is what lets a client who has never heard of a mode
	// play it: the rules arrive inside the position.
	//
	// Absent for the built-in modes, whose rules are hand-written on both sides.
	Spec json.RawMessage `json:"spec,omitempty"`
	// Origin is where the mode came from. Absent means built-in.
	Origin ModeOrigin `json:"origin,omitempty"`
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
	EndReasonRepetition    GameEndReason = "repetition"
	EndReasonStalemate     GameEndReason = "stalemate"
	EndReasonAbandonment   GameEndReason = "abandonment"
	// Kept for records written before custom move caps were retired.
	EndReasonMoveLimit GameEndReason = "move_limit"
)

type PlayerProfile struct {
	UserID   string `json:"userId"`
	Username string `json:"username"`
	Discord  string `json:"discord,omitempty"`
	// Title is the three-letter tag worn in front of the name — "GM", "DEV" —
	// and empty for most players. It travels with the profile rather than being
	// looked up per screen because the profile is already what every board,
	// lobby row, and live-game listing renders a player from; a second lookup
	// would be a second answer to "who is this".
	//
	// A copy of accounts.title taken when the player connected, so a title
	// chosen mid-game appears when the socket next reconnects rather than
	// halfway through a move. See persistence/titles.go.
	Title string `json:"title,omitempty"`
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
	GameID string `json:"gameId"`
	// Grid is shared, not copied: see the note at the top of board.go. A
	// GameState handed out beyond the lock that guards it needs Grid.Clone.
	Grid        Grid           `json:"grid"`
	Mode        ModeDefinition `json:"mode"`
	TimeControl TimeControl    `json:"timeControl"`
	// Rules are the optional rules this game switched off, if any. The zero
	// value is a normal game, so a client can render deviations and nothing
	// else.
	Rules           RuleFlags     `json:"rules"`
	Clock           ClockState    `json:"clock"`
	CurrentTurn     PlayerColor   `json:"currentTurn"`
	Status          GameStatus    `json:"status"`
	Winner          PlayerColor   `json:"winner"`
	EndReason       GameEndReason `json:"endReason,omitempty"`
	DrawOfferedBy   PlayerColor   `json:"drawOfferedBy,omitempty"`
	DrawOfferUsedBy PlayerColor   `json:"drawOfferUsedBy,omitempty"`
	// A time extension follows the same offer/accept/decline lifecycle as a
	// draw, so both players must agree before either clock grows.
	TimeOfferedBy   PlayerColor   `json:"timeOfferedBy,omitempty"`
	TimeOfferUsedBy PlayerColor   `json:"timeOfferUsedBy,omitempty"`
	MoveNumber      int           `json:"moveNumber"`
	RedPlayer       PlayerProfile `json:"redPlayer"`
	BluePlayer      PlayerProfile `json:"bluePlayer"`
	// OpeningLine is the game so far in the opening book's own notation --
	// `d8-c7`, no piece letter and no capture marker -- so a client can look
	// the position up in the book without replaying the board itself.
	//
	// Present only while a game is still inside the opening (see
	// OpeningLineLimit) and only for games that began from the mode's own
	// starting position, because a line means nothing measured from any other
	// board. Absent, therefore, is a complete answer: this game has no opening
	// to name.
	OpeningLine []string `json:"openingLine,omitempty"`
}
