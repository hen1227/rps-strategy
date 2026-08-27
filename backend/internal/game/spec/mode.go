package spec

// A spec, as a mode the engine can host.
//
// `game.GameMode` is the only rules contract the engine understands, and this
// implements it — so a mode somebody published this morning is, to the queue,
// the clock, the archive and the lobby, exactly as ordinary as Total War.
// Nothing outside this package learns that specs exist.
//
// The mirror of `specMovesFor` and `specApplyMove` in
// `frontend/src/engine/spec/interpret.ts`. The two are held together by
// `conformance/corpus.json`, which both suites replay.

import (
	"encoding/json"
	"fmt"

	"rps-strategy/backend/internal/game"
)

// Mode is the spec as a GameMode. `id` is the mode id it is registered under —
// the spec does not carry one, because the same rules published twice are two
// modes and the library decides their names.
type Mode struct {
	id     game.ModeID
	spec   RuleSpec
	origin game.ModeOrigin
	// definition is built once. It carries the encoded spec, and encoding it per
	// call would be a JSON marshal on every snapshot of every live game.
	definition game.ModeDefinition
}

// NewMode builds a hostable mode from a validated spec.
//
// Refuses an invalid one rather than registering something that cannot be
// played: a mode in the registry is a mode matchmaking may seat two people into.
func NewMode(id game.ModeID, parsed RuleSpec, origin game.ModeOrigin) (*Mode, error) {
	if report := Validate(parsed); !report.Valid() {
		return nil, fmt.Errorf("mode %s: %w", id, report.Err())
	}
	encoded, err := json.Marshal(parsed)
	if err != nil {
		return nil, fmt.Errorf("mode %s: %w", id, err)
	}
	mode := &Mode{id: id, spec: parsed, origin: origin}
	mode.definition = game.ModeDefinition{
		ID:          id,
		ShortCode:   parsed.ShortCode,
		Name:        parsed.Name,
		Description: parsed.Description,
		Objective:   parsed.Objective,
		Playable:    true,
		// Derived rather than declared: a mode has territory exactly when
		// something in it claims ground. Asking the rules is one fact; a flag
		// beside them would be a second one that can disagree.
		Features:         featuresOf(parsed),
		StartingPosition: parsed.StartingPosition,
		Spec:             encoded,
		Origin:           origin,
	}
	return mode, nil
}

// Factory is the mode as the registry takes it.
//
// A factory returns a *fresh* mode per game everywhere else in this package's
// neighbours; here the value is immutable — a spec is data and nothing mutates
// it — so every game can share one.
func (mode *Mode) Factory() game.ModeFactory {
	return func() game.GameMode { return mode }
}

func featuresOf(parsed RuleSpec) []game.ModeFeature {
	for _, rule := range parsed.Effects {
		for _, effect := range asList(rule["do"]) {
			node := asNode(effect)
			if node["claimTerritory"] != nil || node["setTerritory"] != nil {
				return []game.ModeFeature{game.FeatureTerritory}
			}
		}
	}
	return []game.ModeFeature{}
}

func (mode *Mode) Definition() game.ModeDefinition { return mode.definition }

// SetPlayable retires a mode, or brings it back.
//
// A retired mode keeps its rules and stops accepting new games. That is the
// whole difference, and it is why retiring is not deleting: its archive still
// replays, and the people holding links to those games are exactly the people
// who would notice.
func (mode *Mode) SetPlayable(playable bool) { mode.definition.Playable = playable }

func (mode *Mode) Spec() RuleSpec { return mode.spec }

