package spec

// Is this a spec, and does it mean anything?
//
// The same two answers the TypeScript validator gives, deliberately in the same
// order and with the same words, because the Lab shows one and this one decides:
//
//	Errors   — nothing could act on this. The spec is never played.
//	Warnings — legal, and probably not what the author meant. Publishing does not
//	           refuse them, because "probably wrong" is the author's call.
//
// This is the publish boundary. Everything a stranger sends arrives here, and the
// caps in types.go are the bound on how much work one published mode can make
// this server do.

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"sort"
	"strings"

	"rps-strategy/backend/internal/game"
)

// ErrInvalidSpec wraps every refusal, so a caller can tell a bad spec from a
// database failure without reading the message.
var ErrInvalidSpec = errors.New("invalid rule spec")

// Issue is one thing wrong, and where. The path is a JSON path into the spec so
// the Lab can point at the field rather than at the document.
type Issue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

type Report struct {
	Errors   []Issue `json:"errors"`
	Warnings []Issue `json:"warnings"`
}

func (report Report) Valid() bool { return len(report.Errors) == 0 }

// Err is the report as an error, or nil when the spec is playable. Warnings are
// deliberately not in it: they are advice, and a caller that treated them as
// refusals would refuse Rock-Paper-Scissors-Lizard-Spock.
func (report Report) Err() error {
	if report.Valid() {
		return nil
	}
	parts := make([]string, 0, len(report.Errors))
	for _, issue := range report.Errors {
		path := issue.Path
		if path == "" {
			path = "(spec)"
		}
		parts = append(parts, path+": "+issue.Message)
	}
	return fmt.Errorf("%w: %s", ErrInvalidSpec, strings.Join(parts, "; "))
}

