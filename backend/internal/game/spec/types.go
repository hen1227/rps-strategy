// Package spec is a game mode as data.
//
// One versioned JSON document describes a whole mode — the board, the pieces,
// how they move, what happens when they meet, and how somebody wins — and
// `docs/rulespec.md` at the repository root is its reference. This package is
// the authoritative reader: `Validate` decides whether a spec somebody
// published is playable at all, and `Mode` turns one into a `game.GameMode`,
// which is the only rules contract the engine understands.
//
// There is a second reader, in the browser
// (`frontend/src/engine/spec/interpret.ts`), because an analysis board, a bot
// game and a replayed archive all need to know what a legal move is without
// asking anybody. The two are held together by a shared corpus of positions
// rather than by good intentions: a disagreement is a failing test in two
// languages, not a player being told their legal move is illegal.
//
// This package imports `game` and nothing in `game` imports it, which is what
// keeps the dependency one-way: a mode built from a spec is an ordinary
// registered mode, and the engine never learns that specs exist.
package spec

import (
	"regexp"

	"rps-strategy/backend/internal/game"
)

// Version is the rule language this build reads. A published spec is immutable
// and carries its own version, so an old mode keeps meaning what it meant.
const Version = 1

// The caps. Every one of these is also in
// `frontend/src/engine/spec/validate.ts` with the same value, and they have to
// agree: a spec the Lab accepts and the server refuses is a Lab that lies to
// its author.
//
// They are not tidiness. A spec arrives from a stranger, and these are the bound
// on how much work one published mode can make this server do.
const (
	MaxSpecBytes    = 16 * 1024
	MaxPieces       = 12
	MaxBeats        = 64
	MaxMovement     = 24
	MaxEffects      = 24
	MaxWin          = 16
	MaxDepth        = 12
	MaxOffsets      = 32
	MaxTextLength   = 400
	MaxShortCodeLen = 6
	// MaxArtRefs bounds the database work one publish can ask for: every
	// distinct picture a mode names is a row to look up and a row to pin.
	// Twelve pieces, a board and a cover is the most a legal spec can name.
	MaxArtRefs = MaxPieces + 2
)

// maxSide mirrors game.MaxBoardSide, named locally so the offset check reads as
// a bound on the language rather than on a particular board.
const maxSide = game.MaxBoardSide

// ArtRefPattern matches a reference to an uploaded picture: `img:` and the
// first 128 bits of the asset's SHA-256, lower case.
//
// The picture lives in the asset store and is fetched by id, because a spec is
// capped at MaxSpecBytes and an image is not going to fit in one. The digest
// *is* the address, which is what makes an asset immutable — the same property
// a published mode has, arrived at the same way.
//
// This is also the only thing standing between an author-written string and a
// URL path, so it is anchored at both ends and admits nothing but hex.
var ArtRefPattern = regexp.MustCompile(`^img:[0-9a-f]{32}$`)

// IsArtRef reports whether a value addresses an uploaded picture.
func IsArtRef(value string) bool { return ArtRefPattern.MatchString(value) }

// ArtDigest is the asset id inside a reference, or "" if it is not one.
func ArtDigest(value string) string {
	if !IsArtRef(value) {
		return ""
	}
	return value[len("img:"):]
}

type Board struct {
	Width  int `json:"width"`
	Height int `json:"height"`
	// Art is a picture painted under the whole board, as an ArtRef.
	Art string `json:"art,omitempty"`
}

type PieceKind struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Symbol string `json:"symbol"`
	// Art is a bundled artwork name, or an uploaded picture as an ArtRef.
	Art string `json:"art,omitempty"`
}

type Capture struct {
	Mode string `json:"mode"`
}

type Turn struct {
	MovesPerTurn *int  `json:"movesPerTurn,omitempty"`
	MayPass      *bool `json:"mayPass,omitempty"`
}