// Initialize paints the opening board, in the mode's own alphabet.
//
// Not `standardRPSRules.initializeBoard`: that one reads `R`/`P`/`S` and a mode
// with a Lizard in it needs its own letters. The shape comes from the layout, so
// a mode is whatever rectangle it was written as.
func (mode *Mode) Initialize(state *game.GameState) {
	position := mode.spec.StartingPosition
	state.Grid = game.NewGrid(position.Width(), position.Height())
	alphabet := mode.spec.Alphabet()
	for y, row := range position.Rows() {
		for x := 0; x < len(row); x++ {
			piece, known := alphabet[row[x]]
			if !known {
				continue
			}
			tile := &state.Grid[y][x]
			tile.Occupant = game.Piece(piece.Kind)
			tile.OccupantOwner = piece.Owner
			tile.OwnerColor = piece.Owner
		}
	}
}

/* --------------------------------------------------------------- generation -- */

// specMove is one legal move, with what produced it.
//
// `jumped` is the square whose piece a jumpOver move takes — not the square it
// landed on. Carried from generation rather than worked out again at apply time,
// because a step and a jump can reach the same square and only one of them takes
// anything on the way.
type specMove struct {
	from    game.Position
	to      game.Position
	jumped  *game.Position
	forcing bool
}

var (
	all8       = [][2]int{{-1, -1}, {0, -1}, {1, -1}, {-1, 0}, {1, 0}, {-1, 1}, {0, 1}, {1, 1}}
	orthogonal = [][2]int{{0, -1}, {-1, 0}, {1, 0}, {0, 1}}
	diagonal   = [][2]int{{-1, -1}, {1, -1}, {-1, 1}, {1, 1}}
	sideways   = [][2]int{{-1, 0}, {1, 0}}
)

// forwardStep is which way a mover's "forward" points.
//
// Blue starts on rank 1 and advances up the ranks; Red starts on the last and
// advances down. So one rule written `forward` serves both sides, which is the
// whole reason the named sets are relative rather than absolute.
func forwardStep(mover game.PlayerColor) int {
	if mover == game.Blue {
		return 1
	}
	return -1
}

func directionsFor(dirs any, mover game.PlayerColor) [][2]int {
	forward := forwardStep(mover)
	if name, ok := dirs.(string); ok {
		switch name {
		case "orthogonal":
			return orthogonal
		case "diagonal":
			return diagonal
		case "sideways":
			return sideways
		case "forward":
			return [][2]int{{0, forward}}
		case "forwardDiagonal":
			return [][2]int{{-1, forward}, {1, forward}}
		case "backward":
			return [][2]int{{0, -forward}}
		default:
			return all8
		}
	}
	// Explicit offsets are in the mover's own frame: `+y` is forward, away from
	// your own home. A one-way piece is therefore one rule rather than two, and a
	// symmetric set — a knight's eight — reads the same either way.
	offsets := asList(asNode(dirs)["offsets"])
	found := make([][2]int, 0, len(offsets))
	for _, entry := range offsets {
		pair := asList(entry)
		if len(pair) != 2 {
			continue
		}
		dx, dxOK := wholeNumber(pair[0])
		dy, dyOK := wholeNumber(pair[1])
		if dxOK && dyOK {
			found = append(found, [2]int{dx, dy * forward})
		}
	}
	return found
}

// canCapture is whether an attacker may take a defender, under this mode's rule.
func (mode *Mode) canCapture(attacker, defender game.Piece) bool {
	switch mode.spec.CaptureMode() {
	case "never":
		return false
	case "always", "mutual":
		return true
	default:
		return mode.beats(attacker, defender)
	}
}

func (mode *Mode) beats(attacker, defender game.Piece) bool {
	for _, edge := range mode.spec.Beats {
		if len(edge) == 2 && game.Piece(edge[0]) == attacker && game.Piece(edge[1]) == defender {
			return true
		}
	}
	return false
}