var (
	pieceIDPattern   = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_-]{0,23}$`)
	symbolPattern    = regexp.MustCompile(`^[A-Z]$`)
	shortCodePattern = regexp.MustCompile(`^[A-Za-z0-9]{1,6}$`)
	reasonPattern    = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)
)

var (
	sideRefs       = []string{"mover", "opponent", "red", "blue", "neutral", "any"}
	homeRefs       = []string{"mover", "opponent", "red", "blue"}
	directionNames = []string{
		"all8", "orthogonal", "diagonal", "forward", "forwardDiagonal", "backward", "sideways",
	}
	movementKinds = []string{"step", "slide", "leap", "jumpOver"}
	captureModes  = []string{"beats", "always", "never", "mutual"}
	comparisons   = []string{"eq", "lt", "lte", "gt", "gte"}
	regionKinds   = []string{
		"rows", "columns", "squares", "rect", "home", "corners", "edge", "all",
		"destination", "origin",
	}
	effectKinds = []string{
		"claimTerritory", "setTerritory", "promote", "remove", "spawn", "extraTurn",
	}
	termKinds      = []string{"count", "row", "column", "moveNumber", "share"}
	fromTo         = []string{"from", "to"}
	effectTriggers = []string{"move", "capture", "turnEnd"}
	moveTargets    = []string{"empty", "enemy", "any"}
	winResults     = []string{"mover", "opponent", "draw"}
)

func contains(list []string, value string) bool {
	for _, candidate := range list {
		if candidate == value {
			return true
		}
	}
	return false
}

// hasControlCharacter is why author-supplied text is checked at all: it reaches
// other people's screens. Control characters are the only thing refused
// outright; everything else is rendered as plain text.
func hasControlCharacter(text string) bool {
	for _, character := range text {
		if character < 0x20 || character == 0x7f {
			return true
		}
	}
	return false
}

// wholeNumber reads a JSON number that has to be an integer. Every number in a
// decoded spec is a float64, so "is this a whole number" is a real question.
func wholeNumber(value any) (int, bool) {
	number, ok := value.(float64)
	if !ok || number != float64(int(number)) {
		return 0, false
	}
	return int(number), true
}

// soleKey is how every tagged union in the language is spelled: exactly one of
// the allowed keys, and nothing ambiguous.
func soleKey(node Node, allowed []string) (string, bool) {
	found := ""
	count := 0
	for key := range node {
		if contains(allowed, key) {
			found = key
			count++
		}
	}
	return found, count == 1
}

type validator struct {
	spec    RuleSpec
	kinds   map[string]PieceKind
	symbols map[string]string
	report  *Report
	width   int
	height  int
}

func (check *validator) fail(path, format string, args ...any) {
	check.report.Errors = append(check.report.Errors, Issue{path, fmt.Sprintf(format, args...)})
}

func (check *validator) warn(path, format string, args ...any) {
	check.report.Warnings = append(check.report.Warnings, Issue{path, fmt.Sprintf(format, args...)})
}

// Validate reads a spec the way the Lab does, and reaches the same verdict.
func Validate(candidate RuleSpec) Report {
	report := Report{Errors: []Issue{}, Warnings: []Issue{}}
	check := &validator{
		spec:    candidate,
		kinds:   map[string]PieceKind{},
		symbols: map[string]string{},
		report:  &report,
		width:   candidate.Board.Width,
		height:  candidate.Board.Height,
	}

	if candidate.Spec != Version {
		// Everything below assumes v1 shapes, so there is nothing useful to add.
		check.fail("spec", "this build reads rule language version %d, got %d", Version, candidate.Spec)
		return report
	}

	check.identity()
	check.board()
	check.pieces()
	check.art()
	check.beats()
	check.startingPosition()
	check.movement()
	check.effects()
	check.winAndDraw()
	check.turn()
	check.size()
	return report
}

// ValidateJSON is Validate for a document that has not been decoded yet, which
// is the shape it arrives in over HTTP. The byte cap is applied first, before
// anything is parsed: a caller should not have to decode a megabyte to find out
// it was refused.
func ValidateJSON(raw []byte) (RuleSpec, Report) {
	if len(raw) > MaxSpecBytes {
		return RuleSpec{}, Report{Errors: []Issue{{
			Path:    "",
			Message: fmt.Sprintf("a published spec is at most %d bytes, this one is %d", MaxSpecBytes, len(raw)),
		}}}
	}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	// Unknown fields are refused rather than ignored: a spec whose author
	// misspelled `movement` should hear about it here, not by finding that
	// nothing can move.
	decoder.DisallowUnknownFields()
	var decoded RuleSpec
	if err := decoder.Decode(&decoded); err != nil {
		return RuleSpec{}, Report{Errors: []Issue{{Path: "", Message: err.Error()}}}
	}
	return decoded, Validate(decoded)
}

func (check *validator) identity() {
	for field, value := range map[string]string{
		"name":        check.spec.Name,
		"shortCode":   check.spec.ShortCode,
		"description": check.spec.Description,
		"objective":   check.spec.Objective,
	} {
		if strings.TrimSpace(value) == "" {
			check.fail(field, "required, and not blank")
			continue
		}
		if len([]rune(value)) > MaxTextLength {
			check.fail(field, "at most %d characters", MaxTextLength)
		}
		if hasControlCharacter(value) {
			check.fail(field, "contains control characters")
		}
	}
	if check.spec.ShortCode != "" && !shortCodePattern.MatchString(check.spec.ShortCode) {
		check.fail("shortCode", "one to six letters or digits")
	}
}

func (check *validator) board() {
	if err := game.ValidateBoardSize(check.width, check.height); err != nil {
		check.fail("board", "%v", err)
	}
}

// art reports on every place the mode names a picture.

// The two halves are deliberately not equally strict, and the rule is worth
// stating: inside our own namespace, be strict; outside it, warn. A malformed
// `img:` reference can only be our typo — nothing will ever resolve it — and
// naming it while it is being written is cheaper than a published mode with a
// permanent hole in it. A name we simply do not recognise might be a bundled
// picture from a build the author has and this one does not, so it costs the
// picture and nothing else. That second case is load-bearing: it is what lets
// the bundled set grow without older builds refusing modes that use it.
//
// This is also the only thing between an author-written string and a URL path,
// which is why the pattern is anchored at both ends and admits nothing but hex.
func (check *validator) art() {
	for _, site := range check.spec.ArtSites() {
		switch {
		case site.Value == "":
		case strings.HasPrefix(site.Value, "img:"):
			if !IsArtRef(site.Value) {
				check.fail(site.Path, "an uploaded picture is \"img:\" and 32 lower-case hex characters")
			}
		case !site.Bundled:
			check.fail(site.Path, "an uploaded picture as \"img:<digest>\", not %q", site.Value)
		case !contains([]string{"rock", "paper", "scissors"}, site.Value):
			// Not an error: a kind with no artwork is drawn as its letter, so
			// an unknown name only costs the picture.
			check.warn(site.Path, "no bundled artwork called %q; it will draw as a letter", site.Value)
		}
	}
	if refs := check.spec.ArtReferences(); len(refs) > MaxArtRefs {
		check.fail("", "at most %d uploaded pictures in one mode, this one names %d",
			MaxArtRefs, len(refs))
	}
}

func (check *validator) pieces() {
	if len(check.spec.Pieces) == 0 {
		check.fail("pieces", "at least one kind of piece")
		return
	}
	if len(check.spec.Pieces) > MaxPieces {
		check.fail("pieces", "at most %d kinds", MaxPieces)
		return
	}
	for index, piece := range check.spec.Pieces {
		path := fmt.Sprintf("pieces[%d]", index)
		switch {
		case !pieceIDPattern.MatchString(piece.ID):
			check.fail(path+".id",
				"letters, digits, dash or underscore, starting with a letter")
		case piece.ID == string(game.Empty):
			// `Empty` is what an unoccupied tile carries, so a kind by that name
			// would be a piece indistinguishable from no piece at all.
			check.fail(path+".id", `"Empty" is reserved for a square with nothing on it`)
		case check.kinds[piece.ID].ID != "":
			check.fail(path+".id", "duplicate piece id %q", piece.ID)
		default:
			check.kinds[piece.ID] = piece
		}
		if strings.TrimSpace(piece.Name) == "" {
			check.fail(path+".name", "required")
		}
		switch {
		case !symbolPattern.MatchString(piece.Symbol):
			// One letter, and upper case: the case of a symbol in a layout is
			// which side owns the piece, so a lower-case symbol would have no
			// room left to say that.
			check.fail(path+".symbol", "one upper-case letter, A to Z")
		case check.symbols[piece.Symbol] != "":
			check.fail(path+".symbol", "symbol %s is already %s", piece.Symbol, check.symbols[piece.Symbol])
		default:
			check.symbols[piece.Symbol] = piece.ID
		}
	}
}

func (check *validator) beats() {
	if len(check.spec.Beats) > MaxBeats {
		check.fail("beats", "at most %d pairs", MaxBeats)
		return
	}
	predators := map[string]bool{}
	seen := map[string]bool{}
	for index, edge := range check.spec.Beats {
		path := fmt.Sprintf("beats[%d]", index)
		if len(edge) != 2 {
			check.fail(path, "a pair: [attacker, defender]")
			continue
		}
		attacker, defender := edge[0], edge[1]
		for role, kind := range map[string]string{"attacker": attacker, "defender": defender} {
			if _, known := check.kinds[kind]; !known {
				check.fail(path, "%s %q is not a declared piece", role, kind)
			}
		}
		// [X, X] is allowed on purpose: a kind that takes its own kind is how a
		// chess pawn works, and refusing it would refuse a whole family of modes
		// for the sake of a tidiness nothing needs.
		key := attacker + ">" + defender
		if seen[key] {
			check.fail(path, "duplicate pair")
		}
		seen[key] = true
		predators[defender] = true
	}
	if !contains(captureModes, check.spec.CaptureMode()) {
		check.fail("capture.mode", "one of %s", strings.Join(captureModes, ", "))
	}
	if check.spec.CaptureMode() != "beats" {
		return
	}
	// Sorted so two runs report the same warnings in the same order, which is
	// what lets a test compare them.
	uncapturable := make([]string, 0, len(check.kinds))
	for kind := range check.kinds {
		if !predators[kind] {
			uncapturable = append(uncapturable, kind)
		}
	}
	sort.Strings(uncapturable)
	for _, kind := range uncapturable {
		check.warn("beats",
			"nothing captures %q, so it can never be taken — an annihilation win may be unreachable",
			kind)
	}
}

func (check *validator) startingPosition() {
	position := check.spec.StartingPosition
	if err := position.Validate(); err != nil {
		// The layout's own shape and symbols are checked by the engine's
		// validator, but it only knows rock, paper and scissors — so a spec with
		// a lizard in it fails there and is checked below instead. Only the
		// shape is taken from it.
		if position.Layout == "" {
			check.fail("startingPosition.rows", "required")
			return
		}
	}
	rows := position.Rows()
	if position.Width() != check.width || position.Height() != check.height {
		check.fail("startingPosition.rows",
			"the board is %d by %d, but the layout is %d by %d",
			check.width, check.height, position.Width(), position.Height())
		return
	}
	allowed := map[byte]bool{'.': true}
	for symbol := range check.symbols {
		allowed[symbol[0]] = true
		allowed[symbol[0]+('a'-'A')] = true
	}
	blue, red := 0, 0
	for y, row := range rows {
		for x := 0; x < len(row); x++ {
			symbol := row[x]
			switch {
			case !allowed[symbol]:
				check.fail(fmt.Sprintf("startingPosition.rows[%d]", y),
					"%q at file %d is not a declared piece", string(symbol), x+1)
			case symbol == '.':
			case symbol >= 'A' && symbol <= 'Z':
				blue++
			default:
				red++
			}
		}
	}
	switch {
	case blue+red == 0:
		check.warn("startingPosition.rows", "the opening board is empty")
	case red == 0:
		check.warn("startingPosition.rows", "Red starts with no pieces, so Red has no legal move")
	case blue == 0:
		check.warn("startingPosition.rows", "Blue starts with no pieces, so Blue has no legal move")
	}
}

func (check *validator) size() {
	// Last, because a spec with structural errors is not worth weighing, and the
	// caps above already bound everything this could catch. It is here for the
	// one case they do not: a spec legal in every part and enormous in total.
	if !check.report.Valid() {
		return
	}
	encoded, err := json.Marshal(check.spec)
	if err != nil {
		check.fail("", "cannot be encoded: %v", err)
		return
	}
	if len(encoded) > MaxSpecBytes {
		check.fail("", "a published spec is at most %d bytes, this one is %d", MaxSpecBytes, len(encoded))
	}
}

func (check *validator) turn() {
	if check.spec.Turn == nil {
		return
	}
	if check.spec.Turn.MovesPerTurn != nil && *check.spec.Turn.MovesPerTurn < 1 {
		check.fail("turn.movesPerTurn", "a whole number of at least 1")
	}
}
