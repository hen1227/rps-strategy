package game

// BoardSize is the side of the standard board, and the size of every mode.
// It is still a default rather than a rule — ValidateBoardSize accepts other
// rectangles — so nothing may bound a coordinate against this. Use
// Grid.Contains.
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

// FirstToMove is the side that opens a game, and so the side that is written
// like White: it takes the "1." in a PGN, it is drawn at the bottom of the
// board for a spectator, and it is the seat matchmaking hands to the player who
// asked for the game.
//
// Named rather than spelled Blue at each of those places because they are all
// the same fact, and a game that seated its opener at the top of the board or
// numbered its moves from the other colour would be three separate bugs.
const FirstToMove = Blue

// ModeID is deliberately opaque to the engine and matchmaking layers.
// A newly registered GameMode can use any stable, unique ID.
type ModeID string

const (
	ModeTotalWar     ModeID = "V5"
	ModeInfiltration ModeID = "V3"
	ModeIntransitive ModeID = "V6"
)

type ModeFeature string

const (
	FeatureTerritory ModeFeature = "territory"
	// FeatureNoRepetitionDraw removes the engine's threefold-repetition draw
	// for a mode that does not want one. The same rule RuleFlags lets a single
	// game switch off, declared by the mode instead.
	//
	// No built-in mode declares it, and none needs to: RepetitionDrawEnabled is
	// off, so no mode has the draw to remove. Intransitive used to declare it,
	// when the rule was on elsewhere -- a race for one tile reads a repeated
	// position as a defensive resource rather than half a point.
	//
	// Kept because it is still the door a mode declares the rule through, and
	// because it is the answer that travels to the client in the catalogue.
	// What keeps a game finite is EndReasonNoCapture, which no mode and no rule
	// flag can take away.
	FeatureNoRepetitionDraw ModeFeature = "no_repetition_draw"
	// FeatureStalemateLoses turns the engine's stalemate draw into a loss for
	// the side that cannot move.
	//
	// A mode-level answer to the same position, because "no legal move" means
	// different things in different rule sets: in a mode decided by what is
	// left on the board, being unable to move is nobody's fault, and in a race
	// it is a blockade the stuck side walked into.
	FeatureStalemateLoses ModeFeature = "stalemate_loses"
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
	// Symmetries are the colour-preserving relabellings of the board this mode
	// is unchanged by, and so the ones under which two positions are the same
	// position. Empty means "none known", which is the safe answer: nothing is
	// folded and every board counts for itself.
	//
	// Declared rather than derived because the answer is half layout and half
	// win condition. Registration checks the layout half against the symmetry's
	// own definition and refuses a mode that claims one it does not have; the
	// win-condition half is Go, and TestBuiltInSymmetriesPlayTheSameGame is
	// what holds it honest. See symmetry.go.
	Symmetries []BoardSymmetry `json:"symmetries,omitempty"`
	// RulesPublished is the day this mode's rules last changed, as YYYY-MM-DD.
	//
	// Here because an engine cannot notice. A person reads a rules page and a
	// changelog; a program plays whatever it was written against, and a board
	// that flipped or a win condition that moved does not read as a rule change
	// from inside a search — it reads as a lost game. So the date travels to
	// the bot client, which prints it on every connect and says so when it is
	// not the one that machine last saw. See bot_ready in bot_client.go.
	//
	// Per mode rather than one number for the server, so that changing what it
	// takes to win Intransitive does not tell every Total War author to go and
	// re-read something that did not move.
	RulesPublished string `json:"rulesPublished,omitempty"`
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
	EndReasonCorner        GameEndReason = "corner"
	EndReasonTimeout       GameEndReason = "timeout"
	EndReasonResignation   GameEndReason = "resignation"
	EndReasonDrawAgreement GameEndReason = "draw_agreement"
	EndReasonRepetition    GameEndReason = "repetition"
	EndReasonStalemate     GameEndReason = "stalemate"
	EndReasonAbandonment   GameEndReason = "abandonment"
	// EndReasonAdjudication is a result declared from outside the game: a host
	// stopping a match. Its own reason rather than borrowing resignation or
	// abandonment, because neither is true — nobody resigned and nobody left —
	// and the archive should say what actually happened to a game somebody
	// looks up in six months.
	EndReasonAdjudication GameEndReason = "adjudication"
	// EndReasonNoCapture is the engine's draw for a game that has stopped
	// getting anywhere: QuietPlyLimit plies in a row with nothing taken, which
	// is a hundred moves from each side.
	//
	// The other bound on a game's length, alongside repetition. Repetition
	// catches a position that comes back; this catches an army that shuffles
	// around the board without ever repeating one. Every mode has it and no
	// mode or rule flag can remove it, because "this game is over and neither
	// side will admit it" is not a rule a mode gets an opinion about.
	EndReasonNoCapture GameEndReason = "no_capture"
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