// canLandOn is whether a piece may finish on a square, ignoring how it got there.
//
// A friendly piece is never a destination — the one rule every mode inherits
// without saying so, and the same refusal standardRPSRules.validateMove makes.
func (mode *Mode) canLandOn(
	destination game.Tile,
	mover game.PlayerColor,
	moving game.Piece,
	targets string,
) bool {
	if targets == "" {
		targets = "any"
	}
	if destination.OccupantOwner == mover {
		return false
	}
	if destination.Occupant == game.Empty {
		return targets != "enemy"
	}
	if targets == "empty" {
		return false
	}
	return mode.canCapture(moving, destination.Occupant)
}

func ruleApplies(rule Node, kind game.Piece) bool {
	piece, present := rule["piece"]
	if !present {
		return true
	}
	for _, name := range asStrings(piece) {
		if game.Piece(name) == kind {
			return true
		}
	}
	return false
}

func (mode *Mode) destinationsForRule(
	grid game.Grid,
	rule Node,
	from game.Position,
	mover game.PlayerColor,
	moving game.Piece,
) []specMove {
	kind, _ := rule["kind"].(string)
	targets, _ := rule["targets"].(string)
	forcing := asBool(rule["mustCapture"])
	moves := make([]specMove, 0, 8)

	for _, step := range directionsFor(rule["dirs"], mover) {
		dx, dy := step[0], step[1]

		switch kind {
		case "slide":
			limit := intOr(rule["maxDistance"], max(grid.Width(), grid.Height()))
			for distance := 1; distance <= limit; distance++ {
				to := game.Position{X: from.X + dx*distance, Y: from.Y + dy*distance}
				if !grid.Contains(to) {
					break
				}
				tile := grid.At(to)
				if tile.Occupant != game.Empty {
					// The ray stops here either way; it only ends *on* this square
					// when the piece standing there can be taken.
					if mode.canLandOn(tile, mover, moving, targets) {
						moves = append(moves, specMove{from: from, to: to, forcing: forcing})
					}
					break
				}
				if mode.canLandOn(tile, mover, moving, targets) {
					moves = append(moves, specMove{from: from, to: to, forcing: forcing})
				}
			}

		case "jumpOver":
			over := game.Position{X: from.X + dx, Y: from.Y + dy}
			if !grid.Contains(over) || grid.At(over).Occupant == game.Empty {
				continue
			}
			to := game.Position{X: from.X + dx*2, Y: from.Y + dy*2}
			// Checkers, not chess: you land on empty ground beyond the piece.
			if !grid.Contains(to) || grid.At(to).Occupant != game.Empty || targets == "enemy" {
				continue
			}
			jumpedTile := grid.At(over)
			move := specMove{from: from, to: to, forcing: forcing}
			if asBool(rule["captureJumped"]) &&
				jumpedTile.OccupantOwner != mover &&
				mode.canCapture(moving, jumpedTile.Occupant) {
				square := over
				move.jumped = &square
			}
			moves = append(moves, move)

		default:
			// `step` scales the direction; `leap` uses the offset as it stands. On
			// the named sets the two are the same thing at distance 1, which is
			// the standard king move.
			distance := 1
			if kind == "step" {
				distance = intOr(rule["distance"], 1)
			}
			to := game.Position{X: from.X + dx*distance, Y: from.Y + dy*distance}
			if grid.Contains(to) && mode.canLandOn(grid.At(to), mover, moving, targets) {
				moves = append(moves, specMove{from: from, to: to, forcing: forcing})
			}
		}
	}
	return moves
}

// dedupe: two rules reaching the same square give one move, and a jump wins the
// tie. Preferring the jump is the useful answer — it is the move that does
// something, and a mode whose author wanted both spellings would have written
// two destinations.
func dedupe(moves []specMove) []specMove {
	best := make(map[game.Position]specMove, len(moves))
	order := make([]game.Position, 0, len(moves))
	for _, move := range moves {
		existing, seen := best[move.to]
		if !seen {
			order = append(order, move.to)
			best[move.to] = move
			continue
		}
		if (existing.jumped == nil && move.jumped != nil) || (!existing.forcing && move.forcing) {
			best[move.to] = move
		}
	}
	// Rebuilt in the order the squares were first reached, because the order of
	// legal moves is load-bearing: a seeded opening is only reproducible if "the
	// seventh legal move" means the same thing on every run.
	found := make([]specMove, 0, len(order))
	for _, square := range order {
		found = append(found, best[square])
	}
	return found
}