// Draw is the one draw rule a mode gets to state.
//
// Threefold repetition and the stalemate draw are deliberately absent: both are
// engine-level and identical for every mode (see backend/docs/game-modes.md), so
// a spec that claimed to change them would be making a promise Game could not
// keep. MoveLimit depends only on the move number, which is why the mode can own
// it and both readers can honour it.
type Draw struct {
	MoveLimit *int `json:"moveLimit,omitempty"`
}

// Node is one rule — a movement rule, an effect, a win condition, a predicate —
// as decoded JSON rather than as a Go type.
//
// Deliberately untyped. The rule language has about thirty tagged unions in it
// (every predicate, term, region, filter and effect), and spelling each as a Go
// struct with a custom UnmarshalJSON would be several hundred lines whose only
// job is to reject shapes `Validate` already rejects — and it would put the
// language in two places on this side alone. Walking the decoded tree instead
// keeps this package structurally parallel to the TypeScript validator, which
// is what makes the two auditable against each other.
//
// The cost is one map lookup per rule per move. The server evaluates one move at
// a time against a board of at most 361 tiles; the search that would care about
// this runs in the browser, over its own typed representation.
type Node = map[string]any

type RuleSpec struct {
	Spec             int                   `json:"spec"`
	Name             string                `json:"name"`
	ShortCode        string                `json:"shortCode"`
	Description      string                `json:"description"`
	Objective        string                `json:"objective"`
	Board            Board                 `json:"board"`
	Pieces           []PieceKind           `json:"pieces"`
	Beats            [][]string            `json:"beats"`
	StartingPosition game.StartingPosition `json:"startingPosition"`
	Turn             *Turn                 `json:"turn,omitempty"`
	Movement         []Node                `json:"movement"`
	Capture          *Capture              `json:"capture,omitempty"`
	Effects          []Node                `json:"effects,omitempty"`
	Win              []Node                `json:"win"`
	Draw             *Draw                 `json:"draw,omitempty"`
	// Cover is the picture the library card leads with, as an ArtRef.
	//
	// In the document rather than beside it, for the reason the name is: this
	// server reads a mode's name, code, description and objective out of the
	// spec because the document is what a live game carries and what a fork
	// starts from. A cover held only in the publish request would vanish the
	// first time somebody forked the mode.
	Cover string `json:"cover,omitempty"`
}

// CaptureMode is how contact resolves, with the default filled in. A spec that
// says nothing means `beats`, which is the standard game.
func (spec RuleSpec) CaptureMode() string {
	if spec.Capture == nil || spec.Capture.Mode == "" {
		return "beats"
	}
	return spec.Capture.Mode
}

// Kinds is the set of declared piece ids.
func (spec RuleSpec) Kinds() map[string]PieceKind {
	kinds := make(map[string]PieceKind, len(spec.Pieces))
	for _, piece := range spec.Pieces {
		kinds[piece.ID] = piece
	}
	return kinds
}

// Alphabet maps a layout symbol to the kind and side it means: upper case is
// Blue and lower case is Red, exactly as `game.StartingPosition` has always
// spelled the standard pieces.
//
// This is what makes an author-declared piece set work at all. The engine's own
// symbol table only knows rock, paper and scissors, so a mode with a lizard in
// it has to carry its own alphabet — and this is it.
func (spec RuleSpec) Alphabet() map[byte]struct {
	Kind  string
	Owner game.PlayerColor
} {
	alphabet := make(map[byte]struct {
		Kind  string
		Owner game.PlayerColor
	}, len(spec.Pieces)*2)
	for _, piece := range spec.Pieces {
		if len(piece.Symbol) != 1 {
			continue
		}
		upper := piece.Symbol[0]
		lower := upper + ('a' - 'A')
		alphabet[upper] = struct {
			Kind  string
			Owner game.PlayerColor
		}{piece.ID, game.Blue}
		alphabet[lower] = struct {
			Kind  string
			Owner game.PlayerColor
		}{piece.ID, game.Red}
	}
	return alphabet
}