func (mode *Mode) movesFromSquare(state game.GameState, from game.Position) []specMove {
	if !state.Grid.Contains(from) {
		return nil
	}
	source := state.Grid.At(from)
	if source.Occupant == game.Empty || source.OccupantOwner != state.CurrentTurn {
		return nil
	}
	mover := source.OccupantOwner

	moves := make([]specMove, 0, 8)
	for _, rule := range mode.spec.Movement {
		if !ruleApplies(rule, source.Occupant) {
			continue
		}
		for _, move := range mode.destinationsForRule(state.Grid, rule, from, mover, source.Occupant) {
			if when, present := rule["when"]; present {
				// A movement rule's condition is asked *before* the move, with both
				// squares known — the move has not happened yet. Everywhere else a
				// condition is asked after. docs/rulespec.md says so out loud,
				// because it is the one place the language is not uniform.
				ctx := context{
					spec: mode.spec, grid: state.Grid, mover: mover,
					from: move.from, to: move.to, moved: source.Occupant,
					moveNumber: state.MoveNumber,
				}
				if !ctx.evaluate(when) {
					continue
				}
			}
			moves = append(moves, move)
		}
	}
	return dedupe(moves)
}

func (mode *Mode) hasForcingRule() bool {
	for _, rule := range mode.spec.Movement {
		if asBool(rule["mustCapture"]) {
			return true
		}
	}
	return false
}

// allMoves is every move the side to move may play.
//
// `mustCapture` is why this is the primitive and one square's moves are derived
// from it: a forced capture is a fact about the whole position, not about the
// piece you happen to have selected. Modes without a forcing rule — almost all
// of them — never pay for it.
func (mode *Mode) allMoves(state game.GameState) []specMove {
	moves := make([]specMove, 0, 32)
	for _, row := range state.Grid {
		for _, tile := range row {
			if tile.OccupantOwner != state.CurrentTurn {
				continue
			}
			moves = append(moves, mode.movesFromSquare(state, game.Position{X: tile.X, Y: tile.Y})...)
		}
	}
	forced := make([]specMove, 0, len(moves))
	for _, move := range moves {
		if move.forcing {
			forced = append(forced, move)
		}
	}
	if len(forced) > 0 {
		return forced
	}
	return moves
}

// ValidMoves is the squares one piece may move to.
func (mode *Mode) ValidMoves(
	state game.GameState,
	player game.PlayerColor,
	from game.Position,
) []game.Position {
	if state.Status != game.InProgress || state.CurrentTurn != player {
		return nil
	}
	var moves []specMove
	if mode.hasForcingRule() {
		for _, move := range mode.allMoves(state) {
			if move.from == from {
				moves = append(moves, move)
			}
		}
	} else {
		moves = mode.movesFromSquare(state, from)
	}
	found := make([]game.Position, 0, len(moves))
	for _, move := range moves {
		found = append(found, move.to)
	}
	return found
}

/* -------------------------------------------------------------------- apply -- */

var errIllegalMove = fmt.Errorf("%w: that move is not legal in this mode", game.ErrInvalidMovement)

func clearTile(tile *game.Tile) {
	tile.Occupant = game.Empty
	tile.OccupantOwner = game.Neutral
}

// runEffect applies one effect to the board the move has already been made on.
// The boolean is whether the mover goes again.
func (mode *Mode) runEffect(effect Node, ctx context) bool {
	grid := ctx.grid
	destination := &grid[ctx.to.Y][ctx.to.X]

	switch {
	case effect["claimTerritory"] != nil:
		// Claims ground nobody holds, and only that. Taking ground somebody
		// already owns is `setTerritory` over the `destination` region — a
		// different rule, and visible as one in the spec rather than hidden
		// behind a flag. Exactly what mode_total_war.go does.
		name, _ := effect["claimTerritory"].(string)
		side := ctx.resolveSide(name)
		if destination.OwnerColor == game.Neutral && side != "" {
			destination.OwnerColor = side
		}
	case effect["setTerritory"] != nil:
		set := asNode(effect["setTerritory"])
		name, _ := set["to"].(string)
		side := ctx.resolveSide(name)
		if side != "" {
			for _, tile := range ctx.tilesMatching(asNode(set["tiles"])) {
				grid[tile.Y][tile.X].OwnerColor = side
			}
		}
	case effect["promote"] != nil:
		to, _ := asNode(effect["promote"])["to"].(string)
		if destination.Occupant != game.Empty {
			destination.Occupant = game.Piece(to)
		}
	case effect["remove"] != nil:
		for _, tile := range ctx.tilesMatching(asNode(asNode(effect["remove"])["tiles"])) {
			clearTile(&grid[tile.Y][tile.X])
		}
	case effect["spawn"] != nil:
		spawn := asNode(effect["spawn"])
		name, _ := spawn["owner"].(string)
		owner := ctx.resolveSide(name)
		piece, _ := spawn["piece"].(string)
		if owner != game.Red && owner != game.Blue {
			return false
		}
		region := asNode(spawn["at"])
		// The first empty square of the region, in board order, so a spawn is
		// reproducible rather than a choice one reader makes differently from
		// the other.
		for _, row := range grid {
			for _, tile := range row {
				if tile.Occupant != game.Empty {
					continue
				}
				if !ctx.inRegion(region, game.Position{X: tile.X, Y: tile.Y}) {
					continue
				}
				grid[tile.Y][tile.X].Occupant = game.Piece(piece)
				grid[tile.Y][tile.X].OccupantOwner = owner
				return false
			}
		}
	case effect["extraTurn"] != nil:
		return true
	}
	return false
}

func (mode *Mode) resolveWin(result any, ctx context) game.PlayerColor {
	if name, ok := result.(string); ok {
		switch name {
		case "mover":
			return ctx.mover
		case "opponent":
			return ctx.opponent()
		default:
			return game.Neutral
		}
	}
	moreOf := asNode(asNode(result)["moreOf"])
	red := ctx.evalTerm(moreOf["red"])
	blue := ctx.evalTerm(moreOf["blue"])
	switch {
	case red > blue:
		return game.Red
	case blue > red:
		return game.Blue
	default:
		return game.Neutral
	}
}

// Move plays a move, mutating the state.
//
// The order is the one every mode in this package follows, and every step of it
// is load-bearing: the piece moves, then the mode's effects run, then its win
// conditions are checked, and only a game still in progress passes the turn.
// Returning before passTurn is why a decided game's final position still has the
// winner to move — visible in every archived record's FinalFEN.
//
// Repetition, the stalemate draw and the clock are deliberately absent: they are
// Game's, applied to every mode alike, and a mode that adjudicated them would be
// a second opinion about a rule it does not own.
func (mode *Mode) Move(
	state *game.GameState,
	player game.PlayerColor,
	from game.Position,
	to game.Position,
) error {
	if state.Status != game.InProgress {
		return game.ErrGameFinished
	}
	if player != state.CurrentTurn {
		return game.ErrWrongTurn
	}
	if !state.Grid.Contains(from) || !state.Grid.Contains(to) {
		return game.ErrOutOfBounds
	}

	var legal *specMove
	candidates := mode.movesFromSquare(*state, from)
	if mode.hasForcingRule() {
		candidates = mode.allMoves(*state)
	}
	for index, move := range candidates {
		if move.from == from && move.to == to {
			legal = &candidates[index]
			break
		}
	}
	if legal == nil {
		return errIllegalMove
	}

	source := &state.Grid[from.Y][from.X]
	destination := &state.Grid[to.Y][to.X]
	moved := source.Occupant

	takesDestination := destination.Occupant != game.Empty
	// Mutual destruction, except where the graph already says this attacker wins
	// the exchange outright.
	mutuallyDestroyed := takesDestination &&
		mode.spec.CaptureMode() == "mutual" &&
		!mode.beats(moved, destination.Occupant)
	captured := takesDestination || legal.jumped != nil

	destination.Occupant = moved
	destination.OccupantOwner = player
	clearTile(source)
	if legal.jumped != nil {
		clearTile(&state.Grid[legal.jumped.Y][legal.jumped.X])
	}
	if mutuallyDestroyed {
		clearTile(destination)
	}
	state.MoveNumber++

	ctx := context{
		spec: mode.spec, grid: state.Grid, mover: player,
		from: from, to: to, captured: captured, moved: moved,
		moveNumber: state.MoveNumber,
	}

	extraTurn := false
	for _, rule := range mode.spec.Effects {
		trigger, _ := rule["on"].(string)
		if trigger == "capture" && !captured {
			continue
		}
		if when, present := rule["when"]; present && !ctx.evaluate(when) {
			continue
		}
		for _, effect := range asList(rule["do"]) {
			if mode.runEffect(asNode(effect), ctx) {
				extraTurn = true
			}
		}
	}

	for _, condition := range mode.spec.Win {
		if !ctx.evaluate(condition["when"]) {
			continue
		}
		reason, _ := condition["reason"].(string)
		if reason == "" {
			reason = string(game.EndReasonGameRule)
		}
		state.Status = game.Finished
		state.Winner = mode.resolveWin(condition["result"], ctx)
		state.EndReason = game.GameEndReason(reason)
		return nil
	}

	// `movesPerTurn` passes the turn every nth move rather than every move, and
	// `extraTurn` overrides it outright. Both counted off MoveNumber, so a replay
	// lands on the same side to move as the game did.
	perTurn := 1
	if mode.spec.Turn != nil && mode.spec.Turn.MovesPerTurn != nil {
		perTurn = *mode.spec.Turn.MovesPerTurn
	}
	if !extraTurn && state.MoveNumber%perTurn == 0 {
		state.CurrentTurn = game.OtherColor(player)
	}

	// The move limit is checked *after* the turn has passed, and the win
	// conditions above return *before* it. That difference is a rule, not an
	// accident: a mode's own win leaves the winner to move — which is what every
	// archived FinalFEN shows — while a draw the game ran into is adjudicated
	// once the turn has already changed hands, exactly as Game does for
	// stalemate and repetition. A cap on the length of a game is a draw.
	if mode.spec.Draw != nil && mode.spec.Draw.MoveLimit != nil &&
		state.MoveNumber >= *mode.spec.Draw.MoveLimit {
		state.Status = game.Finished
		state.Winner = game.Neutral
		state.EndReason = game.EndReasonMoveLimit
	}
	return nil
}

// ValidateStartingPosition checks a board somebody drew against this mode's own
// alphabet, which is the whole reason `game.PositionValidator` exists: a layout
// full of Lizards is nonsense to the engine's six letters and perfectly ordinary
// here.
func (mode *Mode) ValidateStartingPosition(position game.StartingPosition) error {
	if err := position.ValidateShape(); err != nil {
		return err
	}
	alphabet := mode.spec.Alphabet()
	for y, row := range position.Rows() {
		for x := 0; x < len(row); x++ {
			if row[x] == '.' {
				continue
			}
			if _, known := alphabet[row[x]]; !known {
				return fmt.Errorf(
					"%w: %q at (%d, %d) is not a piece in %s",
					game.ErrInvalidStartingPosition, string(row[x]), x, y, mode.spec.Name,
				)
			}
		}
	}
	return nil
}
